import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import type { ReviewWorkflowHistoryRequestV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readReviewHistory } from '@/sync/api/reviews/history';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { subscribeAccountCatalogInvalidation } from '@/sync/engine/settings/accountCatalogInvalidation';
import { homeAccountChangeAffectsArtifactKinds } from '@/sync/runtime/orchestration/changesPlanner';
import { applyReviewHistory, applyReviewHistoryFailure, beginReviewHistoryLoad, getReviewHistorySnapshot,
    invalidateReviewHistory, retireReviewHistory, reviewHistoryKey } from '@/sync/store/domains/reviews/history';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope; input: ReviewWorkflowHistoryRequestV1 }>;
const kinds = Object.freeze([REVIEW_ARTIFACT_KIND_V1]);
function targetFor(scope: ServerAccountScope, input: ReviewWorkflowHistoryRequestV1): Target {
    return { key: reviewHistoryKey(scope, input), serverId: scope.serverId, scope, input };
}
const loader = createScopedSnapshotLoader<Target>({
    subscribeRetainedInvalidation: (target, handlers) => subscribeAccountCatalogInvalidation(target, {
        ...handlers, retire: () => { retireReviewHistory(target.key); handlers.retire(); },
    }),
    load: async (target, context) => {
        beginReviewHistoryLoad(target.key);
        const result = await readReviewHistory(target.scope, target.input, context.signal);
        if (context.signal.aborted) return;
        if (result.kind === 'completed') applyReviewHistory(target.key, result.value, context.isCurrent());
        else applyReviewHistoryFailure(target.key, result.failure);
    },
    shouldLoadOnObserve: target => getReviewHistorySnapshot(target.key).stale,
    invalidateServer: () => {},
    invalidateTarget: target => invalidateReviewHistory(target.key),
    // Earlier Reviews contribute independent open decisions; their changes also refresh this selected source.
    prepareWake: event => homeAccountChangeAffectsArtifactKinds(event, kinds),
    onCredentialMutation: (_event, target) => { retireReviewHistory(target.key); return true; },
});

export function observeReviewHistory(scope: ServerAccountScope, input: ReviewWorkflowHistoryRequestV1): () => void {
    return loader.observe(targetFor(scope, input));
}
export function refreshReviewHistory(scope: ServerAccountScope, input: ReviewWorkflowHistoryRequestV1): Promise<void> {
    return loader.refresh(targetFor(scope, input));
}
