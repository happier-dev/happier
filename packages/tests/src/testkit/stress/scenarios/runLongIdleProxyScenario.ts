import type { RunDirs } from '../../runDir';
import { FailureArtifacts } from '../../failureArtifacts';
import { sleep, waitFor } from '../../timing';
import type { CapturedEvent } from '../../socketClient';
import type { StressConfig } from '../config/stressScenarioSchema';
import { renderStressGatewayNginxConf } from '../docker/renderStressGatewayNginxConf';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import {
  activateGatewayConfig,
  requireFullComposeAdmin,
  resolveServiceUpstreamTargets,
} from './fullComposeScenarioSupport';
import { createStressUserScopedSocketCollector } from './stressSocketCollectors';

const unsafeProxyTimeoutSeconds = 5;
const safeProxyTimeoutSeconds = 90;
const idleObservationMs = 20_000;

function hasConnectivityFailure(events: readonly CapturedEvent[]): boolean {
  return events.some((event) => event.kind === 'connect_error' || event.kind === 'disconnect');
}

export async function runLongIdleProxyScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const testDir = params.run.testDir('proxy-long-idle-timeout');
  const startedAt = new Date().toISOString();
  const admin = requireFullComposeAdmin(params.target);
  let failure: unknown;
  let unsafeDisconnects = 0;
  let safeDisconnects = 0;

  if (!admin) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'proxy.longIdleTimeout',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: 'passed',
      counts: {
        idleConnections: 0,
      },
      errors: {
        buckets: {
          unsupportedTopology: 1,
        },
      },
    });
    return;
  }

  const apiTargets = await resolveServiceUpstreamTargets(params.target, 'api', 53288);
  const upstreamTarget = apiTargets[0];
  if (!upstreamTarget) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'proxy.longIdleTimeout',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: 'passed',
      counts: {
        idleConnections: 0,
      },
      errors: {
        buckets: {
          missingReplicaIps: 1,
        },
      },
    });
    return;
  }

  const unsafeConfigContents = renderStressGatewayNginxConf({
    upstreamApiTargets: [upstreamTarget],
    websocketReadTimeoutSeconds: unsafeProxyTimeoutSeconds,
    websocketSendTimeoutSeconds: unsafeProxyTimeoutSeconds,
  });
  const safeConfigContents = renderStressGatewayNginxConf({
    upstreamApiTargets: [upstreamTarget],
    websocketReadTimeoutSeconds: safeProxyTimeoutSeconds,
    websocketSendTimeoutSeconds: safeProxyTimeoutSeconds,
  });
  const unsafeConfigPath = await admin.writeGatewayConfig(
    'nginx.proxy.unsafe.conf',
    unsafeConfigContents,
  );
  const safeConfigPath = await admin.writeGatewayConfig(
    'nginx.proxy.safe.conf',
    safeConfigContents,
  );

  const unsafeCollector = createStressUserScopedSocketCollector(params.target.baseUrl, params.token, {
    transports: ['websocket'],
  });
  const safeCollector = createStressUserScopedSocketCollector(params.target.baseUrl, params.token, {
    transports: ['websocket'],
  });
  const artifacts = new FailureArtifacts();
  artifacts.json('unsafe.events.json', () => unsafeCollector.getEvents());
  artifacts.json('safe.events.json', () => safeCollector.getEvents());
  artifacts.text('unsafe.gateway.conf', () => unsafeConfigContents);
  artifacts.text('safe.gateway.conf', () => safeConfigContents);

  try {
    await activateGatewayConfig(params.target, unsafeConfigPath);
    unsafeCollector.connect();
    await waitFor(() => unsafeCollector.isConnected(), { timeoutMs: 20_000 });
    await sleep(idleObservationMs);

    unsafeDisconnects = unsafeCollector.getEvents().filter((event) => event.kind === 'disconnect').length;
    if (unsafeCollector.isConnected() && unsafeDisconnects === 0) {
      throw new Error('Unsafe proxy timeout did not disconnect the idle websocket');
    }
    unsafeCollector.close();

    await activateGatewayConfig(params.target, safeConfigPath);
    safeCollector.connect();
    await waitFor(() => safeCollector.isConnected(), { timeoutMs: 20_000 });
    await sleep(idleObservationMs);

    safeDisconnects = safeCollector.getEvents().filter((event) => event.kind === 'disconnect').length;
    if (!safeCollector.isConnected() || hasConnectivityFailure(safeCollector.getEvents())) {
      throw new Error('Safe proxy timeout did not preserve the idle websocket connection');
    }
  } catch (error) {
    failure = error;
  } finally {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'proxy.longIdleTimeout',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        idleConnections: 2,
      },
      errors: {
        buckets: {
          unsafeDisconnects,
          safeDisconnects,
        },
      },
    });
    await artifacts.dumpAll(testDir, { onlyIf: params.config.artifacts.saveArtifactsOnSuccess || !!failure });
    unsafeCollector.close();
    safeCollector.close();
  }

  if (failure) {
    throw failure;
  }
}
