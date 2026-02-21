import axios from 'axios';
import {
  type V2SessionByIdResponse,
  type V2SessionListResponse,
  V2SessionByIdResponseSchema,
  V2SessionListResponseSchema,
  V2SessionMessageResponseSchema,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveSessionEncryptionContext } from '@/api/client/encryptionKey';
import { encodeBase64, encrypt } from '@/api/encryption';
import { resolveSessionCreateEncryptionMode } from '@/api/session/resolveSessionCreateEncryptionMode';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type RawSessionRecord = V2SessionByIdResponse['session'];
export type RawSessionListRow = V2SessionListResponse['sessions'][number];

function parseOrThrow<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, payload: unknown, message: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success || !parsed.data) {
    throw new Error(message);
  }
  return parsed.data;
}

export async function fetchSessionById(params: Readonly<{ token: string; sessionId: string }>): Promise<RawSessionRecord | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.get(`${serverUrl}/v2/sessions/${params.sessionId}`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v2/sessions/${params.sessionId}: ${response.status}`);
  }

  return parseOrThrow<V2SessionByIdResponse>(V2SessionByIdResponseSchema, response.data, 'Unexpected /v2/sessions response shape').session;
}

function looksLikeMissingV2SessionRoute404(data: unknown, sessionId: string): boolean {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  const error = typeof anyData.error === 'string' ? anyData.error : '';
  const path = typeof anyData.path === 'string' ? anyData.path : '';
  const message = typeof anyData.message === 'string' ? anyData.message : '';
  if (error !== 'Not found') return false;
  const needle = `/v2/sessions/${sessionId}`;
  return (path && path.includes(needle)) || (message && message.includes(needle));
}

export async function fetchSessionByIdCompat(params: Readonly<{ token: string; sessionId: string }>): Promise<RawSessionRecord | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.get(`${serverUrl}/v2/sessions/${params.sessionId}`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (response.status === 404) {
    if (!looksLikeMissingV2SessionRoute404(response.data, params.sessionId)) return null;

    let cursor: string | undefined = undefined;
    for (let page = 0; page < 20; page++) {
      const res = await fetchSessionsPage({ token: params.token, cursor, limit: 200 });
      const match = res.sessions.find((row) => (row as any) && String((row as any).id ?? '') === params.sessionId);
      if (match) return match as unknown as RawSessionRecord;
      if (!res.hasNext || !res.nextCursor) return null;
      cursor = res.nextCursor;
    }
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v2/sessions/${params.sessionId}: ${response.status}`);
  }

  return parseOrThrow<V2SessionByIdResponse>(V2SessionByIdResponseSchema, response.data, 'Unexpected /v2/sessions response shape').session;
}

export async function fetchSessionsPage(params: Readonly<{
  token: string;
  cursor?: string;
  limit?: number;
  activeOnly?: boolean;
  archivedOnly?: boolean;
}>): Promise<{
  sessions: RawSessionListRow[];
  nextCursor: string | null;
  hasNext: boolean;
}> {
  const serverUrl = resolveServerHttpBaseUrl();
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : undefined;

  if (params.activeOnly && params.archivedOnly) {
    throw new Error('Cannot combine activeOnly and archivedOnly');
  }

  const path = params.activeOnly ? '/v2/sessions/active' : params.archivedOnly ? '/v2/sessions/archived' : '/v2/sessions';
  const response = await axios.get(`${serverUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: params.activeOnly
      ? { ...(limit ? { limit } : {}) }
      : { ...(params.cursor ? { cursor: params.cursor } : {}), ...(limit ? { limit } : {}) },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from ${path}: ${response.status}`);
  }

  const parsed = parseOrThrow<V2SessionListResponse>(
    V2SessionListResponseSchema,
    response.data,
    `Unexpected ${path} response shape`,
  );

  if (!Array.isArray(parsed.sessions)) {
    throw new Error(`Unexpected ${path} response shape`);
  }

  return {
    sessions: parsed.sessions,
    nextCursor: typeof parsed.nextCursor === 'string' ? parsed.nextCursor : null,
    hasNext: Boolean(parsed.hasNext),
  };
}

