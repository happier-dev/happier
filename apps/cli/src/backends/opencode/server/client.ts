import { logger } from '@/ui/logger';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { resolveOpenCodeServerAuthHeadersFromEnv } from './openCodeServerAuth';
import { subscribeSseJson } from './openCodeSse';
import type { OpenCodeGlobalEvent, OpenCodeModelRef, OpenCodeSession } from './types';
import { waitForOpenCodeServerHealth } from './waitForOpenCodeServerHealth';
import {
  ensureSharedManagedOpenCodeServerBaseUrl,
  isLoopbackManagedOpenCodeBaseUrl,
  readSharedManagedOpenCodeServerStateBestEffort,
} from './sharedManagedServer';

type PermissionReply = 'once' | 'always' | 'reject';

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed;
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

function redactOpenCodeUrlForError(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('directory')) {
      url.searchParams.set('directory', '<redacted>');
    }
    return url.toString();
  } catch {
    // Best-effort redaction for non-URL strings.
    return String(rawUrl ?? '').replace(/([?&]directory=)[^&#]*/gu, '$1<redacted>');
  }
}

function resolveOpenCodeServerHttpTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env.HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS;
  const defaultTimeoutMs = 60_000;
  if (typeof raw !== 'string') return defaultTimeoutMs;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultTimeoutMs;
  // Fail closed on absurdly low timeouts: these tend to create flakey control-plane polling and
  // false-negative health probes under normal load.
  const clamped = Math.min(120_000, Math.trunc(parsed));
  if (clamped < 1000) return defaultTimeoutMs;
  return clamped;
}

