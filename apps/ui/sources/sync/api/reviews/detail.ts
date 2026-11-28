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
export async function readReviewDetail(scope: ServerAccountScope, reviewId: string, signal: AbortSignal,
    options?: Readonly<{ includeRecord: () => boolean }>): Promise<ReviewDetailReadResult> {
    const execute = scopedHomeActionExecutor(scope, {
        hostActionApprovalLifetime: { actionId: 'review.get', signal, surface: 'ui' },
    });
    let account: LazyActionAccountContext | undefined;
    let artifact: ReturnType<LazyActionAccountContext['readArtifactContent']> | undefined;
    let contentArtifact: ReturnType<typeof ReviewGetResponseV1Schema.parse>['contentArtifact'];
    const readArtifact = () => artifact ??= (async () => {
        account = await captureLazyActionAccountContext(scope.serverId, signal, undefined, scope);
        const openOptions = { includeAssociatedContentOpener: true, signal };
        if (contentArtifact?.id !== reviewId) return account.readArtifactContent(reviewId, openOptions);
        const [opened] = await account.openArtifactContents([contentArtifact], openOptions);
        if (opened?.status === 'rejected') throw opened.reason;
        return opened?.value ?? null;
    })();
    try {
        const result = await execute('review.get', {
            reviewId, ...(options?.includeRecord() === true ? { includeContentArtifact: true } : {}),
        }, {
            surface: 'ui', authority: 'present_user', serverId: scope.serverId, signal,
        });
        requireActionSuccess(result, 'review.get');
        const { contentArtifact: bundledArtifact, ...value } = ReviewGetResponseV1Schema.parse(result.result);
        contentArtifact = bundledArtifact;
        const human = await openReviewHumanStateV1(value.human,
            () => readReviewHumanResource({ readArtifactContent: readArtifact }, reviewId, signal));
        // Reviewer names and outcomes live in the opened Review body. A body the
        // Account cannot open leaves the already-admitted aggregate available.
        const includeRecord = options?.includeRecord() === true;
        const record = includeRecord || value.review.state === 'partial'
            ? await readArtifact().then(row => row ? openReviewArtifactV1(row) : null).catch(() => null) : undefined;
        const partialRound = record?.rounds.find(round => round.ordinal === value.review.currentRoundOrdinal
            && round.state === 'partial');
        return { kind: 'completed', value: { ...value, human, ...(partialRound ? { partialRound } : {}),
            ...(includeRecord ? { record } : {}) } };
    } catch (error) {
        return { kind: 'failed', failure: homeDomainFailureFromActionFailure(
            normalizeActionExecutorThrownError(error), 'review.get',
        ) };
    } finally { account?.dispose(); }
}
