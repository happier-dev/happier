import { describe, expect, it, vi } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import {
  HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY,
  consumePersistedTakeoverAdmissionFromEnv,
  createPersistedTakeoverAdmissionWaiter,
  serializePersistedTakeoverAdmissionForEnv,
} from './persistedTakeoverAdmission';

describe('persisted takeover admission child handoff', () => {
  it('consumes only each hosted Session admission published through the real handoff serializer', async () => {
    const hostAdmission = serializePersistedTakeoverAdmissionForEnv({
      mode: 'persisted', operationId: 'host-operation', attemptId: 'host-attempt',
    });
    const envScope = createEnvKeyScope([HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]);
    envScope.patch({ [HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]: hostAdmission });
    const admissions = (['persisted', 'external_linked'] as const).map((mode, index) => ({
      mode, operationId: `operation-${index}`, attemptId: `attempt-${index}`,
    }));
    const environments = admissions.map(admission => ({
      [HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]: serializePersistedTakeoverAdmissionForEnv(admission),
    }));
    try {
      const consumed = await Promise.all(environments.map(environment => runAddedHostedSession({
        environment, workingDirectory: '/repo', end: () => undefined,
      }, async () => {
        await Promise.resolve();
        const admission = consumePersistedTakeoverAdmissionFromEnv();
        await Promise.resolve();
        expect(consumePersistedTakeoverAdmissionFromEnv()).toBeNull();
        return admission;
      })));
      expect(consumed).toEqual(admissions);
      for (const environment of environments) {
        expect(environment[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]).toBeUndefined();
      }
      expect(process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]).toBe(hostAdmission);
    } finally {
      envScope.restore();
    }
  });

  it('round-trips bounded opaque correlation and consumes it exactly once', () => {
    const env: NodeJS.ProcessEnv = {
      [HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]:
        serializePersistedTakeoverAdmissionForEnv({
          mode: 'persisted',
          operationId: 'operation-1',
          attemptId: 'attempt-1',
        }),
    };

    expect(consumePersistedTakeoverAdmissionFromEnv(env)).toEqual({
      mode: 'persisted',
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
      mode: 'persisted' as const,
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

  it('cancels a still-pending exact attempt with its owning operation', async () => {
    vi.useFakeTimers();
    try {
      const waiter = createPersistedTakeoverAdmissionWaiter();
      const pending = waiter.register({
        mode: 'persisted',
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      });

      pending.cancel();

      await expect(pending.outcome).resolves.toEqual({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_cancelled',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes a runtime_bound reservation when its owning operation ends', async () => {
    vi.useFakeTimers();
    try {
      const waiter = createPersistedTakeoverAdmissionWaiter();
      const correlation = {
        mode: 'persisted' as const,
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      };
      const pending = waiter.register(correlation);
      const reserved = waiter.reserveRuntimeBound(correlation);
      expect(reserved.status).toBe('reserved');
      const duplicate = waiter.reserveRuntimeBound(correlation);
      expect(duplicate.status).toBe('already_reserved');

      pending.cancel();
      expect(pending.readOutcome()).toEqual({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_cancelled',
      });
      await expect(pending.outcome).resolves.toEqual({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_cancelled',
      });
      if (duplicate.status !== 'already_reserved') {
        throw new Error('Expected duplicate runtime-bound reservation');
      }
      await expect(duplicate.outcome).resolves.toEqual({
        status: 'failed',
        errorCode: 'persisted_takeover_admission_cancelled',
      });
      if (reserved.status !== 'reserved') {
        throw new Error('Expected runtime-bound reservation');
      }
      expect(reserved.reservation.commit()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not allocate a timer when a runtime-bound reservation commits', async () => {
    vi.useFakeTimers();
    try {
      const waiter = createPersistedTakeoverAdmissionWaiter();
      const correlation = {
        mode: 'persisted' as const,
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      };
      const pending = waiter.register(correlation);
      const reserved = waiter.reserveRuntimeBound(correlation);
      if (reserved.status !== 'reserved') {
        throw new Error('Expected runtime-bound reservation');
      }

      expect(reserved.reservation.commit()).toBe(true);
      await expect(pending.outcome).resolves.toEqual({ status: 'committed' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves failure without success when durable completion fails after reservation', async () => {
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const correlation = {
      mode: 'persisted' as const,
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

  it('keeps external-linked and persisted custody distinct for the same opaque ids', async () => {
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const persisted = {
      mode: 'persisted' as const,
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    };
    const externalLinked = {
      ...persisted,
      mode: 'external_linked' as const,
    };
    const pendingPersisted = waiter.register(persisted);
    const pendingExternalLinked = waiter.register(externalLinked);

    expect(waiter.settle(externalLinked, { status: 'committed' })).toBe(true);
    expect(waiter.isPending(persisted)).toBe(true);
    await expect(pendingExternalLinked.outcome).resolves.toEqual({
      status: 'committed',
    });

    pendingPersisted.cancel();
    await expect(pendingPersisted.outcome).resolves.toEqual({
      status: 'failed',
      errorCode: 'persisted_takeover_admission_cancelled',
    });
  });
});
