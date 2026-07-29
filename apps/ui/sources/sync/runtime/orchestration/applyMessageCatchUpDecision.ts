import type { MessageCatchUpDecision } from '@/sync/runtime/orchestration/messageCatchUpPolicy';

export async function applyMessageCatchUpDecision(params: Readonly<{
    decision: MessageCatchUpDecision;
    afterSeq: number;
    onIncrementalExhausted: 'tail_reset_latest_page' | 'defer_forward_loading';
    fetchNewerPage: (afterSeq: number) => Promise<{ messagesCount: number; nextAfterSeq: number | null }>;
    fetchSnapshotLatestPage: () => Promise<void>;
    markLoaded: () => void;
    setDeferredForwardLoading: (deferred: boolean) => void;
}>): Promise<void> {
    if (params.decision.kind === 'do_nothing') {
        return;
    }

    if (params.decision.kind === 'defer_forward_loading') {
        params.setDeferredForwardLoading(true);
        return;
    }

    if (params.decision.kind === 'tail_reset_latest_page') {
        // C6/D2b: fetch-then-merge. A large catch-up gap is NOT a discontinuity — the latest
        // page is merged on top of existing history via the non-destructive seq-merge in
        // applyMessages. Wiping the transcript first lost all paginated older pages and opened
        // an empty-store window; a full reset is reserved for proven discontinuity (truncated
        // tail / server purge-rewrite), handled by its own callers.
        params.setDeferredForwardLoading(false);
        await params.fetchSnapshotLatestPage();
        params.markLoaded();
        return;
    }

    params.setDeferredForwardLoading(false);

    let cursor = Math.max(0, Math.trunc(params.afterSeq));
    let remainingPages = Math.max(1, Math.trunc(params.decision.maxPages));
    while (remainingPages > 0) {
        remainingPages -= 1;
        const page = await params.fetchNewerPage(cursor);
        if (page.messagesCount <= 0 || page.nextAfterSeq === null) {
            params.markLoaded();
            return;
        }
        cursor = page.nextAfterSeq;
    }

    if (params.onIncrementalExhausted === 'tail_reset_latest_page') {
        // C6/D2b: fetch-then-merge (see above) — never a destructive reset on a plain gap.
        await params.fetchSnapshotLatestPage();
        params.markLoaded();
        return;
    }

    params.setDeferredForwardLoading(true);
}
