import { describe, expect, it } from 'vitest';
import { decideMessageCatchUpPolicy } from '@/sync/runtime/orchestration/messageCatchUpPolicy';

describe('decideMessageCatchUpPolicy', () => {
    const thresholds = {
        largeGapSeq: 5,
        maxIncrementalPagesOnResume: 2,
        forceSnapshotOfflineMs: 1000,
    };

    it('returns do_nothing when not foreground', () => {
        expect(decideMessageCatchUpPolicy({
            isForeground: false,
            isSessionVisible: true,
            isPinned: true,
            materializedMaxSeq: 10,
            sessionSeqHint: 20,
            offlineForMs: 0,
            thresholds,
        })).toEqual({ kind: 'do_nothing' });
    });

    it('returns do_nothing when session is not visible', () => {
        expect(decideMessageCatchUpPolicy({
            isForeground: true,
            isSessionVisible: false,
            isPinned: true,
            materializedMaxSeq: 10,
            sessionSeqHint: 20,
            offlineForMs: 0,
            thresholds,
        })).toEqual({ kind: 'do_nothing' });
    });

    it('returns do_nothing when there is no gap', () => {
        expect(decideMessageCatchUpPolicy({
            isForeground: true,
            isSessionVisible: true,
            isPinned: true,
            materializedMaxSeq: 20,
            sessionSeqHint: 20,
            offlineForMs: 0,
            thresholds,
        })).toEqual({ kind: 'do_nothing' });
    });

    it('returns tail_reset_latest_page when pinned and gap is large', () => {
        expect(decideMessageCatchUpPolicy({
            isForeground: true,
            isSessionVisible: true,
            isPinned: true,
            materializedMaxSeq: 10,
            sessionSeqHint: 20,
            offlineForMs: 0,
            thresholds,
        })).toEqual({ kind: 'tail_reset_latest_page' });
    });

    it('returns defer_forward_loading when not pinned and gap is large', () => {
        expect(decideMessageCatchUpPolicy({
            isForeground: true,
            isSessionVisible: true,
            isPinned: false,
            materializedMaxSeq: 10,
            sessionSeqHint: 20,
            offlineForMs: 0,
            thresholds,
        })).toEqual({ kind: 'defer_forward_loading' });
    });

    it('returns incremental_batched when gap is small', () => {
        expect(decideMessageCatchUpPolicy({
            isForeground: true,
            isSessionVisible: true,
            isPinned: false,
            materializedMaxSeq: 10,
            sessionSeqHint: 13,
            offlineForMs: 0,
            thresholds,
        })).toEqual({ kind: 'incremental_batched', maxPages: 2 });
    });
});
