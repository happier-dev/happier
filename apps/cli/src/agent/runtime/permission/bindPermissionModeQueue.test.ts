import { describe, expect, it } from 'vitest';

import type { Metadata, PermissionMode, UserMessage } from '@/api/types';
import { registerPermissionModeMessageQueueBinding } from './bindPermissionModeQueue';

describe('registerPermissionModeMessageQueueBinding', () => {
  function createHarness() {
    let userMessageHandler: ((message: UserMessage) => void) | null = null;
    const queueCalls: Array<{ type: 'push' | 'clear'; message: string; mode: { permissionMode: PermissionMode } }> = [];
    let currentPermissionMode: PermissionMode | undefined;
    let metadata = { permissionMode: 'default', permissionModeUpdatedAt: 0 } as unknown as Metadata;

    const session = {
      onUserMessage: (handler: (message: UserMessage) => void) => {
        userMessageHandler = handler;
      },
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        metadata = updater(metadata);
      },
    };

    registerPermissionModeMessageQueueBinding({
      session,
      queue: {
        push: (message: string, mode: { permissionMode: PermissionMode }) =>
          queueCalls.push({ type: 'push', message, mode }),
        pushIsolateAndClear: (message: string, mode: { permissionMode: PermissionMode }) =>
          queueCalls.push({ type: 'clear', message, mode }),
      },
      getCurrentPermissionMode: () => currentPermissionMode,
      setCurrentPermissionMode: (mode: PermissionMode | undefined) => {
        currentPermissionMode = mode;
      },
    });

    return {
      emit: (message: UserMessage) => {
        if (!userMessageHandler) throw new Error('missing onUserMessage handler');
        userMessageHandler(message);
      },
      getCurrentPermissionMode: () => currentPermissionMode,
      getMetadata: () => metadata,
      queueCalls,
    };
  }

  it('queues regular messages with the current permission mode', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'hello world' },
      meta: {},
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: 'hello world',
        mode: { permissionMode: 'default' },
      },
    ]);
  });

  it('updates permission mode from message metadata before queueing', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'approve this' },
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

    expect(harness.getCurrentPermissionMode()).toBe('safe-yolo');
    expect(harness.getMetadata().permissionMode).toBe('safe-yolo');
    expect(harness.getMetadata().permissionModeUpdatedAt).toBe(42);
    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: 'approve this',
        mode: { permissionMode: 'safe-yolo' },
      },
    ]);
  });

  it('routes clear commands through isolate-and-clear queue path', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: '/clear' },
      meta: {},
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'clear',
        message: '/clear',
        mode: { permissionMode: 'default' },
      },
    ]);
  });
});
