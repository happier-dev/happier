import { afterAll, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchSessionsV2 } from '../../src/testkit/sessions';
import { fetchChanges, fetchCursor } from '../../src/testkit/changes';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifest } from '../../src/testkit/manifest';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: sessions list catch-up via /v2/changes', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('offline device observes new session via /v2/changes and sees it in /v2/sessions after reconnect', async () => {
    const testDir = run.testDir('sessions-list-catchup');
    const saveArtifactsOnSuccess = envFlag('HAPPY_E2E_SAVE_ARTIFACTS', false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    writeTestManifest(testDir, {
      startedAt,
      runId: run.runId,
      testName: 'sessions-list-catchup',
      baseUrl: server.baseUrl,
      ports: { server: server.port },
      env: {
        CI: process.env.CI,
        HAPPY_E2E_SAVE_ARTIFACTS: process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('cursor0.json', async () => await fetchCursor(server!.baseUrl, auth.token));
    artifacts.json('sessions.before.json', async () => await fetchSessionsV2(server!.baseUrl, auth.token));
    artifacts.json('changes.after.json', async () => await fetchChanges(server!.baseUrl, auth.token, { after: 0 }));
    artifacts.json('sessions.after.json', async () => await fetchSessionsV2(server!.baseUrl, auth.token));

    let passed = false;
    try {
      const cursor0 = await fetchCursor(server.baseUrl, auth.token);
      const sessions0 = await fetchSessionsV2(server.baseUrl, auth.token);
      expect(sessions0.sessions.length).toBe(0);

      const created = await createSession(server.baseUrl, auth.token);
      const { sessionId } = created;

      const changesRes = await fetchChanges(server.baseUrl, auth.token, { after: cursor0.cursor });
      expect(changesRes.nextCursor).toBeGreaterThanOrEqual(cursor0.cursor);
      expect(changesRes.changes.some((c) => c.kind === 'session' && c.entityId === sessionId)).toBe(true);

      const sessions1 = await fetchSessionsV2(server.baseUrl, auth.token);
      expect(sessions1.sessions.some((s) => s.id === sessionId)).toBe(true);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  });
});

