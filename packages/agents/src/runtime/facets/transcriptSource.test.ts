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
      truncated: false,
    });
    expect(pageOlder).toHaveBeenCalledTimes(1);
    expect(readAfter).toHaveBeenCalledWith({ cursor: 'tail' });
    expect(delivered).toEqual([['older-1'], ['tail-1']]);
  });

  it('preserves an initial-window discontinuity instead of presenting it as authoritative', async () => {
    const result = await readInitialTranscriptSourceWindow({
      pageOlder: async () => ({
        items: [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
        truncated: true,
      }),
      readAfter: async () => ({
        items: [],
        nextCursor: null,
        truncated: false,
      }),
    });

    expect(result.truncated).toBe(true);
  });

  it('does not publish a nonempty initial page when the fallback tail read fails', async () => {
    const onPageItems = vi.fn();
    const onTailItems = vi.fn();

    await expect(readInitialTranscriptSourceWindow({
      pageOlder: async () => ({
        items: ['page-row'],
        nextCursor: 'older-1',
        tailCursor: null,
        hasMore: true,
        truncated: false,
      }),
      readAfter: async () => {
        throw new Error('tail read failed');
      },
      onPageItems,
      onTailItems,
    })).rejects.toThrow('tail read failed');

    expect(onPageItems).not.toHaveBeenCalled();
    expect(onTailItems).not.toHaveBeenCalled();
  });

  it('does not publish a nonempty truncated initial page', async () => {
    const onPageItems = vi.fn();
    const onTailItems = vi.fn();

    const result = await readInitialTranscriptSourceWindow({
      pageOlder: async () => ({
        items: ['truncated-row'],
        nextCursor: 'older-1',
        tailCursor: 'tail-1',
        hasMore: false,
        truncated: true,
      }),
      readAfter: async () => ({
        items: ['unused-tail-row'],
        nextCursor: 'tail-2',
        truncated: false,
      }),
      onPageItems,
      onTailItems,
    });

    expect(result.truncated).toBe(true);
    expect(onPageItems).not.toHaveBeenCalled();
    expect(onTailItems).not.toHaveBeenCalled();
  });

  it('does not publish a truncated catch-up page', async () => {
    const onItems = vi.fn();

    const result = await transcriptSource.catchUpTranscriptSourceWindow({
      cursor: 'cursor-1',
      readAfter: async () => ({
        items: ['catch-up-row'],
        nextCursor: 'cursor-2',
        truncated: true,
      }),
      onItems,
    });

    expect(result).toEqual({ tailCursor: 'cursor-2', truncated: true });
    expect(onItems).not.toHaveBeenCalled();
  });
});
