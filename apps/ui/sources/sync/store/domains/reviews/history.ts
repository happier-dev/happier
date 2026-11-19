import type { ReviewHistoryRequestV1, ReviewHistoryResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { retainDeep, retainShallow } from '@/sync/domains/state/structuralSharing';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';

export type ReviewHistorySnapshot = Readonly<{
    data: ReviewHistoryResponseV1 | null;
    status: 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';
    error: HomeActionFailure | null;
    stale: boolean;
}>;
const EMPTY: ReviewHistorySnapshot = Object.freeze({ data: null, status: 'idle', error: null, stale: true });
const snapshots = new Map<string, ReviewHistorySnapshot>();
const listeners = new Map<string, Set<() => void>>();

export function reviewHistoryKey(scope: ServerAccountScope, input: ReviewHistoryRequestV1): string {
    const resource = 'workflowId' in input ? ['workflow', input.workflowId, input.reviewId]
        : ['seenBefore', input.reviewId, input.findingIdentity];
    return serverAccountScopedResourceKey(scope, 'review.history.list', JSON.stringify(resource));
}
export function getReviewHistorySnapshot(key: string): ReviewHistorySnapshot { return snapshots.get(key) ?? EMPTY; }
export function subscribeReviewHistory(key: string, listener: () => void): () => void {
    const set = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, set);
    set.add(listener);
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
}
function write(key: string, next: ReviewHistorySnapshot): void {
    const previous = getReviewHistorySnapshot(key);
    const retained = retainShallow(previous, next);
    if (retained === previous) return;
    snapshots.set(key, retained);
    for (const listener of listeners.get(key) ?? []) listener();
}
export function applyReviewHistory(key: string, data: ReviewHistoryResponseV1, current = true): void {
    write(key, { data: retainDeep(getReviewHistorySnapshot(key).data, data), status: 'ready', error: null, stale: !current });
}
export function beginReviewHistoryLoad(key: string): void {
    const previous = getReviewHistorySnapshot(key);
    if (!previous.error) write(key, { ...previous, status: previous.data ? 'refreshing' : 'loading' });
}
export function applyReviewHistoryFailure(key: string, error: HomeActionFailure): void {
    const previous = getReviewHistorySnapshot(key);
    write(key, { ...previous, data: isAuthoritativeScopedSnapshotRefusalKind(error.kind) ? null : previous.data,
        status: 'error', error: retainShallow(previous.error ?? undefined, error), stale: true });
}
export function invalidateReviewHistory(key: string): void {
    const previous = getReviewHistorySnapshot(key);
    if (!previous.stale) write(key, { ...previous, stale: true });
}
export function retireReviewHistory(key: string): void { write(key, EMPTY); }
