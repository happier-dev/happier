import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { registerPermissionModeMessageQueueBinding } from './bindModeQueue';
import { createUnsettledReplaySeedRetirement } from '../replaySeed/unsettledReplaySeedRetirement';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionFollowContextReconciler } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from '@/agent/runtime/session/follow/sessionFollowSourceHydrator';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import { combinePermissionModeQueuedPrompts } from '@/agent/runtime/permissions/queuedPrompt';
import {
  renderSessionInputContextBlockV1,
  renderSessionInputContextPromptV1,
  resolveSessionInputPromptProvenanceV1,
} from '@happier-dev/protocol';

const LEGACY_UNKNOWN_INPUT_CONTEXT = renderSessionInputContextBlockV1({
  provenance: resolveSessionInputPromptProvenanceV1({}),
});

function renderLegacyUnknownProviderPrompt(text: string): string {
  return renderSessionInputContextPromptV1({
    provenanceBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
    transformedUserText: text,
  });
}

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
    { batcher: combinePermissionModeQueuedPrompts },
  );
  const spyPush = vi.spyOn(queue, 'push');
  const spyIsolate = vi.spyOn(queue, 'pushIsolateAndClear');
  return { queue, spyPush, spyIsolate };
}

describe('registerPermissionModeMessageQueueBinding (in-flight steer)', () => {
  it('keeps session role instructions out of the steer context slot', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue } = createQueue();
    const steerText = vi.fn(async (_text: string) => {});
    registerPermissionModeMessageQueueBinding({
      session, queue, getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true, supportsInFlightSteer: () => true, steerText,
        registerProviderAcceptedEffect: () => undefined,
      },
    });
    emitUserMessage({ content: { text: 'FIRST_INPUT' }, localId: 'role-steer-first', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steerText.mock.calls[0]?.[0]).toBe(renderLegacyUnknownProviderPrompt('FIRST_INPUT'));
    emitUserMessage({ content: { text: 'SECOND_INPUT' }, localId: 'role-steer-second', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steerText.mock.calls[1]?.[0]).toBe(renderLegacyUnknownProviderPrompt('SECOND_INPUT'));
  });

  it.each([
    ['the provider is idle', { isTurnInFlight: () => false }],
    ['steer capability is unavailable', { supportsInFlightSteer: () => false }],
    ['the active turn is no longer steerable', { canSteerPrompt: () => false }],
    ['provider input is not admitted', { isProviderInputAdmitted: () => false }],
  ] as const)('queues a non-interrupting explicit steer when %s', async (_label, override) => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue } = createQueue();
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({
      content: { text: 'exact steer only' },
      localId: 'exact-steer-unavailable',
      meta: {},
      pendingProviderAction: 'steer',
      pendingRequestedAction: { v: 1, kind: 'steer_now' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    const next = await queue.waitForMessagesAndGetAsString();
    expect(next?.message).toMatchObject({
      text: 'exact steer only', localId: 'exact-steer-unavailable', userMessageSeq: 71,
    });
    expect(rejectPromptBeforeProvider).not.toHaveBeenCalled();
  });

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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({
      content: { text: 'exact steer only' },
      localId: 'exact-steer-unavailable',
      meta: {},
      pendingProviderAction: 'steer',
      pendingRequestedAction: { v: 1, kind: 'steer_if_active' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(rejectPromptBeforeProvider).toHaveBeenCalledExactlyOnceWith({
      localIds: ['exact-steer-unavailable'],
      userMessageSeq: 71,
      userMessageSeqs: [71],
      reason: 'conditional_steer_unavailable',
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
        registerProviderAcceptedEffect: () => undefined,
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

  it('queues a non-interrupting steer when steerability is lost before the queued dispatch runs', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue } = createQueue();
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
        registerProviderAcceptedEffect: () => undefined,
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
    expect(queue.size()).toBe(1);
    expect((await queue.waitForMessagesAndGetAsString())?.message).toMatchObject({
      text: 'stale exact steer', localId: 'exact-steer-stale-before-dispatch',
    });
    expect(rejectPromptBeforeProvider).not.toHaveBeenCalled();
    expect(reportPromptEffectMayHaveOccurred).not.toHaveBeenCalled();
  });

  it.each([
    ['exact claimed steer', 'steer'],
    ['ambient input', undefined],
  ] as const)('handles an admission-race cancellation for %s without losing the prompt', async (
    label,
    pendingProviderAction,
  ) => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue } = createQueue();
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({
      content: { text: 'admission changed before dispatch' },
      localId: `admission-race-${label}`,
      meta: {},
      ...(pendingProviderAction ? { pendingProviderAction } : {}),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect((await queue.waitForMessagesAndGetAsString())?.message).toMatchObject({
      text: 'admission changed before dispatch', localId: `admission-race-${label}`,
    });
    expect(rejectPromptBeforeProvider).not.toHaveBeenCalled();
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({ content: { text: 'send next' }, localId: 'send-local', meta: {}, pendingProviderAction: 'send' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'send next',
        localId: 'send-local',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
      expect.objectContaining({
        permissionMode: 'default',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
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
        registerProviderAcceptedEffect: () => undefined,
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
        registerProviderAcceptedEffect: () => undefined,
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
        registerProviderAcceptedEffect: () => undefined,
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
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello',
        localId: null,
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
      expect.objectContaining({
        permissionMode: 'default',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
    );
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer me' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith(
      renderLegacyUnknownProviderPrompt('steer me'),
      { localId: null },
    );
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('steers a completion-only structured message as its tagged notification text', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();
    const steerText = vi.fn(async () => {});
    const rejectPromptBeforeProvider = vi.fn();

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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({
      content: {
        text: [
          '<happier_execution_run_notification>',
          'This is an automated background-run notification from Happier, not a user message.',
          'Run ID: run_1',
          'Status: succeeded',
          '',
          'Final result:',
          'Reviewed the change.',
          '</happier_execution_run_notification>',
        ].join('\n'),
      },
      localId: 'execution-run-completion',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          executionRunCompletion: {
            v: 1,
            runId: 'run_1',
            status: 'succeeded',
            finishedAtMs: 42,
            canInspect: true,
            summary: 'Reviewed the change.',
          },
        },
      },
      pendingProviderAction: 'steer',
      pendingRequestedAction: { v: 1, kind: 'steer_if_active' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith(
      renderLegacyUnknownProviderPrompt([
        '<happier_execution_run_notification>',
        'This is an automated background-run notification from Happier, not a user message.',
        'Run ID: run_1',
        'Status: succeeded',
        '',
        'Final result:',
        'Reviewed the change.',
        '</happier_execution_run_notification>',
      ].join('\n')),
      expect.objectContaining({ localId: 'execution-run-completion' }),
    );
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(rejectPromptBeforeProvider).not.toHaveBeenCalled();
  });

  it('does not drop additional structured semantics while steering a completion message', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();
    const steerText = vi.fn(async () => {});
    const rejectPromptBeforeProvider = vi.fn();

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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({
      content: {
        text: [
          '<happier_execution_run_notification>',
          'This is an automated background-run notification from Happier, not a user message.',
          'Run ID: run_1',
          'Status: succeeded',
          '</happier_execution_run_notification>',
        ].join('\n'),
      },
      localId: 'completion-with-extra-semantics',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          executionRunCompletion: {
            v: 1,
            runId: 'run_1',
            status: 'succeeded',
            finishedAtMs: 42,
            canInspect: true,
          },
          futureStructuredContract: { value: 'must not be discarded' },
        },
      },
      pendingProviderAction: 'steer',
      pendingRequestedAction: { v: 1, kind: 'steer_if_active' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(rejectPromptBeforeProvider).toHaveBeenCalledExactlyOnceWith({
      localIds: ['completion-with-extra-semantics'],
      userMessageSeq: null,
      reason: 'conditional_steer_unavailable',
    });
  });

  it('queues model-carrying messages instead of steering them into an active turn', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      agentTargetKey: 'agent:happier.agent.opencode/opencode',
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
        registerProviderAcceptedEffect: () => undefined,
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
            agentTargetKey: 'agent:happier.agent.opencode/opencode',
            providerConnectionId: null,
            modelId: 'opencode/big-pickle',
          },
        },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'switch model next',
        localId: 'local-model-steer-1',
        localIds: ['local-model-steer-1'],
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
      expect.objectContaining({
        permissionMode: 'default',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
        modelSelection: {
          agentTargetKey: 'agent:happier.agent.opencode/opencode',
          providerConnectionId: null,
          modelId: 'opencode/big-pickle',
        },
      }),
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer with seq' }, localId: 'local-steer-seq', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith(renderLegacyUnknownProviderPrompt('steer with seq'), {
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({ content: { text: 'queue me' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'queue me',
        localId: null,
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
      expect.objectContaining({
        permissionMode: 'default',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
    );
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

    const acceptanceByLocalId = new Map<string, () => void>();
    const steerText = vi.fn(async () => {
      acceptanceByLocalId.get('local-1')?.();
    });

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        registerProviderAcceptedEffect: (localId: string, onAccepted: (() => void) | null) => {
          if (onAccepted) acceptanceByLocalId.set(localId, onAccepted);
          else acceptanceByLocalId.delete(localId);
        },
        steerText,
      },
    } as any);

    emitUserMessage({
      content: { text: '/goal steer me' },
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
      '/goal steer me',
    ].join('\n'), {
      localId: 'local-1',
      localIds: ['local-1'],
    });
    expect(spyPush).not.toHaveBeenCalled();

    const finalMeta = session.getMetadataSnapshot();
    expect(finalMeta?.replaySeedV1?.seedText).toBe('');
    expect(finalMeta?.replaySeedV1?.appliedToLocalId).toBe('local-1');
  });

  it.each([
    { exact: false, change: 'turn ends' },
    { exact: true, change: 'turn ends' },
    { exact: false, change: 'Session binding changes' },
    { exact: true, change: 'Session binding changes' },
  ])('does not dispatch after $change during Follow preparation (exact steer: $exact)', async ({ exact, change }) => {
    const first = createSessionHarness();
    const second = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();
    first.setMetadataSnapshot({
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    });
    let releaseObservation!: () => void;
    const observationGate = new Promise<void>((resolve) => { releaseObservation = resolve; });
    const observePendingSessionFollow = vi.fn(async () => {
      await observationGate;
      return { ok: true, v: 1, sessionId: 'destination', publisherGeneration: '1', observations: [] };
    });
    const acknowledgeSessionFollow = vi.fn();
    // Session network methods are the boundary; preparation and hydration remain real owners.
    const followSession = {
      sessionId: 'destination',
      observePendingSessionFollow,
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const prepareHostContext = createSessionFollowContextReconciler({
      session: followSession,
      hydrateObservation: createSessionFollowSourceHydrator({
        session: followSession,
        credentials: { token: 'test-token', encryption: null },
      }),
      maxFollowContextUtf8Bytes: 4096,
    });
    let steerable = true;
    const steerText = vi.fn(async () => {});
    const rejectPromptBeforeProvider = vi.fn();
    const registerProviderAcceptedEffect = vi.fn();
    const binding = registerPermissionModeMessageQueueBinding({
      session: {
        ...first.session,
        readDurableProviderInputAcceptanceV1: async () => 'not_accepted' as const,
      },
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => steerable,
        supportsInFlightSteer: () => true,
        canSteerPrompt: () => steerable,
        prepareHostContext,
        registerProviderAcceptedEffect,
        rejectPromptBeforeProvider,
        steerText,
      },
    });
    first.emitUserMessage({
      role: 'user',
      content: { type: 'text', text: 'raw steer' },
      localId: 'pending-follow-steer',
      meta: {},
      ...(exact ? {
        pendingProviderAction: 'steer',
        pendingRequestedAction: { v: 1, kind: 'steer_if_active' },
      } : {}),
    });
    await vi.waitFor(() => expect(observePendingSessionFollow).toHaveBeenCalledOnce());
    expect(first.session.getMetadataSnapshot().replaySeedV1.dispatchedToLocalId).toBe('pending-follow-steer');
    if (change === 'turn ends') steerable = false;
    else binding.bindSession(second.session);
    releaseObservation();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).not.toHaveBeenCalled();
    expect(registerProviderAcceptedEffect).not.toHaveBeenCalled();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
    expect(first.session.getMetadataSnapshot().replaySeedV1).toMatchObject({ seedText: 'SEED' });
    expect(first.session.getMetadataSnapshot().replaySeedV1.dispatchedToLocalId).toBeUndefined();
    expect(spyIsolate).not.toHaveBeenCalled();
    if (exact) {
      expect(rejectPromptBeforeProvider).toHaveBeenCalledExactlyOnceWith({
        localIds: ['pending-follow-steer'],
        userMessageSeq: null,
        reason: 'conditional_steer_unavailable',
      });
      expect(spyPush).not.toHaveBeenCalled();
    } else if (change === 'turn ends') {
      expect(rejectPromptBeforeProvider).not.toHaveBeenCalled();
      expect(spyPush).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'raw steer' }),
        expect.objectContaining({ permissionMode: 'default' }),
      );
    } else {
      expect(rejectPromptBeforeProvider).not.toHaveBeenCalled();
      expect(spyPush).not.toHaveBeenCalled();
      expect(second.session.getMetadataSnapshot()).toBeNull();
    }
  });

  it('composes Follow into an in-flight steer and acknowledges only on exact provider acceptance', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();
    const acknowledgeAccepted = vi.fn();
    const prepareHostContext = vi.fn(async ({ requiredPrompt }: { requiredPrompt: string }) => {
      expect(requiredPrompt).toContain('steer with context');
      return {
        updates: [{
          v: 1,
          kind: 'session_follow_update' as const,
          edge: { sourceSessionId: 'source', destinationSessionId: 'destination' },
          reason: 'source_changed' as const,
          deliveryIntent: 'context_only' as const,
          observed: { transcriptSeq: 2, readyEventSeq: 0, agentStateVersion: 0, turn: null },
          awareness: {
            v: 1,
            sessionId: 'source',
            lifecycle: 'ready' as const,
            runtime: 'idle' as const,
            freshness: 'live' as const,
            operational: { primary: 'ready' as const, reasons: ['ready' as const] },
            encryption: 'plain' as const,
            availability: 'complete' as const,
          },
          recentMessages: [{ messageId: 'source-2', seq: 2, text: 'follow context', provenance: null }],
          truncated: false,
        }],
        acknowledgeAccepted,
      };
    });
    let accept: (() => void) | null = null;
    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        registerProviderAcceptedEffect: (_localId: string, onAccepted: (() => void) | null) => {
          accept = onAccepted;
        },
        prepareHostContext,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer with context' }, localId: 'steer-follow', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(spyPush).not.toHaveBeenCalled();
    expect(steerText).toHaveBeenCalledWith(
      expect.stringContaining('<session_follow>'),
      expect.objectContaining({ localId: 'steer-follow' }),
    );
    const sentPrompt = (steerText.mock.calls as unknown as Array<[string]>)[0]?.[0] ?? '';
    expect(sentPrompt).toContain('follow context');
    expect(sentPrompt.endsWith('steer with context')).toBe(true);
    expect(acknowledgeAccepted).not.toHaveBeenCalled();
    expect(accept).toBeTypeOf('function');
    (accept as unknown as () => void)();
    expect(acknowledgeAccepted).toHaveBeenCalledWith({
      kind: 'admitted_input',
      localInputId: 'steer-follow',
      userMessageSeq: null,
    });
  });

  it('keeps a steered replay seed live until exact provider acceptance', async () => {
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
    let acceptProviderPrompt: (() => void) | undefined;
    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        registerProviderAcceptedEffect: (_localId: string, onAccepted: (() => void) | null) => {
          acceptProviderPrompt = onAccepted ?? undefined;
        },
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer me' }, localId: 'local-steer-acceptance', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(acceptProviderPrompt).toBeTypeOf('function');
    expect(session.getMetadataSnapshot()?.replaySeedV1?.seedText).toBe('SEED');

    acceptProviderPrompt?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.getMetadataSnapshot()?.replaySeedV1?.seedText).toBe('');
    expect(session.getMetadataSnapshot()?.replaySeedV1?.appliedToLocalId).toBe(
      'local-steer-acceptance',
    );
  });

  it('blocks a further steer while an accepted seed retirement keeps failing, then steers without the seed once it succeeds', async () => {
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
    // The provider accepted steer #1, but retiring its seed fails on acceptance and again at
    // the next steer admission boundary. Only after the write recovers may steer #3 dispatch.
    let retirementWriteFailures = 2;
    let retirementWriteAttempts = 0;
    session.updateMetadata = vi.fn(async (updater: (m: any) => any) => {
      retirementWriteAttempts += 1;
      if (retirementWriteFailures > 0) {
        retirementWriteFailures -= 1;
        throw new Error('metadata unavailable');
      }
      setMetadataSnapshot(updater(session.getMetadataSnapshot() ?? {}));
    });

    const acceptanceByLocalId = new Map<string, () => void>();
    const steerText = vi.fn(async (_text: string, options?: { localId?: string | null }) => {
      const localId = options?.localId ?? null;
      if (localId) acceptanceByLocalId.get(localId)?.();
    });

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      replaySeedRetirement: createUnsettledReplaySeedRetirement(),
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        registerProviderAcceptedEffect: (localId: string, onAccepted: (() => void) | null) => {
          if (onAccepted) acceptanceByLocalId.set(localId, onAccepted);
          else acceptanceByLocalId.delete(localId);
        },
        steerText,
      },
    } as any);

    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 500 && !predicate(); i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(predicate()).toBe(true);
    };

    emitUserMessage({ content: { text: 'steer me' }, localId: 'local-1', meta: {} });
    await waitFor(() => retirementWriteAttempts === 1);
    expect(steerText).toHaveBeenCalledTimes(1);
    expect(steerText).toHaveBeenCalledWith(
      renderLegacyUnknownProviderPrompt('SEED\n\nsteer me'),
      expect.objectContaining({ localId: 'local-1' }),
    );

    emitUserMessage({ content: { text: 'again' }, localId: 'local-2', meta: {} });
    // The admission boundary retried the failed retirement, it failed again, and steer #2 is
    // blocked back to the queue instead of carrying the already-accepted seed to the provider.
    await waitFor(() => retirementWriteAttempts === 2 && spyPush.mock.calls.length > 0);
    expect(steerText).toHaveBeenCalledTimes(1);
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'again',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
      expect.objectContaining({
        permissionMode: 'default',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
    );

    // The write recovers; the next steer admission boundary retries successfully and only
    // then dispatches — with the retired seed no longer prefixed.
    retirementWriteFailures = 0;
    emitUserMessage({ content: { text: 'third' }, localId: 'local-3', meta: {} });
    await waitFor(() => steerText.mock.calls.length === 2);
    expect(steerText).toHaveBeenCalledWith(
      renderLegacyUnknownProviderPrompt('third'),
      expect.objectContaining({ localId: 'local-3' }),
    );
    expect(retirementWriteAttempts).toBeGreaterThanOrEqual(3);
    expect(session.getMetadataSnapshot()?.replaySeedV1?.seedText).toBe('');
  });

  it('settles an accepted steer against its original Session after the queue binding moves', async () => {
    const first = createSessionHarness();
    const second = createSessionHarness();
    const { queue } = createQueue();
    first.setMetadataSnapshot({
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'sess_parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    });
    let acceptFirstPrompt: (() => void) | undefined;
    const binding = registerPermissionModeMessageQueueBinding({
      session: first.session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        registerProviderAcceptedEffect: (_localId: string, onAccepted: (() => void) | null) => {
          acceptFirstPrompt = onAccepted ?? undefined;
        },
        steerText: vi.fn(async () => {}),
      },
    } as any);

    first.emitUserMessage({ content: { text: 'steer me' }, localId: 'local-old-session', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acceptFirstPrompt).toBeTypeOf('function');

    binding.bindSession(second.session);
    acceptFirstPrompt?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(first.session.getMetadataSnapshot()?.replaySeedV1?.seedText).toBe('');
    expect(first.session.getMetadataSnapshot()?.replaySeedV1?.appliedToLocalId).toBe(
      'local-old-session',
    );
  });

  it('drains acceptance-triggered replay-seed settlement before resolving the next steer prompt', async () => {
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
    let releaseSettlement: (() => void) | undefined;
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const originalUpdateMetadata = session.updateMetadata;
    session.updateMetadata = vi.fn(async (updater: (metadata: any) => any) => {
      await settlementGate;
      await originalUpdateMetadata(updater);
    });
    let acceptFirstPrompt: (() => void) | undefined;
    const steerText = vi.fn(async (_text: string) => {});

    registerPermissionModeMessageQueueBinding({
      session: session as any,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        registerProviderAcceptedEffect: (_localId: string, onAccepted: (() => void) | null) => {
          if (!acceptFirstPrompt) acceptFirstPrompt = onAccepted ?? undefined;
        },
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'first' }, localId: 'local-steer-first', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acceptFirstPrompt).toBeTypeOf('function');

    acceptFirstPrompt?.();
    emitUserMessage({ content: { text: 'second' }, localId: 'local-steer-second', meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(steerText).toHaveBeenCalledTimes(1);

    releaseSettlement?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledTimes(2);
    expect(steerText.mock.calls[1]?.[0]).toBe(renderLegacyUnknownProviderPrompt('second'));
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({ content: { text: 'queue me' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'queue me',
        localId: null,
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
      expect.objectContaining({
        permissionMode: 'default',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
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
          registerProviderAcceptedEffect: () => undefined,
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
        registerProviderAcceptedEffect: () => undefined,
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    first.emitUserMessage({ content: { text: 'stale steer' }, meta: {} });
    await vi.waitFor(() => {
      expect(first.session.refreshSessionSnapshotFromServerBestEffort).toHaveBeenCalledTimes(1);
    });
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change' }, meta: { permissionMode: 'read-only' } });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'mode change',
        localId: null,
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
      expect.objectContaining({
        permissionMode: 'read-only',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
    );
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({ content: { text: 'same mode, alias spelling' }, meta: { permissionMode: 'safe-yolo' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith(
      renderLegacyUnknownProviderPrompt('same mode, alias spelling'),
      { localId: null },
    );
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({ content: { text: '/clear' }, meta: {} });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/clear',
        localId: null,
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
      expect.objectContaining({
        permissionMode: 'default',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({ content: { text: '/compact' }, meta: {} });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/compact',
        localId: null,
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
      expect.objectContaining({
        permissionMode: 'default',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
    );
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
        registerProviderAcceptedEffect: () => undefined,
      },
    } as any);

    emitUserMessage({ content: { text: '/model' }, meta: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(steerText).toHaveBeenCalledWith(
      renderLegacyUnknownProviderPrompt('/model'),
      { localId: null },
    );
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
        registerProviderAcceptedEffect: () => undefined,
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
        registerProviderAcceptedEffect: () => undefined,
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
        registerProviderAcceptedEffect: () => undefined,
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
        registerProviderAcceptedEffect: () => undefined,
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
    expect(steerText).toHaveBeenCalledWith(
      renderLegacyUnknownProviderPrompt('switch and steer'),
      expect.anything(),
    );
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
    expect(spyPush).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'switch and steer',
        localId: null,
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
      expect.objectContaining({
        permissionMode: 'safe-yolo',
        inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT,
      }),
    );
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
