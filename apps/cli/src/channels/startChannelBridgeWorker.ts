import { randomUUID } from 'node:crypto';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { fetchEncryptedTranscriptPageAfterSeq, fetchEncryptedTranscriptPageLatest } from '@/api/session/fetchEncryptedTranscriptWindow';
import type { Credentials } from '@/persistence';
import { decryptTranscriptRows } from '@/session/replay/decryptTranscriptRows';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import {
  encryptSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionMetadata,
  type SessionEncryptionContext,
} from '@/sessionControl/sessionEncryptionContext';
import { sendSessionMessageViaSocketCommitted } from '@/sessionControl/sessionSocketSendMessage';
import { fetchSessionById, fetchSessionsPage, type RawSessionListRow } from '@/sessionControl/sessionsHttp';
import { logger } from '@/ui/logger';

import {
  createInMemoryChannelBindingStore,
  startChannelBridgeWorker,
  type ChannelBindingStore,
  type ChannelBridgeAdapter,
  type ChannelBridgeDeps,
  type ChannelBridgeWorkerHandle,
} from './core/channelBridgeWorker';
import { resolveChannelBridgeRuntimeConfig } from './channelBridgeConfig';
import { createServerBackedChannelBindingStore } from './channelBindingStore.server';
import { createAxiosChannelBridgeKvClient } from './channelBridgeServerKv';
import { createTelegramChannelAdapter } from './telegram/telegramAdapter';
import { startTelegramWebhookRelay, type TelegramWebhookRelayHandle } from './telegram/telegramWebhookRelay';

export type ChannelBridgeRuntimeHandle = ChannelBridgeWorkerHandle;

