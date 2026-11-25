import { describe, expect, it } from 'vitest';
import { createDeferred } from '@/testkit/async/deferred';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { createWorkflowStepWithdrawal } from './workflowStepWithdrawal';

describe('workflow step dispatch ownership', () => {
  it('waits for an in-flight withdrawal report before rearming the same identity', async () => {
    const barrier = createDeferred<void>();
    let reports = 0;
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => {
      reports += 1;
      if (reports === 1) await barrier.promise;
    } });
    const input = { localInputId: 'resume-report-race' };
    const reporting = owner.reportWorkflowStepWithdrawn(input);
    await Promise.resolve();
    const offer = Promise.resolve(owner.offerWorkflowStepInput(input));
    barrier.resolve();
    await Promise.all([reporting, offer]);
    await owner.reportWorkflowStepWithdrawn(input);
    expect(reports).toBe(2);
  });
  it('restores a positive persisted dispatch fact without publishing another host event', () => {
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => undefined });
    const input = { localInputId: 'restart-dispatched' };
    owner.observeWorkflowStepDispatched(input);
    expect(owner.withdrawWorkflowStepInput(input)).toBe('dispatched');
    expect(owner.claimDispatch(input, () => { throw new Error('duplicate host event'); })).toBe(false);
  });
  it('rearms the same invocation identity only when its canonical producer offers it again after Pause', async () => {
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => undefined });
    const input = { localInputId: 'resumed-origin-step' };
    expect(owner.withdrawWorkflowStepInput(input)).toBe('withdrawn');
    expect(owner.claimDispatch(input, () => undefined)).toBe(false);
    await owner.offerWorkflowStepInput(input);
    expect(owner.claimDispatch(input, () => undefined)).toBe(true);
    await owner.offerWorkflowStepInput(input);
    expect(owner.withdrawWorkflowStepInput(input)).toBe('dispatched');
    expect(owner.claimDispatch(input, () => undefined)).toBe(false);
  });
  it.each([true, false])('linearizes real input-consumer dispatch against withdrawal during the FIN recheck (withdraw first: %s)', async (withdrawFirst) => {
    const localInputId = 'consumer-barrier-step';
    const recheckStarted = createDeferred<void>();
    const deliverability = createDeferred<boolean>();
    const publication = createDeferred<void>();
    const publicationStarted = createDeferred<void>();
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => undefined });
    const events: string[] = [];
    const providerInputs: string[] = [];
    const messageQueue = new MessageQueue2<string, { text: string; localId: string }>((mode) => mode, { batcher: (messages) => messages[0]! });
    let available = true;
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: { waitForMetadataUpdate: () => new Promise<boolean>(() => {}) },
      takeContextOnlyInput: async () => {
        if (!available) return null;
        available = false;
        return { message: { text: 'required workflow text', localId: localInputId }, mode: 'default', isolate: true, hash: localInputId };
      },
    });
    const abortSignal = new AbortController().signal;
    const batch = await consumer.waitForNextInput({ abortSignal });
    expect(batch).not.toBeNull();
    const finalize = consumer.finalizeContextOnlyInput({
      batch: batch!, abortSignal,
      recheck: async () => {
        recheckStarted.resolve();
        return await deliverability.promise && !owner.isWithdrawn({ localInputId });
      },
      commit: async () => {
        const claimed = owner.claimDispatch({ localInputId }, () => {
          events.push(localInputId);
          publicationStarted.resolve();
        });
        if (claimed) await publication.promise;
        return claimed;
      },
    });
    await recheckStarted.promise;
    if (withdrawFirst) expect(owner.withdrawWorkflowStepInput({ localInputId })).toBe('withdrawn');
    deliverability.resolve(true);
    if (!withdrawFirst) {
      await publicationStarted.promise;
      expect(owner.withdrawWorkflowStepInput({ localInputId })).toBe('dispatched');
      messageQueue.push({ text: 'queued after dispatch', localId: 'user-after-dispatch' }, 'default');
    }
    publication.resolve();
    const result = await finalize;
    if (result === 'committed') providerInputs.push(batch!.message.text);

    expect(result).toBe(withdrawFirst ? 'withdrawn' : 'committed');
    expect(events).toEqual(withdrawFirst ? [] : [localInputId]);
    expect(providerInputs).toEqual(withdrawFirst ? [] : ['required workflow text']);
    expect(owner.withdrawWorkflowStepInput({ localInputId })).toBe(withdrawFirst ? 'withdrawn' : 'dispatched');
    expect(owner.withdrawWorkflowStepInput({ localInputId })).toBe(withdrawFirst ? 'withdrawn' : 'dispatched');
    if (!withdrawFirst) {
      const restartedOwner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => undefined });
      restartedOwner.observeWorkflowStepDispatched({ localInputId });
      expect(restartedOwner.withdrawWorkflowStepInput({ localInputId })).toBe('dispatched');
      expect(restartedOwner.claimDispatch({ localInputId }, () => { events.push(localInputId); })).toBe(false);
      expect((await consumer.waitForNextInput({ abortSignal }))?.message.localId).toBe('user-after-dispatch');
      expect(events).toEqual([localInputId]);
    }
  });

  it('defers a taken step for user input arriving during recheck and leaves the step withdrawable', async () => {
    const localInputId = 'consumer-user-priority-step';
    const recheckStarted = createDeferred<void>();
    const deliverability = createDeferred<boolean>();
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => undefined });
    const events: string[] = [];
    const messageQueue = new MessageQueue2<string, { text: string; localId: string }>((mode) => mode, { batcher: (messages) => messages[0]! });
    let available = true;
    const consumer = createSessionProviderInputConsumer({
      messageQueue,
      session: { waitForMetadataUpdate: () => new Promise<boolean>(() => {}) },
      takeContextOnlyInput: async () => {
        if (!available) return null;
        available = false;
        return { message: { text: 'required workflow text', localId: localInputId }, mode: 'default', isolate: true, hash: localInputId };
      },
    });
    const abortSignal = new AbortController().signal;
    const batch = await consumer.waitForNextInput({ abortSignal });
    const finalize = consumer.finalizeContextOnlyInput({
      batch: batch!, abortSignal,
      recheck: async () => {
        recheckStarted.resolve();
        return await deliverability.promise;
      },
      commit: async () => owner.claimDispatch({ localInputId }, () => { events.push(localInputId); }),
    });
    await recheckStarted.promise;
    messageQueue.push({ text: 'user input wins', localId: 'user-1' }, 'default');
    deliverability.resolve(true);

    expect(await finalize).toBe('deferred');
    expect(events).toEqual([]);
    expect(owner.withdrawWorkflowStepInput({ localInputId })).toBe('withdrawn');
    expect((await consumer.waitForNextInput({ abortSignal }))?.message.localId).toBe('user-1');
    expect((await consumer.waitForNextInput({ abortSignal }))?.message.localId).toBe(localInputId);
  });

  it('withdraws an item during the asynchronous deliverability read, without a host event', async () => {
    const barrier = createDeferred<boolean>();
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => undefined });
    const events: string[] = [];
    const dispatch = (async () => {
      if (!await barrier.promise) return false;
      return owner.claimDispatch({ localInputId: 'step-1' }, () => { events.push('step-1'); });
    })();
    expect(owner.withdrawWorkflowStepInput({ localInputId: 'step-1' })).toBe('withdrawn');
    barrier.resolve(true);
    expect(await dispatch).toBe(false);
    expect(events).toEqual([]);
    expect(owner.withdrawWorkflowStepInput({ localInputId: 'step-1' })).toBe('withdrawn');
  });

  it('reports dispatched on withdrawal after the positive check, including during host publication', async () => {
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => undefined });
    const events: string[] = [];
    expect(owner.claimDispatch({ localInputId: 'step-2' }, () => {
      expect(owner.withdrawWorkflowStepInput({ localInputId: 'step-2' })).toBe('dispatched');
      events.push('step-2');
    })).toBe(true);
    expect(events).toEqual(['step-2']);
    expect(owner.withdrawWorkflowStepInput({ localInputId: 'step-2' })).toBe('dispatched');
  });

  it('keeps a taken item waiting behind user input withdrawable', () => {
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => undefined });
    expect(owner.withdrawWorkflowStepInput({ localInputId: 'waiting-step' })).toBe('withdrawn');
    expect(owner.claimDispatch({ localInputId: 'waiting-step' }, () => { throw new Error('must not publish'); })).toBe(false);
  });

  it('reports a closed-run decline unasked once and replays the same answer', async () => {
    const reports: string[] = [];
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async ({ localInputId }) => { reports.push(localInputId); } });
    await owner.reportWorkflowStepWithdrawn({ localInputId: 'closed-step' });
    await owner.reportWorkflowStepWithdrawn({ localInputId: 'closed-step' });
    expect(reports).toEqual(['closed-step']);
    expect(owner.withdrawWorkflowStepInput({ localInputId: 'closed-step' })).toBe('withdrawn');
  });

  it('joins concurrent unasked reports without changing the withdrawal answer', async () => {
    const barrier = createDeferred<void>();
    let reports = 0;
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => {
      reports += 1;
      await barrier.promise;
    } });
    const first = owner.reportWorkflowStepWithdrawn({ localInputId: 'closed-step' });
    const replay = owner.reportWorkflowStepWithdrawn({ localInputId: 'closed-step' });
    barrier.resolve();
    await Promise.all([first, replay]);
    expect(reports).toBe(1);
    expect(owner.withdrawWorkflowStepInput({ localInputId: 'closed-step' })).toBe('withdrawn');
  });

  it('retries a failed unasked report without changing the idempotent withdrawal answer', async () => {
    let attempts = 0;
    const owner = createWorkflowStepWithdrawal({ reportWithdrawn: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('report transport unavailable');
    } });
    const input = { localInputId: 'closed-report-retry' };
    await expect(owner.reportWorkflowStepWithdrawn(input)).rejects.toThrow('report transport unavailable');
    expect(owner.withdrawWorkflowStepInput(input)).toBe('withdrawn');
    await owner.reportWorkflowStepWithdrawn(input);
    await owner.reportWorkflowStepWithdrawn(input);
    expect(attempts).toBe(2);
  });
});
