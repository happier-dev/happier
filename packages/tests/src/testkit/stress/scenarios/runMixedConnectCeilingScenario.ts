import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRootDir } from '../../paths';
import type { RunDirs } from '../../runDir';
import { runLoggedCommand } from '../../process/spawnProcess';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { buildMixedConnectCeilingShardPlans, type MixedConnectCeilingShardPlan } from './mixedConnectCeilingSharding';
import { scrapeMixedRealisticFullComposeMetrics } from './runMixedRealisticScenario';
import { runStressTasksWithConcurrencyLimit } from './runStressTasksWithConcurrencyLimit';

type MixedConnectCeilingShardRequest = Readonly<{
  baseUrl: string;
  config: StressConfig;
  shardPlan: MixedConnectCeilingShardPlan;
  outputPath: string;
}>;

type MixedConnectCeilingConnectivitySnapshot = Readonly<{
  userDevices: {
    total: number;
    connected: number;
    disconnectedAuthIndexes: number[];
    disconnectedSample: Array<{
      authIndex: number;
      disconnectedDeviceCount: number;
      devices: Array<{
        deviceIndex: number;
        lastConnectError?: {
          at: number;
          message: string;
        };
        lastDisconnect?: {
          at: number;
          reason?: string;
        };
      }>;
    }>;
  };
  machineCollectors: {
    total: number;
    connected: number;
    disconnectedCount: number;
    disconnectedSample: Array<{
      sessionId: string;
      machineId: string;
      authIndex: number;
      lastConnectError?: {
        at: number;
        message: string;
      };
      lastDisconnect?: {
        at: number;
        reason?: string;
      };
    }>;
  };
}>;

export type MixedConnectCeilingShardResult = Readonly<{
  shardIndex: number;
  authIndexStart: number;
  authIndexEndExclusive: number;
  userDevicesTotal: number;
  connectedUserDevices: number;
  machineCollectorsTotal: number;
  connectedMachineCollectors: number;
  connectivitySnapshot: MixedConnectCeilingConnectivitySnapshot;
  stageDurationsMs: {
    authMs: number;
    provisionMs: number;
    connectMs: number;
  };
}>;

type MixedConnectCeilingScenarioDeps = Readonly<{
  repoRootDir: typeof repoRootDir;
  runLoggedCommand: typeof runLoggedCommand;
  scrapeMixedRealisticFullComposeMetrics: typeof scrapeMixedRealisticFullComposeMetrics;
  finalizeStressScenario: typeof finalizeStressScenario;
}>;

