import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { loadDirectSessionTranscriptItems } from './loadDirectSessionTranscriptItems';

describe('loadDirectSessionTranscriptItems', () => {
  it('restarts backward paging when the provider reports a transcript discontinuity', async () => {
    const staleItem: DirectTranscriptRawMessageV1 = {
      id: 'stale-item',
      localId: 'stale-item',
      createdAtMs: 1,
      messageRole: 'user',
      raw: { role: 'user', content: { type: 'text', text: 'stale branch' } },
    };
    const currentItem: DirectTranscriptRawMessageV1 = {
      id: 'current-item',
      localId: 'current-item',
      createdAtMs: 2,
      messageRole: 'user',
      raw: { role: 'user', content: { type: 'text', text: 'current branch' } },
    };
    const readPage = vi.fn()
      .mockResolvedValueOnce({
        items: [staleItem],
        nextCursor: 'stale-older-cursor',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null,
        hasMore: false,
        truncated: true,
      })
      .mockResolvedValueOnce({
        items: [currentItem],
        nextCursor: null,
        hasMore: false,
      })
      .mockRejectedValue(new Error('unexpected fourth transcript page'));

    await expect(loadDirectSessionTranscriptItems({ readPage })).resolves.toEqual([currentItem]);
    expect(readPage.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      'stale-older-cursor',
      undefined,
    ]);
  });
});
