import type { ScmOperationErrorCode } from '@happier-dev/protocol/scm/operationError';

import { getScmUserFacingError } from './userFacingErrors';

export function buildScmCommitFailureMessage(input: {
    errorCode?: ScmOperationErrorCode;
    actionErrorCode?: string;
    error?: string;
    commitSha?: string;
}): string {
    const fallback = input.error || 'Failed to create commit';
    return getScmUserFacingError({
        ...input,
        errorCode: input.errorCode,
        error: input.error,
        fallback,
    });

}
