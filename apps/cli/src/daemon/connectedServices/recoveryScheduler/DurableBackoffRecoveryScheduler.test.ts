import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRecoveryIntentFileStore } from './recoveryIntentFileStore';

type TestStatus = 'waiting' | 'checking' | 'cancelled' | 'exhausted';

type TestIntent = Readonly<{
  v: 1;
  status: TestStatus;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAtMs: number | null;
  lastError: string | null;
  terminalAtMs?: number | null;
}>;

type SchedulerModule = Readonly<{
  DurableBackoffRecoveryScheduler: new <TIntent>(deps: {
    nowMs: () => number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    jitterMs?: () => number;
	    store?: {
	      read: (sessionId: string) => unknown | null;
	      readAll?: () => ReadonlyArray<readonly [string, unknown]>;
	      write: (sessionId: string, intent: TIntent) => Promise<void> | void;
	      remove?: (sessionId: string) => Promise<void> | void;
	      prune?: (predicate: (entry: Readonly<{ sessionId: string; value: unknown }>) => boolean) => Promise<ReadonlyArray<string>> | ReadonlyArray<string>;
	    };
    normalizeIntent: (value: unknown) => TIntent | null;
    getStatus: (intent: TIntent) => TestStatus;
    getNextRetryAtMs: (intent: TIntent) => number | null;
    getAttemptCount: (intent: TIntent) => number;
    getMaxAttempts: (intent: TIntent) => number;
    terminalRecordRetentionMs?: number;
    getTerminalPruneReferenceMs?: (intent: TIntent) => number | null;
    markChecking: (intent: TIntent, attemptCount: number) => TIntent;
    markWaiting: (intent: TIntent, input: { nextRetryAtMs: number; lastError: string | null }) => TIntent;
    markCancelled: (intent: TIntent) => TIntent;
    markExhausted: (intent: TIntent, input: { lastError: string | null }) => TIntent;
    recover: (intent: TIntent, context: { sessionId: string; reason: string }) => Promise<
      | { status: 'success'; intent?: TIntent }
      | { status: 'wait'; nextRetryAtMs?: number | null; lastError?: string | null; intent?: TIntent }
      | { status: 'terminal'; lastError?: string | null; intent?: TIntent }
      | { status: 'exhausted'; lastError?: string | null; intent?: TIntent }
      | { status: 'superseded'; reason?: string | null }
    >;
    gate?: (input: { sessionId: string; intent: TIntent }) =>
      | { status: 'open' }
      | { status: 'delayed'; retryAtMs: number; reason: string };
	    onSuccess?: (input: { sessionId: string; intent: TIntent }) => Promise<void> | void;
	    clearOnSuccess?: boolean;
	    onDelayed?: (input: { sessionId: string; intent: TIntent; retryAtMs: number; reason: string }) => void;
    onExhausted?: (input: { sessionId: string; intent: TIntent; lastError: string | null }) => void;
    onSuperseded?: (input: { sessionId: string; intent: TIntent; reason: string | null }) => void;
    exhaustAfterWait?: boolean;
    honorTimerNotBefore?: boolean;
  }) => {
    upsert: (input: { sessionId: string; intent: TIntent }) => Promise<TIntent>;
	    upsertMerged: (input: {
      sessionId: string;
      intent: TIntent;
      merge: (previous: TIntent | null, next: TIntent) => TIntent;
	    }) => Promise<TIntent>;
    transact: <TResult>(input: {
      sessionId: string;
      transaction: (current: TIntent | null) => { intent: TIntent | null; result: TResult };
      schedule?: boolean;
    }) => Promise<TResult>;
    read: (sessionId: string, options?: Readonly<{ schedule?: boolean }>) => TIntent | null;
    hydrate: (options?: Readonly<{ schedule?: boolean }>) => ReadonlyArray<TIntent>;
	    wake: (input: { sessionId: string; reason: string }) => Promise<{ status: string }>;
	    cancel: (input: { sessionId: string }) => Promise<TIntent | null>;
	    clear: (input: { sessionId: string }) => Promise<TIntent | null>;
    rearmAfterConfirmedEffectOwnerLoss: (input: {
      sessionId: string;
      authorization: 'fresh_user_action_after_owner_loss';
    }) => Promise<TIntent | null>;
	    dispose: () => void;
		  };
}>;

