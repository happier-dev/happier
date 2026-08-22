import { MAX_CONVERSATION_RETRY_AFTER_MS } from '@happier-dev/channels-protocol/v1';
import type { HttpService } from '@happier-dev/plugin-sdk/http';

const TELEGRAM_BOT_API_BASE_URL = 'https://api.telegram.org';
const TELEGRAM_MAX_UPDATE_ID = 2 ** 52 - 1;
const TELEGRAM_MAX_UPDATE_OFFSET = TELEGRAM_MAX_UPDATE_ID + 1;
const TELEGRAM_API_REQUEST_TIMEOUT_MS = 15_000;
export const TELEGRAM_MAX_LONG_POLL_TIMEOUT_SECONDS = 50;
const TELEGRAM_LONG_POLL_DEADLINE_OVERHEAD_MS = 10_000;
/**
 * Telegram's per-message ceiling. The send path chunks against it and the
 * setup fact publishes it to the Channels core as this connection's
 * `outboundTextLimit`, so both read this one constant: a core that chunked to
 * a different size than the send path enforces would fail at the provider.
 */
export const TELEGRAM_MAX_MESSAGE_CODE_POINTS = 4_096;
const TELEGRAM_BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
const NORMALIZED_CROCKFORD_TOKEN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

type JsonRecord = Readonly<Record<string, unknown>>;
type TelegramHttp = Pick<HttpService, 'request'>;
type TelegramRequestOptions = Readonly<{ signal?: AbortSignal }>;
type TelegramUser = Readonly<{
  id: number;
  isBot: boolean;
}>;

export type TelegramBotIdentity = Readonly<{
  id: string;
  username: string;
  displayName: string;
  canReadAllGroupMessages: boolean;
}>;

export type TelegramWebhookInfo = Readonly<{
  url: string;
  pendingUpdateCount: number;
}>;

export type TelegramChat = Readonly<{
  id: string;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  label: string | null;
}>;

export type TelegramTextEntity = Readonly<{
  type: string;
  text: string;
  userId: string | null;
}>;

export type TelegramIncomingMessage = Readonly<{
  messageId: string;
  chatId: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  messageThreadId: string | null;
  senderId: string | null;
  senderIsBot: boolean;
  senderIsChat: boolean;
  text: string | null;
  textEntities: readonly TelegramTextEntity[];
  replyToMessageId: string | null;
  replyToSenderId: string | null;
  forwarded: boolean;
  viaBotId: string | null;
  sentAtMs: number;
  editedAtMs: number | null;
}>;

export type TelegramUpdate = Readonly<{
  updateId: string;
  kind: 'message' | 'editedMessage' | 'unsupported';
  message: TelegramIncomingMessage | null;
}>;

type TelegramReadFailureResult =
  | Readonly<{
      kind: 'providerConflict';
      diagnostic: string;
    }>
  | Readonly<{
      kind: 'notReady';
      reason: 'credentialInvalid' | 'permissionMissing' | 'network' | 'rateLimited' | 'invalidConfiguration';
      retryAfterMs?: number;
      diagnostic?: string;
    }>;

export type TelegramGetUpdatesResult =
  | Readonly<{
      kind: 'updates';
      updates: readonly TelegramUpdate[];
      checkpointAfter: string;
    }>
  | TelegramReadFailureResult;

export type TelegramSendMessageResult =
  | Readonly<{ kind: 'sent'; messageId: string }>
  | Readonly<{
      kind: 'notSent';
      retry: 'safe' | 'after' | 'never';
      retryAfterMs?: number;
      diagnostic?: string;
    }>
  | Readonly<{ kind: 'outcomeUnknown' }>;

/**
 * A webhook deletion is externally observable. A response loss or a Telegram
 * 5xx cannot prove that the webhook remained installed, so callers must
 * inspect setup again instead of retrying the mutation blindly.
 */
export type TelegramDeleteWebhookResult =
  | Readonly<{ kind: 'deleted' }>
  | TelegramReadFailureResult
  | Readonly<{ kind: 'outcomeUnknown' }>;

