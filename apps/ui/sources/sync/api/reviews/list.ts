import { ReviewListResponseV1Schema, type ReviewListRequestV1, type ReviewListResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';

export type ReviewListReadResult = Readonly<{ kind: 'completed'; value: ReviewListResponseV1 }>
    | Readonly<{ kind: 'failed'; failure: HomeActionFailure }>;

/** The shared Action front door captures the named Home/Account and owns admission and HTTP mapping. */
export async function readReviewList(scope: ServerAccountScope, input: ReviewListRequestV1, signal: AbortSignal): Promise<ReviewListReadResult> {
    const execute = scopedHomeActionExecutor(scope, {
        hostActionApprovalLifetime: { actionId: 'reviews.list', signal, surface: 'ui' },
    });
    try {
        const result = await execute('reviews.list', input, {
            surface: 'ui', authority: 'present_user', serverId: scope.serverId, signal,
        });
        // The factory-bound lifetime retains read approvals until settlement. The shared
        // result owner also keeps an unexpected approval receipt out of list data.
        requireActionSuccess(result, 'reviews.list');
        return { kind: 'completed', value: ReviewListResponseV1Schema.parse(result.result) };
    } catch (error) {
        // Includes an unloaded Action chunk failing before the executor can normalize it.
        return { kind: 'failed', failure: homeDomainFailureFromActionFailure(
            normalizeActionExecutorThrownError(error), 'reviews.list',
        ) };
    }
}
