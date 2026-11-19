import type { ReviewGetResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { retainDeep, retainShallow } from '@/sync/domains/state/structuralSharing';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';

export type ReviewDetailSnapshot = Readonly<{
    data: ReviewGetResponseV1 | null;
    status: 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';
    error: HomeActionFailure | null;
    stale: boolean;
}>;
const EMPTY: ReviewDetailSnapshot = Object.freeze({ data: null, status: 'idle', error: null, stale: true });
const snapshots = new Map<string, ReviewDetailSnapshot>();
const listeners = new Map<string, Set<() => void>>();

export function reviewDetailKey(scope: ServerAccountScope, reviewId: string): string {
    return serverAccountScopedResourceKey(scope, 'review.get', reviewId);
}
export function getReviewDetailSnapshot(key: string): ReviewDetailSnapshot { return snapshots.get(key) ?? EMPTY; }
export function subscribeReviewDetail(key: string, listener: () => void): () => void {
    const set = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, set);
    set.add(listener);
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
}
function write(key: string, next: ReviewDetailSnapshot): void {
    const previous = getReviewDetailSnapshot(key);
    const retained = retainShallow(previous, next);
    if (retained === previous) return;
    snapshots.set(key, retained);
    for (const listener of listeners.get(key) ?? []) listener();
}
export function applyReviewDetail(key: string, data: ReviewGetResponseV1, current = true): void {
    write(key, { data: retainDeep(getReviewDetailSnapshot(key).data, data), status: 'ready', error: null, stale: !current });
}
export function beginReviewDetailLoad(key: string): void {
    const previous = getReviewDetailSnapshot(key);
    if (!previous.error) write(key, { ...previous, status: previous.data ? 'refreshing' : 'loading' });
}
export function applyReviewDetailFailure(key: string, error: HomeActionFailure): void {
    const previous = getReviewDetailSnapshot(key);
    write(key, { ...previous, data: isAuthoritativeScopedSnapshotRefusalKind(error.kind) ? null : previous.data,
        status: 'error', error: retainShallow(previous.error ?? undefined, error), stale: true });
}
export function invalidateReviewDetail(key: string): void {
    const previous = getReviewDetailSnapshot(key);
    if (!previous.stale) write(key, { ...previous, stale: true });
}
export function retireReviewDetail(key: string): void { write(key, EMPTY); }
