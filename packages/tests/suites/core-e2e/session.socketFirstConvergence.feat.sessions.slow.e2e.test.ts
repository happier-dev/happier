import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchChanges, fetchCursor, type AccountChangeRow } from '../../src/testkit/changes';
import { envFlag } from '../../src/testkit/env';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { fetchJson } from '../../src/testkit/http';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession, fetchSessionV2, fetchSessionsV2, type SessionV2ListRow } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector, type CapturedEvent } from '../../src/testkit/socketClient';
import { addFriend, fetchAccountId, setUsername } from '../../src/testkit/socialFriends';
import { waitFor } from '../../src/testkit/timing';
import { findPendingChangedUpdateAfter, type PendingChangedUpdateBody } from '../../src/testkit/updates';

const run = createRunDirs({ runLabel: 'core' });

function requireNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected numeric ${context}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePendingChangedActivity(body: PendingChangedUpdateBody): number {
  return requireNumber(body.meaningfulActivityAt, 'pending-changed.meaningfulActivityAt');
}

function requireSessionChangeHint(change: AccountChangeRow): {
  pendingCount: number;
  pendingVersion: number;
  meaningfulActivityAt: number;
} {
  const hint = change.hint;
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) {
    throw new Error(`Expected session change hint object, got ${JSON.stringify(hint)}`);
  }
  const record = hint as Record<string, unknown>;
  return {
    pendingCount: requireNumber(record.pendingCount, 'change.hint.pendingCount'),
    pendingVersion: requireNumber(record.pendingVersion, 'change.hint.pendingVersion'),
    meaningfulActivityAt: requireNumber(record.meaningfulActivityAt, 'change.hint.meaningfulActivityAt'),
  };
}

function findSessionChange(changes: readonly AccountChangeRow[], sessionId: string): AccountChangeRow {
  const matches = changes.filter((change) => change.kind === 'session' && change.entityId === sessionId);
  const latest = matches[matches.length - 1];
  if (!latest) {
    throw new Error(`Expected /v2/changes session row for ${sessionId}`);
  }
  return latest;
}

function findSessionRow(rows: readonly SessionV2ListRow[], sessionId: string): SessionV2ListRow {
  const row = rows.find((session) => session.id === sessionId);
  if (!row) {
    throw new Error(`Expected /v2/sessions row for ${sessionId}`);
  }
  return row;
}

function findUpdateSessionAfter(params: {
  events: CapturedEvent[];
  sessionId: string;
  afterIndex: number;
}): Record<string, unknown> | null {
  const slice = params.events.slice(Math.max(0, params.afterIndex));
  for (const event of slice) {
    if (event.kind !== 'update') continue;
    const body = event.payload?.body;
    if (!body || typeof body !== 'object') continue;
    const record = body as Record<string, unknown>;
    if (record.t !== 'update-session') continue;
    if (record.id !== params.sessionId && record.sid !== params.sessionId) continue;
    return record;
  }
  return null;
}

function findShareUpdateAfter(params: {
  events: CapturedEvent[];
  sessionId: string;
  type: 'session-shared' | 'session-share-updated';
  afterIndex: number;
}): Record<string, unknown> | null {
  const slice = params.events.slice(Math.max(0, params.afterIndex));
  for (const event of slice) {
    if (event.kind !== 'update') continue;
    const body = event.payload?.body;
    if (!body || typeof body !== 'object') continue;
    const record = body as Record<string, unknown>;
    if (record.t !== params.type) continue;
    if (record.sessionId !== params.sessionId && record.sid !== params.sessionId) continue;
    return record;
  }
  return null;
}

