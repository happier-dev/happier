import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import type { RunDirs } from '../../runDir';
import { createSession } from '../../sessions';
import { FailureArtifacts } from '../../failureArtifacts';
import { createUserScopedSocketCollector } from '../../socketClient';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { resolveRpcCallCount, resolveRpcListenerCount, resolveStressSocketTransports } from './stressScenarioRuntime';
import { waitForRegisteredRpcMethod } from './waitForRegisteredRpcMethod';

export async function runRpcMultiReplicaScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const testDir = params.run.testDir('rpc-multi-replica');
  const startedAt = new Date().toISOString();
  const { sessionId } = await createSession(params.target.baseUrl, params.token);
  const transports = resolveStressSocketTransports(params.config, params.target.mode);
  let failure: unknown;
  let listenerCount = 0;
  let callCount = 0;
  let latencies: number[] = [];

  if (params.target.topology.resolvedApiReplicas < 2) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'rpc.multiReplica',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds: [sessionId],
      seed: params.config.seed,
      status: 'passed',
      counts: {
        listeners: 0,
        calls: 0,
      },
    });
    return;
  }

  const ui = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });
  const listeners = Array.from({ length: resolveRpcListenerCount(params.config) }, async (_, index) => {
    const bound = await createMachineBoundSessionScopedSocketCollector({
      baseUrl: params.target.baseUrl,
      token: params.token,
      sessionId,
      transports,
    });
    return { index, ...bound };
  });
  const resolvedListeners = await Promise.all(listeners);
  const artifacts = new FailureArtifacts();
  artifacts.json('ui.events.json', () => ui.getEvents());
  artifacts.json('listener.events.json', () => resolvedListeners.map((listener) => ({
    index: listener.index,
    machineId: listener.machineId,
    events: listener.socket.getEvents(),
  })));
  try {
    if (params.config.duration.warmupMs > 0) {
      await sleep(params.config.duration.warmupMs);
    }
    ui.connect();
    resolvedListeners.forEach((listener) => listener.socket.connect());
    await waitFor(
      () => ui.isConnected() && resolvedListeners.every((listener) => listener.socket.isConnected()),
      { timeoutMs: 30_000 },
    );

    for (const listener of resolvedListeners) {
      const method = `${sessionId}:stress.rpc.${listener.index}`;
      listener.socket.onRpcRequest(async (request) => JSON.stringify({
        ok: true,
        machineId: listener.machineId,
        method,
        params: request.params,
      }));
      await listener.socket.rpcRegister(method);
    }

    for (const listener of resolvedListeners) {
      const method = `${sessionId}:stress.rpc.${listener.index}`;
      await waitForRegisteredRpcMethod({
        ui,
        method,
        expectedMachineId: listener.machineId,
      });
    }

    listenerCount = resolvedListeners.length;
    callCount = resolveRpcCallCount(params.config, resolvedListeners.length);

    for (let i = 0; i < callCount; i++) {
      const targetListener = resolvedListeners[i % resolvedListeners.length];
      const method = `${sessionId}:stress.rpc.${targetListener.index}`;
      const started = Date.now();
      const response = await ui.rpcCall<{ ok: boolean; result?: string; errorCode?: string }>(method, JSON.stringify({ i }));
      latencies.push(Date.now() - started);
      if (!response.ok || typeof response.result !== 'string') {
        throw new Error(`RPC call failed for ${method}: ${response.errorCode ?? 'unknown'}`);
      }
      const parsed = JSON.parse(response.result) as { ok?: boolean; machineId?: string };
      if (parsed.ok !== true || parsed.machineId !== targetListener.machineId) {
        throw new Error(`RPC response was routed to the wrong listener for ${method}`);
      }
    }
    if (params.config.duration.soakMs > 0) {
      await sleep(params.config.duration.soakMs);
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
      testName: 'rpc.multiReplica',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds: [sessionId],
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        listeners: listenerCount,
        calls: callCount,
      },
      latencies: summarizeLatencies(latencies),
      failures: {
        methodNotAvailable: 0,
      },
    });
    await artifacts.dumpAll(testDir, { onlyIf: params.config.artifacts.saveArtifactsOnSuccess || !!failure });
    ui.close();
    resolvedListeners.forEach((listener) => listener.socket.close());
  }

  if (failure) {
    throw failure;
  }
}

function summarizeLatencies(latencies: number[]): Record<string, number> {
  if (latencies.length === 0) return {};
  const sorted = [...latencies].sort((left, right) => left - right);
  const readPercentile = (percentile: number) => {
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile));
    return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
  };

  return {
    p50Ms: readPercentile(0.5),
    p95Ms: readPercentile(0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}
