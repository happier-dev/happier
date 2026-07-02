import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

import { classifyDaemonServerWorkError } from './classifyDaemonServerWorkError';
import type {
  DaemonServerWorkBudget,
  DaemonServerWorkCounter,
  DaemonServerWorkGate,
  DaemonServerWorkGateResult,
  DaemonServerWorkLogger,
  DaemonServerWorkOutcome,
  DaemonServerWorkRequest,
  DaemonServerWorkScheduler,
  DaemonServerWorkSnapshot,
  DaemonServerWorkSupervisorLike,
} from './types';

type PurposeStats = {
  counters: Record<DaemonServerWorkCounter, number>;
};

type KeyStats = {
  lastSuccessAt: number | null;
  backoffReason: string | null;
  nextEligibleAt: number | null;
  lastTouchedAt: number;
};

type FailureLogStats = {
  loggedAt: number;
};

const DEFAULT_FAILURE_LOG_SAMPLE_INTERVAL_MS = 60_000;

const COUNTERS: readonly DaemonServerWorkCounter[] = [
  'accepted',
  'coalesced',
  'suppressed',
  'written',
  'failed',
  'deferred',
  'retried',
];

function createEmptyCounters(): Record<DaemonServerWorkCounter, number> {
  return {
    accepted: 0,
    coalesced: 0,
    suppressed: 0,
    written: 0,
    failed: 0,
    deferred: 0,
    retried: 0,
  };
}

function normalizePayloadBytes(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function createTimeoutPromise(timeoutMs: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), Math.max(0, Math.floor(timeoutMs)));
    timeout.unref?.();
  });
}

function isDaemonServerWorkOutcome(value: unknown): value is DaemonServerWorkOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = (value as Readonly<{ status?: unknown }>).status;
  return status === 'written' || status === 'deferred' || status === 'suppressed' || status === 'failed';
}

function phaseToGateResult(state: ManagedConnectionState): DaemonServerWorkGateResult {
  if (state.phase === 'online') return { status: 'open' };
  if (state.phase === 'auth_failed') return { status: 'deferred', reason: 'auth_failed' };
  if (state.phase === 'shutting_down') return { status: 'deferred', reason: 'shutting_down' };
  return { status: 'deferred', reason: 'offline' };
}

export function createDaemonServerWorkGateFromSupervisor(supervisor: DaemonServerWorkSupervisorLike): DaemonServerWorkGate {
  return () => phaseToGateResult(supervisor.getState());
}

