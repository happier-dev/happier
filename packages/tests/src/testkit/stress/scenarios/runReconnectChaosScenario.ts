import { randomUUID } from 'node:crypto';

import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';

import type { RunDirs } from '../../runDir';
import { createSession, countDuplicateLocalIds, fetchAllMessages } from '../../sessions';
import { FailureArtifacts } from '../../failureArtifacts';
import { createUserScopedSocketCollector } from '../../socketClient';
import { runWithFlakeRetry } from '../../providers/harness/flakeRetry';
import { sleep, waitFor } from '../../timing';
import { mulberry32, pickOne, randomIntInclusive } from '../../seed';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { resolveReconnectCycleCount, resolveReconnectMessageCount, resolveStressSocketTransports } from './stressScenarioRuntime';

export async function runReconnectChaosScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const globalSeed = params.config.seed ?? (Date.now() & 0xffffffff);
  const startedAt = new Date().toISOString();

  for (let i = 1; i <= params.config.repeat; i++) {
    const iterSeed = (globalSeed + i * 2654435761) >>> 0;
    const rng = mulberry32(iterSeed);
    const scenario = pickOne(rng, ['b-offline', 'both-drop', 'b-flap'] as const);
    const testDir = params.run.testDir(`chaos-${i}-${scenario}-seed-${iterSeed}`);
    const { sessionId } = await createSession(params.target.baseUrl, params.token);
    const transports = resolveStressSocketTransports(params.config, params.target.mode);
    const totalMessages = resolveReconnectMessageCount(params.config);
    const reconnectCycles = resolveReconnectCycleCount(params.config);
    let failure: unknown;
    let duplicateLocalIds = 0;
    let expectedMessages = 0;
    let uniqueLocalIds = 0;

    try {
      await runWithFlakeRetry({
        enabled: params.config.flakeRetry,
        flakyErrorMessage: `FLAKY: stress scenario passed on retry (iteration=${i}, scenario=${scenario}, seed=${iterSeed})`,
        runOnce: async (attempt) => {
          const deviceA = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });
          const deviceB = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });
          const artifacts = new FailureArtifacts();
          artifacts.json(`attempt-${attempt}.deviceA.events.json`, () => deviceA.getEvents());
          artifacts.json(`attempt-${attempt}.deviceB.events.json`, () => deviceB.getEvents());
          artifacts.json(`attempt-${attempt}.transcript.json`, async () => await fetchAllMessages(params.target.baseUrl, params.token, sessionId));

          const expectedSeqs: number[] = [];
          const expectedLocalIds: string[] = [];
          let attemptPassed = false;

          try {
            if (params.config.duration.warmupMs > 0) {
              await sleep(params.config.duration.warmupMs);
            }
            const sendFromA = async (label: string) => {
              const ciphertext = Buffer.from(label, 'utf8').toString('base64');
              const localId = randomUUID();
              const raw = await deviceA.emitWithAck<unknown>('message', { sid: sessionId, message: ciphertext, localId });
              const ack = MessageAckResponseSchema.parse(raw);
              if (!ack.ok) {
                throw new Error(`Expected successful ack for ${label}`);
              }
              expectedSeqs.push(ack.seq);
              expectedLocalIds.push(localId);

              if (randomIntInclusive(rng, 1, 10) === 1) {
                const rawRetry = await deviceA.emitWithAck<unknown>('message', { sid: sessionId, message: ciphertext, localId });
                const retryAck = MessageAckResponseSchema.parse(rawRetry);
                if (!retryAck.ok || retryAck.seq !== ack.seq || retryAck.didWrite !== false) {
                  throw new Error(`Idempotent retry mismatch for ${label}`);
                }
              }
            };

            deviceA.connect();
            deviceB.connect();
            await waitFor(() => deviceA.isConnected() && deviceB.isConnected(), { timeoutMs: 20_000 });

            if (scenario === 'b-offline') {
              const pre = Math.max(2, Math.floor(totalMessages / 4));
              const offline = Math.max(5, Math.floor(totalMessages / 2));
              const post = Math.max(1, totalMessages - pre - offline);
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
              const pre = Math.max(2, Math.floor(totalMessages / 2));
              const post = Math.max(2, totalMessages - pre);
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
              const cycles = reconnectCycles;
              const msgsPerCycle = Math.max(1, Math.ceil(totalMessages / cycles));
              for (let cycle = 1; cycle <= cycles; cycle++) {
                for (let k = 0; k < msgsPerCycle; k++) await sendFromA(`cycle-${cycle}-${k}`);
                deviceB.disconnect();
                await waitFor(() => !deviceB.isConnected(), { timeoutMs: 10_000 });
                await sleep(randomIntInclusive(rng, 10, 250));
                deviceB.connect();
                await waitFor(() => deviceB.isConnected(), { timeoutMs: 20_000 });
              }
            }

            if (params.config.duration.soakMs > 0) {
              await sleep(params.config.duration.soakMs);
            }
            const transcript = await fetchAllMessages(params.target.baseUrl, params.token, sessionId);
            duplicateLocalIds = countDuplicateLocalIds(transcript);
            expectedMessages = expectedSeqs.length;
            uniqueLocalIds = expectedLocalIds.length;
            assertReconnectChaosTranscriptConvergence({
              transcript,
              expectedSeqs,
              expectedLocalIds,
            });
            if (params.config.duration.cooldownMs > 0) {
              await sleep(params.config.duration.cooldownMs);
            }
            attemptPassed = true;
          } finally {
            await artifacts.dumpAll(testDir, { onlyIf: params.config.artifacts.saveArtifactsOnSuccess || !attemptPassed });
            deviceA.close();
            deviceB.close();
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'reconnect.chaos',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds: [sessionId],
      seed: iterSeed,
      env: {
        HAPPIER_STRESS_TARGET_MODE: params.config.targetMode,
        HAPPIER_STRESS_REPEAT: String(params.config.repeat),
        HAPPIER_STRESS_SEED: String(globalSeed),
        HAPPIER_STRESS_RECONNECT_RATE: String(params.config.load.reconnectRate),
      },
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        expectedMessages,
        uniqueLocalIds,
      },
      failures: {
        duplicateLocalIds,
      },
    });

    if (failure) {
      throw failure;
    }
  }
}

