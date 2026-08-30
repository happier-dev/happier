import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { registerPermissionModeMessageQueueBinding } from './bindPermissionModeQueue';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';

function createSessionHarness() {
  let handler: ((message: any, info?: any) => void | Promise<void>) | null = null;
  let metadataSnapshot: any = null;
  const session = {
    onUserMessage: (fn: (message: any, info?: any) => void | Promise<void>) => {
      handler = fn;
    },
    getMetadataSnapshot: () => metadataSnapshot,
    refreshSessionSnapshotFromServerBestEffort: vi.fn(async () => {}),
    updateMetadata: vi.fn(async (updater: (m: any) => any) => {
      metadataSnapshot = updater(metadataSnapshot ?? {});
    }),
    blockPendingMessageDelivery: vi.fn(async () => true),
  };
  return {
    session,
    setMetadataSnapshot: (next: any) => {
      metadataSnapshot = next;
    },
    emitUserMessage: (message: any, info?: any) => {
      if (!handler) throw new Error('onUserMessage handler not registered');
      return handler(message, info);
    },
  };
}

function createQueue() {
  // MessageQueue2 already implements push + pushIsolateAndClear.
  const queue = new MessageQueue2<{ permissionMode: any }, PermissionModeQueuedPrompt>(
    (mode) => mode.permissionMode,
    { batcher: (messages) => messages[0]! },
  );
  const spyPush = vi.spyOn(queue, 'push');
  const spyIsolate = vi.spyOn(queue, 'pushIsolateAndClear');
  return { queue, spyPush, spyIsolate };
}

