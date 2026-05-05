import { describe, expect, it } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import { buildMixedRealisticWorkload } from './mixedRealisticWorkload';

const baseConfig: StressConfig = {
  targetMode: 'full-compose',
  baseUrl: 'http://127.0.0.1:43080',
  repeat: 1,
  seed: 42,
  flakeRetry: false,
  socketTransport: 'websocket',
  duration: {
    warmupMs: 1_000,
    durationMs: 20_000,
    cooldownMs: 1_000,
    soakMs: 5_000,
  },
  load: {
    users: 250,
    machinesPerUser: 2,
    sessionsPerUser: 2,
    rpcListenersPerUser: 1,
    rpcCallsPerSecond: 10,
    messagesPerSecond: 250,
    reconnectRate: 2,
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
    imageBuildStrategy: 'never',
    reuseRunningTopology: true,
    gatewayPort: undefined,
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

describe('buildMixedRealisticWorkload', () => {
  it('derives a representative combined workload from the canonical stress knobs', () => {
    expect(buildMixedRealisticWorkload(baseConfig)).toMatchObject({
      sessionCount: 250,
      rpcListenerCount: 125,
      rpcReadinessProbeCount: 125,
      messageCount: 5_000,
      reconnectCycles: 40,
      verificationSessionCount: 8,
      presencePulseCollectorCount: 0,
    });
  });

  it('can switch to presence-fan-in mode for mixed campaigns that need real machine/session cardinality', () => {
    expect(
      buildMixedRealisticWorkload({
        ...baseConfig,
        load: {
          ...baseConfig.load,
          users: 1000,
          machinesPerUser: 2,
          sessionsPerUser: 2,
          rpcReadinessProbeLimit: 32,
          mixedSessionMode: 'presence-fan-in',
        },
      }),
    ).toMatchObject({
      sessionCount: 4000,
      rpcListenerCount: 2000,
      rpcReadinessProbeCount: 32,
      messageCount: 20_000,
      reconnectCycles: 40,
      verificationSessionCount: 8,
      presencePulseCollectorCount: 4000,
    });
  });

  it('keeps non-full-compose workloads bounded for developer iteration', () => {
    expect(
      buildMixedRealisticWorkload({
        ...baseConfig,
        targetMode: 'light',
        load: {
          ...baseConfig.load,
          users: 50,
          machinesPerUser: 3,
          sessionsPerUser: 2,
          rpcListenersPerUser: 2,
          rpcCallsPerSecond: 20,
          messagesPerSecond: 40,
          reconnectRate: 3,
          mixedSessionMode: 'representative',
        },
      }),
    ).toMatchObject({
      sessionCount: 12,
      rpcListenerCount: 6,
      rpcReadinessProbeCount: 6,
      messageCount: 60,
      reconnectCycles: 10,
      verificationSessionCount: 6,
      presencePulseCollectorCount: 0,
    });
  });

  it('never returns zero-sized mixed workloads', () => {
    expect(
      buildMixedRealisticWorkload({
        ...baseConfig,
        duration: {
          warmupMs: 0,
          durationMs: 1_000,
          cooldownMs: 0,
          soakMs: 0,
        },
        load: {
          users: 1,
          machinesPerUser: 1,
          sessionsPerUser: 1,
          rpcListenersPerUser: 1,
          rpcCallsPerSecond: 1,
          messagesPerSecond: 1,
          reconnectRate: 0,
          mixedSessionMode: 'representative',
        },
      }),
    ).toMatchObject({
      sessionCount: 1,
      rpcListenerCount: 1,
      rpcReadinessProbeCount: 1,
      messageCount: 5,
      reconnectCycles: 1,
      verificationSessionCount: 1,
      presencePulseCollectorCount: 0,
    });
  });

  it('allows zero active sessions when the mixed-active percent is explicitly disabled', () => {
    expect(
      buildMixedRealisticWorkload({
        ...baseConfig,
        load: {
          ...baseConfig.load,
          users: 4,
          mixedActiveSessionPercent: 0,
        },
      }),
    ).toMatchObject({
      sessionCount: 4,
      activeSessionCount: 0,
      rpcListenerCount: 2,
      rpcReadinessProbeCount: 2,
    });
  });

  it('assigns representative mixed sessions to distinct auth users', () => {
    expect(
      buildMixedRealisticWorkload({
        ...baseConfig,
        load: {
          ...baseConfig.load,
          users: 4,
          machinesPerUser: 2,
          sessionsPerUser: 2,
          mixedSessionMode: 'representative',
        },
      }).sessionPlans,
    ).toEqual([
      { authIndex: 0, sessionSlot: 0 },
      { authIndex: 1, sessionSlot: 0 },
      { authIndex: 2, sessionSlot: 0 },
      { authIndex: 3, sessionSlot: 0 },
    ]);
  });

  it('round-robins presence-fan-in sessions across auth users before allocating another slot', () => {
    expect(
      buildMixedRealisticWorkload({
        ...baseConfig,
        load: {
          ...baseConfig.load,
          users: 3,
          machinesPerUser: 1,
          sessionsPerUser: 2,
          mixedSessionMode: 'presence-fan-in',
        },
      }).sessionPlans,
    ).toEqual([
      { authIndex: 0, sessionSlot: 0 },
      { authIndex: 1, sessionSlot: 0 },
      { authIndex: 2, sessionSlot: 0 },
      { authIndex: 0, sessionSlot: 1 },
      { authIndex: 1, sessionSlot: 1 },
      { authIndex: 2, sessionSlot: 1 },
    ]);
  });
});