type DefaultChannelBridgeDepsHandle = Readonly<{
  deps: ChannelBridgeDeps;
  dispose: () => void;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractAssistantText(content: unknown): string | null {
  const contentRecord = asRecord(content);
  if (!contentRecord) return null;

  const type = contentRecord.type;
  if (type === 'text') {
    const text = contentRecord.text;
    return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
  }

  if (type === 'acp') {
    const data = asRecord(contentRecord.data);
    if (!data) return null;

    const dataType = data.type;
    if (dataType === 'message' || dataType === 'reasoning') {
      const message = data.message;
      return typeof message === 'string' && message.trim().length > 0 ? message.trim() : null;
    }
    return null;
  }

  if (type === 'output') {
    const data = asRecord(contentRecord.data);
    if (!data) return null;

    const message = data.message;
    return typeof message === 'string' && message.trim().length > 0 ? message.trim() : null;
  }

  return null;
}

type PlainTranscriptRowLike = Readonly<{
  seq: number;
  createdAt: number;
  content: unknown;
}>;

function parsePlainTranscriptRows(rows: readonly PlainTranscriptRowLike[]): ReadonlyArray<Readonly<{
  seq: number;
  createdAtMs: number;
  role: 'user' | 'agent';
  content: unknown;
}>> {
  const out: Array<Readonly<{
    seq: number;
    createdAtMs: number;
    role: 'user' | 'agent';
    content: unknown;
  }>> = [];

  for (const row of rows) {
    const content = asRecord(row.content);
    if (!content || content.t !== 'plain') continue;
    const value = asRecord(content.v);
    if (!value) continue;

    const role = value.role;
    if (role !== 'user' && role !== 'agent') continue;

    out.push({
      seq: row.seq,
      createdAtMs: row.createdAt,
      role,
      content: value.content,
    });
  }

  return out;
}

function createDefaultChannelBridgeDeps(credentials: Credentials): DefaultChannelBridgeDepsHandle {
  type CachedSessionRuntime = Readonly<{
    ctx: SessionEncryptionContext;
    mode: ReturnType<typeof resolveSessionStoredContentEncryptionMode>;
  }>;

  const sessionRuntimeCache = new Map<string, CachedSessionRuntime>();
  const SESSION_CTX_CACHE_MAX_ENTRIES = 200;

  const rememberSessionRuntime = (sessionId: string, runtime: CachedSessionRuntime): CachedSessionRuntime => {
    if (sessionRuntimeCache.has(sessionId)) {
      sessionRuntimeCache.delete(sessionId);
    }
    sessionRuntimeCache.set(sessionId, runtime);
    while (sessionRuntimeCache.size > SESSION_CTX_CACHE_MAX_ENTRIES) {
      const oldestKey = sessionRuntimeCache.keys().next().value;
      if (!oldestKey) break;
      sessionRuntimeCache.delete(oldestKey);
    }
    return runtime;
  };

  async function resolveSessionRuntime(sessionId: string): Promise<CachedSessionRuntime | null> {
    const cached = sessionRuntimeCache.get(sessionId);
    if (cached) return rememberSessionRuntime(sessionId, cached);

    const rawSession = await fetchSessionById({ token: credentials.token, sessionId });
    if (!rawSession) return null;
    const runtime: CachedSessionRuntime = {
      ctx: resolveSessionEncryptionContextFromCredentials(credentials, rawSession),
      mode: resolveSessionStoredContentEncryptionMode(rawSession),
    };
    return rememberSessionRuntime(sessionId, runtime);
  }

  return {
    deps: {
    listSessions: async () => {
      const displayLimit = 20;
      const pageSize = 100;
      const maxPages = 50;
      const sessions: RawSessionListRow[] = [];
      let cursor: string | undefined;

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page = await fetchSessionsPage({
          token: credentials.token,
          activeOnly: false,
          limit: pageSize,
          cursor,
        });
        sessions.push(...page.sessions);
        if (sessions.length >= displayLimit) {
          cursor = undefined;
          break;
        }
        if (!page.hasNext || !page.nextCursor) {
          cursor = undefined;
          break;
        }
        cursor = page.nextCursor;
      }

      if (cursor) {
        logger.warn(`[channelBridge] Session list pagination stopped after ${maxPages} pages; truncating /sessions results`);
      }

      return sessions.slice(0, displayLimit).map((row) => {
        const meta = tryDecryptSessionMetadata({ credentials, rawSession: row });
        const tagRaw = meta?.tag;
        const tag = typeof tagRaw === 'string' ? tagRaw.trim() : '';
        return {
          sessionId: row.id,
          label: tag.length > 0 ? tag : null,
        };
      });
    },
    resolveSessionIdOrPrefix: async (idOrPrefix: string) => {
      return await resolveSessionIdOrPrefix({
        credentials,
        idOrPrefix,
      });
    },
    sendUserMessageToSession: async (params) => {
      const runtime = await resolveSessionRuntime(params.sessionId);
      if (!runtime) {
        throw new Error(`Session not found: ${params.sessionId}`);
      }

      const ctx = runtime.ctx;
      const mode = runtime.mode;
      const record = {
        role: 'user',
        content: { type: 'text', text: params.text },
        meta: {
          sentFrom: params.sentFrom,
          source: params.sentFrom,
          channel: {
            providerId: params.providerId,
            conversationId: params.conversationId,
            threadId: params.threadId,
          },
        },
      };

      const content =
        mode === 'plain'
          ? ({ t: 'plain', v: record } as const)
          : ({ t: 'encrypted', c: encryptSessionPayload({ ctx, payload: record }) } as const);

      await sendSessionMessageViaSocketCommitted({
        token: credentials.token,
        sessionId: params.sessionId,
        content,
        localId: randomUUID(),
        sentFrom: params.sentFrom,
      });
    },
    resolveLatestSessionSeq: async (sessionId: string) => {
      const rows = await fetchEncryptedTranscriptPageLatest({
        token: credentials.token,
        sessionId,
        limit: 1,
      });
      if (rows.length === 0) return 0;
      return Math.max(0, Math.trunc(rows[0]!.seq));
    },
    fetchAgentMessagesAfterSeq: async ({ sessionId, afterSeq }) => {
      const runtime = await resolveSessionRuntime(sessionId);
      if (!runtime) return [];

      const encrypted = await fetchEncryptedTranscriptPageAfterSeq({
        token: credentials.token,
        sessionId,
        afterSeq,
        limit: 50,
      });

      const transcriptRows = runtime.mode === 'plain'
        ? parsePlainTranscriptRows(encrypted)
        : decryptTranscriptRows({
          ctx: runtime.ctx,
          rows: encrypted,
        });

      return transcriptRows
        .filter((row) => row.role === 'agent')
        .map((row) => ({ seq: row.seq, text: extractAssistantText(row.content) }))
        .filter((row) => typeof row.text === 'string' && row.text.trim().length > 0)
        .map((row) => ({ seq: row.seq, text: row.text! }));
    },
    onWarning: (message, error) => {
      if (typeof error === 'undefined') {
        logger.warn(`[channelBridge] ${message}`);
      } else {
        logger.warn(`[channelBridge] ${message}`, serializeAxiosErrorForLog(error));
      }
    },
    },
    dispose: () => {
      sessionRuntimeCache.clear();
    },
  };
}

