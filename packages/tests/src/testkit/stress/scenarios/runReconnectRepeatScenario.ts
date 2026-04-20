import { randomUUID } from 'node:crypto';

import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';

import type { RunDirs } from '../../runDir';
import { createSession, countDuplicateLocalIds, fetchAllMessages, maxMessageSeq } from '../../sessions';
import { FailureArtifacts } from '../../failureArtifacts';
import { createUserScopedSocketCollector } from '../../socketClient';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { resolveReconnectMessageCount, resolveStressSocketTransports } from './stressScenarioRuntime';

export async function runReconnectRepeatScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const startedAt = new Date().toISOString();

  for (let i = 1; i <= params.config.repeat; i++) {
    const testDir = params.run.testDir(`repeat-${i}`);
    const { sessionId } = await createSession(params.target.baseUrl, params.token);
    const transports = resolveStressSocketTransports(params.config, params.target.mode);
    const deviceA = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });
    const deviceB = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });

    const artifacts = new FailureArtifacts();
    artifacts.json('deviceA.events.json', () => deviceA.getEvents());
    artifacts.json('deviceB.events.json', () => deviceB.getEvents());
    artifacts.json('transcript.json', async () => await fetchAllMessages(params.target.baseUrl, params.token, sessionId));

    const expectedSeqs: number[] = [];
    const expectedLocalIds: string[] = [];
    const totalMessages = resolveReconnectMessageCount(params.config);
    const preCount = Math.max(2, Math.floor(totalMessages / 3));
    const offlineCount = Math.max(1, Math.floor(totalMessages / 3));
    const postCount = Math.max(1, totalMessages - preCount - offlineCount);
    let failure: unknown;
    let transcriptMessages = 0;
    let duplicateLocalIds = 0;

    try {
      if (params.config.duration.warmupMs > 0) {
        await sleep(params.config.duration.warmupMs);
      }
      deviceA.connect();
      deviceB.connect();
      await waitFor(() => deviceA.isConnected() && deviceB.isConnected(), { timeoutMs: 20_000 });

      const send = async (label: string) => {
        const ciphertext = Buffer.from(label, 'utf8').toString('base64');
        const localId = randomUUID();
        const rawAck = await deviceA.emitWithAck<unknown>('message', { sid: sessionId, message: ciphertext, localId });
        const ack = MessageAckResponseSchema.parse(rawAck);
        if (!ack.ok) {
          throw new Error(`Expected message ack success for ${label}`);
        }
        expectedSeqs.push(ack.seq);
        expectedLocalIds.push(localId);
      };

      for (let index = 0; index < preCount; index++) {
        await send(`r${i}-pre-${index}`);
      }

      deviceB.disconnect();
      await waitFor(() => !deviceB.isConnected(), { timeoutMs: 10_000 });

      for (let index = 0; index < offlineCount; index++) {
        await send(`r${i}-offline-${index}`);
      }

      deviceB.connect();
      await waitFor(() => deviceB.isConnected(), { timeoutMs: 20_000 });
      if (params.config.duration.soakMs > 0) {
        await sleep(params.config.duration.soakMs);
      }

      for (let index = 0; index < postCount; index++) {
        await send(`r${i}-post-${index}`);
      }

      const transcript = await fetchAllMessages(params.target.baseUrl, params.token, sessionId);
      transcriptMessages = transcript.length;
      duplicateLocalIds = countDuplicateLocalIds(transcript);
      const seqSet = new Set(transcript.map((message) => message.seq));
      const localIdSet = new Set(
        transcript.map((message) => message.localId).filter((value): value is string => typeof value === 'string'),
      );

      expectNoDuplicateLocalIds(transcript);
      if (maxMessageSeq(transcript) < Math.max(...expectedSeqs)) {
        throw new Error('Transcript head did not converge to the latest acknowledged sequence');
      }
      for (const seq of expectedSeqs) {
        if (!seqSet.has(seq)) {
          throw new Error(`Missing expected transcript sequence ${seq}`);
        }
      }
      for (const localId of expectedLocalIds) {
        if (!localIdSet.has(localId)) {
          throw new Error(`Missing expected localId ${localId}`);
        }
      }
      if (params.config.duration.cooldownMs > 0) {
        await sleep(params.config.duration.cooldownMs);
      }
    } catch (error) {
      failure = error;
    } finally {
      await finalizeStressScenario({
        run: params.run,
        testDir,
        testName: 'reconnect.repeat',
        target: params.target,
        config: params.config,
        startedAt,
        sessionIds: [sessionId],
        seed: params.config.seed,
        env: {
          HAPPIER_STRESS_TARGET_MODE: params.config.targetMode,
          HAPPIER_STRESS_REPEAT: String(params.config.repeat),
          HAPPIER_STRESS_MESSAGES_PER_SECOND: String(params.config.load.messagesPerSecond),
        },
        status: failure ? 'failed' : 'passed',
        error: failure,
        counts: {
          messagesSent: expectedSeqs.length,
          transcriptMessages,
        },
        failures: {
          duplicateLocalIds,
        },
      });
      await artifacts.dumpAll(testDir, { onlyIf: params.config.artifacts.saveArtifactsOnSuccess || !!failure });
      deviceA.close();
      deviceB.close();
    }

    if (failure) {
      throw failure;
    }
  }
}

function expectNoDuplicateLocalIds(transcript: Awaited<ReturnType<typeof fetchAllMessages>>): void {
  if (countDuplicateLocalIds(transcript) !== 0) {
    throw new Error('Transcript contains duplicate localIds after reconnect repeat');
  }
}