export type TelegramBotApi = Readonly<{
  getMe(options?: TelegramRequestOptions): Promise<TelegramBotIdentity | TelegramGetUpdatesResult>;
  getWebhookInfo(options?: TelegramRequestOptions): Promise<TelegramWebhookInfo | TelegramGetUpdatesResult>;
  deleteWebhook(options?: TelegramRequestOptions): Promise<TelegramDeleteWebhookResult>;
  getChat(input: Readonly<{ chatId: string }>, options?: TelegramRequestOptions): Promise<TelegramChat | TelegramGetUpdatesResult>;
  getUpdates(input: Readonly<{
    offset: string;
    initialBaseline?: boolean;
    limit: number;
    timeoutSeconds: number;
  }>, options?: TelegramRequestOptions): Promise<TelegramGetUpdatesResult>;
  sendMessage(input: Readonly<{
    chatId: string;
    text: string;
    suppressLinkPreview: boolean;
    replyToMessageId?: string;
    messageThreadId?: string;
  }>, options?: TelegramRequestOptions): Promise<TelegramSendMessageResult>;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function boundedTelegramRetryAfterMs(retryAfterSeconds: number | null): number | undefined {
  if (retryAfterSeconds === null || retryAfterSeconds < 0) return undefined;
  return Math.min(MAX_CONVERSATION_RETRY_AFTER_MS, retryAfterSeconds * 1_000);
}

function parseTelegramUser(value: unknown): TelegramUser | null {
  if (!isRecord(value)) return null;
  const id = readSafeInteger(value.id);
  if (id === null || typeof value.is_bot !== 'boolean') return null;
  return { id, isBot: value.is_bot };
}

function parseBotApiEnvelope(body: Uint8Array):
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{
      ok: false;
      errorCode: number | null;
      description: string;
      retryAfterMs?: number;
    }>
  | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') return null;
    if (parsed.ok) return { ok: true, result: parsed.result };

    const parameters = isRecord(parsed.parameters) ? parsed.parameters : null;
    const retryAfterSeconds = parameters ? readSafeInteger(parameters.retry_after) : null;
    const retryAfterMs = boundedTelegramRetryAfterMs(retryAfterSeconds);
    return {
      ok: false,
      errorCode: readSafeInteger(parsed.error_code),
      description: readString(parsed.description) ?? 'Telegram rejected the request.',
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  } catch {
    return null;
  }
}

function mapReadFailure(envelope: Exclude<ReturnType<typeof parseBotApiEnvelope>, null | { ok: true }>): TelegramReadFailureResult {
  if (envelope.errorCode === 409) {
    return { kind: 'providerConflict', diagnostic: envelope.description };
  }
  if (envelope.errorCode === 401) {
    return { kind: 'notReady', reason: 'credentialInvalid', diagnostic: envelope.description };
  }
  if (envelope.errorCode === 403) {
    return { kind: 'notReady', reason: 'permissionMissing', diagnostic: envelope.description };
  }
  if (envelope.errorCode === 400) {
    return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: envelope.description };
  }
  if (envelope.errorCode === 429) {
    return {
      kind: 'notReady',
      reason: 'rateLimited',
      ...(envelope.retryAfterMs === undefined ? {} : { retryAfterMs: envelope.retryAfterMs }),
      diagnostic: envelope.description,
    };
  }
  return { kind: 'notReady', reason: 'network', diagnostic: envelope.description };
}

function mapSendFailure(envelope: Exclude<ReturnType<typeof parseBotApiEnvelope>, null | { ok: true }>): TelegramSendMessageResult {
  if (envelope.errorCode === 429) {
    return envelope.retryAfterMs === undefined
      ? { kind: 'notSent', retry: 'safe', diagnostic: envelope.description }
      : {
          kind: 'notSent',
          retry: 'after',
          retryAfterMs: envelope.retryAfterMs,
          diagnostic: envelope.description,
        };
  }
  if (envelope.errorCode !== null && envelope.errorCode >= 500) {
    return { kind: 'outcomeUnknown' };
  }
  return { kind: 'notSent', retry: 'never', diagnostic: envelope.description };
}

function parseOffset(value: string, allowInitialTail = false): number | null {
  if (allowInitialTail && value === '-1') return -1;
  if (!/^[0-9]+$/.test(value)) return null;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= TELEGRAM_MAX_UPDATE_OFFSET
    ? offset
    : null;
}

/** Shared by the opaque Channel checkpoint decoder and the Bot API request owner. */
export function isTelegramUpdateOffset(value: string): boolean {
  return parseOffset(value) !== null;
}

