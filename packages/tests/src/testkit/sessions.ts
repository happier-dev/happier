import { randomUUID } from 'node:crypto';

import { fetchJson } from './http';

export async function createSession(baseUrl: string, token: string): Promise<{ sessionId: string; tag: string }> {
  const tag = `e2e-${randomUUID()}`;
  const metadata = Buffer.from(JSON.stringify({ v: 1, tag, createdAt: Date.now() }), 'utf8').toString('base64');

  const res = await fetchJson<{ session?: { id?: string } }>(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tag, metadata, agentState: null }),
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
    const url = new URL(`${baseUrl}/v1/sessions/${sessionId}/messages`);
    url.searchParams.set('limit', '500');
    url.searchParams.set('afterSeq', String(afterSeq));

    const res = await fetchJson<{ messages?: SessionMessageRow[]; nextAfterSeq?: number | null }>(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 20_000,
    });

    if (res.status !== 200 || !Array.isArray(res.data?.messages)) {
      throw new Error(`Failed to fetch messages (status=${res.status})`);
    }

    const messages = res.data.messages;
    out.push(...messages);

    const nextAfterSeq = res.data.nextAfterSeq;
    if (typeof nextAfterSeq === 'number' && Number.isFinite(nextAfterSeq) && nextAfterSeq > afterSeq) {
      afterSeq = nextAfterSeq;
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
