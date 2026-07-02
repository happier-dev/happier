import axios from 'axios';

import {
  SessionSystemRecordLatestResponseSchema,
  SessionSystemRecordLookupResponseSchema,
  SessionSystemRecordPageResponseSchema,
  SessionSystemRecordUpsertResponseSchema,
  type SessionSystemRecord,
  type SessionSystemRecordContent,
  type SessionSystemRecordKind,
  type SessionSystemRecordNamespace,
  type SessionSystemRecordPageResponse,
} from '@happier-dev/protocol';

import { createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type FetchSessionSystemRecordsPageResult = Readonly<{
  records: SessionSystemRecord[];
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
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(extra ?? {}),
  };
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

export async function upsertSessionSystemRecord(params: Readonly<{
  token: string;
  sessionId: string;
  namespace: SessionSystemRecordNamespace;
  kind: SessionSystemRecordKind;
  localId: string;
  content: SessionSystemRecordContent;
}>): Promise<SessionSystemRecord> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const route = `/v2/sessions/${params.sessionId}/system-records`;
  const response = await axios.put(`${serverUrl}/v2/sessions/${encodedSessionId}/system-records`, {
    namespace: params.namespace,
    kind: params.kind,
    localId: params.localId,
    content: params.content,
  }, {
    headers: buildHeaders(params.token, { 'Idempotency-Key': params.localId }),
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
  const parsed: SessionSystemRecordPageResponse = parseOrThrow(
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
}>): Promise<SessionSystemRecord | null> {
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
  return parseOrThrow(SessionSystemRecordLatestResponseSchema, response.data, `Unexpected ${route} response shape`).record;
}

export async function fetchSessionSystemRecord(params: Readonly<{
  token: string;
  sessionId: string;
  namespace: SessionSystemRecordNamespace;
  localId: string;
}>): Promise<SessionSystemRecord | null> {
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
  return parseOrThrow(SessionSystemRecordLookupResponseSchema, response.data, `Unexpected ${route} response shape`).record;
}
