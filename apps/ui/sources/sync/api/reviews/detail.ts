import { ReviewGetResponseV1Schema, type ReviewGetResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';

export type ReviewDetailReadResult = Readonly<{ kind: 'completed'; value: ReviewGetResponseV1 }>
    | Readonly<{ kind: 'failed'; failure: HomeActionFailure }>;

/** Metadata and person state use the existing Account-bound Action front door. */
export async function readReviewDetail(scope: ServerAccountScope, reviewId: string, signal: AbortSignal): Promise<ReviewDetailReadResult> {
    const execute = scopedHomeActionExecutor(scope, {
        hostActionApprovalLifetime: { actionId: 'review.get', signal, surface: 'ui' },
    });
    try {
        const result = await execute('review.get', { reviewId }, {
            surface: 'ui', authority: 'present_user', serverId: scope.serverId, signal,
        });
        requireActionSuccess(result, 'review.get');
        return { kind: 'completed', value: ReviewGetResponseV1Schema.parse(result.result) };
    } catch (error) {
        return { kind: 'failed', failure: homeDomainFailureFromActionFailure(
            normalizeActionExecutorThrownError(error), 'review.get',
        ) };
    }
}
