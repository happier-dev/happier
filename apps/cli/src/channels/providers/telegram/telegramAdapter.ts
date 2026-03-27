import axios from 'axios';

import { ChannelBridgePermanentDeliveryError } from '@/channels/core/channelBridgeWorker';
import type { ChannelBridgeAdapter, ChannelBridgeInboundMessage } from '@/channels/core/channelBridgeWorker';
import { logger } from '@/ui/logger';

type TelegramSelfUser = Readonly<{ id: number; username: string | null }>;
type TelegramApiMethod = 'getMe' | 'getUpdates' | 'sendMessage';

type TelegramApiClient = Readonly<{
  getMe: () => Promise<TelegramSelfUser>;
  getUpdates: (params: Readonly<{ offset: number | null; limit: number }>) => Promise<readonly unknown[]>;
  sendMessage: (params: Readonly<{ chatId: string; threadId: string | null; text: string }>) => Promise<void>;
}>;

const TELEGRAM_GET_UPDATES_LONG_POLL_TIMEOUT_SECONDS = 25;
const TELEGRAM_GET_UPDATES_HTTP_TIMEOUT_MS = (TELEGRAM_GET_UPDATES_LONG_POLL_TIMEOUT_SECONDS + 4) * 1_000;
const TELEGRAM_MAX_SEND_MESSAGE_TEXT_LENGTH = 4_096;

function telegramApiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

function extractTelegramApiDescription(data: unknown): string | null {
  const record = asRecord(data);
  const description = record && typeof record.description === 'string' ? record.description.trim() : '';
  return description.length > 0 ? description : null;
}

function formatTelegramApiFailure(method: TelegramApiMethod, status: number, description: string | null): string {
  return description && description.length > 0
    ? `Telegram ${method} failed (${status}): ${description}`
    : `Telegram ${method} failed (${status})`;
}

export class TelegramApiError extends Error {
  readonly method: TelegramApiMethod;
  readonly statusCode: number;
  readonly description: string | null;

  constructor(params: Readonly<{ method: TelegramApiMethod; statusCode: number; data: unknown }>) {
    const description = extractTelegramApiDescription(params.data);
    super(formatTelegramApiFailure(params.method, params.statusCode, description));
    this.name = 'TelegramApiError';
    this.method = params.method;
    this.statusCode = params.statusCode;
    this.description = description;
  }
}

