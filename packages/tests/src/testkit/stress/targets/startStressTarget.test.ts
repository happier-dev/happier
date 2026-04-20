import { describe, expect, it, vi } from 'vitest';

import { startStressTarget } from './startStressTarget';
import type { StressConfig } from '../config/stressScenarioSchema';
import type { StartedStressTarget } from './stressTargetTypes';

const baseConfig: StressConfig = {
  targetMode: 'light',
  baseUrl: undefined,
  repeat: 1,
  seed: undefined,
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
    rpcCallsPerSecond: 1,
    messagesPerSecond: 1,
    reconnectRate: 0,
    mixedSessionMode: 'representative',
  },
  orchestration: {
    rollingRestartEnabled: false,
    killTarget: 'none',
    expectedApiReplicas: 1,
    expectedWorkerReplicas: 0,
  },
  compose: {
    apiReplicas: 2,
    workerReplicas: 1,
    imageBuildStrategy: 'if-missing',
    reuseRunningTopology: false,
    gatewayPort: undefined,
    postgresPort: undefined,
    redisPort: undefined,
    minioPort: undefined,
    minioConsolePort: undefined,
    metricsEnabled: false,
    filesBackend: 's3',
  },
  artifacts: {
    saveArtifactsOnSuccess: false,
    metricsScrapeEnabled: false,
    keepTopologyOnFailure: false,
    summaryOutputPath: undefined,
  },
};

function createStartedStressTarget(mode: StartedStressTarget['mode']): StartedStressTarget {
  return {
    mode,
    baseUrl: 'http://127.0.0.1:43080',
    topology: {
      kind: mode,
      services: [mode],
      expectedApiReplicas: 1,
      expectedWorkerReplicas: 0,
      resolvedApiReplicas: 1,
      resolvedWorkerReplicas: 0,
      baseUrl: 'http://127.0.0.1:43080',
      ports: {},
    },
    preserveForInspection: () => {},
    stop: async () => {},
    collectDiagnostics: async () => {},
  };
}

describe('startStressTarget', () => {
  it('dispatches to the canonical light target starter', async () => {
    const startLight = vi.fn(async () => createStartedStressTarget('light'));
    const startCompose = vi.fn();
    const attachCompose = vi.fn();
    const attachExternal = vi.fn();

    await startStressTarget(
      {
        config: baseConfig,
        testDir: '/tmp/stress-target',
      },
      {
        startServerLightStressTarget: startLight,
        startFullComposeStressTarget: startCompose,
        attachRunningFullComposeStressTarget: attachCompose,
        attachExternalStressTarget: attachExternal,
      },
    );

    expect(startLight).toHaveBeenCalledTimes(1);
    expect(startCompose).not.toHaveBeenCalled();
    expect(attachCompose).not.toHaveBeenCalled();
    expect(attachExternal).not.toHaveBeenCalled();
  });

  it('dispatches to the canonical full-compose target starter', async () => {
    const startLight = vi.fn();
    const startCompose = vi.fn(async () => createStartedStressTarget('full-compose'));
    const attachCompose = vi.fn();
    const attachExternal = vi.fn();

    await startStressTarget(
      {
        config: { ...baseConfig, targetMode: 'full-compose' },
        testDir: '/tmp/stress-target',
      },
      {
        startServerLightStressTarget: startLight,
        startFullComposeStressTarget: startCompose,
        attachRunningFullComposeStressTarget: attachCompose,
        attachExternalStressTarget: attachExternal,
      },
    );

    expect(startLight).not.toHaveBeenCalled();
    expect(startCompose).toHaveBeenCalledTimes(1);
    expect(attachCompose).not.toHaveBeenCalled();
    expect(attachExternal).not.toHaveBeenCalled();
  });

  it('attaches to the canonical running full-compose target when reuse is enabled', async () => {
    const startLight = vi.fn();
    const startCompose = vi.fn();
    const attachCompose = vi.fn(async () => createStartedStressTarget('full-compose'));
    const attachExternal = vi.fn();

    await startStressTarget(
      {
        config: {
          ...baseConfig,
          targetMode: 'full-compose',
          compose: {
            ...baseConfig.compose,
            reuseRunningTopology: true,
          },
        },
        testDir: '/tmp/stress-target',
      },
      {
        startServerLightStressTarget: startLight,
        startFullComposeStressTarget: startCompose,
        attachRunningFullComposeStressTarget: attachCompose,
        attachExternalStressTarget: attachExternal,
      },
    );

    expect(startLight).not.toHaveBeenCalled();
    expect(startCompose).not.toHaveBeenCalled();
    expect(attachCompose).toHaveBeenCalledTimes(1);
    expect(attachExternal).not.toHaveBeenCalled();
  });

  it('dispatches to the canonical external target attacher', async () => {
    const startLight = vi.fn();
    const startCompose = vi.fn();
    const attachCompose = vi.fn();
    const attachExternal = vi.fn(async () => createStartedStressTarget('external'));

    await startStressTarget(
      {
        config: { ...baseConfig, targetMode: 'external', baseUrl: 'https://stress.example.com' },
        testDir: '/tmp/stress-target',
      },
      {
        startServerLightStressTarget: startLight,
        startFullComposeStressTarget: startCompose,
        attachRunningFullComposeStressTarget: attachCompose,
        attachExternalStressTarget: attachExternal,
      },
    );

    expect(startLight).not.toHaveBeenCalled();
    expect(startCompose).not.toHaveBeenCalled();
    expect(attachCompose).not.toHaveBeenCalled();
    expect(attachExternal).toHaveBeenCalledTimes(1);
  });
});
