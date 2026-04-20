import type { StressConfig, StressSocketTransport, StressTargetMode } from '../config/stressScenarioSchema';
import type { StartedStressTarget } from '../targets/stressTargetTypes';

export type StressLatencySummary = Readonly<{
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}>;

export type StressErrorBuckets = Readonly<{
  buckets?: Record<string, number>;
  details?: Record<string, Record<string, number>>;
}>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isFullComposeTarget(config: Pick<StressConfig, 'targetMode'>): boolean {
  return config.targetMode === 'full-compose';
}

function resolveDurationSeconds(config: StressConfig): number {
  return Math.max(1, Math.ceil(config.duration.durationMs / 1000));
}

export function resolveStressSocketTransports(
  config: Pick<StressConfig, 'socketTransport'>,
  targetMode: StressTargetMode,
): readonly StressSocketTransport[] {
  if (targetMode === 'full-compose') {
    return ['websocket'];
  }
  return [config.socketTransport];
}

export function resolveRpcListenerCount(config: StressConfig): number {
  if (isFullComposeTarget(config)) {
    return Math.max(2, config.load.users * config.load.rpcListenersPerUser);
  }
  return clamp(config.load.users * config.load.rpcListenersPerUser, 2, 12);
}

export function resolveRpcCallCount(config: StressConfig, listenerCount: number): number {
  return Math.max(listenerCount * 2, config.load.rpcCallsPerSecond * resolveDurationSeconds(config));
}

export function resolvePresenceSessionCount(config: StressConfig): number {
  if (isFullComposeTarget(config)) {
    return Math.max(1, config.load.users * config.load.machinesPerUser * config.load.sessionsPerUser);
  }
  return clamp(config.load.users * config.load.machinesPerUser * config.load.sessionsPerUser, 1, 12);
}

export function resolveReconnectMessageCount(config: StressConfig): number {
  if (isFullComposeTarget(config)) {
    return Math.max(5, config.load.messagesPerSecond * resolveDurationSeconds(config));
  }
  return clamp(config.load.messagesPerSecond * resolveDurationSeconds(config), 5, 60);
}

export function resolveReconnectCycleCount(config: StressConfig): number {
  if (isFullComposeTarget(config)) {
    return Math.max(1, config.load.reconnectRate * resolveDurationSeconds(config));
  }
  return clamp(config.load.reconnectRate * resolveDurationSeconds(config), 1, 10);
}

export function summarizeLatencySamples(samples: readonly number[]): StressLatencySummary {
  if (samples.length === 0) {
    return {
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    };
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const readPercentile = (percentile: number) => {
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile));
    return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
  };

  return {
    p50Ms: readPercentile(0.5),
    p95Ms: readPercentile(0.95),
    p99Ms: readPercentile(0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

export function flattenStressErrorBuckets(errorBuckets: StressErrorBuckets | undefined): Record<string, number> {
  const flattened: Record<string, number> = {};

  for (const [bucket, value] of Object.entries(errorBuckets?.buckets ?? {})) {
    flattened[bucket] = value;
  }

  for (const [bucket, bucketDetails] of Object.entries(errorBuckets?.details ?? {})) {
    for (const [detailKey, value] of Object.entries(bucketDetails)) {
      flattened[`${bucket}.${detailKey}`] = value;
    }
  }

  return flattened;
}

export async function stopStressTarget(target: StartedStressTarget | undefined): Promise<void> {
  await target?.stop();
}