async function loadModule(): Promise<SchedulerModule> {
  const loaded = await import('./DurableBackoffRecoveryScheduler').catch(() => null);
  expect(loaded).not.toBeNull();
  return loaded as SchedulerModule;
}

function intent(overrides: Partial<TestIntent> = {}): TestIntent {
  return {
    v: 1,
    status: 'waiting',
    attemptCount: 0,
    maxAttempts: 3,
    nextRetryAtMs: 2_000,
    lastError: null,
    ...overrides,
  };
}

function normalizeIntent(value: unknown): TestIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<TestIntent>;
  if (record.v !== 1) return null;
  if (
    record.status !== 'waiting'
    && record.status !== 'checking'
    && record.status !== 'cancelled'
    && record.status !== 'exhausted'
  ) return null;
  if (typeof record.attemptCount !== 'number' || typeof record.maxAttempts !== 'number') return null;
  if (record.nextRetryAtMs !== null && typeof record.nextRetryAtMs !== 'number') return null;
  return record as TestIntent;
}

function strategy(overrides: {
  nowMs?: () => number;
  recover?: ReturnType<typeof vi.fn>;
  jitterMs?: () => number;
	  store?: {
	    read: (sessionId: string) => unknown | null;
	    readAll?: () => ReadonlyArray<readonly [string, unknown]>;
	    write: (sessionId: string, intent: TestIntent) => Promise<void> | void;
	    remove?: (sessionId: string) => Promise<void> | void;
	    prune?: (predicate: (entry: Readonly<{ sessionId: string; value: unknown }>) => boolean) => Promise<ReadonlyArray<string>> | ReadonlyArray<string>;
	  };
	  clearOnSuccess?: boolean;
  terminalRecordRetentionMs?: number;
  getTerminalPruneReferenceMs?: (intent: TestIntent) => number | null;
  gate?: (input: { sessionId: string; intent: TestIntent }) =>
    | { status: 'open' }
    | { status: 'delayed'; retryAtMs: number; reason: string };
  onSuccess?: ReturnType<typeof vi.fn>;
  onDelayed?: ReturnType<typeof vi.fn>;
  onExhausted?: ReturnType<typeof vi.fn>;
  onSuperseded?: ReturnType<typeof vi.fn>;
  exhaustAfterWait?: boolean;
  honorTimerNotBefore?: boolean;
} = {}) {
  return {
    nowMs: overrides.nowMs ?? (() => 2_000),
    baseBackoffMs: 1_000,
    maxBackoffMs: 10_000,
    jitterMs: overrides.jitterMs,
	    store: overrides.store,
    normalizeIntent,
    getStatus: (input: TestIntent) => input.status,
    getNextRetryAtMs: (input: TestIntent) => input.nextRetryAtMs,
    getAttemptCount: (input: TestIntent) => input.attemptCount,
    getMaxAttempts: (input: TestIntent) => input.maxAttempts,
    terminalRecordRetentionMs: overrides.terminalRecordRetentionMs,
    getTerminalPruneReferenceMs: overrides.getTerminalPruneReferenceMs,
    markChecking: (input: TestIntent, attemptCount: number): TestIntent => ({
      ...input,
      status: 'checking',
      attemptCount,
    }),
    markWaiting: (input: TestIntent, next: { nextRetryAtMs: number; lastError: string | null }): TestIntent => ({
      ...input,
      status: 'waiting',
      nextRetryAtMs: next.nextRetryAtMs,
      lastError: next.lastError,
    }),
    markCancelled: (input: TestIntent): TestIntent => ({
      ...input,
      status: 'cancelled',
      nextRetryAtMs: null,
      lastError: null,
    }),
    markExhausted: (input: TestIntent, next: { lastError: string | null }): TestIntent => ({
      ...input,
      status: 'exhausted',
      nextRetryAtMs: null,
      lastError: next.lastError,
    }),
    recover: overrides.recover ?? vi.fn(async () => ({ status: 'success' as const })),
    gate: overrides.gate,
    onSuccess: overrides.onSuccess,
    clearOnSuccess: overrides.clearOnSuccess,
    onDelayed: overrides.onDelayed,
    onExhausted: overrides.onExhausted,
    onSuperseded: overrides.onSuperseded,
    exhaustAfterWait: overrides.exhaustAfterWait,
    honorTimerNotBefore: overrides.honorTimerNotBefore,
  };
}

