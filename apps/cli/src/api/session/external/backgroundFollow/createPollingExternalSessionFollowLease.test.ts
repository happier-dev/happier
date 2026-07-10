import { describe, expect, it, vi } from 'vitest';

import { createPollingExternalSessionFollowLease } from './createPollingExternalSessionFollowLease';

describe('createPollingExternalSessionFollowLease', () => {
  it('emits the cursor it read from with transcript updates', async () => {
    const readAfterTranscript = vi.fn()
      .mockResolvedValueOnce({
        items: [],
        nextCursor: 'initial-tail',
        truncated: false,
      })
      .mockResolvedValueOnce({
        items: [{ id: 'msg-1' }],
        nextCursor: 'tail-after-msg-1',
        truncated: false,
      });
    let resolveUpdate: (value: unknown) => void = () => {};
    const updatePromise = new Promise((resolve) => {
      resolveUpdate = resolve;
    });

    const lease = await createPollingExternalSessionFollowLease({
      readAfterTranscript,
      env: {
        HAPPIER_EXTERNAL_SESSIONS_FOLLOW_POLL_MS: '60000',
      },
    });
    const unsubscribe = lease.subscribeToTranscriptUpdates((update) => {
      resolveUpdate(update);
    });

    await expect(updatePromise).resolves.toEqual({
      items: [{ id: 'msg-1' }],
      fromCursor: 'initial-tail',
      nextCursor: 'tail-after-msg-1',
      truncated: false,
    });
    expect(readAfterTranscript).toHaveBeenNthCalledWith(2, {
      cursor: 'initial-tail',
      maxBytes: 512_000,
      maxItems: 200,
    });

    unsubscribe();
    await lease.release();
  });

  it('continues draining immediately after a truncated transcript update advances the cursor', async () => {
    const readAfterTranscript = vi.fn()
      .mockResolvedValueOnce({
        items: [],
        nextCursor: 'cursor-0',
        truncated: false,
      })
      .mockResolvedValueOnce({
        items: [{ id: 'msg-1' }],
        nextCursor: 'cursor-1',
        truncated: true,
      })
      .mockResolvedValueOnce({
        items: [{ id: 'msg-2' }],
        nextCursor: 'cursor-2',
        truncated: false,
      });
    const updates: unknown[] = [];

    const lease = await createPollingExternalSessionFollowLease({
      readAfterTranscript,
      env: {
        HAPPIER_EXTERNAL_SESSIONS_FOLLOW_POLL_MS: '60000',
      },
    });
    const unsubscribe = lease.subscribeToTranscriptUpdates((update) => {
      updates.push(update);
    });

    try {
      await expect.poll(() => updates, { interval: 5, timeout: 100 }).toEqual([
        {
          items: [{ id: 'msg-1' }],
          fromCursor: 'cursor-0',
          nextCursor: 'cursor-1',
          truncated: true,
        },
        {
          items: [{ id: 'msg-2' }],
          fromCursor: 'cursor-1',
          nextCursor: 'cursor-2',
          truncated: false,
        },
      ]);
      expect(readAfterTranscript).toHaveBeenNthCalledWith(3, {
        cursor: 'cursor-1',
        maxBytes: 512_000,
        maxItems: 200,
      });
      expect(readAfterTranscript).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
      await lease.release();
    }
  });
});
