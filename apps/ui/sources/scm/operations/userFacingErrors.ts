import type { ScmOperationErrorCode } from '@happier-dev/protocol/scm';
import { classifyScmOperationErrorCode, mapGitScmErrorCode, SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm';
import { t } from '@/text';
import { describeActionExecutionPrerequisite } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

export function getScmUserFacingError(input: {
    errorCode?: ScmOperationErrorCode;
    actionErrorCode?: string;
    error?: string;
    fallback: string;
    /**
     * What the operation carried, when its copy differs: a sent message names the conversation to check; a pull
     * request read that finds nothing names the pull request, not a remote.
     */
    subject?: 'message' | 'pullRequest';
}): string {
    const prerequisite = describeActionExecutionPrerequisite(input.actionErrorCode);
    if (prerequisite) return prerequisite.message;
    const rawError = input.error?.toLowerCase() ?? '';
    const rawFallback = input.fallback.toLowerCase();
    switch (input.errorCode) {
        case SCM_OPERATION_ERROR_CODES.ROOT_NOT_FOUND:
            return t('errors.workspaceFolderMissing');
        case SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY:
            return 'The selected path is not a source control repository.';
        case SCM_OPERATION_ERROR_CODES.INVALID_PATH:
            return 'The repository path is invalid.';
        case SCM_OPERATION_ERROR_CODES.INVALID_REQUEST:
            if (rawError.includes('merge commits') || rawError.includes('merge commit')) {
                return 'Reverting merge commits is not supported yet.';
            }
            if (rawError.includes('head is detached') || rawError.includes('detached')) {
                return 'Operation is unavailable while HEAD is detached.';
            }
            if (rawError.includes('commit message exceeds maximum length') || rawError.includes('message is too long')) {
                return 'Commit message is too long. Use a shorter message and try again.';
            }
            return 'The source control request is invalid.';
        case SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED:
            if (looksLikeLockContention(rawError, rawFallback)) {
                return 'Another source control operation is in progress (working copy lock). Wait for it to finish and try again.';
            }
            return 'Diff changed, refresh and reselect your lines.';
        case SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED:
            return 'Commit included changes before continuing.';
        case SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE:
            return 'Resolve local changes and conflicts before continuing.';
        case SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED:
            return 'Remote authentication is required.';
        case SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED:
            return 'Set a tracking target before pull or push.';
        case SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD:
            return 'Push rejected because remote has newer commits. Fetch/pull first, then push again.';
        case SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED:
            return 'Pull requires a fast-forward but branches diverged. Rebase or merge locally, then retry.';
        case SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED:
            if (rawError.includes('gh013') || rawError.includes('repository rule violations')) {
                return 'Remote rejected the update due to repository rules (GH013). Review the rules and retry.';
            }
            if (rawError.includes('gh006') || rawError.includes('protected branch')) {
                return 'Remote rejected the update due to protected-branch rules (GH006).';
            }
            if (rawError.includes('pre-receive hook declined')) {
                return 'Remote rejected the update through a pre-receive hook. Review repository policy and retry.';
            }
            return 'Remote rejected the update (for example by server policy or pre-receive hook).';
        case SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND:
            return input.subject === 'pullRequest'
                ? t('errors.scmPullRequestNotFound')
                : 'The selected remote was not found in this repository.';
        case SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED:
            return 'This operation is not supported by the active source control backend.';
        case SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE:
            return 'The active source control backend is unavailable.';
        case SCM_OPERATION_ERROR_CODES.COMMAND_OUTCOME_UNKNOWN:
            // The command was dispatched but its reply was lost: say so, never the raw code, and never claim it failed.
            return input.subject === 'message' ? t('errors.scmMessageOutcomeUnknown') : t('errors.scmOutcomeUnknown');
        case SCM_OPERATION_ERROR_CODES.COMMAND_FAILED:
            if (looksLikeLockContention(rawError, rawFallback)) {
                return 'Another source control operation is in progress (working copy lock). Wait for it to finish and try again.';
            }
            if (rawError.includes('would be overwritten by merge')) {
                return 'Pull would overwrite local changes. Commit, stash, or discard local changes first.';
            }
            return sanitizeCommandFailureFallback(input.error, input.fallback);
        default:
            if (classifyScmOperationErrorCode(input.errorCode) === 'remote') {
                return 'Remote source control operation failed. Review remote settings and try again.';
            }
            return sanitizeCommandFailureFallback(input.error, input.fallback);
    }
}

export function isRecoverableGitIndexLockError(input: {
    success: boolean;
    errorCode?: ScmOperationErrorCode | string;
    error?: string;
    stderr?: string;
}): boolean {
    if (input.success) return false;
    if (input.errorCode === SCM_OPERATION_ERROR_CODES.INDEX_LOCKED) return true;
    if (
        input.errorCode !== SCM_OPERATION_ERROR_CODES.COMMAND_FAILED
        && input.errorCode !== SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED
    ) {
        return false;
    }
    return looksLikeLockContention(
        (input.error ?? '').toLowerCase(),
        (input.stderr ?? '').toLowerCase(),
    );
}

function sanitizeCommandFailureFallback(error: string | undefined, fallback: string): string {
    if (looksLikeRawScmOutput(error) || looksLikeRawScmOutput(fallback)) {
        return 'Source control command failed. Refresh repository status and try again.';
    }
    return fallback;
}

function looksLikeRawScmOutput(value: string | undefined): boolean {
    if (!value) return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.includes('\n')) return true;

    return /(^|\s)(fatal:|error:|remote:|hint:|usage:|pathspec|did not match any files|cannot lock ref)/i.test(trimmed);
}

function looksLikeLockContention(error: string, fallback: string): boolean {
    // Supported legacy responses carry generic codes. The protocol owns diagnostic
    // classification; current typed responses need no diagnostic interpretation.
    return mapGitScmErrorCode(`${error}\n${fallback}`) === SCM_OPERATION_ERROR_CODES.INDEX_LOCKED;
}
