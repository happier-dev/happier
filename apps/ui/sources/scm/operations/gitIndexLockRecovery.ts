import {
    REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
    type ScmRepositoryRemoveIndexLockRequest,
    type ScmRepositoryRemoveIndexLockResponse,
} from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { t } from '@/text';
import { isRecoverableGitIndexLockError } from '@/scm/operations/userFacingErrors';

type ScmOperationResponse = { success: boolean; errorCode?: string; error?: string; stderr?: string };

export async function runScmOperationWithGitIndexLockRecovery<
    TFailureResponse extends ScmOperationResponse,
    TRetryResponse extends ScmOperationResponse = TFailureResponse,
>(input: Readonly<{
    cwd: string;
    failedResponse: TFailureResponse;
    removeIndexLock: (request: ScmRepositoryRemoveIndexLockRequest) => Promise<ScmRepositoryRemoveIndexLockResponse>;
    retryOriginalOperation: () => Promise<TRetryResponse>;
    recoveryAlreadyAttempted?: boolean;
}>): Promise<TFailureResponse | TRetryResponse> {
    if (
        input.recoveryAlreadyAttempted === true
        || !isRecoverableGitIndexLockError(input.failedResponse)
    ) {
        return input.failedResponse;
    }

    const confirmed = await Modal.confirm(
        t('files.indexLockRecovery.title'),
        t('files.indexLockRecovery.body'),
        {
            cancelText: t('common.cancel'),
            confirmText: t('files.indexLockRecovery.confirm'),
            destructive: true,
        },
    );
    if (!confirmed) {
        return input.failedResponse;
    }

    const removeResponse = await input.removeIndexLock({
        cwd: input.cwd,
        confirmed: true,
        confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
    });
    // If the privileged unlink itself failed, surface that distinct error to the caller
    // by returning a synthesized failure shaped like the original response. This avoids
    // misleading the user with the original lock-contention error when the actual
    // failure was permissions/IO/symlink-rejection from the backend.
    if (!removeResponse.success) {
        const removeError = (removeResponse as { error?: string; errorCode?: string }).error
            ?? (removeResponse as { errorCode?: string }).errorCode
            ?? 'unknown';
        return {
            ...input.failedResponse,
            error: t('files.indexLockRecovery.failed', { error: removeError }),
        };
    }

    return await input.retryOriginalOperation();
}
