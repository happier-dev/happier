import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchAllMessages, maxMessageSeq } from '../../src/testkit/sessions';
import { fetchChanges, fetchCursor } from '../../src/testkit/changes';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifest } from '../../src/testkit/manifest';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: /v2/changes catch-up hints for session messages', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('offline device can use /v2/changes hints to detect missing session messages', async () => {
    const testDir = run.testDir('changes-catchup-hints');
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
      testName: 'changes-catchup-hints',
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
    artifacts.json('changes.json', async () => await fetchChanges(server!.baseUrl, auth.token, { after: 0 }));
    artifacts.json('transcript.json', async () => await fetchAllMessages(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    try {
      const cursor0 = await fetchCursor(server.baseUrl, auth.token);

      deviceA.connect();
      deviceB.connect();
      await waitFor(() => deviceA.isConnected() && deviceB.isConnected(), { timeoutMs: 20_000 });

      deviceB.disconnect();
      await waitFor(() => !deviceB.isConnected(), { timeoutMs: 10_000 });

      const expectedSeqs: number[] = [];
      for (let i = 0; i < 6; i++) {
        const ciphertext = Buffer.from(`msg-${i}`, 'utf8').toString('base64');
        const localId = randomUUID();
        const ack = await deviceA.emitWithAck<{ ok: boolean; seq: number }>('message', { sid: sessionId, message: ciphertext, localId });
        expect(ack.ok).toBe(true);
        expectedSeqs.push(ack.seq);
      }

      const maxSeq = Math.max(...expectedSeqs);

      const changesRes = await fetchChanges(server.baseUrl, auth.token, { after: cursor0.cursor });
      expect(changesRes.nextCursor).toBeGreaterThanOrEqual(cursor0.cursor);

      const sessionChanges = changesRes.changes.filter((c) => c.kind === 'session' && c.entityId === sessionId);
      expect(sessionChanges.length).toBeGreaterThan(0);

      const last = sessionChanges[sessionChanges.length - 1]!;
      const hint = last.hint && typeof last.hint === 'object' ? (last.hint as Record<string, unknown>) : null;
      const hintedLastMessageSeq = hint && typeof hint.lastMessageSeq === 'number' ? hint.lastMessageSeq : null;
      expect(hintedLastMessageSeq).not.toBeNull();
      expect(hintedLastMessageSeq!).toBeGreaterThanOrEqual(maxSeq);

      const transcript = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      expect(maxMessageSeq(transcript)).toBeGreaterThanOrEqual(maxSeq);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      deviceA.close();
      deviceB.close();
    }
  });
});

