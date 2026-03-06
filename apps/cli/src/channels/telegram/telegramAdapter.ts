import axios from 'axios';

import type { ChannelBridgeAdapter, ChannelBridgeInboundMessage } from '@/channels/core/channelBridgeWorker';

type TelegramSelfUser = Readonly<{ id: number; username: string | null }>;

type TelegramApiClient = Readonly<{
  getMe: () => Promise<TelegramSelfUser>;
  getUpdates: (params: Readonly<{ offset: number | null; limit: number }>) => Promise<readonly unknown[]>;
  sendMessage: (params: Readonly<{ chatId: string; threadId: string | null; text: string }>) => Promise<void>;
}>;

const TELEGRAM_GET_UPDATES_LONG_POLL_TIMEOUT_SECONDS = 25;
const TELEGRAM_GET_UPDATES_HTTP_TIMEOUT_MS = 30_000;

function telegramApiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

function createDefaultTelegramApiClient(botToken: string): TelegramApiClient {
  return {
    getMe: async () => {
      const response = await axios.post(telegramApiUrl(botToken, 'getMe'), {}, {
        timeout: 10_000,
        validateStatus: () => true,
      });
      if (response.status !== 200 || !response.data || response.data.ok !== true || !response.data.result) {
        throw new Error(`Telegram getMe failed (${response.status})`);
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
        throw new Error(`Telegram getUpdates failed (${response.status})`);
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
        throw new Error(`Telegram sendMessage failed (${response.status})`);
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

  if (params.allowedChatIds && !params.allowedChatIds.has(conversationId)) {
    return null;
  }

  const threadId =
    typeof rawMessage.message_thread_id === 'number' && Number.isFinite(rawMessage.message_thread_id)
      ? String(Math.trunc(rawMessage.message_thread_id))
      : null;

  if (params.requireTopics) {
    const chatType = typeof chat.type === 'string' ? chat.type : '';
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
    const record = asRecord(item);
    if (!record) continue;
    const rawUpdateId = record.update_id;
    if (typeof rawUpdateId !== 'number' || !Number.isFinite(rawUpdateId)) continue;
    const current = Math.trunc(rawUpdateId);
    if (max === null || current > max) max = current;
  }
  return max;
}

export function createTelegramChannelAdapter(params: Readonly<{
  botToken: string;
  api?: TelegramApiClient;
  webhookMode?: boolean;
  updateLimit?: number;
  allowedChatIds?: ReadonlySet<string> | null;
  requireTopics?: boolean;
}>): ChannelBridgeAdapter & Readonly<{ enqueueWebhookUpdate: (update: unknown) => void }> {
  const api = params.api ?? createDefaultTelegramApiClient(params.botToken);
  const webhookMode = params.webhookMode === true;
  const updateLimit =
    typeof params.updateLimit === 'number' && Number.isFinite(params.updateLimit)
      ? Math.max(1, Math.min(100, Math.trunc(params.updateLimit)))
      : 100;
  const allowedChatIds = params.allowedChatIds ?? null;
  const requireTopics = params.requireTopics === true;
  const MAX_WEBHOOK_QUEUE_SIZE = 2_000;

  type QueuedWebhookUpdate = {
    id: number;
    update: unknown;
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
        queuedWebhookUpdates.shift();
      }
      queuedWebhookUpdates.push({
        id: nextQueuedWebhookId,
        update,
      });
      nextQueuedWebhookId += 1;
    },
    pullInboundMessages: async () => {
      if (webhookMode) {
        const snapshot = queuedWebhookUpdates.slice();
        const parsed = await parseUpdates(snapshot.map((row) => row.update));
        const consumedIds = new Set(snapshot.map((row) => row.id));
        for (let index = queuedWebhookUpdates.length - 1; index >= 0; index -= 1) {
          if (consumedIds.has(queuedWebhookUpdates[index]!.id)) {
            queuedWebhookUpdates.splice(index, 1);
          }
        }
        return parsed;
      }

      const updates = await api.getUpdates({
        offset: updateOffset,
        limit: updateLimit,
      });

      const parsed = await parseUpdates(updates);
      const maxUpdateId = parseHighestUpdateOffset(updates);
      if (maxUpdateId !== null) {
        updateOffset = maxUpdateId + 1;
      }
      return parsed;
    },
    sendMessage: async (message) => {
      await api.sendMessage({
        chatId: message.conversationId,
        threadId: message.threadId,
        text: message.text,
      });
    },
  };
}
