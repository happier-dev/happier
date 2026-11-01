import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildRuntimeAuthRecoveryKey } from './recoveryKey/runtimeAuthRecoveryKey';
import { createRuntimeAuthRecoverySchedulerForDaemon } from './createRuntimeAuthRecoverySchedulerForDaemon';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

const classification: ConnectedServiceRuntimeFailureClassification = {
  kind: 'usage_limit',
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'team',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error',
};

describe('createRuntimeAuthRecoverySchedulerForDaemon', () => {
  it.each([1_500, 20_000])('arms a persisted wait across replacement at daemon time %i without synchronous recovery', async (restartAtMs) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-startup-timer-'));
    const recover = vi.fn(async () => ({ status: 'session_not_found' as const }));
    let scheduler: ReturnType<typeof createRuntimeAuthRecoverySchedulerForDaemon>['scheduler'] | undefined;
    try {
      const first = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir, nowMs: () => 1_000, recover,
      });
      await first.scheduler.enqueueHandlerFailure({
        sessionId: 'session-startup-timer', switchesThisTurn: 0, classification,
        error: Object.assign(new Error('network unavailable'), { code: 'ECONNRESET' }),
      });
      const [waiting] = first.scheduler.hydratePassive();
      expect(waiting?.status).toBe('waiting');
      expect(waiting?.nextRetryAtMs).toEqual(expect.any(Number));
      first.scheduler.dispose();

      vi.useFakeTimers();
      vi.setSystemTime(restartAtMs);
      const replacement = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir, nowMs: () => Date.now(), recover,
      });
      scheduler = replacement.scheduler;
      expect(recover).not.toHaveBeenCalled();
      replacement.scheduler.hydrate();
      expect(recover).not.toHaveBeenCalled();
      const delayMs = Math.max(0, waiting!.nextRetryAtMs! - restartAtMs);
      if (delayMs > 0) {
        await vi.advanceTimersByTimeAsync(delayMs - 1);
        expect(recover).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(delayMs > 0 ? 1 : 0);
      // The timer enters the normal recovery owner with its original failure,
      // rather than applying auth or continuing during hydration itself.
      await vi.waitFor(() => expect(recover).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sessionId: 'session-startup-timer', source: 'scheduler_retry', classification: expect.objectContaining(classification),
      })));
    } finally {
      scheduler?.dispose();
      vi.useRealTimers();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it.each([
    ['missing', false],
    ['corrupt', true],
  ] as const)('keeps %s durable state passive and effect-free', async (_state, seedCorruptStore) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-startup-empty-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));

    try {
      if (seedCorruptStore) {
        await mkdir(join(activeServerDir, 'connected-services'), { recursive: true });
        await writeFile(
          join(activeServerDir, 'connected-services', 'runtime-auth-recovery.json'),
          '{not-json',
          'utf8',
        );
      }

      const composition = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_000,
        recover,
      });

      expect(composition.hydratedIntents).toEqual([]);
      expect(recover).not.toHaveBeenCalled();
      composition.scheduler.dispose();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('reconstructs durable runtime-auth state passively across daemon replacement', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-startup-'));
    let releaseRecovery!: () => void;
    const recoveryBlocked = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let notifyRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => {
      notifyRecoveryStarted = resolve;
    });
    const recover = vi.fn(async () => {
      notifyRecoveryStarted();
      await recoveryBlocked;
      return { status: 'credential_refreshed' as const };
    });
    let ownerWake: Promise<Readonly<{ status: string }>> | null = null;

    try {
      const first = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_000,
        recover,
      });
      const intake = await first.scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:startup',
        sessionId: 'session-startup',
        switchesThisTurn: 0,
        classification,
      });
      first.scheduler.dispose();

      const replacement = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 2_000,
        recover,
      });
      const recoveryKey = buildRuntimeAuthRecoveryKey({
        sessionId: 'session-startup',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team',
      });

      expect(replacement.hydratedIntents).toHaveLength(1);
      expect(replacement.scheduler.readByKey(recoveryKey)).toMatchObject({
        attemptId: intake.attemptId,
        lastSettledTransition: intake.transition,
        status: 'waiting',
      });
      expect(recover).not.toHaveBeenCalled();
      const duplicateController = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 2_000,
        recover,
      });
      ownerWake = replacement.scheduler.wakeByKey({ recoveryKey, reason: 'manual' });
      await recoveryStarted;
      expect(recover).toHaveBeenCalledTimes(1);
      await expect(duplicateController.scheduler.wakeByKey({
        recoveryKey,
        reason: 'manual',
      })).resolves.toEqual({ status: 'checking' });
      releaseRecovery();
      await ownerWake;
      ownerWake = null;
      expect(recover).toHaveBeenCalledTimes(1);
      replacement.scheduler.dispose();
      duplicateController.scheduler.dispose();
    } finally {
      releaseRecovery?.();
      await ownerWake?.catch(() => {});
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('durably retries an accepted visible transition after daemon replacement without running recovery work', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-startup-delivery-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    const deliveredLocalIds: string[] = [];

    try {
      const first = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_000,
        recover,
      });
      const intake = await first.scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:durable-delivery',
        sessionId: 'session-durable-delivery',
        switchesThisTurn: 0,
        classification,
      });
      await first.scheduler.enqueueHandlerFailure({
        reportId: 'runtime-auth-report:durable-delivery',
        sessionId: 'session-durable-delivery',
        switchesThisTurn: 0,
        classification,
        error: Object.assign(new Error('network down before write'), { code: 'ECONNRESET' }),
        expectedAttemptId: intake.attemptId,
      });

      await expect(first.scheduler.drainPendingVisibleEvents(async () => {
        throw new Error('http failed before write');
      })).rejects.toThrow('http failed before write');
      first.scheduler.dispose();

      const replacement = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 2_000,
        recover,
      });
      expect(replacement.hydratedIntents).toHaveLength(1);
      await replacement.scheduler.drainPendingVisibleEvents(async (delivery) => {
        deliveredLocalIds.push(`${delivery.attemptId}:${delivery.transition}`);
        throw new Error('server wrote but acknowledgement was lost');
      }).catch((error: unknown) => {
        expect(error).toMatchObject({ message: 'server wrote but acknowledgement was lost' });
      });
      replacement.scheduler.dispose();

      const afterLostAck = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 3_000,
        recover,
      });
      await afterLostAck.scheduler.drainPendingVisibleEvents(async (delivery) => {
        deliveredLocalIds.push(`${delivery.attemptId}:${delivery.transition}`);
      });
      await afterLostAck.scheduler.drainPendingVisibleEvents(async (delivery) => {
        deliveredLocalIds.push(`${delivery.attemptId}:${delivery.transition}`);
      });

      expect(deliveredLocalIds).toEqual([
        `${intake.attemptId}:scheduled`,
        `${intake.attemptId}:scheduled`,
      ]);
      expect(recover).not.toHaveBeenCalled();
      afterLostAck.scheduler.dispose();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('keeps scheduling the same pending visible event until delivery acknowledges it', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-delivery-retry-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    const deliveries: string[] = [];
    try {
      const composition = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_000,
        recover,
      });
      const intake = await composition.scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:retry-until-ack',
        sessionId: 'session-retry-until-ack',
        switchesThisTurn: 0,
        classification,
      });
      await composition.scheduler.enqueueHandlerFailure({
        reportId: 'runtime-auth-report:retry-until-ack',
        sessionId: 'session-retry-until-ack',
        switchesThisTurn: 0,
        classification,
        error: Object.assign(new Error('network'), { code: 'ECONNRESET' }),
        expectedAttemptId: intake.attemptId,
      });
      let attempts = 0;
      const acknowledged = new Promise<void>((resolve) => {
        composition.scheduler.schedulePendingVisibleEventDrain({
          delayMs: 0,
          retryDelayMs: 10,
          deliver: async (delivery) => {
            deliveries.push(`${delivery.attemptId}:${delivery.transition}`);
            attempts += 1;
            if (attempts === 1) throw new Error('lost acknowledgement');
            resolve();
          },
        });
      });
      await acknowledged;
      expect(deliveries).toEqual([
        `${intake.attemptId}:scheduled`,
        `${intake.attemptId}:scheduled`,
      ]);
      composition.scheduler.dispose();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });

  it('does not re-arm the delivery timer when an in-flight delivery fails after disposal', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-delivery-dispose-'));
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    let releaseDelivery!: () => void;
    const deliveryBlocked = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    try {
      const composition = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir,
        nowMs: () => 1_000,
        recover,
      });
      const intake = await composition.scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:dispose-in-flight',
        sessionId: 'session-dispose-in-flight',
        switchesThisTurn: 0,
        classification,
      });
      await composition.scheduler.enqueueHandlerFailure({
        reportId: 'runtime-auth-report:dispose-in-flight',
        sessionId: 'session-dispose-in-flight',
        switchesThisTurn: 0,
        classification,
        error: Object.assign(new Error('network'), { code: 'ECONNRESET' }),
        expectedAttemptId: intake.attemptId,
      });

      const deliver = vi.fn(async () => {
        notifyStarted();
        await deliveryBlocked;
        throw new Error('delivery failed during shutdown');
      });
      composition.scheduler.schedulePendingVisibleEventDrain({
        delayMs: 0,
        retryDelayMs: 5,
        deliver,
      });
      await started;
      composition.scheduler.dispose();
      releaseDelivery();
      await new Promise((resolve) => setTimeout(resolve, 30));
      composition.scheduler.dispose();

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(recover).not.toHaveBeenCalled();
    } finally {
      releaseDelivery?.();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });
});
