import axios from 'axios';

import { ChannelBridgePermanentDeliveryError } from '@/channels/core/channelBridgeWorker';
import type { ChannelBridgeAdapter, ChannelBridgeInboundMessage } from '@/channels/core/channelBridgeWorker';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';

import type {
  TelegramWebhookUpdateStore,
  TelegramWebhookUpdateStoreSnapshot,
} from './telegramWebhookUpdateStore';

type TelegramSelfUser = Readonly<{ id: number; username: string | null }>;
type TelegramApiMethod = 'getMe' | 'getUpdates' | 'sendMessage';

type TelegramApiClient = Readonly<{
  getMe: () => Promise<TelegramSelfUser>;
  getUpdates: (params: Readonly<{ offset: number | null; limit: number }>) => Promise<readonly unknown[]>;
  sendMessage: (params: Readonly<{ chatId: string; threadId: string | null; text: string }>) => Promise<void>;
}>;

type TelegramWebhookQueuedUpdate = Readonly<{
  id: number;
  update: unknown;
  updateId: number | null;
}>;

type TelegramWebhookQueueState = Readonly<{
  lastHandledWebhookUpdateId: number | null;
  nextQueuedWebhookId: number;
  queuedWebhookUpdates: TelegramWebhookQueuedUpdate[];
  queuedUpdateIds: ReadonlySet<number>;
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

function createTelegramTransportError(method: TelegramApiMethod, error: unknown): Error {
  const serialized = serializeAxiosErrorForLog(error);
  const safeDetails = {
    code: typeof serialized.code === 'string' ? serialized.code : undefined,
    status: typeof serialized.status === 'number' ? serialized.status : undefined,
    method: typeof serialized.method === 'string' ? serialized.method : undefined,
    url: typeof serialized.url === 'string' ? serialized.url : undefined,
  };
  return new Error(`Telegram ${method} transport error: ${JSON.stringify(safeDetails)}`);
}

function createDefaultTelegramApiClient(botToken: string): TelegramApiClient {
  return {
    getMe: async () => {
      let response: any;
      try {
        response = await axios.post(telegramApiUrl(botToken, 'getMe'), {}, {
          timeout: 10_000,
          validateStatus: () => true,
        });
      } catch (error) {
        throw createTelegramTransportError('getMe', error);
      }
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
      let response: any;
      try {
        response = await axios.post(telegramApiUrl(botToken, 'getUpdates'), {
          ...(typeof offset === 'number' ? { offset } : {}),
          limit,
          timeout: TELEGRAM_GET_UPDATES_LONG_POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message', 'channel_post'],
        }, {
          timeout: TELEGRAM_GET_UPDATES_HTTP_TIMEOUT_MS,
          validateStatus: () => true,
        });
      } catch (error) {
        throw createTelegramTransportError('getUpdates', error);
      }
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
      let response: any;
      try {
        response = await axios.post(telegramApiUrl(botToken, 'sendMessage'), {
          chat_id: chatId,
          text,
          ...(messageThreadId !== null ? { message_thread_id: messageThreadId } : {}),
        }, {
          timeout: 10_000,
          validateStatus: () => true,
        });
      } catch (error) {
        throw createTelegramTransportError('sendMessage', error);
      }
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
  const rawMessage = asRecord(update.message) ?? asRecord(update.channel_post);
  if (!rawMessage) return null;

  const rawText = typeof rawMessage.text === 'string' ? rawMessage.text.trim() : '';
  const rawCaption = typeof rawMessage.caption === 'string' ? rawMessage.caption.trim() : '';
  const text = rawText || rawCaption;
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

  const conversationKind =
    isPrivateChat
      ? 'dm'
      : chatType === 'channel'
        ? 'channel'
        : chatType === 'group' || chatType === 'supergroup'
          ? 'group'
          : 'unknown';

  const threadId =
    typeof rawMessage.message_thread_id === 'number' && Number.isFinite(rawMessage.message_thread_id)
      ? String(Math.trunc(rawMessage.message_thread_id))
      : null;

  if (params.requireTopics) {
    if (!isPrivateChat && (chatType !== 'supergroup' || threadId === null)) {
      return null;
    }
  }

  const sender = asRecord(rawMessage.from);
  const senderChat = asRecord(rawMessage.sender_chat);
  const senderIdFrom =
    sender && typeof sender.id === 'number' && Number.isFinite(sender.id) ? Math.trunc(sender.id) : null;
  const senderChatId =
    senderChat && typeof senderChat.id === 'number' && Number.isFinite(senderChat.id)
      ? Math.trunc(senderChat.id)
      : senderChat && typeof senderChat.id === 'string'
        ? senderChat.id.trim()
        : null;
  const senderId =
    senderIdFrom !== null
      ? String(senderIdFrom)
      : senderChatId !== null
        ? String(senderChatId)
        : null;
  const senderIsBot = sender?.is_bot === true;
  if (senderIsBot && senderIdFrom !== null && params.selfBotId !== null && senderIdFrom === params.selfBotId) {
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
    senderId,
    conversationKind,
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

function cloneWebhookQueueState(state: TelegramWebhookQueueState): TelegramWebhookQueueState {
  return {
    lastHandledWebhookUpdateId: state.lastHandledWebhookUpdateId,
    nextQueuedWebhookId: state.nextQueuedWebhookId,
    queuedWebhookUpdates: state.queuedWebhookUpdates.map((row) => ({
      id: row.id,
      update: row.update,
      updateId: row.updateId,
    })),
    queuedUpdateIds: new Set(state.queuedUpdateIds),
  };
}

function normalizeWebhookQueueSnapshot(snapshot: TelegramWebhookUpdateStoreSnapshot | null): TelegramWebhookQueueState {
  if (!snapshot) {
    return {
      lastHandledWebhookUpdateId: null,
      nextQueuedWebhookId: 1,
      queuedWebhookUpdates: [],
      queuedUpdateIds: new Set<number>(),
    };
  }

  const queuedWebhookUpdates: TelegramWebhookQueuedUpdate[] = [];
  const queuedUpdateIds = new Set<number>();
  let maxQueuedWebhookId = 0;

  for (const row of snapshot.queuedWebhookUpdates) {
    const id = Number.isFinite(row.id) ? Math.max(1, Math.trunc(row.id)) : null;
    if (id === null) {
      continue;
    }
    const updateId = parseUpdateId(row.update);
    queuedWebhookUpdates.push({
      id,
      update: row.update,
      updateId,
    });
    if (updateId !== null) {
      queuedUpdateIds.add(updateId);
    }
    if (id > maxQueuedWebhookId) {
      maxQueuedWebhookId = id;
    }
  }

  queuedWebhookUpdates.sort((left, right) => left.id - right.id);

  const nextQueuedWebhookId = Math.max(
    1,
    Math.trunc(snapshot.nextQueuedWebhookId),
    maxQueuedWebhookId + 1,
  );

  return {
    lastHandledWebhookUpdateId:
      typeof snapshot.lastHandledWebhookUpdateId === 'number' && Number.isFinite(snapshot.lastHandledWebhookUpdateId)
        ? Math.max(0, Math.trunc(snapshot.lastHandledWebhookUpdateId))
        : null,
    nextQueuedWebhookId,
    queuedWebhookUpdates,
    queuedUpdateIds,
  };
}

function webhookQueueSnapshotToStore(snapshot: TelegramWebhookQueueState): TelegramWebhookUpdateStoreSnapshot {
  return {
    lastHandledWebhookUpdateId: snapshot.lastHandledWebhookUpdateId,
    nextQueuedWebhookId: snapshot.nextQueuedWebhookId,
    queuedWebhookUpdates: snapshot.queuedWebhookUpdates.map((row) => ({
      id: row.id,
      update: row.update,
    })),
  };
}

export function createTelegramChannelAdapter(params: Readonly<{
  botToken: string;
  api?: TelegramApiClient;
  webhookMode?: boolean;
  updateLimit?: number;
  allowedChatIds?: ReadonlySet<string> | null;
  allowAllSharedChats?: boolean;
  requireTopics?: boolean;
  pollingCursorStore?: Readonly<{
    load: () => Promise<number | null>;
    save: (offset: number) => Promise<void>;
  }>;
  webhookUpdateStore?: TelegramWebhookUpdateStore;
}>): ChannelBridgeAdapter & Readonly<{ enqueueWebhookUpdate: (update: unknown) => void | Promise<void> }> {
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
   * If a `pollingCursorStore` is provided, the adapter loads and persists this cursor
   * (best-effort) so polling can resume after daemon restarts without replaying the
   * retention window. If not provided, the cursor is process-local and polling is
   * at-least-once across restarts.
   */
  let updateOffset: number | null = null;
  const pollingCursorStore = params.pollingCursorStore ?? null;
  let pollingCursorLoaded = false;
  let lastPersistedPollingOffset: number | null = null;
  let pollingCursorSaveQueue = Promise.resolve();
  let webhookQueueState: TelegramWebhookQueueState | null = null;
  let webhookQueueLoaded = false;
  let webhookQueueLoadPromise: Promise<void> | null = null;
  let webhookQueueMutationQueue = Promise.resolve();
  let droppedWebhookUpdates = 0;
  const pendingWebhookAcksByMessageKey = new Map<string, PendingWebhookAck>();
  let pendingPollingBatchAck: PendingPollingBatchAck | null = null;
  const webhookUpdateStore = params.webhookUpdateStore ?? null;

  async function ensurePollingCursorLoaded(): Promise<void> {
    if (pollingCursorLoaded) return;
    pollingCursorLoaded = true;
    if (!pollingCursorStore) return;

    try {
      const loaded = await pollingCursorStore.load();
      if (typeof loaded === 'number' && Number.isFinite(loaded)) {
        const candidate = Math.max(0, Math.trunc(loaded));
        updateOffset = updateOffset === null ? candidate : Math.max(updateOffset, candidate);
        lastPersistedPollingOffset = candidate;
      }
    } catch (error) {
      logger.warn('[channelBridge] Failed to load Telegram polling cursor; continuing with empty cursor', error);
    }
  }

  async function persistPollingOffset(offset: number): Promise<void> {
    if (!pollingCursorStore) return;
    if (lastPersistedPollingOffset !== null && offset <= lastPersistedPollingOffset) return;
    lastPersistedPollingOffset = offset;

    pollingCursorSaveQueue = pollingCursorSaveQueue
      .then(() => pollingCursorStore.save(offset))
      .catch((error) => {
        logger.warn('[channelBridge] Failed to persist Telegram polling cursor; continuing without persistence', error);
      });

    await pollingCursorSaveQueue;
  }

  function withWebhookQueueMutation<T>(work: () => Promise<T>): Promise<T> {
    const run = webhookQueueMutationQueue.then(work, work);
    webhookQueueMutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  function getWebhookQueueState(): TelegramWebhookQueueState {
    if (!webhookQueueState) {
      throw new Error('Telegram webhook queue is not loaded');
    }
    return webhookQueueState;
  }

  function setWebhookQueueState(nextState: TelegramWebhookQueueState): void {
    webhookQueueState = cloneWebhookQueueState(nextState);
  }

  async function ensureWebhookQueueLoaded(): Promise<void> {
    if (webhookQueueLoaded) return;
    if (webhookQueueLoadPromise) {
      await webhookQueueLoadPromise;
      return;
    }

    webhookQueueLoadPromise = (async () => {
      try {
        if (!webhookUpdateStore) {
          setWebhookQueueState(normalizeWebhookQueueSnapshot(null));
          return;
        }

        const loaded = await webhookUpdateStore.load();
        setWebhookQueueState(normalizeWebhookQueueSnapshot(loaded));
      } catch (error) {
        logger.warn('[channelBridge] Failed to load Telegram webhook queue; continuing with empty queue', error);
        setWebhookQueueState(normalizeWebhookQueueSnapshot(null));
      } finally {
        webhookQueueLoaded = true;
        webhookQueueLoadPromise = null;
      }
    })();

    await webhookQueueLoadPromise;
  }

  async function saveWebhookQueueState(nextState: TelegramWebhookQueueState): Promise<void> {
    if (!webhookUpdateStore) return;
    await webhookUpdateStore.save(webhookQueueSnapshotToStore(nextState));
  }

  function queueWebhookUpdateIdExists(state: TelegramWebhookQueueState, updateId: number): boolean {
    return state.queuedUpdateIds.has(updateId);
  }

  function removeQueuedWebhookUpdatesById(state: TelegramWebhookQueueState, ids: ReadonlySet<number>): TelegramWebhookQueueState {
    if (ids.size === 0) return state;

    const nextQueuedWebhookUpdates: TelegramWebhookQueuedUpdate[] = [];
    const nextQueuedUpdateIds = new Set<number>(state.queuedUpdateIds);
    let lastHandledWebhookUpdateId = state.lastHandledWebhookUpdateId;

    for (const row of state.queuedWebhookUpdates) {
      if (!ids.has(row.id)) {
        nextQueuedWebhookUpdates.push(row);
        continue;
      }

      if (row.updateId !== null) {
        nextQueuedUpdateIds.delete(row.updateId);
        lastHandledWebhookUpdateId =
          lastHandledWebhookUpdateId === null
            ? row.updateId
            : Math.max(lastHandledWebhookUpdateId, row.updateId);
      }
    }

    return {
      lastHandledWebhookUpdateId,
      nextQueuedWebhookId: state.nextQueuedWebhookId,
      queuedWebhookUpdates: nextQueuedWebhookUpdates,
      queuedUpdateIds: nextQueuedUpdateIds,
    };
  }

  function dropOldestWebhookUpdate(state: TelegramWebhookQueueState): Readonly<{
    state: TelegramWebhookQueueState;
    droppedQueueIds: ReadonlySet<number>;
  }> {
    if (state.queuedWebhookUpdates.length === 0) {
      return {
        state,
        droppedQueueIds: new Set<number>(),
      };
    }
    const [oldest, ...rest] = state.queuedWebhookUpdates;
    const nextQueuedUpdateIds = new Set<number>(state.queuedUpdateIds);
    if (oldest?.updateId !== null) {
      nextQueuedUpdateIds.delete(oldest.updateId);
    }
    return {
      state: {
        lastHandledWebhookUpdateId: state.lastHandledWebhookUpdateId,
        nextQueuedWebhookId: state.nextQueuedWebhookId,
        queuedWebhookUpdates: rest,
        queuedUpdateIds: nextQueuedUpdateIds,
      },
      droppedQueueIds: oldest ? new Set([oldest.id]) : new Set<number>(),
    };
  }

  function appendWebhookUpdate(state: TelegramWebhookQueueState, update: unknown): Readonly<{
    state: TelegramWebhookQueueState;
    droppedQueueIds: ReadonlySet<number>;
  }> {
    const updateId = parseUpdateId(update);
    if (updateId !== null) {
      if (state.lastHandledWebhookUpdateId !== null && updateId <= state.lastHandledWebhookUpdateId) {
        return { state, droppedQueueIds: new Set<number>() };
      }
      if (queueWebhookUpdateIdExists(state, updateId)) {
        return { state, droppedQueueIds: new Set<number>() };
      }
    }

    let nextState: TelegramWebhookQueueState = {
      lastHandledWebhookUpdateId: state.lastHandledWebhookUpdateId,
      nextQueuedWebhookId: state.nextQueuedWebhookId + 1,
      queuedWebhookUpdates: [
        ...state.queuedWebhookUpdates,
        {
          id: state.nextQueuedWebhookId,
          update,
          updateId,
        },
      ],
      queuedUpdateIds: updateId === null ? new Set(state.queuedUpdateIds) : new Set(state.queuedUpdateIds).add(updateId),
    };

    let droppedQueueIds = new Set<number>();
    if (nextState.queuedWebhookUpdates.length > MAX_WEBHOOK_QUEUE_SIZE) {
      const dropped = dropOldestWebhookUpdate(nextState);
      nextState = dropped.state;
      droppedQueueIds = new Set(dropped.droppedQueueIds);
    }

    return {
      state: nextState,
      droppedQueueIds,
    };
  }

  async function persistWebhookQueueOrWarn(state: TelegramWebhookQueueState): Promise<void> {
    if (!webhookUpdateStore) return;
    try {
      await saveWebhookQueueState(state);
    } catch (error) {
      logger.warn('[channelBridge] Failed to persist Telegram webhook queue; continuing without persistence', error);
    }
  }

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
    enqueueWebhookUpdate: (update: unknown) => withWebhookQueueMutation(async () => {
      await ensureWebhookQueueLoaded();
      const currentState = getWebhookQueueState();
      const appended = appendWebhookUpdate(currentState, update);
      if (appended.state === currentState) {
        return;
      }

      await saveWebhookQueueState(appended.state);
      setWebhookQueueState(appended.state);
      if (appended.droppedQueueIds.size > 0) {
        dropPendingWebhookAckIds(appended.droppedQueueIds);
        droppedWebhookUpdates += appended.droppedQueueIds.size;
      }
    }),
    pullInboundMessages: async () => {
      if (webhookMode) {
        const snapshot = await withWebhookQueueMutation(async () => {
          await ensureWebhookQueueLoaded();
          const currentState = getWebhookQueueState();
          return currentState.queuedWebhookUpdates.map((row) => ({
            id: row.id,
            update: row.update,
            updateId: row.updateId,
          }));
        });

        if (droppedWebhookUpdates > 0) {
          logger.warn(
            `[channelBridge] Telegram webhook queue overflow: dropped ${droppedWebhookUpdates} oldest update(s)`,
          );
          droppedWebhookUpdates = 0;
        }

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

          if (row.updateId !== null) {
            pending.maxUpdateId = pending.maxUpdateId === null ? row.updateId : Math.max(pending.maxUpdateId, row.updateId);
          }

          pendingWebhookAcksByMessageKey.set(key, pending);
        }

        if (consumedWithoutAck.size > 0) {
          await withWebhookQueueMutation(async () => {
            await ensureWebhookQueueLoaded();
            const currentState = getWebhookQueueState();
            const nextState = removeQueuedWebhookUpdatesById(currentState, consumedWithoutAck);
            if (nextState !== currentState) {
              setWebhookQueueState(nextState);
              await persistWebhookQueueOrWarn(nextState);
            }
            dropPendingWebhookAckIds(consumedWithoutAck);
          });
        }
        return parsed;
      }

      if (pendingPollingBatchAck) {
        return pendingPollingBatchAck.messages.map((message) => ({ ...message }));
      }

      await ensurePollingCursorLoaded();
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
          await persistPollingOffset(updateOffset);
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
          await persistPollingOffset(updateOffset);
        }

        pendingPollingBatchAck = null;
        return;
      }

      if (messages.length === 0) {
        return;
      }

      const consumedIds = new Set<number>();

      for (const message of messages) {
        const key = inboundMessageKey(message);
        const pending = pendingWebhookAcksByMessageKey.get(key);
        if (!pending) {
          continue;
        }

        for (const queueId of pending.queueIds) {
          consumedIds.add(queueId);
        }

        pendingWebhookAcksByMessageKey.delete(key);
      }

      if (consumedIds.size > 0) {
        await withWebhookQueueMutation(async () => {
          await ensureWebhookQueueLoaded();
          const currentState = getWebhookQueueState();
          const nextState = removeQueuedWebhookUpdatesById(currentState, consumedIds);
          if (nextState !== currentState) {
            setWebhookQueueState(nextState);
            await persistWebhookQueueOrWarn(nextState);
          }
          dropPendingWebhookAckIds(consumedIds);

          if (nextState.lastHandledWebhookUpdateId !== null) {
            const nextOffset = nextState.lastHandledWebhookUpdateId + 1;
            updateOffset = updateOffset === null ? nextOffset : Math.max(updateOffset, nextOffset);
            await persistPollingOffset(updateOffset);
          }
        });
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