function waitForSteerWork() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('registerPermissionModeMessageQueueBinding (in-flight steer)', () => {
  it('executes a claimed send action by queueing without steering an active turn', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        cancelActiveTurn: vi.fn(async () => {}),
      },
    });

    await expect(Promise.resolve(emitUserMessage(
      { content: { text: 'send after the active turn' }, localId: 'pending-send', meta: {} },
      { seq: 10, providerAcceptancePending: true, pendingProviderAction: 'send' },
    ))).resolves.toBeUndefined();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'send after the active turn', localId: 'pending-send' }),
      { permissionMode: 'default' },
      {
        userMessageSeq: null,
        userMessageLocalId: 'pending-send',
        userMessageLocalIds: ['pending-send'],
        providerAcceptancePending: true,
        pendingProviderAction: 'send',
      },
    );
  });

  it('re-enters after a claimed send is consumed and preserves the next claimed row identity', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue } = createQueue();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => false,
        supportsInFlightSteer: () => true,
        steerText: vi.fn(async () => {}),
        cancelActiveTurn: vi.fn(async () => {}),
      },
    });

    emitUserMessage(
      { content: { text: 'first claimed send' }, localId: 'pending-send-first', meta: {} },
      { seq: 10, providerAcceptancePending: true, pendingProviderAction: 'send' },
    );
    await expect(queue.waitForMessagesAndGetAsString()).resolves.toMatchObject({
      message: expect.objectContaining({ text: 'first claimed send', localId: 'pending-send-first' }),
      userMessageLocalIds: ['pending-send-first'],
      pendingProviderAction: 'send',
    });

    emitUserMessage(
      { content: { text: 'second claimed send' }, localId: 'pending-send-second', meta: {} },
      { seq: 11, providerAcceptancePending: true, pendingProviderAction: 'send' },
    );
    await expect(queue.waitForMessagesAndGetAsString()).resolves.toMatchObject({
      message: expect.objectContaining({ text: 'second claimed send', localId: 'pending-send-second' }),
      userMessageLocalIds: ['pending-send-second'],
      pendingProviderAction: 'send',
    });
  });

  it('blocks a claimed steer action when steering fails and never falls back to the queue', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const steerText = vi.fn(async () => {
      throw new Error('steer window closed');
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        cancelActiveTurn: vi.fn(async () => {}),
      },
    });

    emitUserMessage(
      { content: { text: 'must steer' }, localId: 'pending-steer', meta: {} },
      { seq: 11, providerAcceptancePending: true, pendingProviderAction: 'steer' },
    );
    await waitForSteerWork();
    await waitForSteerWork();

    expect(spyPush).not.toHaveBeenCalled();
    expect(session.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['pending-steer'],
      reason: 'steering_unavailable',
    });
  });

  it('proves no provider effect when a claimed steer is unavailable before invocation', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => false,
        steerText,
      },
    });

    emitUserMessage(
      { content: { text: 'conditional steer' }, localId: 'pending-conditional-steer', meta: {} },
      { seq: 12, providerAcceptancePending: true, pendingProviderAction: 'steer' },
    );
    await waitForSteerWork();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(session.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['pending-conditional-steer'],
      reason: 'steering_unavailable',
      providerEffect: 'none',
    });
  });

  it('executes a claimed interrupt_and_send action by cancelling before queueing the send', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const calls: string[] = [];
    let releaseCancel: () => void = () => {};
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const cancelActiveTurn = vi.fn(async () => {
      calls.push('cancel');
      await cancelGate;
    });
    spyPush.mockImplementation(() => {
      calls.push('queue');
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText: vi.fn(async () => {}),
        cancelActiveTurn,
      },
    });

    const delivery = Promise.resolve(emitUserMessage(
      { content: { text: 'replace active turn' }, localId: 'pending-interrupt', meta: {} },
      { seq: 12, providerAcceptancePending: true, pendingProviderAction: 'interrupt_and_send' },
    ));
    let deliverySettled = false;
    void delivery.then(() => { deliverySettled = true; });
    await waitForSteerWork();

    expect(deliverySettled).toBe(false);
    expect(calls).toEqual(['cancel']);
    expect(spyPush).not.toHaveBeenCalled();

    releaseCancel();
    await delivery;

    expect(calls).toEqual(['cancel', 'queue']);
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'replace active turn', localId: 'pending-interrupt' }),
      { permissionMode: 'default' },
      expect.objectContaining({
        providerAcceptancePending: true,
        pendingProviderAction: 'send',
      }),
    );
  });

  it('blocks a claimed interrupt_and_send when cancellation fails without queueing or steering', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const steerText = vi.fn(async () => {});
    const cancelActiveTurn = vi.fn(async () => {
      throw new Error('turn cancellation failed');
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        cancelActiveTurn,
      },
    });

    emitUserMessage(
      { content: { text: 'replace active turn' }, localId: 'pending-interrupt-failed', meta: {} },
      { seq: 13, providerAcceptancePending: true, pendingProviderAction: 'interrupt_and_send' },
    );
    await waitForSteerWork();
    await waitForSteerWork();

    expect(cancelActiveTurn).toHaveBeenCalledTimes(1);
    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(session.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['pending-interrupt-failed'],
      reason: 'provider_rejected_before_acceptance',
    });
  });

  it('queues messages normally when no steer controller is provided', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
    });

    emitUserMessage({ content: { text: 'hello' }, meta: {} });
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', localId: null }),
      { permissionMode: 'default' },
      { userMessageSeq: null, userMessageLocalId: null, userMessageLocalIds: null },
    );
  });

  it('steers a message during an in-flight turn and does not queue it when steer succeeds', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    let releaseSteer: () => void = () => {};
    const steerGate = new Promise<void>((resolve) => { releaseSteer = resolve; });
    const steerText = vi.fn(async () => { await steerGate; });
    const isTurnInFlight = vi.fn(() => true);
    const supportsInFlightSteer = vi.fn(() => true);

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight,
        supportsInFlightSteer,
        steerText,
      },
    } as any);

    const delivery = Promise.resolve(emitUserMessage({ content: { text: 'steer me' }, meta: {} }));
    let deliverySettled = false;
    void delivery.then(() => { deliverySettled = true; });
    await waitForSteerWork();

    expect(steerText).toHaveBeenCalledWith('steer me');
    expect(deliverySettled).toBe(false);
    expect(spyPush).not.toHaveBeenCalled();

    releaseSteer();
    await delivery;
    expect(deliverySettled).toBe(true);
  });

  it('carries localId and committed seq identity when steering in-flight', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    (session as any).getCommittedUserMessageSeq = vi.fn((localId: string) => (localId === ' local-42\n' ? 42 : null));

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer with identity' }, localId: ' local-42\n', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith('steer with identity', {
      localId: ' local-42\n',
      localIds: [' local-42\n'],
      userMessageSeq: 42,
      userMessageSeqs: [42],
    });
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('prefixes replaySeedV1 when steering and consumes it only after exact provider acceptance', async () => {
    const { session, emitUserMessage, setMetadataSnapshot } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    setMetadataSnapshot({
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'sess_parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    });

    let acceptProviderPrompt: (() => void) | undefined;
    const steerText = vi.fn(async (
      _text: string,
      _identity: unknown,
      callbacks?: { onProviderPromptAccepted?: () => void },
    ) => {
      acceptProviderPrompt = callbacks?.onProviderPromptAccepted;
    });

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer me' }, localId: 'local-1', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith(
      'SEED\n\nsteer me',
      {
        localId: 'local-1',
        localIds: ['local-1'],
      },
      expect.objectContaining({ onProviderPromptAccepted: expect.any(Function) }),
    );
    expect(spyPush).not.toHaveBeenCalled();

    expect(session.getMetadataSnapshot()?.replaySeedV1?.seedText).toBe('SEED');

    acceptProviderPrompt?.();
    await vi.waitFor(() => {
      expect(session.getMetadataSnapshot()?.replaySeedV1?.seedText).toBe('');
    });
    const finalMeta = session.getMetadataSnapshot();
    expect(finalMeta?.replaySeedV1?.seedText).toBe('');
    expect(finalMeta?.replaySeedV1?.appliedToLocalId).toBe('local-1');
  });

  it('keeps delayed acceptance correlated to its steer and drains it before the following prompt', async () => {
    const { session, emitUserMessage, setMetadataSnapshot } = createSessionHarness();
    const { queue } = createQueue();

    setMetadataSnapshot({
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'sess_parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    });

    const acceptProviderPrompt: Array<(() => void) | undefined> = [];
    const steeredTexts: string[] = [];
    const steerText = vi.fn(async (
      text: string,
      _identity: unknown,
      callbacks?: { onProviderPromptAccepted?: () => void },
    ) => {
      steeredTexts.push(text);
      acceptProviderPrompt.push(callbacks?.onProviderPromptAccepted);
    });

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'first' }, localId: 'local-1', meta: {} });
    await vi.waitFor(() => expect(steeredTexts).toHaveLength(1));

    emitUserMessage({ content: { text: 'second' }, localId: 'local-2', meta: {} });
    await vi.waitFor(() => expect(steeredTexts).toHaveLength(2));

    // The first provider ACK may arrive after the transport has already accepted the second
    // steer. It must retire the first steer identity, never whichever settler was bound last.
    acceptProviderPrompt[0]?.();
    emitUserMessage({ content: { text: 'third' }, localId: 'local-3', meta: {} });

    await vi.waitFor(() => expect(steeredTexts).toHaveLength(3));
    expect(steeredTexts[0]).toBe('SEED\n\nfirst');
    expect(steeredTexts[1]).toBe('SEED\n\nsecond');
    expect(steeredTexts[2]).toBe('third');
    expect(session.getMetadataSnapshot()?.replaySeedV1).toMatchObject({
      seedText: '',
      appliedToLocalId: 'local-1',
    });
  });

  it('carries the session-reference block on the steered text, not only on send (D-21)', async () => {
    // The seam, not the block: this path hands `message.meta` to the prompt-finalization owner.
    // Without that, `@session` would work on send and silently vanish on an in-flight steer —
    // the exact asymmetry D-21's "identically on send and steer" exists to forbid.
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const steerText = vi.fn(async (_text: string) => {});

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({
      content: { text: 'compare with @session:peer-abc123' },
      localId: 'local-1',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          mentions: [{
            kind: 'happier.session',
            ref: 'session:sess-referenced',
            token: '@session:peer-abc123',
            start: 13,
            end: 33,
          }],
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const steered = steerText.mock.calls[0]?.[0] as unknown as string;
    expect(steered).toContain('compare with @session:peer-abc123');
    expect(steered).toContain('<happier_session_reference>');
    expect(steered).toContain('sess-referenced');
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('falls back to queueing when steering fails', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {
      throw new Error('steer failed');
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'queue me' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'queue me', localId: null }),
      { permissionMode: 'default' },
      { userMessageSeq: null, userMessageLocalId: null, userMessageLocalIds: null },
    );
  });

  it('preserves localId and committed seq identity when a steer falls back to the queue', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    (session as any).getCommittedUserMessageSeq = vi.fn((localId: string) => (localId === 'local-43' ? 43 : null));

    const steerText = vi.fn(async () => {
      throw new Error('steer failed');
    });

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'queue with identity' }, localId: 'local-43', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'queue with identity', localId: 'local-43' }),
      { permissionMode: 'default' },
      { userMessageSeq: 43, userMessageLocalId: 'local-43', userMessageLocalIds: ['local-43'] },
    );
  });

  it('does not leak unhandledRejection when fallback queueing throws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const { session, emitUserMessage } = createSessionHarness();
      const { queue, spyPush } = createQueue();

      spyPush.mockImplementation(() => {
        throw new Error('queue push failed');
      });

      const steerText = vi.fn(async () => {
        throw new Error('steer failed');
      });

      registerPermissionModeMessageQueueBinding({
        session,
        queue,
        getCurrentPermissionMode: () => 'default',
        setCurrentPermissionMode: () => {},
        inFlightSteer: {
          isTurnInFlight: () => true,
          supportsInFlightSteer: () => true,
          steerText,
        },
      } as any);

      emitUserMessage({ content: { text: 'fallback should not crash' }, meta: {} });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('serializes steering so multiple in-flight messages do not overlap', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    let currentInFlight = 0;
    let maxInFlight = 0;
    let resolveFirstGate: () => void = () => {
      throw new Error('firstGate resolver not initialized');
    };
    const firstGate = new Promise<void>((resolve) => {
      resolveFirstGate = () => resolve();
    });

    const steerText = vi.fn(async (text: string) => {
      currentInFlight += 1;
      maxInFlight = Math.max(maxInFlight, currentInFlight);
      try {
        if (text === 'first') {
          await firstGate;
        }
        await Promise.resolve();
      } finally {
        currentInFlight -= 1;
      }
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'first' }, meta: {} });
    emitUserMessage({ content: { text: 'second' }, meta: {} });

    // Drain the microtask queue rather than counting a fixed number of ticks: prompt
    // finalization sits between the emit and `steerText`, so a tick budget silently
    // measures ZERO steers in flight and would pass even if serialization were removed.
    await waitForSteerWork();
    // The first steer is parked on `firstGate`, so a serialized implementation has
    // exactly one in flight and the second has not started.
    expect(maxInFlight).toBe(1);
    expect(steerText).toHaveBeenCalledTimes(1);

    resolveFirstGate();
    await waitForSteerWork();
    await waitForSteerWork();

    expect(steerText).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('drops queued old-session steer work after bindSession swaps sessions', async () => {
    const oldSession = createSessionHarness();
    const newSession = createSessionHarness();
    const { queue, spyPush } = createQueue();

    let agentState: any = {};
    (oldSession.session as any).updateAgentState = (updater: (current: any) => any) => {
      agentState = updater(agentState);
    };

    let resolveFirstSteer: () => void = () => {
      throw new Error('first steer resolver not initialized');
    };
    let resolveFirstStarted: () => void = () => {
      throw new Error('first started resolver not initialized');
    };
    const firstSteerGate = new Promise<void>((resolve) => {
      resolveFirstSteer = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });

    const steerText = vi.fn(async (text: string) => {
      if (text === 'first') {
        resolveFirstStarted();
        await firstSteerGate;
      }
    });

    const binding = registerPermissionModeMessageQueueBinding({
      session: oldSession.session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    oldSession.emitUserMessage({ content: { text: 'first' }, meta: {} });
    oldSession.emitUserMessage({ content: { text: 'second stale' }, meta: {} });
    await firstStarted;

    binding.bindSession(newSession.session);
    resolveFirstSteer();
    await waitForSteerWork();
    await waitForSteerWork();

    expect(steerText).toHaveBeenCalledTimes(1);
    expect(steerText).toHaveBeenCalledWith('first');
    expect(spyPush).not.toHaveBeenCalled();
    expect(agentState.capabilities?.inFlightSteerUnavailableReason).toBeUndefined();
  });

  it('does not steer when the message changes permission mode (it must be queued)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change' }, meta: { permissionMode: 'read-only' } });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      {
        text: 'mode change',
        localId: null,
        meta: { permissionMode: 'read-only' },
      },
      { permissionMode: 'read-only' },
      { userMessageSeq: null, userMessageLocalId: null, userMessageLocalIds: null },
    );
  });

  it('does not steer /clear (it must be isolated+clearing)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: '/clear' }, meta: {} });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/clear', localId: null }),
      { permissionMode: 'default' },
      { userMessageSeq: null, userMessageLocalId: null, userMessageLocalIds: null },
    );
  });

  it('does not steer /compact (it must be handled by the main loop)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: '/compact' }, meta: {} });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/compact', localId: null }),
      { permissionMode: 'default' },
      { userMessageSeq: null, userMessageLocalId: null, userMessageLocalIds: null },
    );
  });

  it('steers non-Happier slash prompts through the shared payload policy', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: '/model' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith('/model');
    expect(spyPush).not.toHaveBeenCalled();
  });
});

