import { logger } from '@/ui/logger';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { subscribeSseJson } from './openCodeSse';
import type { OpenCodeGlobalEvent, OpenCodeModelRef, OpenCodeSession } from './types';
import { ensureSharedManagedOpenCodeServerBaseUrl } from './sharedManagedServer';

type PermissionReply = 'once' | 'always' | 'reject';

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed;
}

function resolveBasicAuthHeader(): string | null {
  const password = typeof process.env.OPENCODE_SERVER_PASSWORD === 'string' ? process.env.OPENCODE_SERVER_PASSWORD : '';
  if (!password) return null;
  const username = typeof process.env.OPENCODE_SERVER_USERNAME === 'string' && process.env.OPENCODE_SERVER_USERNAME.trim().length > 0
    ? process.env.OPENCODE_SERVER_USERNAME.trim()
    : 'opencode';
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path, `${baseUrl}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (typeof v === 'string' && v.length > 0) url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

async function fetchJson<T>(params: {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(params.url, {
    method: params.method,
    headers: {
      ...params.headers,
      ...(params.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenCode HTTP ${params.method} ${params.url} failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ''}`);
  }
  if (response.status === 204) return undefined as unknown as T;
  return (await response.json()) as T;
}

export type OpenCodeServerRuntimeClient = Readonly<{
  setDirectoryOverride: (directory: string) => void;
  sessionCreate: (opts?: { permission?: unknown[] }) => Promise<OpenCodeSession>;
  sessionGet: (opts: { sessionId: string }) => Promise<OpenCodeSession>;
  sessionMessagesList: (opts: { sessionId: string }) => Promise<unknown[]>;
  sessionStatusList: () => Promise<Record<string, { type?: string }>>;
  globalConfigGet: () => Promise<{ model?: string }>;
  agentsList: () => Promise<ReadonlyArray<{ name: string; description?: string }>>;
  providersList: () => Promise<ReadonlyArray<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>>;
  sessionPromptAsync: (opts: {
    sessionId: string;
    messageId?: string;
    parts: unknown[];
    agent?: string;
    model?: OpenCodeModelRef;
    config?: Record<string, unknown>;
  }) => Promise<void>;
  sessionAbort: (opts: { sessionId: string }) => Promise<void>;
  sessionFork: (opts: { sessionId: string; messageId?: string }) => Promise<OpenCodeSession>;
  permissionList: () => Promise<unknown[]>;
  questionList: () => Promise<unknown[]>;
  questionReply: (opts: { requestId: string; answers: string[][] }) => Promise<boolean>;
  questionReject: (opts: { requestId: string }) => Promise<boolean>;
  permissionReply: (opts: { requestId: string; reply: PermissionReply }) => Promise<boolean>;
  subscribeGlobalEvents: (opts: { signal: AbortSignal; onEvent: (evt: OpenCodeGlobalEvent) => void }) => Promise<void>;
  dispose: () => Promise<void>;
}>;

