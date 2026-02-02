import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { countDuplicateLocalIds, createSession, fetchAllMessages, maxMessageSeq } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifest } from '../../src/testkit/manifest';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: mid-stream message storm + reconnect convergence', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('device B disconnects mid-storm; on reconnect, transcript converges to expected head seq', async () => {
    const testDir = run.testDir('midstream-storm-reconnect');
    const saveArtifactsOnSuccess = envFlag('HAPPY_E2E_SAVE_ARTIFACTS', false);
    const startedAt = new Date().toISOString();
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const deviceA = createUserScopedSocketCollector(server.baseUrl, auth.token);
    const deviceB = createUserScopedSocketCollector(server.baseUrl, auth.token);

    const artifacts = new FailureArtifacts();
    artifacts.json('deviceA.events.json', () => deviceA.getEvents());
    artifacts.json('deviceB.events.json', () => deviceB.getEvents());
    artifacts.json('transcript.json', async () => await fetchAllMessages(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    deviceA.connect();
    deviceB.connect();
    await waitFor(() => deviceA.isConnected() && deviceB.isConnected(), { timeoutMs: 20_000 });

    writeTestManifest(testDir, {
      startedAt,
      runId: run.runId,
      testName: 'midstream-storm-reconnect',
      baseUrl: server.baseUrl,
      ports: { server: server.port },
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPY_E2E_SAVE_ARTIFACTS: process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const expectedSeqs: number[] = [];
    const expectedLocalIds: string[] = [];

    const sendFromA = async (label: string) => {
      const ciphertext = Buffer.from(label, 'utf8').toString('base64');
      const localId = randomUUID();
      const ack = await deviceA.emitWithAck<{ ok: boolean; seq: number }>('message', { sid: sessionId, message: ciphertext, localId });
      expect(ack.ok).toBe(true);
      expectedSeqs.push(ack.seq);
      expectedLocalIds.push(localId);
    };

    // Send a few while both are connected.
    for (let i = 0; i < 10; i++) {
      await sendFromA(`pre-${i}`);
    }

    // Drop B mid-storm.
    deviceB.disconnect();
    await waitFor(() => !deviceB.isConnected(), { timeoutMs: 10_000 });

    // Message storm while B is offline (simulates a streaming-heavy agent turn).
    const STORM = 80;
    for (let i = 0; i < STORM; i++) {
      await sendFromA(`storm-${i}`);
    }

    deviceB.connect();
    await waitFor(() => deviceB.isConnected(), { timeoutMs: 20_000 });

    try {
      const transcript = await fetchAllMessages(server.baseUrl, auth.token, sessionId);

      const expectedMaxSeq = Math.max(...expectedSeqs);
      expect(maxMessageSeq(transcript)).toBeGreaterThanOrEqual(expectedMaxSeq);
      expect(countDuplicateLocalIds(transcript)).toBe(0);

      // Ensure the last few localIds exist (avoid scanning all in case server adds extra).
      const localIdSet = new Set(transcript.map((m) => m.localId).filter((v): v is string => typeof v === 'string'));
      for (const lid of expectedLocalIds.slice(-10)) {
        expect(localIdSet.has(lid)).toBe(true);
      }

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      deviceA.close();
      deviceB.close();
    }
  });
});
