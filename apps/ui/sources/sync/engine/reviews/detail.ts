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
function targetFor(scope: ServerAccountScope, reviewId: string): Target {
    return { key: reviewDetailKey(scope, reviewId), serverId: scope.serverId, scope, reviewId };
}
const loader = createScopedSnapshotLoader<Target>({
    subscribeRetainedInvalidation: (target, handlers) => subscribeAccountCatalogInvalidation(target, {
        ...handlers, retire: () => { retireReviewDetail(target.key); handlers.retire(); },
    }),
    load: async (target, context) => {
        beginReviewDetailLoad(target.key);
        const result = await readReviewDetail(target.scope, target.reviewId, context.signal);
        if (context.signal.aborted) return;
        if (result.kind === 'completed') applyReviewDetail(target.key, result.value, context.isCurrent());
        else applyReviewDetailFailure(target.key, result.failure);
    },
    shouldLoadOnObserve: target => getReviewDetailSnapshot(target.key).stale,
    invalidateServer: () => {},
    invalidateTarget: target => invalidateReviewDetail(target.key),
    prepareWake: (event, target) => homeAccountChangeAffectsArtifactKinds(event, kinds)
        && (event.entityIds === undefined || event.entityIds.includes(target.reviewId)),
    onCredentialMutation: (_event, target) => { retireReviewDetail(target.key); return true; },
});

export function observeReviewDetail(scope: ServerAccountScope, reviewId: string): () => void {
    return loader.observe(targetFor(scope, reviewId));
}
export function refreshReviewDetail(scope: ServerAccountScope, reviewId: string): Promise<void> {
    return loader.refresh(targetFor(scope, reviewId));
}