function countTelegramCodePoints(value: string): number {
  return Array.from(value).length;
}

export function splitTelegramPlainText(value: string): readonly string[] | null {
  if (!value) return [];
  const graphemes = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(value)]
    .map(({ segment }) => segment);
  const chunks: string[] = [];
  let current = '';
  let currentCodePoints = 0;
  for (const grapheme of graphemes) {
    const graphemeCodePoints = countTelegramCodePoints(grapheme);
    if (graphemeCodePoints > TELEGRAM_MAX_MESSAGE_CODE_POINTS) return null;
    if (currentCodePoints + graphemeCodePoints > TELEGRAM_MAX_MESSAGE_CODE_POINTS) {
      chunks.push(current);
      current = grapheme;
      currentCodePoints = graphemeCodePoints;
      continue;
    }
    current += grapheme;
    currentCodePoints += graphemeCodePoints;
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseTextEntities(value: unknown, text: string | null): readonly TelegramTextEntity[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || text === null) return null;
  const entities: TelegramTextEntity[] = [];
  for (const rawEntity of value) {
    if (!isRecord(rawEntity)) return null;
    const type = readString(rawEntity.type);
    const offset = readSafeInteger(rawEntity.offset);
    const length = readSafeInteger(rawEntity.length);
    const user = isRecord(rawEntity.user) ? rawEntity.user : null;
    const userId = user ? readSafeInteger(user.id) : null;
    if (!type || offset === null || length === null || offset < 0 || length <= 0 || offset + length > text.length) {
      return null;
    }
    entities.push({
      type,
      text: text.slice(offset, offset + length),
      userId: userId === null ? null : String(userId),
    });
  }
  return entities;
}

function parseIncomingMessage(value: unknown): TelegramIncomingMessage | null {
  if (!isRecord(value)) return null;
  const messageId = readSafeInteger(value.message_id);
  const dateSeconds = readSafeInteger(value.date);
  const editDateSeconds = readSafeInteger(value.edit_date);
  const chat = isRecord(value.chat) ? value.chat : null;
  const chatId = chat ? readSafeInteger(chat.id) : null;
  const chatType = chat ? readString(chat.type) : null;
  if (
    messageId === null
    || dateSeconds === null
    || chatId === null
    || (chatType !== 'private' && chatType !== 'group' && chatType !== 'supergroup' && chatType !== 'channel')
  ) {
    return null;
  }
  // Telegram can pair a chat-authored message with a compatibility `from`
  // user. `sender_chat` is authoritative, so never attribute that message to
  // the synthetic user identity.
  const senderIsChat = Object.hasOwn(value, 'sender_chat');
  const sender = senderIsChat ? null : parseTelegramUser(value.from);
  const senderId = sender?.id ?? null;
  const messageThreadId = readSafeInteger(value.message_thread_id);
  const reply = isRecord(value.reply_to_message) ? value.reply_to_message : null;
  const replyToMessageId = reply ? readSafeInteger(reply.message_id) : null;
  const replySender = reply !== null && !Object.hasOwn(reply, 'sender_chat')
    ? parseTelegramUser(reply.from)
    : null;
  const replyToSenderId = replySender?.isBot === true ? replySender.id : null;
  const viaBot = isRecord(value.via_bot) ? value.via_bot : null;
  const viaBotId = viaBot ? readSafeInteger(viaBot.id) : null;
  const text = readString(value.text);
  const textEntities = parseTextEntities(value.entities, text);
  if (textEntities === null) return null;
  return {
    messageId: String(messageId),
    chatId: String(chatId),
    chatType,
    messageThreadId: messageThreadId === null ? null : String(messageThreadId),
    senderId: senderId === null ? null : String(senderId),
    senderIsBot: sender?.isBot === true,
    senderIsChat,
    text,
    textEntities,
    replyToMessageId: replyToMessageId === null ? null : String(replyToMessageId),
    replyToSenderId: replyToSenderId === null ? null : String(replyToSenderId),
    forwarded: 'forward_origin' in value
      || 'forward_from' in value
      || 'forward_date' in value
      || value.is_automatic_forward === true,
    viaBotId: viaBotId === null ? null : String(viaBotId),
    sentAtMs: dateSeconds * 1_000,
    editedAtMs: editDateSeconds === null ? null : editDateSeconds * 1_000,
  };
}

