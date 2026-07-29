import { describe, expect, it, vi } from 'vitest';

import * as transcriptSource from './transcriptSource.js';
import {
  readInitialTranscriptSourceWindow,
} from './transcriptSource.js';

describe('transcriptSource helpers', () => {
  it('does not retain callerless hosted-direct replay or handoff helpers', () => {
    expect(transcriptSource).not.toHaveProperty('replayTranscriptSourceHistory');
    expect(transcriptSource).not.toHaveProperty('bridgeTranscriptSourceHandoffGap');
  });

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
});
