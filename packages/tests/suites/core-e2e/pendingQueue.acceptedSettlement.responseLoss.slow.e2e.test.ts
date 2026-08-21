import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createTestAuth } from '../../src/testkit/auth';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import { createSession, fetchAllMessages, fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: accepted settlement survives a committed socket ACK loss', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('replays the same socket transaction without committing the prompt twice', async () => {
    const testDir = run.testDir('pending-queue-accepted-settlement-socket-ack-loss');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);
    const { socket } = await createMachineBoundSessionScopedSocketCollector({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
    });

    try {
      socket.connect();
      await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });
      socket.emit('session-alive', { sid: sessionId, time: Date.now(), thinking: false });
      await waitFor(async () => (await fetchSessionV2(server!.baseUrl, auth.token, sessionId)).active === true, {
        timeoutMs: 20_000,
        context: 'machine-bound session publisher registration',
      });

      const localId = `accepted-response-loss-${randomUUID()}`;
      const enqueue = await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId,
        ciphertext: Buffer.from('accepted response loss', 'utf8').toString('base64'),
        timeoutMs: 20_000,
      });
      expect(enqueue.status).toBe(200);

      const materialized = await socket.emitWithAck<any>('pending-materialize-next', {
        sid: sessionId,
        deliveryState: 'provider',
        deliveryTiming: 'after_foreground_ready',
        foregroundState: 'ready',
      }, 20_000);
      expect(materialized).toMatchObject({
        ok: true,
        didMaterialize: true,
        message: { localId },
      });

      // Deliberately omit the callback. The server commits, but this publisher observes no ACK.
      socket.emit('pending-delivery-accepted-v1', { v: 1, sessionId, localId });
      await waitFor(async () => {
        const pending = await listPendingQueueV2({
          baseUrl: server!.baseUrl,
          token: auth.token,
          sessionId,
          includeDiscarded: true,
          timeoutMs: 20_000,
        });
        return pending.status === 200 && pending.data.pending?.every((row) => row.localId !== localId) === true;
      }, { timeoutMs: 20_000, context: 'callback-less socket settlement commits' });

      const replay = await socket.emitWithAck<any>('pending-delivery-accepted-v1', {
        v: 1,
        sessionId,
        localId,
      }, 20_000);
      expect(replay).toMatchObject({
        ok: true,
        didResolve: false,
        pendingCount: 0,
      });

      const transcript = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      expect(transcript.filter((message) => message.localId === localId)).toHaveLength(1);
    } finally {
      socket.close();
    }
  }, 90_000);
});