const MAX_SAFE_TIMER_DELAY_MS = 2_147_483_647;

describe('DurableBackoffRecoveryScheduler', () => {
  it('persists waiting work and wakes it at the scheduled time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    try {
      const { DurableBackoffRecoveryScheduler } = await loadModule();
      const stored = new Map<string, unknown>();
      const recover = vi.fn(async () => ({ status: 'success' as const }));
      const onSuccess = vi.fn();
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
        nowMs: () => Date.now(),
        recover,
        onSuccess,
        store: {
          read: (sessionId) => stored.get(sessionId) ?? null,
          write: (sessionId, next) => {
            stored.set(sessionId, next);
          },
        },
      }));

      await scheduler.upsert({ sessionId: 'sess_1', intent: intent({ nextRetryAtMs: 2_000 }) });
      await vi.advanceTimersByTimeAsync(999);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(recover).toHaveBeenCalledWith(expect.objectContaining({ status: 'checking' }), {
        sessionId: 'sess_1',
        reason: 'timer',
      });
      expect(onSuccess).toHaveBeenCalledOnce();
      expect(stored.get('sess_1')).toMatchObject({ status: 'cancelled', nextRetryAtMs: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire armed timers after dispose and keeps the intent waiting on disk', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    try {
      const { DurableBackoffRecoveryScheduler } = await loadModule();
      const stored = new Map<string, unknown>();
      const recover = vi.fn(async () => ({ status: 'success' as const }));
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
        nowMs: () => Date.now(),
        recover,
        store: {
          read: (sessionId) => stored.get(sessionId) ?? null,
          write: (sessionId, next) => {
            stored.set(sessionId, next);
          },
        },
      }));

      await scheduler.upsert({ sessionId: 'sess_1', intent: intent({ nextRetryAtMs: 2_000 }) });
      scheduler.dispose();
      await vi.advanceTimersByTimeAsync(5_000);

      // The armed timer must not have fired the recovery into a tearing-down daemon.
      expect(recover).not.toHaveBeenCalled();
      // wake is a no-op after dispose.
      await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'timer' })).resolves.toEqual({ status: 'disposed' });
      // The persisted intent stays waiting for a future daemon to re-drive.
      expect(stored.get('sess_1')).toMatchObject({ status: 'waiting' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears recovery work from memory and durable storage without marking it cancelled', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    const stored = new Map<string, unknown>();
    const removed: string[] = [];
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
      store: {
        read: (sessionId) => stored.get(sessionId) ?? null,
        write: (sessionId, next) => {
          stored.set(sessionId, next);
        },
        remove: (sessionId) => {
          stored.delete(sessionId);
          removed.push(sessionId);
        },
      },
    }));

    await scheduler.upsert({ sessionId: 'sess_1', intent: intent({ nextRetryAtMs: 2_000 }) });

    await expect(scheduler.clear({ sessionId: 'sess_1' })).resolves.toMatchObject({
      status: 'waiting',
    });

    expect(removed).toEqual(['sess_1']);
    expect(scheduler.read('sess_1')).toBeNull();
  });

  it('prunes stale terminal recovery intents before durable writes', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    const stored = new Map<string, unknown>([
      ['old-cancelled', intent({ status: 'cancelled', nextRetryAtMs: null, terminalAtMs: 1_000 })],
      ['fresh-exhausted', intent({ status: 'exhausted', nextRetryAtMs: null, terminalAtMs: 9_500 })],
      ['active-waiting', intent({ nextRetryAtMs: 12_000 })],
    ]);
    const pruned: string[] = [];
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
      nowMs: () => 10_000,
      terminalRecordRetentionMs: 5_000,
      getTerminalPruneReferenceMs: (next) => next.terminalAtMs ?? null,
      store: {
        read: (sessionId) => stored.get(sessionId) ?? null,
        readAll: () => Array.from(stored.entries()),
        write: (sessionId, next) => {
          stored.set(sessionId, next);
        },
        prune: (predicate) => {
          const removed: string[] = [];
          for (const [sessionId, value] of stored.entries()) {
            if (!predicate({ sessionId, value })) continue;
            stored.delete(sessionId);
            removed.push(sessionId);
          }
          pruned.push(...removed);
          return removed;
        },
      },
    }));

    await scheduler.upsert({ sessionId: 'new-session', intent: intent() });

    expect(pruned).toEqual(['old-cancelled']);
    expect(stored.has('old-cancelled')).toBe(false);
    expect(stored.has('fresh-exhausted')).toBe(true);
    expect(stored.has('active-waiting')).toBe(true);
    expect(stored.has('new-session')).toBe(true);
  });

  it('applies jittered exponential backoff for retryable waits', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    const recover = vi.fn(async () => ({ status: 'wait' as const, lastError: 'still_down' }));
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
      nowMs: () => 2_000,
      recover,
      jitterMs: () => 250,
    }));

    await scheduler.upsert({ sessionId: 'sess_1', intent: intent({ nextRetryAtMs: 2_000 }) });
    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('sess_1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_250,
      lastError: 'still_down',
    });
  });

  it('hydrates persisted work after restart and supports cancel', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    const stored = new Map<string, unknown>([
      ['sess_1', intent({ nextRetryAtMs: 6_000 })],
      ['sess_2', intent({ status: 'checking', attemptCount: 1, nextRetryAtMs: 6_000 })],
    ]);
    const store = {
      read: (sessionId: string) => stored.get(sessionId) ?? null,
      readAll: () => Array.from(stored.entries()),
      write: (sessionId: string, next: TestIntent) => {
        stored.set(sessionId, next);
      },
    };
    const recover = vi.fn(async () => ({ status: 'success' as const }));
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({ store, recover }));

    expect(scheduler.hydrate()).toHaveLength(2);
    expect(scheduler.read('sess_1')).toMatchObject({ status: 'waiting', nextRetryAtMs: 6_000 });
    await expect(scheduler.cancel({ sessionId: 'sess_1' })).resolves.toMatchObject({ status: 'cancelled' });
    await expect(scheduler.wake({ sessionId: 'sess_2', reason: 'timer' })).resolves.toEqual({ status: 'succeeded' });
  });

  it('can hydrate persisted work passively without treating startup state as execution authority', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    try {
      const { DurableBackoffRecoveryScheduler } = await loadModule();
      const stored = new Map<string, unknown>([
        ['sess_1', intent({ nextRetryAtMs: 2_000 })],
      ]);
      const recover = vi.fn(async () => ({ status: 'success' as const }));
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
        nowMs: () => Date.now(),
        recover,
        store: {
          read: (sessionId) => stored.get(sessionId) ?? null,
          readAll: () => Array.from(stored.entries()),
          write: (sessionId, next) => {
            stored.set(sessionId, next);
          },
        },
      }));

      expect(scheduler.hydrate({ schedule: false })).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(recover).not.toHaveBeenCalled();

      await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' }))
        .resolves.toEqual({ status: 'succeeded' });
      expect(recover).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports side-effect-free observation while ordinary reads keep their scheduling contract', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    try {
      const { DurableBackoffRecoveryScheduler } = await loadModule();
      const recover = vi.fn(async () => ({ status: 'success' as const }));
      const stored = new Map<string, unknown>([
        ['sess_observed', intent({ nextRetryAtMs: 2_000 })],
      ]);
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
        nowMs: () => Date.now(),
        recover,
        store: {
          read: (sessionId) => stored.get(sessionId) ?? null,
          write: (sessionId, next) => {
            stored.set(sessionId, next);
          },
        },
      }));

      expect(scheduler.read('sess_observed', { schedule: false })).toMatchObject({ status: 'waiting' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(recover).not.toHaveBeenCalled();

      await scheduler.transact({
        sessionId: 'sess_observed',
        schedule: false,
        transaction: (current) => ({
          intent: current ? { ...current, lastError: 'observed' } : null,
          result: undefined,
        }),
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).not.toHaveBeenCalled();

      expect(scheduler.read('sess_observed')).toMatchObject({ status: 'waiting' });
      await vi.runOnlyPendingTimersAsync();
      expect(recover).toHaveBeenCalledTimes(1);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a crashed recovery effect claim until fresh user action rearms it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-claim-'));
    try {
      const { DurableBackoffRecoveryScheduler } = await loadModule();
      const store = createRecoveryIntentFileStore<TestIntent>(join(dir, 'intents.json'));
      const firstRecover = vi.fn(async () => await new Promise<never>(() => {}));
      const first = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
        recover: firstRecover,
        store,
      }));
      await first.upsert({ sessionId: 'sess_claimed', intent: intent() });
      void first.wake({ sessionId: 'sess_claimed', reason: 'manual' });
      await expect.poll(() => firstRecover).toHaveBeenCalledOnce();
      first.dispose();

      const replacementRecover = vi.fn(async () => ({ status: 'success' as const }));
      const replacement = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
        recover: replacementRecover,
        store: createRecoveryIntentFileStore<TestIntent>(join(dir, 'intents.json')),
      }));
      replacement.hydrate({ schedule: false });

      await expect(replacement.wake({ sessionId: 'sess_claimed', reason: 'manual' }))
        .resolves.toEqual({ status: 'checking' });
      expect(replacementRecover).not.toHaveBeenCalled();

      await replacement.rearmAfterConfirmedEffectOwnerLoss({
        sessionId: 'sess_claimed',
        authorization: 'fresh_user_action_after_owner_loss',
      });
      await expect(replacement.wake({ sessionId: 'sess_claimed', reason: 'manual' }))
        .resolves.toEqual({ status: 'succeeded' });
      expect(replacementRecover).toHaveBeenCalledOnce();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite a cancellation when in-flight recovery later succeeds', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    let releaseRecovery!: () => void;
    const recover = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      return { status: 'success' as const };
    });
    const stored = new Map<string, unknown>();
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
      recover,
      store: {
        read: (sessionId) => stored.get(sessionId) ?? null,
        write: (sessionId, next) => {
          stored.set(sessionId, next);
        },
      },
    }));

    await scheduler.upsert({ sessionId: 'sess_1', intent: intent({ nextRetryAtMs: 2_000 }) });
    const wake = scheduler.wake({ sessionId: 'sess_1', reason: 'manual' });
    await expect.poll(() => recover).toHaveBeenCalledOnce();

    await scheduler.cancel({ sessionId: 'sess_1' });
    releaseRecovery();

    await expect(wake).resolves.toEqual({ status: 'inactive' });
    expect(stored.get('sess_1')).toMatchObject({ status: 'cancelled' });
  });

  it('does not fence an in-flight recovery for a transaction that returns the exact current intent', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    let releaseRecovery!: () => void;
    const recover = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      return { status: 'wait' as const, nextRetryAtMs: 9_000 };
    });
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({ recover }));

    await scheduler.upsert({ sessionId: 'sess_noop', intent: intent() });
    const wake = scheduler.wake({ sessionId: 'sess_noop', reason: 'manual' });
    await expect.poll(() => recover).toHaveBeenCalledOnce();
    await scheduler.transact({
      sessionId: 'sess_noop',
      transaction: (current) => ({ intent: current, result: undefined }),
    });
    releaseRecovery();

    await expect(wake).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('sess_noop')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 9_000,
    });
  });

  it('still fences an in-flight recovery when a transaction materially replaces the intent', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    let releaseRecovery!: () => void;
    const recover = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      return { status: 'wait' as const, nextRetryAtMs: 9_000 };
    });
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({ recover }));

    await scheduler.upsert({ sessionId: 'sess_replaced', intent: intent() });
    const wake = scheduler.wake({ sessionId: 'sess_replaced', reason: 'manual' });
    await expect.poll(() => recover).toHaveBeenCalledOnce();
    await scheduler.transact({
      sessionId: 'sess_replaced',
      transaction: (current) => ({
        intent: current ? { ...current, status: 'cancelled', nextRetryAtMs: null } : null,
        result: undefined,
      }),
    });
    releaseRecovery();

    await expect(wake).resolves.toEqual({ status: 'inactive' });
    expect(scheduler.read('sess_replaced')).toMatchObject({ status: 'cancelled' });
  });

  it('merges replacement intent with the normalized stored intent', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    const stored = new Map<string, unknown>([
      ['sess_1', intent({
        attemptCount: 2,
        maxAttempts: 4,
        nextRetryAtMs: 9_000,
        lastError: 'previous_failure',
      })],
    ]);
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
      store: {
        read: (sessionId) => stored.get(sessionId) ?? null,
        write: (sessionId, next) => {
          stored.set(sessionId, next);
        },
      },
    }));

    await expect(scheduler.upsertMerged({
      sessionId: 'sess_1',
      intent: intent({
        attemptCount: 0,
        maxAttempts: 3,
        nextRetryAtMs: 6_000,
        lastError: 'latest_failure',
      }),
      merge: (previous, next) => ({
        ...next,
        attemptCount: previous?.attemptCount ?? next.attemptCount,
        maxAttempts: Math.min(previous?.maxAttempts ?? next.maxAttempts, next.maxAttempts),
        nextRetryAtMs: Math.min(
          previous?.nextRetryAtMs ?? next.nextRetryAtMs ?? 0,
          next.nextRetryAtMs ?? 0,
        ),
      }),
    })).resolves.toMatchObject({
      attemptCount: 2,
      maxAttempts: 3,
      nextRetryAtMs: 6_000,
      lastError: 'latest_failure',
    });

    expect(stored.get('sess_1')).toMatchObject({
      attemptCount: 2,
      maxAttempts: 3,
      nextRetryAtMs: 6_000,
      lastError: 'latest_failure',
    });
  });

  it('honors circuit-breaker delays and dead-letters at max attempts', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    const recover = vi.fn(async () => ({ status: 'wait' as const, lastError: 'transient' }));
    const onDelayed = vi.fn();
    const delayed = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
      recover,
      gate: () => ({ status: 'delayed', retryAtMs: 30_000, reason: 'local_server_storm' }),
      onDelayed,
    }));
    await delayed.upsert({ sessionId: 'sess_1', intent: intent({ nextRetryAtMs: 2_000 }) });

    await expect(delayed.wake({ sessionId: 'sess_1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(recover).not.toHaveBeenCalled();
    expect(onDelayed).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      retryAtMs: 30_000,
      reason: 'local_server_storm',
    }));

    const onExhausted = vi.fn();
    const exhausted = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({ recover, onExhausted }));
    await exhausted.upsert({
      sessionId: 'sess_2',
      intent: intent({ attemptCount: 0, maxAttempts: 1, nextRetryAtMs: 2_000 }),
    });

    await expect(exhausted.wake({ sessionId: 'sess_2', reason: 'timer' })).resolves.toEqual({ status: 'exhausted' });
    expect(exhausted.read('sess_2')).toMatchObject({
      status: 'exhausted',
      attemptCount: 1,
      lastError: 'transient',
    });
    expect(onExhausted).toHaveBeenCalledOnce();
  });

  it('sanitizes thrown recovery errors before persisting retry state', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    const recover = vi.fn(async () => {
      throw new Error('transport failed accessToken=thrown-recovery-access-token authorization=Bearer thrown-recovery-auth-token');
    });
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({ recover }));

    await scheduler.upsert({ sessionId: 'sess_1', intent: intent({ nextRetryAtMs: 2_000 }) });
    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });

    const stored = scheduler.read('sess_1');
    expect(stored?.lastError).toContain('[REDACTED]');
    expect(stored?.lastError).not.toContain('thrown-recovery-access-token');
    expect(stored?.lastError).not.toContain('thrown-recovery-auth-token');
  });

  it('sanitizes gate-delayed reasons before persistence and callbacks', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    const onDelayed = vi.fn();
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
      gate: () => ({
        status: 'delayed',
        retryAtMs: 30_000,
        reason: 'local server unavailable refreshToken=gate-delay-refresh-token cookie=gate-delay-cookie-token',
      }),
      onDelayed,
    }));

    await scheduler.upsert({ sessionId: 'sess_1', intent: intent({ nextRetryAtMs: 2_000 }) });
    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });

    const stored = scheduler.read('sess_1');
    expect(stored?.lastError).toContain('[REDACTED]');
    expect(stored?.lastError).not.toContain('gate-delay-refresh-token');
    expect(stored?.lastError).not.toContain('gate-delay-cookie-token');
    expect(onDelayed).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining('[REDACTED]'),
    }));
    expect(JSON.stringify(onDelayed.mock.calls)).not.toContain('gate-delay-refresh-token');
    expect(JSON.stringify(onDelayed.mock.calls)).not.toContain('gate-delay-cookie-token');
  });

  it('clamps far-future timer delays to the max setTimeout delay and chains re-arms until the real wake time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    try {
      const { DurableBackoffRecoveryScheduler } = await loadModule();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const recover = vi.fn(async () => ({ status: 'success' as const }));
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
        nowMs: () => Date.now(),
        recover,
        honorTimerNotBefore: true,
      }));

      // A wait far beyond the int32 setTimeout bound (> ~24.8 days). Without the
      // clamp, Node fires such a timer immediately; the armed delay must never
      // exceed the safe bound.
      const farFutureRetryAtMs = Date.now() + MAX_SAFE_TIMER_DELAY_MS + 60_000;
      await scheduler.upsert({ sessionId: 'sess_1', intent: intent({ nextRetryAtMs: farFutureRetryAtMs }) });

      const armedDelays = setTimeoutSpy.mock.calls.map((call) => call[1]);
      expect(armedDelays.length).toBeGreaterThan(0);
      for (const delay of armedDelays) {
        expect(delay).toBeLessThanOrEqual(MAX_SAFE_TIMER_DELAY_MS);
      }

      // The clamped timer fires before the real wake time: recovery must NOT run,
      // and a chained timer must be re-armed for the remaining wait.
      await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMER_DELAY_MS);
      expect(recover).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(recover).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('re-arms the timer when an armed timer fires before the not-before time (clock moved backward)', async () => {
    vi.useFakeTimers();
    try {
      const { DurableBackoffRecoveryScheduler } = await loadModule();
      let clockNowMs = 2_000;
      const recover = vi.fn(async () => ({ status: 'success' as const }));
      const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
        nowMs: () => clockNowMs,
        recover,
        honorTimerNotBefore: true,
      }));

      await scheduler.upsert({ sessionId: 'sess_1', intent: intent({ nextRetryAtMs: 10_000 }) });

      // The wall clock moves backward relative to the (monotonic) timer: the timer
      // fires while nowMs() is still before nextRetryAtMs. The intent must not run
      // early AND must not silently lose its timer.
      clockNowMs = 6_000;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(recover).not.toHaveBeenCalled();

      clockNowMs = 10_000;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(recover).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not exhaust a wait outcome whose intent rolled the attempt increment back (F0)', async () => {
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    const onExhausted = vi.fn();
    // The recover loop asks for a durable wait and rolls the markChecking attempt
    // increment back (group-exhausted wait semantics): exhaustion must respect the
    // settled attempt count, not the pre-rollback increment.
    const recover = vi.fn(async (checking: TestIntent) => ({
      status: 'wait' as const,
      nextRetryAtMs: 9_000,
      lastError: 'no_eligible_member',
      intent: {
        ...checking,
        status: 'waiting' as const,
        attemptCount: Math.max(0, checking.attemptCount - 1),
        nextRetryAtMs: 9_000,
        lastError: 'no_eligible_member',
      },
    }));
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
      recover,
      onExhausted,
    }));

    await scheduler.upsert({
      sessionId: 'sess_1',
      intent: intent({ attemptCount: 1, maxAttempts: 2, nextRetryAtMs: 2_000 }),
    });
    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });

    expect(onExhausted).not.toHaveBeenCalled();
    expect(scheduler.read('sess_1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 9_000,
    });
  });

  it('removes the durable record on a superseded outcome so the key can re-arm later', async () => {
    // A superseded recovery (the failure no longer applies — e.g. the group switched off the
    // failing profile while the intent was waiting) must REMOVE the record, never terminalize:
    // a cancelled/exhausted record persists for days and blocks re-arming the same key on a
    // genuine future failure.
    const { DurableBackoffRecoveryScheduler } = await loadModule();
    const removed: string[] = [];
    const backing = new Map<string, TestIntent>();
    const onSuperseded = vi.fn();
    const scheduler = new DurableBackoffRecoveryScheduler<TestIntent>(strategy({
      store: {
        read: (sessionId) => backing.get(sessionId) ?? null,
        readAll: () => Array.from(backing.entries()),
        write: (sessionId, value) => {
          backing.set(sessionId, value);
        },
        remove: (sessionId) => {
          removed.push(sessionId);
          backing.delete(sessionId);
        },
      },
      recover: vi.fn(async () => ({ status: 'superseded' as const, reason: 'failing_profile_inactive' })),
      onSuperseded,
    }));

    await scheduler.upsert({ sessionId: 'sess_1', intent: intent() });
    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' }))
      .resolves.toEqual({ status: 'superseded' });

    expect(onSuperseded).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      reason: 'failing_profile_inactive',
    }));
    expect(removed).toContain('sess_1');
    expect(scheduler.read('sess_1')).toBeNull();

    // The same key re-arms fresh afterward.
    await scheduler.upsert({ sessionId: 'sess_1', intent: intent() });
    expect(scheduler.read('sess_1')).toMatchObject({ status: 'waiting', attemptCount: 0 });
  });
});
