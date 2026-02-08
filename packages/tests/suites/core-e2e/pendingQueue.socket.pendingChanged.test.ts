import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession } from '../../src/testkit/sessions';
import { createSessionScopedSocketCollector, createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { waitFor } from '../../src/testkit/timing';
import {
  deletePendingQueueV2,
  discardPendingQueueV2,
  enqueuePendingQueueV2,
  patchPendingQueueV2,
  reorderPendingQueueV2,
  restorePendingQueueV2,
} from '../../src/testkit/pendingQueueV2';

const run = createRunDirs({ runLabel: 'core' });

function findPendingChangedAfter(params: { events: any[]; sessionId: string; afterIndex: number }): any | null {
  const slice = params.events.slice(params.afterIndex);
  for (const e of slice) {
    if (e?.kind !== 'update') continue;
    const body = e?.payload?.body;
    if (body?.t !== 'pending-changed') continue;
    if (body?.sid !== params.sessionId && body?.sessionId !== params.sessionId) continue;
    return body;
  }
  return null;
}

describe('core e2e: pending queue v2 emits pending-changed socket updates', () => {
  it('broadcasts pending-changed to connected sockets on enqueue', async () => {
    const testDir = run.testDir('pending-queue-v2-socket-pending-changed');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    const server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const socket = createUserScopedSocketCollector(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-v2-socket-pending-changed',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('socket.events.json', () => socket.getEvents());

    let passed = false;
    try {
      socket.connect();
      await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });

      const localId = randomUUID();
      const ciphertext = Buffer.from('pending-for-socket', 'utf8').toString('base64');

      const start0 = socket.getEvents().length;
      const enqueue = await enqueuePendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, localId, ciphertext, timeoutMs: 20_000 });
      expect(enqueue.status).toBe(200);

      await waitFor(() => {
        const body = findPendingChangedAfter({ events: socket.getEvents(), sessionId, afterIndex: start0 });
        return body?.pendingCount === 1;
      }, { timeoutMs: 20_000 });

      const start1 = socket.getEvents().length;
      const edit = await patchPendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, localId, ciphertext: Buffer.from('pending-edit', 'utf8').toString('base64') });
      expect(edit.status).toBe(200);
      await waitFor(() => {
        const body = findPendingChangedAfter({ events: socket.getEvents(), sessionId, afterIndex: start1 });
        return body?.pendingCount === 1;
      }, { timeoutMs: 20_000 });

      const start2 = socket.getEvents().length;
      const reorder = await reorderPendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, orderedLocalIds: [localId] });
      expect(reorder.status).toBe(200);
      await waitFor(() => {
        const body = findPendingChangedAfter({ events: socket.getEvents(), sessionId, afterIndex: start2 });
        return body?.pendingCount === 1;
      }, { timeoutMs: 20_000 });

      const start3 = socket.getEvents().length;
      const discard = await discardPendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, localId, reason: 'test' });
      expect(discard.status).toBe(200);
      await waitFor(() => {
        const body = findPendingChangedAfter({ events: socket.getEvents(), sessionId, afterIndex: start3 });
        return body?.pendingCount === 0;
      }, { timeoutMs: 20_000 });

      const start4 = socket.getEvents().length;
      const restore = await restorePendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, localId });
      expect(restore.status).toBe(200);
      await waitFor(() => {
        const body = findPendingChangedAfter({ events: socket.getEvents(), sessionId, afterIndex: start4 });
        return body?.pendingCount === 1;
      }, { timeoutMs: 20_000 });

      const start5 = socket.getEvents().length;
      const del = await deletePendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, localId });
      expect(del.status).toBe(200);
      await waitFor(() => {
        const body = findPendingChangedAfter({ events: socket.getEvents(), sessionId, afterIndex: start5 });
        return body?.pendingCount === 0;
      }, { timeoutMs: 20_000 });

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      socket.close();
      await server.stop();
    }
  });

  it('broadcasts pending-changed on materialize-next via socket RPC', async () => {
    const testDir = run.testDir('pending-queue-v2-socket-pending-changed.materialize');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    const server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const userSocket = createUserScopedSocketCollector(server.baseUrl, auth.token);
    const sessionSocket = createSessionScopedSocketCollector(server.baseUrl, auth.token, sessionId);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-v2-socket-pending-changed.materialize',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('user.socket.events.json', () => userSocket.getEvents());
    artifacts.json('session.socket.events.json', () => sessionSocket.getEvents());

    let passed = false;
    try {
      userSocket.connect();
      sessionSocket.connect();
      await waitFor(() => userSocket.isConnected() && sessionSocket.isConnected(), { timeoutMs: 20_000 });

      const localId = randomUUID();
      const ciphertext = Buffer.from('pending-materialize', 'utf8').toString('base64');
      const start0 = userSocket.getEvents().length;
      const enqueue = await enqueuePendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, localId, ciphertext, timeoutMs: 20_000 });
      expect(enqueue.status).toBe(200);
      await waitFor(() => {
        const body = findPendingChangedAfter({ events: userSocket.getEvents(), sessionId, afterIndex: start0 });
        return body?.pendingCount === 1;
      }, { timeoutMs: 20_000 });

      const start1 = userSocket.getEvents().length;
      const ack = await sessionSocket.emitWithAck<any>('pending-materialize-next', { sid: sessionId }, 20_000);
      expect(ack?.ok).toBe(true);
      expect(ack?.didMaterialize).toBe(true);
      await waitFor(() => {
        const body = findPendingChangedAfter({ events: userSocket.getEvents(), sessionId, afterIndex: start1 });
        return body?.pendingCount === 0;
      }, { timeoutMs: 20_000 });

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      userSocket.close();
      sessionSocket.close();
      await server.stop();
    }
  });
});
