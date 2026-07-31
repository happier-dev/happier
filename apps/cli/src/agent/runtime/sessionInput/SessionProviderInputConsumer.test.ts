import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { HttpStatusError } from '@/api/client/httpStatusError';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import { logger } from '@/ui/logger';

import { createSessionProviderInputConsumer } from './SessionProviderInputConsumer';
import type { DrainPendingOptions, DrainPendingResult } from './types';

type TestMode = { id: string };
type ConsumerWithDrain = ReturnType<typeof createSessionProviderInputConsumer<TestMode, string>> & {
  drainPending?: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
};

function createDrainConsumer(
  session: Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]['session'],
  options: Partial<Omit<Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0], 'messageQueue' | 'session'>> = {},
): ConsumerWithDrain {
  return createSessionProviderInputConsumer({
    messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
    session,
    ...options,
  }) as ConsumerWithDrain;
}

describe('SessionProviderInputConsumer drainPending', () => {
  it('drains one pending message per wake by default', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'materialized',
        localId: 'local-safe',
        seq: 7,
        content: null,
      });

    const consumer = createDrainConsumer({
      popPendingMessage: vi.fn(async () => false),
      materializeNextPendingMessageSafely,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending?.({ reason: 'test-default-one' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('uses safe pending materialization before legacy pop fallback', async () => {
    const popPendingMessage = vi.fn(async () => false);
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValueOnce({
        type: 'materialized',
        localId: 'local-safe',
        seq: 7,
        content: null,
      })
      .mockResolvedValueOnce({ type: 'no_pending' });

    const consumer = createDrainConsumer({
      popPendingMessage,
      materializeNextPendingMessageSafely,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ maxPopPerWake: 5, reason: 'test-safe' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'no_pending',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('reconciles before stopping when materialization is disallowed', async () => {
    const popPendingMessage = vi.fn(async () => true);
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createDrainConsumer({
      popPendingMessage,
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingQueueState,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ reason: 'test-disallowed' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'materialization_blocked',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('leaves active-turn delivery policy to the session client instead of overriding it per drain', async () => {
    const shouldAttemptPendingMaterialization = vi.fn(() => true);
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'no_pending' });

    const consumer = createDrainConsumer({
      popPendingMessage: vi.fn(async () => false),
      materializeNextPendingMessageSafely,
      shouldAttemptPendingMaterialization,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending?.({ reason: 'test-no-policy-override' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'no_pending',
    });
    expect(shouldAttemptPendingMaterialization).toHaveBeenCalledWith();
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
  });

  it('returns an error result when reconciliation fails during drain', async () => {
    const popPendingMessage = vi.fn(async () => true);
    const reconcilePendingQueueState = vi.fn(async () => {
      throw new Error('reconcile failed');
    });

    const consumer = createDrainConsumer({
      popPendingMessage,
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingQueueState,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending({ reason: 'test-reconcile-error' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'error',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('stops after terminal auth failure without throwing', async () => {
    const popPendingMessage = vi.fn(async () => {
      throw new HttpStatusError(401, 'Authentication failed');
    });

    const consumer = createDrainConsumer({
      popPendingMessage,
      waitForMetadataUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ maxPopPerWake: 5, reason: 'test-auth' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'auth_failure',
    });
    expect(popPendingMessage).toHaveBeenCalledTimes(1);
  });
});

describe('SessionProviderInputConsumer waitForNextInput', () => {
  it('routes passive known-empty materialization through the safe materializer policy', async () => {
    const popPendingMessage = vi.fn(async () => true);
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'no_pending',
      });
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        popPendingMessage,
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => false,
        reconcilePendingQueueState,
        waitForMetadataUpdate: async () => false,
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toBeNull();
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'skip' });
    expect(reconcilePendingQueueState).not.toHaveBeenCalled();
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('logs text-free materialization decisions', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'materialized',
        localId: 'local-secret',
        seq: 33,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'do not log this secret prompt' } } },
      });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        popPendingMessage: vi.fn(async () => false),
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate: async () => false,
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toBeNull();

    expect(debugSpy).toHaveBeenCalledWith('[pendingQueue] input consumer materialization decision', {
      localId: 'local-secret',
      reconcileWhenEmpty: 'skip',
      resultType: 'materialized',
      seq: 33,
      source: 'waitForNextInput',
    });
    expect(debugSpy.mock.calls).not.toEqual(expect.arrayContaining([
      expect.arrayContaining([
        expect.any(String),
        expect.objectContaining({ content: expect.anything() }),
      ]),
    ]));
  });

  it('idle wakes reconcile a stale-empty pending count (throttled) so lost nudges self-heal', async () => {
    const abortController = new AbortController();
    const materializeNextPendingMessageSafely = vi
      .fn<(opts?: { reconcileWhenEmpty?: string }) => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'no_pending' });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        popPendingMessage: vi.fn(async () => false),
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => false,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 1,
    });

    const waitPromise = consumer.waitForNextInput({ abortSignal: abortController.signal });
    setTimeout(() => abortController.abort(), 25).unref?.();
    await expect(waitPromise).resolves.toBeNull();

    const policies = materializeNextPendingMessageSafely.mock.calls.map((call) => call[0]?.reconcileWhenEmpty);
    // First (pre-wait) attempt stays passive; idle-timer wakes must reconcile (throttled).
    expect(policies[0]).toBe('skip');
    expect(policies).toContain('throttled');
  });

  it('calls metadata refresh when only the idle timer wakes', async () => {
    const abortController = new AbortController();
    const onMetadataUpdate = vi.fn();
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'no_pending' });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        popPendingMessage: vi.fn(async () => false),
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => false,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      },
      onMetadataUpdate,
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 1,
    });

    const waitPromise = consumer.waitForNextInput({ abortSignal: abortController.signal });
    setTimeout(() => abortController.abort(), 10).unref?.();

    await expect(waitPromise).resolves.toBeNull();
    expect(onMetadataUpdate).toHaveBeenCalled();
  });

  it('calls metadata refresh after a non-aborted metadata wait resolves false', async () => {
    const onMetadataUpdate = vi.fn(async () => {});
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        popPendingMessage: vi.fn(async () => false),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
        waitForMetadataUpdate: vi.fn(async () => false),
      },
      onMetadataUpdate,
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toBeNull();
    expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
  });
});
