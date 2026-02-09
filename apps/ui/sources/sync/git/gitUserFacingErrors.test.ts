import { describe, expect, it } from 'vitest';

import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { getGitUserFacingError } from './gitUserFacingErrors';

describe('getGitUserFacingError', () => {
    it('maps known git error codes to stable user-facing messages', () => {
        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                fallback: 'Failed operation',
            })
        ).toContain('upstream');

        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                fallback: 'Failed operation',
            })
        ).toContain('conflicts');

        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.PATCH_APPLY_FAILED,
                fallback: 'Failed operation',
            })
        ).toContain('Diff changed');

        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
                fallback: 'Failed operation',
            })
        ).toMatch(/fetch/i);

        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED,
                fallback: 'Failed operation',
            })
        ).toContain('fast-forward');

        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_REJECTED,
                fallback: 'Failed operation',
            })
        ).toContain('rejected');

        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
                fallback: 'Failed operation',
            })
        ).toContain('remote');
    });

    it('falls back to a provided fallback message for unknown or missing codes', () => {
        expect(
            getGitUserFacingError({
                errorCode: undefined,
                error: 'some low-level error',
                fallback: 'Failed to push',
            })
        ).toBe('Failed to push');
    });

    it('does not surface raw git stderr when command failures bubble low-level output', () => {
        const message = getGitUserFacingError({
            errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: 'fatal: pathspec \'tmp file\' did not match any files',
            fallback: 'fatal: pathspec \'tmp file\' did not match any files',
        });

        expect(message).toBe('Git command failed. Refresh repository status and try again.');
    });

    it('surfaces a specific hint when pull/merge would overwrite local changes', () => {
        const message = getGitUserFacingError({
            errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: 'error: Your local changes to the following files would be overwritten by merge:\n\tapp.ts\nPlease commit your changes or stash them before you merge.',
            fallback: 'error: Your local changes to the following files would be overwritten by merge.',
        });

        expect(message).toContain('would overwrite local changes');
    });

    it('surfaces a specific hint for repository rules rejections', () => {
        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_REJECTED,
                error: 'remote: error: GH013: Repository rule violations found',
                fallback: 'Failed operation',
            })
        ).toContain('repository rules');
    });

    it('surfaces a specific hint for unsupported merge-commit revert requests', () => {
        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Reverting merge commits is not supported yet.',
                fallback: 'Failed operation',
            })
        ).toContain('merge commits');
    });

    it('surfaces a specific hint for detached-head remote operation requests', () => {
        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Push is unavailable while HEAD is detached',
                fallback: 'Failed operation',
            })
        ).toContain('detached');
    });

    it('surfaces a specific hint for overlong commit message requests', () => {
        expect(
            getGitUserFacingError({
                errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Commit message exceeds maximum length of 4096 characters',
                fallback: 'Failed operation',
            })
        ).toContain('too long');
    });
});
