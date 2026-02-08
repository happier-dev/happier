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

describe('core e2e: socket message ACK schema contract', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('validates message ACK using shared protocol schema', async () => {
    const testDir = run.testDir('messages-socket-ack-schema');
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
      testName: 'messages-socket-ack-schema',
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

      const ciphertext = Buffer.from('hello', 'utf8').toString('base64');
      const localId = randomUUID();
      const rawAck = await socket.emitWithAck<any>('message', { sid: sessionId, message: ciphertext, localId });

      const parsed = MessageAckResponseSchema.safeParse(rawAck);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      if (parsed.data.ok === true) {
        expect(typeof parsed.data.id).toBe('string');
        expect(typeof parsed.data.seq).toBe('number');
        expect(Number.isInteger(parsed.data.seq)).toBe(true);
        expect(parsed.data.seq).toBeGreaterThanOrEqual(0);
        expect(parsed.data.didWrite === undefined || typeof parsed.data.didWrite === 'boolean').toBe(true);
      } else {
        expect(typeof parsed.data.error).toBe('string');
      }

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      socket.close();
    }
  });
});
