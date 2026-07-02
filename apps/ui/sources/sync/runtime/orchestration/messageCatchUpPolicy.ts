export type MessageCatchUpDecision =
    | { kind: 'do_nothing' }
    | { kind: 'incremental_batched'; maxPages: number }
    | { kind: 'tail_reset_latest_page' }
    | { kind: 'defer_forward_loading' };

export type MessageCatchUpThresholds = {
    largeGapSeq: number;
    maxIncrementalPagesOnResume: number;
    forceSnapshotOfflineMs: number;
};

export function decideMessageCatchUpPolicy(input: Readonly<{
    isForeground: boolean;
    isSessionVisible: boolean;
    isPinned: boolean;
    materializedMaxSeq: number;
    sessionSeqHint: number;
    offlineForMs: number;
    hasAcceptedLocalPending?: boolean;
    thresholds: MessageCatchUpThresholds;
}>): MessageCatchUpDecision {
    const thresholds = input.thresholds;

    if (!input.isForeground) {
        return { kind: 'do_nothing' };
    }
    if (!input.isSessionVisible) {
        return { kind: 'do_nothing' };
    }

    const materializedMaxSeq = Math.max(0, Math.trunc(input.materializedMaxSeq));
    const sessionSeqHint = Math.max(0, Math.trunc(input.sessionSeqHint));
    const gapSeq = sessionSeqHint - materializedMaxSeq;

    // If we recently reconnected, the session seq hint can be stale (e.g. when the changes feed
    // does not include message entries for the gap). Force a single incremental page so we
    // still attempt `afterSeq` catch-up once per resume.
    if (gapSeq <= 0 && input.offlineForMs > 0 && materializedMaxSeq > 0) {
        return { kind: 'incremental_batched', maxPages: 1 };
    }

    if (gapSeq <= 0 && input.hasAcceptedLocalPending === true) {
        return { kind: 'incremental_batched', maxPages: 1 };
    }

    if (gapSeq <= 0) {
        return { kind: 'do_nothing' };
    }

    const isLongOffline = input.offlineForMs >= thresholds.forceSnapshotOfflineMs;
    const isLargeGap = gapSeq >= thresholds.largeGapSeq;

    if (isLongOffline || isLargeGap) {
        if (input.isPinned) {
            return { kind: 'tail_reset_latest_page' };
        }
        return { kind: 'defer_forward_loading' };
    }

    return {
        kind: 'incremental_batched',
        maxPages: Math.max(1, Math.trunc(thresholds.maxIncrementalPagesOnResume)),
    };
}
