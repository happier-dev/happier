import { afterAll, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchSessionV2, patchSessionAgentState } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifest } from '../../src/testkit/manifest';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: agentState patch + multi-device reconnect', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('device B reconnects and observes latest agentStateVersion via snapshot', async () => {
    const testDir = run.testDir('agentState-multi-device-reconnect');
    const saveArtifactsOnSuccess = envFlag('HAPPY_E2E_SAVE_ARTIFACTS', false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const deviceA = createUserScopedSocketCollector(server.baseUrl, auth.token);
    const deviceB = createUserScopedSocketCollector(server.baseUrl, auth.token);

    writeTestManifest(testDir, {
      startedAt,
      runId: run.runId,
      testName: 'agentState-multi-device-reconnect',
      baseUrl: server.baseUrl,
      ports: { server: server.port },
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPY_E2E_SAVE_ARTIFACTS: process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('deviceA.events.json', () => deviceA.getEvents());
    artifacts.json('deviceB.events.json', () => deviceB.getEvents());
    artifacts.json('session.v2.json', async () => await fetchSessionV2(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    try {
      deviceA.connect();
      deviceB.connect();
      await waitFor(() => deviceA.isConnected() && deviceB.isConnected(), { timeoutMs: 20_000 });

      const initial = await fetchSessionV2(server.baseUrl, auth.token, sessionId);

      deviceB.disconnect();
      await waitFor(() => !deviceB.isConnected(), { timeoutMs: 10_000 });

      const updates = ['state-1', 'state-2', 'state-3'];
      let expectedVersion = initial.agentStateVersion;
      for (const label of updates) {
        const ciphertext = Buffer.from(label, 'utf8').toString('base64');
        const res = await patchSessionAgentState({
          baseUrl: server.baseUrl,
          token: auth.token,
          sessionId,
          ciphertext,
          expectedVersion,
        });
        if (!res.ok) {
          throw new Error(`Failed to patch agentState (${res.error})`);
        }
        expectedVersion = res.version;
      }

      deviceB.connect();
      await waitFor(() => deviceB.isConnected(), { timeoutMs: 20_000 });

      const final = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      expect(final.agentStateVersion).toBe(expectedVersion);
      expect(final.agentState).toBe(Buffer.from('state-3', 'utf8').toString('base64'));

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      deviceA.close();
      deviceB.close();
    }
  });
});

