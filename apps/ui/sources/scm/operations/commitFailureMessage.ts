import type { ScmOperationErrorCode } from '@happier-dev/protocol';

import { getScmUserFacingError } from './userFacingErrors';

export function buildScmCommitFailureMessage(input: {
    errorCode?: ScmOperationErrorCode;
    error?: string;
    commitSha?: string;
}): string {
    const fallback = input.error || 'Failed to create commit';
    const baseMessage = getScmUserFacingError({
        errorCode: input.errorCode,
        error: input.error,
        fallback,
    });

    if (!input.commitSha) {
        return baseMessage;
    }

    const shortSha = input.commitSha.slice(0, 12);
    return `Commit ${shortSha} was created, but final repository sync failed. Your virtual selection is preserved. ${baseMessage}`;
}
