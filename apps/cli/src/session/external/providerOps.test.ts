import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExternalSessionTranscriptProviderOps } from './providerOps';

describe('createExternalSessionTranscriptProviderOps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes transcript page and follow-lease payloads from provider leaf callbacks', async () => {
    const release = vi.fn(async () => {});
    const subscribe = vi.fn((listener: (update: Readonly<{
      items: string[];
      nextCursor: string | null;
      truncated: boolean;
    }>) => void | Promise<void>) => {
      void listener({
        items: ['follow-1'],
        nextCursor: 'tail-cursor-2',
        truncated: false,
      });
      return () => {};
    });

    const ops = createExternalSessionTranscriptProviderOps<string>({
      pageOlder: async () => ({
        items: ['older-1'],
        nextCursor: 'older-cursor-1',
        tailCursor: 'tail-cursor-1',
        hasMore: true,
        truncated: false,
      }),
      readAfter: async () => ({
        items: ['tail-1'],
        nextCursor: 'tail-cursor-2',
        truncated: false,
      }),
      acquireFollowLease: async () => ({
        release,
        getTailCursor: () => 'tail-cursor-1',
        subscribeToTranscriptUpdates: subscribe,
      }),
    });

    const page = await ops.pageTranscript({
      source: { kind: 'codexHome', home: 'user' },
      remoteSessionId: 'remote-1',
      direction: 'older',
      cursor: undefined,
      maxBytes: 1024,
      maxItems: 50,
    });
    const readAfter = await ops.readAfterTranscript({
      source: { kind: 'codexHome', home: 'user' },
      remoteSessionId: 'remote-1',
      cursor: 'tail',
      maxBytes: 1024,
      maxItems: 50,
    });
    const followLease = await ops.acquireFollowLease?.({
      source: { kind: 'codexHome', home: 'user' },
      remoteSessionId: 'remote-1',
      reason: 'attached_view',
    });
    const delivered: string[][] = [];
    const unsubscribe = followLease?.subscribeToTranscriptUpdates?.((update) => {
      delivered.push([...update.items]);
    });

    expect(page).toEqual({
      items: ['older-1'],
      nextCursor: 'older-cursor-1',
      tailCursor: 'tail-cursor-1',
      hasMore: true,
      truncated: false,
    });
    expect(readAfter).toEqual({
      items: ['tail-1'],
      nextCursor: 'tail-cursor-2',
      truncated: false,
    });
    expect(followLease?.getTailCursor?.()).toBe('tail-cursor-1');
    expect(delivered).toEqual([['follow-1']]);
    unsubscribe?.();
    await followLease?.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('creates a polling follow lease from readAfter when no native follow lease is supplied', async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const readAfter = vi.fn(async ({ cursor }: { cursor: string }) => {
      if (cursor === 'tail') {
        return {
          items: [],
          nextCursor: 'cursor-tail',
          truncated: false,
        };
      }
      pollCount += 1;
      if (pollCount === 1) {
        return {
          items: [],
          nextCursor: 'cursor-tail',
          truncated: false,
        };
      }
      return {
        items: ['newer-1'],
        nextCursor: 'cursor-newer-1',
        truncated: false,
      };
    });

    const ops = createExternalSessionTranscriptProviderOps<string>({
      pageOlder: async () => ({
        items: [],
        nextCursor: null,
        tailCursor: 'cursor-tail',
        hasMore: false,
        truncated: false,
      }),
      readAfter,
    });

    const lease = await ops.acquireFollowLease?.({
      source: { kind: 'codexHome', home: 'user' },
      remoteSessionId: 'remote-1',
      reason: 'attached_view',
    });

    expect(lease).toBeDefined();
    expect(lease?.getTailCursor?.()).toBe('cursor-tail');

    const delivered: string[][] = [];
    lease?.subscribeToTranscriptUpdates?.((update) => {
      delivered.push([...update.items]);
    });

    await vi.advanceTimersByTimeAsync(250);

    expect(readAfter).toHaveBeenCalledWith(expect.objectContaining({
      cursor: 'cursor-tail',
      maxBytes: expect.any(Number),
      maxItems: expect.any(Number),
    }));
    expect(delivered).toEqual([['newer-1']]);

    await lease?.release();
  });
});
