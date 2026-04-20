import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { RunDirs } from '../../runDir';
import type { StressConfig } from '../config/stressScenarioSchema';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { runMixedConnectCeilingScenario } from './runMixedConnectCeilingScenario';

const config: StressConfig = {
  targetMode: 'full-compose',
  baseUrl: undefined,
  repeat: 1,
  seed: 42,
  flakeRetry: false,
  socketTransport: 'websocket',
  duration: {
    warmupMs: 1000,
    durationMs: 20000,
    cooldownMs: 1000,
    soakMs: 5000,
  },
  load: {
    users: 4,
    machinesPerUser: 2,
    sessionsPerUser: 2,
    rpcListenersPerUser: 1,
    rpcCallsPerSecond: 20,
    messagesPerSecond: 1000,
    reconnectRate: 2,
    mixedSessionMode: 'presence-fan-in',
    mixedSetupConcurrency: 8,
    mixedConnectConcurrency: 8,
    mixedRunnerShards: 2,
  },
  orchestration: {
    rollingRestartEnabled: false,
    killTarget: 'none',
    expectedApiReplicas: 4,
    expectedWorkerReplicas: 2,
  },
  compose: {
    apiReplicas: 4,
    workerReplicas: 2,
    imageBuildStrategy: 'never',
    reuseRunningTopology: false,
    frontDoorMode: 'gateway',
    metricsEnabled: true,
    filesBackend: 's3',
  },
  artifacts: {
    saveArtifactsOnSuccess: false,
    metricsScrapeEnabled: true,
    keepTopologyOnFailure: false,
    summaryOutputPath: undefined,
  },
};

function createRunFixture(): RunDirs {
  const runDir = mkdtempSync(join(tmpdir(), 'happier-mixed-connect-ceiling-'));
  return {
    runId: 'run-id',
    runDir,
    testDir: (testName: string) => {
      const dir = join(runDir, testName);
      return dir;
    },
  };
}

const target: StartedStressTarget = {
  mode: 'full-compose',
  baseUrl: 'http://127.0.0.1:43080',
  topology: {
    kind: 'full-compose',
    composeProjectName: 'compose-project',
    services: ['gateway', 'api', 'worker'],
    expectedApiReplicas: 4,
    expectedWorkerReplicas: 2,
    resolvedApiReplicas: 4,
    resolvedWorkerReplicas: 2,
    baseUrl: 'http://127.0.0.1:43080',
    ports: {
      gateway: 43080,
    },
  },
  preserveForInspection: () => {},
  stop: async () => {},
  collectDiagnostics: async () => {},
};

describe('runMixedConnectCeilingScenario', () => {
  it('launches shard workers, aggregates outputs, and finalizes one combined summary', async () => {
    const run = createRunFixture();
    const finalized = vi.fn(async () => ({
      summaryFile: join(run.runDir, 'summary.json'),
      manifestFile: join(run.runDir, 'manifest.json'),
    }));

    await runMixedConnectCeilingScenario(
      {
        run,
        target,
        config,
      },
      {
        repoRootDir: () => '/repo/root',
        runLoggedCommand: vi.fn(async (params) => {
          const requestPath = params.args.at(-1);
          if (!requestPath) {
            throw new Error('missing shard request path');
          }
          const request = JSON.parse(readFileSync(requestPath, 'utf8')) as {
            outputPath: string;
            shardPlan: {
              shardIndex: number;
              authIndexStart: number;
              authIndexEndExclusive: number;
              userCount: number;
            };
          };
          const machineCollectorsTotal = request.shardPlan.userCount * config.load.machinesPerUser * config.load.sessionsPerUser;
          const connectedMachineCollectors = request.shardPlan.shardIndex === 0 ? machineCollectorsTotal : machineCollectorsTotal - 1;
          writeFileSync(
            request.outputPath,
            `${JSON.stringify({
              shardIndex: request.shardPlan.shardIndex,
              authIndexStart: request.shardPlan.authIndexStart,
              authIndexEndExclusive: request.shardPlan.authIndexEndExclusive,
              userDevicesTotal: request.shardPlan.userCount,
              connectedUserDevices: request.shardPlan.userCount,
              machineCollectorsTotal,
              connectedMachineCollectors,
              connectivitySnapshot: {
                userDevices: {
                  total: request.shardPlan.userCount,
                  connected: request.shardPlan.userCount,
                  disconnectedAuthIndexes: [],
                  disconnectedSample: [],
                },
                machineCollectors: {
                  total: machineCollectorsTotal,
                  connected: connectedMachineCollectors,
                  disconnectedCount: machineCollectorsTotal - connectedMachineCollectors,
                  disconnectedSample: [],
                },
              },
              stageDurationsMs: {
                authMs: 100,
                provisionMs: 200,
                connectMs: 300,
              },
            }, null, 2)}\n`,
            'utf8',
          );
        }),
        scrapeMixedRealisticFullComposeMetrics: vi.fn(async () => ({
          api: { websocket_connections_active: 1234 },
        })),
        finalizeStressScenario: finalized,
      },
    ).catch((error: unknown) => error);

    expect(finalized).toHaveBeenCalledTimes(1);
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      counts: expect.objectContaining({
        shardCount: 2,
        userDevices: 4,
        connectedUserDevices: 4,
        machineSockets: 16,
        connectedCollectors: 15,
      }),
      metrics: expect.objectContaining({
        api: { websocket_connections_active: 1234 },
        shardPlans: expect.arrayContaining([
          expect.objectContaining({ shardIndex: 0, userCount: 2 }),
          expect.objectContaining({ shardIndex: 1, userCount: 2 }),
        ]),
        shardResults: expect.arrayContaining([
          expect.objectContaining({ shardIndex: 0, connectedMachineCollectors: 8 }),
          expect.objectContaining({ shardIndex: 1, connectedMachineCollectors: 7 }),
        ]),
      }),
    }));
  });
});
