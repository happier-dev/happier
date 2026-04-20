import { describe, expect, it, vi } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import {
  flattenStressErrorBuckets,
  resolvePresenceSessionCount,
  resolveReconnectCycleCount,
  resolveReconnectMessageCount,
  resolveRpcCallCount,
  resolveRpcListenerCount,
  resolveStressSocketTransports,
  summarizeLatencySamples,
  stopStressTarget,
} from './stressScenarioRuntime';

const config: StressConfig = {
  targetMode: 'external',
  baseUrl: 'https://stress.example.com',
  repeat: 1,
  seed: 42,
  flakeRetry: false,
  socketTransport: 'polling',
  duration: {
    warmupMs: 2000,
    durationMs: 5000,
    cooldownMs: 3000,
    soakMs: 7000,
  },
  load: {
    users: 4,
    machinesPerUser: 2,
    sessionsPerUser: 2,
    rpcListenersPerUser: 3,
    rpcCallsPerSecond: 10,
    messagesPerSecond: 6,
    reconnectRate: 2,
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

describe('stressScenarioRuntime', () => {
  it('derives transport and work budgets from the canonical stress config knobs', () => {
    expect(resolveStressSocketTransports(config, 'external')).toEqual(['polling']);
    expect(resolveStressSocketTransports({ ...config, socketTransport: 'polling' }, 'full-compose')).toEqual(['websocket']);
    expect(resolveRpcListenerCount(config)).toBe(12);
    expect(resolveRpcCallCount(config, 2)).toBe(50);
    expect(resolvePresenceSessionCount(config)).toBe(12);
    expect(resolveReconnectMessageCount(config)).toBe(30);
    expect(resolveReconnectCycleCount(config)).toBe(10);
  });

  it('keeps light and external work budgets bounded but lets full-compose use the configured scale', () => {
    const fullComposeConfig: StressConfig = {
      ...config,
      targetMode: 'full-compose',
      duration: {
        ...config.duration,
        durationMs: 20_000,
      },
      load: {
        ...config.load,
        users: 40,
        machinesPerUser: 3,
        sessionsPerUser: 2,
        rpcListenersPerUser: 2,
        rpcCallsPerSecond: 25,
        messagesPerSecond: 40,
        reconnectRate: 3,
        mixedSessionMode: 'representative',
      },
    };

    expect(resolveRpcListenerCount(fullComposeConfig)).toBe(80);
    expect(resolveRpcCallCount(fullComposeConfig, 80)).toBe(500);
    expect(resolvePresenceSessionCount(fullComposeConfig)).toBe(240);
    expect(resolveReconnectMessageCount(fullComposeConfig)).toBe(800);
    expect(resolveReconnectCycleCount(fullComposeConfig)).toBe(60);
  });

  it('stops a started target when one exists', async () => {
    const stop = vi.fn(async () => undefined);

    await stopStressTarget({
      stop,
    } as never);

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('ignores teardown when startup never produced a target', async () => {
    await expect(stopStressTarget(undefined)).resolves.toBeUndefined();
  });

  it('summarizes latency samples into canonical p50/p95/p99/max values', () => {
    expect(summarizeLatencySamples([90, 10, 60, 40, 20, 70, 30, 80, 50])).toEqual({
      p50Ms: 50,
      p95Ms: 80,
      p99Ms: 80,
      maxMs: 90,
    });
    expect(summarizeLatencySamples([])).toEqual({
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });
  });

  it('flattens structured stress error buckets into a compare-friendly numeric map', () => {
    expect(
      flattenStressErrorBuckets({
        buckets: {
          rpc: 2,
          connection: 1,
        },
        details: {
          rpc: {
            methodNotAvailable: 2,
          },
        },
      }),
    ).toEqual({
      connection: 1,
      rpc: 2,
      'rpc.methodNotAvailable': 2,
    });
  });
});
