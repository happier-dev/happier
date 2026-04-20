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

function countConnectivityFailures(events: readonly CapturedEvent[]): number {
  return events.filter((event) => event.kind === 'connect_error' || event.kind === 'disconnect').length;
}

export async function runStickyAffinityValidationScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const testDir = params.run.testDir('sticky-affinity-validation');
  const startedAt = new Date().toISOString();
  const admin = requireFullComposeAdmin(params.target);
  let failure: unknown;
  let goodStableClients = 0;
  let badDegradedClients = 0;
  let goodConnectivityFailures = 0;
  let badConnectivityFailures = 0;

  if (!admin || params.target.topology.resolvedApiReplicas < 2) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'stickyAffinity.validation',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: 'passed',
      counts: {
        stickyClients: 0,
        nonStickyClients: 0,
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
  if (apiTargets.length < 2) {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'stickyAffinity.validation',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: 'passed',
      counts: {
        stickyClients: 0,
        nonStickyClients: 0,
      },
      errors: {
        buckets: {
          missingReplicaIps: 1,
        },
      },
    });
    return;
  }

  const stickyConfigPath = await admin.writeGatewayConfig(
    'nginx.sticky.good.conf',
    renderStressGatewayNginxConf({
      upstreamApiTargets: apiTargets,
      affinity: 'header-hash',
      stickyHeaderName: 'X-Happier-Sticky-Key',
    }),
  );
  const nonStickyConfigPath = await admin.writeGatewayConfig(
    'nginx.sticky.bad.conf',
    renderStressGatewayNginxConf({
      upstreamApiTargets: apiTargets,
      affinity: 'none',
    }),
  );
  const stickyConfigContents = renderStressGatewayNginxConf({
    upstreamApiTargets: apiTargets,
    affinity: 'header-hash',
    stickyHeaderName: 'X-Happier-Sticky-Key',
  });
  const nonStickyConfigContents = renderStressGatewayNginxConf({
    upstreamApiTargets: apiTargets,
    affinity: 'none',
  });

  const clientCount = Math.max(2, Math.min(params.config.load.users, 4));
  const stickyCollectors = Array.from({ length: clientCount }, (_, index) =>
    createStressUserScopedSocketCollector(params.target.baseUrl, params.token, {
      transports: ['polling'],
      extraHeaders: {
        'X-Happier-Sticky-Key': `sticky-client-${index + 1}`,
      },
    }),
  );
  const nonStickyCollectors = Array.from({ length: clientCount }, () =>
    createStressUserScopedSocketCollector(params.target.baseUrl, params.token, {
      transports: ['polling'],
    }),
  );

  const artifacts = new FailureArtifacts();
  artifacts.json('sticky.good.events.json', () => stickyCollectors.map((collector) => collector.getEvents()));
  artifacts.json('sticky.bad.events.json', () => nonStickyCollectors.map((collector) => collector.getEvents()));
  artifacts.text('sticky.good.gateway.conf', () => stickyConfigContents);
  artifacts.text('sticky.bad.gateway.conf', () => nonStickyConfigContents);

  try {
    await activateGatewayConfig(params.target, stickyConfigPath);
    stickyCollectors.forEach((collector) => collector.connect());
    await waitFor(() => stickyCollectors.every((collector) => collector.isConnected()), { timeoutMs: 20_000 });
    await sleep(Math.max(5_000, Math.min(15_000, params.config.duration.durationMs)));

    goodStableClients = stickyCollectors.filter((collector) => collector.isConnected()).length;
    goodConnectivityFailures = stickyCollectors.reduce(
      (total, collector) => total + countConnectivityFailures(collector.getEvents()),
      0,
    );
    if (goodStableClients !== stickyCollectors.length || goodConnectivityFailures !== 0) {
      throw new Error('Sticky polling gateway did not preserve stable client continuity');
    }

    stickyCollectors.forEach((collector) => collector.close());

    await activateGatewayConfig(params.target, nonStickyConfigPath);
    nonStickyCollectors.forEach((collector) => collector.connect());
    await sleep(Math.max(8_000, Math.min(15_000, params.config.duration.durationMs + 3_000)));

    badConnectivityFailures = nonStickyCollectors.reduce(
      (total, collector) => total + countConnectivityFailures(collector.getEvents()),
      0,
    );
    badDegradedClients = nonStickyCollectors.filter((collector) => !collector.isConnected() || countConnectivityFailures(collector.getEvents()) > 0).length;
    if (badDegradedClients === 0 && badConnectivityFailures === 0) {
      throw new Error('Non-sticky polling gateway did not degrade as expected');
    }
  } catch (error) {
    failure = error;
  } finally {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'stickyAffinity.validation',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        stickyClients: stickyCollectors.length,
        stickyStableClients: goodStableClients,
        nonStickyClients: nonStickyCollectors.length,
        nonStickyDegradedClients: badDegradedClients,
      },
      errors: {
        buckets: {
          stickyConnectivityFailures: goodConnectivityFailures,
          nonStickyConnectivityFailures: badConnectivityFailures,
        },
      },
    });
    await artifacts.dumpAll(testDir, { onlyIf: params.config.artifacts.saveArtifactsOnSuccess || !!failure });
    stickyCollectors.forEach((collector) => collector.close());
    nonStickyCollectors.forEach((collector) => collector.close());
  }

  if (failure) {
    throw failure;
  }
}
