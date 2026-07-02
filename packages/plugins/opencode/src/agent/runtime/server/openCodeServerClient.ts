import type { FetchRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { asRecord, normalizeString } from './openCodeParsing.js';
import { OpenCodeSseReadIdleTimeoutError, subscribeSseJson } from './openCodeSse.js';

export type OpenCodeGlobalEvent = Readonly<{
  payload?: Readonly<{
    type?: string;
    properties?: unknown;
  }>;
  type?: string;
  properties?: unknown;
}>;

export type OpenCodeServerClient = Readonly<{
  mcpAdd(input: Readonly<{
    directory: string;
    name: string;
    config: unknown;
  }>): Promise<void>;
  sessionCreate(input: Readonly<{ directory: string }>): Promise<Readonly<{ id: string }>>;
  sessionPromptAsync(input: Readonly<{
    sessionId: string;
    messageId?: string | null;
    text: string;
    variant?: string | null;
    config?: Readonly<Record<string, unknown>> | null;
  }>): Promise<void>;
  sessionAbort(input: Readonly<{ sessionId: string }>): Promise<void>;
  sessionStatus(input: Readonly<{ sessionId: string }>): Promise<unknown>;
  sessionMessages(input: Readonly<{ sessionId: string }>): Promise<readonly unknown[]>;
  sessionTodo(input: Readonly<{ sessionId: string }>): Promise<readonly unknown[]>;
  subscribeGlobalEvents(input: Readonly<{
    signal: AbortSignal;
    onEvent: (event: OpenCodeGlobalEvent) => void;
  }>): Promise<void>;
  providersList(): Promise<readonly Readonly<{
    id: string;
    env?: readonly string[];
    models?: Readonly<Record<string, unknown>>;
  }>[]>;
}>;

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/u, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function joinUrlWithQuery(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, string | null | undefined>>,
): string {
  const url = new URL(joinUrl(baseUrl, path));
  for (const [key, value] of Object.entries(query)) {
    const normalized = normalizeString(value);
    if (normalized) url.searchParams.set(key, normalized);
  }
  return url.toString();
}

async function requestJson(params: Readonly<{
  fetch: FetchRuntimeServiceV1;
  baseUrl: string;
  method: string;
  path: string;
  body?: unknown;
}>): Promise<unknown> {
  const response = await params.fetch({
    url: joinUrl(params.baseUrl, params.path),
    method: params.method,
    headers: { 'content-type': 'application/json' },
    ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
  });
  if (!response.ok) {
    throw new Error(`OpenCode server request failed: ${response.status} ${response.statusText ?? ''}`.trim());
  }
  return await response.json();
}

function readSessionId(value: unknown): string {
  const record = asRecord(value);
  const id = normalizeString(record?.id) || normalizeString(record?.sessionID);
  if (!id) throw new Error('OpenCode server response did not include a session id');
  return id;
}

function readProviderId(value: unknown): string {
  if (typeof value === 'string') return normalizeString(value);
  return normalizeString(asRecord(value)?.id);
}

function readProviderList(raw: unknown): readonly Readonly<{
  id: string;
  env?: readonly string[];
  models?: Readonly<Record<string, unknown>>;
}>[] {
  const record = asRecord(raw);
  const all = Array.isArray(record?.all) ? record.all : [];
  const connectedRaw = Array.isArray(record?.connected) ? record.connected : null;
  const connectedIds = connectedRaw
    ? connectedRaw
      .map((value) => readProviderId(value))
      .filter((value) => value.length > 0)
    : null;
  const connected = connectedIds && connectedIds.length > 0 ? new Set(connectedIds) : null;

  return all.flatMap((provider) => {
    const providerRecord = asRecord(provider);
    const id = readProviderId(provider);
    if (!id || (connected && !connected.has(id))) return [];
    const env = Array.isArray(providerRecord?.env)
      ? providerRecord.env.map((value) => normalizeString(value)).filter((value) => value.length > 0)
      : undefined;
    const models = asRecord(providerRecord?.models) ?? undefined;
    return [{
      id,
      ...(env && env.length > 0 ? { env } : {}),
      ...(models ? { models } : {}),
    }];
  });
}

function buildPromptConfig(input: Readonly<{
  variant?: string | null;
  config?: Readonly<Record<string, unknown>> | null;
}>): Readonly<{
  variant?: string;
  config?: Readonly<Record<string, unknown>>;
}> {
  const configVariant = normalizeString(input.config?.variant);
  const variant = normalizeString(input.variant) || configVariant;
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.config ?? {})) {
    if (key === 'variant') continue;
    config[key] = value;
  }
  return {
    ...(variant ? { variant } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export function createOpenCodeServerClient(params: Readonly<{
  fetch: FetchRuntimeServiceV1;
  baseUrl: string;
}>): OpenCodeServerClient {
  return {
    async mcpAdd(input) {
      const serverName = normalizeString(input.name);
      if (!serverName) return;
      const response = await params.fetch({
        url: joinUrlWithQuery(params.baseUrl, '/mcp', { directory: input.directory }),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: serverName,
          config: input.config,
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenCode MCP registration failed: ${response.status} ${response.statusText ?? ''}`.trim());
      }
    },
    async sessionCreate(input) {
      const response = await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        method: 'POST',
        path: '/session',
        body: { directory: input.directory },
      });
      return { id: readSessionId(response) };
    },
    async sessionPromptAsync(input) {
      const promptConfig = buildPromptConfig(input);
      await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        method: 'POST',
        path: `/session/${encodeURIComponent(input.sessionId)}/prompt_async`,
        body: {
          ...(input.messageId ? { messageID: input.messageId } : {}),
          ...promptConfig,
          parts: [{ type: 'text', text: input.text }],
        },
      });
    },
    async sessionAbort(input) {
      await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        method: 'POST',
        path: `/session/${encodeURIComponent(input.sessionId)}/abort`,
      });
    },
    async sessionStatus(input) {
      return await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        method: 'GET',
        path: `/session/${encodeURIComponent(input.sessionId)}/status`,
      });
    },
    async sessionMessages(input) {
      const response = await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        method: 'GET',
        path: `/session/${encodeURIComponent(input.sessionId)}/message`,
      });
      return Array.isArray(response) ? response : [];
    },
    async sessionTodo(input) {
      const response = await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        method: 'GET',
        path: `/session/${encodeURIComponent(input.sessionId)}/todo`,
      });
      return Array.isArray(response) ? response : [];
    },
    async subscribeGlobalEvents(input) {
      let lastEventId: string | null = null;
      while (!input.signal.aborted) {
        try {
          const subscription = await subscribeSseJson<OpenCodeGlobalEvent>({
            url: joinUrl(params.baseUrl, '/global/event'),
            ...(lastEventId ? { headers: { 'Last-Event-ID': lastEventId } } : {}),
            signal: input.signal,
            onMessage: (event, meta) => {
              if (meta.id) lastEventId = meta.id;
              input.onEvent(event);
            },
          });
          await subscription.done;
          return;
        } catch (error) {
          if (input.signal.aborted) return;
          if (error instanceof OpenCodeSseReadIdleTimeoutError) continue;
          throw error;
        }
      }
    },
    async providersList() {
      const response = await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        method: 'GET',
        path: '/provider',
      });
      return readProviderList(response);
    },
  };
}
