import { describe, expect, it, vi } from 'vitest';

import { loadCommittedTranscriptLocalIdBaseline } from './committedTranscriptLocalIdBaseline';

describe('loadCommittedTranscriptLocalIdBaseline', () => {
  it('collects recent session-global local ids and reports a bounded partial window', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          { seq: 9, localId: 'fact-9', createdAt: 900 },
          { seq: 8, localId: 'fact-8', createdAt: 800 },
        ],
        hasMore: true,
        nextBeforeSeq: 8,
        nextAfterSeq: 9,
      })
      .mockResolvedValueOnce({
        messages: [{ seq: 7, localId: 'fact-7', createdAt: 700 }],
        hasMore: true,
        nextBeforeSeq: 7,
        nextAfterSeq: 9,
      });

    await expect(loadCommittedTranscriptLocalIdBaseline({
      take: 3,
      fetchPage,
    })).resolves.toEqual({
      localIds: new Set(['fact-9', 'fact-8', 'fact-7']),
      complete: false,
    });
    expect(fetchPage).toHaveBeenNthCalledWith(2, {
      limit: 1,
      beforeSeq: 8,
    });
  });

  it('reports an incomplete identity baseline when committed history exceeds 5,000 rows', async () => {
    let pageIndex = 0;
    const fetchPage = vi.fn(async () => {
      const offset = pageIndex * 500;
      pageIndex += 1;
      return {
        messages: Array.from({ length: 500 }, (_, index) => ({
          seq: 5_001 - offset - index,
          localId: `fact-${offset + index}`,
        })),
        hasMore: true,
        nextBeforeSeq: 5_001 - pageIndex * 500,
      };
    });

    const result = await loadCommittedTranscriptLocalIdBaseline({ fetchPage });

    expect(result.complete).toBe(false);
    expect(result.localIds.size).toBe(5_000);
    expect(fetchPage).toHaveBeenCalledTimes(10);
  });
});
