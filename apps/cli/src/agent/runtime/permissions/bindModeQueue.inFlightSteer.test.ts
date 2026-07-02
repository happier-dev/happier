import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { registerPermissionModeMessageQueueBinding } from './bindModeQueue';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';

function createSessionHarness() {
  let handler: ((message: any) => void) | null = null;
  let metadataSnapshot: any = null;
  const session = {
    onUserMessage: (fn: (message: any) => void) => {
      handler = fn;
    },
    getMetadataSnapshot: () => metadataSnapshot,
    refreshSessionSnapshotFromServerBestEffort: vi.fn(async () => {}),
    updateMetadata: vi.fn(async (updater: (m: any) => any) => {
      metadataSnapshot = updater(metadataSnapshot ?? {});
    }),
  };
  return {
    session,
    setMetadataSnapshot: (next: any) => {
      metadataSnapshot = next;
    },
    emitUserMessage: (message: any) => {
      if (!handler) throw new Error('onUserMessage handler not registered');
      handler(message);
    },
  };
}

function createQueue() {
  // MessageQueue2 already implements push + pushIsolateAndClear.
  const queue = new MessageQueue2<{ permissionMode: any }, PermissionModeQueuedPrompt>((mode) => mode.permissionMode);
  const spyPush = vi.spyOn(queue, 'push');
  const spyIsolate = vi.spyOn(queue, 'pushIsolateAndClear');
  return { queue, spyPush, spyIsolate };
}

describe('registerPermissionModeMessageQueueBinding (in-flight steer)', () => {
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
    expect(spyPush).toHaveBeenCalledWith({ text: 'hello', localId: null }, { permissionMode: 'default' });
  });

  it('steers a message during an in-flight turn and does not queue it when steer succeeds', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});
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

    emitUserMessage({ content: { text: 'steer me' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith('steer me', { localId: null });
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('queues instead of steering when the active turn is not steerable', async () => {
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
        canSteerPrompt: () => false,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'queue me' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith({ text: 'queue me', localId: null }, { permissionMode: 'default' });
  });

  it('prefixes replaySeedV1 when steering and consumes it exactly once', async () => {
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

    emitUserMessage({ content: { text: 'steer me' }, localId: 'local-1', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith('SEED\n\nsteer me', { localId: 'local-1' });
    expect(spyPush).not.toHaveBeenCalled();

    const finalMeta = session.getMetadataSnapshot();
    expect(finalMeta?.replaySeedV1?.seedText).toBe('');
    expect(finalMeta?.replaySeedV1?.appliedToLocalId).toBe('local-1');
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

    expect(spyPush).toHaveBeenCalledWith({ text: 'queue me', localId: null }, { permissionMode: 'default' });
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

    // Allow the async steer tasks to start.
    await Promise.resolve();

    resolveFirstGate();
    await Promise.resolve();
    await Promise.resolve();

    expect(maxInFlight).toBe(1);
    expect(spyPush).not.toHaveBeenCalled();
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
    expect(spyPush).toHaveBeenCalledWith({ text: 'mode change', localId: null }, { permissionMode: 'read-only' });
  });

  it('steers when the message carries an ALIAS of the current mode (no semantic change; ported S-6)', async () => {
    // remote-dev UIMSG starvation: the current mode can be held in a provider-alias form
    // ('acceptEdits') while the message carries the canonical intent ('safe-yolo') of the SAME
    // mode. A raw string compare reads that as a mode change and blocks steering forever; the
    // canonical didChange from maybeUpdatePermissionModeMetadata must gate the steer instead.
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'acceptEdits',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'same mode, alias spelling' }, meta: { permissionMode: 'safe-yolo' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith('same mode, alias spelling', { localId: null });
    expect(spyPush).not.toHaveBeenCalled();
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
    expect(spyIsolate).toHaveBeenCalledWith({ text: '/clear', localId: null }, { permissionMode: 'default' });
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
    expect(spyPush).toHaveBeenCalledWith({ text: '/compact', localId: null }, { permissionMode: 'default' });
  });

  it('signals onPromptQueuedDuringTurn when a mode-changing message is queued behind a running turn (L1)', async () => {
    // Stale-turn recovery demand signal: a mode-change message can never steer, so it queues
    // behind the running turn; the runtime needs to know a prompt is starving behind the turn
    // so it can reconcile a turn whose completion evidence was lost.
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});
    const onPromptQueuedDuringTurn = vi.fn();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        onPromptQueuedDuringTurn,
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change' }, meta: { permissionMode: 'read-only' } });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalled();
    expect(onPromptQueuedDuringTurn).toHaveBeenCalledTimes(1);
  });

  it('signals onPromptQueuedDuringTurn when a steer fails and the message falls back to the queue (L1)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {
      throw new Error('steer vetoed');
    });
    const onPromptQueuedDuringTurn = vi.fn();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        onPromptQueuedDuringTurn,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer me' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(spyPush).toHaveBeenCalled();
    expect(onPromptQueuedDuringTurn).toHaveBeenCalledTimes(1);
  });

  it('does not signal onPromptQueuedDuringTurn when no turn is in flight', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const onPromptQueuedDuringTurn = vi.fn();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => false,
        supportsInFlightSteer: () => true,
        steerText: vi.fn(async () => {}),
        onPromptQueuedDuringTurn,
      },
    } as any);

    emitUserMessage({ content: { text: 'hello' }, meta: {} });
    await Promise.resolve();

    expect(spyPush).toHaveBeenCalled();
    expect(onPromptQueuedDuringTurn).not.toHaveBeenCalled();
  });
});

