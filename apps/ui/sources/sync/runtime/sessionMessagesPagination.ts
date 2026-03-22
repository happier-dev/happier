export type SessionMessagesPaginationState = {
    /**
     * Cursor used for backwards paging (older messages). When set, subsequent requests should use
     * `beforeSeq=<beforeSeq>`.
     */
    beforeSeq: number | null;
    /**
     * Whether there are more *older* messages available. `null` means unknown.
     */
    hasMoreOlder: boolean | null;
    /**
     * Whether the server supports message pagination fields for this chain. `null` means unknown.
     */
    paginationSupported: boolean | null;
};

export function computeSessionMessagesPaginationUpdateFromPage(params: Readonly<{
    prev: SessionMessagesPaginationState;
    page: {
        messages: Array<{ seq: number }>;
        hasMore?: boolean;
        nextBeforeSeq?: number | null;
        nextAfterSeq?: number | null;
    };
    pageSize: number;
    allowHasMoreInference: boolean;
    direction: 'older' | 'newer';
}>): { next: SessionMessagesPaginationState; maxSeq: number | null } {
    const prev = params.prev;
    const page = params.page;

    if (!Array.isArray(page.messages) || page.messages.length === 0) {
        return { next: prev, maxSeq: null };
    }

    const seqs = page.messages.map((m) => m.seq);
    const minSeq = Math.min(...seqs);
    const maxSeq = Math.max(...seqs);

    const supportsPagination =
        page.hasMore !== undefined || page.nextBeforeSeq !== undefined || page.nextAfterSeq !== undefined;

    const nextBeforeCandidate =
        typeof page.nextBeforeSeq === 'number' && Number.isFinite(page.nextBeforeSeq)
            ? Math.max(1, Math.trunc(page.nextBeforeSeq))
            : (Number.isFinite(minSeq) ? Math.max(1, Math.trunc(minSeq)) : null);

    const nextBeforeSeq =
        nextBeforeCandidate == null
            ? prev.beforeSeq
            : (prev.beforeSeq == null ? nextBeforeCandidate : Math.min(prev.beforeSeq, nextBeforeCandidate));

    let nextHasMoreOlder = prev.hasMoreOlder;
    if (params.direction === 'older') {
        if (typeof page.hasMore === 'boolean') {
            nextHasMoreOlder = page.hasMore;
        } else if (prev.hasMoreOlder !== false && params.allowHasMoreInference) {
            const inferredHasMore = page.messages.length >= params.pageSize;
            if (!inferredHasMore) {
                nextHasMoreOlder = false;
            } else if (prev.hasMoreOlder == null) {
                nextHasMoreOlder = true;
            }
        }
    }

    const nextPaginationSupported =
        supportsPagination ? true : (prev.paginationSupported ?? false);

    return {
        next: {
            beforeSeq: nextBeforeSeq,
            hasMoreOlder: nextHasMoreOlder,
            paginationSupported: nextPaginationSupported,
        },
        maxSeq: Number.isFinite(maxSeq) ? Math.trunc(maxSeq) : null,
    };
}

