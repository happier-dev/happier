import { formatOpenCodeServerPromptErrorMessage } from './formatOpenCodeServerPromptErrorMessage.js';
import type { HttpMethod } from '@happier-dev/plugin-sdk/http';
import { readOpenCodeEventReconnectBackoffMs } from './openCodeEventReconnect.js';
import { asRecord, normalizeString } from './openCodeParsing.js';
import { subscribeSseJson } from './openCodeSse.js';
import type { OpenCodePromptPart } from './promptParts.js';
import type {
  OpenCodeNativeFetch,
  OpenCodeServerTransport,
} from './transport.js';

export type OpenCodeRuntimeFetchResponse = Readonly<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type OpenCodeRuntimeFetch = (request: Readonly<{
  url: string;
  method?: HttpMethod;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
}>) => Promise<OpenCodeRuntimeFetchResponse>;

export type OpenCodeGlobalEvent = Readonly<{
  directory?: string;
  payload?: Readonly<{
    type?: string;
    properties?: unknown;
  }>;
  type?: string;
  properties?: unknown;
}>;

export type OpenCodeGlobalEventDelivery = Readonly<{
  /**
   * Global replay events remain untrusted observations. The directory-scoped `/event` route emits
   * a connection boundary before subscribing to the instance bus, so only that route can produce
   * `accepted-live` after its boundary.
   */
  provenance: 'connection-boundary' | 'untrusted-observation' | 'accepted-live';
  connectionGeneration: number;
}>;

export type OpenCodeServerPromptModel = Readonly<{
  providerID: string;
  modelID: string;
}>;

export type OpenCodeServerPermissionReply = 'once' | 'always' | 'reject';

export type OpenCodeMcpStatus = Readonly<
  | { status: 'connected' }
  | { status: 'disabled' }
  | { status: 'failed'; error: string }
  | { status: 'needs_auth' }
  | { status: 'needs_client_registration'; error: string }
>;

function readOpenCodeMcpStatus(response: unknown, serverName: string): OpenCodeMcpStatus {
  const statusMap = asRecord(response);
  const rawStatus = asRecord(statusMap?.[serverName]);
  if (!rawStatus) {
    throw new Error(`OpenCode MCP registration response omitted status for "${serverName}"`);
  }
  const status = normalizeString(rawStatus.status);
  if (status === 'connected' || status === 'disabled' || status === 'needs_auth') {
    return { status };
  }
  if (status === 'failed' || status === 'needs_client_registration') {
    const error = normalizeString(rawStatus.error);
    if (!error) {
      throw new Error(`OpenCode MCP registration returned status "${status}" without an error for "${serverName}"`);
    }
    return { status, error };
  }
  throw new Error(`OpenCode MCP registration returned an unknown status for "${serverName}"`);
}

