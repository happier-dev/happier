import { describe, expect, it } from 'vitest';

import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';

describe('createPermissionModeQueueState (queue key)', () => {
  it('allows callers to override restart batching via a queue key resolver', async () => {
    const session = {
      onUserMessage: () => undefined,
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => ({}),
    };

    const { messageQueue } = createPermissionModeQueueState({
      session: session as any,
      initialPermissionMode: 'default' as any,
      // Treat all modes as equivalent for queue batching/restart purposes.
      resolvePermissionModeQueueKey: () => 'same',
    } as any);

    messageQueue.push('one', { permissionMode: 'default' as any });
    messageQueue.push('two', { permissionMode: 'yolo' as any });

    const batch = await messageQueue.waitForMessagesAndGetAsString();
    expect(batch?.message).toBe('one\ntwo');
  });
});

