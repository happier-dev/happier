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

export async function patchSessionMetadataWithRetry(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  ciphertext: string;
  expectedVersion: number;
  maxAttempts?: number;
  timeoutMs?: number;
}): Promise<void> {
  let expectedVersion = params.expectedVersion;
  const maxAttempts = typeof params.maxAttempts === 'number' && Number.isFinite(params.maxAttempts)
    ? Math.max(1, Math.floor(params.maxAttempts))
    : 5;
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
    ? params.timeoutMs
    : 20_000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await fetchJson<any>(`${params.baseUrl}/v2/sessions/${params.sessionId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        metadata: { ciphertext: params.ciphertext, expectedVersion },
      }),
      timeoutMs,
    });

    if (res.status !== 200) {
      throw new Error(`Failed to patch metadata (status=${res.status})`);
    }

    if (res.data?.success === true) {
      return;
    }

    const currentVersion = typeof res.data?.metadata?.version === 'number' ? res.data.metadata.version : null;
    const isVersionMismatch = res.data?.success === false && res.data?.error === 'version-mismatch' && currentVersion !== null;

    if (!isVersionMismatch || attempt === maxAttempts - 1) {
      throw new Error(`Failed to patch metadata (status=${res.status})`);
    }

    expectedVersion = currentVersion;
  }
}

export type SessionMessageRow = {
  id: string;
  seq: number;
  localId: string | null;
  content: { t: 'encrypted'; c: string };
  createdAt: number;
  updatedAt: number;
};

type SessionMessagesPageResponse = {
  messages?: unknown;
  nextAfterSeq?: unknown;
};

type SessionsV2Response = {
  sessions?: unknown;
  nextCursor?: unknown;
  hasNext?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseSessionMessageRow(value: unknown, context: string): SessionMessageRow {
  if (!isRecord(value)) throw new Error(`Invalid message row shape (${context})`);

  const id = value.id;
  const seq = value.seq;
  const localId = value.localId;
  const content = value.content;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;

  if (typeof id !== 'string' || id.length === 0) throw new Error(`Invalid message row id (${context})`);
  if (typeof seq !== 'number' || !Number.isFinite(seq)) throw new Error(`Invalid message row seq (${context})`);
  if (!(localId === null || typeof localId === 'string')) throw new Error(`Invalid message row localId (${context})`);
  if (!isRecord(content) || content.t !== 'encrypted' || typeof content.c !== 'string') {
    throw new Error(`Invalid message row content (${context})`);
  }
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) throw new Error(`Invalid message row createdAt (${context})`);
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) throw new Error(`Invalid message row updatedAt (${context})`);

  return {
    id,
    seq,
    localId,
    content: { t: 'encrypted', c: content.c },
    createdAt,
    updatedAt,
  };
}

async function paginateMessages(params: {
  startAfterSeq: number;
  fetchPage: (afterSeq: number) => Promise<{ messages: SessionMessageRow[]; nextAfterSeq: number | null }>;
}): Promise<SessionMessageRow[]> {
  const out: SessionMessageRow[] = [];
  let cursor = params.startAfterSeq;
  for (;;) {
    const page = await params.fetchPage(cursor);
    out.push(...page.messages);

    const nextAfterSeq = page.nextAfterSeq;
    if (typeof nextAfterSeq === 'number' && Number.isFinite(nextAfterSeq) && nextAfterSeq > cursor) {
      cursor = nextAfterSeq;
      continue;
    }
    break;
  }
  return out;
}

export async function fetchMessagesPage(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  afterSeq: number;
  limit?: number;
}): Promise<{ messages: SessionMessageRow[]; nextAfterSeq: number | null }> {
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : 500;
  const endpoint = `${params.baseUrl}/v1/sessions/${params.sessionId}/messages`;
  const url = new URL(endpoint);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('afterSeq', String(params.afterSeq));

  const res = await fetchJson<SessionMessagesPageResponse>(url.toString(), {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });

  if (res.status !== 200 || !Array.isArray(res.data?.messages)) {
    throw new Error(`Failed to fetch messages from ${endpoint} (status=${res.status})`);
  }

  const messages = (res.data.messages as unknown[]).map((row, index) =>
    parseSessionMessageRow(row, `${endpoint}#${index}`),
  );

  return { messages, nextAfterSeq: typeof res.data.nextAfterSeq === 'number' ? res.data.nextAfterSeq : null };
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
  return await paginateMessages({
    startAfterSeq: 0,
    fetchPage: async (afterSeq) => await fetchMessagesPage({ baseUrl, token, sessionId, afterSeq, limit: 500 }),
  });
}

