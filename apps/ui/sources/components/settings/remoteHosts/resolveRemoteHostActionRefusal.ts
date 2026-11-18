import { isActionApprovalDeclinedErrorCode, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

export function resolveRemoteHostActionRefusal(result: ActionExecuteResult): string | null {
    if (!result.ok) {
        if (result.errorCode === 'cancelled' || isActionApprovalDeclinedErrorCode(result.errorCode)) return null;
        return resolveActionExecutionErrorMessage(result, t('errors.operationFailed'));
    }
    const receipt = result.result;
    if (!receipt || typeof receipt !== 'object' || !('status' in receipt)) return null;
    if (receipt.status === 'conflict') return t('approvals.conflictFailure');
    if (receipt.status === 'outcome_unknown') return t('errors.scmOutcomeUnknown');
    if (receipt.status === 'unavailable') {
        const code = 'reason' in receipt ? receipt.reason : undefined;
        return resolveActionExecutionErrorMessage({ code }, t('errors.operationFailed'));
    }
    return null;
}
