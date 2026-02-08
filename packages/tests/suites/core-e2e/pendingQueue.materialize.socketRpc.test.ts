import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchAllMessages, fetchSessionV2 } from '../../src/testkit/sessions';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { createSessionScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { enqueuePendingQueueV2, listPendingQueueV2, reorderPendingQueueV2 } from '../../src/testkit/pendingQueueV2';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: pending queue v2 materialize via socket RPC', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('materializes queued items in order and clears pendingCount', async () => {
    const testDir = run.testDir('pending-queue-v2-materialize-socket-rpc');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const socket = createSessionScopedSocketCollector(server.baseUrl, auth.token, sessionId);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'pending-queue-v2-materialize-socket-rpc',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('socket.events.json', () => socket.getEvents());
    artifacts.json('pending.list.json', async () => {
      return await listPendingQueueV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId, includeDiscarded: true });
    });
    artifacts.json('transcript.json', async () => await fetchAllMessages(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    try {
      socket.connect();
      await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });

      const localIds = [randomUUID(), randomUUID(), randomUUID()];
      for (const localId of localIds) {
        const ciphertext = Buffer.from(`pending:${localId}`, 'utf8').toString('base64');
        const res = await enqueuePendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, localId, ciphertext, timeoutMs: 20_000 });
        expect(res.status).toBe(200);
      }

      // Reverse order to ensure we respect `position`.
      const expected = [...localIds].reverse();
      const reorder = await reorderPendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, orderedLocalIds: expected, timeoutMs: 20_000 });
      expect(reorder.status).toBe(200);

      const materialized: string[] = [];
      for (;;) {
        const ack = await socket.emitWithAck<any>('pending-materialize-next', { sid: sessionId }, 20_000);
        expect(ack && typeof ack === 'object').toBe(true);
        if (ack?.ok !== true) {
          throw new Error(`pending-materialize-next failed: ${typeof ack?.error === 'string' ? ack.error : 'unknown'}`);
        }
        if (ack.didMaterialize !== true) break;
        if (typeof ack?.message?.localId !== 'string') {
          throw new Error('pending-materialize-next ack missing message.localId');
        }
        materialized.push(ack.message.localId);
      }

      expect(materialized).toEqual(expected);

      const transcript = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      expect(transcript.map((m) => m.localId)).toEqual(expected);

      const pending = await listPendingQueueV2({ baseUrl: server.baseUrl, token: auth.token, sessionId, includeDiscarded: true });
      expect(pending.status).toBe(200);
      expect(pending.data.pending?.length ?? 0).toBe(0);

      const snap: any = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      expect(snap.pendingCount).toBe(0);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      socket.close();
    }
  });
});