describe('registerPermissionModeMessageQueueBinding (in-flight config-delta apply, lane Q)', () => {
  it('applies the permission-mode delta in-flight then steers the text when the controller supports it', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const calls: string[] = [];
    const steerText = vi.fn(async () => {
      calls.push('steerText');
    });
    const applyConfigDeltaInFlight = vi.fn(async (delta: { permissionMode: string }) => {
      calls.push(`applyConfig:${delta.permissionMode}`);
      return { status: 'applied' } as const;
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight,
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change steer' }, meta: { permissionMode: 'read-only' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toEqual(['applyConfig:read-only', 'steerText']);
    expect(steerText).toHaveBeenCalledWith('mode change steer');
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('steers the text when the config apply reports scheduled_in_turn', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight: vi.fn(async () => ({ status: 'scheduled_in_turn' } as const)),
      },
    } as any);

    emitUserMessage({ content: { text: 'scheduled mode steer' }, meta: { permissionMode: 'read-only' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith('scheduled mode steer');
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('falls back to the queue (legacy behavior) when the config apply reports unsupported', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    let agentState: any = {};
    (session as any).updateAgentState = (updater: (current: any) => any) => {
      agentState = updater(agentState);
    };
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight: vi.fn(async () => ({ status: 'unsupported', reason: 'no_window' } as const)),
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change' }, meta: { permissionMode: 'read-only' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'mode change' }),
      { permissionMode: 'read-only' },
      { userMessageSeq: null, userMessageLocalId: null, userMessageLocalIds: null },
    );
    // Not a bounce: the steer was never accepted, so no unsafe_window corrective publish.
    expect(agentState.capabilities?.inFlightSteerUnavailableReason).toBeUndefined();
  });

  it('does not queue old-session config fallback after bindSession swaps sessions', async () => {
    const oldSession = createSessionHarness();
    const newSession = createSessionHarness();
    const { queue, spyPush } = createQueue();

    let agentState: any = {};
    (oldSession.session as any).updateAgentState = (updater: (current: any) => any) => {
      agentState = updater(agentState);
    };

    let resolveConfigApply: () => void = () => {
      throw new Error('config apply resolver not initialized');
    };
    let resolveConfigStarted: () => void = () => {
      throw new Error('config started resolver not initialized');
    };
    const configApplyGate = new Promise<void>((resolve) => {
      resolveConfigApply = resolve;
    });
    const configStarted = new Promise<void>((resolve) => {
      resolveConfigStarted = resolve;
    });

    const applyConfigDeltaInFlight = vi.fn(async () => {
      resolveConfigStarted();
      await configApplyGate;
      return { status: 'unsupported', reason: 'stale_after_rebind' } as const;
    });
    const steerText = vi.fn(async () => {});

    const binding = registerPermissionModeMessageQueueBinding({
      session: oldSession.session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight,
      },
    } as any);

    oldSession.emitUserMessage({ content: { text: 'mode stale' }, meta: { permissionMode: 'read-only' } });
    await configStarted;

    binding.bindSession(newSession.session);
    resolveConfigApply();
    await waitForSteerWork();
    await waitForSteerWork();

    expect(applyConfigDeltaInFlight).toHaveBeenCalledTimes(1);
    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(agentState.capabilities?.inFlightSteerUnavailableReason).toBeUndefined();
  });

  it('falls back to the queue when the config apply throws', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight: vi.fn(async () => {
          throw new Error('apply transport failed');
        }),
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change' }, meta: { permissionMode: 'read-only' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'mode change' }),
      { permissionMode: 'read-only' },
      { userMessageSeq: null, userMessageLocalId: null, userMessageLocalIds: null },
    );
  });

  it('never routes special commands through the config-apply capability', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyIsolate } = createQueue();

    const steerText = vi.fn(async () => {});
    const applyConfigDeltaInFlight = vi.fn(async () => ({ status: 'applied' } as const));

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight,
      },
    } as any);

    emitUserMessage({ content: { text: '/clear' }, meta: { permissionMode: 'read-only' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(applyConfigDeltaInFlight).not.toHaveBeenCalled();
    expect(steerText).not.toHaveBeenCalled();
    expect(spyIsolate).toHaveBeenCalled();
  });

  it('does not call the capability for messages without a mode change', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});
    const applyConfigDeltaInFlight = vi.fn(async () => ({ status: 'applied' } as const));

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight,
      },
    } as any);

    emitUserMessage({ content: { text: 'plain steer' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(applyConfigDeltaInFlight).not.toHaveBeenCalled();
    expect(steerText).toHaveBeenCalledWith('plain steer');
    expect(spyPush).not.toHaveBeenCalled();
  });
});

