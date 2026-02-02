import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchAllMessages, countDuplicateLocalIds, maxMessageSeq } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifest } from '../../src/testkit/manifest';
import { sleep, waitFor } from '../../src/testkit/timing';
import { mulberry32, parseOptionalInt, pickOne, randomIntInclusive } from '../../src/testkit/seed';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const run = createRunDirs({ runLabel: 'stress' });

describe('stress: seeded reconnection chaos', () => {
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

  it('injects seeded disconnects/reconnects and asserts transcript convergence invariants', async () => {
    const repeats = parsePositiveInt(process.env.HAPPY_E2E_REPEAT, 10);
    const saveArtifactsOnSuccess = envFlag('HAPPY_E2E_SAVE_ARTIFACTS', false);
    const allowFlakeRetry = envFlag('HAPPY_E2E_FLAKE_RETRY', false);

    const seedFromEnv = parseOptionalInt(process.env.HAPPY_E2E_SEED);
    const globalSeed = seedFromEnv ?? (Date.now() & 0xffffffff);
    const startedAt = new Date().toISOString();

    for (let i = 1; i <= repeats; i++) {
      const iterSeed = (globalSeed + i * 2654435761) >>> 0;
      const rng = mulberry32(iterSeed);
      const scenario = pickOne(rng, ['b-offline', 'both-drop', 'b-flap'] as const);

      const testDir = run.testDir(`chaos-${i}-${scenario}-seed-${iterSeed}`);
      const { sessionId } = await createSession(server.baseUrl, token);

      writeTestManifest(testDir, {
        startedAt,
        runId: run.runId,
        testName: `chaos-${i}`,
        seed: iterSeed,
        baseUrl: server.baseUrl,
        ports: { server: server.port },
        sessionIds: [sessionId],
        env: {
          HAPPY_E2E_REPEAT: process.env.HAPPY_E2E_REPEAT,
          HAPPY_E2E_SEED: process.env.HAPPY_E2E_SEED,
          HAPPY_E2E_FLAKE_RETRY: process.env.HAPPY_E2E_FLAKE_RETRY,
          HAPPY_E2E_SAVE_ARTIFACTS: process.env.HAPPY_E2E_SAVE_ARTIFACTS,
        },
      });

      const runScenarioOnce = async (attempt: number) => {
        const deviceA = createUserScopedSocketCollector(server.baseUrl, token);
        const deviceB = createUserScopedSocketCollector(server.baseUrl, token);

        const artifacts = new FailureArtifacts();
        artifacts.json(`attempt-${attempt}.deviceA.events.json`, () => deviceA.getEvents());
        artifacts.json(`attempt-${attempt}.deviceB.events.json`, () => deviceB.getEvents());
        artifacts.json(`attempt-${attempt}.transcript.json`, async () => await fetchAllMessages(server.baseUrl, token, sessionId));

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

        let passed = false;
        try {
          deviceA.connect();
          deviceB.connect();
          await waitFor(() => deviceA.isConnected() && deviceB.isConnected(), { timeoutMs: 20_000 });

          if (scenario === 'b-offline') {
            const pre = randomIntInclusive(rng, 2, 8);
            const offline = randomIntInclusive(rng, 5, 25);
            const post = randomIntInclusive(rng, 1, 6);
            const offlineDelay = randomIntInclusive(rng, 50, 400);

            for (let k = 0; k < pre; k++) await sendFromA(`pre-${i}-${k}`);
            deviceB.disconnect();
            await waitFor(() => !deviceB.isConnected(), { timeoutMs: 10_000 });
            for (let k = 0; k < offline; k++) await sendFromA(`offline-${i}-${k}`);
            await sleep(offlineDelay);
            deviceB.connect();
            await waitFor(() => deviceB.isConnected(), { timeoutMs: 20_000 });
            for (let k = 0; k < post; k++) await sendFromA(`post-${i}-${k}`);
          } else if (scenario === 'both-drop') {
            const pre = randomIntInclusive(rng, 2, 8);
            const post = randomIntInclusive(rng, 2, 8);
            const downDelay = randomIntInclusive(rng, 50, 500);

            for (let k = 0; k < pre; k++) await sendFromA(`pre-${i}-${k}`);
            deviceA.disconnect();
            deviceB.disconnect();
            await waitFor(() => !deviceA.isConnected() && !deviceB.isConnected(), { timeoutMs: 10_000 });
            await sleep(downDelay);
            deviceA.connect();
            deviceB.connect();
            await waitFor(() => deviceA.isConnected() && deviceB.isConnected(), { timeoutMs: 20_000 });
            for (let k = 0; k < post; k++) await sendFromA(`post-${i}-${k}`);
          } else {
            // b-flap
            const cycles = randomIntInclusive(rng, 2, 5);
            const msgsPerCycle = randomIntInclusive(rng, 3, 8);
            for (let cycle = 1; cycle <= cycles; cycle++) {
              for (let k = 0; k < msgsPerCycle; k++) await sendFromA(`cycle-${cycle}-${k}`);
              deviceB.disconnect();
              await waitFor(() => !deviceB.isConnected(), { timeoutMs: 10_000 });
              await sleep(randomIntInclusive(rng, 10, 250));
              deviceB.connect();
              await waitFor(() => deviceB.isConnected(), { timeoutMs: 20_000 });
            }
          }

          const transcript = await fetchAllMessages(server.baseUrl, token, sessionId);
          expect(countDuplicateLocalIds(transcript)).toBe(0);
          expect(maxMessageSeq(transcript)).toBeGreaterThanOrEqual(Math.max(...expectedSeqs));

          const seqSet = new Set(transcript.map((m) => m.seq));
          for (const seq of expectedSeqs) expect(seqSet.has(seq)).toBe(true);
          const localIdSet = new Set(transcript.map((m) => m.localId).filter((v): v is string => typeof v === 'string'));
          for (const lid of expectedLocalIds.slice(-10)) expect(localIdSet.has(lid)).toBe(true);

          passed = true;
        } finally {
          await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
          deviceA.close();
          deviceB.close();
        }
      };

      if (!allowFlakeRetry) {
        await runScenarioOnce(1);
        continue;
      }

      try {
        await runScenarioOnce(1);
      } catch (e1) {
        // Retry once to classify as flaky vs deterministic failure.
        try {
          await runScenarioOnce(2);
        } catch {
          throw e1;
        }
        throw new Error(
          `FLAKY: stress scenario passed on retry (iteration=${i}, scenario=${scenario}, seed=${iterSeed}). See artifacts in ${testDir}`
        );
      }
    }
  });
});

