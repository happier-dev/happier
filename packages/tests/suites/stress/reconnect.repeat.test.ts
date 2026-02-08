import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { countDuplicateLocalIds, createSession, fetchAllMessages, maxMessageSeq } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { waitFor } from '../../src/testkit/timing';
import { parsePositiveInt } from '../../src/testkit/numbers';

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
    const repeats = parsePositiveInt(process.env.HAPPIER_E2E_REPEAT ?? process.env.HAPPY_E2E_REPEAT, 5);
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    for (let i = 1; i <= repeats; i++) {
      const testDir = run.testDir(`repeat-${i}`);
      const { sessionId } = await createSession(server.baseUrl, token);

      const deviceA = createUserScopedSocketCollector(server.baseUrl, token);
      const deviceB = createUserScopedSocketCollector(server.baseUrl, token);

      writeTestManifestForServer({
        testDir,
        server,
        startedAt,
        runId: run.runId,
        testName: `repeat-${i}`,
        sessionIds: [sessionId],
        env: {
          HAPPIER_E2E_REPEAT: process.env.HAPPIER_E2E_REPEAT ?? process.env.HAPPY_E2E_REPEAT,
          HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
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

      const expectedSeqs: number[] = [];
      const expectedLocalIds: string[] = [];
      const send = async (label: string) => {
        const ciphertext = Buffer.from(label, 'utf8').toString('base64');
        const localId = randomUUID();
        const rawAck = await deviceA.emitWithAck<any>('message', { sid: sessionId, message: ciphertext, localId });
        const ack = MessageAckResponseSchema.parse(rawAck);
        expect(ack.ok).toBe(true);
        if (ack.ok === true) {
          expectedSeqs.push(ack.seq);
        }
        expectedLocalIds.push(localId);
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
        expect(countDuplicateLocalIds(transcript)).toBe(0);
        expect(maxMessageSeq(transcript)).toBeGreaterThanOrEqual(Math.max(...expectedSeqs));
        const seqSet = new Set(transcript.map((m) => m.seq));
        for (const seq of expectedSeqs) expect(seqSet.has(seq)).toBe(true);
        const localIdSet = new Set(transcript.map((m) => m.localId).filter((v): v is string => typeof v === 'string'));
        for (const localId of expectedLocalIds) expect(localIdSet.has(localId)).toBe(true);
        passed = true;
      } finally {
        await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
        deviceA.close();
        deviceB.close();
      }
    }
  });
});
