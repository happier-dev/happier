import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchSessionsV2 } from '../../src/testkit/sessions';
import { fetchChanges, fetchCursor } from '../../src/testkit/changes';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: sessions list catch-up via /v2/changes', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('offline device observes new session via /v2/changes and sees it in /v2/sessions after reconnect', async () => {
    const testDir = run.testDir('sessions-list-catchup');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'sessions-list-catchup',
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
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

  it('tracks multiple new sessions after a cursor checkpoint and then stabilizes with no new changes', async () => {
    const testDir = run.testDir('sessions-list-catchup.multi');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'sessions-list-catchup.multi',
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('changes.batch1.json', async () => await fetchChanges(server!.baseUrl, auth.token, { after: 0 }));
    artifacts.json('changes.batch2.json', async () => await fetchChanges(server!.baseUrl, auth.token, { after: 0 }));
    artifacts.json('sessions.after.multi.json', async () => await fetchSessionsV2(server!.baseUrl, auth.token));

    let passed = false;
    try {
      const cursor0 = await fetchCursor(server.baseUrl, auth.token);

      const createdA = await createSession(server.baseUrl, auth.token);
      const createdB = await createSession(server.baseUrl, auth.token);
      const expectedSessionIds = [createdA.sessionId, createdB.sessionId];

      const changes1 = await fetchChanges(server.baseUrl, auth.token, { after: cursor0.cursor });
      const sessionChanges1 = changes1.changes.filter((c) => c.kind === 'session').map((c) => c.entityId);
      for (const sessionId of expectedSessionIds) {
        expect(sessionChanges1).toContain(sessionId);
      }

      const sessions1 = await fetchSessionsV2(server.baseUrl, auth.token);
      const listedIds1 = sessions1.sessions.map((s) => s.id);
      for (const sessionId of expectedSessionIds) {
        expect(listedIds1).toContain(sessionId);
      }

      const changes2 = await fetchChanges(server.baseUrl, auth.token, { after: changes1.nextCursor });
      expect(changes2.changes.length).toBe(0);
      expect(changes2.nextCursor).toBeGreaterThanOrEqual(changes1.nextCursor);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  });
});
