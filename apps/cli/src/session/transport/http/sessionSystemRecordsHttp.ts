import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';

import {
  LegacyHostSessionSystemRecordLatestResponseSchema,
  LegacyHostSessionSystemRecordLookupResponseSchema,
  LegacyHostSessionSystemRecordPageResponseSchema as SessionSystemRecordPageResponseSchema,
  LegacyHostSessionSystemRecordUpsertResponseSchema as SessionSystemRecordUpsertResponseSchema,
  SESSION_SYSTEM_RECORDS_PLUGIN_ID_HEADER,
  SessionSystemRecordDeleteResponseSchema,
  SessionSystemRecordStoredPageResponseSchema,
  SessionSystemRecordStoredReadResponseSchema,
  SessionSystemRecordStoredUpsertResponseSchema,
  type LegacyHostSessionSystemRecord,
  type SessionSystemRecordAddress,
  type SessionSystemRecordContent,
  type SessionSystemRecordDeleteRequest,
  type SessionSystemRecordKind,
  type SessionSystemRecordListQuery,
  type SessionSystemRecordNamespace,
  type SessionSystemRecordStored,
  type SessionSystemRecordStoredUpsertRequest,
  type LegacyHostSessionSystemRecordPageResponse,
} from '@happier-dev/protocol';

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

function buildHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(extra ?? {}),
  };
}

function buildV1PluginRecordHeaders(token: string, pluginId: string): Record<string, string> {
  return buildHeaders(token, {
    [SESSION_SYSTEM_RECORDS_PLUGIN_ID_HEADER]: pluginId,
    'x-happier-session-system-records-protocol': '1',
  });
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
  if (isAuthenticationStatus(status)) {
    throwAuthenticationStatusError(status);
  }
  const payload = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const code = typeof payload.code === 'string'
    ? payload.code
    : 'plugin_session_record_transport_error';
  const error = createHttpStatusError(status, 'Plugin Session system record request failed', code);
  Object.assign(error, {
    code,
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

async function retryLostMutationAcknowledgement<T>(params: Readonly<{
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

export async function listSessionSystemRecordsV1(params: Readonly<{
  token: string;
  sessionId: string;
  pluginId: string;
  query: SessionSystemRecordListQuery;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  records: readonly SessionSystemRecordStored[];
  nextCursor: string | null;
  hasNext: boolean;
}>> {
  const route = v1SystemRecordRoute(params.sessionId);
  const response = await axios.get(`${resolveServerHttpBaseUrl()}${route}`, {
    headers: buildV1PluginRecordHeaders(params.token, params.pluginId),
    params: params.query,
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (response.status !== 200) throwV1PluginRecordStatus(response.status, response.data);
  return parseOrThrow(
    SessionSystemRecordStoredPageResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  );
}

export async function readSessionSystemRecordV1(params: Readonly<{
  token: string;
  sessionId: string;
  pluginId: string;
  address: SessionSystemRecordAddress;
  signal?: AbortSignal;
}>): Promise<SessionSystemRecordStored | null> {
  const route = v1SystemRecordRoute(params.sessionId, '/record');
  const response = await axios.get(`${resolveServerHttpBaseUrl()}${route}`, {
    headers: buildV1PluginRecordHeaders(params.token, params.pluginId),
    params: params.address,
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (response.status !== 200) throwV1PluginRecordStatus(response.status, response.data);
  return parseOrThrow(
    SessionSystemRecordStoredReadResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  ).record;
}

export async function upsertSessionSystemRecordV1(params: Readonly<{
  token: string;
  sessionId: string;
  pluginId: string;
  request: SessionSystemRecordStoredUpsertRequest;
  signal?: AbortSignal;
}>): Promise<SessionSystemRecordStored> {
  const route = v1SystemRecordRoute(params.sessionId);
  const response = await retryLostMutationAcknowledgement({
    signal: params.signal,
    send: async () => await axios.put(`${resolveServerHttpBaseUrl()}${route}`, params.request, {
      headers: buildV1PluginRecordHeaders(params.token, params.pluginId),
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
      ...(params.signal ? { signal: params.signal } : {}),
    }),
  });
  if (response.status !== 200) throwV1PluginRecordStatus(response.status, response.data);
  return parseOrThrow(
    SessionSystemRecordStoredUpsertResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  ).record;
}

export async function deleteSessionSystemRecordV1(params: Readonly<{
  token: string;
  sessionId: string;
  pluginId: string;
  request: SessionSystemRecordDeleteRequest;
  signal?: AbortSignal;
}>): Promise<void> {
  const route = v1SystemRecordRoute(params.sessionId, '/record');
  const response = await retryLostMutationAcknowledgement({
    signal: params.signal,
    send: async () => await axios.delete(`${resolveServerHttpBaseUrl()}${route}`, {
      headers: buildV1PluginRecordHeaders(params.token, params.pluginId),
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
  namespace: SessionSystemRecordNamespace;
  kind: SessionSystemRecordKind;
  localId: string;
  content: SessionSystemRecordContent;
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
  });

  handleCommonStatus(response.status, route);
  return parseOrThrow(SessionSystemRecordUpsertResponseSchema, response.data, `Unexpected ${route} response shape`).record;
}

export async function fetchSessionSystemRecordsPage(params: Readonly<{
  token: string;
  sessionId: string;
  namespace?: SessionSystemRecordNamespace;
  kind?: SessionSystemRecordKind;
  localId?: string;
  cursor?: string;
  limit?: number;
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
  namespace: SessionSystemRecordNamespace;
  kind: SessionSystemRecordKind;
}>): Promise<LegacyHostSessionSystemRecord | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const route = `/v2/sessions/${params.sessionId}/system-records/latest`;
  const response = await axios.get(`${serverUrl}/v2/sessions/${encodedSessionId}/system-records/latest`, {
    headers: buildHeaders(params.token),
    params: { namespace: params.namespace, kind: params.kind },
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });

  handleCommonStatus(response.status, route);
  return parseOrThrow(LegacyHostSessionSystemRecordLatestResponseSchema, response.data, `Unexpected ${route} response shape`).record;
}

export async function fetchSessionSystemRecord(params: Readonly<{
  token: string;
  sessionId: string;
  namespace: SessionSystemRecordNamespace;
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
