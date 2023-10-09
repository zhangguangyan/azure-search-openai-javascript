import { type SearchClient } from '@azure/search-documents';
import { type OpenAiService } from '../../plugins/openai.js';
import {
  type ChatApproach,
  type ApproachResponse,
  type ChatApproachContext,
  type ApproachResponseChunk,
} from './approach.js';
import { ApproachBase } from './approach-base.js';
import { type HistoryMessage, type Message, messagesToString } from '../message.js';
import { MessageBuilder } from '../message-builder.js';
import { getTokenLimit } from '../tokens.js';

const SYSTEM_MESSAGE_CHAT_CONVERSATION = `Assistant helps the Consto Real Estate company customers with support questions regarding terms of service, privacy policy, and questions about support requests. Be brief in your answers.
Answer ONLY with the facts listed in the list of sources below. If there isn't enough information below, say you don't know. Do not generate answers that don't use the sources below. If asking a clarifying question to the user would help, ask the question.
For tabular information return it as an html table. Do not return markdown format. If the question is not in English, answer in the language used in the question.
Each source has a name followed by colon and the actual information, always include the source name for each fact you use in the response. Use square brackets to reference the source, e.g. [info1.txt]. Don't combine sources, list each source separately, e.g. [info1.txt][info2.pdf].
{follow_up_questions_prompt}
{injected_prompt}
`;

const FOLLOW_UP_QUESTIONS_PROMPT_CONTENT = `Generate three very brief follow-up questions that the user would likely ask next about rentals.
Use double angle brackets to reference the questions, e.g. <<Am I allowed to invite friends for a party?>>.
Try not to repeat questions that have already been asked.
Only generate questions and do not generate any text before or after the questions, such as 'Next Questions'`;

const QUERY_PROMPT_TEMPLATE = `Below is a history of the conversation so far, and a new question asked by the user that needs to be answered by searching in a knowledge base about terms of service, privacy policy, and questions about support requests.
Generate a search query based on the conversation and the new question.
Do not include cited source filenames and document names e.g info.txt or doc.pdf in the search query terms.
Do not include any text inside [] or <<>> in the search query terms.
Do not include any special characters like '+'.
If the question is not in English, translate the question to English before generating the search query.
If you cannot generate a search query, return just the number 0.
`;

const QUERY_PROMPT_FEW_SHOTS: Message[] = [
  { role: 'user', content: 'What happens if a payment error occurs?' },
  { role: 'assistant', content: 'Show support for payment errors' },
  { role: 'user', content: 'can I get refunded if cannot travel?' },
  { role: 'assistant', content: 'Refund policy' },
];

/**
 * Simple retrieve-then-read implementation, using the Cognitive Search and OpenAI APIs directly.
 * It first retrieves top documents from search, then constructs a prompt with them, and then uses
 * OpenAI to generate an completion (answer) with that prompt.
 */
export class ChatReadRetrieveRead extends ApproachBase implements ChatApproach {
  chatGptTokenLimit: number;

  constructor(
    search: SearchClient<any>,
    openai: OpenAiService,
    chatGptModel: string,
    embeddingModel: string,
    sourcePageField: string,
    contentField: string,
  ) {
    super(search, openai, chatGptModel, embeddingModel, sourcePageField, contentField);
    this.chatGptTokenLimit = getTokenLimit(chatGptModel);
  }

  async run(history: HistoryMessage[], context?: ChatApproachContext): Promise<ApproachResponse> {
    const { completionRequest, dataPoints, thoughts } = await this.baseRun(history, context);
    const openAiChat = await this.openai.getChat();
    const chatCompletion = await openAiChat.completions.create(completionRequest);
    const chatContent = chatCompletion.choices[0].message.content ?? '';

    return {
      data_points: dataPoints,
      answer: chatContent,
      thoughts: thoughts,
    };
  }

  async *runWithStreaming(
    history: HistoryMessage[],
    context?: ChatApproachContext,
  ): AsyncGenerator<ApproachResponseChunk, void> {
    const { completionRequest, dataPoints, thoughts } = await this.baseRun(history, context);
    const openAiChat = await this.openai.getChat();
    const chatCompletion = await openAiChat.completions.create({
      ...completionRequest,
      stream: true,
    });
    let id = 0;
    for await (const chunk of chatCompletion) {
      const responseChunk = {
        data_points: id === 0 ? dataPoints : undefined,
        thoughts: id === 0 ? thoughts : undefined,
        answer: chunk.choices[0].delta.content ?? '',
      };
      yield responseChunk;
      id++;
    }
  }

