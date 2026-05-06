import { describe, expect, it, vi } from 'vitest';

import type { FileBackedTranscriptSessionStore } from './fileBackedTranscripts/store';
import {
  createSessionTranscriptFollowLeaseRegistry,
  followSessionTranscript,
  importSessionTranscript,
  pageSessionTranscript,
  readSessionTranscriptAfter,
  searchSessionTranscript,
} from './transcriptQueries';

type TestItem = Readonly<{ id: string; text?: string }>;

function createStore(overrides?: Partial<FileBackedTranscriptSessionStore<TestItem>>): FileBackedTranscriptSessionStore<TestItem> {
  return {
    warm: async () => undefined,
    dispose: async () => undefined,
    setLifecycleState: async () => undefined,
    pageOlder: async () => ({ items: [], nextCursor: null, hasMore: false, tailCursor: null, truncated: false }),
    readAfter: async () => ({ items: [], nextCursor: null, truncated: false }),
    getTailCursor: () => null,
    subscribe: () => () => undefined,
    getTitle: async () => null,
    getWorkingDirectory: async () => null,
    getActivity: async () => null,
    getPreview: async () => null,
    ...overrides,
  };
}

describe('session transcript action query helpers', () => {
  it('pages transcript rows through the bounded store cursor API', async () => {
    const pageOlder = vi.fn(async () => ({
      items: [{ id: 'row-1' }],
      nextCursor: 'older-1',
      hasMore: true,
      tailCursor: 'tail-1',
      truncated: false,
    }));
    const store = createStore({ pageOlder });

    await expect(pageSessionTranscript({
      store,
      input: { cursor: 'cursor-1', maxBytes: 4096, maxItems: 25 },
    })).resolves.toEqual({
      ok: true,
      items: [{ id: 'row-1' }],
      nextCursor: 'older-1',
      hasMore: true,
      tailCursor: 'tail-1',
      truncated: false,
    });

    expect(pageOlder).toHaveBeenCalledWith({ cursor: 'cursor-1', maxBytes: 4096, maxItems: 25 });
  });

  it('reads transcript deltas only after a cursor', async () => {
    const readAfter = vi.fn(async () => ({
      items: [{ id: 'row-2' }],
      nextCursor: 'tail-2',
      truncated: false,
    }));
    const store = createStore({ readAfter });

    await expect(readSessionTranscriptAfter({
      store,
      input: { cursor: 'tail-1', maxBytes: 4096, maxItems: 25 },
    })).resolves.toEqual({
      ok: true,
      items: [{ id: 'row-2' }],
      nextCursor: 'tail-2',
      truncated: false,
    });

    expect(readAfter).toHaveBeenCalledWith({ cursor: 'tail-1', maxBytes: 4096, maxItems: 25 });
  });

  it('searches by bounded forward cursor reads without paging the full transcript', async () => {
    const readAfter = vi.fn()
      .mockResolvedValueOnce({
        items: [{ id: 'row-1', text: 'skip' }, { id: 'row-2', text: 'needle found' }],
        nextCursor: 'cursor-2',
        truncated: false,
      })
      .mockResolvedValueOnce({
        items: [{ id: 'row-3', text: 'another needle' }],
        nextCursor: 'cursor-3',
        truncated: false,
      });
    const pageOlder = vi.fn(async () => {
      throw new Error('pageOlder should not be used for search');
    });
    const store = createStore({ readAfter, pageOlder });

    const result = await searchSessionTranscript({
      store,
      input: { query: 'needle', cursor: 'tail', maxItems: 2, maxReads: 4 },
      stringifyItem: (item) => item.text ?? '',
    });

    expect(result).toEqual({
      ok: true,
      items: [{ id: 'row-2', text: 'needle found' }, { id: 'row-3', text: 'another needle' }],
      nextCursor: 'cursor-3',
      truncated: false,
    });
    expect(pageOlder).not.toHaveBeenCalled();
    expect(readAfter).toHaveBeenCalledTimes(2);
  });

  it('imports transcript rows through a caller-provided bounded writer', async () => {
    const writeItems = vi.fn(async () => ({ imported: 1, cursor: 'tail-1' }));

    await expect(importSessionTranscript({
      input: { items: [{ id: 'row-1' }, { id: 'row-2' }], maxItems: 1 },
      writeItems,
    })).resolves.toEqual({ ok: true, imported: 1, cursor: 'tail-1' });

    expect(writeItems).toHaveBeenCalledWith([{ id: 'row-1' }]);
  });
});

