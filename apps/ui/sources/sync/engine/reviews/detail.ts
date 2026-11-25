import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readReviewDetail } from '@/sync/api/reviews/detail';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { subscribeAccountCatalogInvalidation } from '@/sync/engine/settings/accountCatalogInvalidation';
import { homeAccountChangeAffectsArtifactKinds } from '@/sync/runtime/orchestration/changesPlanner';
import { applyReviewDetail, applyReviewDetailFailure, beginReviewDetailLoad, getReviewDetailSnapshot,
    invalidateReviewDetail, retireReviewDetail, reviewDetailKey } from '@/sync/store/domains/reviews/detail';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope; reviewId: string }>;
const kinds = Object.freeze([REVIEW_ARTIFACT_KIND_V1]);
// The Workflow page needs the opened history; ordinary summaries need only metadata and a current partial round.
const recordConsumers = new Map<string, number>();
function targetFor(scope: ServerAccountScope, reviewId: string): Target {
    return { key: reviewDetailKey(scope, reviewId), serverId: scope.serverId, scope, reviewId };
}
const loader = createScopedSnapshotLoader<Target>({
    subscribeRetainedInvalidation: (target, handlers) => subscribeAccountCatalogInvalidation(target, {
        ...handlers, retire: () => { retireReviewDetail(target.key); handlers.retire(); },
    }),
    load: async (target, context) => {
        beginReviewDetailLoad(target.key);
        const result = await readReviewDetail(target.scope, target.reviewId, context.signal,
            { includeRecord: () => recordConsumers.has(target.key) });
        if (context.signal.aborted) return;
        if (result.kind === 'completed') applyReviewDetail(target.key, result.value, context.isCurrent());
        else applyReviewDetailFailure(target.key, result.failure);
    },
    shouldLoadOnObserve: target => {
        const snapshot = getReviewDetailSnapshot(target.key);
        return snapshot.stale || recordConsumers.has(target.key) && snapshot.data?.record === undefined;
    },
    invalidateServer: () => {},
    invalidateTarget: target => invalidateReviewDetail(target.key),
    prepareWake: (event, target) => homeAccountChangeAffectsArtifactKinds(event, kinds)
        && (event.entityIds === undefined || event.entityIds.includes(target.reviewId)),
    onCredentialMutation: (_event, target) => { retireReviewDetail(target.key); return true; },
});

export function observeReviewDetail(scope: ServerAccountScope, reviewId: string,
    options?: Readonly<{ includeRecord?: boolean }>): () => void {
    const target = targetFor(scope, reviewId);
    if (options?.includeRecord) recordConsumers.set(target.key, (recordConsumers.get(target.key) ?? 0) + 1);
    const release = loader.observe(target);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (options?.includeRecord) {
            const count = (recordConsumers.get(target.key) ?? 1) - 1;
            if (count > 0) recordConsumers.set(target.key, count);
            else recordConsumers.delete(target.key);
        }
        release();
    };
}
export function refreshReviewDetail(scope: ServerAccountScope, reviewId: string): Promise<void> {
    return loader.refresh(targetFor(scope, reviewId));
}
