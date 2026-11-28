import { describe, expect, it, vi } from 'vitest';
import { SESSION_MESSAGES_PAGE_SIZE } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { applyMessageCatchUpDecision } from '@/sync/runtime/orchestration/applyMessageCatchUpDecision';
import { decideMessageCatchUpPolicy } from '@/sync/runtime/orchestration/messageCatchUpPolicy';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';

// C6/D2b: the catch-up executor is non-destructive. `tail_reset_latest_page` (and the
// incremental-exhausted fallback) now FETCH-then-MERGE the latest page on top of existing
// history via applyMessages' seq-merge, instead of wiping the transcript first. There is no
// destructive reset hook in this executor; a full reset is reserved for proven-discontinuity
// callers (truncated tail / server purge-rewrite) outside this module.

describe('applyMessageCatchUpDecision', () => {
    it('uses one latest page when a long disconnect leaves a pinned session with a stale hint', async () => {
        const tuning = loadSyncTuning();
        const cursor = 2_000;
        const requests: Array<{ afterSeq?: number }> = [];
        const decision = decideMessageCatchUpPolicy({
            isForeground: true,
            isSessionVisible: true,
            isPinned: true,
            materializedMaxSeq: cursor,
            sessionSeqHint: cursor + 1,
            offlineForMs: tuning.messageForceSnapshotOfflineMs + 1,
            thresholds: {
                largeGapSeq: tuning.messageLargeGapSeq,
                maxIncrementalPagesOnResume: tuning.messageMaxIncrementalPagesOnResume,
                forceSnapshotOfflineMs: tuning.messageForceSnapshotOfflineMs,
            },
        });

        await applyMessageCatchUpDecision({
            decision,
            afterSeq: cursor,
            onIncrementalExhausted: () => 'tail_reset_latest_page',
            fetchNewerPage: async (afterSeq) => {
                requests.push({ afterSeq });
                // The durable gap extends beyond the forward budget despite the small hint.
                return { messagesCount: SESSION_MESSAGES_PAGE_SIZE, nextAfterSeq: afterSeq + SESSION_MESSAGES_PAGE_SIZE };
            },
            fetchSnapshotLatestPage: async () => { requests.push({}); },
            markLoaded: () => {},
            setDeferredForwardLoading: () => {},
        });

        expect(requests).toEqual([{}]);
    });

    it.each(['snapshot', 'incremental'] as const)('retains failed %s catch-up demand when the session hint is stale', async (kind) => {
        let deferred = true;
        let loaded = false;
        const failure = new Error('Message transport unavailable');
        await expect(applyMessageCatchUpDecision({
            decision: kind === 'snapshot'
                ? { kind: 'tail_reset_latest_page' }
                : { kind: 'incremental_batched', maxPages: 1 },
            afterSeq: 10,
            onIncrementalExhausted: () => 'tail_reset_latest_page',
            fetchNewerPage: async () => { throw failure; },
            fetchSnapshotLatestPage: async () => { throw failure; },
            markLoaded: () => { loaded = true; },
            setDeferredForwardLoading: (value) => { deferred = value; },
        })).rejects.toBe(failure);

        expect(loaded).toBe(false);
        expect(decideMessageCatchUpPolicy({
            isForeground: true,
            isSessionVisible: true,
            isPinned: true,
            materializedMaxSeq: 10,
            sessionSeqHint: 10,
            offlineForMs: 0,
            hasDeferredNewer: deferred,
            thresholds: { largeGapSeq: 500, maxIncrementalPagesOnResume: 3, forceSnapshotOfflineMs: 30 * 60_000 },
        }).kind).toBe('tail_reset_latest_page');
    });

    it.each([true, false])('uses current reading intent after an in-flight page changes pinned=%s', async (initiallyPinned) => {
        let pinned = initiallyPinned;
        let deferred = false;
        let snapshots = 0;
        await applyMessageCatchUpDecision({
            decision: { kind: 'incremental_batched', maxPages: 1 },
            afterSeq: 10,
            onIncrementalExhausted: () => pinned ? 'tail_reset_latest_page' : 'defer_forward_loading',
            fetchNewerPage: async () => {
                pinned = !initiallyPinned;
                return { messagesCount: 150, nextAfterSeq: 160 };
            },
            fetchSnapshotLatestPage: async () => { snapshots += 1; },
            markLoaded: () => {},
            setDeferredForwardLoading: (value) => { deferred = value; },
        });
        expect(snapshots).toBe(initiallyPinned ? 0 : 1);
        expect(deferred).toBe(initiallyPinned);
    });
    it('tails reset by fetching and merging the snapshot without wiping existing history', async () => {
        const fetchSnapshotLatestPage = vi.fn(async () => {});
        const markLoaded = vi.fn();
        const setDeferredForwardLoading = vi.fn();

        await applyMessageCatchUpDecision({
            decision: { kind: 'tail_reset_latest_page' },
            afterSeq: 10,
            onIncrementalExhausted: () => 'defer_forward_loading',
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
            onIncrementalExhausted: () => 'tail_reset_latest_page',
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
            onIncrementalExhausted: () => 'tail_reset_latest_page',
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
            onIncrementalExhausted: () => 'tail_reset_latest_page',
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
            onIncrementalExhausted: () => 'defer_forward_loading',
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
