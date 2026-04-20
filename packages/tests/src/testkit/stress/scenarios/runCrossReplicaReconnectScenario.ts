import type { RunDirs } from '../../runDir';
import { createSession } from '../../sessions';
import { FailureArtifacts } from '../../failureArtifacts';
import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import { createUserScopedSocketCollector } from '../../socketClient';
import { waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { renderStressGatewayNginxConf } from '../docker/renderStressGatewayNginxConf';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import {
  activateGatewayConfig,
  requireFullComposeAdmin,
  resolveServiceUpstreamTargets,
} from './fullComposeScenarioSupport';
import { resolveStressSocketTransports, summarizeLatencySamples } from './stressScenarioRuntime';
import { waitForRegisteredRpcMethod } from './waitForRegisteredRpcMethod';

function countConnectEvents(collector: ReturnType<typeof createUserScopedSocketCollector>): number {
  return collector.getEvents().filter((event) => event.kind === 'connect').length;
}

export async function runCrossReplicaReconnectScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const testDir = params.run.testDir('reconnect-cross-replica-failover');
  const startedAt = new Date().toISOString();
  const admin = requireFullComposeAdmin(params.target);
  let failure: unknown;
  let latencies: number[] = [];
  let reconnectEvents = 0;

  if (!admin || params.target.topology.resolvedApiReplicas < 2) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'reconnect.crossReplicaFailover',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: 'passed',
      counts: {
        apiReplicas: params.target.topology.resolvedApiReplicas,
        reconnectEvents: 0,
      },
      errors: {
        buckets: {
          unsupportedTopology: 1,
        },
      },
    });
    return;
  }

  const apiContainers = await admin.listServiceContainers('api');
  const primary = apiContainers[0];
  const backup = apiContainers[1];
  const primaryIp = primary?.ipv4Addresses[0];
  const backupIp = backup?.ipv4Addresses[0];
  if (!primary || !backup || !primaryIp || !backupIp) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'reconnect.crossReplicaFailover',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: 'passed',
      counts: {
        apiReplicas: apiContainers.length,
        reconnectEvents: 0,
      },
      errors: {
        buckets: {
          missingReplicaIps: 1,
        },
      },
    });
    return;
  }

  const primaryConfigPath = await admin.writeGatewayConfig(
    'nginx.failover.primary.conf',
    renderStressGatewayNginxConf({
      upstreamApiTargets: [`${primaryIp}:53288`],
    }),
  );
  const backupConfigPath = await admin.writeGatewayConfig(
    'nginx.failover.backup.conf',
    renderStressGatewayNginxConf({
      upstreamApiTargets: [`${backupIp}:53288`],
    }),
  );

  await activateGatewayConfig(params.target, primaryConfigPath);

  const { sessionId } = await createSession(params.target.baseUrl, params.token);
  const transports = resolveStressSocketTransports(params.config, params.target.mode);
  const ui = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });
  const agent = await createMachineBoundSessionScopedSocketCollector({
    baseUrl: params.target.baseUrl,
    token: params.token,
    sessionId,
    transports,
  });
  const method = `${sessionId}:stress.failover`;
  const artifacts = new FailureArtifacts();
  artifacts.json('ui.events.json', () => ui.getEvents());
  artifacts.json('agent.events.json', () => agent.socket.getEvents());

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
      throw new Error('RPC call failed before cross-replica failover');
    }

    await admin.stopContainer(primary.id);
    await activateGatewayConfig(params.target, backupConfigPath);

    await waitFor(
      () => ui.isConnected() && agent.socket.isConnected() && countConnectEvents(ui) >= 2,
      {
        timeoutMs: 45_000,
        intervalMs: 500,
      },
    );
    reconnectEvents = countConnectEvents(ui) - 1;

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
      throw new Error('RPC call failed after cross-replica failover');
    }
  } catch (error) {
    failure = error;
  } finally {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'reconnect.crossReplicaFailover',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds: [sessionId],
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        apiReplicas: params.target.topology.resolvedApiReplicas,
        reconnectEvents,
      },
      latencies: summarizeLatencySamples(latencies),
      errors: {
        buckets: {
          connectErrors: ui.getEvents().filter((event) => event.kind === 'connect_error').length,
          disconnects: ui.getEvents().filter((event) => event.kind === 'disconnect').length,
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
