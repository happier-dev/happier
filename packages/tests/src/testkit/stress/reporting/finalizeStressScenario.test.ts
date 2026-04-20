import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
      },
    });
  });
});
