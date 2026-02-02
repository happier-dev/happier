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

describe('core e2e: multi-device reconnect catch-up', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('device B disconnects; on reconnect, HTTP transcript catch-up includes messages created while offline', async () => {
    const testDir = run.testDir('multi-device-reconnect-catchup');
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
      testName: 'multi-device-reconnect-catchup',
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

    const sendMessageFromA = async (label: string) => {
      const ciphertext = Buffer.from(label, 'utf8').toString('base64');
      const localId = randomUUID();
      const ack = await deviceA.emitWithAck<{ ok: boolean; seq: number; localId: string | null }>('message', {
        sid: sessionId,
        message: ciphertext,
        localId,
      });
      expect(ack.ok).toBe(true);
      expectedSeqs.push(ack.seq);
      expectedLocalIds.push(localId);
    };

    // Phase 1: both connected; B should observe all messages sent by A (server skips sender socket only).
    await sendMessageFromA('m1');
    await sendMessageFromA('m2');
    await sendMessageFromA('m3');

    await waitFor(() => {
      const updates = deviceB.getEvents().filter((e) => e.kind === 'update' && e.payload?.body?.t === 'new-message');
      return updates.length >= 3;
    });

    // Phase 2: B offline while A sends more.
    deviceB.disconnect();
    await waitFor(() => !deviceB.isConnected(), { timeoutMs: 10_000 });

    await sendMessageFromA('m4');
    await sendMessageFromA('m5');
    await sendMessageFromA('m6');

    // Reconnect B and verify it can catch up via HTTP transcript fetch.
    deviceB.connect();
    await waitFor(() => deviceB.isConnected(), { timeoutMs: 20_000 });

    try {
      const transcript = await fetchAllMessages(server.baseUrl, auth.token, sessionId);

      // Invariant: transcript head includes all messages, even those created while B was offline.
      expect(transcript.length).toBeGreaterThanOrEqual(6);
      expect(maxMessageSeq(transcript)).toBeGreaterThanOrEqual(Math.max(...expectedSeqs));
      expect(countDuplicateLocalIds(transcript)).toBe(0);

      // Stronger: every message we sent is present by seq and by localId.
      const seqSet = new Set(transcript.map((m) => m.seq));
      for (const seq of expectedSeqs) expect(seqSet.has(seq)).toBe(true);
      const localIdSet = new Set(transcript.map((m) => m.localId).filter((v): v is string => typeof v === 'string'));
      for (const lid of expectedLocalIds) expect(localIdSet.has(lid)).toBe(true);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      deviceA.close();
      deviceB.close();
    }
  });
});
