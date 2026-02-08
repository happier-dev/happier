export function computeHasUnreadActivity(params: {
    sessionSeq: number;
    pendingActivityAt: number;
    lastViewedSessionSeq: number | undefined;
    lastViewedPendingActivityAt: number | undefined;
}): boolean {
    const { sessionSeq, lastViewedSessionSeq } = params;

    // Pending queue changes do NOT affect unread state (unread is driven only by committed transcript seq).
    const hasMarker = typeof lastViewedSessionSeq === 'number';
    if (!hasMarker) return sessionSeq > 0;

    const viewedSeq = lastViewedSessionSeq;
    return sessionSeq > viewedSeq;
}
