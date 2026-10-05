import type { ScmOperationErrorCode } from '@happier-dev/protocol';

import { getScmUserFacingError } from './userFacingErrors';

export function buildScmCommitFailureMessage(input: {
    errorCode?: ScmOperationErrorCode;
    error?: string;
    commitSha?: string;
}): string {
    const fallback = input.error || 'Failed to create commit';
    return getScmUserFacingError({
        errorCode: input.errorCode,
        error: input.error,
        fallback,
    });

}
