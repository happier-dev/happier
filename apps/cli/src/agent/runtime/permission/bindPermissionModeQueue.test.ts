import { describe, expect, it } from 'vitest';

import type { Metadata, PermissionMode, UserMessage } from '@/api/types';
import { registerPermissionModeMessageQueueBinding } from './bindPermissionModeQueue';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import type { ApiSessionClient } from '@/api/session/sessionClient';

describe('registerPermissionModeMessageQueueBinding', () => {
  function createSessionHarness(initialMetadata?: Metadata) {
    let userMessageHandler: ((message: UserMessage) => void) | null = null;
    let metadata =
      initialMetadata ?? ({ permissionMode: 'default', permissionModeUpdatedAt: 0 } as unknown as Metadata);

    return {
      session: {
        getMetadataSnapshot: () => metadata,
        onUserMessage: (handler: (message: UserMessage) => void) => {
          userMessageHandler = handler;
        },
        updateMetadata: (updater: (current: Metadata) => Metadata) => {
          metadata = updater(metadata);
        },
      },
      emit: (message: UserMessage) => {
        if (!userMessageHandler) throw new Error('missing onUserMessage handler');
        userMessageHandler(message);
      },
      getMetadata: () => metadata,
    };
  }

  it('keeps messages from different agents separate through the shared permission queue', async () => {
    const harness = createSessionHarness();
    const { messageQueue } = createPermissionModeQueueState({
      session: harness.session as ApiSessionClient,
      initialPermissionMode: 'default',
    });
    const senders = ['first', 'second'];
    for (const sender of senders) {
      harness.emit({ role: 'user', content: { type: 'text', text: sender }, localId: sender,
        meta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: sender, via: 'mcp' } },
      } as UserMessage);
    }
    for (const sender of senders) {
      const batch = await messageQueue.waitForMessagesAndGetAsString();
      expect(batch?.message.text).toBe(sender);
      expect(batch?.providerPromptMeta).toMatchObject({ happierProvenanceV1: { sourceSessionId: sender } });
    }
  });

  function createHarness() {
    const queueCalls: Array<{
      type: 'push' | 'clear';
      message: PermissionModeQueuedPrompt;
      mode: { permissionMode: PermissionMode; appendSystemPrompt?: string | null };
      providerPromptMeta?: unknown;
    }> = [];
    let currentPermissionMode: PermissionMode | undefined;
    const sessionHarness = createSessionHarness();

    const binding = registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      queue: {
        push: (message: PermissionModeQueuedPrompt, mode: { permissionMode: PermissionMode }, options) =>
          queueCalls.push({ type: 'push', message, mode, providerPromptMeta: options?.providerPromptMeta }),
        unshift: (message: PermissionModeQueuedPrompt, mode: { permissionMode: PermissionMode }, options) =>
          queueCalls.push({ type: 'push', message, mode, providerPromptMeta: options?.providerPromptMeta }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt, mode: { permissionMode: PermissionMode }, options) =>
          queueCalls.push({ type: 'clear', message, mode, providerPromptMeta: options?.providerPromptMeta }),
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
        message: expect.objectContaining({ text: 'hello world', localId: 'local-1' }),
        providerPromptMeta: {},
        mode: { permissionMode: 'default' },
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
        message: {
          text: 'approve this',
          localId: 'local-2',
        },
        providerPromptMeta: { permissionMode: 'acceptEdits' },
        mode: { permissionMode: 'safe-yolo' },
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
        message: {
          text: 'approve this',
          localId: 'local-rebind-1',
        },
        providerPromptMeta: { permissionMode: 'acceptEdits' },
        mode: { permissionMode: 'safe-yolo' },
      },
    ]);
  });

  it('ignores old-session user messages after bindSession swaps to a new client', () => {
    const harness = createHarness();
    const reboundSession = createSessionHarness();

    harness.bindSession(reboundSession.session);

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'stale session message' },
      localId: 'local-stale-1',
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

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
        message: expect.objectContaining({ text: '/clear', localId: 'local-3' }),
        providerPromptMeta: {},
        mode: { permissionMode: 'default' },
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
        message: {
          text: 'hello world',
          localId: 'local-4',
        },
        providerPromptMeta: { appendSystemPrompt: 'Use the latest project conventions.' },
        mode: {
          permissionMode: 'default',
          appendSystemPrompt: 'Use the latest project conventions.',
        },
      },
    ]);
  });
});
