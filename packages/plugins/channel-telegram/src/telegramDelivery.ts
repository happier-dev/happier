import type { ConversationDeliveryInputV1, ConversationDeliveryResultV1 } from '@happier-dev/channels-protocol/v1';
import type { TelegramBotApi } from './telegramBotApi.js';

/** One native text-send owner for existing conversations and newly created topics. */
export async function sendTelegramText(input: Readonly<{
  api: TelegramBotApi;
  request: ConversationDeliveryInputV1;
  chatId: string;
  messageThreadId?: string;
  signal: AbortSignal;
}>): Promise<ConversationDeliveryResultV1> {
  const { request } = input;
  const replyToMessageId = request.replyContext !== undefined && 'replyToMessageId' in request.replyContext
    ? request.replyContext.replyToMessageId : undefined;
  let result: Awaited<ReturnType<TelegramBotApi['sendMessage']>>;
  try {
    result = await input.api.sendMessage({
      chatId: input.chatId,
      // Telegram creates username entities server-side even without parse_mode.
      // Fullwidth @ preserves the core's native Unicode-code-point chunk size.
      text: request.content.text.replaceAll('@', '＠'),
      suppressLinkPreview: request.linkPreviewPolicy === 'suppress',
      ...((request.chunkIndex ?? 0) === 0 && replyToMessageId !== undefined ? { replyToMessageId } : {}),
      ...(input.messageThreadId === undefined ? {} : { messageThreadId: input.messageThreadId }),
    }, { signal: input.signal });
  } catch {
    // Cancellation/transport loss after send cannot prove absence of the effect.
    return { kind: 'outcomeUnknown' };
  }
  if (result.kind === 'sent') return { kind: 'delivered', providerMessageIds: [result.messageId] };
  if (result.kind === 'outcomeUnknown') return result;
  return { kind: 'notDelivered', retry: result.retry,
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) };
}
