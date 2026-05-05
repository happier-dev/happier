import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector, type CapturedEvent } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type MessageCreateResponse = Readonly<{
  didWrite?: boolean;
  message?: Readonly<{ id?: string; seq?: number; localId?: string | null }>;
}>;

type ReadStateResponse = Readonly<{
  success?: boolean;
  state?: 'read' | 'unread';
  lastViewedSessionSeq?: number | null;
  didChange?: boolean;
}>;

type SessionReadStateSnapshot = Readonly<{
  seq: number;
  lastViewedSessionSeq: number | null;
}>;

function findReadCursorUpdateEvent(
  events: readonly CapturedEvent[],
  sessionId: string,
  lastViewedSessionSeq: number,
): CapturedEvent | null {
  for (const event of events) {
    if (event.kind !== 'update') continue;
    const body = event.payload.body;
    if (body?.t !== 'update-session') continue;
    const sid = typeof body.sid === 'string' ? body.sid : typeof body.id === 'string' ? body.id : null;
    if (sid !== sessionId) continue;
    if (body.lastViewedSessionSeq === lastViewedSessionSeq) return event;
  }
  return null;
}

async function postEncryptedMessage(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<number> {
  const localId = randomUUID();
  const ciphertext = Buffer.from(`manual-read-state:${localId}`, 'utf8').toString('base64');
  const res = await fetchJson<MessageCreateResponse>(`${params.baseUrl}/v2/sessions/${params.sessionId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ciphertext, localId }),
    timeoutMs: 20_000,
  });

  const seq = res.data?.message?.seq;
  expect(res.status).toBe(200);
  expect(res.data?.didWrite).toBe(true);
  expect(res.data?.message?.localId).toBe(localId);
  expect(typeof seq).toBe('number');
  return seq ?? 0;
}

async function postReadState(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  state: 'read' | 'unread';
}>): Promise<ReadStateResponse> {
  const res = await fetchJson<ReadStateResponse>(`${params.baseUrl}/v2/sessions/${params.sessionId}/read-state`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state: params.state }),
    timeoutMs: 20_000,
  });

  expect(res.status).toBe(200);
  expect(res.data?.success).toBe(true);
  expect(res.data?.state).toBe(params.state);
  return res.data ?? {};
}

async function fetchSessionReadState(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<SessionReadStateSnapshot> {
  const res = await fetchJson<{
    session?: Readonly<{ seq?: unknown; lastViewedSessionSeq?: unknown }>;
  }>(`${params.baseUrl}/v2/sessions/${params.sessionId}`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 15_000,
  });

  expect(res.status).toBe(200);
  const seq = res.data?.session?.seq;
  const lastViewedSessionSeq = res.data?.session?.lastViewedSessionSeq;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) {
    throw new Error('v2 session response did not include numeric seq');
  }
  if (!(lastViewedSessionSeq === null || typeof lastViewedSessionSeq === 'number')) {
    throw new Error('v2 session response did not include nullable lastViewedSessionSeq');
  }
  return { seq, lastViewedSessionSeq };
}

async function fetchBadgeCount(baseUrl: string, token: string): Promise<number> {
  const res = await fetchJson<{ badgeCount?: unknown }>(`${baseUrl}/v1/account/activity/badge-snapshot`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
  });
  expect(res.status).toBe(200);
  const badgeCount = res.data?.badgeCount;
  if (typeof badgeCount !== 'number' || !Number.isFinite(badgeCount)) {
    throw new Error('badge snapshot did not include numeric badgeCount');
  }
  return badgeCount;
}

describe('core e2e: manual session read-state actions', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('marks a real session unread and read through the v2 route', async () => {
    const testDir = run.testDir('session-read-state-manual');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'session-read-state-manual',
      sessionIds: [sessionId],
      env: {},
    });

    const userSocket = createUserScopedSocketCollector(server.baseUrl, auth.token);

    try {
      userSocket.connect();
      await waitFor(() => userSocket.isConnected(), { timeoutMs: 20_000 });

      const committedSeq = await postEncryptedMessage({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });

      const read = await postReadState({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        state: 'read',
      });
      expect(read.lastViewedSessionSeq).toBe(committedSeq);
      expect(read.didChange).toBe(true);
      await waitFor(() => findReadCursorUpdateEvent(userSocket.getEvents(), sessionId, committedSeq) !== null, {
        timeoutMs: 20_000,
      });
      expect(await fetchSessionReadState({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      })).toEqual({ seq: committedSeq, lastViewedSessionSeq: committedSeq });
      expect(await fetchBadgeCount(server.baseUrl, auth.token)).toBe(0);

      const unread = await postReadState({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        state: 'unread',
      });
      const unreadCursor = Math.max(0, committedSeq - 1);
      expect(unread.lastViewedSessionSeq).toBe(unreadCursor);
      expect(unread.didChange).toBe(true);
      await waitFor(() => findReadCursorUpdateEvent(userSocket.getEvents(), sessionId, unreadCursor) !== null, {
        timeoutMs: 20_000,
      });
      expect(await fetchSessionReadState({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      })).toEqual({ seq: committedSeq, lastViewedSessionSeq: unreadCursor });
      expect(await fetchBadgeCount(server.baseUrl, auth.token)).toBe(1);

      const readAgain = await postReadState({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        state: 'read',
      });
      expect(readAgain.lastViewedSessionSeq).toBe(committedSeq);
      expect(readAgain.didChange).toBe(true);
      expect(await fetchSessionReadState({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      })).toEqual({ seq: committedSeq, lastViewedSessionSeq: committedSeq });
      expect(await fetchBadgeCount(server.baseUrl, auth.token)).toBe(0);
    } finally {
      userSocket.close();
    }
  }, 120_000);
});
