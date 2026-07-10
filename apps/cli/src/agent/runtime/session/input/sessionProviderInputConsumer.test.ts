import { describe, expect, it, vi } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { writeSessionPendingQueueHoldV1ToMetadata } from '@happier-dev/protocol';
import {
  createSessionProviderInputConsumer,
  createSessionProviderPendingDrainAdapter,
  PendingQueueMaterializationAuthError,
} from './sessionProviderInputConsumer';

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

  it('serializes overlapping waits without duplicating queued messages', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));

    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely,
        popPendingMessage: vi.fn(async () => false),
        shouldAttemptPendingMaterialization: () => false,
      },
      reconcileWhenEmpty: 'skip',
    });

    const firstWait = consumer.waitForNextInput({ abortSignal: firstAbortController.signal });
    await Promise.resolve();
    await Promise.resolve();

    const secondWait = consumer.waitForNextInput({ abortSignal: secondAbortController.signal });
    const earlySecondOutcome = await Promise.race([
      secondWait.then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]);

    try {
      expect(earlySecondOutcome).toBe('pending');

      messageQueue.pushImmediate('first', { id: 'mode' });
      await expect(firstWait).resolves.toMatchObject({ message: 'first' });

      messageQueue.pushImmediate('second', { id: 'mode' });
      await expect(secondWait).resolves.toMatchObject({ message: 'second' });
    } finally {
      firstAbortController.abort();
      secondAbortController.abort();
    }
  });

  it('lets a queued overlapping wait observe its own abort before the active wait completes', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();

    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
        popPendingMessage: vi.fn(async () => false),
        shouldAttemptPendingMaterialization: () => false,
      },
      reconcileWhenEmpty: 'skip',
    });

    const firstWait = consumer.waitForNextInput({ abortSignal: firstAbortController.signal });
    await Promise.resolve();
    await Promise.resolve();

    const secondWait = consumer.waitForNextInput({ abortSignal: secondAbortController.signal });
    secondAbortController.abort();

    try {
      await expect(secondWait).resolves.toBeNull();
    } finally {
      firstAbortController.abort();
      await expect(firstWait).resolves.toBeNull();
    }
  });

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

  it('refreshes metadata before returning an already queued input batch', async () => {
    type Mode = { id: string };
    const mode: Mode = { id: 'mode-1' };
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const events: string[] = [];
    queue.pushImmediate('hello', mode);

    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
        popPendingMessage: vi.fn(async () => false),
      },
      onMetadataUpdate: () => {
        events.push('metadata');
      },
    });

    const result = await consumer.waitForNextInput({ abortSignal: new AbortController().signal });
    events.push(`returned:${result?.message ?? 'null'}`);

    expect(events).toEqual(['metadata', 'returned:hello']);
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

  it('forwards live active-turn delivery policy while waiting for provider input', async () => {
    type Mode = { id: string };
    const mode: Mode = { id: 'mode-1' };
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      queue.pushImmediate('from-active-pending', mode);
      return { type: 'materialized' as const, localId: 'local-1', seq: 1, content: null };
    });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
        popPendingMessage: vi.fn(async () => false),
      },
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });

    const result = await consumer.waitForNextInput({ abortSignal: new AbortController().signal });

    expect(result?.message).toBe('from-active-pending');
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'throttled',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
  });

  it('forwards runtime-idle pending delivery timing while waiting for provider input', async () => {
    type Mode = { id: string };
    const mode: Mode = { id: 'mode-1' };
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      queue.pushImmediate('from-runtime-idle-pending', mode);
      return { type: 'materialized' as const, localId: 'local-1', seq: 1, content: null };
    });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
        popPendingMessage: vi.fn(async () => false),
      },
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    } as Parameters<typeof createSessionProviderInputConsumer<Mode, string>>[0] & { pendingQueueDeliveryTiming: 'after_runtime_idle' });

    const result = await consumer.waitForNextInput({ abortSignal: new AbortController().signal });

    expect(result?.message).toBe('from-runtime-idle-pending');
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'throttled',
      deliveryTiming: 'after_runtime_idle',
    });
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

  it('refreshes metadata on idle timer wake', async () => {
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
        idleWakePollIntervalMs: 1,
      });

      const pending = consumer.waitForNextInput({ abortSignal: abortController.signal });
      await vi.advanceTimersByTimeAsync(30_000);
      abortController.abort();
      await pending;

      expect(onMetadataUpdate).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes metadata when the idle timer wins after failed metadata wakes', async () => {
    vi.useFakeTimers();
    try {
      type Mode = { id: string };
      const queue = new MessageQueue2<Mode>(() => 'hash');
      const onMetadataUpdate = vi.fn();
      const abortController = new AbortController();

      const consumer = createSessionProviderInputConsumer({
        messageQueue: queue,
        session: {
          waitForMetadataUpdate: vi.fn(async () => false),
          materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
          popPendingMessage: vi.fn(async () => false),
        },
        onMetadataUpdate,
        reconcileWhenEmpty: 'skip',
        idleWakePollIntervalMs: 1,
      });

      const pending = consumer.waitForNextInput({ abortSignal: abortController.signal });
      await vi.advanceTimersByTimeAsync(30_000);
      abortController.abort();
      await pending;

      expect(onMetadataUpdate).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting after a transient non-aborted metadata wake failure when idle polling is disabled', async () => {
    vi.useFakeTimers();
    try {
      type Mode = { id: string };
      const queue = new MessageQueue2<Mode>(() => 'hash');
      const abortController = new AbortController();
      const consumer = createSessionProviderInputConsumer({
        messageQueue: queue,
        session: {
          waitForMetadataUpdate: vi.fn(async () => false),
          materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
          popPendingMessage: vi.fn(async () => false),
        },
        reconcileWhenEmpty: 'skip',
        idleWakePollIntervalMs: 0,
      });

      const pending = consumer.waitForNextInput({ abortSignal: abortController.signal });
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();

      queue.pushImmediate('after reconnect', { id: 'mode' });
      await expect(pending).resolves.toMatchObject({ message: 'after reconnect' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting after a rejected metadata wake when idle polling is disabled', async () => {
    vi.useFakeTimers();
    try {
      type Mode = { id: string };
      const queue = new MessageQueue2<Mode>(() => 'hash');
      const abortController = new AbortController();
      const consumer = createSessionProviderInputConsumer({
        messageQueue: queue,
        session: {
          waitForMetadataUpdate: vi
            .fn<() => Promise<boolean>>()
            .mockRejectedValueOnce(new Error('metadata stream disconnected'))
            .mockImplementation(() => new Promise<boolean>(() => {})),
          materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
          popPendingMessage: vi.fn(async () => false),
        },
        reconcileWhenEmpty: 'skip',
        idleWakePollIntervalMs: 0,
        metadataWaitRetryBackoffMs: 1,
      });

      const pending = consumer.waitForNextInput({ abortSignal: abortController.signal });
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).not.toHaveBeenCalled();

      queue.pushImmediate('after rejected metadata wait', { id: 'mode' });
      await expect(pending).resolves.toMatchObject({ message: 'after rejected metadata wait' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps transient metadata wait failures internal and refreshes before returning the queued batch', async () => {
    vi.useFakeTimers();
    try {
      type Mode = { id: string };
      const queue = new MessageQueue2<Mode>(() => 'hash');
      const onMetadataUpdate = vi.fn();
      const abortController = new AbortController();
      const consumer = createSessionProviderInputConsumer({
        messageQueue: queue,
        session: {
          waitForMetadataUpdate: vi.fn(async () => false),
          materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
          popPendingMessage: vi.fn(async () => false),
        },
        onMetadataUpdate,
        reconcileWhenEmpty: 'skip',
        idleWakePollIntervalMs: 0,
      });

      const pending = consumer.waitForNextInput({ abortSignal: abortController.signal });
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(250);
      expect(settled).not.toHaveBeenCalled();
      expect(onMetadataUpdate).not.toHaveBeenCalled();

      queue.pushImmediate('after retry', { id: 'mode' });
      await expect(pending).resolves.toMatchObject({ message: 'after retry' });
      expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks a visible pending row after repeated safe-materializer faults while keeping the wait alive', async () => {
    type Mode = { id: string };
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const abortController = new AbortController();
    const materializeError = Object.assign(new Error('pending delivery metadata was malformed'), {
      localId: 'local-permanent-fault',
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      throw materializeError;
    });
    const blockPendingMessageDelivery = vi.fn(async () => true);
    const waitForMetadataUpdate = vi.fn(async () => {
      if (blockPendingMessageDelivery.mock.calls.length > 0) {
        abortController.abort();
        return false;
      }
      return true;
    });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate,
        materializeNextPendingMessageSafely,
        popPendingMessage: vi.fn(async () => false),
        blockPendingMessageDelivery,
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(3);
    expect(blockPendingMessageDelivery).toHaveBeenCalledTimes(1);
    expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-permanent-fault'],
      reason: 'unknown',
    });
  });

  it('propagates auth-class materialization errors for park handling', async () => {
    type Mode = { id: string };
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const abortController = new AbortController();
    const authError = new PendingQueueMaterializationAuthError();
    const blockPendingMessageDelivery = vi.fn(async () => true);

    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: async () => {
          abortController.abort();
          return false;
        },
        materializeNextPendingMessageSafely: vi.fn(async () => {
          throw authError;
        }),
        popPendingMessage: vi.fn(async () => false),
        blockPendingMessageDelivery,
      },
      reconcileWhenEmpty: 'skip',
      idleWakePollIntervalMs: 0,
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).rejects.toBe(authError);
    expect(blockPendingMessageDelivery).not.toHaveBeenCalled();
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

  it('forwards live active-turn delivery policy during pending drains', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn()
      .mockResolvedValueOnce({ type: 'materialized' as const, localId: 'local-1', seq: 1, content: null })
      .mockResolvedValueOnce({ type: 'no_pending' as const });
    const shouldAttemptPendingMaterialization = vi.fn(
      async (opts?: { activeTurnDeliveryPolicy?: 'block' | 'allow_live_delivery' }) =>
        opts?.activeTurnDeliveryPolicy === 'allow_live_delivery',
    );

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2(() => 'hash'),
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
        popPendingMessage: vi.fn(async () => false),
        shouldAttemptPendingMaterialization,
      },
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });

    await expect(consumer.drainPending({ maxPopPerWake: 5, reason: 'test-active-policy' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'no_pending',
    });
    expect(shouldAttemptPendingMaterialization).toHaveBeenCalledWith({
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(1, {
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(2, {
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
  });

  it('forwards adapter default live active-turn delivery policy during pending drains', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn()
      .mockResolvedValueOnce({ type: 'materialized' as const, localId: 'local-1', seq: 1, content: null })
      .mockResolvedValueOnce({ type: 'no_pending' as const });
    const shouldAttemptPendingMaterialization = vi.fn(
      async (opts?: { activeTurnDeliveryPolicy?: 'block' | 'allow_live_delivery' }) =>
        opts?.activeTurnDeliveryPolicy === 'allow_live_delivery',
    );

    const adapter = createSessionProviderPendingDrainAdapter({
      waitForMetadataUpdate: async () => false,
      materializeNextPendingMessageSafely,
      popPendingMessage: vi.fn(async () => false),
      shouldAttemptPendingMaterialization,
    }, {
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });

    await expect(adapter.drainPending({ maxPopPerWake: 5, reason: 'test-adapter-active-policy' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'no_pending',
    });
    expect(shouldAttemptPendingMaterialization).toHaveBeenCalledWith({
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(1, {
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(2, {
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
  });

  it('forwards runtime-idle pending delivery timing during pending drains', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn()
      .mockResolvedValueOnce({ type: 'deferred' as const, reason: 'runtime_activity_active' as const });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2(() => 'hash'),
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
        popPendingMessage: vi.fn(async () => false),
        shouldAttemptPendingMaterialization: () => true,
      },
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    } as Parameters<typeof createSessionProviderInputConsumer<never, never>>[0] & { pendingQueueDeliveryTiming: 'after_runtime_idle' });

    await expect(consumer.drainPending({ maxPopPerWake: 5, reason: 'test-runtime-idle-policy' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'deferred',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_runtime_idle',
    });
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
