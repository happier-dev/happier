import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { waitFor } from '../../src/testkit/timing';
import { countNewMessageUpdatesWithLocalId } from '../../src/testkit/updates';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: socket message idempotency', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('resending the same localId returns an ACK but does not rebroadcast a second new-message update', async () => {
    const testDir = run.testDir('messages-socket-idempotency-no-rebroadcast');
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
      testName: 'messages-socket-idempotency-no-rebroadcast',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('sender.events.json', () => sender.getEvents());
    artifacts.json('observer.events.json', () => observer.getEvents());

    let passed = false;
    try {
      sender.connect();
      observer.connect();
      await waitFor(() => sender.isConnected() && observer.isConnected(), { timeoutMs: 20_000 });

      const localId = randomUUID();
      const ciphertext = Buffer.from('idem', 'utf8').toString('base64');

      const raw1 = await sender.emitWithAck<any>('message', { sid: sessionId, message: ciphertext, localId });
      const ack1 = MessageAckResponseSchema.parse(raw1);
      expect(ack1.ok).toBe(true);
      if (ack1.ok === true) {
        expect(ack1.didWrite).toBe(true);
      }

      await waitFor(() => countNewMessageUpdatesWithLocalId(observer.getEvents(), localId) === 1, { timeoutMs: 20_000 });

      const raw2 = await sender.emitWithAck<any>('message', { sid: sessionId, message: ciphertext, localId });
      const ack2 = MessageAckResponseSchema.parse(raw2);
      expect(ack2.ok).toBe(true);
      if (ack1.ok === true && ack2.ok === true) {
        // For idempotent duplicates, seq should match the original.
        expect(ack2.seq).toBe(ack1.seq);
        expect(ack2.id).toBe(ack1.id);
        expect(ack2.didWrite).toBe(false);
      }

      // Send a different message as an event barrier, then confirm the original localId
      // was still only broadcast once.
      const barrierLocalId = randomUUID();
      const barrierCiphertext = Buffer.from('idem-barrier', 'utf8').toString('base64');
      const raw3 = await sender.emitWithAck<any>('message', { sid: sessionId, message: barrierCiphertext, localId: barrierLocalId });
      const ack3 = MessageAckResponseSchema.parse(raw3);
      expect(ack3.ok).toBe(true);
      await waitFor(() => countNewMessageUpdatesWithLocalId(observer.getEvents(), barrierLocalId) === 1, { timeoutMs: 20_000 });
      expect(countNewMessageUpdatesWithLocalId(observer.getEvents(), localId)).toBe(1);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      sender.close();
      observer.close();
    }
  });
});
