import { describe, expect, it } from 'vitest';

import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';

describe('createPermissionModeQueueState (queue key)', () => {
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
});
