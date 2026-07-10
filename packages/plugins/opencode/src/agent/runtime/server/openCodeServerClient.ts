import type { FetchRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { formatOpenCodeServerPromptErrorMessage } from './formatOpenCodeServerPromptErrorMessage.js';
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

export type OpenCodeServerPromptModel = Readonly<{
  providerID: string;
  modelID: string;
}>;

export type OpenCodeServerPermissionReply = 'once' | 'always' | 'reject';

export type OpenCodeServerClient = Readonly<{
  mcpAdd(input: Readonly<{
    directory: string;
    name: string;
    config: unknown;
  }>): Promise<void>;
  sessionCreate(input: Readonly<{ directory: string }>): Promise<Readonly<{ id: string }>>;
  sessionPromptAsync(input: Readonly<{
    directory?: string | null;
    sessionId: string;
    messageId?: string | null;
    text: string;
    model?: OpenCodeServerPromptModel | null;
    variant?: string | null;
    config?: Readonly<Record<string, unknown>> | null;
  }>): Promise<unknown>;
  sessionAbort(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<void>;
  sessionStatus(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<unknown>;
  sessionMessages(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<readonly unknown[]>;
  sessionTodo(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<readonly unknown[]>;
  permissionReply(input: Readonly<{
    requestId: string;
    reply: OpenCodeServerPermissionReply;
    message?: string | null;
  }>): Promise<void>;
  appSkills(input: Readonly<{ directory: string }>): Promise<unknown>;
  subscribeGlobalEvents(input: Readonly<{
    signal: AbortSignal;
    onEvent: (event: OpenCodeGlobalEvent) => void;
  }>): Promise<void>;
  globalConfigGet(): Promise<Readonly<Record<string, unknown>>>;
  providersList(): Promise<readonly Readonly<{
    id: string;
    env?: readonly string[];
    models?: Readonly<Record<string, unknown>>;
  }>[]>;
}>;

export type OpenCodeServerRequestOperation =
  | 'mcp_registration'
  | 'server_request'
  | 'skill_catalog';

export class OpenCodeServerHttpError extends Error {
  readonly code: 'opencode_server_auth_failed' | 'opencode_server_request_failed';
  readonly operation: OpenCodeServerRequestOperation;
  readonly status: number;
  readonly statusText: string;
  readonly responseBodyPreview: string | null;

  constructor(params: Readonly<{
    message: string;
    operation: OpenCodeServerRequestOperation;
    status: number;
    statusText?: string | null;
    responseBodyPreview?: string | null;
  }>) {
    super(params.message);
    this.name = 'OpenCodeServerHttpError';
    this.operation = params.operation;
    this.status = params.status;
    this.statusText = params.statusText ?? '';
    this.responseBodyPreview = params.responseBodyPreview ?? null;
    this.code = isAuthFailureStatus(params.status)
      ? 'opencode_server_auth_failed'
      : 'opencode_server_request_failed';
  }
}

export class OpenCodeServerCredentialError extends Error {
  readonly code = 'opencode_server_auth_failed';

  constructor(message = 'OpenCode managed server credential is unavailable') {
    super(message);
    this.name = 'OpenCodeServerCredentialError';
  }
}

function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function isOpenCodeServerAuthFailure(error: unknown): boolean {
  if (error instanceof OpenCodeServerHttpError) return isAuthFailureStatus(error.status);
  if (error instanceof OpenCodeServerCredentialError) return true;
  if (!error || typeof error !== 'object') return false;
  const record = error as Readonly<Record<string, unknown>>;
  return record.code === 'opencode_server_auth_failed'
    || record.status === 401
    || record.status === 403;
}

function createOpenCodeServerHttpError(params: Readonly<{
  prefix: string;
  operation: OpenCodeServerRequestOperation;
  status: number;
  statusText?: string | null;
  responseBodyPreview?: string | null;
}>): OpenCodeServerHttpError {
  const bodyPreview = normalizeString(params.responseBodyPreview);
  const statusLine = `${params.prefix}: ${params.status} ${params.statusText ?? ''}`.trim();
  return new OpenCodeServerHttpError({
    operation: params.operation,
    status: params.status,
    statusText: params.statusText,
    responseBodyPreview: bodyPreview || null,
    message: bodyPreview ? `${statusLine}\n${bodyPreview}` : statusLine,
  });
}

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
  headers?: Readonly<Record<string, string>>;
  method: string;
  path: string;
  query?: Readonly<Record<string, string | null | undefined>>;
  body?: unknown;
  operation?: OpenCodeServerRequestOperation;
  expectJson?: boolean;
}>): Promise<unknown> {
  const response = await params.fetch({
    url: params.query
      ? joinUrlWithQuery(params.baseUrl, params.path, params.query)
      : joinUrl(params.baseUrl, params.path),
    method: params.method,
    headers: { ...params.headers, 'content-type': 'application/json' },
    ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
  });
  if (!response.ok) {
    const responseBodyPreview = await readResponseBodyPreview(response);
    throw createOpenCodeServerHttpError({
      prefix: 'OpenCode server request failed',
      operation: params.operation ?? 'server_request',
      status: response.status,
      statusText: response.statusText,
      responseBodyPreview,
    });
  }
  if (params.expectJson === false || response.status === 204) {
    return null;
  }
  return await response.json();
}

async function requestOptionalJson(params: Readonly<{
  fetch: FetchRuntimeServiceV1;
  baseUrl: string;
  headers?: Readonly<Record<string, string>>;
  method: string;
  path: string;
  query?: Readonly<Record<string, string | null | undefined>>;
  body?: unknown;
  operation?: OpenCodeServerRequestOperation;
}>): Promise<unknown> {
  const response = await params.fetch({
    url: params.query
      ? joinUrlWithQuery(params.baseUrl, params.path, params.query)
      : joinUrl(params.baseUrl, params.path),
    method: params.method,
    headers: { ...params.headers, 'content-type': 'application/json' },
    ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
  });
  if (!response.ok) {
    const responseBodyPreview = await readResponseBodyPreview(response);
    throw createOpenCodeServerHttpError({
      prefix: 'OpenCode server request failed',
      operation: params.operation ?? 'server_request',
      status: response.status,
      statusText: response.statusText,
      responseBodyPreview,
    });
  }
  if (response.status === 204) return undefined;
  const body = await response.text().catch(() => '');
  const normalized = normalizeString(body);
  if (!normalized) return undefined;
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return undefined;
  }
}

async function readResponseBodyPreview(response: Awaited<ReturnType<FetchRuntimeServiceV1>>): Promise<string | null> {
  try {
    const body = normalizeString(await response.text());
    if (!body) return null;
    return formatOpenCodeServerPromptErrorMessage(body);
  } catch {
    return null;
  }
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
  headers?: Readonly<Record<string, string>>;
  directory?: string | null;
}>): OpenCodeServerClient {
  const resolveDirectory = (value?: string | null): string | null => (
    normalizeString(value) || normalizeString(params.directory) || null
  );
  const directoryQuery = (value?: string | null): Readonly<{ directory?: string }> => {
    const directory = resolveDirectory(value);
    return directory ? { directory } : {};
  };

  return {
    async mcpAdd(input) {
      const serverName = normalizeString(input.name);
      if (!serverName) return;
      const response = await params.fetch({
        url: joinUrlWithQuery(params.baseUrl, '/mcp', { directory: input.directory }),
        method: 'POST',
        headers: { ...params.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: serverName,
          config: input.config,
        }),
      });
      if (!response.ok) {
        const responseBodyPreview = await readResponseBodyPreview(response);
        throw createOpenCodeServerHttpError({
          prefix: 'OpenCode MCP registration failed',
          operation: 'mcp_registration',
          status: response.status,
          statusText: response.statusText,
          responseBodyPreview,
        });
      }
    },
    async sessionCreate(input) {
      const response = await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        headers: params.headers,
        method: 'POST',
        path: '/session',
        query: directoryQuery(input.directory),
        body: {},
      });
      return { id: readSessionId(response) };
    },
    async sessionPromptAsync(input) {
      const promptConfig = buildPromptConfig(input);
      return await requestOptionalJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        headers: params.headers,
        method: 'POST',
        path: `/session/${encodeURIComponent(input.sessionId)}/message`,
        query: directoryQuery(input.directory),
        body: {
          ...(input.messageId ? { messageID: input.messageId } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...promptConfig,
          parts: [{ type: 'text', text: input.text }],
        },
      });
    },
    async sessionAbort(input) {
      await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        headers: params.headers,
        method: 'POST',
        path: `/session/${encodeURIComponent(input.sessionId)}/abort`,
        query: directoryQuery(input.directory),
        expectJson: false,
      });
    },
    async sessionStatus(input) {
      const response = await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        headers: params.headers,
        method: 'GET',
        path: '/session/status',
        query: directoryQuery(input.directory),
      });
      return asRecord(response)?.[input.sessionId] ?? {};
    },
    async sessionMessages(input) {
      const response = await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        headers: params.headers,
        method: 'GET',
        path: `/session/${encodeURIComponent(input.sessionId)}/message`,
        query: directoryQuery(input.directory),
      });
      return Array.isArray(response) ? response : [];
    },
    async sessionTodo(input) {
      const response = await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        headers: params.headers,
        method: 'GET',
        path: `/session/${encodeURIComponent(input.sessionId)}/todo`,
        query: directoryQuery(input.directory),
      });
      return Array.isArray(response) ? response : [];
    },
    async permissionReply(input) {
      const requestId = normalizeString(input.requestId);
      if (!requestId) return;
      const message = normalizeString(input.message);
      await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        headers: params.headers,
        method: 'POST',
        path: `/permission/${encodeURIComponent(requestId)}/reply`,
        expectJson: false,
        body: {
          reply: input.reply,
          ...(message ? { message } : {}),
        },
      });
    },
    async appSkills(input) {
      const response = await params.fetch({
        url: joinUrlWithQuery(params.baseUrl, '/skill', { directory: input.directory }),
        method: 'GET',
        headers: { ...params.headers, 'content-type': 'application/json' },
      });
      if (!response.ok) {
        const responseBodyPreview = await readResponseBodyPreview(response);
        throw createOpenCodeServerHttpError({
          prefix: 'OpenCode skill catalog request failed',
          operation: 'skill_catalog',
          status: response.status,
          statusText: response.statusText,
          responseBodyPreview,
        });
      }
      return await response.json();
    },
    async subscribeGlobalEvents(input) {
      let lastEventId: string | null = null;
      while (!input.signal.aborted) {
        try {
          const headers: Record<string, string> = { ...(params.headers ?? {}) };
          if (lastEventId) headers['Last-Event-ID'] = lastEventId;
          const subscription = await subscribeSseJson<OpenCodeGlobalEvent>({
            url: joinUrl(params.baseUrl, '/global/event'),
            headers,
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
    async globalConfigGet() {
      const response = await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        headers: params.headers,
        method: 'GET',
        path: '/global/config',
      });
      return asRecord(response) ?? {};
    },
    async providersList() {
      const response = await requestJson({
        fetch: params.fetch,
        baseUrl: params.baseUrl,
        headers: params.headers,
        method: 'GET',
        path: '/provider',
      });
      return readProviderList(response);
    },
  };
}
