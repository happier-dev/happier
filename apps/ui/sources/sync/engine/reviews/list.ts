import type { ReviewListRequestV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readReviewList } from '@/sync/api/reviews/list';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { subscribeAccountCatalogInvalidation } from '@/sync/engine/settings/accountCatalogInvalidation';
import { homeAccountChangeAffectsArtifactKinds, homeAccountChangeAffectsResourceSpaceMembership } from '@/sync/runtime/orchestration/changesPlanner';
import { applyReviewListFailure, applyReviewListPage, beginReviewListLoad, getReviewListSnapshot,
    invalidateReviewList, retireReviewList, reviewListKey } from '@/sync/store/domains/reviews/list';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope; input: ReviewListRequestV1 }>;
const kinds = Object.freeze([REVIEW_ARTIFACT_KIND_V1]);
function targetFor(scope: ServerAccountScope, input: ReviewListRequestV1): Target {
    return { key: reviewListKey(scope, input), serverId: scope.serverId, scope, input };
}
const loader = createScopedSnapshotLoader<Target>({
    subscribeRetainedInvalidation: (target, handlers) => subscribeAccountCatalogInvalidation(target, {
        ...handlers, retire: () => { retireReviewList(target.key); handlers.retire(); },
    }),
    load: async (target, context) => {
        beginReviewListLoad(target.key);
        const result = await readReviewList(target.scope, target.input, context.signal);
        if (context.signal.aborted) return;
        if (result.kind === 'completed') applyReviewListPage(target.key, result.value, false, context.isCurrent());
        else applyReviewListFailure(target.key, result.failure);
    },
    shouldLoadOnObserve: target => getReviewListSnapshot(target.key).stale,
    invalidateServer: () => {},
    invalidateTarget: target => invalidateReviewList(target.key),
    prepareWake: (event, target) => homeAccountChangeAffectsArtifactKinds(event, kinds)
        || homeAccountChangeAffectsResourceSpaceMembership(event, target.input.spaceId),
    onCredentialMutation: (_event, target) => { retireReviewList(target.key); return true; },
});
const continuations = new Map<string, Promise<void>>();

export function observeReviewList(scope: ServerAccountScope, input: ReviewListRequestV1): () => void {
    return loader.observe(targetFor(scope, input));
}
export function refreshReviewList(scope: ServerAccountScope, input: ReviewListRequestV1): Promise<void> {
    return loader.refresh(targetFor(scope, input));
}
/** One explicit candidate page; sparse local matches never trigger another page. */
export function loadMoreReviews(scope: ServerAccountScope, input: ReviewListRequestV1): Promise<void> {
    const target = targetFor(scope, input);
    const existing = continuations.get(target.key);
    if (existing) return existing;
    const snapshot = getReviewListSnapshot(target.key);
    const cursor = snapshot.cursor;
    if (!cursor || snapshot.status === 'refreshing' || snapshot.status === 'loading') return Promise.resolve();
    const pending = loader.readContinuation(target, async signal => {
        beginReviewListLoad(target.key, true);
        const result = await readReviewList(scope, { ...input, cursor }, signal);
        if (signal.aborted || getReviewListSnapshot(target.key).cursor !== cursor) return;
        if (result.kind === 'completed') applyReviewListPage(target.key, result.value, true);
        else applyReviewListFailure(target.key, result.failure);
    }).finally(() => { continuations.delete(target.key); });
    continuations.set(target.key, pending);
    return pending;
}