export async function startChannelBridgeFromEnv(params: Readonly<{
  credentials: Credentials;
  env?: NodeJS.ProcessEnv;
  settings?: unknown;
  serverId?: string | null;
  accountId?: string | null;
  deps?: ChannelBridgeDeps;
  store?: ChannelBindingStore;
  adapters?: readonly ChannelBridgeAdapter[];
}>): Promise<ChannelBridgeWorkerHandle | null> {
  const env = params.env ?? process.env;
  const runtimeConfig = resolveChannelBridgeRuntimeConfig({
    env,
    settings: params.settings,
    serverId: params.serverId,
    accountId: params.accountId,
  });

  let relayHandle: TelegramWebhookRelayHandle | null = null;
  const adapters: ChannelBridgeAdapter[] = params.adapters ? [...params.adapters] : [];
  if (adapters.length === 0) {
    const botToken = runtimeConfig.telegram.botToken;
    if (!botToken) {
      return null;
    }

    const allowedChatIdsRaw = runtimeConfig.telegram.allowedChatIds;
    const allowedChatIds = allowedChatIdsRaw.length > 0 ? new Set(allowedChatIdsRaw) : null;
    const webhookEnabled = runtimeConfig.telegram.webhookEnabled;
    const webhookSecret = runtimeConfig.telegram.webhookSecret;
    const requireTopics = runtimeConfig.telegram.requireTopics;

    if (webhookEnabled && webhookSecret.length === 0) {
      logger.warn('[channelBridge] Telegram webhook.enabled=true but webhook.secret is missing; falling back to polling mode');
    }

    const webhookModeRequested = webhookEnabled && webhookSecret.length > 0;
    let telegramAdapter = createTelegramChannelAdapter({
      botToken,
      allowedChatIds,
      requireTopics,
      webhookMode: webhookModeRequested,
    });

    const telegramAdapterIndex = adapters.push(telegramAdapter) - 1;

    if (webhookModeRequested) {
      const port = runtimeConfig.telegram.webhookPort;
      const host = runtimeConfig.telegram.webhookHost;
      try {
        relayHandle = await startTelegramWebhookRelay({
          port,
          host,
          // We intentionally use one shared secret today because bridge config currently
          // exposes a single webhook secret field. The relay API keeps both knobs
          // separate so we can split path/header secrets in a future config version.
          secretPathToken: webhookSecret,
          secretHeaderToken: webhookSecret,
          onUpdate: telegramAdapter.enqueueWebhookUpdate,
        });
        logger.debug(
          `[channelBridge] Telegram webhook relay listening on http://${host}:${relayHandle.port} (path redacted)`,
        );
      } catch (error) {
        logger.warn(
          '[channelBridge] Failed to start Telegram webhook relay; bridge will continue without webhook relay',
          serializeAxiosErrorForLog(error),
        );
        telegramAdapter = createTelegramChannelAdapter({
          botToken,
          allowedChatIds,
          requireTopics,
          webhookMode: false,
        });
        adapters[telegramAdapterIndex] = telegramAdapter;
        logger.warn('[channelBridge] Falling back to Telegram polling mode because webhook relay failed to start');
      }
    }
  }

  if (adapters.length === 0) {
    return null;
  }

  let defaultDepsHandle: DefaultChannelBridgeDepsHandle | null = null;
  const deps = (() => {
    if (params.deps) return params.deps;
    defaultDepsHandle = createDefaultChannelBridgeDeps(params.credentials);
    return defaultDepsHandle.deps;
  })();
  let store = params.store ?? null;
  if (!store) {
    const serverId = typeof params.serverId === 'string' ? params.serverId.trim() : '';
    const accountId = typeof params.accountId === 'string' ? params.accountId.trim() : '';
    if (serverId && accountId) {
      const kv = createAxiosChannelBridgeKvClient({ token: params.credentials.token });
      store = createServerBackedChannelBindingStore({
        kv,
        serverId,
        accountId,
      });
    }
  }
  if (!store) {
    store = createInMemoryChannelBindingStore();
  }
  const tickMs = runtimeConfig.tickMs;

  let worker: ChannelBridgeWorkerHandle;
  try {
    worker = startChannelBridgeWorker({
      store,
      adapters,
      deps,
      tickMs,
    });
  } catch (error) {
    if (relayHandle) {
      await relayHandle.stop().catch(() => undefined);
    }
    defaultDepsHandle?.dispose();
    throw error;
  }

  return {
    trigger: worker.trigger,
    stop: async () => {
      try {
        await worker.stop();
      } finally {
        try {
          if (relayHandle) {
            await relayHandle.stop().catch((error: unknown) => {
              logger.warn('[channelBridge] Error stopping webhook relay during shutdown', error);
            });
          }
        } finally {
          defaultDepsHandle?.dispose();
        }
      }
    },
  };
}
