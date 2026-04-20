import { randomUUID } from 'node:crypto';

import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';

import type { RunDirs } from '../../runDir';
import { createSession, fetchAllMessages } from '../../sessions';
import { FailureArtifacts } from '../../failureArtifacts';
import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import { createUserScopedSocketCollector } from '../../socketClient';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import {
  readScalarMetricValue,
  readServiceMetricsViaNodeFetch,
  requireFullComposeAdmin,
  waitForRedisServiceHealthy,
} from './fullComposeScenarioSupport';
import { resolveStressSocketTransports, summarizeLatencySamples } from './stressScenarioRuntime';
import { waitForRegisteredRpcMethod } from './waitForRegisteredRpcMethod';

export async function runRedisInterruptionScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const testDir = params.run.testDir('redis-interruption');
  const startedAt = new Date().toISOString();
  const admin = requireFullComposeAdmin(params.target);
  let failure: unknown;
  let latencies: number[] = [];
  let interruptionDurationMs = 0;
  let recoveryDurationMs = 0;
  let pendingEntries = 0;

  if (!admin) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'redis.interruption',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: 'passed',
      counts: {
        interruptions: 0,
      },
      errors: {
        buckets: {
          unsupportedTopology: 1,
        },
      },
    });
    return;
  }

  const { sessionId } = await createSession(params.target.baseUrl, params.token);
  const transports = resolveStressSocketTransports(params.config, params.target.mode);
  const ui = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });
  const agent = await createMachineBoundSessionScopedSocketCollector({
    baseUrl: params.target.baseUrl,
    token: params.token,
    sessionId,
    transports,
  });
  const method = `${sessionId}:stress.redis`;
  const artifacts = new FailureArtifacts();
  artifacts.json('ui.events.json', () => ui.getEvents());
  artifacts.json('agent.events.json', () => agent.socket.getEvents());
  artifacts.json('transcript.json', async () => await fetchAllMessages(params.target.baseUrl, params.token, sessionId));

  try {
    ui.connect();
    agent.socket.connect();
    await waitFor(() => ui.isConnected() && agent.socket.isConnected(), { timeoutMs: 20_000 });

    agent.socket.onRpcRequest(async () => JSON.stringify({ ok: true, machineId: agent.machineId }));
    await agent.socket.rpcRegister(method);
    await waitForRegisteredRpcMethod({
      ui,
      method,
      expectedMachineId: agent.machineId,
    });

    const beforeStarted = Date.now();
    const before = await ui.rpcCall<{ ok: boolean; result?: string }>(method, JSON.stringify({ step: 'before' }));
    latencies.push(Date.now() - beforeStarted);
    if (!before.ok) {
      throw new Error('RPC call failed before Redis interruption');
    }

    const interruptionStarted = Date.now();
    await admin.stopService('redis');
    await sleep(3_000);
    await admin.startService('redis');
    await waitForRedisServiceHealthy(params.target, 45_000);
    interruptionDurationMs = Date.now() - interruptionStarted;
    const recoveryStarted = Date.now();

    await waitFor(
      () => ui.isConnected() && agent.socket.isConnected(),
      {
        timeoutMs: 45_000,
        intervalMs: 500,
      },
    );

    await agent.socket.rpcRegister(method);
    await waitForRegisteredRpcMethod({
      ui,
      method,
      expectedMachineId: agent.machineId,
      timeoutMs: 30_000,
    });

    const afterStarted = Date.now();
    const after = await ui.rpcCall<{ ok: boolean; result?: string }>(method, JSON.stringify({ step: 'after' }));
    latencies.push(Date.now() - afterStarted);
    if (!after.ok) {
      throw new Error('RPC call failed after Redis interruption');
    }

    const localId = randomUUID();
    const ack = MessageAckResponseSchema.parse(
      await ui.emitWithAck<unknown>('message', {
        sid: sessionId,
        message: Buffer.from('redis-interruption-message', 'utf8').toString('base64'),
        localId,
      }),
    );
    if (!ack.ok) {
      throw new Error('Message ack failed after Redis interruption');
    }

    await waitFor(
      async () => {
        const transcript = await fetchAllMessages(params.target.baseUrl, params.token, sessionId);
        if (!transcript.some((row) => row.localId === localId)) {
          return false;
        }
        const workerMetrics = await readServiceMetricsViaNodeFetch(params.target, 'worker');
        pendingEntries = readScalarMetricValue(workerMetrics, 'presence_stream_pending_entries');
        return pendingEntries <= 0;
      },
      {
        timeoutMs: 30_000,
        intervalMs: 500,
        shouldRetryOnError: () => true,
      },
    );
    recoveryDurationMs = Date.now() - recoveryStarted;
  } catch (error) {
    failure = error;
  } finally {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'redis.interruption',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds: [sessionId],
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        interruptions: 1,
      },
      latencies: summarizeLatencySamples(latencies),
      errors: {
        buckets: {
          connectErrors: ui.getEvents().filter((event) => event.kind === 'connect_error').length,
          disconnects: ui.getEvents().filter((event) => event.kind === 'disconnect').length,
        },
        details: {
          redis: {
            interruptionDurationMs,
            recoveryDurationMs,
            pendingEntries,
          },
        },
      },
    });
    await artifacts.dumpAll(testDir, { onlyIf: params.config.artifacts.saveArtifactsOnSuccess || !!failure });
    ui.close();
    agent.socket.close();
  }

  if (failure) {
    throw failure;
  }
}
