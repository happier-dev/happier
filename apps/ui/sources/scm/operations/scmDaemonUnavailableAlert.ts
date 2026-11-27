import type { ScmOperationErrorCode } from '@happier-dev/protocol/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm';

import { showDaemonUnavailableAlert } from '@/utils/errors/daemonUnavailableAlert';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { alertActionFailure, showActionFailureDetails } from '@/utils/errors/alertActionFailure';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { Modal } from '@/modal';
import { t } from '@/text';

function scmFailureDetails(failure: ActionExecuteFailure | null | undefined) {
    if (!failure || (!failure.failureCause && !failure.requestId && failure.effectAttempted === undefined && failure.details === undefined)) return null;
    return { code: failure.errorCode,
        context: Object.fromEntries(presentActionExecutionFailure(failure).technicalDetails.map(({ key, value }) => [key, value])) };
}

/** Reuse the Action disclosure while the caller retains its SCM reason and recovery. */
export function alertScmOperationFailure(params: Readonly<{ failure?: ActionExecuteFailure | null; message: string; title?: string }>): void {
    const details = scmFailureDetails(params.failure);
    if (details) alertActionFailure({ title: params.title, reason: params.message, ...details });
    else Modal.alert(params.title ?? t('common.error'), params.message);
}

export function tryShowDaemonUnavailableAlertForScmOperationFailure(params: Readonly<{
    errorCode?: ScmOperationErrorCode | string | null;
    onRetry?: (() => void) | null;
    shouldContinue?: (() => boolean) | null;
    failure?: ActionExecuteFailure | null;
}>): boolean {
    if (params.errorCode !== SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE) {
        return false;
    }

    const details = scmFailureDetails(params.failure);
    showDaemonUnavailableAlert({
        titleKey: 'errors.daemonUnavailableTitle',
        bodyKey: 'errors.daemonUnavailableBody',
        onRetry: params.onRetry ?? null,
        shouldContinue: params.shouldContinue ?? null,
        ...(details ? { onShowDetails: () => showActionFailureDetails(details) } : {}),
    });
    return true;
}
