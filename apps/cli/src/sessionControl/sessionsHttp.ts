import axios from 'axios';

import type { Credentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type RawSessionRecord = Readonly<{
  id?: unknown;
  metadata?: unknown;
  metadataVersion?: unknown;
  agentState?: unknown;
  agentStateVersion?: unknown;
  dataEncryptionKey?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  active?: unknown;
  activeAt?: unknown;
  pendingCount?: unknown;
  share?: unknown;
}>;

export type RawSessionListRow = Readonly<{
  id?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  active?: unknown;
  activeAt?: unknown;
  pendingCount?: unknown;
  metadata?: unknown;
  metadataVersion?: unknown;
  agentState?: unknown;
  agentStateVersion?: unknown;
  dataEncryptionKey?: unknown;
  share?: unknown;
}>;

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

  const session = (response.data as any)?.session;
  if (!session || typeof session !== 'object') {
    throw new Error('Unexpected /v2/sessions response shape');
  }
  return session as RawSessionRecord;
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

  const session = (response.data as any)?.session;
  if (!session || typeof session !== 'object') {
    throw new Error('Unexpected /v2/sessions response shape');
  }
  return session as RawSessionRecord;
}

export async function fetchSessionsPage(params: Readonly<{
  token: string;
  cursor?: string;
  limit?: number;
  activeOnly?: boolean;
}>): Promise<{
  sessions: RawSessionListRow[];
  nextCursor: string | null;
  hasNext: boolean;
}> {
  const serverUrl = resolveServerHttpBaseUrl();
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : undefined;

  const path = params.activeOnly ? '/v2/sessions/active' : '/v2/sessions';
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

  const rawSessions = (response.data as any)?.sessions;
  if (!Array.isArray(rawSessions)) {
    throw new Error(`Unexpected ${path} response shape`);
  }

  return {
    sessions: rawSessions as RawSessionListRow[],
    nextCursor: typeof (response.data as any)?.nextCursor === 'string' ? String((response.data as any).nextCursor) : null,
    hasNext: Boolean((response.data as any)?.hasNext),
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

  return {
    didWrite: Boolean((response.data as any)?.didWrite),
    messageId: String((response.data as any)?.message?.id ?? ''),
    seq: Number((response.data as any)?.message?.seq ?? 0),
    createdAt: Number((response.data as any)?.message?.createdAt ?? 0),
  };
}

export async function getOrCreateSessionByTag(params: Readonly<{
  credentials: Credentials;
  tag: string;
  metadataCiphertext: string;
  agentStateCiphertext: string | null;
  dataEncryptionKey: string | null;
}>): Promise<{ session: RawSessionRecord }> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.post(`${serverUrl}/v1/sessions`, {
    tag: params.tag,
    metadata: params.metadataCiphertext,
    agentState: params.agentStateCiphertext,
    dataEncryptionKey: params.dataEncryptionKey,
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

  const session = (response.data as any)?.session;
  if (!session || typeof session !== 'object') {
    throw new Error('Unexpected /v1/sessions response shape');
  }
  return { session: session as RawSessionRecord };
}
