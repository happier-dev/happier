import { ReviewListRequestV1Schema, type ReviewListItemV1, type ReviewListRequestV1, type ReviewListResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { retainKeyedRows, retainShallow } from '@/sync/domains/state/structuralSharing';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';

export type ReviewListSnapshot = Readonly<{
    items: readonly ReviewListItemV1[] | null;
    cursor: string | null;
    status: 'idle' | 'loading' | 'refreshing' | 'loading_more' | 'ready' | 'error';
    error: HomeActionFailure | null;
    stale: boolean;
}>;
const EMPTY: ReviewListSnapshot = Object.freeze({ items: null, cursor: null, status: 'idle', error: null, stale: true });
const snapshots = new Map<string, ReviewListSnapshot>();
const listeners = new Map<string, Set<() => void>>();

export function reviewListKey(scope: ServerAccountScope, input: ReviewListRequestV1): string {
    return serverAccountScopedResourceKey(scope, 'reviews.list', JSON.stringify(ReviewListRequestV1Schema.parse(input)));
}
export function getReviewListSnapshot(key: string): ReviewListSnapshot { return snapshots.get(key) ?? EMPTY; }
export function subscribeReviewList(key: string, listener: () => void): () => void {
    const set = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, set);
    set.add(listener);
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
}
function write(key: string, next: ReviewListSnapshot): void {
    const previous = getReviewListSnapshot(key);
    const retained = retainShallow(previous, next);
    if (retained === previous) return;
    snapshots.set(key, retained);
    for (const listener of listeners.get(key) ?? []) listener();
}
export function applyReviewListPage(key: string, page: ReviewListResponseV1, append = false, current = true): void {
    const previous = getReviewListSnapshot(key);
    const incoming = append ? [...new Map([...previous.items ?? [], ...page.items].map(row => [row.reviewId, row])).values()] : page.items;
    write(key, { items: retainKeyedRows(previous.items, incoming, row => row.reviewId),
        cursor: page.cursor, status: 'ready', error: null, stale: !current });
}
export function beginReviewListLoad(key: string, append = false): void {
    const previous = getReviewListSnapshot(key);
    // Keep a settled failure and its safe rows visible during retry.
    if (previous.error) return;
    write(key, { ...previous, status: append ? 'loading_more' : previous.items ? 'refreshing' : 'loading' });
}
export function applyReviewListFailure(key: string, error: HomeActionFailure): void {
    const previous = getReviewListSnapshot(key);
    const withdrawn = isAuthoritativeScopedSnapshotRefusalKind(error.kind);
    write(key, { ...previous, ...(withdrawn ? { items: null, cursor: null } : {}),
        status: 'error', error: retainShallow(previous.error ?? undefined, error), stale: true });
}
export function invalidateReviewList(key: string): void {
    const previous = getReviewListSnapshot(key);
    if (!previous.stale) write(key, { ...previous, stale: true });
}
export function retireReviewList(key: string): void { write(key, EMPTY); }