async function createPlainSharedSessionFixture(server: StartedServer): Promise<{
  owner: Awaited<ReturnType<typeof createTestAuth>>;
  recipient: Awaited<ReturnType<typeof createTestAuth>>;
  recipientId: string;
  sessionId: string;
}> {
  const owner = await createTestAuth(server.baseUrl);
  const recipient = await createTestAuth(server.baseUrl);
  const ownerId = await fetchAccountId(server.baseUrl, owner.token);
  const recipientId = await fetchAccountId(server.baseUrl, recipient.token);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

  await setUsername(server.baseUrl, owner.token, `owner_${suffix}`);
  await setUsername(server.baseUrl, recipient.token, `recipient_${suffix}`);
  await addFriend(server.baseUrl, owner.token, recipientId);
  await addFriend(server.baseUrl, recipient.token, ownerId);

  const patchMode = await fetchJson<{ mode?: string }>(`${server.baseUrl}/v1/account/encryption`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode: 'plain' }),
    timeoutMs: 15_000,
  });
  expect(patchMode.status).toBe(200);
  expect(patchMode.data?.mode).toBe('plain');

  const create = await fetchJson<{ session?: { id?: string; encryptionMode?: string } }>(`${server.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag: `socket-first-share-${suffix}`,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ v: 1, path: '/tmp', flavor: 'claude' }),
      agentState: null,
      dataEncryptionKey: null,
    }),
    timeoutMs: 15_000,
  });
  expect(create.status).toBe(200);
  expect(create.data?.session?.encryptionMode).toBe('plain');
  const sessionId = create.data?.session?.id;
  if (typeof sessionId !== 'string') {
    throw new Error('Expected created plaintext session id');
  }

  return { owner, recipient, recipientId, sessionId };
}

describe('core e2e: socket-first session convergence contract', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('emits a self-sufficient pending-changed payload for list ordering after pending enqueue', async () => {
    const testDir = run.testDir('session-socket-first-pending-changed-activity');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);
    const socket = createUserScopedSocketCollector(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'session-socket-first-pending-changed-activity',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('socket.events.json', () => socket.getEvents());
    artifacts.json('sessions.v2.json', async () => await fetchSessionsV2(server!.baseUrl, auth.token, { limit: 25 }));

    let passed = false;
    try {
      socket.connect();
      await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });

      const afterIndex = socket.getEvents().length;
      const localId = randomUUID();
      const enqueue = await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId,
        ciphertext: Buffer.from('socket-first-pending-activity', 'utf8').toString('base64'),
        timeoutMs: 20_000,
      });
      expect(enqueue.status).toBe(200);

      const pendingChangedRef: { current: PendingChangedUpdateBody | null } = { current: null };
      await waitFor(() => {
        pendingChangedRef.current = findPendingChangedUpdateAfter({ events: socket.getEvents(), sessionId, afterIndex });
        return pendingChangedRef.current?.pendingCount === 1;
      }, { timeoutMs: 20_000 });

      const pendingChanged = pendingChangedRef.current;
      if (!pendingChanged) {
        throw new Error('Expected pending-changed update after enqueue');
      }
      const activityAt = requirePendingChangedActivity(pendingChanged);
      const sessions = await fetchSessionsV2(server.baseUrl, auth.token, { limit: 25 });
      const row = findSessionRow(sessions.sessions, sessionId);

      expect(pendingChanged.pendingVersion).toBe(row.pendingVersion);
      expect(pendingChanged.pendingCount).toBe(row.pendingCount);
      expect(activityAt).toBe(row.meaningfulActivityAt);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      socket.close();
    }
  }, 180_000);

  it('lets a missed pending-changed event converge from /v2/changes without a session-detail read', async () => {
    const testDir = run.testDir('session-socket-first-missed-pending-changed-cursor');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'session-socket-first-missed-pending-changed-cursor',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('changes.json', async () => await fetchChanges(server!.baseUrl, auth.token, { after: 0 }));
    artifacts.json('sessions.v2.json', async () => await fetchSessionsV2(server!.baseUrl, auth.token, { limit: 25 }));

    let passed = false;
    try {
      const initialRows = await fetchSessionsV2(server.baseUrl, auth.token, { limit: 25 });
      const initialRow = findSessionRow(initialRows.sessions, sessionId);
      const cursor0 = await fetchCursor(server.baseUrl, auth.token);

      const localId = randomUUID();
      const enqueue = await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId,
        ciphertext: Buffer.from('missed-pending-changed-cursor', 'utf8').toString('base64'),
        timeoutMs: 20_000,
      });
      expect(enqueue.status).toBe(200);

      const changes = await fetchChanges(server.baseUrl, auth.token, { after: cursor0.cursor });
      const sessionChange = findSessionChange(changes.changes, sessionId);
      const hint = requireSessionChangeHint(sessionChange);

      const finalRows = await fetchSessionsV2(server.baseUrl, auth.token, { limit: 25 });
      const finalRow = findSessionRow(finalRows.sessions, sessionId);

      expect(changes.nextCursor).toBeGreaterThanOrEqual(sessionChange.cursor);
      expect(hint.pendingCount).toBe(1);
      expect(hint.pendingVersion).toBeGreaterThan(initialRow.pendingVersion ?? 0);
      expect(hint.pendingCount).toBe(finalRow.pendingCount);
      expect(hint.pendingVersion).toBe(finalRow.pendingVersion);
      expect(hint.meaningfulActivityAt).toBe(finalRow.meaningfulActivityAt);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  }, 180_000);

  it('emits share permission capability to the recipient socket and list projection', async () => {
    const testDir = run.testDir('session-socket-first-share-can-approve');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '1',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: '1',
      },
    });
    const { owner, recipient, recipientId, sessionId } = await createPlainSharedSessionFixture(server);
    const recipientSocket = createUserScopedSocketCollector(server.baseUrl, recipient.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'session-socket-first-share-can-approve',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('recipient.socket.events.json', () => recipientSocket.getEvents());
    artifacts.json('recipient.sessions.v2.json', async () => await fetchSessionsV2(server!.baseUrl, recipient.token, { limit: 25 }));

    let passed = false;
    try {
      recipientSocket.connect();
      await waitFor(() => recipientSocket.isConnected(), { timeoutMs: 20_000 });

      const shareStart = recipientSocket.getEvents().length;
      const share = await fetchJson<{ share?: { id?: string; accessLevel?: string; canApprovePermissions?: boolean } }>(
        `${server.baseUrl}/v1/sessions/${sessionId}/shares`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${owner.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId: recipientId,
            accessLevel: 'edit',
            canApprovePermissions: false,
          }),
          timeoutMs: 15_000,
        },
      );
      expect(share.status).toBe(200);
      const shareId = share.data?.share?.id;
      if (typeof shareId !== 'string') {
        throw new Error('Expected created share id');
      }

      const sharedUpdateRef: { current: Record<string, unknown> | null } = { current: null };
      await waitFor(() => {
        sharedUpdateRef.current = findShareUpdateAfter({
          events: recipientSocket.getEvents(),
          sessionId,
          type: 'session-shared',
          afterIndex: shareStart,
        });
        return sharedUpdateRef.current?.shareId === shareId && sharedUpdateRef.current?.canApprovePermissions === false;
      }, { timeoutMs: 20_000 });
      const sharedUpdate = sharedUpdateRef.current;
      if (!sharedUpdate) throw new Error('Expected session-shared update');
      expect(sharedUpdate?.accessLevel).toBe('edit');

      const updateStart = recipientSocket.getEvents().length;
      const update = await fetchJson<{ share?: { accessLevel?: string; canApprovePermissions?: boolean } }>(
        `${server.baseUrl}/v1/sessions/${sessionId}/shares/${shareId}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${owner.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ canApprovePermissions: true }),
          timeoutMs: 15_000,
        },
      );
      expect(update.status).toBe(200);

      const updatedShareRef: { current: Record<string, unknown> | null } = { current: null };
      await waitFor(() => {
        updatedShareRef.current = findShareUpdateAfter({
          events: recipientSocket.getEvents(),
          sessionId,
          type: 'session-share-updated',
          afterIndex: updateStart,
        });
        return updatedShareRef.current?.shareId === shareId && updatedShareRef.current?.canApprovePermissions === true;
      }, { timeoutMs: 20_000 });
      const updatedShare = updatedShareRef.current;
      if (!updatedShare) throw new Error('Expected session-share-updated update');
      expect(updatedShare?.accessLevel).toBe('edit');

      const sessions = await fetchSessionsV2(server.baseUrl, recipient.token, { limit: 25 });
      const row = findSessionRow(sessions.sessions, sessionId);
      expect(row.share).toEqual({ accessLevel: 'edit', canApprovePermissions: true });

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      recipientSocket.close();
    }
  }, 180_000);

  it('acknowledges socket session-end to the sender while broadcasting durable inactive state to other sockets', async () => {
    const testDir = run.testDir('session-socket-first-session-end-ack');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);
    const sender = createUserScopedSocketCollector(server.baseUrl, auth.token);
    const observer = createUserScopedSocketCollector(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'session-socket-first-session-end-ack',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('sender.events.json', () => sender.getEvents());
    artifacts.json('observer.events.json', () => observer.getEvents());
    artifacts.json('session.v2.json', async () => await fetchSessionV2(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    try {
      sender.connect();
      observer.connect();
      await waitFor(() => sender.isConnected() && observer.isConnected(), { timeoutMs: 20_000 });

      const senderStart = sender.getEvents().length;
      const observerStart = observer.getEvents().length;
      const observedAt = Date.now();
      const ack = await sender.emitWithAck<{
        ok?: unknown;
        applied?: unknown;
        active?: unknown;
        activeAt?: unknown;
      }>('session-end', { sid: sessionId, time: observedAt }, 20_000);

      expect(ack.ok).toBe(true);
      expect(ack.applied).toBe(true);
      expect(ack.active).toBe(false);
      expect(ack.activeAt).toBe(observedAt);

      let observerUpdate: Record<string, unknown> | null = null;
      await waitFor(() => {
        observerUpdate = findUpdateSessionAfter({ events: observer.getEvents(), sessionId, afterIndex: observerStart });
        return observerUpdate?.active === false && observerUpdate?.activeAt === observedAt;
      }, { timeoutMs: 20_000 });

      const senderEcho = findUpdateSessionAfter({ events: sender.getEvents(), sessionId, afterIndex: senderStart });
      expect(senderEcho).toBeNull();

      const session = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      expect(session.active).toBe(false);
      expect(session.activeAt).toBe(observedAt);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      sender.close();
      observer.close();
    }
  }, 180_000);
});