async function fetchJson<T>(params: {
  url: string;
  method: 'GET' | 'PATCH' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number | null;
}): Promise<T> {
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) ? params.timeoutMs : null;
  const ctrl = timeoutMs ? new AbortController() : null;
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        ctrl?.abort();
      }, timeoutMs)
    : null;
  timer?.unref?.();

  let response: Response;
  try {
    response = await fetch(params.url, {
      method: params.method,
      headers: {
        ...params.headers,
        ...(params.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
  } catch (error) {
    if (timedOut && timeoutMs) {
      throw new Error(`OpenCode HTTP ${params.method} ${redactOpenCodeUrlForError(params.url)} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `OpenCode HTTP ${params.method} ${redactOpenCodeUrlForError(params.url)} failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ''}`
    );
  }
  if (response.status === 204) return undefined as unknown as T;
  return (await response.json()) as T;
}

function isRetryableManagedServerTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('opencode http ')) return false;
  return (
    normalized.includes('fetch failed')
    || normalized.includes('econnrefused')
    || normalized.includes('econnreset')
    || normalized.includes('socket hang up')
    || normalized.includes('connect_error')
    || normalized.includes('terminated')
    || normalized.includes('networkerror')
    || normalized.includes('other side closed')
  );
}

export type OpenCodeServerRuntimeClient = Readonly<{
  setDirectoryOverride: (directory: string) => void;
  sessionList: () => Promise<unknown[]>;
  sessionCreate: (opts?: { permission?: unknown[] }) => Promise<OpenCodeSession>;
  sessionGet: (opts: { sessionId: string }) => Promise<OpenCodeSession>;
  sessionUpdate: (opts: { sessionId: string; permission?: unknown[]; title?: string; time?: { archived?: number } }) => Promise<OpenCodeSession>;
  sessionMessagesList: (opts: { sessionId: string }) => Promise<unknown[]>;
  sessionDiff: (opts: { sessionId: string; messageId?: string }) => Promise<unknown[]>;
  sessionStatusList: () => Promise<Record<string, { type?: string }>>;
  globalConfigGet: () => Promise<{ model?: string }>;
  agentsList: () => Promise<ReadonlyArray<{ name: string; description?: string }>>;
  providersList: () => Promise<ReadonlyArray<{ id: string; env?: readonly string[]; models?: Record<string, unknown> }>>;
  mcpAdd: (opts: { name: string; config: unknown }) => Promise<void>;
  mcpDisconnect: (opts: { name: string }) => Promise<void>;
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

function resolveSseReconnectDelayMs(attempt: number, env: NodeJS.ProcessEnv): number {
  const baseRaw = Number.parseInt(String(env.HAPPIER_OPENCODE_SSE_RECONNECT_BASE_DELAY_MS ?? ''), 10);
  const maxRaw = Number.parseInt(String(env.HAPPIER_OPENCODE_SSE_RECONNECT_MAX_DELAY_MS ?? ''), 10);
  const baseMs = Number.isFinite(baseRaw) && baseRaw > 0 ? Math.trunc(baseRaw) : 250;
  const maxMs = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.trunc(maxRaw) : 5_000;

  const clampedBase = Math.max(5, Math.min(30_000, baseMs));
  const clampedMax = Math.max(clampedBase, Math.min(120_000, maxMs));

  const exp = Math.min(20, Math.max(0, Math.trunc(attempt)));
  const rawDelay = Math.min(clampedMax, clampedBase * (2 ** exp));
  // Add a small jitter so multiple sessions don't reconnect in lockstep.
  const jitter = Math.floor(rawDelay * 0.15 * Math.random());
  return Math.min(clampedMax, rawDelay + jitter);
}

async function sleepUntilOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const cleanup = (onAbort: () => void, timer: ReturnType<typeof setTimeout>) => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup(onAbort, timer);
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup(onAbort, timer);
      resolve();
    }, ms);
    timer.unref?.();

    signal.addEventListener('abort', onAbort);
  });
}

export async function createOpenCodeServerRuntimeClient(params: Readonly<{ directory: string; messageBuffer: MessageBuffer; baseUrlOverride?: string | null; env?: NodeJS.ProcessEnv }>): Promise<OpenCodeServerRuntimeClient> {
  const env = params.env ?? process.env;
  const httpTimeoutMs = resolveOpenCodeServerHttpTimeoutMs(env);
  const baseUrlOverrideRaw = typeof params.baseUrlOverride === 'string' ? params.baseUrlOverride.trim() : '';
  const envUrlRaw = typeof env.HAPPIER_OPENCODE_SERVER_URL === 'string' ? env.HAPPIER_OPENCODE_SERVER_URL.trim() : '';
  const usingManagedServer = baseUrlOverrideRaw.length === 0 && envUrlRaw.length === 0;

  const headers = resolveOpenCodeServerAuthHeadersFromEnv(env);

  let directoryOverride = '';
  const resolveDirectory = (): string => {
    const normalized = directoryOverride.trim() || params.directory.trim();
    return normalized;
  };

  const probeHealth = async (candidateBaseUrl: string): Promise<boolean> => {
    try {
      const probeTimeoutMs = httpTimeoutMs ? Math.min(2_000, httpTimeoutMs) : 900;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), probeTimeoutMs);
      timer.unref?.();
      const res = await fetch(buildUrl(candidateBaseUrl, '/global/health'), { method: 'GET', headers, signal: ctrl.signal }).catch(() => null);
      clearTimeout(timer);
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  };

  let baseUrl = normalizeBaseUrl(
    baseUrlOverrideRaw
      || envUrlRaw
      || await ensureSharedManagedOpenCodeServerBaseUrl({
        probeHealth,
      }),
  );

  const refreshBaseUrlIfManagedBestEffort = async (): Promise<void> => {
    if (!usingManagedServer) return;

    const state = await readSharedManagedOpenCodeServerStateBestEffort().catch(() => null);
    if (state?.baseUrl && isLoopbackManagedOpenCodeBaseUrl(state.baseUrl)) {
      const normalized = normalizeBaseUrl(state.baseUrl);
      if (normalized && normalized !== baseUrl) {
        baseUrl = normalized;
      }
    }

    // Avoid spawning/killing a managed server on the first sign of an SSE disconnect.
    // Prefer using the existing baseUrl when it still looks healthy.
    if (!state) {
      const healthy = await probeHealth(baseUrl).catch(() => false);
      if (healthy) return;
    } else {
      const pidAlive = (() => {
        try {
          process.kill(state.pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (pidAlive) {
        const healthy = await probeHealth(baseUrl).catch(() => false);
        if (healthy) return;
      }
    }

    try {
      baseUrl = normalizeBaseUrl(
        await ensureSharedManagedOpenCodeServerBaseUrl({
          probeHealth,
        }),
      );
    } catch {
      // Ignore (caller will retry with backoff).
    }
  };

  const waitForManagedServerHealthAfterRefreshBestEffort = async (): Promise<void> => {
    if (!usingManagedServer) return;
    try {
      await waitForOpenCodeServerHealth({
        baseUrl,
        timeoutMs: 2_000,
        pollIntervalMs: 100,
        headers,
      });
    } catch {
      // best-effort only; caller will decide whether to propagate the original error
    }
  };

  const fetchJsonWithManagedServerRetry = async <T>(
    request: (currentBaseUrl: string) => Promise<T>,
  ): Promise<T> => {
    try {
      return await request(baseUrl);
    } catch (error) {
      if (!usingManagedServer || !isRetryableManagedServerTransportError(error)) {
        throw error;
      }
      logger.debug('[OpenCodeServer] Retrying managed HTTP request after transient transport failure', error);
      await refreshBaseUrlIfManagedBestEffort();
      await waitForManagedServerHealthAfterRefreshBestEffort();
      return await request(baseUrl);
    }
  };

  // Best-effort health probe (useful for diagnostics if url is stale).
  try {
    await fetchJson<{ healthy: boolean; version: string }>({
      url: buildUrl(baseUrl, '/global/health'),
      method: 'GET',
      headers,
      timeoutMs: Math.min(2_000, httpTimeoutMs ?? 2_000),
    });
  } catch (error) {
    logger.debug('[OpenCodeServer] Health probe failed (non-fatal)', error);
  }

  let subscription: Awaited<ReturnType<typeof subscribeSseJson<OpenCodeGlobalEvent>>> | null = null;
  let subscriptionLoop: Promise<void> | null = null;
  let subscriptionLoopAbort: AbortController | null = null;
  let lastEventId: string | null = null;
  let disposed = false;

  const client: OpenCodeServerRuntimeClient = {
    setDirectoryOverride: (directory) => {
      directoryOverride = typeof directory === 'string' ? directory : '';
    },
    sessionList: async () => {
      const raw = await fetchJson<unknown>({
        url: buildUrl(baseUrl, '/session', { directory: resolveDirectory() }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
      return Array.isArray(raw) ? raw : [];
    },
    sessionCreate: async (opts) => {
      return await fetchJson<OpenCodeSession>({
        url: buildUrl(baseUrl, '/session', { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {
          ...(Array.isArray(opts?.permission) ? { permission: opts?.permission } : {}),
        },
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionGet: async ({ sessionId }) => {
      return await fetchJson<OpenCodeSession>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}`, { directory: resolveDirectory() }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionUpdate: async ({ sessionId, permission, title, time }) => {
      const body: Record<string, unknown> = {};
      if (Array.isArray(permission)) {
        body.permission = permission;
      }
      if (typeof title === 'string') {
        body.title = title;
      }
      if (time && typeof time === 'object') {
        body.time = time;
      }

      return await fetchJsonWithManagedServerRetry((currentBaseUrl) => fetchJson<OpenCodeSession>({
        url: buildUrl(currentBaseUrl, `/session/${encodeURIComponent(sessionId)}`, { directory: resolveDirectory() }),
        method: 'PATCH',
        headers,
        body,
        timeoutMs: httpTimeoutMs,
      }));
    },
    sessionMessagesList: async ({ sessionId }) => {
      const raw = await fetchJsonWithManagedServerRetry((currentBaseUrl) => fetchJson<unknown>({
        url: buildUrl(currentBaseUrl, `/session/${encodeURIComponent(sessionId)}/message`, { directory: resolveDirectory() }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      }));
      return Array.isArray(raw) ? raw : [];
    },
    sessionDiff: async ({ sessionId, messageId }) => {
      const raw = await fetchJsonWithManagedServerRetry((currentBaseUrl) => fetchJson<unknown>({
        url: buildUrl(currentBaseUrl, `/session/${encodeURIComponent(sessionId)}/diff`, {
          directory: resolveDirectory(),
          ...(messageId ? { messageID: messageId } : {}),
        }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      }));
      return Array.isArray(raw) ? raw : [];
    },
    sessionStatusList: async () => {
      const raw = await fetchJsonWithManagedServerRetry((currentBaseUrl) => fetchJson<unknown>({
        url: buildUrl(currentBaseUrl, '/session/status', { directory: resolveDirectory() }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      }));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw as Record<string, { type?: string }>;
    },
    globalConfigGet: async () => {
      return await fetchJson<{ model?: string }>({
        url: buildUrl(baseUrl, '/global/config'),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
    },
    agentsList: async () => {
      const agents = await fetchJson<unknown>({
        url: buildUrl(baseUrl, '/agent'),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
      return Array.isArray(agents) ? agents as any : [];
    },
    providersList: async () => {
      const providers = await fetchJson<unknown>({
        url: buildUrl(baseUrl, '/provider'),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      });
      const all = providers && typeof providers === 'object' && !Array.isArray(providers) ? (providers as any).all : null;
      return Array.isArray(all) ? all as any : [];
    },
    mcpAdd: async ({ name, config }) => {
      const serverName = typeof name === 'string' ? name.trim() : '';
      if (!serverName) return;
      await fetchJson<void>({
        url: buildUrl(baseUrl, '/mcp', { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {
          name: serverName,
          config,
        },
        timeoutMs: httpTimeoutMs,
      });
    },
    mcpDisconnect: async ({ name }) => {
      const serverName = typeof name === 'string' ? name.trim() : '';
      if (!serverName) return;
      await fetchJson<void>({
        url: buildUrl(baseUrl, `/mcp/${encodeURIComponent(serverName)}/disconnect`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {},
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionPromptAsync: async ({ sessionId, messageId, parts, agent, model, config }) => {
      await fetchJsonWithManagedServerRetry((currentBaseUrl) => fetchJson<void>({
        url: buildUrl(currentBaseUrl, `/session/${encodeURIComponent(sessionId)}/prompt_async`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {
          ...(messageId ? { messageID: messageId } : {}),
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(config ? { config } : {}),
          parts,
        },
        timeoutMs: httpTimeoutMs,
      }));
    },
    sessionAbort: async ({ sessionId }) => {
      await fetchJson<void>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/abort`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {},
        timeoutMs: httpTimeoutMs,
      });
    },
    sessionFork: async ({ sessionId, messageId }) => {
      return await fetchJson<OpenCodeSession>({
        url: buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/fork`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: messageId ? { messageID: messageId } : {},
        timeoutMs: httpTimeoutMs,
      });
    },
    questionReply: async ({ requestId, answers }) => {
      return await fetchJson<boolean>({
        url: buildUrl(baseUrl, `/question/${encodeURIComponent(requestId)}/reply`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: { answers },
        timeoutMs: httpTimeoutMs,
      });
    },
    questionReject: async ({ requestId }) => {
      return await fetchJson<boolean>({
        url: buildUrl(baseUrl, `/question/${encodeURIComponent(requestId)}/reject`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: {},
        timeoutMs: httpTimeoutMs,
      });
    },
    permissionReply: async ({ requestId, reply }) => {
      return await fetchJson<boolean>({
        url: buildUrl(baseUrl, `/permission/${encodeURIComponent(requestId)}/reply`, { directory: resolveDirectory() }),
        method: 'POST',
        headers,
        body: { reply },
        timeoutMs: httpTimeoutMs,
      });
    },
    permissionList: async () => {
      const raw = await fetchJsonWithManagedServerRetry((currentBaseUrl) => fetchJson<unknown>({
        url: buildUrl(currentBaseUrl, '/permission', { directory: resolveDirectory() }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      }));
      if (!Array.isArray(raw)) {
        throw new Error('OpenCode permission list returned invalid data');
      }
      return raw;
    },
    questionList: async () => {
      const raw = await fetchJsonWithManagedServerRetry((currentBaseUrl) => fetchJson<unknown>({
        url: buildUrl(currentBaseUrl, '/question', { directory: resolveDirectory() }),
        method: 'GET',
        headers,
        timeoutMs: httpTimeoutMs,
      }));
      if (!Array.isArray(raw)) {
        throw new Error('OpenCode question list returned invalid data');
      }
      return raw;
    },
    subscribeGlobalEvents: async ({ signal, onEvent }) => {
      if (disposed) return;
      if (subscriptionLoop) return;

      subscriptionLoop = (async () => {
        const localAbort = new AbortController();
        subscriptionLoopAbort = localAbort;

        let attempt = 0;
        while (!disposed && !signal.aborted && !localAbort.signal.aborted) {
          const combinedAbort = new AbortController();
          const onAbort = () => {
            try {
              combinedAbort.abort();
            } catch {
              // ignore
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
          localAbort.signal.addEventListener('abort', onAbort, { once: true });

          try {
            const url = buildUrl(baseUrl, '/global/event');
            const nextHeaders: Record<string, string> = { ...headers };
            if (lastEventId) nextHeaders['Last-Event-ID'] = lastEventId;
            subscription = await subscribeSseJson<OpenCodeGlobalEvent>({
              url,
              headers: nextHeaders,
              signal: combinedAbort.signal,
              onMessage: (msg, meta) => {
                if (meta?.id) lastEventId = meta.id;
                onEvent(msg);
              },
            });
            await subscription.done;
            attempt = 0;
          } catch (error) {
            if (disposed || signal.aborted || localAbort.signal.aborted) break;
            logger.debug('[OpenCodeServer] SSE stream ended; reconnecting (best-effort)', error);
            await refreshBaseUrlIfManagedBestEffort();
            const delayMs = resolveSseReconnectDelayMs(attempt, env);
            attempt += 1;
            await sleepUntilOrAbort(delayMs, combinedAbort.signal);
          } finally {
            if (subscription) {
              try {
                subscription.close();
              } catch {
                // ignore
              }
            }
            subscription = null;
            signal.removeEventListener('abort', onAbort);
            localAbort.signal.removeEventListener('abort', onAbort);
          }
        }
      })();
    },
    dispose: async () => {
      disposed = true;
      if (subscriptionLoopAbort) {
        try {
          subscriptionLoopAbort.abort();
        } catch {
          // ignore
        }
      }
      if (subscription) {
        try {
          subscription.close();
          await subscription.done.catch(() => {});
        } catch {
          // ignore
        }
        subscription = null;
      }
      if (subscriptionLoop) {
        try {
          await subscriptionLoop.catch(() => {});
        } catch {
          // ignore
        }
        subscriptionLoop = null;
      }
      subscriptionLoopAbort = null;
    },
  };

  return client;
}
