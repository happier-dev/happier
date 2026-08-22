import { describe, expect, it } from 'vitest';

import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';

describe('createPermissionModeQueueState (queue key)', () => {
  it('partitions admitted inputs with different immutable permission ceilings', async () => {
    type QueuedTestMessage = {
      role: 'user';
      content: { type: 'text'; text: string };
      localId: string;
      meta: Record<string, unknown>;
    };
    type QueuedTestMessageHandler = (message: QueuedTestMessage) => void;

    let handler: QueuedTestMessageHandler | null = null;
    const session = {
      onUserMessage: (next: QueuedTestMessageHandler) => {
        handler = next;
      },
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };
    const state = createPermissionModeQueueState({
      session: session as any,
      agentTargetKey: 'agent.test',
      initialPermissionMode: 'default' as any,
    });
    const emit = handler ?? ((_message: QueuedTestMessage) => {
      throw new Error('expected user message handler');
    });

    emit({
      role: 'user',
      content: { type: 'text', text: 'first' },
      localId: 'authority-first',
      meta: {
        happierInputAuthorityV1: {
          v: 1,
          producer: 'cli',
          caller: { kind: 'host' },
          permission: { admittedPermissionCeiling: 'default' },
        },
      },
    });
    emit({
      role: 'user',
      content: { type: 'text', text: 'second' },
      localId: 'authority-second',
      meta: {
        happierInputAuthorityV1: {
          v: 1,
          producer: 'cli',
          caller: { kind: 'host' },
          permission: { admittedPermissionCeiling: 'read-only' },
        },
      },
    });

    const first = await state.messageQueue.waitForMessagesAndGetAsString();
    const second = await state.messageQueue.waitForMessagesAndGetAsString();

    expect(first?.message).toMatchObject({
      text: 'first',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'default',
      },
    });
    expect(second?.message).toMatchObject({
      text: 'second',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'read-only',
      },
    });
  });

  it('rebinds user-message delivery when the session client swaps', async () => {
    type QueuedTestMessage = {
      role: 'user';
      content: { type: 'text'; text: string };
      localId: string;
      meta: Record<string, never>;
    };
    type QueuedTestMessageHandler = (message: QueuedTestMessage) => void;

    let secondSessionHandler: QueuedTestMessageHandler | null = null;

    const firstSession = {
      onUserMessage: (_handler: QueuedTestMessageHandler) => undefined,
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };
    const secondSession = {
      onUserMessage: (handler: QueuedTestMessageHandler) => {
        secondSessionHandler = handler;
      },
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };

    const state = createPermissionModeQueueState({
      session: firstSession as any,
      initialPermissionMode: 'default' as any,
    } as any);

    state.rebindSession(secondSession as any);

    expect(secondSessionHandler).toBeTypeOf('function');
    const reboundHandler: QueuedTestMessageHandler =
      secondSessionHandler ??
      ((_message: QueuedTestMessage) => {
        throw new Error('expected rebound session handler to be registered');
      });
    reboundHandler({
      role: 'user',
      content: { type: 'text', text: 'swapped session prompt' },
      localId: 'local-swap-1',
      meta: {},
    });

    const batch = await state.messageQueue.waitForMessagesAndGetAsString();
    expect(batch?.message.text).toBe('swapped session prompt');
  });

  it('does not release an active binding identity for a stale session', () => {
    type QueuedTestMessage = {
      role: 'user';
      content: { type: 'text'; text: string };
      localId: string;
      meta: Record<string, never>;
    };
    type QueuedTestMessageHandler = (message: QueuedTestMessage) => void;

    let activeSessionHandler: QueuedTestMessageHandler | null = null;
    const activeSession = {
      onUserMessage: (handler: QueuedTestMessageHandler) => {
        activeSessionHandler = handler;
      },
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };
    const staleSession = {
      onUserMessage: (_handler: QueuedTestMessageHandler) => undefined,
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };
    const state = createPermissionModeQueueState({
      session: activeSession as any,
      agentTargetKey: 'agent.test',
      initialPermissionMode: 'default' as any,
    });
    const emit = activeSessionHandler ?? ((_message: QueuedTestMessage) => {
      throw new Error('expected active user message handler');
    });
    const message: QueuedTestMessage = {
      role: 'user',
      content: { type: 'text', text: 'retry only after current-session custody retirement' },
      localId: 'stale-session-retry',
      meta: {},
    };
    const queuedPrompt = {
      text: message.content.text,
      localId: message.localId,
      localIds: [message.localId],
    };

    emit(message);
    expect(state.messageQueue.queue).toHaveLength(1);

    state.releaseRejectedBeforeProviderPromptIdentity(staleSession as any, queuedPrompt);
    emit(message);
    expect(state.messageQueue.queue).toHaveLength(1);

    state.releaseRejectedBeforeProviderPromptIdentity(activeSession as any, queuedPrompt);
    emit(message);
    expect(state.messageQueue.queue).toHaveLength(2);
  });

  it('preserves each structured input as an isolated queued delivery without clearing peers', async () => {
    type QueuedTestMessage = {
      role: 'user';
      content: { type: 'text'; text: string };
      localId: string;
      meta: Record<string, unknown>;
    };
    type QueuedTestMessageHandler = (message: QueuedTestMessage) => void;

    let handler: QueuedTestMessageHandler | null = null;
    const session = {
      onUserMessage: (next: QueuedTestMessageHandler) => {
        handler = next;
      },
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };
    const state = createPermissionModeQueueState({
      session: session as any,
      agentTargetKey: 'agent.test',
      initialPermissionMode: 'default' as any,
    });
    const emit = handler ?? ((_message: QueuedTestMessage) => {
      throw new Error('expected user message handler');
    });

    emit({
      role: 'user',
      content: { type: 'text', text: 'first structured input' },
      localId: 'structured-first',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          skillMentions: [{ name: 'first', path: '/skills/first/SKILL.md' }],
        },
      },
    });
    emit({
      role: 'user',
      content: { type: 'text', text: 'second structured input' },
      localId: 'structured-second',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          skillMentions: [{ name: 'second', path: '/skills/second/SKILL.md' }],
        },
      },
    });

    expect(state.messageQueue.queue).toHaveLength(2);
    expect(state.messageQueue.queue.map((item) => item.isolate)).toEqual([true, true]);

    const first = await state.messageQueue.waitForMessagesAndGetAsString();
    const second = await state.messageQueue.waitForMessagesAndGetAsString();

    expect(first?.message).toMatchObject({
      text: 'first structured input',
      localId: 'structured-first',
      structuredInput: {
        skillMentions: [{ name: 'first' }],
      },
    });
    expect(second?.message).toMatchObject({
      text: 'second structured input',
      localId: 'structured-second',
      structuredInput: {
        skillMentions: [{ name: 'second' }],
      },
    });
  });
});
