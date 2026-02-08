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

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: socket message ACK includes didWrite', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('returns didWrite=true on first commit and didWrite=false on idempotent duplicate', async () => {
    const testDir = run.testDir('messages-socket-ack-didwrite');
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
      testName: 'messages-socket-ack-didwrite',
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
      const ciphertext = Buffer.from('didWrite', 'utf8').toString('base64');

      const raw1 = await socket.emitWithAck<any>('message', { sid: sessionId, message: ciphertext, localId });
      const ack1 = MessageAckResponseSchema.parse(raw1);
      expect(ack1.ok).toBe(true);
      if (ack1.ok === true) expect(ack1.didWrite).toBe(true);

      const raw2 = await socket.emitWithAck<any>('message', { sid: sessionId, message: ciphertext, localId });
      const ack2 = MessageAckResponseSchema.parse(raw2);
      expect(ack2.ok).toBe(true);
      if (ack2.ok === true) expect(ack2.didWrite).toBe(false);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      socket.close();
    }
  });
});