export function assertReconnectChaosTranscriptConvergence(params: {
  transcript: readonly { seq: number; localId?: string | null }[];
  expectedSeqs: readonly number[];
  expectedLocalIds: readonly string[];
}): void {
  if (countDuplicateLocalIdsInTranscript(params.transcript) !== 0) {
    throw new Error('Transcript contains duplicate localIds after reconnect chaos');
  }

  if (params.expectedSeqs.length > 0 && maxMessageSeqInTranscript(params.transcript) < Math.max(...params.expectedSeqs)) {
    throw new Error('Transcript sequence convergence failed after reconnect chaos');
  }

  const seqSet = new Set(params.transcript.map((message) => message.seq));
  const localIdSet = new Set(
    params.transcript
      .map((message) => message.localId)
      .filter((value): value is string => typeof value === 'string'),
  );

  for (const seq of params.expectedSeqs) {
    if (!seqSet.has(seq)) {
      throw new Error(`Missing acknowledged transcript sequence ${seq} after reconnect chaos`);
    }
  }

  for (const localId of params.expectedLocalIds) {
    if (!localIdSet.has(localId)) {
      throw new Error(`Missing acknowledged localId ${localId} after reconnect chaos`);
    }
  }
}

function maxMessageSeqInTranscript(messages: readonly { seq: number }[]): number {
  if (messages.length === 0) return 0;
  return Math.max(...messages.map((message) => message.seq));
}

function countDuplicateLocalIdsInTranscript(messages: readonly { localId?: string | null }[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const message of messages) {
    if (!message.localId) continue;
    if (seen.has(message.localId)) duplicates += 1;
    else seen.add(message.localId);
  }
  return duplicates;
}
