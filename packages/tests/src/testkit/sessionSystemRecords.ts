import {
  SessionSystemRecordLatestResponseSchema,
  SessionSystemRecordLookupResponseSchema,
  SessionSystemRecordPageResponseSchema,
  SessionSystemRecordUpsertResponseSchema,
  type SessionSystemRecord,
  type SessionSystemRecordContent,
  type SessionSystemRecordKind,
  type SessionSystemRecordNamespace,
} from '@happier-dev/protocol';

import { fetchJson } from './http';

const SESSION_SYSTEM_RECORD_TIMEOUT_MS = 20_000;

type ProtocolSchema<T> = Readonly<{
  safeParse(value: unknown): Readonly<
    | { success: true; data: T }
    | { success: false; error: { message: string } }
  >;
}>;

function parseProtocolResponse<T>(schema: ProtocolSchema<T>, value: unknown, context: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`Invalid session system record response (${context}): ${parsed.error.message}`);
}

function sessionSystemRecordsEndpoint(baseUrl: string, sessionId: string): string {
  return `${baseUrl}/v2/sessions/${encodeURIComponent(sessionId)}/system-records`;
}

function latestSessionSystemRecordEndpoint(baseUrl: string, sessionId: string): string {
  return `${sessionSystemRecordsEndpoint(baseUrl, sessionId)}/latest`;
}

function lookupSessionSystemRecordEndpoint(baseUrl: string, sessionId: string): string {
  return `${sessionSystemRecordsEndpoint(baseUrl, sessionId)}/record`;
}

export async function upsertSessionSystemRecord(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  namespace: SessionSystemRecordNamespace;
  kind: SessionSystemRecordKind;
  localId: string;
  content: SessionSystemRecordContent;
}>): Promise<SessionSystemRecord> {
  const endpoint = sessionSystemRecordsEndpoint(params.baseUrl, params.sessionId);
  const res = await fetchJson<unknown>(endpoint, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      namespace: params.namespace,
      kind: params.kind,
      localId: params.localId,
      content: params.content,
    }),
    timeoutMs: SESSION_SYSTEM_RECORD_TIMEOUT_MS,
  });

  if (res.status !== 200) {
    throw new Error(`Expected 200 session system record upsert, received ${res.status}`);
  }
  return parseProtocolResponse(SessionSystemRecordUpsertResponseSchema, res.data, endpoint).record;
}

export async function fetchSessionSystemRecordsPage(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  namespace?: SessionSystemRecordNamespace;
  kind?: SessionSystemRecordKind;
  localId?: string;
  limit?: number;
  cursor?: string;
}>): Promise<Readonly<{ records: SessionSystemRecord[]; nextCursor: string | null; hasNext: boolean }>> {
  const endpoint = sessionSystemRecordsEndpoint(params.baseUrl, params.sessionId);
  const url = new URL(endpoint);
  if (params.namespace) url.searchParams.set('namespace', params.namespace);
  if (params.kind) url.searchParams.set('kind', params.kind);
  if (params.localId) url.searchParams.set('localId', params.localId);
  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
    url.searchParams.set('limit', String(params.limit));
  }
  if (typeof params.cursor === 'string') url.searchParams.set('cursor', params.cursor);

  const res = await fetchJson<unknown>(url.toString(), {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: SESSION_SYSTEM_RECORD_TIMEOUT_MS,
  });
  if (res.status !== 200) {
    throw new Error(`Expected 200 session system record list, received ${res.status}`);
  }
  const page = parseProtocolResponse(SessionSystemRecordPageResponseSchema, res.data, endpoint);

  return {
    records: page.records,
    nextCursor: page.nextCursor,
    hasNext: page.hasNext,
  };
}

export async function fetchLatestSessionSystemRecord(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  namespace: SessionSystemRecordNamespace;
  kind: SessionSystemRecordKind;
}>): Promise<SessionSystemRecord | null> {
  const endpoint = latestSessionSystemRecordEndpoint(params.baseUrl, params.sessionId);
  const url = new URL(endpoint);
  url.searchParams.set('namespace', params.namespace);
  url.searchParams.set('kind', params.kind);

  const res = await fetchJson<unknown>(url.toString(), {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: SESSION_SYSTEM_RECORD_TIMEOUT_MS,
  });
  if (res.status !== 200) {
    throw new Error(`Expected 200 session system record latest, received ${res.status}`);
  }
  return parseProtocolResponse(SessionSystemRecordLatestResponseSchema, res.data, endpoint).record;
}

export async function fetchSessionSystemRecord(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  namespace: SessionSystemRecordNamespace;
  localId: string;
}>): Promise<SessionSystemRecord | null> {
  const endpoint = lookupSessionSystemRecordEndpoint(params.baseUrl, params.sessionId);
  const url = new URL(endpoint);
  url.searchParams.set('namespace', params.namespace);
  url.searchParams.set('localId', params.localId);

  const res = await fetchJson<unknown>(url.toString(), {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: SESSION_SYSTEM_RECORD_TIMEOUT_MS,
  });
  if (res.status !== 200) {
    throw new Error(`Expected 200 session system record lookup, received ${res.status}`);
  }
  return parseProtocolResponse(SessionSystemRecordLookupResponseSchema, res.data, endpoint).record;
}
