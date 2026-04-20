import type { RunDirs } from '../../runDir';
import { createSession } from '../../sessions';
import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import { createUserScopedSocketCollector } from '../../socketClient';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { resolveStressSocketTransports } from './stressScenarioRuntime';

export async function runRollingRestartScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const testDir = params.run.testDir('rolling-restart');
  const startedAt = new Date().toISOString();
  const { sessionId } = await createSession(params.target.baseUrl, params.token);
  const transports = resolveStressSocketTransports(params.config, params.target.mode);
  let failure: unknown;
  let restarts = 0;

  if (!params.config.orchestration.rollingRestartEnabled || !params.target.restartService) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'rollingRestart',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds: [sessionId],
      seed: params.config.seed,
      status: 'passed',
      counts: {
        restarts: 0,
      },
    });
    return;
  }

  const ui = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });
  const agent = await createMachineBoundSessionScopedSocketCollector({
    baseUrl: params.target.baseUrl,
    token: params.token,
    sessionId,
    transports,
  });
  const method = `${sessionId}:stress.restart`;

  try {
    if (params.config.duration.warmupMs > 0) {
      await sleep(params.config.duration.warmupMs);
    }
    ui.connect();
    agent.socket.connect();
    await waitFor(() => ui.isConnected() && agent.socket.isConnected(), { timeoutMs: 20_000 });

    agent.socket.onRpcRequest(async () => JSON.stringify({ ok: true, machineId: agent.machineId }));
    await agent.socket.rpcRegister(method);

    const before = await ui.rpcCall<{ ok: boolean; result?: string }>(method, JSON.stringify({ step: 'before' }));
    if (!before.ok) {
      throw new Error('Initial RPC call failed before rolling restart');
    }

    await params.target.restartService(params.config.orchestration.killTarget === 'worker' ? 'worker' : 'api');
    restarts = 1;

    await waitFor(() => ui.isConnected() && agent.socket.isConnected(), { timeoutMs: 30_000 });
    await agent.socket.rpcRegister(method);

    const after = await ui.rpcCall<{ ok: boolean; result?: string }>(method, JSON.stringify({ step: 'after' }));
    if (!after.ok) {
      throw new Error('RPC call failed after rolling restart');
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
      testName: 'rollingRestart',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds: [sessionId],
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        restarts,
      },
      failures: {
        methodNotAvailable: 0,
      },
    });
    ui.close();
    agent.socket.close();
  }

  if (failure) {
    throw failure;
  }
}
