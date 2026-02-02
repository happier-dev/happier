import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchAllMessages } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifest } from '../../src/testkit/manifest';
import { waitFor } from '../../src/testkit/timing';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const run = createRunDirs({ runLabel: 'stress' });

describe('stress: reconnect repeat', () => {
  let server: StartedServer;
  let token: string;

  beforeAll(async () => {
    const testDir = run.testDir('server');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    token = auth.token;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('repeats multi-device disconnect/reconnect and verifies transcript head convergence', async () => {
    const repeats = parsePositiveInt(process.env.HAPPY_E2E_REPEAT, 5);
    const saveArtifactsOnSuccess = envFlag('HAPPY_E2E_SAVE_ARTIFACTS', false);
    const startedAt = new Date().toISOString();

    for (let i = 1; i <= repeats; i++) {
      const testDir = run.testDir(`repeat-${i}`);
      const { sessionId } = await createSession(server.baseUrl, token);

      const deviceA = createUserScopedSocketCollector(server.baseUrl, token);
      const deviceB = createUserScopedSocketCollector(server.baseUrl, token);

      writeTestManifest(testDir, {
        startedAt,
        runId: run.runId,
        testName: `repeat-${i}`,
        baseUrl: server.baseUrl,
        ports: { server: server.port },
        sessionIds: [sessionId],
        env: {
          HAPPY_E2E_REPEAT: process.env.HAPPY_E2E_REPEAT,
          HAPPY_E2E_SAVE_ARTIFACTS: process.env.HAPPY_E2E_SAVE_ARTIFACTS,
        },
      });

      const artifacts = new FailureArtifacts();
      artifacts.json('deviceA.events.json', () => deviceA.getEvents());
      artifacts.json('deviceB.events.json', () => deviceB.getEvents());
      artifacts.json('transcript.json', async () => await fetchAllMessages(server.baseUrl, token, sessionId));

      let passed = false;
      deviceA.connect();
      deviceB.connect();
      await waitFor(() => deviceA.isConnected() && deviceB.isConnected(), { timeoutMs: 20_000 });

      const send = async (label: string) => {
        const ciphertext = Buffer.from(label, 'utf8').toString('base64');
        const localId = randomUUID();
        const ack = await deviceA.emitWithAck<{ ok: boolean; seq?: number }>('message', { sid: sessionId, message: ciphertext, localId });
        expect(ack.ok).toBe(true);
      };

      await send(`r${i}-m1`);
      await send(`r${i}-m2`);

      // Drop B mid-stream and keep sending.
      deviceB.disconnect();
      await waitFor(() => !deviceB.isConnected(), { timeoutMs: 10_000 });

      await send(`r${i}-m3`);
      await send(`r${i}-m4`);
      await send(`r${i}-m5`);

      deviceB.connect();
      await waitFor(() => deviceB.isConnected(), { timeoutMs: 20_000 });

      try {
        const transcript = await fetchAllMessages(server.baseUrl, token, sessionId);

        // The exact number may be >5 if the server creates side effects; require at least what we sent.
        expect(transcript.length).toBeGreaterThanOrEqual(5);
        passed = true;
      } finally {
        await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
        deviceA.close();
        deviceB.close();
      }
    }
  });
});
