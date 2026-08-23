import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { loadDirectSessionTranscriptItems } from './loadDirectSessionTranscriptItems';

describe('loadDirectSessionTranscriptItems', () => {
  it('returns backward transcript pages in chronological order', async () => {
    const newestItem: DirectTranscriptRawMessageV1 = {
      id: 'newest-item',
      localId: 'newest-item',
      createdAtMs: 2,
      messageRole: 'agent',
      raw: { role: 'agent', content: { type: 'text', text: 'newest' } },
    };
    const oldestItem: DirectTranscriptRawMessageV1 = {
      id: 'oldest-item',
      localId: 'oldest-item',
      createdAtMs: 1,
      messageRole: 'user',
      raw: { role: 'user', content: { type: 'text', text: 'oldest' } },
    };
    const readPage = vi.fn()
      .mockResolvedValueOnce({
        items: [newestItem],
        nextCursor: 'older-cursor',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [oldestItem],
        nextCursor: null,
        hasMore: false,
      });

    await expect(loadDirectSessionTranscriptItems({ readPage })).resolves.toEqual([
      oldestItem,
      newestItem,
    ]);
    expect(readPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'older-cursor']);
  });

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

  it('fails observably when transcript discontinuities exhaust the existing page budget', async () => {
    const readPage = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
      truncated: true,
    });

    await expect(loadDirectSessionTranscriptItems({ readPage, maxPages: 2 })).rejects.toThrow();
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it('fails observably when a continuation page omits its cursor', async () => {
    const readPage = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: true,
    });

    await expect(loadDirectSessionTranscriptItems({ readPage })).rejects.toThrow();
    expect(readPage).toHaveBeenCalledTimes(1);
  });
});
