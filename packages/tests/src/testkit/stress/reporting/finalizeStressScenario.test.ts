import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { finalizeStressScenario } from './finalizeStressScenario';

const baseConfig: StressConfig = {
  targetMode: 'full-compose',
  baseUrl: undefined,
  repeat: 1,
  seed: 42,
  flakeRetry: false,
  socketTransport: 'websocket',
  duration: {
    warmupMs: 1000,
    durationMs: 10000,
    cooldownMs: 1000,
    soakMs: 0,
  },
  load: {
    users: 5,
    machinesPerUser: 1,
    sessionsPerUser: 1,
    rpcListenersPerUser: 1,
    rpcCallsPerSecond: 2,
    messagesPerSecond: 5,
    reconnectRate: 0,
    mixedSessionMode: 'representative',
  },
  orchestration: {
    rollingRestartEnabled: true,
    killTarget: 'api',
    expectedApiReplicas: 2,
    expectedWorkerReplicas: 1,
  },
  compose: {
    apiReplicas: 2,
    workerReplicas: 1,
    imageBuildStrategy: 'if-missing',
    reuseRunningTopology: false,
    gatewayPort: 43080,
    postgresPort: 45432,
    redisPort: 46379,
    minioPort: 49000,
    minioConsolePort: 49001,
    metricsEnabled: true,
    filesBackend: 's3',
  },
  artifacts: {
    saveArtifactsOnSuccess: false,
    metricsScrapeEnabled: true,
    keepTopologyOnFailure: true,
    summaryOutputPath: undefined,
  },
};

function createTarget(overrides?: Partial<StartedStressTarget>): StartedStressTarget {
  return {
    mode: 'full-compose',
    baseUrl: 'http://127.0.0.1:43080',
    topology: {
      kind: 'full-compose',
      composeProjectName: 'stress-project',
      services: ['postgres', 'redis', 'api', 'worker', 'gateway'],
      expectedApiReplicas: 2,
      expectedWorkerReplicas: 1,
      resolvedApiReplicas: 2,
      resolvedWorkerReplicas: 1,
      baseUrl: 'http://127.0.0.1:43080',
      ports: { gateway: 43080 },
    },
    preserveForInspection: vi.fn(),
    stop: async () => {},
    collectDiagnostics: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('finalizeStressScenario', () => {
  it('collects configured success diagnostics before publishing their manifest paths', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'happier-relay-cluster-finalize-'));
    const testDir = join(runDir, 'relay-cluster-compose');
    mkdirSync(testDir, { recursive: true });
    const dockerLogsFile = join(runDir, 'docker-compose.logs.txt');
    const dockerPsFile = join(runDir, 'docker-compose.ps.txt');
    const collectDiagnostics = vi.fn(async () => {
      writeFileSync(dockerLogsFile, 'compose logs\n', 'utf8');
      writeFileSync(dockerPsFile, 'compose ps\n', 'utf8');
    });
    const target = createTarget({
      artifacts: {
        dockerLogsFile,
        dockerPsFile,
      },
      collectDiagnostics,
    });

    const result = await finalizeStressScenario({
      run: {
        runId: 'relay-cluster-run',
        runDir,
        testDir: () => testDir,
      },
      testDir,
      testName: 'relay.clusterCompose',
      target,
      config: {
        ...baseConfig,
        artifacts: {
          ...baseConfig.artifacts,
          saveArtifactsOnSuccess: true,
        },
      },
      startedAt: '2026-07-29T23:00:00.000Z',
      endedAt: '2026-07-29T23:00:01.000Z',
      status: 'passed',
      counts: {
        scenarioRuns: 1,
      },
    });

    const manifest = JSON.parse(readFileSync(result.manifestFile, 'utf8')) as {
      artifacts: {
        dockerLogsFile: string;
        dockerPsFile: string;
      };
    };
    expect(collectDiagnostics).toHaveBeenCalledTimes(1);
    expect(existsSync(manifest.artifacts.dockerLogsFile)).toBe(true);
    expect(existsSync(manifest.artifacts.dockerPsFile)).toBe(true);
  });

  it('writes canonical failure artifacts and preserves the topology when configured', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'happier-stress-finalize-'));
    const testDir = join(runDir, 'rpc-multi-replica');
    mkdirSync(testDir, { recursive: true });
    const target = createTarget();

    const result = await finalizeStressScenario({
      run: {
        runId: 'run-123',
        runDir,
        testDir: () => testDir,
      },
      testDir,
      testName: 'rpc.multiReplica',
      target,
      config: {
        ...baseConfig,
        artifacts: {
          ...baseConfig.artifacts,
          summaryOutputPath: join(runDir, 'mirrored-summary.json'),
        },
      },
      startedAt: '2026-04-18T12:00:00.000Z',
      endedAt: '2026-04-18T12:00:04.000Z',
      sessionIds: ['session-1'],
      status: 'failed',
      error: new Error('boom'),
      counts: {
        calls: 2,
      },
      failures: {
        methodNotAvailable: 1,
      },
    });

    expect(target.collectDiagnostics).toHaveBeenCalledTimes(1);
    expect(target.preserveForInspection).toHaveBeenCalledTimes(1);
    expect(existsSync(result.summaryFile)).toBe(true);
    expect(existsSync(result.manifestFile)).toBe(true);
    expect(JSON.parse(readFileSync(result.summaryFile, 'utf8'))).toMatchObject({
      status: 'failed',
      durationMs: 4000,
      failures: {
        methodNotAvailable: 1,
      },
    });
    expect(JSON.parse(readFileSync(result.manifestFile, 'utf8'))).toMatchObject({
      results: {
        status: 'failed',
        endedAt: '2026-04-18T12:00:04.000Z',
        failureClassification: 'unknown',
      },
    });
  });

  it('labels only explicitly evidenced deterministic failures as deterministic', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'happier-stress-classification-'));
    const testDir = join(runDir, 'classified');
    mkdirSync(testDir, { recursive: true });
    const target = createTarget();

    const result = await finalizeStressScenario({
      run: {
        runId: 'classified-run',
        runDir,
        testDir: () => testDir,
      },
      testDir,
      testName: 'classified.scenario',
      target,
      config: baseConfig,
      startedAt: '2026-04-18T12:00:00.000Z',
      endedAt: '2026-04-18T12:00:01.000Z',
      status: 'failed',
      error: new Error('DETERMINISTIC: reproduced owner invariant'),
      counts: {},
    });

    expect(JSON.parse(readFileSync(result.manifestFile, 'utf8'))).toMatchObject({
      results: {
        failureClassification: 'deterministic',
      },
    });
  });
});