describe('registerPermissionModeMessageQueueBinding (steer-bounce corrective publish, lane P)', () => {
  it('publishes unsafe_window to agentState when a steer the runner accepted bounces back to the queue', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    let agentState: any = {};
    (session as any).updateAgentState = (updater: (current: any) => any) => {
      agentState = updater(agentState);
    };
    const { queue, spyPush } = createQueue();

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText: vi.fn(async () => {
          throw new Error('steer transport failed');
        }),
      },
    });

    emitUserMessage({ content: { text: 'steer me' }, meta: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spyPush).toHaveBeenCalled();
    expect(agentState.capabilities?.inFlightSteerAvailable).toBe(false);
    expect(agentState.capabilities?.inFlightSteerUnavailableReason).toBe('unsafe_window');
    expect(typeof agentState.capabilities?.inFlightSteerStateAt).toBe('number');
  });

  it('does not mutate metadata, steer, queue, or bounce old replay-seed work after bindSession swaps sessions', async () => {
    const oldSession = createSessionHarness();
    const newSession = createSessionHarness();
    const { queue, spyPush } = createQueue();

    oldSession.setMetadataSnapshot({
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'sess_parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    });

    let agentState: any = {};
    (oldSession.session as any).updateAgentState = (updater: (current: any) => any) => {
      agentState = updater(agentState);
    };

    let resolveRefresh: () => void = () => {
      throw new Error('refresh resolver not initialized');
    };
    let resolveRefreshStarted: () => void = () => {
      throw new Error('refresh started resolver not initialized');
    };
    const refreshGate = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      resolveRefreshStarted = resolve;
    });
    oldSession.session.refreshSessionSnapshotFromServerBestEffort = vi.fn(async () => {
      resolveRefreshStarted();
      await refreshGate;
    });

    const steerText = vi.fn(async () => {});
    const binding = registerPermissionModeMessageQueueBinding({
      session: oldSession.session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    oldSession.emitUserMessage({ content: { text: 'seed stale' }, localId: 'local-seed-stale', meta: {} });
    await refreshStarted;

    binding.bindSession(newSession.session);
    resolveRefresh();
    await waitForSteerWork();
    await waitForSteerWork();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(oldSession.session.updateMetadata).not.toHaveBeenCalled();
    expect(oldSession.session.getMetadataSnapshot()?.replaySeedV1?.seedText).toBe('SEED');
    expect(oldSession.session.getMetadataSnapshot()?.replaySeedV1?.appliedToLocalId).toBeUndefined();
    expect(agentState.capabilities?.inFlightSteerUnavailableReason).toBeUndefined();
  });
});
