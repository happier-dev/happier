import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

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
import { hasNewMessageUpdateWithLocalId } from '../../src/testkit/updates';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: HTTP v2 message create emits socket updates', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('posting /v2/sessions/:id/messages commits and broadcasts to connected sockets', async () => {
    const testDir = run.testDir('messages-http-v2messages-emits-socket-updates');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const socketA = createUserScopedSocketCollector(server.baseUrl, auth.token);
    const socketB = createUserScopedSocketCollector(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'messages-http-v2messages-emits-socket-updates',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('socketA.events.json', () => socketA.getEvents());
    artifacts.json('socketB.events.json', () => socketB.getEvents());
    artifacts.json('transcript.json', async () => await fetchAllMessages(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    try {
      socketA.connect();
      socketB.connect();
      await waitFor(() => socketA.isConnected() && socketB.isConnected(), { timeoutMs: 20_000 });

      const localId = randomUUID();
      const ciphertext = Buffer.from('via-http', 'utf8').toString('base64');

      const res = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext, localId }),
        timeoutMs: 20_000,
      });
      expect(res.status).toBe(200);
      expect(res.data?.didWrite).toBe(true);
      expect(typeof res.data?.message?.id).toBe('string');
      expect(typeof res.data?.message?.seq).toBe('number');
      expect(res.data?.message?.localId).toBe(localId);

      await waitFor(() => hasNewMessageUpdateWithLocalId(socketA.getEvents(), localId), { timeoutMs: 20_000 });
      await waitFor(() => hasNewMessageUpdateWithLocalId(socketB.getEvents(), localId), { timeoutMs: 20_000 });

      const transcript = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      expect(transcript.some((m) => m.localId === localId)).toBe(true);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      socketA.close();
      socketB.close();
    }
  });
});
