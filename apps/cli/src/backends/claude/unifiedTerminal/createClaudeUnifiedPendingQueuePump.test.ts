import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import { createClaudeUnifiedPendingQueuePump } from './createClaudeUnifiedPendingQueuePump';
import { PendingQueueMaterializationAuthError } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';

const createIdleSnapshot = () => ({
  pendingQueuePumpStateVersion: 0,
  queuedCount: 0,
  pendingInjectionCount: 0,
  terminalCustodyCount: 0,
  providerAcceptancePendingCount: 0,
  disposed: false,
  turnState: 'idle' as const,
  permissionBlocked: false,
  userTyping: false,
  lastDeferredReason: null,
  lastFailureReason: null,
  currentHeadBlocker: null,
  headInputState: null,
});

async function waitForPendingQueuePumpStateChangeUntilAbort(options: Readonly<{
  abortSignal: AbortSignal;
}>): Promise<boolean> {
  if (options.abortSignal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    options.abortSignal.addEventListener('abort', () => resolve(false), { once: true });
  });
}

describe('createClaudeUnifiedPendingQueuePump', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues batches already produced by SessionProviderInputConsumer without materializing again', async () => {
    const waitForNextInput = vi.fn().mockResolvedValue({
      message: 'from queue',
      mode: { permissionMode: 'default' },
      isolate: false,
      hash: 'same-mode',
    });
    const drainPending = vi.fn();
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);

    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput, drainPending },
      arbiter: { enqueueUiMessage, drainWhenSafe, snapshot: vi.fn(createIdleSnapshot), waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort },
    });

    await pump.pumpOnce({ abortSignal: new AbortController().signal });

    expect(enqueueUiMessage).toHaveBeenCalledWith({
      message: 'from queue',
      mode: { permissionMode: 'default' },
      origin: { kind: 'ui_pending' },
      maxUserMessageSeq: null,
      userMessageLocalIds: [],
    });
    expect(drainWhenSafe).toHaveBeenCalledTimes(1);
    expect(drainPending).not.toHaveBeenCalled();
  });

  it('delegates explicit pending drain to SessionProviderInputConsumer', async () => {
    const drainPending = vi.fn().mockResolvedValue({ materialized: 2, stoppedReason: 'no_pending' });
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(),
        drainPending,
      },
      arbiter: { enqueueUiMessage: vi.fn(), drainWhenSafe: vi.fn(), snapshot: vi.fn(createIdleSnapshot), waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort },
    });

    await expect(pump.drainPending({ reason: 'unified-test' })).resolves.toEqual({
      materialized: 2,
      stoppedReason: 'no_pending',
    });
    expect(drainPending).toHaveBeenCalledWith({ reason: 'unified-test' });
  });

  it('does not prefetch while a newer head awaits provider acceptance alongside older terminal custody', async () => {
    vi.useFakeTimers();
    const waitForNextInput = vi.fn()
      .mockResolvedValueOnce({
        message: 'old prompt awaiting Claude acceptance',
        mode: undefined,
        isolate: false,
        hash: 'h1',
        userMessageLocalIds: ['old-local'],
      })
      .mockResolvedValueOnce({
        message: 'new prompt should remain server-pending',
        mode: undefined,
        isolate: false,
        hash: 'h2',
        userMessageLocalIds: ['new-local'],
      })
      .mockResolvedValueOnce(null);
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const snapshot = vi.fn()
      .mockReturnValueOnce(createIdleSnapshot())
      .mockReturnValue({
        pendingQueuePumpStateVersion: 1,
        queuedCount: 1,
        pendingInjectionCount: 0,
        terminalCustodyCount: 1,
        providerAcceptancePendingCount: 1,
        disposed: false,
        turnState: 'idle',
        permissionBlocked: false,
        userTyping: false,
        lastDeferredReason: null,
        lastFailureReason: null,
        headInputState: 'awaiting_provider_acceptance',
      });
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput },
      arbiter: {
        enqueueUiMessage,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
        snapshot,
        waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort,
      },
    });

    const abortController = new AbortController();
    const running = pump.start({ abortSignal: abortController.signal });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);

    expect(waitForNextInput).toHaveBeenCalledTimes(1);
    expect(enqueueUiMessage).toHaveBeenCalledTimes(1);
    expect(enqueueUiMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'old prompt awaiting Claude acceptance',
      userMessageLocalIds: ['old-local'],
    }));

    abortController.abort();
    await expect(running).resolves.toBeUndefined();
  });

  it('keeps unresolved provider acceptance in truthful custody regardless of elapsed time', async () => {
    vi.useFakeTimers();
    let nowMs = 10_000;
    const injectPrompt = vi.fn(async (batch) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
    }));
    const onInjectionFailure = vi.fn(async () => ({ action: 'claimed_pending_delivery' as const }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      injectPrompt,
      onInjectionFailure,
    });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });

    const waitForNextInput = vi.fn()
      .mockResolvedValueOnce({
        message: 'prompt awaiting independent Claude acceptance evidence',
        mode: undefined,
        isolate: false,
        hash: 'h1',
        userMessageLocalIds: ['old-local'],
      })
      .mockResolvedValueOnce({
        message: 'next prompt wakes only after arbiter state changes',
        mode: undefined,
        isolate: false,
        hash: 'h2',
        userMessageLocalIds: ['next-local'],
      });
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput },
      arbiter,
    });

    const abortController = new AbortController();
    const running = pump.start({ abortSignal: abortController.signal });
    await vi.advanceTimersByTimeAsync(1);

    expect(waitForNextInput).toHaveBeenCalledTimes(1);
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    nowMs += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();

    expect(onInjectionFailure).not.toHaveBeenCalled();
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 0,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('old-local') === true,
    )).resolves.toBe(true);
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }

    expect(waitForNextInput).toHaveBeenCalledTimes(2);
    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    abortController.abort();
    await expect(running).resolves.toBeUndefined();
  });

  it('does not hand an unresolved provider-acceptance batch back for blind replay on dispose', async () => {
    const onUndeliverableBatches = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async (batch) => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: batch.message.length,
      })),
      onUndeliverableBatches,
    });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'written prompt whose provider outcome is unresolved',
      mode: undefined,
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['unresolved-local'],
    });
    await arbiter.drainWhenSafe();

    expect(arbiter.snapshot()).toMatchObject({
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    arbiter.dispose();

    expect(onUndeliverableBatches).not.toHaveBeenCalled();
  });

  it('marks provider-acceptance pending batches as owned before arbiter delivery', async () => {
    const waitForNextInput = vi.fn().mockResolvedValue({
      message: 'prompt already claimed by pending-provider delivery',
      mode: undefined,
      isolate: false,
      hash: 'h1',
      maxUserMessageSeq: null,
      userMessageLocalIds: ['pending-provider-local'],
      providerAcceptancePending: true,
    });
    const events: string[] = [];
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput },
      arbiter: {
        enqueueUiMessage: vi.fn(async () => {
          events.push('enqueue');
        }),
        drainWhenSafe: vi.fn(),
        snapshot: vi.fn(createIdleSnapshot),
        waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort,
      },
      onProviderAcceptancePendingPrompt: (batch) => {
        events.push(`owned:${batch.message}`);
      },
    });

    await pump.pumpOnce({ abortSignal: new AbortController().signal });

    expect(events).toEqual([
      'owned:prompt already claimed by pending-provider delivery',
      'enqueue',
    ]);
  });

  it('forwards the authenticated exact action into the Claude arbiter batch', async () => {
    const enqueueUiMessage = vi.fn(async () => undefined);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput: vi.fn().mockResolvedValue({
        message: 'steer exactly this', mode: undefined, isolate: false, hash: 'h',
        userMessageLocalIds: ['exact-local'], pendingProviderAction: 'steer',
      }) },
      arbiter: { enqueueUiMessage, drainWhenSafe: vi.fn(), snapshot: vi.fn(createIdleSnapshot), waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort },
    });
    await pump.pumpOnce({ abortSignal: new AbortController().signal });
    expect(enqueueUiMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'steer exactly this',
      pendingProviderAction: 'steer',
    }));
  });

  it('continues pumping when provider-acceptance work is already in terminal custody', async () => {
    const waitForNextInput = vi.fn()
      .mockResolvedValueOnce({
        message: 'first prompt in terminal custody',
        mode: undefined,
        isolate: false,
        hash: 'h1',
      })
      .mockResolvedValueOnce({
        message: 'second prompt can still drain',
        mode: undefined,
        isolate: false,
        hash: 'h2',
      })
      .mockResolvedValueOnce(null);
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput },
      arbiter: {
        enqueueUiMessage,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
        snapshot: vi.fn(() => ({
          ...createIdleSnapshot(),
          queuedCount: 0,
          terminalCustodyCount: 1,
          providerAcceptancePendingCount: 0,
          headInputState: 'terminal_custody' as const,
        })),
        waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort,
      },
    });

    await pump.start({ abortSignal: new AbortController().signal });

    expect(waitForNextInput).toHaveBeenCalledTimes(3);
    expect(enqueueUiMessage.mock.calls.map(([batch]) => batch.message)).toEqual([
      'first prompt in terminal custody',
      'second prompt can still drain',
    ]);
  });

  it('parks after a consumer failure without starting a pump retry loop', async () => {
    vi.useFakeTimers();
    const error = new Error('pending materialization failed');
    const waitForNextInput = vi.fn().mockRejectedValueOnce(error);
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput,
      },
      arbiter: {
        enqueueUiMessage,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
        snapshot: vi.fn(createIdleSnapshot),
        waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort,
      },
    });

    const startResult: unknown = pump.start({ abortSignal: new AbortController().signal });
    expect(startResult).toBeInstanceOf(Promise);
    await expect(startResult).resolves.toBeUndefined();
    expect(waitForNextInput).toHaveBeenCalledTimes(1);
    expect(enqueueUiMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(waitForNextInput).toHaveBeenCalledTimes(1);
  });

  it('hands back a failed delivery before propagating an unexpected arbiter failure', async () => {
    const error = new Error('drain failed');
    const onUndeliverableBatch = vi.fn();
    const waitForNextInput = vi.fn()
      .mockResolvedValueOnce({
        message: 'from queue',
        mode: undefined,
        isolate: false,
        hash: 'same-mode',
      })
      .mockResolvedValueOnce({
        message: 'next queue item',
        mode: undefined,
        isolate: false,
        hash: 'next-mode',
      })
      .mockResolvedValueOnce(null);
    const drainWhenSafe = vi.fn()
      .mockRejectedValueOnce(error);
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput,
      },
      arbiter: {
        enqueueUiMessage,
        drainWhenSafe,
        snapshot: vi.fn(createIdleSnapshot),
        waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort,
      },
      onUndeliverableBatch,
    });

    const startResult = pump.start({ abortSignal: new AbortController().signal });

    await expect(startResult).rejects.toBe(error);
    expect(onUndeliverableBatch).toHaveBeenCalledWith(expect.objectContaining({
      message: 'from queue',
    }));
    expect(enqueueUiMessage.mock.calls.map(([batch]) => batch.message)).toEqual([
      'from queue',
    ]);
    expect(drainWhenSafe).toHaveBeenCalledTimes(1);
  });

  it('rejects auth materialization failures so the launcher park-wait path can handle them', async () => {
    const authError = new PendingQueueMaterializationAuthError();
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn().mockRejectedValue(authError),
      },
      arbiter: {
        enqueueUiMessage: vi.fn(),
        drainWhenSafe: vi.fn(),
        snapshot: vi.fn(createIdleSnapshot),
        waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort,
      },
    });

    await expect(pump.start({ abortSignal: new AbortController().signal })).rejects.toBe(authError);
  });

  it('stops non-fatally without a retry counter or timer when its consumer rejects', async () => {
    vi.useFakeTimers();
    const transientWaitError = Object.assign(new Error('server materialization stalled'), {
      localId: 'durable-pending-row',
    });
    const waitForNextInput = vi.fn().mockRejectedValueOnce(transientWaitError);
    const enqueueUiMessage = vi.fn().mockResolvedValue(undefined);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput,
      },
      arbiter: {
        enqueueUiMessage,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
        snapshot: vi.fn(createIdleSnapshot),
        waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort,
      },
    });

    const running = pump.start({ abortSignal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(250);
    await expect(running).resolves.toBeUndefined();
    expect(waitForNextInput).toHaveBeenCalledTimes(1);
    expect(enqueueUiMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands an already-consumed batch back instead of dropping it when aborted during the input wait (silent queue-swallow fix)', async () => {
    const abortController = new AbortController();
    let resolveInput!: (value: { message: string; mode: undefined; isolate: boolean; hash: string }) => void;
    const enqueueUiMessage = vi.fn();
    const onUndeliverableBatch = vi.fn();
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(() => new Promise<{ message: string; mode: undefined; isolate: boolean; hash: string }>((resolve) => {
          resolveInput = resolve;
        })),
      },
      arbiter: { enqueueUiMessage, drainWhenSafe: vi.fn(), snapshot: vi.fn(createIdleSnapshot), waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort },
      onUndeliverableBatch,
    });

    const pumping = pump.pumpOnce({ abortSignal: abortController.signal });
    abortController.abort();
    resolveInput({ message: 'arrived during unwind', mode: undefined, isolate: false, hash: 'h1' });

    await expect(pumping).resolves.toBe(false);
    expect(enqueueUiMessage).not.toHaveBeenCalled();
    expect(onUndeliverableBatch).toHaveBeenCalledWith(expect.objectContaining({
      message: 'arrived during unwind',
    }));
  });

  it('hands an already-consumed batch back when disposed during the input wait', async () => {
    let resolveInput!: (value: { message: string; mode: undefined; isolate: boolean; hash: string }) => void;
    const enqueueUiMessage = vi.fn();
    const onUndeliverableBatch = vi.fn();
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(() => new Promise<{ message: string; mode: undefined; isolate: boolean; hash: string }>((resolve) => {
          resolveInput = resolve;
        })),
      },
      arbiter: { enqueueUiMessage, drainWhenSafe: vi.fn(), snapshot: vi.fn(createIdleSnapshot), waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort },
      onUndeliverableBatch,
    });

    const pumping = pump.pumpOnce({ abortSignal: new AbortController().signal });
    pump.dispose();
    resolveInput({ message: 'stolen by stale waiter', mode: undefined, isolate: false, hash: 'h2' });

    await expect(pumping).resolves.toBe(false);
    expect(enqueueUiMessage).not.toHaveBeenCalled();
    expect(onUndeliverableBatch).toHaveBeenCalledWith(expect.objectContaining({
      message: 'stolen by stale waiter',
    }));
  });

  it('resolves the running promise after disposal when the consumer stops', async () => {
    let resolveInput!: (value: null) => void;
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: {
        waitForNextInput: vi.fn(() => new Promise<null>((resolve) => {
          resolveInput = resolve;
        })),
      },
      arbiter: { enqueueUiMessage: vi.fn(), drainWhenSafe: vi.fn(), snapshot: vi.fn(createIdleSnapshot), waitForPendingQueuePumpStateChange: waitForPendingQueuePumpStateChangeUntilAbort },
    });

    const startResult = pump.start({ abortSignal: new AbortController().signal });
    pump.dispose();
    resolveInput(null);

    await expect(startResult).resolves.toBeUndefined();
  });

  it('resolves the running promise when disposed during an arbiter state-change wait', async () => {
    const waitForPendingQueuePumpStateChange = vi.fn(waitForPendingQueuePumpStateChangeUntilAbort);
    const pump = createClaudeUnifiedPendingQueuePump({
      inputConsumer: { waitForNextInput: vi.fn() },
      arbiter: {
        enqueueUiMessage: vi.fn(),
        drainWhenSafe: vi.fn(),
        snapshot: vi.fn(() => ({
          ...createIdleSnapshot(),
          pendingQueuePumpStateVersion: 7,
          providerAcceptancePendingCount: 1,
          headInputState: 'awaiting_provider_acceptance' as const,
        })),
        waitForPendingQueuePumpStateChange,
      },
    });

    const running = pump.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();
    expect(waitForPendingQueuePumpStateChange).toHaveBeenCalledWith(expect.objectContaining({
      afterVersion: 7,
    }));

    pump.dispose();
    await expect(running).resolves.toBeUndefined();
  });
});
