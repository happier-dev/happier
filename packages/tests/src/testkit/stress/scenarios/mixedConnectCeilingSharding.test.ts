import { describe, expect, it } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import { buildMixedConnectCeilingShardPlans } from './mixedConnectCeilingSharding';

const baseConfig: StressConfig = {
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
    users: 10,
    machinesPerUser: 2,
    sessionsPerUser: 2,
    rpcListenersPerUser: 1,
    rpcCallsPerSecond: 20,
    messagesPerSecond: 1000,
    reconnectRate: 2,
    mixedSessionMode: 'presence-fan-in',
    mixedSetupConcurrency: 8,
    mixedConnectConcurrency: 5,
    mixedRunnerShards: 3,
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

describe('buildMixedConnectCeilingShardPlans', () => {
  it('splits users and concurrency budgets deterministically across shards', () => {
    expect(buildMixedConnectCeilingShardPlans(baseConfig)).toEqual([
      {
        shardIndex: 0,
        authIndexStart: 0,
        authIndexEndExclusive: 4,
        userCount: 4,
        mixedSetupConcurrency: 3,
        mixedConnectConcurrency: 2,
      },
      {
        shardIndex: 1,
        authIndexStart: 4,
        authIndexEndExclusive: 7,
        userCount: 3,
        mixedSetupConcurrency: 3,
        mixedConnectConcurrency: 2,
      },
      {
        shardIndex: 2,
        authIndexStart: 7,
        authIndexEndExclusive: 10,
        userCount: 3,
        mixedSetupConcurrency: 2,
        mixedConnectConcurrency: 1,
      },
    ]);
  });

  it('clamps shard count to the user count and preserves at least one concurrency slot per shard', () => {
    const config: StressConfig = {
      ...baseConfig,
      load: {
        ...baseConfig.load,
        users: 3,
        mixedSetupConcurrency: 2,
        mixedConnectConcurrency: 2,
        mixedRunnerShards: 8,
      },
    };

    expect(buildMixedConnectCeilingShardPlans(config)).toEqual([
      {
        shardIndex: 0,
        authIndexStart: 0,
        authIndexEndExclusive: 1,
        userCount: 1,
        mixedSetupConcurrency: 1,
        mixedConnectConcurrency: 1,
      },
      {
        shardIndex: 1,
        authIndexStart: 1,
        authIndexEndExclusive: 2,
        userCount: 1,
        mixedSetupConcurrency: 1,
        mixedConnectConcurrency: 1,
      },
      {
        shardIndex: 2,
        authIndexStart: 2,
        authIndexEndExclusive: 3,
        userCount: 1,
        mixedSetupConcurrency: 1,
        mixedConnectConcurrency: 1,
      },
    ]);
  });

  it('returns one shard when no explicit shard count is configured', () => {
    const config: StressConfig = {
      ...baseConfig,
      load: {
        ...baseConfig.load,
        mixedRunnerShards: undefined,
      },
    };

    expect(buildMixedConnectCeilingShardPlans(config)).toEqual([
      {
        shardIndex: 0,
        authIndexStart: 0,
        authIndexEndExclusive: 10,
        userCount: 10,
        mixedSetupConcurrency: 8,
        mixedConnectConcurrency: 5,
      },
    ]);
  });
});
