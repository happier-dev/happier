import { ReviewGetResponseV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import { openReviewHumanStateV1 } from '@happier-dev/protocol/reviews/reviewHumanTransportV1';
import { openReviewArtifactV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readReviewHumanResource } from '@/sync/domains/reviews/humanApi';
import type { ReviewDetailData } from '@/sync/store/domains/reviews/detail';

export type ReviewDetailReadResult = Readonly<{ kind: 'completed'; value: ReviewDetailData }>
    | Readonly<{ kind: 'failed'; failure: HomeActionFailure }>;

/** Metadata and person state use the existing Account-bound Action front door. */
export async function readReviewDetail(scope: ServerAccountScope, reviewId: string, signal: AbortSignal): Promise<ReviewDetailReadResult> {
    const execute = scopedHomeActionExecutor(scope, {
        hostActionApprovalLifetime: { actionId: 'review.get', signal, surface: 'ui' },
    });
    let account: LazyActionAccountContext | undefined;
    let artifact: ReturnType<LazyActionAccountContext['readArtifactContent']> | undefined;
    const readArtifact = () => artifact ??= (async () => {
        account = await captureLazyActionAccountContext(scope.serverId, signal, undefined, scope);
        return account.readArtifactContent(reviewId, { includeAssociatedContentOpener: true, signal });
    })();
    try {
        const result = await execute('review.get', { reviewId }, {
            surface: 'ui', authority: 'present_user', serverId: scope.serverId, signal,
        });
        requireActionSuccess(result, 'review.get');
        const value = ReviewGetResponseV1Schema.parse(result.result);
        const human = await openReviewHumanStateV1(value.human,
            () => readReviewHumanResource({ readArtifactContent: readArtifact }, reviewId, signal));
        // Reviewer names and outcomes live in the opened Review body. A body the
        // Account cannot open leaves the already-admitted aggregate available.
        const partialRound = value.review.state === 'partial' ? await readArtifact().then(row =>
            row && openReviewArtifactV1(row).rounds.find(round => round.ordinal === value.review.currentRoundOrdinal
                && round.state === 'partial'),
        ).catch(() => undefined) : undefined;
        return { kind: 'completed', value: { ...value, human, ...(partialRound ? { partialRound } : {}) } };
    } catch (error) {
        return { kind: 'failed', failure: homeDomainFailureFromActionFailure(
            normalizeActionExecutorThrownError(error), 'review.get',
        ) };
    } finally { account?.dispose(); }
}
