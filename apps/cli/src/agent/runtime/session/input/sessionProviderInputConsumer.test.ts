import { describe, expect, it, vi } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { writeSessionPendingQueueHoldV1ToMetadata } from '@happier-dev/protocol';
import { createSessionProviderInputConsumer } from './sessionProviderInputConsumer';

describe('createSessionProviderInputConsumer', () => {
  type TestMode = { id: string };

  function createDrainConsumer(
    session: Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]['session'],
  ) {
    return createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session,
    });
  }

  it('drains one pending message per wake by default', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'local-1',
      seq: 1,
      content: null,
    }));

    const consumer = createDrainConsumer({
      waitForMetadataUpdate: async () => false,
      materializeNextPendingMessageSafely,
      popPendingMessage: vi.fn(async () => false),
    });

    await expect(consumer.drainPending({ reason: 'test-default-one' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('returns queued input without touching pending materialization', async () => {
    type Mode = { id: string };
    const mode: Mode = { id: 'mode-1' };
    const queue = new MessageQueue2<Mode>(() => 'hash');
    queue.pushImmediate('hello', mode);
    const materialize = vi.fn(async () => ({ type: 'no_pending' as const }));

    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely: materialize,
        popPendingMessage: async () => false,
      },
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toMatchObject({
      message: 'hello',
      mode,
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('uses safe pending materialization before the legacy pop contract when available', async () => {
    type Mode = { id: string };
    const mode: Mode = { id: 'mode-1' };
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const popPendingMessage = vi.fn(async () => false);
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      queue.pushImmediate('from-pending', mode);
      return { type: 'materialized' as const, localId: 'local-1', seq: 1, content: null };
    });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
        popPendingMessage,
      },
    });

    const result = await consumer.waitForNextInput({ abortSignal: new AbortController().signal });

    expect(result?.message).toBe('from-pending');
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'throttled' });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('routes passive known-empty materialization through the safe policy without force reconciliation', async () => {
    type Mode = { id: string };
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const reconcilePendingQueueState = vi.fn(async () => false);
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    const abortController = new AbortController();
    let waitCalls = 0;

    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: async () => {
          waitCalls += 1;
          if (waitCalls >= 1) abortController.abort();
          return false;
        },
        materializeNextPendingMessageSafely,
        popPendingMessage: vi.fn(async () => false),
        shouldAttemptPendingMaterialization: () => false,
        reconcilePendingQueueState,
      },
      reconcileWhenEmpty: 'skip',
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'skip' });
    expect(reconcilePendingQueueState).not.toHaveBeenCalled();
  });

  it('does not refresh metadata on idle timer wake', async () => {
    vi.useFakeTimers();
    try {
      type Mode = { id: string };
      const queue = new MessageQueue2<Mode>(() => 'hash');
      const onMetadataUpdate = vi.fn();
      const waitForMetadataUpdate = vi.fn(() => new Promise<boolean>(() => {}));
      const abortController = new AbortController();

      const consumer = createSessionProviderInputConsumer({
        messageQueue: queue,
        session: {
          waitForMetadataUpdate,
          materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
          popPendingMessage: vi.fn(async () => false),
        },
        onMetadataUpdate,
        reconcileWhenEmpty: 'skip',
      });

      const pending = consumer.waitForNextInput({ abortSignal: abortController.signal });
      await vi.advanceTimersByTimeAsync(30_000);
      abortController.abort();
      await pending;

      expect(onMetadataUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains pending messages through safe materialization before the legacy pop contract', async () => {
    const popPendingMessage = vi.fn(async () => {
      throw new Error('legacy popPendingMessage should not be used when safe materialization exists');
    });
    const materializeNextPendingMessageSafely = vi
      .fn()
      .mockResolvedValueOnce({ type: 'materialized' as const, localId: 'local-1', seq: 1, content: null })
      .mockResolvedValueOnce({ type: 'no_pending' as const });

    const consumer = createDrainConsumer({
      waitForMetadataUpdate: async () => false,
      materializeNextPendingMessageSafely,
      popPendingMessage,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending({ maxPopPerWake: 5, reason: 'test-drain' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'no_pending',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('reconciles before stopping when materialization is disallowed during drain', async () => {
    const popPendingMessage = vi.fn(async () => true);
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createDrainConsumer({
      popPendingMessage,
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingQueueState,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending({ reason: 'test-disallowed' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'materialization_blocked',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('blocks drain while continuation recovery is unresolved even when the pending count allows materialization', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'local-1',
      seq: 1,
      content: null,
    }));
    const popPendingMessage = vi.fn(async () => true);
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createDrainConsumer({
      waitForMetadataUpdate: async () => false,
      materializeNextPendingMessageSafely,
      popPendingMessage,
      shouldAttemptPendingMaterialization: () => true,
      reconcilePendingQueueState,
      getMetadataSnapshot: () => createTestMetadata({
        sessionContinuationRecoveryV1: {
          v: 1,
          attemptsById: {
            'generation-1:restart-1': {
              v: 1,
              attemptId: 'generation-1:restart-1',
              status: 'pending_provider_context',
              failureAtMs: 100,
              updatedAtMs: 110,
              resumePromptMode: 'standard',
            },
          },
        },
      }),
    });

    await expect(consumer.drainPending({ reason: 'test-continuation-recovery' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'materialization_blocked',
    });
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('blocks drain while a pending-message edit hold is unexpired', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'local-1',
      seq: 1,
      content: null,
    }));
    const popPendingMessage = vi.fn(async () => true);
    const metadataWithHold = writeSessionPendingQueueHoldV1ToMetadata(createTestMetadata(), {
      holdId: 'hold-1',
      localId: 'pending-1',
      updatedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });

    const consumer = createDrainConsumer({
      waitForMetadataUpdate: async () => false,
      materializeNextPendingMessageSafely,
      popPendingMessage,
      shouldAttemptPendingMaterialization: () => true,
      getMetadataSnapshot: () => metadataWithHold,
    });

    await expect(consumer.drainPending({ reason: 'test-pending-edit-hold' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'materialization_blocked',
    });
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('returns an error result when drain reconciliation fails', async () => {
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

  it('stops draining after terminal auth failure without throwing', async () => {
    const popPendingMessage = vi.fn(async () => {
      throw new HttpStatusError(401, 'Authentication failed');
    });

    const consumer = createDrainConsumer({
      popPendingMessage,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending({ maxPopPerWake: 5, reason: 'test-auth' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'auth_failure',
    });
    expect(popPendingMessage).toHaveBeenCalledTimes(1);
  });

});
