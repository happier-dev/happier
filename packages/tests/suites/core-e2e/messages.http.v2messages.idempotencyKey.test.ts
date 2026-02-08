import { afterAll, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchAllMessages } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { countNewMessageUpdatesWithLocalId } from '../../src/testkit/updates';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: HTTP v2 message idempotency-key', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('uses Idempotency-Key as localId and does not rebroadcast on duplicate POSTs', async () => {
    const testDir = run.testDir('messages-http-v2messages-idempotency-key');
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
      testName: 'messages-http-v2messages-idempotency-key',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    let socketA: ReturnType<typeof createUserScopedSocketCollector> | null = null;
    let socketB: ReturnType<typeof createUserScopedSocketCollector> | null = null;
    artifacts.json('socketA.events.json', () => socketA?.getEvents() ?? []);
    artifacts.json('socketB.events.json', () => socketB?.getEvents() ?? []);
    artifacts.json('transcript.json', async () => await fetchAllMessages(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    try {
      socketA = createUserScopedSocketCollector(server.baseUrl, auth.token);
      socketB = createUserScopedSocketCollector(server.baseUrl, auth.token);
      const socketACollector = socketA;
      const socketBCollector = socketB;
      if (!socketACollector || !socketBCollector) {
        throw new Error('Socket collectors were not created');
      }
      socketACollector.connect();
      socketBCollector.connect();
      await waitFor(() => socketACollector.isConnected() && socketBCollector.isConnected(), { timeoutMs: 20_000 });

      const idempotencyKey = 'idem-key-1';
      const ciphertext = Buffer.from('via-http-idem', 'utf8').toString('base64');

      const postWithKey = async (idempotencyKey: string) => {
        return await fetchJson<any>(`${server!.baseUrl}/v2/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ ciphertext }),
          timeoutMs: 20_000,
        });
      };

      const res1 = await postWithKey(idempotencyKey);
      expect(res1.status).toBe(200);
      expect(res1.data?.didWrite).toBe(true);
      expect(res1.data?.message?.localId).toBe(idempotencyKey);

      await waitFor(() => countNewMessageUpdatesWithLocalId(socketACollector.getEvents(), idempotencyKey) === 1, { timeoutMs: 20_000 });
      await waitFor(() => countNewMessageUpdatesWithLocalId(socketBCollector.getEvents(), idempotencyKey) === 1, { timeoutMs: 20_000 });

      const res2 = await postWithKey(idempotencyKey);
      expect(res2.status).toBe(200);
      expect(res2.data?.didWrite).toBe(false);
      expect(res2.data?.message?.localId).toBe(idempotencyKey);

      const barrierKey = 'idem-key-2';
      const barrierRes = await postWithKey(barrierKey);
      expect(barrierRes.status).toBe(200);
      expect(barrierRes.data?.didWrite).toBe(true);
      expect(barrierRes.data?.message?.localId).toBe(barrierKey);
      await waitFor(() => countNewMessageUpdatesWithLocalId(socketACollector.getEvents(), barrierKey) === 1, { timeoutMs: 20_000 });
      await waitFor(() => countNewMessageUpdatesWithLocalId(socketBCollector.getEvents(), barrierKey) === 1, { timeoutMs: 20_000 });
      expect(countNewMessageUpdatesWithLocalId(socketACollector.getEvents(), idempotencyKey)).toBe(1);
      expect(countNewMessageUpdatesWithLocalId(socketBCollector.getEvents(), idempotencyKey)).toBe(1);

      const transcript = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      const matches = transcript.filter((m) => m.localId === idempotencyKey);
      expect(matches.length).toBe(1);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      socketA?.close();
      socketB?.close();
    }
  });
});
