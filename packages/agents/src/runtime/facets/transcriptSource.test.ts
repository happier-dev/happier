import { describe, expect, it, vi } from 'vitest';

import {
  bridgeTranscriptSourceHandoffGap,
  readInitialTranscriptSourceWindow,
  replayTranscriptSourceHistory,
} from './transcriptSource.js';

describe('transcriptSource helpers', () => {
  it('reads the initial transcript window and falls back to tail read when the page omits a tail cursor', async () => {
    const pageOlder = vi.fn(async () => ({
      items: ['older-1'],
      nextCursor: 'older-cursor-1',
      tailCursor: null,
      hasMore: true,
      truncated: false,
    }));
    const readAfter = vi.fn(async ({ cursor }: { cursor: string }) => ({
      items: cursor === 'tail' ? ['tail-1'] : [],
      nextCursor: 'tail-cursor-1',
      truncated: false,
    }));
    const delivered: string[][] = [];

    const result = await readInitialTranscriptSourceWindow({
      pageOlder,
      readAfter,
      onPageItems: async (page) => {
        delivered.push([...page.items]);
      },
      onTailItems: async (page) => {
        delivered.push([...page.items]);
      },
    });

    expect(result).toEqual({
      olderCursor: 'older-cursor-1',
      hasMoreOlder: true,
      tailCursor: 'tail-cursor-1',
    });
    expect(pageOlder).toHaveBeenCalledTimes(1);
    expect(readAfter).toHaveBeenCalledWith({ cursor: 'tail' });
    expect(delivered).toEqual([['older-1'], ['tail-1']]);
  });

  it('replays transcript history oldest-first and returns the discovered tail cursor', async () => {
    const pageOlder = vi.fn()
      .mockResolvedValueOnce({
        items: ['latest-1'],
        nextCursor: 'older-cursor-1',
        tailCursor: 'tail-cursor-1',
        hasMore: true,
        truncated: false,
      })
      .mockResolvedValueOnce({
        items: ['oldest-1'],
        nextCursor: null,
        tailCursor: 'tail-cursor-1',
        hasMore: false,
        truncated: false,
      });
    const delivered: string[][] = [];

    const result = await replayTranscriptSourceHistory({
      pageOlder,
      onItems: async (items) => {
        delivered.push([...items]);
      },
    });

    expect(result).toEqual({ tailCursor: 'tail-cursor-1' });
    expect(delivered).toEqual([['oldest-1'], ['latest-1']]);
  });

  it('bridges the handoff gap until the follow lease tail cursor is reached', async () => {
    const readAfter = vi.fn()
      .mockResolvedValueOnce({
        items: ['gap-1'],
        nextCursor: 'cursor-2',
        truncated: false,
      })
      .mockResolvedValueOnce({
        items: ['gap-2'],
        nextCursor: 'cursor-3',
        truncated: false,
      });
    const delivered: string[][] = [];

    await bridgeTranscriptSourceHandoffGap({
      fromCursor: 'cursor-1',
      toCursor: 'cursor-3',
      readAfter,
      onItems: async (items) => {
        delivered.push([...items]);
      },
    });

    expect(readAfter).toHaveBeenNthCalledWith(1, { cursor: 'cursor-1' });
    expect(readAfter).toHaveBeenNthCalledWith(2, { cursor: 'cursor-2' });
    expect(delivered).toEqual([['gap-1'], ['gap-2']]);
  });
});