export async function createOpenCodeServerRuntimeClient(params: Readonly<{ directory: string; messageBuffer: MessageBuffer }>): Promise<OpenCodeServerRuntimeClient> {
  const envUrlRaw = typeof process.env.HAPPIER_OPENCODE_SERVER_URL === 'string' ? process.env.HAPPIER_OPENCODE_SERVER_URL.trim() : '';

  const authHeader = resolveBasicAuthHeader();
  const headers: Record<string, string> = authHeader ? { Authorization: authHeader } : {};

  let directoryOverride = '';
  const resolveDirectory = (): string => {
    const normalized = directoryOverride.trim() || params.directory.trim();
    return normalized;
  };

  const baseUrl = normalizeBaseUrl(
    envUrlRaw
      || await ensureSharedManagedOpenCodeServerBaseUrl({
        probeHealth: async (candidateBaseUrl) => {
          try {
            await fetchJson<{ healthy: boolean; version: string }>({
              url: buildUrl(candidateBaseUrl, '/global/health'),
              method: 'GET',
              headers,
            });
            return true;
          } catch {
            return false;
          }
        },
      }),
  );

  // Best-effort health probe (useful for diagnostics if url is stale).
  try {
    await fetchJson<{ healthy: boolean; version: string }>({
      url: buildUrl(baseUrl, '/global/health'),
      method: 'GET',
      headers,
    });
  } catch (error) {
    logger.debug('[OpenCodeServer] Health probe failed (non-fatal)', error);
  }

  let subscription: Awaited<ReturnType<typeof subscribeSseJson<OpenCodeGlobalEvent>>> | null = null;

  const client: OpenCodeServerRuntimeClient = {
    setDirectoryOverride: (directory) => {
      directoryOverride = typeof directory === 'string' ? directory : '';
    },
    sessionCreate: async (opts) => {
      return await fetchJson<OpenCodeSession>({
        url: buildUrl(baseUrl, '/session', { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {
          ...(Array.isArray(opts?.permission) ? { permission: opts?.permission } : {}),
        },
      });
    },
    sessionGet: async ({ sessionId }) => {
      return await fetchJson<OpenCodeSession>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}`, { directory: resolveDirectory() }),
        method: 'GET',
        headers,
      });
    },
    sessionMessagesList: async ({ sessionId }) => {
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/message`, { directory: resolveDirectory() }),
        method: 'GET',
        headers,
      });
      return Array.isArray(raw) ? raw : [];
    },
    sessionStatusList: async () => {
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, '/session/status', { directory: resolveDirectory() }),
        method: 'GET',
        headers,
      });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw as Record<string, { type?: string }>;
    },
    globalConfigGet: async () => {
      return await fetchJson<{ model?: string }>({
        url: buildUrl(baseUrl, '/global/config'),
        method: 'GET',
        headers,
      });
    },
    agentsList: async () => {
      const agents = await fetchJson<unknown>({
        url: buildUrl(baseUrl, '/agent'),
        method: 'GET',
        headers,
      });
      return Array.isArray(agents) ? agents as any : [];
    },
    providersList: async () => {
      const providers = await fetchJson<unknown>({
        url: buildUrl(baseUrl, '/provider'),
        method: 'GET',
        headers,
      });
      const all = providers && typeof providers === 'object' && !Array.isArray(providers) ? (providers as any).all : null;
      return Array.isArray(all) ? all as any : [];
    },
    sessionPromptAsync: async ({ sessionId, messageId, parts, agent, model, config }) => {
      await fetchJson<void>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/prompt_async`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {
          ...(messageId ? { messageID: messageId } : {}),
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(config ? { config } : {}),
          parts,
        },
      });
    },
    sessionAbort: async ({ sessionId }) => {
      await fetchJson<void>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/abort`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {},
      });
    },
    sessionFork: async ({ sessionId, messageId }) => {
      return await fetchJson<OpenCodeSession>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/fork`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: messageId ? { messageID: messageId } : {},
      });
    },
    questionReply: async ({ requestId, answers }) => {
      return await fetchJson<boolean>({
        url: buildUrl(baseUrl, `/question/${encodeURIComponent(requestId)}/reply`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: { answers },
      });
    },
    questionReject: async ({ requestId }) => {
      return await fetchJson<boolean>({
        url: buildUrl(baseUrl, `/question/${encodeURIComponent(requestId)}/reject`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {},
      });
    },
    permissionReply: async ({ requestId, reply }) => {
      return await fetchJson<boolean>({
        url: buildUrl(baseUrl, `/permission/${encodeURIComponent(requestId)}/reply`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: { reply },
      });
    },
    permissionList: async () => {
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, '/permission', { directory: resolveDirectory() }),
        method: 'GET',
        headers,
      });
      return Array.isArray(raw) ? raw : [];
    },
    questionList: async () => {
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, '/question', { directory: resolveDirectory() }),
        method: 'GET',
        headers,
      });
      return Array.isArray(raw) ? raw : [];
    },
    subscribeGlobalEvents: async ({ signal, onEvent }) => {
      if (subscription) return;
      subscription = await subscribeSseJson<OpenCodeGlobalEvent>({
        url: buildUrl(baseUrl, '/global/event'),
        headers,
        signal,
        onMessage: (msg) => onEvent(msg),
      });
      // Detach: keep running until caller aborts.
      void subscription.done.catch(() => {});
    },
    dispose: async () => {
      if (subscription) {
        try {
          subscription.close();
          await subscription.done.catch(() => {});
        } catch {
          // ignore
        }
        subscription = null;
      }
    },
  };

  return client;
}
