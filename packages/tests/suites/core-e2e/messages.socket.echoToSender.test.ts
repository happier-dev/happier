import { afterAll, describe, expect, it } from 'vitest';
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
import { hasNewMessageUpdateWithLocalId } from '../../src/testkit/updates';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: socket message echoToSender', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('skips sender by default but delivers updates to sender when echoToSender=true', async () => {
    const testDir = run.testDir('messages-socket-echo-to-sender');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const agent = createSessionScopedSocketCollector(server.baseUrl, auth.token, sessionId);
    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'messages-socket-echo-to-sender',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('agent.events.json', () => agent.getEvents());
    artifacts.json('ui.events.json', () => ui.getEvents());

    let passed = false;
    try {
      agent.connect();
      ui.connect();
      await waitFor(() => agent.isConnected() && ui.isConnected(), { timeoutMs: 25_000 });

      const ciphertext = Buffer.from('hello', 'utf8').toString('base64');

      // Default: sender connection should not receive its own broadcast update.
      const localId1 = randomUUID();
      await agent.emitWithAck('message', { sid: sessionId, message: ciphertext, localId: localId1 });

      await waitFor(() => hasNewMessageUpdateWithLocalId(ui.getEvents(), localId1), { timeoutMs: 20_000 });
      expect(hasNewMessageUpdateWithLocalId(agent.getEvents(), localId1)).toBe(false);

      // With echoToSender=true: sender connection should also receive the update.
      const localId2 = randomUUID();
      await agent.emitWithAck('message', { sid: sessionId, message: ciphertext, localId: localId2, echoToSender: true });

      await waitFor(() => hasNewMessageUpdateWithLocalId(ui.getEvents(), localId2), { timeoutMs: 20_000 });
      await waitFor(() => hasNewMessageUpdateWithLocalId(agent.getEvents(), localId2), { timeoutMs: 20_000 });
      expect(hasNewMessageUpdateWithLocalId(agent.getEvents(), localId1)).toBe(false);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      agent.close();
      ui.close();
    }
  });
});
