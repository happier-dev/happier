import { readOpenCodeNativeChildOutcome, type OpenCodeNativeChildStatus } from './nativeChildOutcome.js';
import { formatOpenCodeServerPromptErrorMessage } from './formatOpenCodeServerPromptErrorMessage.js';
import type { HttpMethod } from '@happier-dev/plugin-sdk/http';
import {
  normalizeOpenCodeV2InstanceEvent,
  OPEN_CODE_V2_EVENT_PATH,
  type OpenCodeServerDialect,
} from './dialect.js';
import { readOpenCodeEventReconnectBackoffMs } from './openCodeEventReconnect.js';
import { asRecord, normalizeString, readNonBlankOpaqueIdentifier } from './openCodeParsing.js';
import {
  buildOpenCodeV2ModelRef,
  buildOpenCodeV2PermissionRuleset,
  buildOpenCodeV2Prompt,
  OpenCodeSkillIdentityError,
  combineOpenCodeV2Providers,
  normalizeOpenCodeV2Messages,
  normalizeOpenCodeV2PermissionRequest,
  openCodeV2LocationQuery,
  readOpenCodeV2Data,
  readOpenCodeV2DataArray,
  readOpenCodeV2MessagePage,
  readOpenCodeV2ActiveSessionStatusMap,
  readOpenCodeV2SessionListPage,
  readOpenCodeV2SessionStatus,
} from './openCodeV2Wire.js';
import { normalizeOpenCodeV2Event } from './openCodeV2EventAdapter.js';
import {
  buildOpenCodeV2FormAnswer,
  projectOpenCodeV2Form,
  type OpenCodeV2FormProjection,
} from './openCodeV2Forms.js';
import { subscribeSseJson } from './openCodeSse.js';
import type { OpenCodePromptPart } from './promptParts.js';
import { normalizeOpenCodeSkills } from './skills.js';
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
   * Global replay events remain untrusted observations. The V1 directory stream and V2 owned
   * session stream establish connection boundaries before their events become `accepted-live`.
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
  | { status: 'pending' }
  | { status: 'failed'; error: string }
  | { status: 'needs_auth'; error?: string }
  | { status: 'needs_client_registration'; error: string }
>;

