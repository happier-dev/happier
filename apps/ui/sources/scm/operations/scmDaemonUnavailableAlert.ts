import type { ScmOperationErrorCode } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { showDaemonUnavailableAlert } from '@/utils/errors/daemonUnavailableAlert';

export function tryShowDaemonUnavailableAlertForScmOperationFailure(params: Readonly<{
    errorCode?: ScmOperationErrorCode | string | null;
    onRetry?: (() => void) | null;
    shouldContinue?: (() => boolean) | null;
}>): boolean {
    if (params.errorCode !== SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE) {
        return false;
    }

    showDaemonUnavailableAlert({
        titleKey: 'errors.daemonUnavailableTitle',
        bodyKey: 'errors.daemonUnavailableBody',
        onRetry: params.onRetry ?? null,
        shouldContinue: params.shouldContinue ?? null,
    });
    return true;
}