function createDefaultTelegramApiClient(botToken: string): TelegramApiClient {
  return {
    getMe: async () => {
      const response = await axios.post(telegramApiUrl(botToken, 'getMe'), {}, {
        timeout: 10_000,
        validateStatus: () => true,
      });
      if (response.status !== 200 || !response.data || response.data.ok !== true || !response.data.result) {
        throw new TelegramApiError({
          method: 'getMe',
          statusCode: response.status,
          data: response.data,
        });
      }
      const user = response.data.result;
      return {
        id: Number(user.id),
        username: typeof user.username === 'string' ? user.username : null,
      };
    },
    getUpdates: async ({ offset, limit }) => {
      const response = await axios.post(telegramApiUrl(botToken, 'getUpdates'), {
        ...(typeof offset === 'number' ? { offset } : {}),
        limit,
        timeout: TELEGRAM_GET_UPDATES_LONG_POLL_TIMEOUT_SECONDS,
        allowed_updates: ['message'],
      }, {
        timeout: TELEGRAM_GET_UPDATES_HTTP_TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (response.status !== 200 || !response.data || response.data.ok !== true || !Array.isArray(response.data.result)) {
        throw new TelegramApiError({
          method: 'getUpdates',
          statusCode: response.status,
          data: response.data,
        });
      }
      return response.data.result;
    },
    sendMessage: async ({ chatId, threadId, text }) => {
      const parsedThreadId = Number.parseInt(typeof threadId === 'string' ? threadId.trim() : '', 10);
      const messageThreadId = Number.isSafeInteger(parsedThreadId) && parsedThreadId > 0
        ? parsedThreadId
        : null;
      const response = await axios.post(telegramApiUrl(botToken, 'sendMessage'), {
        chat_id: chatId,
        text,
        ...(messageThreadId !== null ? { message_thread_id: messageThreadId } : {}),
      }, {
        timeout: 10_000,
        validateStatus: () => true,
      });
      if (response.status !== 200 || !response.data || response.data.ok !== true) {
        const apiError = new TelegramApiError({
          method: 'sendMessage',
          statusCode: response.status,
          data: response.data,
        });

        if (apiError.statusCode === 403) {
          throw new ChannelBridgePermanentDeliveryError({
            code: 'forbidden',
            message: apiError.message,
          });
        }
        if (apiError.statusCode === 400 && apiError.description !== null && /chat not found/i.test(apiError.description)) {
          throw new ChannelBridgePermanentDeliveryError({
            code: 'conversation_not_found',
            message: apiError.message,
          });
        }

        throw apiError;
      }
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseInboundFromUpdate(params: Readonly<{
  update: unknown;
  selfBotId: number | null;
  allowedChatIds: ReadonlySet<string> | null;
  allowAllSharedChats: boolean;
  requireTopics: boolean;
}>): ChannelBridgeInboundMessage | null {
  const update = asRecord(params.update);
  if (!update) return null;
  const rawMessage = asRecord(update.message);
  if (!rawMessage) return null;

  const text = typeof rawMessage.text === 'string' ? rawMessage.text.trim() : '';
  if (!text) return null;

  const chat = asRecord(rawMessage.chat);
  if (!chat) return null;
  const rawChatId = chat.id;
  const conversationId =
    typeof rawChatId === 'number' && Number.isFinite(rawChatId)
      ? String(Math.trunc(rawChatId))
      : typeof rawChatId === 'string'
        ? rawChatId.trim()
        : '';
  if (!conversationId) return null;

  const chatType = typeof chat.type === 'string' ? chat.type : '';
  const isPrivateChat = chatType === 'private';
  if (!isPrivateChat && !params.allowAllSharedChats) {
    if (!params.allowedChatIds || !params.allowedChatIds.has(conversationId)) {
      return null;
    }
  }

  const threadId =
    typeof rawMessage.message_thread_id === 'number' && Number.isFinite(rawMessage.message_thread_id)
      ? String(Math.trunc(rawMessage.message_thread_id))
      : null;

  if (params.requireTopics) {
    if (chatType === 'supergroup' && threadId === null) {
      return null;
    }
  }

  const sender = asRecord(rawMessage.from);
  const senderId =
    sender && typeof sender.id === 'number' && Number.isFinite(sender.id) ? Math.trunc(sender.id) : null;
  const senderIsBot = sender?.is_bot === true;
  if (senderIsBot && senderId !== null && params.selfBotId !== null && senderId === params.selfBotId) {
    return null;
  }

  const messageId =
    typeof rawMessage.message_id === 'number' && Number.isFinite(rawMessage.message_id)
      ? String(Math.trunc(rawMessage.message_id))
      : '';
  if (!messageId) return null;

  return {
    providerId: 'telegram',
    conversationId,
    threadId,
    senderId: senderId === null ? null : String(senderId),
    text,
    messageId,
  };
}

function parseHighestUpdateOffset(updates: readonly unknown[]): number | null {
  let max: number | null = null;
  for (const item of updates) {
    const current = parseUpdateId(item);
    if (current === null) continue;
    if (max === null || current > max) max = current;
  }
  return max;
}

function parseUpdateId(update: unknown): number | null {
  const record = asRecord(update);
  if (!record) return null;
  const rawUpdateId = record.update_id;
  if (typeof rawUpdateId !== 'number' || !Number.isFinite(rawUpdateId)) return null;
  return Math.trunc(rawUpdateId);
}

function inboundMessageKey(message: Readonly<{
  providerId: string;
  conversationId: string;
  threadId: string | null;
  messageId: string;
}>): string {
  return JSON.stringify([message.providerId, message.conversationId, message.threadId, message.messageId]);
}

export function createTelegramChannelAdapter(params: Readonly<{
  botToken: string;
  api?: TelegramApiClient;
  webhookMode?: boolean;
  updateLimit?: number;
  allowedChatIds?: ReadonlySet<string> | null;
  allowAllSharedChats?: boolean;
  requireTopics?: boolean;
}>): ChannelBridgeAdapter & Readonly<{ enqueueWebhookUpdate: (update: unknown) => void }> {
  const api = params.api ?? createDefaultTelegramApiClient(params.botToken);
  const webhookMode = params.webhookMode === true;
  const updateLimit =
    typeof params.updateLimit === 'number' && Number.isFinite(params.updateLimit)
      ? Math.max(1, Math.min(100, Math.trunc(params.updateLimit)))
      : 100;
  const allowedChatIds = params.allowedChatIds ?? null;
  const allowAllSharedChats = params.allowAllSharedChats === true;
  const requireTopics = params.requireTopics === true;
  const MAX_WEBHOOK_QUEUE_SIZE = 2_000;

  type QueuedWebhookUpdate = {
    id: number;
    update: unknown;
  };

  type PendingWebhookAck = {
    queueIds: Set<number>;
    maxUpdateId: number | null;
  };

  type PendingPollingBatchAck = {
    messages: ChannelBridgeInboundMessage[];
    pendingMessageKeys: Set<string>;
    ackedMessageKeys: Set<string>;
    maxUpdateId: number | null;
  };

  let selfBotId: number | null = null;
  /**
   * Telegram polling cursor (`getUpdates` offset).
   *
   * This cursor is intentionally process-local today and is not persisted across
   * daemon restarts. Polling mode therefore provides at-least-once delivery:
   * after restart, Telegram may replay unacknowledged updates from the retention
   * window, and downstream dedupe is expected to absorb duplicates.
   */
  let updateOffset: number | null = null;
  const queuedWebhookUpdates: QueuedWebhookUpdate[] = [];
  let nextQueuedWebhookId = 1;
  let droppedWebhookUpdates = 0;
  const pendingWebhookAcksByMessageKey = new Map<string, PendingWebhookAck>();
  let pendingPollingBatchAck: PendingPollingBatchAck | null = null;

  function dropPendingWebhookAckIds(ids: ReadonlySet<number>): void {
    if (ids.size === 0) return;

    for (const [key, pending] of pendingWebhookAcksByMessageKey) {
      for (const id of ids) {
        pending.queueIds.delete(id);
      }
      if (pending.queueIds.size === 0) {
        pendingWebhookAcksByMessageKey.delete(key);
      }
    }
  }

  function removeQueuedWebhookUpdatesById(ids: ReadonlySet<number>): void {
    if (ids.size === 0) return;

    for (let index = queuedWebhookUpdates.length - 1; index >= 0; index -= 1) {
      if (ids.has(queuedWebhookUpdates[index]!.id)) {
        queuedWebhookUpdates.splice(index, 1);
      }
    }
    dropPendingWebhookAckIds(ids);
  }

  async function ensureSelfIdentity(): Promise<void> {
    if (selfBotId !== null) return;
    const self = await api.getMe();
    selfBotId = Number.isFinite(self.id) ? Math.trunc(self.id) : null;
  }

  async function parseUpdates(updates: readonly unknown[]): Promise<ChannelBridgeInboundMessage[]> {
    await ensureSelfIdentity();
    const out: ChannelBridgeInboundMessage[] = [];
    for (const update of updates) {
      const parsed = parseInboundFromUpdate({
        update,
        selfBotId,
        allowedChatIds,
        allowAllSharedChats,
        requireTopics,
      });
      if (parsed) out.push(parsed);
    }
    return out;
  }

  return {
    providerId: 'telegram',
    enqueueWebhookUpdate: (update: unknown) => {
      if (queuedWebhookUpdates.length >= MAX_WEBHOOK_QUEUE_SIZE) {
        const dropped = queuedWebhookUpdates.shift();
        if (dropped) {
          droppedWebhookUpdates += 1;
          dropPendingWebhookAckIds(new Set([dropped.id]));
        }
      }
      queuedWebhookUpdates.push({
        id: nextQueuedWebhookId,
        update,
      });
      nextQueuedWebhookId += 1;
    },
    pullInboundMessages: async () => {
      if (webhookMode) {
        if (droppedWebhookUpdates > 0) {
          logger.warn(
            `[channelBridge] Telegram webhook queue overflow: dropped ${droppedWebhookUpdates} oldest update(s)`,
          );
          droppedWebhookUpdates = 0;
        }

        const snapshot = queuedWebhookUpdates.slice();
        await ensureSelfIdentity();

        const parsed: ChannelBridgeInboundMessage[] = [];
        const consumedWithoutAck = new Set<number>();
        for (const row of snapshot) {
          const message = parseInboundFromUpdate({
            update: row.update,
            selfBotId,
            allowedChatIds,
            allowAllSharedChats,
            requireTopics,
          });
          if (!message) {
            consumedWithoutAck.add(row.id);
            continue;
          }

          parsed.push(message);
          const key = inboundMessageKey(message);
          const pending = pendingWebhookAcksByMessageKey.get(key) ?? { queueIds: new Set<number>(), maxUpdateId: null };
          pending.queueIds.add(row.id);

          const updateId = parseUpdateId(row.update);
          if (updateId !== null) {
            pending.maxUpdateId = pending.maxUpdateId === null ? updateId : Math.max(pending.maxUpdateId, updateId);
          }

          pendingWebhookAcksByMessageKey.set(key, pending);
        }

        removeQueuedWebhookUpdatesById(consumedWithoutAck);
        return parsed;
      }

      if (pendingPollingBatchAck) {
        return pendingPollingBatchAck.messages.map((message) => ({ ...message }));
      }

      const updates = await api.getUpdates({
        offset: updateOffset,
        limit: updateLimit,
      });

      const parsed = await parseUpdates(updates);
      const maxUpdateId = parseHighestUpdateOffset(updates);
      if (parsed.length === 0) {
        if (maxUpdateId !== null) {
          const nextOffset = maxUpdateId + 1;
          updateOffset = updateOffset === null ? nextOffset : Math.max(updateOffset, nextOffset);
        }
        return [];
      }

      pendingPollingBatchAck = {
        messages: parsed,
        pendingMessageKeys: new Set(parsed.map((message) => inboundMessageKey(message))),
        ackedMessageKeys: new Set<string>(),
        maxUpdateId,
      };

      return parsed;
    },
    ackInboundMessages: async (messages) => {
      if (!webhookMode) {
        const pendingBatch = pendingPollingBatchAck;
        if (!pendingBatch || messages.length === 0) {
          return;
        }

        for (const message of messages) {
          const key = inboundMessageKey(message);
          if (pendingBatch.pendingMessageKeys.has(key)) {
            pendingBatch.ackedMessageKeys.add(key);
          }
        }

        const allPendingMessagesAcked =
          pendingBatch.pendingMessageKeys.size > 0
          && Array.from(pendingBatch.pendingMessageKeys).every((key) => pendingBatch.ackedMessageKeys.has(key));

        if (!allPendingMessagesAcked) {
          return;
        }

        if (pendingBatch.maxUpdateId !== null) {
          const nextOffset = pendingBatch.maxUpdateId + 1;
          updateOffset = updateOffset === null ? nextOffset : Math.max(updateOffset, nextOffset);
        }

        pendingPollingBatchAck = null;
        return;
      }

      if (messages.length === 0) {
        return;
      }

      const consumedIds = new Set<number>();
      let maxAckedUpdateId: number | null = null;

      for (const message of messages) {
        const key = inboundMessageKey(message);
        const pending = pendingWebhookAcksByMessageKey.get(key);
        if (!pending) {
          continue;
        }

        for (const queueId of pending.queueIds) {
          consumedIds.add(queueId);
        }

        if (pending.maxUpdateId !== null) {
          maxAckedUpdateId = maxAckedUpdateId === null
            ? pending.maxUpdateId
            : Math.max(maxAckedUpdateId, pending.maxUpdateId);
        }

        pendingWebhookAcksByMessageKey.delete(key);
      }

      removeQueuedWebhookUpdatesById(consumedIds);

      if (maxAckedUpdateId !== null) {
        const nextOffset = maxAckedUpdateId + 1;
        updateOffset = updateOffset === null ? nextOffset : Math.max(updateOffset, nextOffset);
      }
    },
    sendMessage: async (message) => {
      const normalizedText = String(message.text).trim();
      const codePoints = Array.from(normalizedText);
      const text = codePoints.length > TELEGRAM_MAX_SEND_MESSAGE_TEXT_LENGTH
        ? codePoints.slice(0, TELEGRAM_MAX_SEND_MESSAGE_TEXT_LENGTH).join('')
        : normalizedText;

      if (!text) {
        return;
      }

      if (text !== normalizedText) {
        logger.warn(
          `[channelBridge] Truncated Telegram outbound message for conversation ${message.conversationId} to ${TELEGRAM_MAX_SEND_MESSAGE_TEXT_LENGTH} characters`,
        );
      }

      await api.sendMessage({
        chatId: message.conversationId,
        threadId: message.threadId,
        text,
      });
    },
  };
}