export async function commitSessionEncryptedMessage(params: Readonly<{
  token: string;
  sessionId: string;
  ciphertext: string;
  localId: string;
}>): Promise<{ didWrite: boolean; messageId: string; seq: number; createdAt: number }> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.post(`${serverUrl}/v2/sessions/${params.sessionId}/messages`, {
    ciphertext: params.ciphertext,
    localId: params.localId,
  }, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': params.localId,
    },
    timeout: 20_000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status === 404) {
    const err = new Error('Session not found');
    (err as any).code = 'session_not_found';
    throw err;
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v2/sessions/${params.sessionId}/messages: ${response.status}`);
  }

  const parsed = parseOrThrow(
    V2SessionMessageResponseSchema,
    response.data,
    `Unexpected /v2/sessions/${params.sessionId}/messages response shape`,
  );

  return {
    didWrite: parsed.didWrite,
    messageId: String(parsed.message?.id ?? ''),
    seq: Number(parsed.message?.seq ?? 0),
    createdAt: Number(parsed.message?.createdAt ?? 0),
  };
}

export async function getOrCreateSessionByTag(params: Readonly<{
  credentials: Credentials;
  tag: string;
  metadata: Record<string, unknown>;
  agentState: Record<string, unknown> | null;
}>): Promise<{ session: RawSessionRecord }> {
  const serverUrl = resolveServerHttpBaseUrl();

  const { desiredSessionEncryptionMode, serverSupportsFeatureSnapshot } = await resolveSessionCreateEncryptionMode({
    token: params.credentials.token,
    serverBaseUrl: serverUrl,
  });

  const { encryptionKey, encryptionVariant, dataEncryptionKey } = resolveSessionEncryptionContext(params.credentials);

  const metadataPayload =
    desiredSessionEncryptionMode === 'plain'
      ? JSON.stringify(params.metadata)
      : encodeBase64(encrypt(encryptionKey, encryptionVariant, params.metadata));
  const agentStatePayload =
    desiredSessionEncryptionMode === 'plain'
      ? (params.agentState ? JSON.stringify(params.agentState) : null)
      : (params.agentState ? encodeBase64(encrypt(encryptionKey, encryptionVariant, params.agentState)) : null);

  const dataEncryptionKeyPayload =
    desiredSessionEncryptionMode === 'plain'
      ? null
      : dataEncryptionKey
        ? encodeBase64(dataEncryptionKey)
        : null;

  const response = await axios.post(`${serverUrl}/v1/sessions`, {
    tag: params.tag,
    metadata: metadataPayload,
    agentState: agentStatePayload,
    dataEncryptionKey: dataEncryptionKeyPayload,
    ...(serverSupportsFeatureSnapshot ? { encryptionMode: desiredSessionEncryptionMode } : {}),
  }, {
    headers: {
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 60_000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions: ${response.status}`);
  }

  const parsed = parseOrThrow<V2SessionByIdResponse>(
    V2SessionByIdResponseSchema,
    response.data,
    'Unexpected /v1/sessions response shape',
  );
  if (!parsed || !parsed.session || typeof parsed.session !== 'object') {
    throw new Error('Unexpected /v1/sessions response shape');
  }
  return { session: parsed.session };
}

async function postArchiveMutation(params: Readonly<{
  token: string;
  sessionId: string;
  op: 'archive' | 'unarchive';
}>): Promise<{ archivedAt: number | null }> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.post(
    `${serverUrl}/v2/sessions/${params.sessionId}/${params.op}`,
    {},
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
      validateStatus: () => true,
    },
  );

  if (response.status === 401 || response.status === 403) {
    const err = new Error(`Unauthorized (${response.status})`);
    (err as any).code = 'not_authenticated';
    throw err;
  }
  if (response.status === 404) {
    const err = new Error('Session not found');
    (err as any).code = 'session_not_found';
    throw err;
  }
  if (response.status === 409 && params.op === 'archive') {
    const err = new Error('Cannot archive an active session');
    (err as any).code = 'session_active';
    throw err;
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v2/sessions/${params.sessionId}/${params.op}: ${response.status}`);
  }

  const ok = response.data && typeof response.data === 'object' && (response.data as any).success === true;
  if (!ok) {
    throw new Error(`Unexpected /v2/sessions/${params.sessionId}/${params.op} response shape`);
  }

  const archivedAt = (response.data as any).archivedAt;
  if (archivedAt === null) return { archivedAt: null };
  if (typeof archivedAt === 'number' && Number.isFinite(archivedAt) && archivedAt >= 0) return { archivedAt };
  throw new Error(`Unexpected /v2/sessions/${params.sessionId}/${params.op} response shape`);
}

export async function archiveSession(params: Readonly<{ token: string; sessionId: string }>): Promise<{ archivedAt: number }> {
  const res = await postArchiveMutation({ token: params.token, sessionId: params.sessionId, op: 'archive' });
  if (typeof res.archivedAt !== 'number') {
    throw new Error('Unexpected archive response (archivedAt is null)');
  }
  return { archivedAt: res.archivedAt };
}

export async function unarchiveSession(params: Readonly<{ token: string; sessionId: string }>): Promise<{ archivedAt: null }> {
  const res = await postArchiveMutation({ token: params.token, sessionId: params.sessionId, op: 'unarchive' });
  if (res.archivedAt !== null) {
    throw new Error('Unexpected unarchive response (archivedAt is not null)');
  }
  return { archivedAt: null };
}
