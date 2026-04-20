import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import { attachRunningFullComposeStressTarget } from './attachRunningFullComposeStressTarget';

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
    users: 10,
    machinesPerUser: 1,
    sessionsPerUser: 1,
    rpcListenersPerUser: 1,
    rpcCallsPerSecond: 2,
    messagesPerSecond: 2,
    reconnectRate: 0,
    mixedSessionMode: 'representative',
  },
  orchestration: {
    rollingRestartEnabled: false,
    killTarget: 'none',
    expectedApiReplicas: 2,
    expectedWorkerReplicas: 1,
  },
  compose: {
    apiReplicas: 2,
    workerReplicas: 1,
    imageBuildStrategy: 'if-missing',
    reuseRunningTopology: true,
    frontDoorMode: 'gateway',
    gatewayPort: undefined,
    apiDirectPort: undefined,
    postgresPort: undefined,
    redisPort: undefined,
    minioPort: undefined,
    minioConsolePort: undefined,
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

describe('attachRunningFullComposeStressTarget', () => {
  it('attaches to the latest running compose topology and exposes admin hooks without tearing it down on stop', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-attach-'));
    const generatedEnvFile = join(testDir, 'env.generated.json');
    const gatewayConfigFile = join(testDir, 'nginx.conf');
    writeFileSync(generatedEnvFile, JSON.stringify({
      compose: {
        apiReplicas: 2,
        workerReplicas: 1,
        frontDoorMode: 'gateway',
        metricsEnabled: true,
        filesBackend: 's3',
      },
      ports: {
        gateway: 43080,
        postgres: 45432,
        redis: 46379,
        minio: 49000,
        minioConsole: 49001,
      },
    }), 'utf8');
    writeFileSync(gatewayConfigFile, 'server { listen 8080; }\n', 'utf8');

    const runtime = {
      down: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      stopContainer: vi.fn(async () => {}),
      killContainer: vi.fn(async () => {}),
      ps: vi.fn(async () => '[]'),
      logs: vi.fn(async () => 'compose logs'),
      execCapture: vi.fn(async () => 'worker metrics'),
      inspectContainers: vi.fn(async () => []),
      serviceContainerIds: vi.fn(async () => []),
    };

    const target = await attachRunningFullComposeStressTarget(
      {
        config,
        testDir,
      },
      {
        latestComposeStatePath: () => join(testDir, 'latest-full-compose.json'),
        readLatestComposeState: () => ({
          baseUrl: 'http://127.0.0.1:43080',
          composeProjectName: 'compose-running',
          composeFilePath: '/tmp/docker-compose.yml',
          gatewayConfigFile,
          generatedEnvFile,
          dockerLogsFile: '/tmp/docker-compose.logs.txt',
          dockerPsFile: '/tmp/docker-compose.ps.txt',
          repoRootDir: '/repo/root',
          status: 'running',
          preserved: false,
        }),
        createComposeRuntime: vi.fn(() => runtime as never),
        waitForComposeTopology: vi.fn(async () => {}),
        waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
        inspectComposeTopology: vi.fn(async () => ({
          services: ['postgres', 'redis', 'api', 'worker', 'gateway'],
          resolvedApiReplicas: 2,
          resolvedWorkerReplicas: 1,
          ports: {
            gateway: 43080,
            postgres: 45432,
            redis: 46379,
            minio: 49000,
            minioConsole: 49001,
          },
        })),
        repoRootDir: () => '/repo/root',
      },
    );

    expect(target.baseUrl).toBe('http://127.0.0.1:43080');
    expect(target.topology.composeProjectName).toBe('compose-running');
    expect(target.topology.resolvedApiReplicas).toBe(2);

    const updatedGatewayConfig = await target.admin?.writeGatewayConfig('override.nginx.conf', 'server { listen 8081; }\n');
    expect(updatedGatewayConfig).toContain('override.nginx.conf');
    await target.admin?.activateGatewayConfig(updatedGatewayConfig ?? '');
    expect(runtime.restart).toHaveBeenCalledWith('gateway');

    await target.restartService?.('api');
    expect(runtime.restart).toHaveBeenCalledWith('api');

    await target.stop();
    expect(runtime.down).not.toHaveBeenCalled();
  });

  it('fails fast when the running topology shape does not match the requested compose metrics setting', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-stress-attach-'));
    const generatedEnvFile = join(testDir, 'env.generated.json');
    writeFileSync(generatedEnvFile, JSON.stringify({
      compose: {
        apiReplicas: 2,
        workerReplicas: 1,
        frontDoorMode: 'gateway',
        metricsEnabled: false,
        filesBackend: 's3',
      },
      ports: {
        gateway: 43080,
      },
    }), 'utf8');

    await expect(
      attachRunningFullComposeStressTarget(
        {
          config,
          testDir,
        },
        {
          latestComposeStatePath: () => join(testDir, 'latest-full-compose.json'),
          readLatestComposeState: () => ({
            baseUrl: 'http://127.0.0.1:43080',
            composeProjectName: 'compose-running',
            composeFilePath: '/tmp/docker-compose.yml',
            generatedEnvFile,
            repoRootDir: '/repo/root',
            status: 'running',
            preserved: false,
          }),
          createComposeRuntime: vi.fn(() => ({
            down: vi.fn(async () => {}),
          }) as never),
          waitForComposeTopology: vi.fn(async () => {}),
          waitForComposeRpcGatewayReadiness: vi.fn(async () => {}),
          inspectComposeTopology: vi.fn(async () => ({
            services: ['postgres', 'redis', 'api', 'worker', 'gateway'],
            resolvedApiReplicas: 2,
            resolvedWorkerReplicas: 1,
            ports: {
              gateway: 43080,
            },
          })),
          repoRootDir: () => '/repo/root',
        },
      ),
    ).rejects.toThrow(/metricsEnabled/);
  });
});
