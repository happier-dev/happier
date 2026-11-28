import { parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { alertActionFailure, readSafeFailureDetails } from '@/utils/errors/alertActionFailure';

export function alertInboxNoticeDismissalFailure(error: unknown): void {
    const failure = parseActionExecuteFailure(error);
    const fallback = t('common.requestFailed');
    alertActionFailure({
        reason: failure ? presentActionExecutionFailure(failure, fallback, { closedCodesOnly: true }).reason : fallback,
        code: failure?.errorCode ?? null,
        requestId: failure?.requestId,
        context: readSafeFailureDetails(failure?.details),
        failureCause: failure?.failureCause,
    });
}
