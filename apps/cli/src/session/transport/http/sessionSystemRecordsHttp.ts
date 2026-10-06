import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';

import { LegacyHostSessionSystemRecordLatestResponseSchema, LegacyHostSessionSystemRecordLookupResponseSchema, LegacyHostSessionSystemRecordPageResponseSchema as SessionSystemRecordPageResponseSchema, LegacyHostSessionSystemRecordUpsertResponseSchema as SessionSystemRecordUpsertResponseSchema, SESSION_SYSTEM_RECORDS_PLUGIN_ID_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE, readSessionSystemRecordErrorCodeV1, SessionSystemRecordDeleteResponseSchema, SessionSystemRecordStoredPageResponseSchema, SessionSystemRecordStoredReadResponseSchema, SessionSystemRecordStoredUpsertResponseSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import type { LegacyHostSessionSystemRecord, LegacyHostSessionSystemRecordLatestQuery, LegacyHostSessionSystemRecordListQuery, LegacyHostSessionSystemRecordLookupQuery, LegacyHostSessionSystemRecordUpsertRequest, SessionSystemRecordAddress, SessionSystemRecordContent, SessionSystemRecordDeleteRequest, SessionSystemRecordKind, SessionSystemRecordListQuery, SessionSystemRecordNamespace, SessionSystemRecordStored, SessionSystemRecordStoredUpsertRequest, LegacyHostSessionSystemRecordPageResponse } from '@happier-dev/protocol';

import { createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type FetchSessionSystemRecordsPageResult = Readonly<{
  records: LegacyHostSessionSystemRecord[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

function encodeSessionIdPathSegment(sessionId: string): string {
  return encodeURIComponent(String(sessionId ?? ''));
}

function throwAuthenticationStatusError(status: number, message = `Unauthorized (${status})`): never {
  throw createHttpStatusError(status, message, 'not_authenticated');
}

function throwUnexpectedHttpStatusError(status: number, message: string): never {
  throw createHttpStatusError(status, message);
}

function parseOrThrow<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, payload: unknown, message: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success || !parsed.data) {
    throw new Error(message);
  }
  return parsed.data;
}

function buildHeaders(
  token: string,
  extra?: Record<string, string>,
  authorizationHeaders?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    ...(authorizationHeaders ?? { Authorization: `Bearer ${token}` }),
    'Content-Type': 'application/json',
    ...(extra ?? {}),
  };
}

function buildV1RecordHeaders(
  token: string,
  owner: SessionSystemRecordAddress['owner'],
  pluginId?: string,
  authorizationHeaders?: Readonly<Record<string, string>>,
): Record<string, string> {
  const identity = owner === 'plugin' ? PluginIdSchema.safeParse(pluginId) : null;
  if (identity && !identity.success) {
    throw createHttpStatusError(400, 'Plugin Session record identity is required', 'plugin_session_record_invalid_query');
  }
  return buildHeaders(token, {
    ...(identity?.success ? { [SESSION_SYSTEM_RECORDS_PLUGIN_ID_HEADER]: identity.data } : {}),
    [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE,
  }, authorizationHeaders);
}

type ResolveSystemRecordAuthorizationHeaders = (request: Readonly<{
  method: 'GET'; path: string;
}>) => Readonly<Record<string, string>> | null;

function appendQuery(path: string, query: Readonly<Record<string, unknown>>): string {
  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) encoded.set(key, String(value));
  }
  const suffix = encoded.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function handleCommonStatus(status: number, route: string): void {
  if (isAuthenticationStatus(status)) {
    throwAuthenticationStatusError(status);
  }
  if (status === 404) {
    const err = new Error('Session not found');
    (err as { code?: string }).code = 'session_not_found';
    throw err;
  }
  if (status !== 200) {
    throwUnexpectedHttpStatusError(status, `Unexpected status from ${route}: ${status}`);
  }
}

function throwV1PluginRecordStatus(status: number, data: unknown): never {
  // The producer answers in the typed body, so read it before any status inference:
  // an operation-scoped 403 denial is `forbidden`, not "you are not signed in".
  const typedCode = readSessionSystemRecordErrorCodeV1(data);
  if (typedCode === null) {
    if (isAuthenticationStatus(status)) {
      throwAuthenticationStatusError(status);
    }
    throw createHttpStatusError(
      status,
      'Plugin Session system record request failed',
      'plugin_session_record_transport_error',
    );
  }
  const payload = data as Record<string, unknown>;
  const error = createHttpStatusError(status, 'Plugin Session system record request failed', typedCode);
  Object.assign(error, {
    code: typedCode,
    ...(typeof payload.currentRevision === 'string' ? { currentRevision: payload.currentRevision } : {}),
  });
  throw error;
}

function canRetryLostMutationAcknowledgement(error: unknown, signal?: AbortSignal): boolean {
  return !signal?.aborted
    && axios.isAxiosError(error)
    && !error.response
    && error.code !== 'ERR_CANCELED';
}

function mutationOutcomeUnknownError(): Error & Readonly<{
  code: 'plugin_session_record_outcome_unknown';
  retryable: false;
}> {
  return Object.assign(
    new Error('Session system record mutation acknowledgement was lost after an exact replay'),
    {
      code: 'plugin_session_record_outcome_unknown' as const,
      retryable: false as const,
    },
  );
}

export async function retryLostMutationAcknowledgement<T>(params: Readonly<{
  signal?: AbortSignal;
  send: () => Promise<T>;
}>): Promise<T> {
  try {
    return await params.send();
  } catch (firstError) {
    if (!canRetryLostMutationAcknowledgement(firstError, params.signal)) throw firstError;
  }
  try {
    return await params.send();
  } catch (replayError) {
    if (canRetryLostMutationAcknowledgement(replayError, params.signal)) {
      throw mutationOutcomeUnknownError();
    }
    throw replayError;
  }
}

function v1SystemRecordRoute(sessionId: string, suffix = ''): string {
  return `/v2/sessions/${encodeSessionIdPathSegment(sessionId)}/system-records${suffix}`;
}

function assertV1ResponseScope(address: SessionSystemRecordAddress, query: Pick<SessionSystemRecordListQuery, 'owner' | 'namespace' | 'kind' | 'localId'>): void {
  if (address.owner !== query.owner || address.namespace !== query.namespace
    || (query.kind !== undefined && address.kind !== query.kind)
    || (query.localId !== undefined && address.localId !== query.localId)) {
    throw createHttpStatusError(502, 'Session system record response escaped its requested address', 'plugin_session_record_invalid_response');
  }
}

export async function listSessionSystemRecordsV1(params: Readonly<{
  token: string;
  sessionId: string;
  pluginId?: string;
  serverUrl?: string;
  query: SessionSystemRecordListQuery;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSystemRecordAuthorizationHeaders;
}>): Promise<Readonly<{
  records: readonly SessionSystemRecordStored[];
  nextCursor: string | null;
  hasNext: boolean;
}>> {
  const route = v1SystemRecordRoute(params.sessionId);
  const requestPath = appendQuery(route, params.query);
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'GET', path: requestPath });
  if (params.resolveAuthorizationHeaders && !authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.get(`${params.serverUrl ?? resolveServerHttpBaseUrl()}${requestPath}`, {
    headers: buildV1RecordHeaders(params.token, params.query.owner, params.pluginId, authorizationHeaders ?? undefined),
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (response.status !== 200) throwV1PluginRecordStatus(response.status, response.data);
  const page = parseOrThrow(
    SessionSystemRecordStoredPageResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  );
  for (const record of page.records) assertV1ResponseScope(record.address, params.query);
  if (page.hasNext !== (page.nextCursor !== null)) {
    throw createHttpStatusError(502, 'Session system record pagination response was inconsistent', 'plugin_session_record_invalid_response');
  }
  return page;
}

export async function readSessionSystemRecordV1(params: Readonly<{
  token: string;
  sessionId: string;
  pluginId?: string;
  serverUrl?: string;
  address: SessionSystemRecordAddress;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: ResolveSystemRecordAuthorizationHeaders;
}>): Promise<SessionSystemRecordStored | null> {
  const route = v1SystemRecordRoute(params.sessionId, '/record');
  const requestPath = appendQuery(route, params.address);
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'GET', path: requestPath });
  if (params.resolveAuthorizationHeaders && !authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.get(`${params.serverUrl ?? resolveServerHttpBaseUrl()}${requestPath}`, {
    headers: buildV1RecordHeaders(params.token, params.address.owner, params.pluginId, authorizationHeaders ?? undefined),
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (response.status !== 200) throwV1PluginRecordStatus(response.status, response.data);
  const record = parseOrThrow(
    SessionSystemRecordStoredReadResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  ).record;
  if (record) assertV1ResponseScope(record.address, params.address);
  return record;
}

export async function upsertSessionSystemRecordV1(params: Readonly<{
  token: string;
  sessionId: string;
  pluginId?: string;
  request: SessionSystemRecordStoredUpsertRequest;
  signal?: AbortSignal;
}>): Promise<SessionSystemRecordStored> {
  const route = v1SystemRecordRoute(params.sessionId);
  const response = await retryLostMutationAcknowledgement({
    signal: params.signal,
    send: async () => await axios.put(`${resolveServerHttpBaseUrl()}${route}`, params.request, {
      headers: buildV1RecordHeaders(params.token, params.request.address.owner, params.pluginId),
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
      ...(params.signal ? { signal: params.signal } : {}),
    }),
  });
  if (response.status !== 200) throwV1PluginRecordStatus(response.status, response.data);
  const record = parseOrThrow(
    SessionSystemRecordStoredUpsertResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  ).record;
  if (record) assertV1ResponseScope(record.address, params.request.address);
  return record;
}

export async function deleteSessionSystemRecordV1(params: Readonly<{
  token: string;
  sessionId: string;
  pluginId?: string;
  request: SessionSystemRecordDeleteRequest;
  signal?: AbortSignal;
}>): Promise<void> {
  const route = v1SystemRecordRoute(params.sessionId, '/record');
  const response = await retryLostMutationAcknowledgement({
    signal: params.signal,
    send: async () => await axios.delete(`${resolveServerHttpBaseUrl()}${route}`, {
      headers: buildV1RecordHeaders(params.token, params.request.address.owner, params.pluginId),
      data: params.request,
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
      ...(params.signal ? { signal: params.signal } : {}),
    }),
  });
  if (response.status !== 200) throwV1PluginRecordStatus(response.status, response.data);
  parseOrThrow(
    SessionSystemRecordDeleteResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  );
}

export async function upsertSessionSystemRecord(params: Readonly<{
  token: string;
  sessionId: string;
  namespace: LegacyHostSessionSystemRecordUpsertRequest['namespace'];
  kind: LegacyHostSessionSystemRecordUpsertRequest['kind'];
  localId: string;
  content: LegacyHostSessionSystemRecordUpsertRequest['content'];
  signal?: AbortSignal;
}>): Promise<LegacyHostSessionSystemRecord> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const route = `/v2/sessions/${params.sessionId}/system-records`;
  const response = await axios.put(`${serverUrl}/v2/sessions/${encodedSessionId}/system-records`, {
    namespace: params.namespace,
    kind: params.kind,
    localId: params.localId,
    content: params.content,
  }, {
    headers: buildHeaders(params.token),
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  handleCommonStatus(response.status, route);
  return parseOrThrow(SessionSystemRecordUpsertResponseSchema, response.data, `Unexpected ${route} response shape`).record;
}

export async function fetchSessionSystemRecordsPage(params: Readonly<{
  token: string;
  sessionId: string;
  namespace?: LegacyHostSessionSystemRecordListQuery['namespace'];
  kind?: LegacyHostSessionSystemRecordListQuery['kind'];
  localId?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}>): Promise<FetchSessionSystemRecordsPageResult> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const route = `/v2/sessions/${params.sessionId}/system-records`;
  const response = await axios.get(`${serverUrl}/v2/sessions/${encodedSessionId}/system-records`, {
    headers: buildHeaders(params.token),
    params: {
      ...(params.namespace ? { namespace: params.namespace } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.localId ? { localId: params.localId } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ...(typeof params.limit === 'number' && Number.isFinite(params.limit) ? { limit: Math.max(1, Math.trunc(params.limit)) } : {}),
    },
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  handleCommonStatus(response.status, route);
  const parsed: LegacyHostSessionSystemRecordPageResponse = parseOrThrow(
    SessionSystemRecordPageResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  );
  return {
    records: parsed.records,
    nextCursor: parsed.nextCursor,
    hasNext: parsed.hasNext,
  };
}

export async function fetchLatestSessionSystemRecord(params: Readonly<{
  token: string;
  sessionId: string;
  namespace: LegacyHostSessionSystemRecordLatestQuery['namespace'];
  kind: LegacyHostSessionSystemRecordLatestQuery['kind'];
  signal?: AbortSignal;
}>): Promise<LegacyHostSessionSystemRecord | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const route = `/v2/sessions/${params.sessionId}/system-records/latest`;
  const response = await axios.get(`${serverUrl}/v2/sessions/${encodedSessionId}/system-records/latest`, {
    headers: buildHeaders(params.token),
    params: { namespace: params.namespace, kind: params.kind },
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  handleCommonStatus(response.status, route);
  return parseOrThrow(LegacyHostSessionSystemRecordLatestResponseSchema, response.data, `Unexpected ${route} response shape`).record;
}

export async function fetchSessionSystemRecord(params: Readonly<{
  token: string;
  sessionId: string;
  namespace: LegacyHostSessionSystemRecordLookupQuery['namespace'];
  localId: string;
}>): Promise<LegacyHostSessionSystemRecord | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const route = `/v2/sessions/${params.sessionId}/system-records/record`;
  const response = await axios.get(`${serverUrl}/v2/sessions/${encodedSessionId}/system-records/record`, {
    headers: buildHeaders(params.token),
    params: { namespace: params.namespace, localId: params.localId },
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });

  handleCommonStatus(response.status, route);
  return parseOrThrow(LegacyHostSessionSystemRecordLookupResponseSchema, response.data, `Unexpected ${route} response shape`).record;
}
