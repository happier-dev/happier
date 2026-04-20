import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { writeStressScenarioManifest } from './writeStressScenarioManifest';

const config: StressConfig = {
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
    keepTopologyOnFailure: false,
    summaryOutputPath: undefined,
  },
};

const target: StartedStressTarget = {
  mode: 'full-compose',
  baseUrl: 'http://127.0.0.1:43080',
  topology: {
    kind: 'full-compose',
    composeProjectName: 'stress-project',
    services: ['postgres', 'redis', 'minio', 'minio-init', 'api', 'worker', 'gateway'],
    expectedApiReplicas: 2,
    expectedWorkerReplicas: 1,
    resolvedApiReplicas: 2,
    resolvedWorkerReplicas: 1,
    baseUrl: 'http://127.0.0.1:43080',
    ports: {
      gateway: 43080,
    },
  },
  artifacts: {
    composeFile: '/tmp/docker-compose.yml',
    gatewayConfigFile: '/tmp/nginx.conf',
    dockerLogsFile: '/tmp/docker-compose.logs.txt',
  },
  preserveForInspection: () => {},
  stop: async () => {},
  collectDiagnostics: async () => {},
};

describe('writeStressScenarioManifest', () => {
  it('writes final status, endedAt, summary pointer, and resolved config into the canonical manifest', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'happier-stress-manifest-'));
    const testDir = join(runDir, 'rpc-multi-replica');
    mkdirSync(testDir, { recursive: true });
    const manifestPath = writeStressScenarioManifest({
      run: {
        runId: 'run-123',
        runDir,
        testDir: () => testDir,
      },
      testDir,
      testName: 'rpc.multiReplica',
      target,
      config,
      startedAt: '2026-04-18T12:00:00.000Z',
      endedAt: '2026-04-18T12:00:02.500Z',
      sessionIds: ['session-1'],
      summaryFile: '/tmp/stress-summary.json',
      status: 'failed',
      failureClassification: 'deterministic',
      latencies: {
        p50Ms: 12,
        p95Ms: 48,
        p99Ms: 52,
        maxMs: 80,
      },
      errors: {
        buckets: {
          rpc: 2,
        },
      },
    });

    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      runId: 'run-123',
      targetMode: 'full-compose',
      scenario: {
        name: 'rpc.multiReplica',
        resolvedConfig: {
          targetMode: 'full-compose',
        },
      },
      artifacts: {
        summaryFile: '/tmp/stress-summary.json',
      },
      results: {
        status: 'failed',
        startedAt: '2026-04-18T12:00:00.000Z',
        endedAt: '2026-04-18T12:00:02.500Z',
        failureClassification: 'deterministic',
        latency: {
          p95Ms: 48,
          p99Ms: 52,
        },
        errors: {
          buckets: {
            rpc: 2,
          },
        },
      },
    });
  });
});