export type OpenCodeServerClient = Readonly<{
  mcpAdd(input: Readonly<{
    directory: string;
    name: string;
    config: unknown;
  }>): Promise<OpenCodeMcpStatus>;
  sessionCreate(input: Readonly<{ directory: string }>): Promise<Readonly<{ id: string }>>;
  sessionFork(input: Readonly<{
    sessionId: string;
    messageId?: string;
  }>): Promise<Readonly<{ id: string }>>;
  sessionPromptAsync(input: Readonly<{
    directory?: string | null;
    sessionId: string;
    messageId?: string | null;
    text: string;
    parts?: readonly OpenCodePromptPart[];
    model?: OpenCodeServerPromptModel | null;
    variant?: string | null;
    config?: Readonly<Record<string, unknown>> | null;
  }>): Promise<unknown>;
  sessionAbort(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<void>;
  sessionSummarize(input: Readonly<{
    sessionId: string;
    model: OpenCodeServerPromptModel;
    auto: boolean;
  }>): Promise<void>;
  sessionStatus(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<unknown>;
  sessionMessages(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<readonly unknown[]>;
  sessionTodo(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<readonly unknown[]>;
  permissionList(): Promise<readonly unknown[]>;
  questionList(): Promise<readonly unknown[]>;
  permissionReply(input: Readonly<{
    requestId: string;
    reply: OpenCodeServerPermissionReply;
    message?: string | null;
  }>): Promise<void>;
  questionReply(input: Readonly<{
    requestId: string;
    answers: readonly (readonly string[])[];
  }>): Promise<void>;
  questionReject(input: Readonly<{ requestId: string }>): Promise<void>;
  appSkills(input: Readonly<{ directory: string }>): Promise<unknown>;
  subscribeGlobalEvents(input: Readonly<{
    signal: AbortSignal;
    onEvent: (event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void;
    onUnavailable?: (error: unknown) => void;
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

function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function isOpenCodeServerAuthFailure(error: unknown): boolean {
  if (error instanceof OpenCodeServerHttpError) return isAuthFailureStatus(error.status);
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

function pathWithQuery(
  path: string,
  query: Readonly<Record<string, string | null | undefined>>,
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(normalizedPath, 'http://opencode.invalid');
  for (const [key, value] of Object.entries(query)) {
    const normalized = normalizeString(value);
    if (normalized) url.searchParams.set(key, normalized);
  }
  return `${url.pathname}${url.search}`;
}

async function requestJson(params: Readonly<{
  fetch: OpenCodeRuntimeFetch;
  method: HttpMethod;
  path: string;
  query?: Readonly<Record<string, string | null | undefined>>;
  body?: unknown;
  operation?: OpenCodeServerRequestOperation;
  expectJson?: boolean;
}>): Promise<unknown> {
  const response = await params.fetch({
    url: params.query
      ? pathWithQuery(params.path, params.query)
      : params.path,
    method: params.method,
    headers: { 'content-type': 'application/json' },
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
  fetch: OpenCodeRuntimeFetch;
  method: HttpMethod;
  path: string;
  query?: Readonly<Record<string, string | null | undefined>>;
  body?: unknown;
  operation?: OpenCodeServerRequestOperation;
}>): Promise<unknown> {
  const response = await params.fetch({
    url: params.query
      ? pathWithQuery(params.path, params.query)
      : params.path,
    method: params.method,
    headers: { 'content-type': 'application/json' },
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
  } catch (error) {
    throw new Error('OpenCode server request returned malformed JSON', { cause: error });
  }
}

async function readResponseBodyPreview(response: OpenCodeRuntimeFetchResponse): Promise<string | null> {
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

export async function subscribeOpenCodeGlobalEvents(params: Readonly<{
  baseUrl?: string;
  headers?: Readonly<Record<string, string>>;
  fetch: OpenCodeNativeFetch;
  signal: AbortSignal;
  onEvent: (event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void;
  onUnavailable?: (error: unknown) => void;
}>): Promise<void> {
  await subscribeOpenCodeEvents({
    ...params,
    eventPath: '/global/event',
    liveProvenance: 'untrusted-observation',
    streamEndedMessage: 'OpenCode global event stream ended',
    decodeEvent(rawEvent) {
      const eventRecord = asRecord(rawEvent);
      const payload = asRecord(eventRecord?.payload);
      const eventType = normalizeString(payload?.type ?? eventRecord?.type);
      if (!eventType) return null;
      const directory = normalizeString(eventRecord?.directory);
      return {
        ...(directory ? { directory } : {}),
        ...(payload
          ? { payload: { type: eventType, properties: payload.properties } }
          : { type: eventType, properties: eventRecord?.properties }),
      };
    },
  });
}

async function subscribeOpenCodeInstanceEvents(params: Readonly<{
  baseUrl?: string;
  headers?: Readonly<Record<string, string>>;
  directory?: string | null;
  fetch: OpenCodeNativeFetch;
  signal: AbortSignal;
  onEvent: (event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void;
  onUnavailable?: (error: unknown) => void;
}>): Promise<void> {
  await subscribeOpenCodeEvents({
    ...params,
    eventPath: pathWithQuery('/event', { directory: params.directory }),
    liveProvenance: 'accepted-live',
    streamEndedMessage: 'OpenCode instance event stream ended',
    decodeEvent(rawEvent) {
      const eventRecord = asRecord(rawEvent);
      const eventType = normalizeString(eventRecord?.type);
      if (!eventType) return null;
      return { type: eventType, properties: eventRecord?.properties };
    },
  });
}

async function subscribeOpenCodeEvents(params: Readonly<{
  baseUrl?: string;
  headers?: Readonly<Record<string, string>>;
  eventPath: string;
  liveProvenance: 'untrusted-observation' | 'accepted-live';
  streamEndedMessage: string;
  decodeEvent: (rawEvent: unknown) => OpenCodeGlobalEvent | null;
  fetch: OpenCodeNativeFetch;
  signal: AbortSignal;
  onEvent: (event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void;
  onUnavailable?: (error: unknown) => void;
}>): Promise<void> {
  let connectionGeneration = 0;
  let reconnectAttempt = 0;
  while (!params.signal.aborted) {
    let connectionBoundarySeen = false;
    let unavailableError: unknown = null;
    try {
      connectionGeneration += 1;
      const currentConnectionGeneration = connectionGeneration;
      const headers: Record<string, string> = { ...(params.headers ?? {}) };
      const subscription = await subscribeSseJson<unknown>({
        url: params.baseUrl
          ? `${params.baseUrl.replace(/\/+$/u, '')}${params.eventPath}`
          : params.eventPath,
        headers,
        fetch: params.fetch,
        signal: params.signal,
        onMessage: (rawEvent) => {
          const event = params.decodeEvent(rawEvent);
          if (!event) return;
          const eventType = normalizeString(event.payload?.type ?? event.type);
          if (eventType === 'server.connected') {
            connectionBoundarySeen = true;
            params.onEvent(event, {
              provenance: 'connection-boundary',
              connectionGeneration: currentConnectionGeneration,
            });
            return;
          }
          if (!connectionBoundarySeen) return;
          params.onEvent(event, {
            provenance: params.liveProvenance,
            connectionGeneration: currentConnectionGeneration,
          });
        },
      });
      await subscription.done;
      unavailableError = new Error(params.streamEndedMessage);
    } catch (error) {
      if (params.signal.aborted) return;
      unavailableError = error;
    }
    if (params.signal.aborted) return;
    try {
      params.onUnavailable?.(unavailableError);
    } catch {
      // Availability notification is advisory and must not disable reconnect recovery.
    }
    const backoffAttempt = connectionBoundarySeen ? 0 : reconnectAttempt;
    const shouldReconnect = await waitForOpenCodeEventReconnectBackoff({
      signal: params.signal,
      delayMs: readOpenCodeEventReconnectBackoffMs(backoffAttempt),
    });
    if (!shouldReconnect) return;
    reconnectAttempt = connectionBoundarySeen
      ? 0
      : Math.min(reconnectAttempt + 1, 30);
  }
}

async function waitForOpenCodeEventReconnectBackoff(params: Readonly<{
  signal: AbortSignal;
  delayMs: number;
}>): Promise<boolean> {
  if (params.signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (shouldReconnect: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      params.signal.removeEventListener('abort', onAbort);
      resolve(shouldReconnect);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), params.delayMs);
    timer.unref?.();
    params.signal.addEventListener('abort', onAbort, { once: true });
    if (params.signal.aborted) onAbort();
  });
}

export function createOpenCodeServerClient(input: Readonly<{
  transport: OpenCodeServerTransport;
  directory?: string | null;
}>): OpenCodeServerClient {
  const params: Readonly<{
    fetch: OpenCodeRuntimeFetch;
    streamFetch: OpenCodeNativeFetch;
    directory?: string | null;
  }> = {
    fetch: input.transport.request,
    streamFetch: input.transport.fetch,
    directory: input.directory,
  };
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
      if (!serverName) throw new Error('OpenCode MCP registration requires a server name');
      const response = await params.fetch({
        url: pathWithQuery('/mcp', { directory: input.directory }),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
      return readOpenCodeMcpStatus(await response.json(), serverName);
    },
    async sessionCreate(input) {
      const response = await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: '/session',
        query: directoryQuery(input.directory),
        body: {},
      });
      return { id: readSessionId(response) };
    },
    async sessionFork(input) {
      const response = await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/session/${encodeURIComponent(input.sessionId)}/fork`,
        query: directoryQuery(params.directory),
        body: input.messageId ? { messageID: input.messageId } : {},
      });
      return { id: readSessionId(response) };
    },
    async sessionPromptAsync(input) {
      const promptConfig = buildPromptConfig(input);
      return await requestOptionalJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/session/${encodeURIComponent(input.sessionId)}/message`,
        query: directoryQuery(input.directory),
        body: {
          ...(input.messageId ? { messageID: input.messageId } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...promptConfig,
          parts: input.parts ?? [{ type: 'text', text: input.text }],
        },
      });
    },
    async sessionAbort(input) {
      await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/session/${encodeURIComponent(input.sessionId)}/abort`,
        query: directoryQuery(input.directory),
        expectJson: false,
      });
    },
    async sessionSummarize(input) {
      await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/session/${encodeURIComponent(input.sessionId)}/summarize`,
        query: directoryQuery(params.directory),
        body: {
          providerID: input.model.providerID,
          modelID: input.model.modelID,
          auto: input.auto,
        },
        expectJson: false,
      });
    },
    async sessionStatus(input) {
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/session/status',
        query: directoryQuery(input.directory),
      });
      return asRecord(response)?.[input.sessionId] ?? {};
    },
    async sessionMessages(input) {
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: `/session/${encodeURIComponent(input.sessionId)}/message`,
        query: directoryQuery(input.directory),
      });
      return Array.isArray(response) ? response : [];
    },
    async sessionTodo(input) {
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: `/session/${encodeURIComponent(input.sessionId)}/todo`,
        query: directoryQuery(input.directory),
      });
      return Array.isArray(response) ? response : [];
    },
    async permissionList() {
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/permission',
        query: directoryQuery(params.directory),
      });
      return Array.isArray(response) ? response : [];
    },
    async questionList() {
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/question',
        query: directoryQuery(params.directory),
      });
      return Array.isArray(response) ? response : [];
    },
    async permissionReply(input) {
      const requestId = normalizeString(input.requestId);
      if (!requestId) return;
      const message = normalizeString(input.message);
      await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/permission/${encodeURIComponent(requestId)}/reply`,
        expectJson: false,
        body: {
          reply: input.reply,
          ...(message ? { message } : {}),
        },
      });
    },
    async questionReply(input) {
      await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/question/${encodeURIComponent(input.requestId)}/reply`,
        body: { answers: input.answers },
        expectJson: false,
      });
    },
    async questionReject(input) {
      await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/question/${encodeURIComponent(input.requestId)}/reject`,
        body: {},
        expectJson: false,
      });
    },
    async appSkills(input) {
      const response = await params.fetch({
        url: pathWithQuery('/skill', { directory: input.directory }),
        method: 'GET',
        headers: { 'content-type': 'application/json' },
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
      await subscribeOpenCodeInstanceEvents({
        fetch: params.streamFetch,
        directory: resolveDirectory(),
        signal: input.signal,
        onEvent: input.onEvent,
        onUnavailable: input.onUnavailable,
      });
    },
    async globalConfigGet() {
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/global/config',
      });
      return asRecord(response) ?? {};
    },
    async providersList() {
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/provider',
      });
      return readProviderList(response);
    },
  };
}
