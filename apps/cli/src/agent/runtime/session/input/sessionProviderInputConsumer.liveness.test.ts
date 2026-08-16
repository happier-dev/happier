import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionProviderInputConsumer } from './sessionProviderInputConsumer';

describe('session provider input consumer liveness', () => {
  it('releases a queued input wait when metadata reconciliation never settles and the session closes', async () => {
    type Mode = { id: string };
    const abortController = new AbortController();
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const metadataStarted = createDeferred<void>();
    const onMetadataUpdate = vi.fn(async () => {
      metadataStarted.resolve();
      await new Promise<void>(() => {});
    });
    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        waitForMetadataUpdate: vi.fn(async () => false),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
      onMetadataUpdate,
      reconcileWhenEmpty: 'skip',
    });

    queue.pushImmediate('queued before close', { id: 'mode' });
    const waiting = consumer.waitForNextInput({ abortSignal: abortController.signal });
    await metadataStarted.promise;
    abortController.abort();

    await expect(Promise.race([
      waiting.then((value) => ({ status: 'settled' as const, value })),
      new Promise<{ status: 'timed_out' }>((resolve) => setTimeout(() => resolve({ status: 'timed_out' }), 25)),
    ])).resolves.toEqual({ status: 'settled', value: null });
    expect(onMetadataUpdate).toHaveBeenCalledTimes(1);
  });
});
