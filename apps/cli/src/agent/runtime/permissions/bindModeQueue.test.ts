import { describe, expect, it } from 'vitest';

import type { Metadata, PermissionMode, UserMessage } from '@/api/types';
import { registerPermissionModeMessageQueueBinding } from './bindModeQueue';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';

describe('registerPermissionModeMessageQueueBinding', () => {
  function createSessionHarness(initialMetadata?: Metadata) {
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;
    let metadata =
      initialMetadata ?? ({ permissionMode: 'default', permissionModeUpdatedAt: 0 } as unknown as Metadata);

    return {
      session: {
        onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
          userMessageHandler = handler;
        },
        updateMetadata: (updater: (current: Metadata) => Metadata) => {
          metadata = updater(metadata);
        },
      },
      emit: (message: UserMessage) => {
        if (!userMessageHandler) throw new Error('missing onUserMessage handler');
        return userMessageHandler(message);
      },
      getMetadata: () => metadata,
    };
  }

  function createHarness() {
    const queueCalls: Array<{
      type: 'push' | 'clear';
      message: PermissionModeQueuedPrompt;
      mode: { permissionMode: PermissionMode; appendSystemPrompt?: string | null; model?: string };
    }> = [];
    let currentPermissionMode: PermissionMode | undefined;
    const sessionHarness = createSessionHarness();

    const binding = registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      queue: {
        push: (message: PermissionModeQueuedPrompt, mode: { permissionMode: PermissionMode; model?: string }) =>
          queueCalls.push({ type: 'push', message, mode }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt, mode: { permissionMode: PermissionMode; model?: string }) =>
          queueCalls.push({ type: 'clear', message, mode }),
      },
      getCurrentPermissionMode: () => currentPermissionMode,
      setCurrentPermissionMode: (mode: PermissionMode | undefined) => {
        currentPermissionMode = mode;
      },
    });

    return {
      bindSession: binding.bindSession,
      emit: sessionHarness.emit,
      getCurrentPermissionMode: () => currentPermissionMode,
      getMetadata: sessionHarness.getMetadata,
      queueCalls,
    };
  }

  it('queues regular messages with the current permission mode', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'hello world' },
      localId: 'local-1',
      meta: {},
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: { text: 'hello world', localId: 'local-1', localIds: ['local-1'] },
        mode: { permissionMode: 'default' },
      },
    ]);
  });

  it('threads the committed user-message seq into the queued prompt (HF-1 watermark custody chain)', () => {
    // The provider-acceptance watermark needs the row seq to travel WITH the prompt through the
    // queue so acceptance can confirm exactly the accepted rows (never a later unaccepted one).
    const queueCalls: Array<{ message: PermissionModeQueuedPrompt }> = [];
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;

    registerPermissionModeMessageQueueBinding({
      session: {
        onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
          userMessageHandler = handler;
        },
        updateMetadata: () => void 0,
        getCommittedUserMessageSeq: (localId: string) => (localId === 'local-seq-1' ? 42 : null),
      },
      queue: {
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
      },
      getCurrentPermissionMode: () => 'default' as PermissionMode,
      setCurrentPermissionMode: () => void 0,
    });

    userMessageHandler!({
      role: 'user',
      content: { type: 'text', text: 'confirm me later' },
      localId: 'local-seq-1',
      meta: {},
    } as UserMessage);

    expect(queueCalls).toEqual([
      {
        message: {
          text: 'confirm me later',
          localId: 'local-seq-1',
          localIds: ['local-seq-1'],
          userMessageSeq: 42,
          userMessageSeqs: [42],
        },
      },
    ]);
  });

  it('threads canonical provider-claimed pending delivery into the queued prompt', () => {
    const queueCalls: Array<{ message: PermissionModeQueuedPrompt }> = [];
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;

    registerPermissionModeMessageQueueBinding({
      session: {
        onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
          userMessageHandler = handler;
        },
        updateMetadata: () => void 0,
        getCommittedUserMessageSeq: () => null,
        hasCanonicalPendingDeliveryLocalId: (localId: string) => localId === 'provider-claimed-local-1',
      },
      queue: {
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
      },
      getCurrentPermissionMode: () => 'default' as PermissionMode,
      setCurrentPermissionMode: () => void 0,
    });

    userMessageHandler!({
      role: 'user',
      content: { type: 'text', text: 'owned by provider pending delivery' },
      localId: 'provider-claimed-local-1',
      meta: {},
    } as UserMessage);

    expect(queueCalls).toEqual([
      {
        message: {
          text: 'owned by provider pending delivery',
          localId: 'provider-claimed-local-1',
          localIds: ['provider-claimed-local-1'],
          providerClaimedPendingLocalIds: ['provider-claimed-local-1'],
        },
      },
    ]);
  });

  it('does not queue the same committed user-message row twice', () => {
    const queueCalls: Array<{ message: PermissionModeQueuedPrompt }> = [];
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;

    registerPermissionModeMessageQueueBinding({
      session: {
        onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
          userMessageHandler = handler;
        },
        updateMetadata: () => void 0,
        getCommittedUserMessageSeq: (localId: string) => (localId === 'local-dup-1' ? 7 : null),
      },
      queue: {
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
      },
      getCurrentPermissionMode: () => 'default' as PermissionMode,
      setCurrentPermissionMode: () => void 0,
    });

    const message = {
      role: 'user',
      content: { type: 'text', text: 'deliver exactly once' },
      localId: 'local-dup-1',
      meta: {},
    } as UserMessage;

    expect(userMessageHandler!(message)).toBe(true);
    expect(userMessageHandler!(message)).toBe(true);

    expect(queueCalls).toEqual([
      {
        message: {
          text: 'deliver exactly once',
          localId: 'local-dup-1',
          localIds: ['local-dup-1'],
          userMessageSeq: 7,
          userMessageSeqs: [7],
        },
      },
    ]);
  });

  it('updates permission mode from message metadata before queueing', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'approve this' },
      localId: 'local-2',
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

    expect(harness.getCurrentPermissionMode()).toBe('safe-yolo');
    expect(harness.getMetadata().permissionMode).toBe('safe-yolo');
    expect(harness.getMetadata().permissionModeUpdatedAt).toBe(42);
    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: { text: 'approve this', localId: 'local-2', localIds: ['local-2'] },
        mode: { permissionMode: 'safe-yolo' },
      },
    ]);
  });

  it('queues model overrides from user message metadata as a prompt mode dimension', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'use this model' },
      localId: 'local-model-1',
      meta: { model: ' opencode/big-pickle ' },
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: { text: 'use this model', localId: 'local-model-1', localIds: ['local-model-1'] },
        mode: { permissionMode: 'default', model: 'opencode/big-pickle' },
      },
    ]);
  });

  it('updates metadata through the rebound session after bindSession swaps the client', () => {
    const harness = createHarness();
    const reboundSession = createSessionHarness();

    harness.bindSession(reboundSession.session);

    reboundSession.emit({
      role: 'user',
      content: { type: 'text', text: 'approve this' },
      localId: 'local-rebind-1',
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

    expect(reboundSession.getMetadata().permissionMode).toBe('safe-yolo');
    expect(reboundSession.getMetadata().permissionModeUpdatedAt).toBe(42);
    expect(harness.getMetadata().permissionMode).toBe('default');
    expect(harness.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: { text: 'approve this', localId: 'local-rebind-1', localIds: ['local-rebind-1'] },
        mode: { permissionMode: 'safe-yolo' },
      },
    ]);
  });

  it('ignores old-session user messages after bindSession swaps to a new client', () => {
    const harness = createHarness();
    const reboundSession = createSessionHarness();

    harness.bindSession(reboundSession.session);

    const accepted = harness.emit({
      role: 'user',
      content: { type: 'text', text: 'stale session message' },
      localId: 'local-stale-1',
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

    expect(accepted).toBe(false);
    expect(harness.getCurrentPermissionMode()).toBeUndefined();
    expect(harness.getMetadata().permissionMode).toBe('default');
    expect(harness.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(reboundSession.getMetadata().permissionMode).toBe('default');
    expect(reboundSession.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(harness.queueCalls).toEqual([]);
  });

  it('routes clear commands through isolate-and-clear queue path', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: '/clear' },
      localId: 'local-3',
      meta: {},
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'clear',
        message: { text: '/clear', localId: 'local-3', localIds: ['local-3'] },
        mode: { permissionMode: 'default' },
      },
    ]);
  });

  it('passes the user message local id when steering an in-flight turn', async () => {
    const sessionHarness = createSessionHarness();
    const queueCalls: PermissionModeQueuedPrompt[] = [];
    const steerCalls: Array<Readonly<{ text: string; localId: string | null | undefined }>> = [];

    registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      queue: {
        push: (message: PermissionModeQueuedPrompt) => {
          queueCalls.push(message);
        },
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => {
          queueCalls.push(message);
        },
      },
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      inFlightSteer: {
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => true,
        steerText: async (text, options) => {
          steerCalls.push({ text, localId: options?.localId });
        },
      },
    });

    sessionHarness.emit({
      role: 'user',
      content: { type: 'text', text: 'nudge active turn' },
      localId: 'local-steer-1',
      meta: {},
    } as UserMessage);

    await Promise.resolve();

    expect(queueCalls).toEqual([]);
    expect(steerCalls).toEqual([
      { text: 'nudge active turn', localId: 'local-steer-1' },
    ]);
  });

  it('threads provider-claimed pending delivery into in-flight steering metadata', async () => {
    const sessionHarness = createSessionHarness();
    const queueCalls: PermissionModeQueuedPrompt[] = [];
    const steerCalls: Array<Readonly<{
      text: string;
      localId: string | null | undefined;
      providerClaimedPendingLocalIds: readonly string[] | undefined;
    }>> = [];
    Object.assign(sessionHarness.session, {
      hasCanonicalPendingDeliveryLocalId: (localId: string) => localId === 'local-steer-provider-claimed',
    });

    registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      queue: {
        push: (message: PermissionModeQueuedPrompt) => {
          queueCalls.push(message);
        },
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => {
          queueCalls.push(message);
        },
      },
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      inFlightSteer: {
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => true,
        steerText: async (text, options) => {
          steerCalls.push({
            text,
            localId: options?.localId,
            providerClaimedPendingLocalIds: options?.providerClaimedPendingLocalIds,
          });
        },
      },
    });

    sessionHarness.emit({
      role: 'user',
      content: { type: 'text', text: 'provider claimed steer' },
      localId: 'local-steer-provider-claimed',
      meta: {},
    } as UserMessage);

    await Promise.resolve();

    expect(queueCalls).toEqual([]);
    expect(steerCalls).toEqual([
      {
        text: 'provider claimed steer',
        localId: 'local-steer-provider-claimed',
        providerClaimedPendingLocalIds: ['local-steer-provider-claimed'],
      },
    ]);
  });

  it('reads appendSystemPrompt from prototype-less metadata objects', () => {
    const harness = createHarness();
    const meta = Object.assign(Object.create(null) as Record<string, unknown>, {
      appendSystemPrompt: 'Use the latest project conventions.',
    });

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'hello world' },
      localId: 'local-4',
      meta,
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: { text: 'hello world', localId: 'local-4', localIds: ['local-4'] },
        mode: {
          permissionMode: 'default',
          appendSystemPrompt: 'Use the latest project conventions.',
        },
      },
    ]);
  });
});