describe('registerPermissionModeMessageQueueBinding (in-flight config delta, lane Q)', () => {
  function steerWithConfigCapability(overrides?: Readonly<{
    applyConfigDeltaInFlight?: ReturnType<typeof vi.fn>;
    steerText?: ReturnType<typeof vi.fn>;
  }>) {
    const steerText = overrides?.steerText ?? vi.fn(async () => {});
    const applyConfigDeltaInFlight = overrides?.applyConfigDeltaInFlight ?? vi.fn(async () => ({ status: 'applied' as const }));
    return {
      steerText,
      applyConfigDeltaInFlight,
      controller: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        applyConfigDeltaInFlight,
      },
    };
  }

  it('steers a mode-changing message when the backend owns the delta in-flight (applied)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const { controller, steerText, applyConfigDeltaInFlight } = steerWithConfigCapability();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: controller,
    } as any);

    emitUserMessage({ content: { text: 'switch and steer' }, meta: { permissionMode: 'acceptEdits' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The wire alias 'acceptEdits' normalizes to the canonical intent 'safe-yolo' before the
    // delta reaches the backend capability.
    expect(applyConfigDeltaInFlight).toHaveBeenCalledWith({ permissionMode: 'safe-yolo' });
    expect(steerText).toHaveBeenCalledWith('switch and steer', expect.anything());
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('falls back to the queue when the in-flight config apply fails (mode applies at drain)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const { controller, steerText } = steerWithConfigCapability({
      applyConfigDeltaInFlight: vi.fn(async () => ({ status: 'failed' as const, reason: 'unsafe_window' })),
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: controller,
    } as any);

    emitUserMessage({ content: { text: 'switch and steer' }, meta: { permissionMode: 'acceptEdits' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith({ text: 'switch and steer', localId: null }, { permissionMode: 'safe-yolo' });
  });

  it('treats a thrown config apply as failed and queues (never crashes the handler)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const { controller, steerText } = steerWithConfigCapability({
      applyConfigDeltaInFlight: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: controller,
    } as any);

    emitUserMessage({ content: { text: 'switch and steer' }, meta: { permissionMode: 'acceptEdits' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalled();
  });

  it('does not call the config capability for messages that do not change the mode', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const { controller, steerText, applyConfigDeltaInFlight } = steerWithConfigCapability();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: controller,
    } as any);

    emitUserMessage({ content: { text: 'plain steer' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(applyConfigDeltaInFlight).not.toHaveBeenCalled();
    expect(steerText).toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
  });
});
