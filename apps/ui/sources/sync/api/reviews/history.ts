import { ReviewWorkflowHistoryResponseV1Schema, type ReviewWorkflowHistoryRequestV1, type ReviewWorkflowHistoryResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';

export type ReviewHistoryReadResult = Readonly<{ kind: 'completed'; value: ReviewWorkflowHistoryResponseV1 }>
    | Readonly<{ kind: 'failed'; failure: HomeActionFailure }>;

/** One demanded grouping through the shared Action front door, without opening finding bodies. */
export async function readReviewHistory(scope: ServerAccountScope, input: ReviewWorkflowHistoryRequestV1, signal: AbortSignal): Promise<ReviewHistoryReadResult> {
    const execute = scopedHomeActionExecutor(scope, {
        hostActionApprovalLifetime: { actionId: 'review.history.list', signal, surface: 'ui' },
    });
    try {
        const result = await execute('review.history.list', input, {
            surface: 'ui', authority: 'present_user', serverId: scope.serverId, signal,
        });
        requireActionSuccess(result, 'review.history.list');
        return { kind: 'completed', value: ReviewWorkflowHistoryResponseV1Schema.parse(result.result) };
    } catch (error) {
        return { kind: 'failed', failure: homeDomainFailureFromActionFailure(
            normalizeActionExecutorThrownError(error), 'review.history.list',
        ) };
    }
}