  private async baseRun(history: HistoryMessage[], context?: ChatApproachContext) {
    const userQuery = 'Generate search query for: ' + history[history.length - 1].user;

    // STEP 1: Generate an optimized keyword search query based on the chat history and the last question
    // -----------------------------------------------------------------------

    const messages = this.getMessagesFromHistory(
      QUERY_PROMPT_TEMPLATE,
      this.chatGptModel,
      history,
      userQuery,
      QUERY_PROMPT_FEW_SHOTS,
      this.chatGptTokenLimit - userQuery.length,
    );

    const openAiChat = await this.openai.getChat();
    const chatCompletion = await openAiChat.completions.create({
      model: this.chatGptModel,
      messages,
      temperature: 0,
      max_tokens: 32,
      n: 1,
    });

    let queryText = chatCompletion.choices[0].message.content?.trim();
    if (queryText === '0') {
      // Use the last user input if we failed to generate a better query
      queryText = history[history.length - 1].user;
    }

    // STEP 2: Retrieve relevant documents from the search index with the GPT optimized query
    // -----------------------------------------------------------------------

    const { query, results, content } = await this.searchDocuments(queryText, context);
    const followUpQuestionsPrompt = context?.suggest_followup_questions ? FOLLOW_UP_QUESTIONS_PROMPT_CONTENT : '';

    // STEP 3: Generate a contextual and content specific answer using the search results and chat history
    // -----------------------------------------------------------------------

    // Allow client to replace the entire prompt, or to inject into the exiting prompt using >>>
    const promptOverride = context?.prompt_template;
    let systemMessage: string;
    if (promptOverride?.startsWith('>>>')) {
      systemMessage = SYSTEM_MESSAGE_CHAT_CONVERSATION.replace(
        '{follow_up_questions_prompt}',
        followUpQuestionsPrompt,
      ).replace('{injected_prompt}', promptOverride.slice(3) + '\n');
    } else if (promptOverride) {
      systemMessage = SYSTEM_MESSAGE_CHAT_CONVERSATION.replace(
        '{follow_up_questions_prompt}',
        followUpQuestionsPrompt,
      ).replace('{injected_prompt}', promptOverride);
    } else {
      systemMessage = SYSTEM_MESSAGE_CHAT_CONVERSATION.replace(
        '{follow_up_questions_prompt}',
        followUpQuestionsPrompt,
      ).replace('{injected_prompt}', '');
    }

    const finalMessages = this.getMessagesFromHistory(
      systemMessage,
      this.chatGptModel,
      history,
      // Model does not handle lengthy system messages well.
      // Moving sources to latest user conversation to solve follow up questions prompt.
      `${history[history.length - 1].user}\n\nSources:\n${content}`,
      [],
      this.chatGptTokenLimit,
    );

    const messageToDisplay = messagesToString(messages);

    return {
      completionRequest: {
        model: this.chatGptModel,
        messages: finalMessages,
        temperature: Number(context?.temperature ?? 0.7),
        max_tokens: 1024,
        n: 1,
      },
      dataPoints: results,
      thoughts: `Searched for:<br>${query}<br><br>Conversations:<br>${messageToDisplay.replace('\n', '<br>')}`,
    };
  }

  private getMessagesFromHistory(
    systemPrompt: string,
    model: string,
    history: HistoryMessage[],
    userContent: string,
    fewShots: Message[] = [],
    maxTokens = 4096,
  ): Message[] {
    const messageBuilder = new MessageBuilder(systemPrompt, model);

    // Add examples to show the chat what responses we want.
    // It will try to mimic any responses and make sure they match the rules laid out in the system message.
    for (const shot of fewShots.reverse()) {
      messageBuilder.appendMessage(shot.role, shot.content);
    }

    const appendIndex = fewShots.length + 1;
    messageBuilder.appendMessage('user', userContent, appendIndex);

    for (const historyMessage of history.slice(0, -1).reverse()) {
      if (historyMessage.bot) {
        messageBuilder.appendMessage('assistant', historyMessage.bot, appendIndex);
      }
      if (historyMessage.user) {
        messageBuilder.appendMessage('user', historyMessage.user, appendIndex);
      }
      if (messageBuilder.tokens > maxTokens) {
        break;
      }
    }

    const messages = messageBuilder.messages;
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }
}
