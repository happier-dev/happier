import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { ScmOperationErrorCodeSchema } from '@happier-dev/protocol/scm';

import { getScmUserFacingError, isRecoverableGitIndexLockError } from './scmUserFacingErrors';
import { t } from '@/text';

describe('getScmUserFacingError', () => {
    it.each(['machine_manage_required', 'credential_scope_denied'])('presents %s as a permission refusal rather than backend unavailability', (actionErrorCode) => {
        const refusal = {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
            actionErrorCode,
            error: 'Source control command failed. Refresh repository status and try again.',
        };
        expect(getScmUserFacingError({ ...refusal, fallback: 'Failed operation' }))
            .toBe(t('errors.permissionDenied'));
    });
    it('explains a missing root without blaming the source control tool', () => {
        expect(getScmUserFacingError({ errorCode: ScmOperationErrorCodeSchema.parse('ROOT_NOT_FOUND'), fallback: 'Git unavailable' }))
            .toContain('folder');
    });
    it('maps known scm error codes to stable user-facing messages', () => {
        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                fallback: 'Failed operation',
            })
        ).toContain('tracking');

        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                fallback: 'Failed operation',
            })
        ).toContain('conflicts');

        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
                fallback: 'Failed operation',
            })
        ).toContain('Diff changed');

        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
                fallback: 'Failed operation',
            })
        ).toMatch(/fetch/i);

        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED,
                fallback: 'Failed operation',
            })
        ).toContain('fast-forward');

        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED,
                fallback: 'Failed operation',
            })
        ).toContain('rejected');

        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
                fallback: 'Failed operation',
            })
        ).toContain('remote');
    });

    it('falls back to a provided fallback message for unknown or missing codes', () => {
        expect(
            getScmUserFacingError({
                errorCode: undefined,
                error: 'some low-level error',
                fallback: 'Failed to push',
            })
        ).toBe('Failed to push');
    });

    it('does not surface raw scm stderr when command failures bubble low-level output', () => {
        const message = getScmUserFacingError({
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: 'fatal: pathspec \'tmp file\' did not match any files',
            fallback: 'fatal: pathspec \'tmp file\' did not match any files',
        });

        expect(message).toBe('Source control command failed. Refresh repository status and try again.');
    });

    it('surfaces a specific hint when working-copy lock contention is detected', () => {
        const message = getScmUserFacingError({
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            fallback: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
        });

        expect(message).toContain('Another source control operation is in progress');
    });

    it('surfaces lock contention when patch apply fails because index.lock exists', () => {
        const message = getScmUserFacingError({
            errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
            error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            fallback: 'Diff changed, refresh and reselect your lines.',
        });

        expect(message).toContain('Another source control operation is in progress');
    });

    it('exposes lock contention as a stable recoverability predicate', () => {
        expect(
            isRecoverableGitIndexLockError({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
                stderr: 'Another git process seems to be running in this repository.',
            })
        ).toBe(true);

        expect(
            isRecoverableGitIndexLockError({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED,
                error: 'remote rejected',
            })
        ).toBe(false);
    });

    it('surfaces a specific hint when pull/merge would overwrite local changes', () => {
        const message = getScmUserFacingError({
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: 'error: Your local changes to the following files would be overwritten by merge:\n\tapp.ts\nPlease commit your changes or stash them before you merge.',
            fallback: 'error: Your local changes to the following files would be overwritten by merge.',
        });

        expect(message).toContain('would overwrite local changes');
    });

    it('surfaces a specific hint for repository rules rejections', () => {
        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED,
                error: 'remote: error: GH013: Repository rule violations found',
                fallback: 'Failed operation',
            })
        ).toContain('repository rules');
    });

    it('surfaces a specific hint for unsupported merge-commit revert requests', () => {
        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Reverting merge commits is not supported yet.',
                fallback: 'Failed operation',
            })
        ).toContain('merge commits');
    });

    it('surfaces a specific hint for detached-head remote operation requests', () => {
        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Push is unavailable while HEAD is detached',
                fallback: 'Failed operation',
            })
        ).toContain('detached');
    });

    it('surfaces a specific hint for overlong commit message requests', () => {
        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Commit message exceeds maximum length of 4096 characters',
                fallback: 'Failed operation',
            })
        ).toContain('too long');
    });

    it('maps backend unavailable errors to deterministic copy', () => {
        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
                error: 'Sapling binary missing',
                fallback: 'Failed operation',
            })
        ).toBe('The active source control backend is unavailable.');
    });

    it('maps unsupported feature errors to deterministic copy', () => {
        expect(
            getScmUserFacingError({
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'Unsupported operation',
                fallback: 'Failed operation',
            })
        ).toContain('not supported');
    });
    it('says an unconfirmed outcome could not be confirmed instead of echoing the raw code', () => {
        const code = SCM_OPERATION_ERROR_CODES.COMMAND_OUTCOME_UNKNOWN;
        const message = getScmUserFacingError({ errorCode: code, error: code, fallback: code });
        expect(message).not.toContain(code);
        expect(message).toBe(t('errors.scmOutcomeUnknown'));
        expect(getScmUserFacingError({ errorCode: code, error: code, fallback: code, subject: 'message' })).toBe(t('errors.scmMessageOutcomeUnknown'));
    });
    it('says a missing pull request is missing, not a missing remote, and never echoes the adapter text', () => {
        const message = getScmUserFacingError({ errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
            error: 'GitHub pull request resource was not found', fallback: 'Read failed', subject: 'pullRequest' });
        expect(message).toBe(t('errors.scmPullRequestNotFound'));
        expect(message).not.toBe(getScmUserFacingError({ errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND, fallback: 'Read failed' }));
    });
});