function readOpenCodeMcpStatus(response: unknown, serverName: string): OpenCodeMcpStatus {
  const statusMap = asRecord(response);
  const server = asRecord(statusMap?.[serverName]);
  const rawStatus = asRecord(server?.status) ?? server;
  if (!rawStatus) {
    throw new Error(`OpenCode MCP registration response omitted status for "${serverName}"`);
  }
  const status = normalizeString(rawStatus.status);
  if (status === 'connected' || status === 'disabled' || status === 'pending') {
    return { status };
  }
  if (status === 'needs_auth') {
    const error = normalizeString(rawStatus.error);
    return error ? { status, error } : { status };
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
  mcpRemove(input: Readonly<{ directory: string; name: string }>): Promise<void>;
  sessionCreate(input: Readonly<{
    directory: string;
    permissions?: readonly unknown[];
  }>): Promise<Readonly<{ id: string }>>;
  sessionUpdatePermissions(input: Readonly<{
    sessionId: string;
    permissions: readonly unknown[];
  }>): Promise<void>;
  sessionSetAgent(input: Readonly<{ sessionId: string; agent: string }>): Promise<void>;
  sessionReadAgent(input: Readonly<{ sessionId: string }>): Promise<string | null>;
  sessionSetModel(input: Readonly<{
    sessionId: string;
    model?: OpenCodeServerPromptModel | null;
    variant?: string | null;
  }>): Promise<void>;
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
    agent?: string | null;
    variant?: string | null;
    config?: Readonly<Record<string, unknown>> | null;
  }>): Promise<unknown>;
  sessionCommand(input: Readonly<{
    directory?: string | null;
    sessionId: string;
    command: string;
    arguments: string;
    messageId?: string | null;
    parts?: readonly OpenCodePromptPart[];
    model?: OpenCodeServerPromptModel | null;
    agent?: string | null;
    variant?: string | null;
    delivery?: 'steer' | 'queue';
  }>): Promise<unknown>;
  sessionAbort(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<void>;
  sessionSummarize(input: Readonly<{
    sessionId: string;
    model: OpenCodeServerPromptModel;
    auto: boolean;
  }>): Promise<void>;
  sessionStatus(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<unknown>;
  sessionChildInventory(input: Readonly<{ parentSessionId: string; childSessionId?: string }>): Promise<
    readonly Readonly<{ info: unknown; status: OpenCodeNativeChildStatus | null }>[] | null
  >;
  sessionMessages(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<readonly unknown[]>;
  sessionTodo(input: Readonly<{ directory?: string | null; sessionId: string }>): Promise<readonly unknown[]>;
  permissionList(): Promise<readonly unknown[]>;
  questionList(): Promise<readonly unknown[]>;
  /**
   * `sessionId` is the session that owns the request. V1 answered permissions
   * and questions on flat `/permission/:id/...` routes; V2 owns them under
   * `/api/session/:sessionID/...`, so the owner has to travel with the reply.
   * V1 ignores it and keeps its proven route.
   */
  permissionReply(input: Readonly<{
    sessionId?: string | null;
    requestId: string;
    reply: OpenCodeServerPermissionReply;
    message?: string | null;
  }>): Promise<void>;
  questionReply(input: Readonly<{
    sessionId?: string | null;
    requestId: string;
    answers: readonly (readonly string[])[];
  }>): Promise<void>;
  questionReject(input: Readonly<{
    sessionId?: string | null;
    requestId: string;
  }>): Promise<void>;
  appCommands(input: Readonly<{ directory: string }>): Promise<readonly unknown[]>;
  appSkills(input: Readonly<{ directory: string }>): Promise<unknown>;
  subscribeGlobalEvents(input: Readonly<{
    sessionId?: string | null;
    signal: AbortSignal;
    onEvent: (event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void | Promise<void>;
    onUnavailable?: (error: unknown) => void;
  }>): Promise<void>;
  globalConfigGet(): Promise<Readonly<Record<string, unknown>>>;
  agentsList(): Promise<readonly Readonly<{ id: string; name: string; description?: string; mode?: string; hidden?: boolean }>[]>;
  providersList(): Promise<readonly Readonly<{
    id: string;
    env?: readonly string[];
    models?: Readonly<Record<string, unknown>>;
  }>[]>;
}>;

export type OpenCodeServerRequestOperation =
  | 'mcp_registration'
  | 'server_request'
  | 'command_catalog'
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

/**
 * An operation the reachable OpenCode server's protocol does not declare.
 *
 * These are absences, not refusals: the released V2 protocol has no
 * todo read route or `/global/config`, so there is
 * nothing to call and nothing to retry. Reporting that as an ordinary request
 * failure would let callers treat a missing capability as a broken server.
 *
 * Callers decide what an absence costs them: MCP registration degrades the
 * session's Happier tools while leaving prompting intact, todo reads simply
 * publish no work state, and fork surfaces the limitation to the user.
 */
export type OpenCodeServerUnsupportedOperation =
  | 'mcp_registration'
  | 'session_todo'
  | 'session_prompt_config'
  | 'session_command_delivery'
  | 'session_command_attachments'
  | 'global_config';

export class OpenCodeServerUnsupportedOperationError extends Error {
  readonly code = 'opencode_server_operation_unsupported' as const;
  readonly operation: OpenCodeServerUnsupportedOperation;
  readonly dialect: OpenCodeServerDialect;

  constructor(params: Readonly<{
    operation: OpenCodeServerUnsupportedOperation;
    dialect: OpenCodeServerDialect;
    message: string;
  }>) {
    super(params.message);
    this.name = 'OpenCodeServerUnsupportedOperationError';
    this.operation = params.operation;
    this.dialect = params.dialect;
  }
}

export function isOpenCodeServerUnsupportedOperation(
  error: unknown,
  operation?: OpenCodeServerUnsupportedOperation,
): error is OpenCodeServerUnsupportedOperationError {
  if (!(error instanceof OpenCodeServerUnsupportedOperationError)) return false;
  return operation === undefined || error.operation === operation;
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

/**
 * Serialize a query exactly as its owner decided it.
 *
 * Every value here is already the caller's final answer: Happier-owned paths
 * arrive through `resolveDirectory`, and provider-minted tokens (the opaque V2
 * message cursor) arrive through `readNonBlankOpaqueIdentifier`. The serializer
 * therefore encodes the bytes it is given and omits only an absent or empty
 * value — re-trimming here would re-mint a cursor the server issued and break
 * the continuation at its issuer.
 */
function pathWithQuery(
  path: string,
  query: Readonly<Record<string, string | null | undefined>>,
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(normalizedPath, 'http://opencode.invalid');
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value.length > 0) url.searchParams.set(key, value);
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
  timeoutMs?: number;
}>): Promise<unknown> {
  const response = await params.fetch({
    url: params.query
      ? pathWithQuery(params.path, params.query)
      : params.path,
    method: params.method,
    headers: { 'content-type': 'application/json' },
    ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
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
  signal?: AbortSignal;
}>): Promise<unknown> {
  const response = await params.fetch({
    url: params.query
      ? pathWithQuery(params.path, params.query)
      : params.path,
    method: params.method,
    headers: { 'content-type': 'application/json' },
    ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
    ...(params.signal ? { signal: params.signal } : {}),
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

/**
 * The session id OpenCode just minted. Happier hands it straight back to the
 * same server on every later call, so the reader decides presence only and the
 * accepted value keeps its exact bytes.
 */
function readSessionId(value: unknown): string {
  const record = asRecord(value);
  const id = readNonBlankOpaqueIdentifier(record?.id)
    ?? readNonBlankOpaqueIdentifier(record?.sessionID);
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
  if (!Array.isArray(record?.all)) throw new Error('Invalid OpenCode provider inventory');
  const all = record.all;
  if (all.length > 0 && !all.some((provider) => readProviderId(provider))) throw new Error('Invalid OpenCode provider inventory');
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
  onEvent: (event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void | Promise<void>;
  onUnavailable?: (error: unknown) => void;
}>): Promise<void> {
  await subscribeOpenCodeEvents({
    ...params,
    eventPath: '/global/event',
    liveProvenance: 'accepted-live',
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
  onEvent: (event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void | Promise<void>;
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

/**
 * The released OpenCode V2 instance stream.
 *
 * One V1 property changes: scoping moves from the `directory` query parameter
 * onto each event's `location`. Normalizing that here keeps the runtime domain
 * (`{ type, properties }`, directory-scoped, `server.connected`-gated)
 * identical for both dialects. Released `/api/event` carries both durable and
 * live frames; each `server.connected` boundary triggers the runtime's
 * authoritative transcript/status/request-inventory resynchronization.
 */
export async function subscribeOpenCodeV2InstanceEvents(params: Readonly<{
  baseUrl?: string;
  headers?: Readonly<Record<string, string>>;
  directory?: string | null;
  fetch: OpenCodeNativeFetch;
  signal: AbortSignal;
  onEvent: (event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void | Promise<void>;
  onUnavailable?: (error: unknown) => void;
  liveProvenance?: 'untrusted-observation' | 'accepted-live';
  onFormProjection?: (projection: OpenCodeV2FormProjection) => void;
}>): Promise<void> {
  const directory = normalizeString(params.directory) || null;
  await subscribeOpenCodeEvents({
    ...params,
    eventPath: OPEN_CODE_V2_EVENT_PATH,
    liveProvenance: params.liveProvenance ?? 'accepted-live',
    streamEndedMessage: 'OpenCode V2 instance event stream ended',
    decodeEvent: (rawEvent) => {
      const record = asRecord(rawEvent);
      const eventDirectory = normalizeString(asRecord(record?.location)?.directory);
      if (directory && eventDirectory && eventDirectory !== directory) return null;
      const type = normalizeString(record?.type);
      if (!type) return null;
      const normalized = normalizeOpenCodeV2Event(type, record?.data);
      if (normalized.formProjection) params.onFormProjection?.(normalized.formProjection);
      return { type: normalized.type, properties: normalized.properties };
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
  onEvent: (event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void | Promise<void>;
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
      // No resume token is sent on any dialect. Neither OpenCode event route
      // offers replay: the V1 route streams a live instance queue, and the
      // pinned V2 handler emits `id: undefined`, reads no request header, and
      // subscribes a bounded live queue. A `Last-Event-ID` here would be a
      // request the server ignores while making Happier act as though the gap
      // had been recovered.
      const headers: Record<string, string> = { ...(params.headers ?? {}) };
      const subscription = await subscribeSseJson<unknown>({
        url: params.baseUrl
          ? `${params.baseUrl.replace(/\/+$/u, '')}${params.eventPath}`
          : params.eventPath,
        headers,
        fetch: params.fetch,
        signal: params.signal,
        onMessage: async (rawEvent) => {
          const event = params.decodeEvent(rawEvent);
          if (!event) return;
          const eventType = normalizeString(event.payload?.type ?? event.type);
          if (eventType === 'server.connected') {
            connectionBoundarySeen = true;
            await params.onEvent(event, {
              provenance: 'connection-boundary',
              connectionGeneration: currentConnectionGeneration,
            });
            return;
          }
          if (!connectionBoundarySeen) return;
          await params.onEvent(event, {
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
    // Both dialects begin every accepted connection with `server.connected`, so
    // the boundary is the one proof that this attempt progressed.
    const connectionProgressed = connectionBoundarySeen;
    const backoffAttempt = connectionProgressed ? 0 : reconnectAttempt;
    const shouldReconnect = await waitForOpenCodeEventReconnectBackoff({
      signal: params.signal,
      delayMs: readOpenCodeEventReconnectBackoffMs(backoffAttempt),
    });
    if (!shouldReconnect) return;
    reconnectAttempt = connectionProgressed
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

async function waitForOpenCodeMcpStatusRefresh(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('OpenCode MCP registration was aborted');
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal?.reason ?? new Error('OpenCode MCP registration was aborted'));
    const timer = setTimeout(() => finish(), delayMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * The one OpenCode HTTP client.
 *
 * `dialect` is the resolved answer to "which OpenCode surface is on the other
 * end", decided once per server by `detectOpenCodeServerDialect` and passed in
 * explicitly so there is exactly one decision-maker. It is deliberately not
 * re-derived here: a client that probed on its own would give every operation
 * its own opinion of the server.
 *
 * Every operation routes through this one factory on both dialects. `v1` keeps
 * the long-standing root routes, which the stable binary mounts alongside its
 * `/global/*` and `/api/*` groups
 * (`packages/opencode/src/server/routes/instance/httpapi/api.ts`). `v2` speaks
 * the standalone contract whose whole inventory is `/api/*`
 * (`packages/protocol/src/api.ts`), with its wire mapping owned by
 * `openCodeV2Wire.ts`. Operations that protocol does not declare throw
 * `OpenCodeServerUnsupportedOperationError` instead of guessing a route.
 */
export function createOpenCodeServerClient(input: Readonly<{
  transport: OpenCodeServerTransport;
  directory?: string | null;
  dialect: OpenCodeServerDialect;
  signal?: AbortSignal;
  httpTimeoutMs?: number;
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
  const lifecycleSignal = input.signal;
  const httpTimeoutMs = input.httpTimeoutMs ?? 60_000;
  const isV2 = input.dialect === 'v2';
  const formProjections = new Map<string, OpenCodeV2FormProjection>();
  const resolveDirectory = (value?: string | null): string | null => (
    normalizeString(value) || normalizeString(params.directory) || null
  );
  const directoryQuery = (value?: string | null): Readonly<{ directory?: string }> => {
    const directory = resolveDirectory(value);
    return directory ? { directory } : {};
  };
  const locationQuery = (
    value?: string | null,
  ): Readonly<Record<string, string | undefined>> => (
    openCodeV2LocationQuery(resolveDirectory(value))
  );
  const readV2Catalog = async (
    path: '/api/command' | '/api/skill',
    directory?: string | null,
  ): Promise<readonly unknown[]> => {
    const query = locationQuery(directory);
    const operation = path === '/api/command' ? 'command_catalog' : 'skill_catalog';
    // OpenCode 2.0.15/2.0.20 integration.list awaits Plugin.awaitActivation;
    // command.list and skill.list otherwise expose the cold, empty registry.
    await requestJson({ fetch: params.fetch, method: 'GET', path: '/api/integration', query, operation });
    const response = await requestJson({ fetch: params.fetch, method: 'GET', path, query, operation });
    return readOpenCodeV2DataArray(response);
  };
  const unsupported = (
    operation: OpenCodeServerUnsupportedOperation,
    message: string,
  ): OpenCodeServerUnsupportedOperationError => new OpenCodeServerUnsupportedOperationError({
    operation,
    dialect: input.dialect,
    message,
  });
  /**
   * The session that owns a permission or question request. V2 routes every
   * reply under its session; without the owner there is no route to call, and
   * inventing one would answer the wrong session.
   */
  const requireReplySessionId = (value: string | null | undefined, what: string): string => {
    const sessionId = readNonBlankOpaqueIdentifier(value);
    if (!sessionId) {
      throw new Error(`OpenCode V2 ${what} replies require the owning session id`);
    }
    return sessionId;
  };

  async function resolveV2SkillParts(
    parts: readonly OpenCodePromptPart[] | undefined,
    readCatalog: () => Promise<unknown>,
  ): Promise<readonly OpenCodePromptPart[] | undefined> {
    if (!parts?.some((part) => part.type === 'skill' && !readNonBlankOpaqueIdentifier(part.id))) return parts;
    // Older released selections have name/path only. Resolve through the existing native
    // catalog owner at this wire compatibility seam, never infer an opaque ID from a name.
    const catalog = normalizeOpenCodeSkills(await readCatalog());
    return parts.map((part) => {
      if (part.type !== 'skill' || readNonBlankOpaqueIdentifier(part.id)) return part;
      const matches = catalog.filter((skill) => skill.name === part.name
        && (part.path === undefined || skill.path === part.path));
      const match = matches.length === 1 ? matches[0] : undefined;
      const id = readNonBlankOpaqueIdentifier(match?.id);
      if (!id) throw new OpenCodeSkillIdentityError();
      return { ...part, id };
    });
  }

  return {
    async mcpAdd(input) {
      if (isV2) {
        const serverName = normalizeString(input.name);
        if (!serverName) throw new Error('OpenCode MCP registration requires a server name');
        await requestJson({
          fetch: params.fetch,
          method: 'PUT',
          path: `/api/experimental/mcp/${encodeURIComponent(serverName)}`,
          query: locationQuery(input.directory),
          body: { config: input.config },
          expectJson: false,
        });
        const deadline = Date.now() + httpTimeoutMs;
        while (true) {
          const remainingMs = Math.max(1, deadline - Date.now());
          const response = await requestJson({
            fetch: params.fetch,
            method: 'GET',
            path: '/api/mcp',
            query: locationQuery(input.directory),
            timeoutMs: remainingMs,
          });
          const server = readOpenCodeV2DataArray(response).find((entry) => (
            normalizeString(asRecord(entry)?.name) === serverName
          ));
          const status = readOpenCodeMcpStatus({ [serverName]: server }, serverName);
          if (status.status !== 'pending' || Date.now() >= deadline) return status;
          await waitForOpenCodeMcpStatusRefresh(
            Math.min(100, Math.max(1, deadline - Date.now())),
            lifecycleSignal,
          );
        }
      }
      const serverName = normalizeString(input.name);
      if (!serverName) throw new Error('OpenCode MCP registration requires a server name');
      const response = await params.fetch({
        url: pathWithQuery('/mcp', directoryQuery(input.directory)),
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
    async mcpRemove(input) {
      const serverName = normalizeString(input.name);
      if (!serverName) throw new Error('OpenCode MCP disconnect requires a server name');
      if (isV2) {
        await requestJson({
          fetch: params.fetch,
          method: 'DELETE',
          path: `/api/experimental/mcp/${encodeURIComponent(serverName)}`,
          query: locationQuery(input.directory),
          expectJson: false,
        });
        return;
      }
      await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/mcp/${encodeURIComponent(serverName)}/disconnect`,
        query: directoryQuery(input.directory),
        expectJson: false,
      });
    },
    async sessionCreate(input) {
      if (isV2) {
        const directory = resolveDirectory(input.directory);
        const response = await requestJson({
          fetch: params.fetch,
          method: 'POST',
          path: '/api/session',
          body: {
            ...(directory ? { location: { directory } } : {}),
            ...(input.permissions ? {
              permissions: buildOpenCodeV2PermissionRuleset(input.permissions),
            } : {}),
          },
        });
        return { id: readSessionId(readOpenCodeV2Data(response)) };
      }
      const response = await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: '/session',
        query: directoryQuery(input.directory),
        body: input.permissions ? { permission: input.permissions } : {},
      });
      return { id: readSessionId(response) };
    },
    async sessionUpdatePermissions(input) {
      await requestJson({
        fetch: params.fetch,
        method: 'PATCH',
        path: `${isV2 ? '/api' : ''}/session/${encodeURIComponent(input.sessionId)}`,
        ...(isV2 ? {} : { query: directoryQuery(params.directory) }),
        body: isV2
          ? { permissions: buildOpenCodeV2PermissionRuleset(input.permissions) }
          : { permission: input.permissions },
        expectJson: false,
      });
    },
    async sessionFork(input) {
      if (isV2) {
        const response = await requestJson({
          fetch: params.fetch,
          method: 'POST',
          path: `/api/session/${encodeURIComponent(input.sessionId)}/fork`,
          body: input.messageId ? { before: input.messageId } : {},
        });
        return { id: readSessionId(readOpenCodeV2Data(response)) };
      }
      const response = await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/session/${encodeURIComponent(input.sessionId)}/fork`,
        query: directoryQuery(params.directory),
        body: input.messageId ? { messageID: input.messageId } : {},
      });
      return { id: readSessionId(response) };
    },
    async sessionSetAgent(input) {
      if (!isV2) return;
      await requestJson({
        fetch: params.fetch, method: 'POST',
        path: `/api/session/${encodeURIComponent(input.sessionId)}/agent`,
        body: { agent: input.agent }, expectJson: false,
      });
    },
    async sessionReadAgent(input) {
      const response = await requestJson({
        fetch: params.fetch, method: 'GET',
        path: `${isV2 ? '/api' : ''}/session/${encodeURIComponent(input.sessionId)}`,
        ...(isV2 ? {} : { query: directoryQuery(params.directory) }),
      });
      return normalizeString(asRecord(isV2 ? readOpenCodeV2Data(response) : response)?.agent) || null;
    },
    async sessionSetModel(input) {
      if (!isV2) return;
      let model = input.model;
      if (!model) {
        // Effort-only controls refine this exact native session, not a global model default.
        const response = await requestJson({
          fetch: params.fetch, method: 'GET', path: `/api/session/${encodeURIComponent(input.sessionId)}`,
        });
        const nativeModel = asRecord(asRecord(readOpenCodeV2Data(response))?.model);
        const providerID = normalizeString(nativeModel?.providerID);
        const modelID = normalizeString(nativeModel?.id);
        if (!providerID || !modelID) throw new Error('OpenCode session model is unavailable for reasoning selection');
        model = { providerID, modelID };
      }
      await requestJson({
        fetch: params.fetch, method: 'POST',
        path: `/api/session/${encodeURIComponent(input.sessionId)}/model`,
        body: { model: buildOpenCodeV2ModelRef({ ...model, variant: input.variant }) }, expectJson: false,
      });
    },
    async sessionPromptAsync(input) {
      if (isV2) {
        // V2 splits what V1 accepted in one body: the model is its own
        // `session.switchModel` call, and `session.prompt` carries only
        // the flat `{ id?, text, files?, agents?, skills?, delivery?, resume? }`.
        const promptConfig = buildPromptConfig(input);
        if (promptConfig.config) {
          throw unsupported(
            'session_prompt_config',
            'OpenCode V2 servers accept no per-prompt configuration override',
          );
        }
        const prompt = buildOpenCodeV2Prompt({
          text: input.text,
          parts: await resolveV2SkillParts(input.parts, () => this.appSkills({ directory: resolveDirectory(input.directory) ?? '' })),
        });
        if (input.agent) await this.sessionSetAgent({ sessionId: input.sessionId, agent: input.agent });
        if (input.model || promptConfig.variant) await this.sessionSetModel({
          sessionId: input.sessionId, model: input.model, variant: promptConfig.variant,
        });
        const response = await requestOptionalJson({
          fetch: params.fetch,
          method: 'POST',
          path: `/api/session/${encodeURIComponent(input.sessionId)}/prompt`,
          body: {
            ...(input.messageId ? { id: input.messageId } : {}),
            ...prompt,
          },
        });
        return readOpenCodeV2Data(response);
      }
      const promptConfig = buildPromptConfig(input);
      return await requestOptionalJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/session/${encodeURIComponent(input.sessionId)}/message`,
        query: directoryQuery(input.directory),
        body: {
          ...(input.messageId ? { messageID: input.messageId } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...promptConfig,
          parts: input.parts?.map((part) => part.type === 'skill'
            ? { type: 'text', text: part.text, synthetic: true } : part) ?? [{ type: 'text', text: input.text }],
        },
      });
    },
    async sessionCommand(input) {
      const variant = normalizeString(input.variant);
      let body: Readonly<Record<string, unknown>>;
      if (isV2) {
        body = {
          name: input.command,
          ...buildOpenCodeV2Prompt({ text: input.arguments, parts: await resolveV2SkillParts([
            { type: 'text', text: input.arguments }, ...(input.parts ?? []),
          ], () => this.appSkills({ directory: resolveDirectory(input.directory) ?? '' })) }),
          ...(input.delivery ? { delivery: input.delivery } : {}),
        };
        if (input.agent) await this.sessionSetAgent({ sessionId: input.sessionId, agent: input.agent });
        if (input.model || variant) await this.sessionSetModel({ sessionId: input.sessionId, model: input.model, variant });
      } else {
        if (input.delivery) throw unsupported('session_command_delivery', 'OpenCode V1 commands do not support native delivery');
        if (input.parts?.some((part) => part.type !== 'file')) {
          throw unsupported('session_command_attachments', 'OpenCode V1 commands support only file attachments');
        }
        body = {
          command: input.command,
          arguments: input.arguments,
          ...(input.messageId ? { messageID: input.messageId } : {}),
          ...(input.model ? { model: `${input.model.providerID}/${input.model.modelID}` } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(variant ? { variant } : {}),
          ...(input.parts && input.parts.length > 0 ? { parts: input.parts } : {}),
        };
      }
      // V1 waits for the generated response; V2 waits for its callback. Reuse the native prompt
      // transport without a control-read deadline or replay, retaining lifecycle cancellation.
      return await requestOptionalJson({
        fetch: params.fetch,
        method: 'POST',
        path: `${isV2 ? '/api' : ''}/session/${encodeURIComponent(input.sessionId)}/command`,
        ...(isV2 ? {} : { query: directoryQuery(input.directory) }),
        body,
        signal: lifecycleSignal,
      });
    },
    async sessionAbort(input) {
      await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: isV2
          ? `/api/session/${encodeURIComponent(input.sessionId)}/interrupt`
          : `/session/${encodeURIComponent(input.sessionId)}/abort`,
        ...(isV2 ? {} : { query: directoryQuery(input.directory) }),
        expectJson: false,
      });
    },
    async sessionSummarize(input) {
      if (isV2) {
        await requestOptionalJson({
          fetch: params.fetch,
          method: 'POST',
          path: `/api/session/${encodeURIComponent(input.sessionId)}/compact`,
          body: {},
        });
        return;
      }
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
      if (isV2) {
        // V2 has no per-session status route. `session.active` lists the
        // foreground drains this process owns; absence is the idle answer.
        const response = await requestJson({
          fetch: params.fetch,
          method: 'GET',
          path: '/api/session/active',
        });
        return readOpenCodeV2SessionStatus(response, input.sessionId);
      }
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/session/status',
        query: directoryQuery(input.directory),
      });
      return asRecord(response)?.[input.sessionId] ?? {};
    },
    async sessionChildInventory(input) {
      if (!isV2) return null;
      const sessions: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      for (;;) {
        const page = readOpenCodeV2SessionListPage(await requestJson({
          fetch: params.fetch,
          method: 'GET',
          path: '/api/session',
          query: cursor === null
            ? directoryQuery()
            : { cursor },
        }));
        sessions.push(...page.sessions);
        if (page.nextCursor === null || page.sessions.length === 0) break;
        if (seenCursors.has(page.nextCursor)) break;
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      const children = sessions.filter((raw) => (
        readNonBlankOpaqueIdentifier(asRecord(raw)?.parentID) === input.parentSessionId
        && (!input.childSessionId || readNonBlankOpaqueIdentifier(asRecord(raw)?.id) === input.childSessionId)
      ));
      if (children.length === 0) return [];
      const active = readOpenCodeV2ActiveSessionStatusMap(await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/api/session/active',
      }));
      return Promise.all(children.map(async (info) => {
        const childSessionId = readNonBlankOpaqueIdentifier(asRecord(info)?.id);
        const status = childSessionId && active[childSessionId]
          ? 'running' as const
          : childSessionId ? readOpenCodeNativeChildOutcome(await this.sessionMessages({ sessionId: childSessionId })) : null;
        return { info, status };
      }));
    },
    async sessionMessages(input) {
      if (isV2) {
        // The V2 timeline is paged and ordered. `order` seeds the first page and
        // the opaque cursor carries that order forward, so it must not be sent
        // alongside a cursor (`SessionMessagesQuery`).
        const path = `/api/session/${encodeURIComponent(input.sessionId)}/message`;
        const collected: unknown[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        for (;;) {
          const page: unknown = await requestJson({
            fetch: params.fetch,
            method: 'GET',
            path,
            query: cursor === null ? { order: 'asc' } : { cursor },
          });
          const { messages, nextCursor } = readOpenCodeV2MessagePage(page);
          collected.push(...messages);
          if (nextCursor === null || messages.length === 0) break;
          if (seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        return normalizeOpenCodeV2Messages(collected, input.sessionId);
      }
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: `/session/${encodeURIComponent(input.sessionId)}/message`,
        query: directoryQuery(input.directory),
      });
      if (!Array.isArray(response)) throw new Error('OpenCode session message page is invalid');
      return response;
    },
    async sessionTodo(input) {
      if (isV2) {
        throw unsupported(
          'session_todo',
          'OpenCode V2 servers expose no session todo route; todos arrive only as todo.updated events',
        );
      }
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: `/session/${encodeURIComponent(input.sessionId)}/todo`,
        query: directoryQuery(input.directory),
      });
      return Array.isArray(response) ? response : [];
    },
    async permissionList() {
      if (isV2) {
        const response = await requestJson({
          fetch: params.fetch,
          method: 'GET',
          path: '/api/permission/request',
          query: locationQuery(),
        });
        return readOpenCodeV2DataArray(response)
          .map((entry) => normalizeOpenCodeV2PermissionRequest(entry))
          .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== null);
      }
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/permission',
        query: directoryQuery(params.directory),
      });
      return Array.isArray(response) ? response : [];
    },
    async questionList() {
      if (isV2) {
        const response = await requestJson({
          fetch: params.fetch,
          method: 'GET',
          path: '/api/form',
          query: locationQuery(),
        });
        return readOpenCodeV2DataArray(response).flatMap((entry) => {
          const projection = projectOpenCodeV2Form(entry);
          if (!projection) return [];
          formProjections.set(projection.request.id, projection);
          return [projection.request];
        });
      }
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/question',
        query: directoryQuery(params.directory),
      });
      return Array.isArray(response) ? response : [];
    },
    async permissionReply(input) {
      // OpenCode minted this request id; the reply route addresses it verbatim.
      const requestId = readNonBlankOpaqueIdentifier(input.requestId);
      if (!requestId) return;
      const message = normalizeString(input.message);
      const body = {
        ...(isV2 ? { decision: input.reply } : { reply: input.reply }),
        ...(message ? { message } : {}),
      };
      if (isV2) {
        const sessionId = requireReplySessionId(input.sessionId, 'permission');
        await requestJson({
          fetch: params.fetch,
          method: 'POST',
          path: `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
          expectJson: false,
          body,
        });
        return;
      }
      await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/permission/${encodeURIComponent(requestId)}/reply`,
        expectJson: false,
        body,
      });
    },
    async questionReply(input) {
      if (isV2) {
        const sessionId = requireReplySessionId(input.sessionId, 'question');
        const projection = formProjections.get(input.requestId);
        if (!projection) throw new Error('OpenCode V2 form reply requires its authoritative form projection');
        await requestJson({
          fetch: params.fetch,
          method: 'POST',
          path: `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(input.requestId)}/reply`,
          body: { answer: buildOpenCodeV2FormAnswer(projection.bindings, input.answers, projection.hiddenBindings) },
          expectJson: false,
        });
        return;
      }
      await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/question/${encodeURIComponent(input.requestId)}/reply`,
        body: { answers: input.answers },
        expectJson: false,
      });
    },
    async questionReject(input) {
      if (isV2) {
        const sessionId = requireReplySessionId(input.sessionId, 'question');
        await requestJson({
          fetch: params.fetch,
          method: 'DELETE',
          path: `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(input.requestId)}`,
          expectJson: false,
        });
        return;
      }
      await requestJson({
        fetch: params.fetch,
        method: 'POST',
        path: `/question/${encodeURIComponent(input.requestId)}/reject`,
        body: {},
        expectJson: false,
      });
    },
    async appCommands(input) {
      if (isV2) return await readV2Catalog('/api/command', input.directory);
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/command',
        query: directoryQuery(input.directory),
        operation: 'command_catalog',
      });
      return Array.isArray(response) ? response : [];
    },
    async appSkills(input) {
      if (isV2) return await readV2Catalog('/api/skill', input.directory);
      const response = await params.fetch({
        url: pathWithQuery('/skill', directoryQuery(input.directory)),
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
    async subscribeGlobalEvents(subscription) {
      const subscribe = input.dialect === 'v2' ? subscribeOpenCodeV2InstanceEvents : subscribeOpenCodeInstanceEvents;
      await subscribe({
        fetch: params.streamFetch,
        directory: resolveDirectory(),
        signal: subscription.signal,
        onEvent: subscription.onEvent,
        onUnavailable: subscription.onUnavailable,
        ...(input.dialect === 'v2' ? { onFormProjection: (projection: OpenCodeV2FormProjection) => {
          formProjections.set(projection.request.id, projection);
        } } : {}),
      });
    },
    async globalConfigGet() {
      if (isV2) {
        // `/global/config` belongs to the V1 instance server's `/global` group,
        // which the standalone V2 protocol does not declare. Callers use it only
        // to learn a default model and already tolerate its absence.
        throw unsupported(
          'global_config',
          'OpenCode V2 servers expose no global configuration route',
        );
      }
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/global/config',
      });
      return asRecord(response) ?? {};
    },
    async agentsList() {
      const response = await requestJson({
        fetch: params.fetch, method: 'GET', path: isV2 ? '/api/agent' : '/agent',
        ...(isV2 ? { query: locationQuery() } : {}),
      });
      const rows = isV2 ? readOpenCodeV2Data(response) : response;
      if (!Array.isArray(rows)) throw new Error('Invalid OpenCode agent inventory');
      return rows.flatMap((row) => {
        const record = asRecord(row);
        const id = normalizeString(record?.id) || normalizeString(record?.name);
        const name = normalizeString(record?.name) || id;
        const description = normalizeString(record?.description);
        const mode = normalizeString(record?.mode);
        return id && name ? [{ id, name, ...(description ? { description } : {}), ...(mode ? { mode } : {}), ...(typeof record?.hidden === 'boolean' ? { hidden: record.hidden } : {}) }] : [];
      });
    },
    async providersList() {
      if (isV2) {
        // V2 split the single V1 `/provider` answer in two: `Provider.Info` no
        // longer carries a `models` map, so the model inventory is its own
        // location-scoped read keyed back by `providerID`.
        const providers = await requestJson({
          fetch: params.fetch,
          method: 'GET',
          path: '/api/provider',
          query: locationQuery(),
        });
        const models = await requestJson({
          fetch: params.fetch,
          method: 'GET',
          path: '/api/model',
          query: locationQuery(),
        });
        const providerRows = asRecord(providers)?.data;
        const modelRows = asRecord(models)?.data;
        if (!Array.isArray(providerRows) || !Array.isArray(modelRows)) throw new Error('Invalid OpenCode provider inventory');
        return combineOpenCodeV2Providers(providerRows, modelRows);
      }
      const response = await requestJson({
        fetch: params.fetch,
        method: 'GET',
        path: '/provider',
      });
      return readProviderList(response);
    },
  };
}