describe('session transcript follow leases', () => {
  it('caps retained leases and releases idempotently', async () => {
    const unsubscribes: Array<() => void> = [];
    const store = createStore({
      readAfter: async () => ({ items: [], nextCursor: 'tail', truncated: false }),
      subscribe: (listener) => {
        unsubscribes.push(() => listener?.({ items: [{ id: 'update' }], nextCursor: 'tail-2', truncated: false }));
        return unsubscribes.at(-1)!;
      },
    });
    const registry = createSessionTranscriptFollowLeaseRegistry({ maxLeases: 1, idleTtlMs: 1000 });

    await expect(followSessionTranscript({
      store,
      registry,
      input: { leaseId: 'lease-1', cursor: 'tail' },
    })).resolves.toMatchObject({ ok: true, leaseId: 'lease-1' });
    await expect(followSessionTranscript({
      store,
      registry,
      input: { leaseId: 'lease-2', cursor: 'tail' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'follow_lease_limit_exceeded' });

    await registry.release('lease-1');
    await registry.release('lease-1');
    expect(registry.activeCount()).toBe(0);
  });

  it('expires idle follow leases with a host policy override', async () => {
    vi.useFakeTimers();
    try {
      const unsubscribe = vi.fn();
      const store = createStore({
        readAfter: async () => ({ items: [], nextCursor: 'tail', truncated: false }),
        subscribe: () => unsubscribe,
      });
      const registry = createSessionTranscriptFollowLeaseRegistry({
        maxLeases: 4,
        idleTtlMs: 60_000,
        hostPolicy: { idleTtlMs: 10 },
      });

      await followSessionTranscript({ store, registry, input: { leaseId: 'lease-1', cursor: 'tail' } });
      await vi.advanceTimersByTimeAsync(11);

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(registry.activeCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces active follow updates and delivers the latest queued update', async () => {
    let listener: Parameters<FileBackedTranscriptSessionStore<TestItem>['subscribe']>[0] | null = null;
    let releaseFirstUpdate: (() => void) | null = null;
    const firstUpdateReleased = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const store = createStore({
      readAfter: async () => ({ items: [], nextCursor: 'tail', truncated: false }),
      subscribe: (nextListener) => {
        listener = nextListener;
        return () => undefined;
      },
    });
    const delivered: string[] = [];
    const registry = createSessionTranscriptFollowLeaseRegistry({ maxLeases: 4, idleTtlMs: 1000 });
    const emitUpdate = (update: Parameters<NonNullable<typeof listener>>[0]) => {
      if (!listener) {
        throw new Error('Expected transcript follow listener to be registered');
      }
      listener(update);
    };
    const releaseQueuedUpdate = () => {
      if (!releaseFirstUpdate) {
        throw new Error('Expected first transcript update release callback to be registered');
      }
      releaseFirstUpdate();
    };

    await followSessionTranscript({
      store,
      registry,
      input: { leaseId: 'lease-1', cursor: 'tail' },
      onUpdate: async (update) => {
        const firstItem = update.items[0];
        if (firstItem) {
          delivered.push(firstItem.id);
        }
        if (firstItem?.id === 'first') {
          await firstUpdateReleased;
        }
      },
    });

    emitUpdate({ items: [{ id: 'first' }], nextCursor: 'tail-1', truncated: false });
    await Promise.resolve();
    emitUpdate({ items: [{ id: 'second' }], nextCursor: 'tail-2', truncated: false });
    await Promise.resolve();

    expect(delivered).toEqual(['first']);
    releaseQueuedUpdate();
    await Promise.resolve();
    await Promise.resolve();

    expect(delivered).toEqual(['first', 'second']);
  });
});
