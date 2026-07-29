import { describe, expect, it, vi } from 'vitest';
import { applyMessageCatchUpDecision } from '@/sync/runtime/orchestration/applyMessageCatchUpDecision';

// C6/D2b: the catch-up executor is non-destructive. `tail_reset_latest_page` (and the
// incremental-exhausted fallback) now FETCH-then-MERGE the latest page on top of existing
// history via applyMessages' seq-merge, instead of wiping the transcript first. There is no
// destructive reset hook in this executor; a full reset is reserved for proven-discontinuity
// callers (truncated tail / server purge-rewrite) outside this module.

describe('applyMessageCatchUpDecision', () => {
    it('tails reset by fetching and merging the snapshot without wiping existing history', async () => {
        const fetchSnapshotLatestPage = vi.fn(async () => {});
        const markLoaded = vi.fn();
        const setDeferredForwardLoading = vi.fn();

        await applyMessageCatchUpDecision({
            decision: { kind: 'tail_reset_latest_page' },
            afterSeq: 10,
            onIncrementalExhausted: 'defer_forward_loading',
            fetchNewerPage: vi.fn(),
            fetchSnapshotLatestPage,
            markLoaded,
            setDeferredForwardLoading,
        });

        expect(fetchSnapshotLatestPage).toHaveBeenCalledTimes(1);
        expect(setDeferredForwardLoading).toHaveBeenCalledWith(false);
        expect(markLoaded).toHaveBeenCalledTimes(1);
    });

    it('defers forward loading without fetching', async () => {
        const fetchNewerPage = vi.fn();
        const fetchSnapshotLatestPage = vi.fn(async () => {});
        const markLoaded = vi.fn();
        const setDeferredForwardLoading = vi.fn();

        await applyMessageCatchUpDecision({
            decision: { kind: 'defer_forward_loading' },
            afterSeq: 10,
            onIncrementalExhausted: 'tail_reset_latest_page',
            fetchNewerPage,
            fetchSnapshotLatestPage,
            markLoaded,
            setDeferredForwardLoading,
        });

        expect(setDeferredForwardLoading).toHaveBeenCalledWith(true);
        expect(fetchNewerPage).not.toHaveBeenCalled();
        expect(fetchSnapshotLatestPage).not.toHaveBeenCalled();
        expect(markLoaded).not.toHaveBeenCalled();
    });

    it('fetches newer pages up to maxPages and stops when caught up', async () => {
        const fetchNewerPage = vi.fn()
            .mockResolvedValueOnce({ messagesCount: 150, nextAfterSeq: 30 })
            .mockResolvedValueOnce({ messagesCount: 20, nextAfterSeq: null });
        const fetchSnapshotLatestPage = vi.fn(async () => {});
        const markLoaded = vi.fn();
        const setDeferredForwardLoading = vi.fn();

        await applyMessageCatchUpDecision({
            decision: { kind: 'incremental_batched', maxPages: 3 },
            afterSeq: 10,
            onIncrementalExhausted: 'tail_reset_latest_page',
            fetchNewerPage,
            fetchSnapshotLatestPage,
            markLoaded,
            setDeferredForwardLoading,
        });

        expect(fetchNewerPage).toHaveBeenCalledTimes(2);
        expect(fetchSnapshotLatestPage).not.toHaveBeenCalled();
        expect(setDeferredForwardLoading).toHaveBeenCalledWith(false);
        expect(markLoaded).toHaveBeenCalledTimes(1);
    });

    it('fetches and merges the snapshot when incremental is exhausted (configured), without wiping history', async () => {
        const fetchNewerPage = vi.fn()
            .mockResolvedValueOnce({ messagesCount: 150, nextAfterSeq: 30 })
            .mockResolvedValueOnce({ messagesCount: 150, nextAfterSeq: 60 });
        const fetchSnapshotLatestPage = vi.fn(async () => {});
        const markLoaded = vi.fn();
        const setDeferredForwardLoading = vi.fn();

        await applyMessageCatchUpDecision({
            decision: { kind: 'incremental_batched', maxPages: 2 },
            afterSeq: 10,
            onIncrementalExhausted: 'tail_reset_latest_page',
            fetchNewerPage,
            fetchSnapshotLatestPage,
            markLoaded,
            setDeferredForwardLoading,
        });

        expect(fetchNewerPage).toHaveBeenCalledTimes(2);
        expect(fetchSnapshotLatestPage).toHaveBeenCalledTimes(1);
        expect(markLoaded).toHaveBeenCalledTimes(1);
    });

    it('defers forward loading when incremental is exhausted and more pages remain (configured)', async () => {
        const fetchNewerPage = vi.fn()
            .mockResolvedValueOnce({ messagesCount: 150, nextAfterSeq: 30 })
            .mockResolvedValueOnce({ messagesCount: 150, nextAfterSeq: 60 });
        const fetchSnapshotLatestPage = vi.fn(async () => {});
        const markLoaded = vi.fn();
        const setDeferredForwardLoading = vi.fn();

        await applyMessageCatchUpDecision({
            decision: { kind: 'incremental_batched', maxPages: 2 },
            afterSeq: 10,
            onIncrementalExhausted: 'defer_forward_loading',
            fetchNewerPage,
            fetchSnapshotLatestPage,
            markLoaded,
            setDeferredForwardLoading,
        });

        expect(fetchNewerPage).toHaveBeenCalledTimes(2);
        expect(setDeferredForwardLoading).toHaveBeenCalledWith(false);
        expect(setDeferredForwardLoading).toHaveBeenCalledWith(true);
        expect(fetchSnapshotLatestPage).not.toHaveBeenCalled();
    });
});