export async function fetchMessagesSince(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  afterSeq: number;
}): Promise<SessionMessageRow[]> {
  return await paginateMessages({
    startAfterSeq: params.afterSeq,
    fetchPage: async (afterSeq) =>
      await fetchMessagesPage({
        baseUrl: params.baseUrl,
        token: params.token,
        sessionId: params.sessionId,
        afterSeq,
        limit: 500,
      }),
  });
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

function parseSessionV2ListRow(value: unknown, context: string): SessionV2ListRow {
  if (!isRecord(value)) throw new Error(`Invalid v2 session row shape (${context})`);
  const id = value.id;
  const seq = value.seq;
  const metadata = value.metadata;
  const metadataVersion = value.metadataVersion;
  const agentState = value.agentState;
  const agentStateVersion = value.agentStateVersion;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  const active = value.active;
  const activeAt = value.activeAt;
  const dataEncryptionKey = value.dataEncryptionKey;
  const share = value.share;

  if (typeof id !== 'string' || id.length === 0) throw new Error(`Invalid v2 session id (${context})`);
  if (typeof seq !== 'number' || !Number.isFinite(seq)) throw new Error(`Invalid v2 session seq (${context})`);
  if (typeof metadata !== 'string') throw new Error(`Invalid v2 session metadata (${context})`);
  if (typeof metadataVersion !== 'number' || !Number.isFinite(metadataVersion)) {
    throw new Error(`Invalid v2 session metadataVersion (${context})`);
  }
  if (!(agentState === null || typeof agentState === 'string')) throw new Error(`Invalid v2 session agentState (${context})`);
  if (typeof agentStateVersion !== 'number' || !Number.isFinite(agentStateVersion)) {
    throw new Error(`Invalid v2 session agentStateVersion (${context})`);
  }
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) throw new Error(`Invalid v2 session createdAt (${context})`);
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) throw new Error(`Invalid v2 session updatedAt (${context})`);
  if (typeof active !== 'boolean') throw new Error(`Invalid v2 session active (${context})`);
  if (typeof activeAt !== 'number' || !Number.isFinite(activeAt)) throw new Error(`Invalid v2 session activeAt (${context})`);
  if (!(dataEncryptionKey === null || typeof dataEncryptionKey === 'string')) {
    throw new Error(`Invalid v2 session dataEncryptionKey (${context})`);
  }
  if (
    !(
      share === null ||
      (isRecord(share) && typeof share.accessLevel === 'string' && typeof share.canApprovePermissions === 'boolean')
    )
  ) {
    throw new Error(`Invalid v2 session share (${context})`);
  }

  return {
    id,
    seq,
    metadata,
    metadataVersion,
    agentState,
    agentStateVersion,
    createdAt,
    updatedAt,
    active,
    activeAt,
    dataEncryptionKey,
    share: share as { accessLevel: string; canApprovePermissions: boolean } | null,
  };
}

export async function fetchSessionsV2(baseUrl: string, token: string, opts?: { cursor?: string; limit?: number }): Promise<{
  sessions: SessionV2ListRow[];
  nextCursor: string | null;
  hasNext: boolean;
}> {
  const endpoint = `${baseUrl}/v2/sessions`;
  const url = new URL(endpoint);
  if (typeof opts?.cursor === 'string') url.searchParams.set('cursor', opts.cursor);
  if (typeof opts?.limit === 'number' && Number.isFinite(opts.limit)) url.searchParams.set('limit', String(opts.limit));

  const res = await fetchJson<SessionsV2Response>(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 20_000,
  });
  const sessions = res.data?.sessions;
  if (res.status !== 200 || !Array.isArray(sessions)) {
    throw new Error(`Failed to fetch v2 sessions from ${endpoint} (status=${res.status})`);
  }
  const parsedSessions = sessions.map((session, index) => parseSessionV2ListRow(session, `${endpoint}#${index}`));
  return {
    sessions: parsedSessions,
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
