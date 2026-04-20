import type { RunDirs } from '../../runDir';
import { createSession } from '../../sessions';
import { FailureArtifacts } from '../../failureArtifacts';
import { waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import {
    readScalarMetricValue,
    readServiceMetricsViaNodeFetch,
    requireFullComposeAdmin,
} from './fullComposeScenarioSupport';

const PRESENCE_STREAM_KEY = 'presence:alive:v1';
const PRESENCE_GROUP = 'presence-worker';
const DEAD_CONSUMER_NAME = 'stress-dead-consumer';

export async function runPresenceWorkerCrashScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const testDir = params.run.testDir('presence-worker-crash-reclaim');
  const startedAt = new Date().toISOString();
  const admin = requireFullComposeAdmin(params.target);
  let failure: unknown;
  let reclaimDelta = 0;
  let pendingEntries = 0;
  let drainDurationMs = 0;

  if (!admin || params.target.topology.resolvedWorkerReplicas < 1) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'presence.workerCrashReclaim',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: 'passed',
      counts: {
        workerReplicas: params.target.topology.resolvedWorkerReplicas,
      },
      errors: {
        buckets: {
          unsupportedTopology: 1,
        },
      },
    });
    return;
  }

  const workerContainers = await admin.listServiceContainers('worker');
  const crashedWorker = workerContainers[0];
  if (!crashedWorker) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'presence.workerCrashReclaim',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: 'passed',
      counts: {
        workerReplicas: 0,
      },
      errors: {
        buckets: {
          missingWorkerContainer: 1,
        },
      },
    });
    return;
  }

  const sessionCount = 2;
  const sessionIds: string[] = [];
  const artifacts = new FailureArtifacts();

  try {
    for (let index = 0; index < sessionCount; index += 1) {
      const { sessionId } = await createSession(params.target.baseUrl, params.token);
      sessionIds.push(sessionId);
    }

    const beforeMetrics = await readServiceMetricsViaNodeFetch(params.target, 'worker');
    const beforeReclaims = readScalarMetricValue(beforeMetrics, 'presence_stream_reclaims_total');

    await admin.killContainer(crashedWorker.id);

    for (const sessionId of sessionIds) {
      await admin.execInService(
        'redis',
        [
          'redis-cli',
          '--raw',
          'XADD',
          PRESENCE_STREAM_KEY,
          '*',
          'kind',
          'session',
          'id',
          sessionId,
          'ts',
          String(Date.now()),
          'accountId',
          'stress-test',
        ],
      );
      await admin.execInService(
        'redis',
        [
          'redis-cli',
          '--raw',
          'XREADGROUP',
          'GROUP',
          PRESENCE_GROUP,
          DEAD_CONSUMER_NAME,
          'COUNT',
          '1',
          'STREAMS',
          PRESENCE_STREAM_KEY,
          '>',
        ],
      );
    }

    await admin.startService('worker');
    await waitFor(
      async () => {
        if ((await admin.listServiceContainers('worker')).length === 0) {
          return false;
        }
        await readServiceMetricsViaNodeFetch(params.target, 'worker');
        return true;
      },
      {
        timeoutMs: 60_000,
        intervalMs: 1_000,
        shouldRetryOnError: () => true,
      },
    );

    const drainStartedAt = Date.now();
    await waitFor(
      async () => {
        const metrics = await readServiceMetricsViaNodeFetch(params.target, 'worker');
        reclaimDelta = readScalarMetricValue(metrics, 'presence_stream_reclaims_total') - beforeReclaims;
        pendingEntries = readScalarMetricValue(metrics, 'presence_stream_pending_entries');
        return reclaimDelta >= sessionIds.length && pendingEntries <= 0;
      },
      {
        timeoutMs: 120_000,
        intervalMs: 1_000,
        shouldRetryOnError: () => true,
      },
    );
    drainDurationMs = Date.now() - drainStartedAt;
  } catch (error) {
    failure = error;
  } finally {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'presence.workerCrashReclaim',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds,
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        sessions: sessionIds.length,
      },
      errors: {
        buckets: {
          reclaimDelta,
          pendingEntries,
        },
        details: {
          presence: {
            reclaimDelta,
            pendingEntries,
            drainDurationMs,
          },
        },
      },
    });
    await artifacts.dumpAll(testDir, { onlyIf: params.config.artifacts.saveArtifactsOnSuccess || !!failure });
  }

  if (failure) {
    throw failure;
  }
}
