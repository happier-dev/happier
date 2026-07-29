import { describe, expect, it, vi } from 'vitest';

import {
  HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY,
  consumePersistedTakeoverAdmissionFromEnv,
  createPersistedTakeoverAdmissionWaiter,
  serializePersistedTakeoverAdmissionForEnv,
} from './persistedTakeoverAdmission';

describe('persisted takeover admission child handoff', () => {
  it('round-trips bounded opaque correlation and consumes it exactly once', () => {
    const env: NodeJS.ProcessEnv = {
      [HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]:
        serializePersistedTakeoverAdmissionForEnv({
          operationId: 'operation-1',
          attemptId: 'attempt-1',
        }),
    };

    expect(consumePersistedTakeoverAdmissionFromEnv(env)).toEqual({
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    });
    expect(env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]).toBeUndefined();
    expect(consumePersistedTakeoverAdmissionFromEnv(env)).toBeNull();
  });

  it('clears malformed handoffs while failing closed', () => {
    const env: NodeJS.ProcessEnv = {
      [HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]: '{"operationId":"operation-1"}',
    };

    expect(() => consumePersistedTakeoverAdmissionFromEnv(env)).toThrow(
      'Persisted takeover admission handoff is malformed',
    );
    expect(env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]).toBeUndefined();
  });
});

describe('persisted takeover strict admission waiter', () => {
  it('settles one exact attempt once and converges duplicate acknowledgements', async () => {
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const correlation = {
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    };
    const pending = waiter.register(correlation);
    expect(pending.readOutcome()).toBeNull();
    expect(waiter.isPending(correlation)).toBe(true);

    expect(waiter.settle(correlation, { status: 'committed' })).toBe(true);
    expect(waiter.settle(correlation, {
      status: 'failed',
      errorCode: 'late_duplicate_failure',
    })).toBe(false);

    await expect(pending.outcome).resolves.toEqual({ status: 'committed' });
    expect(pending.readOutcome()).toEqual({ status: 'committed' });
    expect(waiter.isPending(correlation)).toBe(false);
    pending.cancel();
  });

  it('fails a still-pending exact attempt on timeout', async () => {
    vi.useFakeTimers();
    try {
      const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 10 });
      const pending = waiter.register({
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      });

      await vi.advanceTimersByTimeAsync(10);

      await expect(pending.outcome).resolves.toEqual({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps runtime_bound reservation bounded by the exact attempt deadline', async () => {
    vi.useFakeTimers();
    try {
      const waiter = createPersistedTakeoverAdmissionWaiter({ timeoutMs: 10 });
      const correlation = {
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      };
      const pending = waiter.register(correlation);
      const reserved = waiter.reserveRuntimeBound(correlation);
      expect(reserved.status).toBe('reserved');
      const duplicate = waiter.reserveRuntimeBound(correlation);
      expect(duplicate.status).toBe('already_reserved');

      await vi.advanceTimersByTimeAsync(10);
      expect(pending.readOutcome()).toEqual({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_timeout',
      });
      await expect(pending.outcome).resolves.toEqual({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_timeout',
      });
      if (duplicate.status !== 'already_reserved') {
        throw new Error('Expected duplicate runtime-bound reservation');
      }
      await expect(duplicate.outcome).resolves.toEqual({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_timeout',
      });
      if (reserved.status !== 'reserved') {
        throw new Error('Expected runtime-bound reservation');
      }
      expect(reserved.reservation.commit()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves failure without success when durable completion fails after reservation', async () => {
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const correlation = {
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    };
    const pending = waiter.register(correlation);
    const reserved = waiter.reserveRuntimeBound(correlation);
    if (reserved.status !== 'reserved') {
      throw new Error('Expected runtime-bound reservation');
    }

    expect(reserved.reservation.fail('runtime_bound_convergence_failed')).toBe(true);
    expect(reserved.reservation.commit()).toBe(false);
    await expect(pending.outcome).resolves.toEqual({
      status: 'failed',
      errorCode: 'runtime_bound_convergence_failed',
    });
  });
});
