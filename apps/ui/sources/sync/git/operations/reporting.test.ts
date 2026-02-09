import { describe, expect, it, vi } from 'vitest';

import { reportSessionGitOperation, trackBlockedGitOperation } from './reporting';

describe('reportSessionGitOperation', () => {
    it('appends operation log entry and captures sanitized telemetry', () => {
        const appendSessionProjectGitOperation = vi.fn();
        const capture = vi.fn();

        reportSessionGitOperation({
            state: {
                appendSessionProjectGitOperation,
            },
            sessionId: 'session-1',
            operation: 'stage',
            status: 'failed',
            path: 'src/secret.ts',
            detail: 'fatal',
            errorCode: 'PATCH_APPLY_FAILED',
            surface: 'file',
            tracking: { capture },
            now: 123,
        });

        expect(appendSessionProjectGitOperation).toHaveBeenCalledWith('session-1', {
            operation: 'stage',
            status: 'failed',
            path: 'src/secret.ts',
            detail: 'fatal',
            timestamp: 123,
        });

        expect(capture).toHaveBeenCalledWith('git_operation_result', {
            operation: 'stage',
            status: 'failed',
            surface: 'file',
            error_code: 'PATCH_APPLY_FAILED',
            has_path: true,
            has_detail: true,
            detail_length: 5,
        });
    });

    it('does not include sensitive detail contents in telemetry props', () => {
        const capture = vi.fn();

        reportSessionGitOperation({
            state: {
                appendSessionProjectGitOperation: vi.fn(),
            },
            sessionId: 'session-2',
            operation: 'commit',
            status: 'success',
            detail: 'abc123def456',
            surface: 'files',
            tracking: { capture },
            now: 456,
        });

        expect(capture).toHaveBeenCalledWith(
            'git_operation_result',
            expect.not.objectContaining({
                detail: expect.anything(),
                path: expect.anything(),
            })
        );
    });
});

describe('trackBlockedGitOperation', () => {
    it('captures blocked operation reason with sanitized props', () => {
        const capture = vi.fn();

        trackBlockedGitOperation({
            operation: 'push',
            reason: 'preflight',
            message: 'Worktree is dirty',
            surface: 'files',
            tracking: { capture },
        });

        expect(capture).toHaveBeenCalledWith('git_operation_blocked', {
            operation: 'push',
            reason: 'preflight',
            surface: 'files',
            has_message: true,
            message_length: 17,
        });
    });
});
