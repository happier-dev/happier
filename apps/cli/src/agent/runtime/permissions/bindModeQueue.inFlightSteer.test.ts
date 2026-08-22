import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { registerPermissionModeMessageQueueBinding } from './bindModeQueue';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';

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
  const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
    (mode) => JSON.stringify(mode),
  );
  const spyPush = vi.spyOn(queue, 'push');
  const spyIsolate = vi.spyOn(queue, 'pushIsolateAndClear');
  return { queue, spyPush, spyIsolate };
}

describe('registerPermissionModeMessageQueueBinding (in-flight steer)', () => {
  it.each([
    ['steer capability is unavailable', { supportsInFlightSteer: () => false }],
    ['the active turn is no longer steerable', { canSteerPrompt: () => false }],
    ['provider input is not admitted', { isProviderInputAdmitted: () => false }],
  ] as const)('terminally rejects an exact claimed steer when %s and never queues it', async (_label, override) => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();
    const steerText = vi.fn(async () => {});
    const rejectPromptBeforeProvider = vi.fn();

    registerPermissionModeMessageQueueBinding({
      session: {
        ...session,
        getCommittedUserMessageSeq: (localId: string) => localId === 'exact-steer-unavailable' ? 71 : null,
      },
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        rejectPromptBeforeProvider,
        ...override,
      },
    } as any);

    emitUserMessage({
      content: { text: 'exact steer only' },
      localId: 'exact-steer-unavailable',
      meta: {},
      pendingProviderAction: 'steer',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(rejectPromptBeforeProvider).toHaveBeenCalledExactlyOnceWith({
      localIds: ['exact-steer-unavailable'],
      userMessageSeq: 71,
      userMessageSeqs: [71],
    });
  });

  it('reports an exact claimed steer as effect-possible when steerText throws after invocation and never queues it', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();
    const rejectPromptBeforeProvider = vi.fn();
    const reportPromptEffectMayHaveOccurred = vi.fn();
    const steerText = vi.fn(async () => {
      throw new Error('provider rejected before accepting steer');
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
        rejectPromptBeforeProvider,
        reportPromptEffectMayHaveOccurred,
      },
    } as any);

    emitUserMessage({
      content: { text: 'do not queue me later' },
      localId: 'exact-steer-throw',
      meta: {},
      pendingProviderAction: 'steer',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledTimes(1);
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(rejectPromptBeforeProvider).not.toHaveBeenCalled();
    expect(reportPromptEffectMayHaveOccurred).toHaveBeenCalledExactlyOnceWith({
      localIds: ['exact-steer-throw'],
      userMessageSeq: null,
    });
  });

  it('rejects an exact claimed steer before provider input when steerability is lost before the queued dispatch runs', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();
    const rejectPromptBeforeProvider = vi.fn();
    const reportPromptEffectMayHaveOccurred = vi.fn();
    const steerText = vi.fn(async () => {});
    let canSteerPrompt = true;

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => canSteerPrompt,
        supportsInFlightSteer: () => true,
        canSteerPrompt: () => canSteerPrompt,
        isProviderInputAdmitted: () => true,
        steerText,
        rejectPromptBeforeProvider,
        reportPromptEffectMayHaveOccurred,
      },
    } as any);

    emitUserMessage({
      content: { text: 'stale exact steer' },
      localId: 'exact-steer-stale-before-dispatch',
      meta: {},
      pendingProviderAction: 'steer',
    });
    canSteerPrompt = false;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(rejectPromptBeforeProvider).toHaveBeenCalledExactlyOnceWith({
      localIds: ['exact-steer-stale-before-dispatch'],
      userMessageSeq: null,
    });
    expect(reportPromptEffectMayHaveOccurred).not.toHaveBeenCalled();
  });

  it.each([
    ['exact claimed steer', 'steer', true],
    ['ambient input', undefined, false],
  ] as const)('handles an admission-race cancellation for %s without losing the prompt', async (
    _label,
    pendingProviderAction,
    expectRejection,
  ) => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();
    const rejectPromptBeforeProvider = vi.fn();
    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        isProviderInputAdmitted: () => true,
        runProviderInputDispatch: vi.fn(async () => ({ status: 'cancelled' as const })),
        steerText,
        rejectPromptBeforeProvider,
      },
    } as any);

    emitUserMessage({
      content: { text: 'admission changed before dispatch' },
      localId: `admission-race-${expectRejection ? 'exact' : 'ambient'}`,
      meta: {},
      ...(pendingProviderAction ? { pendingProviderAction } : {}),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    if (expectRejection) {
      expect(spyPush).not.toHaveBeenCalled();
      expect(rejectPromptBeforeProvider).toHaveBeenCalledTimes(1);
    } else {
      expect(spyPush).toHaveBeenCalledTimes(1);
      expect(rejectPromptBeforeProvider).not.toHaveBeenCalled();
    }
  });

  it('executes a claimed send action as an isolated queued invocation and never steers an active turn', async () => {
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

    emitUserMessage({ content: { text: 'send next' }, localId: 'send-local', meta: {}, pendingProviderAction: 'send' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'send next', localId: 'send-local' }),
      { permissionMode: 'default' },
    );
  });

  it('interrupts before isolating a claimed interrupt-and-send action', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();
    const effects: string[] = [];
    const rejectPromptBeforeProvider = vi.fn();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText: vi.fn(async () => {}),
        rejectPromptBeforeProvider,
        interruptActiveTurn: vi.fn(async () => {
          effects.push('interrupt');
          return { status: 'interrupted' as const };
        }),
      },
    } as any);
    spyIsolate.mockImplementation(((..._args: unknown[]) => { effects.push('send'); }) as any);

    emitUserMessage({ content: { text: 'interrupt then send' }, localId: 'interrupt-local', meta: {}, pendingProviderAction: 'interrupt_and_send' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(effects).toEqual(['interrupt', 'send']);
    expect(spyPush).not.toHaveBeenCalled();
    expect(rejectPromptBeforeProvider).not.toHaveBeenCalled();
  });

  it('isolates a claimed interrupt-and-send action behind a provider-protected startup turn', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();
    const rejectPromptBeforeProvider = vi.fn();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText: vi.fn(async () => {}),
        rejectPromptBeforeProvider,
        interruptActiveTurn: vi.fn(async () => ({
          status: 'deferred_until_turn_end' as const,
        })),
      },
    } as any);

    emitUserMessage({
      content: { text: 'send after provider startup finishes' },
      localId: 'protected-startup-send',
      meta: {},
      pendingProviderAction: 'interrupt_and_send',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).toHaveBeenCalledTimes(1);
    expect(rejectPromptBeforeProvider).not.toHaveBeenCalled();
  });

  it.each([
    ['the interrupt capability is unavailable', undefined],
    [
      'the interrupt capability reports unsupported',
      vi.fn(async () => ({ status: 'unsupported' as const, reason: 'runtime_without_interrupt' })),
    ],
    [
      'the interrupt capability throws',
      vi.fn(async () => {
        throw new Error('interrupt failed before replacement input');
      }),
    ],
  ] as const)('rejects interrupt-and-send before provider input when %s', async (
    _label,
    interruptActiveTurn,
  ) => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();
    const rejectPromptBeforeProvider = vi.fn();
    const reportPromptEffectMayHaveOccurred = vi.fn();
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
        rejectPromptBeforeProvider,
        reportPromptEffectMayHaveOccurred,
        ...(interruptActiveTurn ? { interruptActiveTurn } : {}),
      },
    } as any);

    emitUserMessage({
      content: { text: 'do not send without interrupt' },
      localId: 'interrupt-and-send-unavailable',
      meta: {},
      pendingProviderAction: 'interrupt_and_send',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(rejectPromptBeforeProvider).toHaveBeenCalledExactlyOnceWith({
      localIds: ['interrupt-and-send-unavailable'],
      userMessageSeq: null,
      reason: 'unsupported_action',
    });
    expect(reportPromptEffectMayHaveOccurred).not.toHaveBeenCalled();
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

  it('queues model-carrying messages instead of steering them into an active turn', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      agentTargetKey: 'backend:opencode',
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
      content: { text: 'switch model next' },
      localId: 'local-model-steer-1',
      meta: {
        modelSelectionV1: {
          v: 1,
          updatedAt: 42,
          ref: {
            agentTargetKey: 'backend:opencode',
            providerConnectionId: null,
            modelId: 'opencode/big-pickle',
          },
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      { text: 'switch model next', localId: 'local-model-steer-1', localIds: ['local-model-steer-1'] },
      {
        permissionMode: 'default',
        modelSelection: {
          agentTargetKey: 'backend:opencode',
          providerConnectionId: null,
          modelId: 'opencode/big-pickle',
        },
      },
    );
  });

  it('passes the committed user-message seq to steerText for exact transcript anchoring', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session: {
        ...session,
        getCommittedUserMessageSeq: (localId: string) => (localId === 'local-steer-seq' ? 17 : null),
      },
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer with seq' }, localId: 'local-steer-seq', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith('steer with seq', {
      localId: 'local-steer-seq',
      localIds: ['local-steer-seq'],
      userMessageSeq: 17,
      userMessageSeqs: [17],
    });
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

    emitUserMessage({
      content: { text: 'steer me' },
      localId: 'local-1',
      meta: {
        happierProvenanceV1: {
          v: 1,
          kind: 'automation',
          automationId: 'automation-1',
          runId: 'run-1',
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith([
      '<happier_input_context v="1">',
      'source_kind="automation"',
      'automation_id="automation-1"',
      'automation_run_id="run-1"',
      '</happier_input_context>',
      '',
      'SEED',
      '',
      'steer me',
    ].join('\n'), { localId: 'local-1', localIds: ['local-1'] });
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

    // Allow the async steer task to enter the runtime call before releasing its gate. The
    // binding may perform bounded best-effort metadata work before steering.
    await new Promise<void>((resolve) => setImmediate(resolve));

    resolveFirstGate();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(maxInFlight).toBe(1);
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('drops stale async steer work after the bound session changes', async () => {
    const first = createSessionHarness();
    const second = createSessionHarness();
    const { queue, spyPush } = createQueue();

    let releaseRefresh: () => void = () => {
      throw new Error('refresh gate not initialized');
    };
    first.session.refreshSessionSnapshotFromServerBestEffort = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
    });

    const steerText = vi.fn(async () => {});
    const binding = registerPermissionModeMessageQueueBinding({
      session: first.session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    first.emitUserMessage({ content: { text: 'stale steer' }, meta: {} });
    await Promise.resolve();
    binding.bindSession(second.session);
    releaseRefresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
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

  it('steers native provider slash commands that are not Happier context-mutating commands', async () => {
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

    expect(steerText).toHaveBeenCalledWith('/model', { localId: null });
    expect(spyPush).not.toHaveBeenCalled();
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