function parseUpdate(value: unknown): TelegramUpdate | null {
  if (!isRecord(value)) return null;
  const updateId = readSafeInteger(value.update_id);
  if (updateId === null || updateId < 0 || updateId > TELEGRAM_MAX_UPDATE_ID) return null;
  const message = parseIncomingMessage(value.message);
  if (message) return { updateId: String(updateId), kind: 'message', message };
  const editedMessage = parseIncomingMessage(value.edited_message);
  if (editedMessage) return { updateId: String(updateId), kind: 'editedMessage', message: editedMessage };
  return { updateId: String(updateId), kind: 'unsupported', message: null };
}

function jsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function createTelegramPairingDeepLink(input: Readonly<{
  username: string;
  token: string;
}>): string | null {
  const username = input.username.trim();
  const token = input.token.trim();
  if (!TELEGRAM_BOT_USERNAME.test(username) || !/bot$/i.test(username) || !NORMALIZED_CROCKFORD_TOKEN.test(token)) {
    return null;
  }
  return `https://t.me/${username}?start=${token}`;
}

export function createTelegramBotApi(input: Readonly<{
  token: string;
  http: TelegramHttp;
}>): TelegramBotApi {
  const token = input.token.trim();
  if (!token) throw new Error('Telegram bot token is required');
  const methodUrl = (method: string): string => `${TELEGRAM_BOT_API_BASE_URL}/bot${token}/${method}`;

  async function request(
    method: string,
    body?: unknown,
    options?: TelegramRequestOptions,
    timeoutMs = TELEGRAM_API_REQUEST_TIMEOUT_MS,
  ): Promise<ReturnType<typeof parseBotApiEnvelope>> {
    try {
      const response = await input.http.request({
        url: methodUrl(method),
        method: 'POST',
        ...(body === undefined ? {} : { body: jsonBody(body), headers: { 'content-type': 'application/json' } }),
        redirect: 'error',
        timeoutMs,
      }, options);
      return parseBotApiEnvelope(response.body);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      return null;
    }
  }

  return {
    async getMe(options) {
      const envelope = await request('getMe', undefined, options);
      if (!envelope) return { kind: 'notReady', reason: 'network' };
      if (!envelope.ok) return mapReadFailure(envelope);
      const result = isRecord(envelope.result) ? envelope.result : null;
      const id = result ? readSafeInteger(result.id) : null;
      const username = result ? readString(result.username) : null;
      const displayName = result ? readString(result.first_name) : null;
      if (id === null || !username || !displayName || result?.is_bot !== true) {
        return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Telegram returned an invalid bot identity.' };
      }
      return {
        id: String(id),
        username,
        displayName,
        canReadAllGroupMessages: result?.can_read_all_group_messages === true,
      };
    },

    async getWebhookInfo(options) {
      const envelope = await request('getWebhookInfo', undefined, options);
      if (!envelope) return { kind: 'notReady', reason: 'network' };
      if (!envelope.ok) return mapReadFailure(envelope);
      const result = isRecord(envelope.result) ? envelope.result : null;
      const url = result ? readString(result.url) : null;
      const pendingUpdateCount = result ? readSafeInteger(result.pending_update_count) : null;
      if (url === null || pendingUpdateCount === null || pendingUpdateCount < 0) {
        return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Telegram returned invalid webhook information.' };
      }
      return { url, pendingUpdateCount };
    },

    async deleteWebhook(options) {
      // Omit `drop_pending_updates` deliberately. Telegram documents that its
      // default is false, so a confirmed switch back to polling leaves queued
      // user updates available to the canonical checkpointed-pull owner.
      const envelope = await request('deleteWebhook', undefined, options);
      if (!envelope) return { kind: 'outcomeUnknown' };
      if (!envelope.ok) {
        return envelope.errorCode !== null && envelope.errorCode >= 500
          ? { kind: 'outcomeUnknown' }
          : mapReadFailure(envelope);
      }
      return envelope.result === true
        ? { kind: 'deleted' }
        : { kind: 'outcomeUnknown' };
    },

    async getChat(chatInput, options) {
      const chatId = chatInput.chatId.trim();
      if (!chatId) {
        return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Telegram chat ID is required.' };
      }
      const envelope = await request('getChat', { chat_id: chatId }, options);
      if (!envelope) return { kind: 'notReady', reason: 'network' };
      if (!envelope.ok) return mapReadFailure(envelope);
      const result = isRecord(envelope.result) ? envelope.result : null;
      const id = result ? readSafeInteger(result.id) : null;
      const type = result ? readString(result.type) : null;
      if (
        id === null
        || (type !== 'private' && type !== 'group' && type !== 'supergroup' && type !== 'channel')
      ) {
        return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Telegram returned an invalid chat.' };
      }
      const title = result ? readString(result.title) : null;
      const firstName = result ? readString(result.first_name) : null;
      const username = result ? readString(result.username) : null;
      return {
        id: String(id),
        type,
        label: title || firstName || username || null,
      };
    },

    async getUpdates(requestInput, options) {
      const offset = parseOffset(requestInput.offset, requestInput.initialBaseline === true);
      if (
        offset === null
        || !Number.isInteger(requestInput.limit)
        || requestInput.limit < 1
        || requestInput.limit > 100
        || !Number.isInteger(requestInput.timeoutSeconds)
        || requestInput.timeoutSeconds < 0
        || requestInput.timeoutSeconds > TELEGRAM_MAX_LONG_POLL_TIMEOUT_SECONDS
      ) {
        return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Invalid Telegram polling request.' };
      }
      const envelope = await request('getUpdates', {
        offset,
        limit: requestInput.limit,
        timeout: requestInput.timeoutSeconds,
        allowed_updates: ['message', 'edited_message'],
      }, options, Math.max(
        TELEGRAM_API_REQUEST_TIMEOUT_MS,
        requestInput.timeoutSeconds * 1_000 + TELEGRAM_LONG_POLL_DEADLINE_OVERHEAD_MS,
      ));
      if (!envelope) return { kind: 'notReady', reason: 'network' };
      if (!envelope.ok) return mapReadFailure(envelope);
      if (!Array.isArray(envelope.result)) {
        return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Telegram returned invalid updates.' };
      }
      const updates = envelope.result.map(parseUpdate);
      if (updates.some((update) => update === null)) {
        return { kind: 'notReady', reason: 'invalidConfiguration', diagnostic: 'Telegram returned an invalid update.' };
      }
      const normalizedUpdates = updates as TelegramUpdate[];
      const highestUpdateId = normalizedUpdates.reduce(
        (highest, update) => Math.max(highest, Number(update.updateId)),
        offset < 0 ? -1 : offset - 1,
      );
      return {
        kind: 'updates',
        updates: normalizedUpdates,
        checkpointAfter: String(highestUpdateId + 1),
      };
    },

    async sendMessage(sendInput, options) {
      if (!sendInput.chatId || !sendInput.text || countTelegramCodePoints(sendInput.text) > TELEGRAM_MAX_MESSAGE_CODE_POINTS) {
        return { kind: 'notSent', retry: 'never', diagnostic: 'Invalid Telegram message.' };
      }
      const replyToMessageId = sendInput.replyToMessageId ? parseOffset(sendInput.replyToMessageId) : null;
      if (sendInput.replyToMessageId !== undefined && replyToMessageId === null) {
        return { kind: 'notSent', retry: 'never', diagnostic: 'Invalid Telegram reply target.' };
      }
      const messageThreadId = sendInput.messageThreadId ? parseOffset(sendInput.messageThreadId) : null;
      if (sendInput.messageThreadId !== undefined && messageThreadId === null) {
        return { kind: 'notSent', retry: 'never', diagnostic: 'Invalid Telegram message thread.' };
      }
      const envelope = await request('sendMessage', {
        chat_id: sendInput.chatId,
        text: sendInput.text,
        ...(sendInput.suppressLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
        ...(replyToMessageId === null ? {} : { reply_parameters: { message_id: replyToMessageId } }),
        ...(messageThreadId === null ? {} : { message_thread_id: messageThreadId }),
      }, options);
      if (!envelope) return { kind: 'outcomeUnknown' };
      if (!envelope.ok) return mapSendFailure(envelope);
      const result = isRecord(envelope.result) ? envelope.result : null;
      const messageId = result ? readSafeInteger(result.message_id) : null;
      return messageId === null
        ? { kind: 'outcomeUnknown' }
        : { kind: 'sent', messageId: String(messageId) };
    },
  };
}
