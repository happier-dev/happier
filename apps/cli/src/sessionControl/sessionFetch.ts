import axios from 'axios';

import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type RawSessionRecord = Readonly<{
  id?: unknown;
  metadata?: unknown;
  metadataVersion?: unknown;
  agentState?: unknown;
  agentStateVersion?: unknown;
  dataEncryptionKey?: unknown;
  pendingCount?: unknown;
  pendingVersion?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  active?: unknown;
  activeAt?: unknown;
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

export async function fetchSessionById(params: { token: string; sessionId: string }): Promise<RawSessionRecord | null> {
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

export async function fetchSessionsPage(params: Readonly<{ token: string; cursor?: string; limit?: number; activeOnly?: boolean }>): Promise<{
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

