import { randomUUID } from 'node:crypto';

import { fetchJson } from './http';

export async function createSession(
  baseUrl: string,
  token: string,
  opts?: { dataEncryptionKeyBase64?: string | null },
): Promise<{ sessionId: string; tag: string }> {
  const tag = `e2e-${randomUUID()}`;
  const metadata = Buffer.from(JSON.stringify({ v: 1, tag, createdAt: Date.now() }), 'utf8').toString('base64');

  const res = await fetchJson<{ session?: { id?: string } }>(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag,
      metadata,
      agentState: null,
      dataEncryptionKey: typeof opts?.dataEncryptionKeyBase64 === 'string' ? opts.dataEncryptionKeyBase64 : undefined,
    }),
    timeoutMs: 15_000,
  });

  const sessionId = res.data?.session?.id;
  if (res.status !== 200 || typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`Failed to create session (status=${res.status})`);
  }
  return { sessionId, tag };
}

export async function createSessionWithCiphertexts(params: {
  baseUrl: string;
  token: string;
  tag?: string;
  metadataCiphertextBase64: string;
  agentStateCiphertextBase64?: string | null;
  dataEncryptionKeyBase64?: string | null;
}): Promise<{ sessionId: string; tag: string }> {
  const tag = typeof params.tag === 'string' && params.tag.trim().length > 0 ? params.tag.trim() : `e2e-${randomUUID()}`;

  const res = await fetchJson<{ session?: { id?: string } }>(`${params.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag,
      metadata: params.metadataCiphertextBase64,
      agentState: typeof params.agentStateCiphertextBase64 === 'string' ? params.agentStateCiphertextBase64 : null,
      dataEncryptionKey: typeof params.dataEncryptionKeyBase64 === 'string' ? params.dataEncryptionKeyBase64 : undefined,
    }),
    timeoutMs: 15_000,
  });

  const sessionId = res.data?.session?.id;
  if (res.status !== 200 || typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`Failed to create session (status=${res.status})`);
  }
  return { sessionId, tag };
}

export type SessionMessageRow = {
  id: string;
  seq: number;
  localId: string | null;
  content: { t: 'encrypted'; c: string };
  createdAt: number;
  updatedAt: number;
};

export async function fetchMessagesPage(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  afterSeq: number;
  limit?: number;
}): Promise<{ messages: SessionMessageRow[]; nextAfterSeq: number | null }> {
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : 500;
  const url = new URL(`${params.baseUrl}/v1/sessions/${params.sessionId}/messages`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('afterSeq', String(params.afterSeq));

  const res = await fetchJson<{ messages?: SessionMessageRow[]; nextAfterSeq?: number | null }>(url.toString(), {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });

  if (res.status !== 200 || !Array.isArray(res.data?.messages)) {
    throw new Error(`Failed to fetch messages (status=${res.status})`);
  }

  return { messages: res.data.messages, nextAfterSeq: typeof res.data.nextAfterSeq === 'number' ? res.data.nextAfterSeq : null };
}

export function maxMessageSeq(messages: SessionMessageRow[]): number {
  if (messages.length === 0) return 0;
  return Math.max(...messages.map((m) => m.seq));
}

export function countDuplicateLocalIds(messages: SessionMessageRow[]): number {
  const seen = new Set<string>();
  let dupes = 0;
  for (const m of messages) {
    if (!m.localId) continue;
    if (seen.has(m.localId)) dupes++;
    else seen.add(m.localId);
  }
  return dupes;
}

export async function fetchAllMessages(baseUrl: string, token: string, sessionId: string): Promise<SessionMessageRow[]> {
  const out: SessionMessageRow[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await fetchMessagesPage({ baseUrl, token, sessionId, afterSeq, limit: 500 });
    const messages = page.messages;
    out.push(...messages);

    const nextAfterSeq = page.nextAfterSeq;
    if (typeof nextAfterSeq === 'number' && Number.isFinite(nextAfterSeq) && nextAfterSeq > afterSeq) {
      afterSeq = nextAfterSeq;
      continue;
    }
    break;
  }
  return out;
}

export async function fetchMessagesSince(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  afterSeq: number;
}): Promise<SessionMessageRow[]> {
  const out: SessionMessageRow[] = [];
  let cursor = params.afterSeq;
  for (;;) {
    const page = await fetchMessagesPage({ baseUrl: params.baseUrl, token: params.token, sessionId: params.sessionId, afterSeq: cursor, limit: 500 });
    out.push(...page.messages);
    if (typeof page.nextAfterSeq === 'number' && Number.isFinite(page.nextAfterSeq) && page.nextAfterSeq > cursor) {
      cursor = page.nextAfterSeq;
      continue;
    }
    break;
  }
  return out;
}

export type SessionV2 = {
  id: string;
  seq: number;
  metadata: string;
  metadataVersion: number;
  agentState: string | null;
  agentStateVersion: number;
  createdAt: number;
  updatedAt: number;
  active: boolean;
  activeAt: number;
};

export type SessionV2ListRow = SessionV2 & {
  dataEncryptionKey: string | null;
  share: { accessLevel: string; canApprovePermissions: boolean } | null;
};

export async function fetchSessionsV2(baseUrl: string, token: string, opts?: { cursor?: string; limit?: number }): Promise<{
  sessions: SessionV2ListRow[];
  nextCursor: string | null;
  hasNext: boolean;
}> {
  const url = new URL(`${baseUrl}/v2/sessions`);
  if (typeof opts?.cursor === 'string') url.searchParams.set('cursor', opts.cursor);
  if (typeof opts?.limit === 'number' && Number.isFinite(opts.limit)) url.searchParams.set('limit', String(opts.limit));

  const res = await fetchJson<any>(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 20_000,
  });
  const sessions = res.data?.sessions;
  if (res.status !== 200 || !Array.isArray(sessions)) {
    throw new Error(`Failed to fetch v2 sessions (status=${res.status})`);
  }
  return {
    sessions: sessions as SessionV2ListRow[],
    nextCursor: typeof res.data?.nextCursor === 'string' ? res.data.nextCursor : null,
    hasNext: res.data?.hasNext === true,
  };
}

export async function fetchSessionV2(baseUrl: string, token: string, sessionId: string): Promise<SessionV2> {
  const res = await fetchJson<{ session?: SessionV2 }>(`${baseUrl}/v2/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
  });
  const s = res.data?.session;
  if (res.status !== 200 || !s || typeof s.id !== 'string') {
    throw new Error(`Failed to fetch session (status=${res.status})`);
  }
  return s;
}

export async function patchSessionAgentState(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  ciphertext: string | null;
  expectedVersion: number;
}): Promise<{ ok: true; version: number } | { ok: false; error: 'version-mismatch'; current: { version: number; value: string | null } } | { ok: false; error: string }> {
  const { baseUrl, token, sessionId, ciphertext, expectedVersion } = params;
  const res = await fetchJson<any>(`${baseUrl}/v2/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      agentState: { ciphertext, expectedVersion },
    }),
    timeoutMs: 20_000,
  });

  if (res.status === 200 && res.data && res.data.success === true && res.data.agentState && typeof res.data.agentState.version === 'number') {
    return { ok: true, version: res.data.agentState.version };
  }
  if (res.status === 200 && res.data && res.data.success === false && res.data.error === 'version-mismatch' && res.data.agentState) {
    return { ok: false, error: 'version-mismatch', current: { version: res.data.agentState.version, value: res.data.agentState.value } };
  }
  return { ok: false, error: `status=${res.status}` };
}
