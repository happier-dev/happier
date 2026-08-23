import { describe, expect, it, vi } from 'vitest';

import * as transcriptSource from './transcriptSource.js';
import {
  followTranscriptSourceWithFiniteActions,
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

  it('drains finite follow reads before the inactive final drain', async () => {
    const follow = vi.fn()
      .mockResolvedValueOnce({ items: ['first'], nextCursor: 'cursor-1', truncated: true })
      .mockResolvedValueOnce({ items: ['second'], nextCursor: 'cursor-2', truncated: false })
      .mockResolvedValueOnce({ items: [], nextCursor: 'cursor-2', truncated: false })
      .mockResolvedValueOnce({ items: ['final'], nextCursor: 'cursor-3', truncated: false })
      .mockResolvedValueOnce({ items: [], nextCursor: 'cursor-3', truncated: false });
    const isSessionActive = vi.fn(async () => false);
    const onItems = vi.fn();
    const waitForNextPoll = vi.fn();
    const release = vi.fn(async () => undefined);

    const result = await followTranscriptSourceWithFiniteActions({
      initialCursor: 'tail',
      leaseId: 'lease-1',
      follow,
      isSessionActive,
      waitForNextPoll,
      onItems,
      release,
    });

    expect(result).toEqual({ tailCursor: 'cursor-3', stopped: 'inactive' });
    expect(follow).toHaveBeenNthCalledWith(1, { cursor: 'tail', leaseId: 'lease-1' });
    expect(follow).toHaveBeenNthCalledWith(2, { cursor: 'cursor-1', leaseId: 'lease-1' });
    expect(follow).toHaveBeenNthCalledWith(3, { cursor: 'cursor-2', leaseId: 'lease-1' });
    expect(follow).toHaveBeenNthCalledWith(4, { cursor: 'cursor-2', leaseId: 'lease-1' });
    expect(follow).toHaveBeenNthCalledWith(5, { cursor: 'cursor-3', leaseId: 'lease-1' });
    expect(isSessionActive).toHaveBeenCalledTimes(1);
    expect(waitForNextPoll).not.toHaveBeenCalled();
    expect(onItems).toHaveBeenNthCalledWith(1, { items: ['first'], nextCursor: 'cursor-1' });
    expect(onItems).toHaveBeenNthCalledWith(2, { items: ['second'], nextCursor: 'cursor-2' });
    expect(onItems).toHaveBeenNthCalledWith(3, { items: ['final'], nextCursor: 'cursor-3' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ leaseId: 'lease-1' });
  });

  it('drains truncated and nonempty terminal pages before stopping inactive', async () => {
    const follow = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: 'cursor-0', truncated: false })
      .mockResolvedValueOnce({ items: ['final-first'], nextCursor: 'cursor-1', truncated: true })
      .mockResolvedValueOnce({ items: ['final-second'], nextCursor: 'cursor-2', truncated: false })
      .mockResolvedValueOnce({ items: [], nextCursor: 'cursor-2', truncated: false });
    const onItems = vi.fn();
    const release = vi.fn(async () => undefined);

    const result = await followTranscriptSourceWithFiniteActions({
      initialCursor: 'tail',
      leaseId: 'lease-1',
      follow,
      isSessionActive: async () => false,
      waitForNextPoll: async () => undefined,
      onItems,
      release,
    });

    expect(result).toEqual({ tailCursor: 'cursor-2', stopped: 'inactive' });
    expect(follow).toHaveBeenNthCalledWith(1, { cursor: 'tail', leaseId: 'lease-1' });
    expect(follow).toHaveBeenNthCalledWith(2, { cursor: 'cursor-0', leaseId: 'lease-1' });
    expect(follow).toHaveBeenNthCalledWith(3, { cursor: 'cursor-1', leaseId: 'lease-1' });
    expect(follow).toHaveBeenNthCalledWith(4, { cursor: 'cursor-2', leaseId: 'lease-1' });
    expect(onItems).toHaveBeenNthCalledWith(1, { items: ['final-first'], nextCursor: 'cursor-1' });
    expect(onItems).toHaveBeenNthCalledWith(2, { items: ['final-second'], nextCursor: 'cursor-2' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('stops after an active poll wait when the caller aborts', async () => {
    let continuing = true;
    const follow = vi.fn(async () => ({ items: [], nextCursor: 'cursor-1', truncated: false }));
    const waitForNextPoll = vi.fn(async () => {
      continuing = false;
    });
    const release = vi.fn(async () => undefined);

    const result = await followTranscriptSourceWithFiniteActions({
      initialCursor: 'tail',
      leaseId: 'lease-1',
      follow,
      isSessionActive: async () => true,
      waitForNextPoll,
      shouldContinue: () => continuing,
      release,
    });

    expect(result).toEqual({ tailCursor: 'cursor-1', stopped: 'aborted' });
    expect(waitForNextPoll).toHaveBeenCalledTimes(1);
    expect(follow).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ leaseId: 'lease-1' });
  });

  it('releases the finite follow lease when a follow Action fails', async () => {
    const release = vi.fn(async () => undefined);

    await expect(followTranscriptSourceWithFiniteActions({
      initialCursor: 'tail',
      leaseId: 'lease-1',
      follow: async () => {
        throw new Error('follow failed');
      },
      isSessionActive: async () => true,
      waitForNextPoll: async () => undefined,
      release,
    })).rejects.toThrow('follow failed');

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ leaseId: 'lease-1' });
  });
});
