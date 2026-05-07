export type ReadStateV1 = {
    v: 1;
    sessionSeq: number;
    pendingActivityAt: number;
    updatedAt: number;
};

export function computeNextReadStateV1(params: {
    prev: ReadStateV1 | undefined;
    sessionSeq: number;
    pendingActivityAt: number;
    now: number;
}): { didChange: boolean; next: ReadStateV1 } {
    const sessionSeq = params.sessionSeq ?? 0;
    const pendingActivityAt = params.pendingActivityAt ?? 0;

    const prev = params.prev;
    if (!prev) {
        return {
            didChange: true,
            next: { v: 1, sessionSeq, pendingActivityAt, updatedAt: params.now },
        };
    }

    const needsSeqRepair = prev.sessionSeq > sessionSeq;
    const nextSessionSeq = needsSeqRepair
        ? sessionSeq
        : Math.max(prev.sessionSeq, sessionSeq);

    const nextPendingActivityAt = Math.max(prev.pendingActivityAt, pendingActivityAt);

    if (!needsSeqRepair && nextSessionSeq === prev.sessionSeq && nextPendingActivityAt === prev.pendingActivityAt) {
        return { didChange: false, next: prev };
    }

    return {
        didChange: true,
        next: {
            v: 1,
            sessionSeq: nextSessionSeq,
            pendingActivityAt: nextPendingActivityAt,
            updatedAt: params.now,
        },
    };
}

export function computeManualUnreadReadStateV1(params: {
    prev: ReadStateV1 | undefined;
    sessionSeq: number;
    lastViewedSessionSeq: number | null | undefined;
    now: number;
}): { didChange: boolean; next: ReadStateV1 | undefined } {
    const prev = params.prev;
    if (!prev) {
        return { didChange: false, next: undefined };
    }

    const sessionSeq = Math.max(0, Math.trunc(params.sessionSeq));
    const serverCursor =
        typeof params.lastViewedSessionSeq === 'number' && Number.isFinite(params.lastViewedSessionSeq)
            ? Math.max(0, Math.trunc(params.lastViewedSessionSeq))
            : null;
    const unreadBoundary = serverCursor ?? Math.max(0, sessionSeq - 1);
    const nextSessionSeq = Math.min(prev.sessionSeq, unreadBoundary);

    if (nextSessionSeq === prev.sessionSeq) {
        return { didChange: false, next: prev };
    }

    return {
        didChange: true,
        next: {
            ...prev,
            sessionSeq: nextSessionSeq,
            updatedAt: params.now,
        },
    };
}
