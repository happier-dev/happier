import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { HttpStatusError } from '@/api/client/httpStatusError';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { RuntimeActivitySnapshotTail } from '@/api/session/mutations/createSessionMutationOutbox';
import { logger } from '@/ui/logger';

import {
  createSessionProviderInputConsumer,
  PendingQueueMaterializationAuthError,
} from './SessionProviderInputConsumer';
import type { DrainPendingOptions, DrainPendingResult } from './types';

type TestMode = { id: string };
type ConsumerWithDrain = ReturnType<typeof createSessionProviderInputConsumer<TestMode, string>> & {
  drainPending?: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

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
  it('arms the Pending wake before an active-turn pass and drains once for the wake without polling', async () => {
    const metadataWakes: Array<(updated: boolean) => void> = [];
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValueOnce({ type: 'no_pending' })
      .mockResolvedValueOnce({
        type: 'materialized',
        localId: 'active-turn-steer',
        seq: 12,
        content: null,
      });
    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely,
      waitForPendingEligibilityUpdate: async (signal) => await new Promise<boolean>((resolve) => {
        const finish = (updated: boolean) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(updated);
        };
        const onAbort = () => finish(false);
        metadataWakes.push(finish);
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    });
    const abortController = new AbortController();
    const pump = (consumer as ConsumerWithDrain & {
      pumpPendingWhileActive: (opts: { abortSignal: AbortSignal; reason: string }) => Promise<void>;
    }).pumpPendingWhileActive({
      abortSignal: abortController.signal,
      reason: 'active-turn-test',
    });

    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
    expect(metadataWakes).toHaveLength(1);

    metadataWakes.shift()?.(true);
    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2));
    expect(metadataWakes).toHaveLength(1);

    abortController.abort();
    await expect(pump).resolves.toBeUndefined();
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
  });

  it('ends the active-turn pump when the wake is unavailable instead of synchronously re-arming', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'no_pending' });
    const unavailableForever = new Promise<boolean>(() => {});
    const waitForPendingEligibilityUpdate = vi
      .fn<(signal?: AbortSignal) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockReturnValue(unavailableForever);
    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely,
      waitForPendingEligibilityUpdate,
    });
    const pump = consumer.pumpPendingWhileActive({
      abortSignal: new AbortController().signal,
      reason: 'active-turn-unavailable-test',
    });

    await expect(Promise.race([
      pump.then(() => 'completed' as const),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 25)),
    ])).resolves.toBe('completed');
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    expect(waitForPendingEligibilityUpdate).toHaveBeenCalledTimes(2);
  });

  it('uses one bounded reconnect wake to run exactly one new unconditional active-turn pass', async () => {
    const metadataWakes: Array<(updated: boolean) => void> = [];
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    const waitForPendingEligibilityUpdate = vi.fn(async (signal?: AbortSignal) => await new Promise<boolean>((resolve) => {
      const finish = (updated: boolean) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(updated);
      };
      const onAbort = () => finish(false);
      metadataWakes.push(finish);
      signal?.addEventListener('abort', onAbort, { once: true });
    }));
    const consumer = createDrainConsumer({ materializeNextPendingMessageSafely, waitForPendingEligibilityUpdate });
    const abortController = new AbortController();
    const pump = consumer.pumpPendingWhileActive({
      abortSignal: abortController.signal,
      reason: 'active-turn-reconnect-test',
    });

    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
    metadataWakes.shift()?.(false);
    await vi.waitFor(() => expect(waitForPendingEligibilityUpdate).toHaveBeenCalledTimes(2));
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);

    metadataWakes.shift()?.(true);
    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2));
    expect(waitForPendingEligibilityUpdate).toHaveBeenCalledTimes(3);

    abortController.abort();
    await expect(pump).resolves.toBeUndefined();
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
  });

  it('closes admission synchronously and waits for an active provider dispatch to drain', async () => {
    let releaseDispatch: () => void = () => {};
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      waitForPendingEligibilityUpdate: async () => false,
    });
    const providerCall = vi.fn(async () => {
      await dispatchGate;
      return 'accepted' as const;
    });

    const dispatch = consumer.runProviderInputDispatch({
      abortSignal: new AbortController().signal,
      dispatch: providerCall,
    });
    await Promise.resolve();
    const drained = vi.fn();
    const close = consumer.closeProviderInputAdmissionAndWaitForDispatches().then(drained);
    const rejected = consumer.runProviderInputDispatch({
      abortSignal: new AbortController().signal,
      dispatch: vi.fn(async () => 'late' as const),
    });
    await Promise.resolve();

    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(drained).not.toHaveBeenCalled();
    await expect(rejected).resolves.toEqual({ status: 'cancelled' });

    releaseDispatch();
    await expect(dispatch).resolves.toEqual({ status: 'dispatched', value: 'accepted' });
    await close;
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it('waits for in-flight materialization and fail-closes a claim returned after admission closes', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    let releaseMaterialization: () => void = () => {};
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    const blockPendingMessageDelivery = vi.fn(async () => true);
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      await materializationGate;
      messageQueue.push('claimed during replacement', { id: 'mode' }, {
        userMessageLocalId: 'replacement-claim',
        providerAcceptancePending: true,
        pendingProviderAction: 'send',
      });
      return {
        type: 'materialized' as const,
        localId: 'replacement-claim',
        seq: null,
        content: null,
      };
    });
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        blockPendingMessageDelivery,
        waitForPendingEligibilityUpdate: async () => false,
      },
    });
    const wait = consumer.waitForNextInput({ abortSignal: new AbortController().signal });
    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));

    const closed = vi.fn();
    const close = consumer.closeProviderInputAdmissionAndWaitForDispatches().then(closed);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).not.toHaveBeenCalled();
    await expect(consumer.runProviderInputDispatch({
      abortSignal: new AbortController().signal,
      dispatch: vi.fn(async () => 'must-not-run'),
    })).resolves.toEqual({ status: 'cancelled' });

    releaseMaterialization();
    await expect(wait).resolves.toBeNull();
    await close;
    expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['replacement-claim'],
      reason: 'unknown',
    });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('prevents a pending claim after input admission closes', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely,
      waitForPendingEligibilityUpdate: async () => false,
    });

    await consumer.closeProviderInputAdmissionAndWaitForDispatches();

    await expect(consumer.drainPending?.({ reason: 'runtime-replacement' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'drain_disallowed',
    });
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
  });

  it('allows an active-turn pending action when ordinary provider work has no claimed pending custody', async () => {
    let releaseProviderDispatch: () => void = () => {};
    const providerDispatchGate = new Promise<void>((resolve) => {
      releaseProviderDispatch = resolve;
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'pending-steer',
      seq: null,
      content: null,
    }));
    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely,
      waitForPendingEligibilityUpdate: async () => false,
    });
    const activeLocalDispatch = consumer.runProviderInputDispatch({
      abortSignal: new AbortController().signal,
      dispatch: async () => {
        await providerDispatchGate;
        return 'local-turn-complete' as const;
      },
    });
    await Promise.resolve();

    await expect(consumer.drainPending?.({ reason: 'active-turn-pending-steer' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);

    releaseProviderDispatch();
    await expect(activeLocalDispatch).resolves.toEqual({
      status: 'dispatched',
      value: 'local-turn-complete',
    });
  });

  it('re-runs the complete pass when metadata wakes during direct materialization', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const abortController = new AbortController();
    const materializationGate = createDeferred<void>();
    const metadataWake = createDeferred<boolean>();
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockImplementationOnce(async () => {
        await materializationGate.promise;
        return { type: 'no_pending' };
      })
      .mockImplementationOnce(async () => {
        messageQueue.push('materialized-after-dirty-pass', { id: 'mode' });
        return {
          type: 'materialized',
          localId: 'dirty-pass',
          seq: 7,
          content: null,
        };
      });
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: () => metadataWake.promise,
      },
    });

    const waiting = consumer.waitForNextInput({ abortSignal: abortController.signal });
    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
    metadataWake.resolve(true);
    materializationGate.resolve();

    await expect(waiting).resolves.toMatchObject({ message: 'materialized-after-dirty-pass' });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    abortController.abort();
  });

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
      materializeNextPendingMessageSafely,
      waitForPendingEligibilityUpdate: async () => false,
    });

    await expect(consumer.drainPending?.({ reason: 'test-default-one' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('never claims a second durable row before the first claimed invocation leaves local custody', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockImplementationOnce(async () => {
        messageQueue.push('first claimed prompt', { id: 'mode' }, {
          userMessageLocalId: 'local-first',
          pendingProviderAction: 'send',
        });
        return {
          type: 'materialized',
          localId: 'local-first',
          seq: 7,
          content: null,
        };
      })
      .mockImplementationOnce(async () => {
        // A later isolate/control prompt replaces local queue contents. Claiming it in the
        // same drain would discard the first claimed row before its provider invocation.
        messageQueue.pushIsolateAndClear('second claimed control', { id: 'mode' }, {
          userMessageLocalId: 'local-second',
          providerAcceptancePending: true,
          pendingProviderAction: 'send',
        });
        return {
          type: 'materialized',
          localId: 'local-second',
          seq: 8,
          content: null,
        };
      });
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: async () => false,
      },
      pendingDrainMaxPopPerWake: 25,
    });

    await expect(consumer.drainPending({ reason: 'two-row-claim-safety-first' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    await expect(consumer.drainPending({ reason: 'two-row-claim-safety-before-consume' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'drain_disallowed',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toMatchObject({
      message: 'first claimed prompt',
      userMessageLocalIds: ['local-first'],
    });
    await expect(consumer.drainPending({ reason: 'two-row-claim-safety-before-dispatch' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'drain_disallowed',
    });
    await expect(consumer.runProviderInputDispatch({
      abortSignal: new AbortController().signal,
      dispatch: async () => 'accepted' as const,
    })).resolves.toEqual({ status: 'dispatched', value: 'accepted' });

    await expect(consumer.drainPending({ reason: 'two-row-claim-safety-reentry' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toMatchObject({
      message: 'second claimed control',
      userMessageLocalIds: ['local-second'],
    });
  });

  it('serializes concurrent drain wakes and rechecks local custody before the next claim', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    let releaseFirstMaterialization: () => void = () => {};
    const firstMaterializationGate = new Promise<void>((resolve) => {
      releaseFirstMaterialization = resolve;
    });
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockImplementationOnce(async () => {
        await firstMaterializationGate;
        messageQueue.push('first concurrent prompt', { id: 'mode' }, {
          userMessageLocalId: 'local-concurrent-first',
          providerAcceptancePending: true,
          pendingProviderAction: 'send',
        });
        return {
          type: 'materialized',
          localId: 'local-concurrent-first',
          seq: 9,
          content: null,
        };
      })
      .mockImplementationOnce(async () => {
        messageQueue.pushIsolateAndClear('second concurrent control', { id: 'mode' }, {
          userMessageLocalId: 'local-concurrent-second',
          providerAcceptancePending: true,
          pendingProviderAction: 'send',
        });
        return {
          type: 'materialized',
          localId: 'local-concurrent-second',
          seq: 10,
          content: null,
        };
      });
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: async () => false,
      },
      pendingDrainMaxPopPerWake: 25,
    });

    const firstDrain = consumer.drainPending({ reason: 'concurrent-drain-first' });
    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
    const overlappingDrain = consumer.drainPending({ reason: 'concurrent-drain-overlap' });
    releaseFirstMaterialization();

    await expect(Promise.all([firstDrain, overlappingDrain])).resolves.toEqual([
      { materialized: 1, stoppedReason: 'max_pop_per_wake' },
      { materialized: 0, stoppedReason: 'drain_disallowed' },
    ]);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    await expect(messageQueue.waitForMessagesAndGetAsString()).resolves.toMatchObject({
      message: 'first concurrent prompt',
      userMessageLocalIds: ['local-concurrent-first'],
    });

    await expect(consumer.drainPending({ reason: 'concurrent-drain-reentry' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    await expect(messageQueue.waitForMessagesAndGetAsString()).resolves.toMatchObject({
      message: 'second concurrent control',
      userMessageLocalIds: ['local-concurrent-second'],
    });
  });

  it('does not retain a reservation after an awaited direct steer or blocked-steer disposition', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValueOnce({
        type: 'materialized',
        localId: 'local-direct-steer',
        seq: null,
        content: null,
      })
      .mockResolvedValueOnce({
        type: 'materialized',
        localId: 'local-blocked-steer',
        seq: null,
        content: null,
      })
      .mockResolvedValueOnce({ type: 'no_pending' });
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: async () => false,
      },
      pendingDrainMaxPopPerWake: 25,
    });

    await expect(consumer.drainPending({ reason: 'direct-steer-completed' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(messageQueue.size()).toBe(0);
    await expect(consumer.drainPending({ reason: 'blocked-steer-completed' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(messageQueue.size()).toBe(0);
    await expect(consumer.drainPending({ reason: 'after-awaited-direct-dispositions' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'no_pending',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(3);
  });

  it('releases a dequeued claimed-batch reservation when the provider requests its next input', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    messageQueue.push('claimed send', { id: 'mode' }, {
      userMessageLocalId: 'local-claimed-send',
      pendingProviderAction: 'send',
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: async () => false,
      },
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toMatchObject({
      message: 'claimed send',
      pendingProviderAction: 'send',
    });
    await expect(consumer.drainPending({ reason: 'claimed-send-before-provider-reentry' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'drain_disallowed',
    });

    messageQueue.push('next ordinary input', { id: 'mode' });
    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toMatchObject({
      message: 'next ordinary input',
    });
    await expect(consumer.drainPending({ reason: 'claimed-send-after-provider-reentry' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'no_pending',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('reconciles a reserved localId before allowing a later durable row to drain', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    messageQueue.push('claimed send', { id: 'mode' }, {
      userMessageLocalId: 'local-claimed-send',
      pendingProviderAction: 'send',
    });
    let hasBlockingCanonicalDelivery = true;
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'local-later-send',
      seq: 9,
      content: null,
    }));
    const reconcilePendingQueueState = vi.fn(async () => {
      hasBlockingCanonicalDelivery = false;
      return true;
    });
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => !hasBlockingCanonicalDelivery,
        reconcilePendingQueueState,
        waitForPendingEligibilityUpdate: async () => false,
      },
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toMatchObject({
      message: 'claimed send',
      userMessageLocalIds: ['local-claimed-send'],
    });

    await expect(consumer.drainPending({ reason: 'reserved-local-id-retired' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: false });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('keeps a reserved localId fenced when canonical reconciliation fails transiently', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    messageQueue.push('claimed send', { id: 'mode' }, {
      userMessageLocalId: 'local-claimed-send',
      pendingProviderAction: 'send',
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'local-later-send',
      seq: 9,
      content: null,
    }));
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => true,
        reconcilePendingQueueState: async () => {
          throw new Error('transient reconciliation failure');
        },
        waitForPendingEligibilityUpdate: async () => false,
      },
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toMatchObject({
      message: 'claimed send',
      userMessageLocalIds: ['local-claimed-send'],
    });

    await expect(consumer.drainPending({ reason: 'reconciliation-failed' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'drain_disallowed',
    });
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
  });

  it('uses structured pending materialization for a drain', async () => {
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
      materializeNextPendingMessageSafely,
      waitForPendingEligibilityUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ maxPopPerWake: 5, reason: 'test-safe' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      onDiagnosticPhase: expect.any(Function),
    });
  });

  it('reconciles before stopping when materialization is disallowed', async () => {
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingQueueState,
      waitForPendingEligibilityUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ reason: 'test-disallowed' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'materialization_blocked',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
  });

  it('passes active-turn steerability into the drain preflight gate', async () => {
    const shouldAttemptPendingMaterialization = vi.fn((
      opts?: { activeTurnSteerability?: 'steerable' | 'unsteerable' },
    ) => opts?.activeTurnSteerability === 'steerable');
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'materialized',
        localId: 'local-live',
        seq: 11,
        content: null,
      });

    const consumer = createDrainConsumer(
      {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization,
        waitForPendingEligibilityUpdate: async () => false,
      },
      { activeTurnSteerability: 'steerable' },
    );

    await expect(consumer.drainPending?.({ reason: 'test-live-preflight' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(shouldAttemptPendingMaterialization).toHaveBeenCalledWith({
      activeTurnSteerability: 'steerable',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      activeTurnSteerability: 'steerable',
      onDiagnosticPhase: expect.any(Function),
    });
  });

  it('lets explicit drain steerability override a default resolver', async () => {
    const shouldAttemptPendingMaterialization = vi.fn(() => true);
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'no_pending' });

    const consumer = createDrainConsumer(
      {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization,
        waitForPendingEligibilityUpdate: async () => false,
      },
      { resolveActiveTurnSteerability: () => 'steerable' },
    );

    await expect(consumer.drainPending?.({
      reason: 'test-explicit-unsteerable-over-default-resolver',
      activeTurnSteerability: 'unsteerable',
    })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'no_pending',
    });
    expect(shouldAttemptPendingMaterialization).toHaveBeenCalledWith({
      activeTurnSteerability: 'unsteerable',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      activeTurnSteerability: 'unsteerable',
      onDiagnosticPhase: expect.any(Function),
    });
  });

  it('returns an error result when reconciliation fails during drain', async () => {
    const reconcilePendingQueueState = vi.fn(async () => {
      throw new Error('reconcile failed');
    });

    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingQueueState,
      waitForPendingEligibilityUpdate: async () => false,
    });

    await expect(consumer.drainPending({ reason: 'test-reconcile-error' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'error',
    });
    expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
  });

  it('stops after terminal auth failure without throwing', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      throw new HttpStatusError(401, 'Authentication failed');
    });

    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely,
      waitForPendingEligibilityUpdate: async () => false,
    });

    expect(consumer.drainPending).toEqual(expect.any(Function));
    await expect(consumer.drainPending?.({ maxPopPerWake: 5, reason: 'test-auth' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'auth_failure',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('does not create a local retry episode for a typed unavailable materializer', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'retryable_transport' as const }));
    const consumer = createDrainConsumer(
      {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: async () => false,
      },
    );

    await expect(consumer.drainPending?.({ reason: 'test-legacy-pop-name' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'error',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });
});

describe('SessionProviderInputConsumer waitForNextInput', () => {
  it('does not treat an unrelated general metadata notification as Pending eligibility', async () => {
    const abortController = new AbortController();
    const generalMetadataWake = createDeferred<boolean>();
    const pendingEligibilityWake = createDeferred<boolean>();
    const never = new Promise<boolean>(() => {});
    const waitForMetadataUpdate = vi.fn()
      .mockImplementationOnce(() => generalMetadataWake.promise)
      .mockImplementation(() => never);
    const waitForPendingEligibilityUpdate = vi.fn()
      .mockImplementationOnce(() => pendingEligibilityWake.promise)
      .mockImplementation(() => never);
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate,
        waitForPendingEligibilityUpdate,
      } as Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]['session'] & {
        waitForMetadataUpdate: (signal?: AbortSignal) => Promise<boolean>;
        waitForPendingEligibilityUpdate: (signal?: AbortSignal) => Promise<boolean>;
      },
      reconcileWhenEmpty: 'skip',
    });

    const waiting = consumer.waitForNextInput({ abortSignal: abortController.signal });
    try {
      await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));

      generalMetadataWake.resolve(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);

      pendingEligibilityWake.resolve(true);
      await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2));
    } finally {
      abortController.abort();
      generalMetadataWake.resolve(false);
      pendingEligibilityWake.resolve(false);
      await waiting;
    }
  });

  it('serializes overlapping waits without duplicating queued messages', async () => {
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));

    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => false,
        waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
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

      messageQueue.push('first', { id: 'mode' });
      await expect(firstWait).resolves.toMatchObject({ message: 'first' });

      messageQueue.push('second', { id: 'mode' });
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
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
        shouldAttemptPendingMaterialization: () => false,
        waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
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

  it('routes passive known-empty materialization through the safe materializer policy', async () => {
    const abortController = new AbortController();
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({
        type: 'no_pending',
      });
    const reconcilePendingQueueState = vi.fn(async () => false);

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => false,
        reconcilePendingQueueState,
        waitForPendingEligibilityUpdate: async () => {
          abortController.abort();
          return false;
        },
      },
      reconcileWhenEmpty: 'skip',
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'skip',
      onDiagnosticPhase: expect.any(Function),
    });
    expect(reconcilePendingQueueState).not.toHaveBeenCalled();
  });

  it('keeps waiting instead of rejecting when safe materialization throws before a batch is queued', async () => {
    const abortController = new AbortController();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const materializeError = new Error('provider attach returned an unexpected response');
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockRejectedValue(materializeError);

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: async () => {
          abortController.abort();
          return false;
        },
      },
      reconcileWhenEmpty: 'skip',
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();
    expect(debugSpy).toHaveBeenCalledWith(
      '[pendingQueue] input consumer materialization failed (non-fatal)',
      materializeError,
    );
    debugSpy.mockRestore();
  });

  it('blocks a visible pending row immediately for a non-transport contract fault with local-id evidence', async () => {
    const abortController = new AbortController();
    const materializeError = Object.assign(
      new Error('provider attach returned malformed pending delivery metadata'),
      { localId: ' permanent-fault-local\n' },
    );
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockRejectedValue(materializeError);
    const metadataWake = createDeferred<boolean>();
    const blockPendingMessageDelivery = vi.fn(async () => {
      abortController.abort();
      metadataWake.resolve(false);
      return true;
    });

    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        blockPendingMessageDelivery,
        waitForPendingEligibilityUpdate: async () => await metadataWake.promise,
      },
      reconcileWhenEmpty: 'skip',
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: [' permanent-fault-local\n'],
      reason: 'unknown',
    });
  });

  it('does not block a materialization fault attributed to plural pending identities', async () => {
    const abortController = new AbortController();
    const materializeError = Object.assign(
      new Error('provider attach returned ambiguous pending delivery metadata'),
      { localIds: ['pending-local-a', 'pending-local-b'] },
    );
    const blockPendingMessageDelivery = vi.fn(async () => true);
    const abortTimer = setTimeout(() => abortController.abort(), 0);
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely: vi.fn(async () => {
          throw materializeError;
        }),
        blockPendingMessageDelivery,
        waitForPendingEligibilityUpdate: async () => false,
      },
      reconcileWhenEmpty: 'skip',
    });

    try {
      await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();
    } finally {
      clearTimeout(abortTimer);
    }

    expect(blockPendingMessageDelivery).not.toHaveBeenCalled();
  });

  it('logs text-free materialization decisions with steerability metadata', async () => {
    const abortController = new AbortController();
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
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: async () => {
          abortController.abort();
          return false;
        },
      },
      activeTurnSteerability: 'steerable',
      reconcileWhenEmpty: 'skip',
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();

    expect(debugSpy).toHaveBeenCalledWith('[pendingQueue] input consumer materialization decision', {
      activeTurnSteerability: 'steerable',
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


  it('keeps waiting after a transient non-aborted metadata wait failure when idle polling is disabled', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
      const onMetadataUpdate = vi.fn(async () => {});
      const consumer = createSessionProviderInputConsumer({
        messageQueue,
        session: {
          materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
          waitForPendingEligibilityUpdate: vi.fn(async () => false),
        },
        onMetadataUpdate,
        reconcileWhenEmpty: 'skip',
      });

      const waitPromise = consumer.waitForNextInput({ abortSignal: abortController.signal });
      const settled = vi.fn();
      void waitPromise.then(settled, settled);

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();

      messageQueue.push('after reconnect', { id: 'mode' });
      await expect(waitPromise).resolves.toMatchObject({ message: 'after reconnect' });
      expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting after a rejected metadata wait when idle polling is disabled', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
      const onMetadataUpdate = vi.fn(async () => {});
      const consumer = createSessionProviderInputConsumer({
        messageQueue,
        session: {
          materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
          waitForPendingEligibilityUpdate: vi
            .fn<() => Promise<boolean>>()
            .mockRejectedValueOnce(new Error('metadata stream disconnected'))
            .mockImplementation(() => new Promise<boolean>(() => {})),
        },
        onMetadataUpdate,
        reconcileWhenEmpty: 'skip',
        metadataWaitRetryBackoffMs: 1,
      });

      const waitPromise = consumer.waitForNextInput({ abortSignal: abortController.signal });
      const settled = vi.fn();
      void waitPromise.then(settled, settled);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).not.toHaveBeenCalled();

      messageQueue.push('after rejected metadata wait', { id: 'mode' });
      await expect(waitPromise).resolves.toMatchObject({ message: 'after rejected metadata wait' });
      expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when an aborted metadata wait resolves false', async () => {
    const onMetadataUpdate = vi.fn(async () => {});
    const abortController = new AbortController();
    abortController.abort();
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
        waitForPendingEligibilityUpdate: vi.fn(async () => false),
      },
      onMetadataUpdate,
      reconcileWhenEmpty: 'skip',
    });

    await expect(consumer.waitForNextInput({ abortSignal: abortController.signal })).resolves.toBeNull();
    expect(onMetadataUpdate).not.toHaveBeenCalled();
  });

  it('releases a queued input wait when metadata reconciliation never settles and the session closes', async () => {
    const abortController = new AbortController();
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const metadataStarted = createDeferred<void>();
    const onMetadataUpdate = vi.fn(async () => {
      metadataStarted.resolve();
      await new Promise<void>(() => {});
    });
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
        waitForPendingEligibilityUpdate: vi.fn(async () => false),
      },
      onMetadataUpdate,
      reconcileWhenEmpty: 'skip',
    });

    messageQueue.push('queued before close', { id: 'mode' });
    const waitPromise = consumer.waitForNextInput({ abortSignal: abortController.signal });
    await metadataStarted.promise;
    abortController.abort();

    await expect(Promise.race([
      waitPromise.then((value) => ({ status: 'settled' as const, value })),
      new Promise<{ status: 'timed_out' }>((resolve) => setTimeout(() => resolve({ status: 'timed_out' }), 25)),
    ])).resolves.toEqual({ status: 'settled', value: null });
    expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
  });

  it('reports the exact materialization subphase when the canonical owner remains unsettled', async () => {
    vi.useFakeTimers();
    const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    try {
      const materialization = createDeferred<MaterializeNextPendingResult>();
      const materializeNextPendingMessageSafely = vi.fn(async (options?: unknown) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
        const diagnostics = options as {
          onDiagnosticPhase?: (phase: 'materialize.server_claim') => void;
        } | undefined;
        diagnostics?.onDiagnosticPhase?.('materialize.server_claim');
        return await materialization.promise;
      });
      const consumer = createDrainConsumer({
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: vi.fn(async () => false),
      });

      const drain = consumer.drainPending?.({ maxPopPerWake: 1, reason: 'slow-phase-diagnostic-test' });
      if (!drain) throw new Error('Missing drainPending test seam');
      await vi.advanceTimersByTimeAsync(0);
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(infoFileSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(infoFileSpy).toHaveBeenCalledWith(
        '[pendingQueue] input consumer phase remains unsettled',
        expect.objectContaining({ phase: 'materialize.server_claim' }),
      );

      materialization.resolve({ type: 'no_pending' });
      await expect(drain).resolves.toMatchObject({ materialized: 0 });
      expect(infoFileSpy).toHaveBeenCalledWith(
        '[pendingQueue] input consumer slow phase settled',
        expect.objectContaining({ phase: 'materialize.server_claim' }),
      );
    } finally {
      infoFileSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('waits for a fresh eligibility event before retrying transient transport', async () => {
    const abortController = new AbortController();
    const eligibilityWake = createDeferred<boolean>();
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValueOnce({ type: 'retryable_transport' } as MaterializeNextPendingResult)
      .mockImplementationOnce(async () => {
        messageQueue.push('recovered', { id: 'mode' });
        return { type: 'materialized', localId: 'recovered-local', seq: 1, content: null };
      });
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: () => eligibilityWake.promise,
      },
    } as Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]);

    const first = consumer.waitForNextInput({ abortSignal: abortController.signal });
    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
    eligibilityWake.resolve(true);
    const firstResult = await first;

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    expect(firstResult).toMatchObject({ message: 'recovered' });
  });

  it('reconciles once and schedules a bounded retry when transport fails without a server delay', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
      const reconcilePendingQueueState = vi.fn(async () => {});
      const materializeNextPendingMessageSafely = vi
        .fn<() => Promise<MaterializeNextPendingResult>>()
        .mockResolvedValueOnce({ type: 'retryable_transport' } as MaterializeNextPendingResult)
        .mockImplementationOnce(async () => {
          messageQueue.push('recovered after reconciliation', { id: 'mode' });
          return { type: 'materialized', localId: 'recovered-local', seq: 1, content: null };
        });
      const consumer = createSessionProviderInputConsumer({
        messageQueue,
        session: {
          materializeNextPendingMessageSafely,
          reconcilePendingQueueState,
          waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
        },
        metadataWaitRetryBackoffMs: 250,
      } as Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]);

      const waiting = consumer.waitForNextInput({ abortSignal: abortController.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(249);
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toMatchObject({ message: 'recovered after reconciliation' });
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejoins an ambiguously acknowledged materialization after its requested backoff without a new eligibility event', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
      const materializeNextPendingMessageSafely = vi
        .fn<() => Promise<MaterializeNextPendingResult>>()
        .mockResolvedValueOnce({ type: 'retryable_transport', retryAfterMs: 1_000 })
        .mockImplementationOnce(async () => {
          messageQueue.push('rejoined frozen claim', { id: 'mode' });
          return { type: 'materialized', localId: 'rejoined-local', seq: 1, content: null };
        });
      const consumer = createSessionProviderInputConsumer({
        messageQueue,
        session: {
          materializeNextPendingMessageSafely,
          waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
        },
      } as Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]);

      const waiting = consumer.waitForNextInput({ abortSignal: abortController.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toMatchObject({ message: 'rejoined frozen claim' });
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps timer-driven ambiguous materialization rejoin at one attempt until another wake', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const materializeNextPendingMessageSafely = vi
        .fn<() => Promise<MaterializeNextPendingResult>>()
        .mockResolvedValue({ type: 'retryable_transport', retryAfterMs: 1_000 });
      const consumer = createSessionProviderInputConsumer({
        messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
        session: {
          materializeNextPendingMessageSafely,
          waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
        },
      } as Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]);

      const waiting = consumer.waitForNextInput({ abortSignal: abortController.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);

      abortController.abort();
      await expect(waiting).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads locally applied delivery timing after each eligibility event', async () => {
    const abortController = new AbortController();
    const eligibilityWake = createDeferred<boolean>();
    let deliveryTiming: 'after_foreground_ready' | 'after_runtime_idle' = 'after_runtime_idle';
    const materializeNextPendingMessageSafely = vi
      .fn<(opts?: { pendingQueueDeliveryTiming?: typeof deliveryTiming }) => Promise<MaterializeNextPendingResult>>()
      .mockImplementationOnce(async () => {
        deliveryTiming = 'after_foreground_ready';
        return { type: 'retryable_transport' };
      })
      .mockImplementationOnce(async () => {
        abortController.abort();
        return { type: 'no_pending' };
      });
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: () => eligibilityWake.promise,
      },
      resolvePendingQueueDeliveryTiming: () => deliveryTiming,
    });

    const waiting = consumer.waitForNextInput({ abortSignal: abortController.signal });
    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
    eligibilityWake.resolve(true);
    await waiting;

    expect(materializeNextPendingMessageSafely.mock.calls.map(([opts]) => opts?.pendingQueueDeliveryTiming))
      .toEqual(['after_runtime_idle', 'after_foreground_ready']);
  });

  it('lets the server classify an idle-timed action before waiting for an exact Activity cut', async () => {
    const tailChanged = createDeferred<boolean>();
    const firstMaterialization = createDeferred<MaterializeNextPendingResult>();
    let tail: RuntimeActivitySnapshotTail = {
      sequence: 7,
      custody: {
        identity: {
          mutationKey: 'activity-pending-8',
          admissionOrder: 8,
        },
        value: { state: 'idle' as const, activeCount: 0 },
      },
      settlement: {
        identity: {
          mutationKey: 'activity-applied-6',
          admissionOrder: 6,
        },
        desiredValue: { state: 'active' as const, activeCount: 1 },
        result: 'applied' as const,
        committedProjection: {
          state: 'active' as const,
          activeCount: 1,
          observedAt: 90,
          revision: 40,
        },
        committedRevision: 40,
      },
    };
    const messageQueue = new MessageQueue2<TestMode>(() => 'hash');
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockImplementationOnce(async () => await firstMaterialization.promise)
      .mockImplementationOnce(async () => {
        messageQueue.push('after-exact-idle', { id: 'mode' });
        return { type: 'materialized', localId: 'after-exact-idle', seq: null, content: null };
      });
    const readRuntimeActivitySnapshotTail = vi.fn(() => tail);
    const waitForRuntimeActivitySnapshotTailChange = vi.fn(async () => await tailChanged.promise);
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: {
        materializeNextPendingMessageSafely,
        readRuntimeActivitySnapshotTail,
        waitForRuntimeActivitySnapshotTailChange,
        waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
      },
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    });

    const waiting = consumer.waitForNextInput({ abortSignal: new AbortController().signal });
    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
    expect(readRuntimeActivitySnapshotTail).not.toHaveBeenCalled();
    expect(waitForRuntimeActivitySnapshotTailChange).not.toHaveBeenCalled();
    firstMaterialization.resolve({ type: 'deferred', reason: 'runtime_activity_unknown' });
    await vi.waitFor(() => expect(waitForRuntimeActivitySnapshotTailChange).toHaveBeenCalledWith(7, expect.any(AbortSignal)));
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'skip',
      pendingQueueDeliveryTiming: 'after_runtime_idle',
      onDiagnosticPhase: expect.any(Function),
    });
    tail = {
      sequence: 8,
      custody: null,
      settlement: {
        identity: {
          mutationKey: 'activity-pending-8',
          admissionOrder: 8,
        },
        desiredValue: { state: 'idle', activeCount: 0 },
        result: 'applied',
        committedProjection: { state: 'idle', activeCount: 0, observedAt: 100, revision: 41 },
        committedRevision: 41,
      },
    };
    tailChanged.resolve(true);

    await expect(waiting).resolves.toMatchObject({ message: 'after-exact-idle' });
    expect(materializeNextPendingMessageSafely).toHaveBeenLastCalledWith({
      reconcileWhenEmpty: 'skip',
      pendingQueueDeliveryTiming: 'after_runtime_idle',
      expectedRuntimeActivityRevision: 41,
      onDiagnosticPhase: expect.any(Function),
    });
  });


  it('cancels retry backoff without another transport attempt', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const materializeNextPendingMessageSafely = vi
        .fn<() => Promise<MaterializeNextPendingResult>>()
        .mockResolvedValue({ type: 'retryable_transport', retryAfterMs: 1_000 } as MaterializeNextPendingResult);
      const consumer = createSessionProviderInputConsumer({
        messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
        session: {
          materializeNextPendingMessageSafely,
          waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
        },
      } as Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]);

      const waiting = consumer.waitForNextInput({ abortSignal: abortController.signal });
      await vi.advanceTimersByTimeAsync(0);
      abortController.abort();
      await vi.advanceTimersByTimeAsync(10);

      await expect(waiting).resolves.toBeNull();
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits through auth policy immediately without consuming retry budget', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockResolvedValue({ type: 'auth_failure', statusCode: 401 } as MaterializeNextPendingResult);
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
      },
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal }))
      .rejects.toBeInstanceOf(PendingQueueMaterializationAuthError);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('exits through auth policy when authentication fails during the transport request', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn<() => Promise<MaterializeNextPendingResult>>()
      .mockRejectedValue(new HttpStatusError(403, 'Authentication failed'));
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForPendingEligibilityUpdate: () => new Promise<boolean>(() => {}),
      },
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal }))
      .rejects.toBeInstanceOf(PendingQueueMaterializationAuthError);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });
});