const defaultDeps: MixedConnectCeilingScenarioDeps = {
  repoRootDir,
  runLoggedCommand,
  scrapeMixedRealisticFullComposeMetrics,
  finalizeStressScenario,
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readShardResult(outputPath: string): MixedConnectCeilingShardResult | undefined {
  try {
    return JSON.parse(readFileSync(outputPath, 'utf8')) as MixedConnectCeilingShardResult;
  } catch {
    return undefined;
  }
}

function aggregateConnectivitySnapshot(
  shardResults: readonly MixedConnectCeilingShardResult[],
  disconnectedSampleLimit = 16,
): MixedConnectCeilingConnectivitySnapshot {
  const disconnectedUserSample = shardResults
    .flatMap((result) => result.connectivitySnapshot.userDevices.disconnectedSample)
    .slice(0, disconnectedSampleLimit);
  const disconnectedCollectorSample = shardResults
    .flatMap((result) => result.connectivitySnapshot.machineCollectors.disconnectedSample)
    .slice(0, disconnectedSampleLimit);

  return {
    userDevices: {
      total: shardResults.reduce((sum, result) => sum + result.connectivitySnapshot.userDevices.total, 0),
      connected: shardResults.reduce((sum, result) => sum + result.connectivitySnapshot.userDevices.connected, 0),
      disconnectedAuthIndexes: shardResults.flatMap((result) => result.connectivitySnapshot.userDevices.disconnectedAuthIndexes),
      disconnectedSample: disconnectedUserSample,
    },
    machineCollectors: {
      total: shardResults.reduce((sum, result) => sum + result.connectivitySnapshot.machineCollectors.total, 0),
      connected: shardResults.reduce((sum, result) => sum + result.connectivitySnapshot.machineCollectors.connected, 0),
      disconnectedCount: shardResults.reduce((sum, result) => sum + result.connectivitySnapshot.machineCollectors.disconnectedCount, 0),
      disconnectedSample: disconnectedCollectorSample,
    },
  };
}

export async function runMixedConnectCeilingScenario(
  params: {
    run: RunDirs;
    target: StartedStressTarget;
    config: StressConfig;
  },
  deps: MixedConnectCeilingScenarioDeps = defaultDeps,
): Promise<void> {
  const testDir = params.run.testDir('mixed-connect-ceiling');
  mkdirSync(testDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const shardPlans = buildMixedConnectCeilingShardPlans(params.config);
  const shardResults: MixedConnectCeilingShardResult[] = [];
  let metrics: Record<string, unknown> = {};
  let failure: unknown;

  try {
    const settledShardResults = await Promise.allSettled(
      shardPlans.map(async (shardPlan) => {
        const shardPrefix = `shard-${shardPlan.shardIndex}`;
        const requestPath = join(testDir, `${shardPrefix}.request.json`);
        const outputPath = join(testDir, `${shardPrefix}.result.json`);
        const stdoutPath = join(testDir, `${shardPrefix}.stdout.log`);
        const stderrPath = join(testDir, `${shardPrefix}.stderr.log`);
        const request: MixedConnectCeilingShardRequest = {
          baseUrl: params.target.baseUrl,
          config: {
            ...params.config,
            load: {
              ...params.config.load,
              users: shardPlan.userCount,
              mixedSetupConcurrency: shardPlan.mixedSetupConcurrency,
              mixedConnectConcurrency: shardPlan.mixedConnectConcurrency,
              mixedRunnerShards: 1,
            },
          },
          shardPlan,
          outputPath,
        };
        writeJson(requestPath, request);
        await deps.runLoggedCommand({
          command: process.execPath,
          args: [
            'scripts/runTsxEntrypoint.mjs',
            'src/testkit/stress/cli/runMixedConnectCeilingShard.ts',
            requestPath,
          ],
          cwd: deps.repoRootDir(),
          stdoutPath,
          stderrPath,
          env: process.env,
          timeoutMs: Math.max(300_000, params.config.duration.durationMs + params.config.duration.soakMs + 120_000),
        });
        const result = readShardResult(outputPath);
        if (!result) {
          throw new Error(`Missing shard result output for ${shardPrefix}`);
        }
        return result;
      }),
    );

    for (const settled of settledShardResults) {
      if (settled.status === 'fulfilled') {
        shardResults.push(settled.value);
        continue;
      }
      if (!failure) {
        failure = settled.reason instanceof Error ? settled.reason : new Error(String(settled.reason));
      }
    }

    if (!failure) {
      const aggregated = aggregateConnectivitySnapshot(shardResults);
      if (aggregated.userDevices.connected !== aggregated.userDevices.total) {
        failure = new Error(
          `Mixed connect ceiling left ${aggregated.userDevices.total - aggregated.userDevices.connected} user devices disconnected`,
        );
      } else if (aggregated.machineCollectors.connected !== aggregated.machineCollectors.total) {
        failure = new Error(
          `Mixed connect ceiling left ${aggregated.machineCollectors.total - aggregated.machineCollectors.connected} machine collectors disconnected`,
        );
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (params.target.mode === 'full-compose' && params.config.compose.metricsEnabled && params.config.artifacts.metricsScrapeEnabled) {
      try {
        metrics = await deps.scrapeMixedRealisticFullComposeMetrics({
          target: params.target,
        });
      } catch (metricsError) {
        metrics = {
          failureMetricsError: metricsError instanceof Error ? metricsError.message : String(metricsError),
        };
      }
    }

    const aggregatedConnectivitySnapshot = aggregateConnectivitySnapshot(shardResults);
    const aggregatedStageDurationsMs = shardResults.reduce(
      (accumulator, result) => ({
        authMs: accumulator.authMs + result.stageDurationsMs.authMs,
        provisionMs: accumulator.provisionMs + result.stageDurationsMs.provisionMs,
        connectMs: accumulator.connectMs + result.stageDurationsMs.connectMs,
      }),
      { authMs: 0, provisionMs: 0, connectMs: 0 },
    );

    metrics = {
      ...metrics,
      shardPlans,
      shardResults,
      connectivitySnapshot: aggregatedConnectivitySnapshot,
      stageDurationsMs: aggregatedStageDurationsMs,
    };

    await deps.finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'mixed.connectCeiling',
      target: params.target,
      config: params.config,
      startedAt,
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        shardCount: shardPlans.length,
        userDevices: shardResults.reduce((sum, result) => sum + result.userDevicesTotal, 0),
        connectedUserDevices: shardResults.reduce((sum, result) => sum + result.connectedUserDevices, 0),
        machineSockets: shardResults.reduce((sum, result) => sum + result.machineCollectorsTotal, 0),
        connectedCollectors: shardResults.reduce((sum, result) => sum + result.connectedMachineCollectors, 0),
      },
      metrics,
    });
  }

  if (failure) {
    throw failure;
  }
}
