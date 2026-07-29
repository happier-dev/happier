import { describe, expect, it, vi } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';
import type { Metadata, UserMessage } from '@/api/types';
import type { RuntimeActivitySnapshotTail } from '@/api/session/sessionClientPort';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { registerPermissionModeMessageQueueBinding } from '@/agent/runtime/permissions/bindModeQueue';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import { createDeferred } from '@/testkit/async/deferred';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { writeSessionPendingQueueHoldV1ToMetadata } from '@happier-dev/protocol';
import {
  createSessionProviderInputConsumer,
  PendingQueueMaterializationAuthError,
} from './sessionProviderInputConsumer';

describe('createSessionProviderInputConsumer', () => {
  it('arms the Pending wake before an active-turn pass and drains once for the wake without polling', async () => {
    const metadataWakes: Array<(updated: boolean) => void> = [];
    const materializeNextPendingMessageSafely = vi
      .fn()
      .mockResolvedValueOnce({ type: 'no_pending' as const })
      .mockResolvedValueOnce({
        type: 'materialized' as const,
        localId: 'active-turn-steer',
        seq: 12,
        content: null,
      });
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate: async (signal) => await new Promise<boolean>((resolve) => {
          const finish = (updated: boolean) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(updated);
          };
          const onAbort = () => finish(false);
          metadataWakes.push(finish);
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      },
    });
    const abortController = new AbortController();
    const pump = (consumer as typeof consumer & {
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
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    const unavailableForever = new Promise<boolean>(() => {});
    const waitForMetadataUpdate = vi
      .fn<(signal?: AbortSignal) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockReturnValue(unavailableForever);
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate,
      },
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
    expect(waitForMetadataUpdate).toHaveBeenCalledTimes(2);
  });

  it('uses one bounded reconnect wake to run exactly one new unconditional active-turn pass', async () => {
    const metadataWakes: Array<(updated: boolean) => void> = [];
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    const waitForMetadataUpdate = vi.fn(async (signal?: AbortSignal) => await new Promise<boolean>((resolve) => {
      const finish = (updated: boolean) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(updated);
      };
      const onAbort = () => finish(false);
      metadataWakes.push(finish);
      signal?.addEventListener('abort', onAbort, { once: true });
    }));
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }>(() => 'hash'),
      session: { materializeNextPendingMessageSafely, waitForMetadataUpdate },
    });
    const abortController = new AbortController();
    const pump = consumer.pumpPendingWhileActive({
      abortSignal: abortController.signal,
      reason: 'active-turn-reconnect-test',
    });

    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
    metadataWakes.shift()?.(false);
    await vi.waitFor(() => expect(waitForMetadataUpdate).toHaveBeenCalledTimes(2));
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);

    metadataWakes.shift()?.(true);
    await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2));
    expect(waitForMetadataUpdate).toHaveBeenCalledTimes(3);

    abortController.abort();
    await expect(pump).resolves.toBeUndefined();
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
  });

  it('reruns an ordinary whole pass when admission closes and reopens after the final pass check', async () => {
    const queue = new MessageQueue2<{ id: string }>(() => 'hash');
    let pendingAvailable = false;
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      if (!pendingAvailable) return { type: 'no_pending' as const };
      queue.pushImmediate('pending after admission change', { id: 'mode' });
      return {
        type: 'materialized' as const,
        localId: 'pending-after-admission-change',
        seq: 13,
        content: null,
      };
    });
    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      },
    });
    const abortController = new AbortController();
    const waiting = consumer.waitForNextInput({ abortSignal: abortController.signal });

    try {
      await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      pendingAvailable = true;

      await consumer.enforceProviderInputAdmission(generationEpoch('ordinary-missed-wake'));
      await consumer.clearProviderInputAdmission({
        serviceId: 'openai-codex',
        groupId: 'primary',
        epochId: 'ordinary-missed-wake',
      });

      await vi.waitFor(
        () => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2),
        { timeout: 250 },
      );
      await expect(waiting).resolves.toMatchObject({ message: 'pending after admission change' });
    } finally {
      abortController.abort();
      await waiting;
    }
  });

  it('reruns an active-turn whole pass when admission closes and reopens after the final pass check', async () => {
    let pendingAvailable = false;
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      if (!pendingAvailable) return { type: 'no_pending' as const };
      pendingAvailable = false;
      return {
        type: 'materialized' as const,
        localId: 'active-turn-pending-after-admission-change',
        seq: 14,
        content: null,
      };
    });
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }>(() => 'hash'),
      session: {
        materializeNextPendingMessageSafely,
        waitForMetadataUpdate: async (signal) => await new Promise<boolean>((resolve) => {
          if (signal?.aborted) {
            resolve(false);
            return;
          }
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
      },
    });
    const abortController = new AbortController();
    const pump = consumer.pumpPendingWhileActive({
      abortSignal: abortController.signal,
      reason: 'active-turn-admission-missed-wake',
    });

    try {
      await vi.waitFor(() => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      pendingAvailable = true;

      await consumer.enforceProviderInputAdmission(generationEpoch('active-turn-missed-wake'));
      await consumer.clearProviderInputAdmission({
        serviceId: 'openai-codex',
        groupId: 'primary',
        epochId: 'active-turn-missed-wake',
      });

      await vi.waitFor(
        () => expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2),
        { timeout: 250 },
      );
    } finally {
      abortController.abort();
      await pump;
    }
  });

  type TestMode = { id: string };

  const generationEpoch = (epochId: string) => ({
    kind: 'action_required' as const,
    reason: 'generation_pending' as const,
    serviceId: 'openai-codex',
    groupId: 'primary',
    epochId,
  });

  function createDrainConsumer(
    session: Parameters<typeof createSessionProviderInputConsumer<TestMode, string>>[0]['session'],
  ) {
    return createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session,
    });
  }

  it('starts a late connected-group target closed until its exact epoch is adopted', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    const controller = new AbortController();
    await consumer.enforceProviderInputAdmission(generationEpoch('target:1'));
    const waiting = consumer.waitUntilProviderInputAdmitted({ abortSignal: controller.signal });
    expect(consumer.readProviderInputAdmission()).toMatchObject({ epochId: 'target:1' });
    await consumer.clearProviderInputAdmission({
      serviceId: 'openai-codex', groupId: 'primary', epochId: 'target:1',
    });
    await expect(waiting).resolves.toBe(true);
  });

  it('keeps a replacement revision closed against the prior revision proof', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    await consumer.enforceProviderInputAdmission(generationEpoch('target:1'));
    await consumer.clearProviderInputAdmission({ serviceId: 'openai-codex', groupId: 'primary', epochId: 'target:1' });
    await consumer.enforceProviderInputAdmission(generationEpoch('target:2'));

    await expect(consumer.clearProviderInputAdmission({
      serviceId: 'openai-codex', groupId: 'primary', epochId: 'target:1',
    })).resolves.toEqual({ status: 'not_matched' });
    expect(consumer.readProviderInputAdmission()).toMatchObject({ epochId: 'target:2' });
  });

  it('does not let an old in-flight completion open its replacement', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    await consumer.enforceProviderInputAdmission(generationEpoch('old'));
    const oldCompletion = Promise.resolve().then(async () => await consumer.clearProviderInputAdmission({
      serviceId: 'openai-codex', groupId: 'primary', epochId: 'old',
    }));
    await consumer.enforceProviderInputAdmission(generationEpoch('replacement'));

    await expect(oldCompletion).resolves.toEqual({ status: 'not_matched' });
    expect(consumer.readProviderInputAdmission()).toMatchObject({ epochId: 'replacement' });
  });

  it('aborts a released target waiter without opening the retained epoch', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    await consumer.enforceProviderInputAdmission(generationEpoch('released'));
    const controller = new AbortController();
    const waiting = consumer.waitUntilProviderInputAdmitted({ abortSignal: controller.signal });
    controller.abort();

    await expect(waiting).resolves.toBe(false);
    expect(consumer.readProviderInputAdmission()).toMatchObject({ epochId: 'released' });
  });

  it('stays closed when provider apply succeeds but durable adoption clear fails', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    await consumer.enforceProviderInputAdmission(generationEpoch('target:7'));
    const durableClear = vi.fn(async () => { throw new Error('disk unavailable'); });

    await expect(durableClear()).rejects.toThrow('disk unavailable');
    expect(consumer.readProviderInputAdmission()).toMatchObject({ epochId: 'target:7' });
  });

  it('does not reconstruct a pre-boot generation admission after daemon replacement', () => {
    const session = {
      waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
    };
    const previous = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session,
    });
    expect(previous.readProviderInputAdmission()).toEqual({ kind: 'admitted' });

    const replacement = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session,
    });
    expect(replacement.readProviderInputAdmission()).toEqual({ kind: 'admitted' });
  });

  it('returns queued provider input exactly once only after exact-current adoption', async () => {
    const queue = new MessageQueue2<TestMode>(() => 'hash');
    queue.pushImmediate('hello', { id: 'mode' });
    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    await consumer.enforceProviderInputAdmission(generationEpoch('target:9'));
    const controller = new AbortController();
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });
    const settled = vi.fn();
    void waiting.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    await consumer.clearProviderInputAdmission({ serviceId: 'openai-codex', groupId: 'primary', epochId: 'old' });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    await consumer.clearProviderInputAdmission({ serviceId: 'openai-codex', groupId: 'primary', epochId: 'target:9' });

    await expect(waiting).resolves.toMatchObject({ message: 'hello' });
    expect(queue.size()).toBe(0);
  });

  it('lets an ordinary provider dispatch that owns custody reach acceptance before enforcement returns', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    let releasePreparation: () => void = () => {};
    const preparationPaused = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const providerAccepted = vi.fn();
    const abortController = new AbortController();

    const dispatch = consumer.runProviderInputDispatch({
      abortSignal: abortController.signal,
      dispatch: async () => {
        await preparationPaused;
        providerAccepted();
        return 'accepted' as const;
      },
    });
    await Promise.resolve();

    const enforcement = consumer.enforceProviderInputAdmission(generationEpoch('target:dispatch'));
    const enforcementSettled = vi.fn();
    void enforcement.then(enforcementSettled, enforcementSettled);
    await Promise.resolve();

    expect(providerAccepted).not.toHaveBeenCalled();
    expect(enforcementSettled).not.toHaveBeenCalled();

    releasePreparation();
    await expect(dispatch).resolves.toEqual({ status: 'dispatched', value: 'accepted' });
    await expect(enforcement).resolves.toMatchObject({ status: 'enforced' });
    expect(providerAccepted).toHaveBeenCalledTimes(1);
  });

  it('atomically transfers an exact transition admission into provider dispatch custody', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    await consumer.enforceProviderInputAdmission(
      generationEpoch('model-transition:prompt'),
    );

    const ordinaryDispatch = vi.fn(async () => {});
    const ordinary = consumer.runProviderInputDispatch({
      abortSignal: new AbortController().signal,
      dispatch: ordinaryDispatch,
    });
    const providerAccepted = createDeferred<void>();
    const selectedDispatch = vi.fn(async () => {
      await providerAccepted.promise;
    });
    const selected = consumer.runProviderInputDispatchFromAdmission({
      admission: generationEpoch('model-transition:prompt'),
      abortSignal: new AbortController().signal,
      dispatch: selectedDispatch,
    });
    await vi.waitFor(() =>
      expect(selectedDispatch).toHaveBeenCalledTimes(1));
    expect(ordinaryDispatch).not.toHaveBeenCalled();

    const successorFence = consumer.enforceProviderInputAdmission(
      generationEpoch('model-transition:successor'),
    );
    let successorFenceSettled = false;
    void successorFence.then(() => {
      successorFenceSettled = true;
    });
    await Promise.resolve();
    expect(successorFenceSettled).toBe(false);

    providerAccepted.resolve();
    await expect(selected).resolves.toMatchObject({ status: 'dispatched' });
    await expect(successorFence).resolves.toMatchObject({ status: 'enforced' });
    expect(ordinaryDispatch).not.toHaveBeenCalled();

    await consumer.clearProviderInputAdmission({
      serviceId: 'openai-codex',
      groupId: 'primary',
      epochId: 'model-transition:successor',
    });
    await expect(ordinary).resolves.toMatchObject({ status: 'dispatched' });
    expect(ordinaryDispatch).toHaveBeenCalledTimes(1);
  });

  it('releases the exact transition admission when atomic transfer is cancelled or provider dispatch throws', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    const cancelledDispatch = vi.fn(async () => {});
    const cancelledController = new AbortController();
    await consumer.enforceProviderInputAdmission(
      generationEpoch('model-transition:cancelled'),
    );
    cancelledController.abort();

    await expect(
      consumer.runProviderInputDispatchFromAdmission({
        admission: generationEpoch('model-transition:cancelled'),
        abortSignal: cancelledController.signal,
        dispatch: cancelledDispatch,
      }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(cancelledDispatch).not.toHaveBeenCalled();
    expect(consumer.readProviderInputAdmission()).toEqual({
      kind: 'admitted',
    });

    await consumer.enforceProviderInputAdmission(
      generationEpoch('model-transition:error'),
    );
    await expect(
      consumer.runProviderInputDispatchFromAdmission({
        admission: generationEpoch('model-transition:error'),
        abortSignal: new AbortController().signal,
        dispatch: async () => {
          throw new Error('provider rejected before acceptance');
        },
      }),
    ).rejects.toThrow('provider rejected before acceptance');
    expect(consumer.readProviderInputAdmission()).toEqual({
      kind: 'admitted',
    });
  });

  it('holds ACP and Claude steer preparation behind exact-current clear and settles cancellation once', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<TestMode>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    const providerCalls: string[] = [];
    const acpAbortController = new AbortController();
    const claudeAbortController = new AbortController();
    const cancelledAbortController = new AbortController();

    await consumer.enforceProviderInputAdmission(generationEpoch('target:steer'));
    const acpDispatch = consumer.runProviderInputDispatch({
      abortSignal: acpAbortController.signal,
      dispatch: async () => {
        providerCalls.push('acp');
        return 'acp' as const;
      },
    });
    const claudeDispatch = consumer.runProviderInputDispatch({
      abortSignal: claudeAbortController.signal,
      dispatch: async () => {
        providerCalls.push('claude');
        return 'claude' as const;
      },
    });
    const cancelledDispatch = consumer.runProviderInputDispatch({
      abortSignal: cancelledAbortController.signal,
      dispatch: async () => {
        providerCalls.push('cancelled');
      },
    });
    cancelledAbortController.abort();

    await expect(cancelledDispatch).resolves.toEqual({ status: 'cancelled' });
    await consumer.clearProviderInputAdmission({
      serviceId: 'openai-codex', groupId: 'primary', epochId: 'stale',
    });
    await Promise.resolve();
    expect(providerCalls).toEqual([]);

    await consumer.clearProviderInputAdmission({
      serviceId: 'openai-codex', groupId: 'primary', epochId: 'target:steer',
    });
    await expect(acpDispatch).resolves.toEqual({ status: 'dispatched', value: 'acp' });
    await expect(claudeDispatch).resolves.toEqual({ status: 'dispatched', value: 'claude' });
    expect(providerCalls).toEqual(['acp', 'claude']);
  });

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

  function createBoundPendingPromptConsumer() {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      (mode) => JSON.stringify(mode),
      {
        batcher: (messages) => {
          const [message] = messages;
          if (messages.length !== 1 || !message) {
            throw new Error('Pending prompts must retain one provider invocation per batch');
          }
          return message;
        },
      },
    );
    let metadata = createTestMetadata();
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;
    const pending = [
      { localId: 'pending-x', seq: 11, text: 'prompt X' },
      { localId: 'pending-y', seq: 12, text: 'prompt Y' },
    ];
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      const next = pending.shift();
      if (!next) return { type: 'no_pending' as const };
      const message = {
        role: 'user' as const,
        content: { type: 'text' as const, text: next.text },
        localId: next.localId,
        meta: { permissionMode: 'default' },
        pendingProviderAction: 'send' as const,
      } as UserMessage & { pendingProviderAction: 'send' };
      if (!userMessageHandler) throw new Error('permission-mode queue binding was not registered');
      userMessageHandler(message);
      return {
        type: 'materialized' as const,
        localId: next.localId,
        seq: next.seq,
        content: null,
      };
    });
    const session = {
      onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
        userMessageHandler = handler;
      },
      updateMetadata: async (updater: (current: Metadata) => Metadata) => {
        metadata = updater(metadata);
      },
      getMetadataSnapshot: () => metadata,
      hasCanonicalPendingDeliveryLocalId: (localId: string) =>
        localId === 'pending-x' || localId === 'pending-y',
      waitForMetadataUpdate: async () => false,
      shouldAttemptPendingMaterialization: () => true,
      materializeNextPendingMessageSafely,
    };

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
    });

    return {
      consumer: createSessionProviderInputConsumer({
        messageQueue: queue,
        session,
      }),
      materializeNextPendingMessageSafely,
      queue,
    };
  }

  it('serializes concurrent drain wakes behind one locally queued pending prompt', async () => {
    const { consumer, materializeNextPendingMessageSafely, queue } = createBoundPendingPromptConsumer();

    await expect(Promise.all([
      consumer.drainPending({ maxPopPerWake: 100, reason: 'pump-concurrent-a' }),
      consumer.drainPending({ maxPopPerWake: 100, reason: 'pump-concurrent-b' }),
    ])).resolves.toEqual([
      { materialized: 1, stoppedReason: 'max_pop_per_wake' },
      { materialized: 0, stoppedReason: 'materialization_blocked' },
    ]);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    expect(queue.queue).toHaveLength(1);
    expect(queue.queue[0]?.message).toMatchObject({ text: 'prompt X', localId: 'pending-x' });
  });

  it('does not finish an admission close before an in-flight pending claim reaches local custody', async () => {
    const queue = new MessageQueue2<TestMode>(() => 'hash');
    let releaseMaterialization: () => void = () => {};
    const materializationPaused = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    let materializationStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      materializationStarted = resolve;
    });
    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: async () => false,
        shouldAttemptPendingMaterialization: () => true,
        materializeNextPendingMessageSafely: vi.fn(async () => {
          materializationStarted();
          await materializationPaused;
          queue.pushIsolateAndClear('claimed X', { id: 'mode' });
          return { type: 'materialized' as const, localId: 'pending-x', seq: 11, content: null };
        }),
      },
    });

    const drain = consumer.drainPending({ maxPopPerWake: 100, reason: 'claim-before-close' });
    await started;
    const close = consumer.enforceProviderInputAdmission(generationEpoch('replacement:claim'));
    const closeSettled = vi.fn();
    void close.then(closeSettled, closeSettled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).not.toHaveBeenCalled();

    releaseMaterialization();
    await expect(drain).resolves.toEqual({ materialized: 1, stoppedReason: 'action_required' });
    await expect(close).resolves.toMatchObject({ status: 'enforced' });
    expect(queue.queue[0]?.message).toBe('claimed X');
  });

  it('closes admission across an already queued materialization turn', async () => {
    let releaseFirst: () => void = () => {};
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let observeFirst: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      observeFirst = resolve;
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      observeFirst();
      await firstPaused;
      return { type: 'no_pending' as const };
    });
    const consumer = createDrainConsumer({
      waitForMetadataUpdate: async () => false,
      shouldAttemptPendingMaterialization: () => true,
      materializeNextPendingMessageSafely,
    });

    const first = consumer.drainPending({ reason: 'first' });
    await firstStarted;
    const queued = consumer.drainPending({ reason: 'queued' });
    const close = consumer.enforceProviderInputAdmission(generationEpoch('replacement:queued'));
    const closeSettled = vi.fn();
    void close.then(closeSettled, closeSettled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).resolves.toMatchObject({ materialized: 0 });
    await expect(queued).resolves.toEqual({ materialized: 0, stoppedReason: 'action_required' });
    await expect(close).resolves.toMatchObject({ status: 'enforced' });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('allows a pending pump claim while an ordinary provider turn is active without local pending custody', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'pending-steer',
      seq: 13,
      content: null,
    }));
    const consumer = createDrainConsumer({
      waitForMetadataUpdate: async () => false,
      shouldAttemptPendingMaterialization: () => true,
      materializeNextPendingMessageSafely,
    });
    let releaseProviderTurn: () => void = () => {};
    const providerTurnPaused = new Promise<void>((resolve) => {
      releaseProviderTurn = resolve;
    });
    const activeTurn = consumer.runProviderInputDispatch({
      abortSignal: new AbortController().signal,
      dispatch: async () => await providerTurnPaused,
    });
    await Promise.resolve();

    await expect(consumer.drainPending({ maxPopPerWake: 100, reason: 'active-turn-steer-pump' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    releaseProviderTurn();
    await expect(activeTurn).resolves.toMatchObject({ status: 'dispatched' });
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

  it('uses structured pending materialization without invoking the boolean compatibility surface', async () => {
    type Mode = { id: string };
    const mode: Mode = { id: 'mode-1' };
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const popPendingMessage = vi.fn(async () => false);
    const materializeNextPendingMessageSafely = vi.fn(async (_options?: {
      deliveryTiming?: 'after_foreground_ready' | 'after_runtime_idle';
    }) => {
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
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      abortController.abort();
      return { type: 'no_pending' as const };
    });
    const abortController = new AbortController();

    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
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

  it('does not poll or refresh metadata from the deprecated idle wake interval', async () => {
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
      const settled = vi.fn();
      void pending.then(settled, settled);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(settled).not.toHaveBeenCalled();
      expect(onMetadataUpdate).not.toHaveBeenCalled();
      queue.pushImmediate('canonical wake', { id: 'mode' });
      await expect(pending).resolves.toMatchObject({ message: 'canonical wake' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms the metadata wake before the complete materialization pass', async () => {
    type Mode = { id: string };
    const queue = new MessageQueue2<Mode>(() => 'hash');
    let resolveMetadataWake: ((value: boolean) => void) | null = null;
    const waitForMetadataUpdate = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveMetadataWake = resolve;
    }));
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      resolveMetadataWake?.(true);
      return { type: 'no_pending' as const };
    });
    const onMetadataUpdate = vi.fn(() => {
      queue.pushImmediate('arrived-during-pass', { id: 'mode' });
    });
    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate,
        materializeNextPendingMessageSafely,
        popPendingMessage: vi.fn(async () => false),
      },
      onMetadataUpdate,
      reconcileWhenEmpty: 'skip',
    });

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal }))
      .resolves.toMatchObject({ message: 'arrived-during-pass' });
    expect(waitForMetadataUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      materializeNextPendingMessageSafely.mock.invocationCallOrder[0]!,
    );
    expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
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

  it('drains through structured materialization without invoking the boolean compatibility surface', async () => {
    const popPendingMessage = vi.fn(async () => {
      throw new Error('boolean compatibility materialization must not own durable retries');
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
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_foreground_ready',
    });
    expect(popPendingMessage).not.toHaveBeenCalled();
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

  it('retries an ordinary runtime-idle claim with the exact applied Activity-tail revision', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn()
      .mockResolvedValueOnce({ type: 'deferred' as const, reason: 'runtime_activity_unknown' as const })
      .mockResolvedValueOnce({ type: 'materialized' as const, localId: 'local-1', seq: null, content: null });
    const readRuntimeActivitySnapshotTail = vi.fn(() => ({
      sequence: 7,
      custody: null,
      settlement: {
        identity: { mutationKey: 'runtime-activity-snapshot:s1', admissionOrder: 7 },
        desiredValue: { state: 'idle' as const, activeCount: 0 },
        result: 'applied' as const,
        committedProjection: {
          state: 'idle' as const,
          activeCount: 0,
          observedAt: 100,
          revision: 42,
        },
        committedRevision: 42,
      },
    }));
    const waitForRuntimeActivitySnapshotTailChange = vi.fn();
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2(() => 'hash'),
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => true,
        readRuntimeActivitySnapshotTail,
        waitForRuntimeActivitySnapshotTailChange,
      },
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    });

    await expect(consumer.drainPending({ maxPopPerWake: 1, reason: 'runtime-tail' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(1, {
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_runtime_idle',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(2, {
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_runtime_idle',
      expectedRuntimeActivityRevision: 42,
    });
    expect(readRuntimeActivitySnapshotTail).toHaveBeenCalledTimes(1);
    expect(waitForRuntimeActivitySnapshotTailChange).not.toHaveBeenCalled();
  });

  it('waits for a pending Activity tail and retries only after its exact durable settlement', async () => {
    const materializeNextPendingMessageSafely = vi
      .fn()
      .mockResolvedValueOnce({ type: 'deferred' as const, reason: 'runtime_activity_unknown' as const })
      .mockResolvedValueOnce({ type: 'materialized' as const, localId: 'local-after-tail', seq: null, content: null });
    let tail: RuntimeActivitySnapshotTail = {
        sequence: 9,
        custody: {
          identity: { mutationKey: 'runtime-activity-snapshot:s1', admissionOrder: 9 },
          value: { state: 'idle' as const, activeCount: 0 },
        },
        settlement: null,
      };
    const readRuntimeActivitySnapshotTail = vi.fn(() => tail);
    const waitForRuntimeActivitySnapshotTailChange = vi.fn(async (sequence: number) => {
      expect(sequence).toBe(9);
      tail = {
        sequence: 10,
        custody: null,
        settlement: {
          identity: { mutationKey: 'runtime-activity-snapshot:s1', admissionOrder: 9 },
          desiredValue: { state: 'idle' as const, activeCount: 0 },
          result: 'unchanged' as const,
          committedProjection: {
            state: 'idle' as const,
            activeCount: 0,
            observedAt: 101,
            revision: 43,
          },
          committedRevision: 43,
        },
      };
      return true;
    });
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2(() => 'hash'),
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => true,
        readRuntimeActivitySnapshotTail,
        waitForRuntimeActivitySnapshotTailChange,
      },
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    });

    await expect(consumer.drainPending({ maxPopPerWake: 1, reason: 'pending-runtime-tail' })).resolves.toMatchObject({
      materialized: 1,
    });
    expect(waitForRuntimeActivitySnapshotTailChange).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(2, {
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_runtime_idle',
      expectedRuntimeActivityRevision: 43,
    });
  });

  it.each([
    { name: 'missing settlement', tail: { sequence: 11, custody: null, settlement: null } },
    {
      name: 'malformed settlement',
      tail: {
        sequence: 12,
        custody: null,
        settlement: {
          identity: { mutationKey: 'runtime-activity-snapshot:s1', admissionOrder: 12 },
          desiredValue: { state: 'idle', activeCount: 0 },
          result: 'applied',
          committedProjection: {
            state: 'idle',
            activeCount: 0,
            observedAt: 102,
            revision: 44,
          },
          committedRevision: Number.NaN,
        },
      },
    },
  ])('fails closed without an exact retry for a $name Activity tail', async ({ tail }) => {
    const materializeNextPendingMessageSafely = vi
      .fn()
      .mockResolvedValueOnce({ type: 'deferred' as const, reason: 'runtime_activity_unknown' as const })
      .mockResolvedValueOnce({ type: 'materialized' as const, localId: 'must-not-materialize', seq: null, content: null });
    const waitForRuntimeActivitySnapshotTailChange = vi.fn();
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2(() => 'hash'),
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => true,
        readRuntimeActivitySnapshotTail: () => tail as never,
        waitForRuntimeActivitySnapshotTailChange,
      },
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    });

    await expect(consumer.drainPending({ maxPopPerWake: 1, reason: 'invalid-runtime-tail' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'deferred',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    expect(waitForRuntimeActivitySnapshotTailChange).not.toHaveBeenCalled();
  });

  it('does not read or wait for Activity evidence when the server materializes an urgent or rejoined row', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'urgent',
      seq: null,
      content: null,
    }));
    const readRuntimeActivitySnapshotTail = vi.fn();
    const waitForRuntimeActivitySnapshotTailChange = vi.fn();
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2(() => 'hash'),
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => true,
        readRuntimeActivitySnapshotTail,
        waitForRuntimeActivitySnapshotTailChange,
      },
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    });

    await expect(consumer.drainPending({ maxPopPerWake: 1, reason: 'urgent-runtime-idle' })).resolves.toMatchObject({
      materialized: 1,
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
    expect(readRuntimeActivitySnapshotTail).not.toHaveBeenCalled();
    expect(waitForRuntimeActivitySnapshotTailChange).not.toHaveBeenCalled();
  });

  it('rereads pending delivery timing only for later event-driven drain invocations', async () => {
    let timing: 'after_foreground_ready' | 'after_runtime_idle' = 'after_runtime_idle';
    const observedDeliveryTimings: Array<'after_foreground_ready' | 'after_runtime_idle' | undefined> = [];
    const materializeNextPendingMessageSafely = vi.fn(async (options?: {
      deliveryTiming?: 'after_foreground_ready' | 'after_runtime_idle';
    }) => {
      observedDeliveryTimings.push(options?.deliveryTiming);
      const call = materializeNextPendingMessageSafely.mock.calls.length;
      if (call === 1) return { type: 'retryable_transport' as const };
      return { type: 'materialized' as const, localId: 'local-1', seq: null, content: null };
    });
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2(() => 'hash'),
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: () => true,
      },
      resolvePendingQueueDeliveryTiming: () => timing,
    });

    await expect(consumer.drainPending({ maxPopPerWake: 2, reason: 'timing-reread' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'error',
    });
    timing = 'after_foreground_ready';
    await expect(consumer.drainPending({ maxPopPerWake: 2, reason: 'timing-reread-later' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });
    expect(observedDeliveryTimings).toEqual([
      'after_runtime_idle',
      'after_foreground_ready',
    ]);
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

  it('reconciles one terminal-custody claim before materializing the later Pending row', async () => {
    let terminalCustodyBlocks = true;
    const reconcilePendingProviderInputCustodyBeforeMaterialization = vi.fn(async () => {
      terminalCustodyBlocks = false;
      return true;
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'later-local',
      seq: null,
      content: null,
    }));
    const consumer = createDrainConsumer({
      waitForMetadataUpdate: async () => false,
      shouldAttemptPendingMaterialization: () => !terminalCustodyBlocks,
      reconcilePendingProviderInputCustodyBeforeMaterialization,
      materializeNextPendingMessageSafely,
    });

    await expect(consumer.drainPending({ reason: 'manual-handled-later-row' })).resolves.toEqual({
      materialized: 1,
      stoppedReason: 'max_pop_per_wake',
    });

    expect(reconcilePendingProviderInputCustodyBeforeMaterialization).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('retains terminal custody and invokes no provider materialization when exact reconciliation fails closed', async () => {
    const reconcilePendingProviderInputCustodyBeforeMaterialization = vi.fn(async () => false);
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'must-not-materialize',
      seq: null,
      content: null,
    }));
    const consumer = createDrainConsumer({
      waitForMetadataUpdate: async () => false,
      shouldAttemptPendingMaterialization: () => false,
      reconcilePendingProviderInputCustodyBeforeMaterialization,
      materializeNextPendingMessageSafely,
    });

    await expect(consumer.drainPending({ reason: 'custody-status-network-failure' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'materialization_blocked',
    });

    expect(reconcilePendingProviderInputCustodyBeforeMaterialization).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
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
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      throw new HttpStatusError(401, 'Authentication failed');
    });

    const consumer = createDrainConsumer({
      materializeNextPendingMessageSafely,
      waitForMetadataUpdate: async () => false,
    });

    await expect(consumer.drainPending({ maxPopPerWake: 5, reason: 'test-auth' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'auth_failure',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

  it('does not retry a typed transport result without another Pending wake', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'retryable_transport' as const }));
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2(() => 'hash'),
      session: {
        waitForMetadataUpdate: async () => false,
        materializeNextPendingMessageSafely,
      },
    });

    await expect(consumer.drainPending({ reason: 'typed-transport-exhaustion' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'error',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
  });

});