export function createDaemonServerWorkScheduler(params: Readonly<{
  budget: DaemonServerWorkBudget;
  gate?: DaemonServerWorkGate;
  logger?: DaemonServerWorkLogger;
  failureLogSampleIntervalMs?: number;
  maxTrackedKeys?: number;
  now?: () => number;
}>): DaemonServerWorkScheduler {
  const purposeStats = new Map<string, PurposeStats>();
  const keyStats = new Map<string, KeyStats>();
  const pendingByKey = new Map<string, { count: number; payloadBytes: number }>();
  const activeOutcomes = new Set<Promise<DaemonServerWorkOutcome>>();
  const failureLogByKeyReason = new Map<string, FailureLogStats>();
  const now = params.now ?? Date.now;
  const failureLogSampleIntervalMs = Math.max(
    0,
    Math.floor(params.failureLogSampleIntervalMs ?? DEFAULT_FAILURE_LOG_SAMPLE_INTERVAL_MS),
  );
  const maxTrackedKeys = Math.max(1, Math.trunc(params.maxTrackedKeys ?? 256));

  function getPurposeStats(purpose: string): PurposeStats {
    const existing = purposeStats.get(purpose);
    if (existing) return existing;
    const created = { counters: createEmptyCounters() };
    purposeStats.set(purpose, created);
    return created;
  }

  function deleteFailureLogStateForKey(key: string): void {
    const prefix = `${key}\u0000`;
    for (const logKey of failureLogByKeyReason.keys()) {
      if (logKey.startsWith(prefix)) {
        failureLogByKeyReason.delete(logKey);
      }
    }
  }

  function evictTrackedKeys(protectedKey?: string): void {
    while (keyStats.size > maxTrackedKeys) {
      let oldestKey: string | null = null;
      let oldestTouchedAt = Number.POSITIVE_INFINITY;
      for (const [key, stats] of keyStats.entries()) {
        if (protectedKey !== undefined && key === protectedKey) continue;
        if (pendingByKey.has(key)) continue;
        if (stats.lastTouchedAt < oldestTouchedAt) {
          oldestTouchedAt = stats.lastTouchedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      keyStats.delete(oldestKey);
      deleteFailureLogStateForKey(oldestKey);
    }
  }

  function getKeyStats(key: string, timestampMs: number): KeyStats {
    const existing = keyStats.get(key);
    if (existing) {
      existing.lastTouchedAt = timestampMs;
      return existing;
    }
    const created = {
      lastSuccessAt: null,
      backoffReason: null,
      nextEligibleAt: null,
      lastTouchedAt: timestampMs,
    };
    keyStats.set(key, created);
    evictTrackedKeys(key);
    return created;
  }

  function increment(purpose: string, counter: DaemonServerWorkCounter): void {
    getPurposeStats(purpose).counters[counter] += 1;
  }

  function addPending(key: string, payloadBytes: number): void {
    const existing = pendingByKey.get(key);
    const normalizedBytes = normalizePayloadBytes(payloadBytes);
    if (existing) {
      existing.count += 1;
      existing.payloadBytes += normalizedBytes;
      return;
    }
    pendingByKey.set(key, { count: 1, payloadBytes: normalizedBytes });
  }

  function removePending(key: string, payloadBytes: number): void {
    const existing = pendingByKey.get(key);
    if (!existing) return;
    existing.count -= 1;
    existing.payloadBytes = Math.max(0, existing.payloadBytes - normalizePayloadBytes(payloadBytes));
    if (existing.count <= 0) {
      pendingByKey.delete(key);
      evictTrackedKeys();
    }
  }

  function shouldLogFailure(key: string, reason: string, timestampMs: number): boolean {
    const logKey = `${key}\u0000${reason}`;
    const previous = failureLogByKeyReason.get(logKey);
    if (!previous || timestampMs - previous.loggedAt >= failureLogSampleIntervalMs) {
      failureLogByKeyReason.set(logKey, { loggedAt: timestampMs });
      return true;
    }
    return false;
  }

  async function waitForActiveOutcomes(timeoutMs: number): Promise<Readonly<{ timedOut: boolean }>> {
    const active = Array.from(activeOutcomes);
    if (active.length === 0) return await params.budget.awaitIdle(timeoutMs);
    const result = await Promise.race([
      Promise.allSettled(active).then(() => 'idle' as const),
      createTimeoutPromise(timeoutMs),
    ]);
    if (result === 'timeout') return { timedOut: true };
    return await params.budget.awaitIdle(0);
  }

  async function runWork<TPayload>(work: DaemonServerWorkRequest<TPayload>): Promise<DaemonServerWorkOutcome> {
    const purpose = String(work.purpose);
    const key = String(work.key);
    const payloadBytes = normalizePayloadBytes(work.payloadBytes);
    increment(purpose, 'accepted');

    const currentTime = now();
    const stats = getKeyStats(key, currentTime);
    if (stats.nextEligibleAt !== null && stats.nextEligibleAt > currentTime) {
      increment(purpose, 'deferred');
      return { status: 'deferred', reason: stats.backoffReason ?? 'backoff', retryAfterMs: stats.nextEligibleAt - currentTime };
    }

    const gateResult = params.gate?.() ?? { status: 'open' };
    if (gateResult.status === 'deferred') {
      increment(purpose, 'deferred');
      return { status: 'deferred', reason: gateResult.reason, retryAfterMs: gateResult.retryAfterMs };
    }
    if (gateResult.status === 'suppressed') {
      increment(purpose, 'suppressed');
      return { status: 'suppressed', reason: gateResult.reason };
    }

    addPending(key, payloadBytes);
    try {
      const workOutcome = await params.budget.run({ purpose }, async () => {
        return await work.run(work.payload);
      });
      if (isDaemonServerWorkOutcome(workOutcome)) {
        if (workOutcome.status === 'written') {
          const completedAt = now();
          stats.lastSuccessAt = completedAt;
          stats.backoffReason = null;
          stats.nextEligibleAt = null;
          increment(purpose, 'written');
          return workOutcome;
        }
        if (workOutcome.status === 'deferred') {
          increment(purpose, 'deferred');
          stats.backoffReason = workOutcome.reason;
          stats.nextEligibleAt = typeof workOutcome.retryAfterMs === 'number'
            ? now() + Math.max(0, Math.trunc(workOutcome.retryAfterMs))
            : null;
          return workOutcome;
        }
        if (workOutcome.status === 'suppressed') {
          increment(purpose, 'suppressed');
          return workOutcome;
        }
        increment(purpose, 'failed');
        if (workOutcome.classification.retryable) {
          increment(purpose, 'retried');
          stats.backoffReason = workOutcome.classification.kind;
          stats.nextEligibleAt = now() + (workOutcome.classification.retryAfterMs ?? 0);
        }
        return workOutcome;
      }
      const completedAt = now();
      stats.lastSuccessAt = completedAt;
      stats.backoffReason = null;
      stats.nextEligibleAt = null;
      increment(purpose, 'written');
      return { status: 'written' };
    } catch (error) {
      const classification = classifyDaemonServerWorkError(error);
      increment(purpose, 'failed');
      const failedAt = now();
      if (classification.retryable) {
        increment(purpose, 'retried');
        stats.backoffReason = classification.kind;
        stats.nextEligibleAt = failedAt + (classification.retryAfterMs ?? 0);
      }
      if (shouldLogFailure(key, classification.kind, failedAt)) {
        params.logger?.warn?.('[DAEMON SERVER WORK] Background server work failed', {
          purpose,
          kind: work.kind,
          key,
          classification,
        });
      }
      return { status: 'failed', classification };
    } finally {
      removePending(key, payloadBytes);
    }
  }

  return {
    enqueue(work) {
      const outcome = runWork(work);
      activeOutcomes.add(outcome);
      void outcome.finally(() => {
        activeOutcomes.delete(outcome);
      });
      return outcome;
    },
    recordEvent(event) {
      const purpose = String(event.purpose);
      if (!COUNTERS.includes(event.type)) return;
      increment(purpose, event.type);
      if (event.type === 'written') {
        const timestampMs = now();
        const stats = getKeyStats(String(event.key), timestampMs);
        stats.lastSuccessAt = timestampMs;
        stats.backoffReason = null;
        stats.nextEligibleAt = null;
      }
    },
    getSnapshot(): DaemonServerWorkSnapshot {
      const currentTime = now();
      const purposes: DaemonServerWorkSnapshot['purposes'] = {};
      for (const [purpose, stats] of purposeStats.entries()) {
        purposes[purpose] = { counters: { ...stats.counters } };
      }
      const keys: DaemonServerWorkSnapshot['keys'] = {};
      for (const [key, stats] of keyStats.entries()) {
        keys[key] = {
          timeSinceLastSuccessMs: stats.lastSuccessAt === null ? null : Math.max(0, currentTime - stats.lastSuccessAt),
          backoffReason: stats.backoffReason,
          nextEligibleAt: stats.nextEligibleAt,
        };
      }
      let pendingPayloadBytes = 0;
      for (const pending of pendingByKey.values()) pendingPayloadBytes += pending.payloadBytes;
      return { pendingKeyCount: pendingByKey.size, pendingPayloadBytes, purposes, keys };
    },
    async flushAll(timeoutMs) {
      return await waitForActiveOutcomes(timeoutMs);
    },
  };
}
