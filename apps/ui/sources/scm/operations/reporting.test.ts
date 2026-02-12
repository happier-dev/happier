import { describe, expect, it, vi } from 'vitest';

import { reportSessionScmOperation, trackBlockedScmOperation } from './reporting';

describe('reportSessionScmOperation', () => {
    it('appends operation log entry and captures sanitized telemetry', () => {
        const appendSessionProjectScmOperation = vi.fn();
        const capture = vi.fn();

        reportSessionScmOperation({
            state: {
                appendSessionProjectScmOperation,
            },
            sessionId: 'session-1',
            operation: 'stage',
            status: 'failed',
            path: 'src/secret.ts',
            detail: 'fatal',
            errorCode: 'CHANGE_APPLY_FAILED',
            surface: 'file',
            tracking: { capture },
            now: 123,
        });

        expect(appendSessionProjectScmOperation).toHaveBeenCalledWith('session-1', {
            operation: 'stage',
            status: 'failed',
            path: 'src/secret.ts',
            detail: 'fatal',
            timestamp: 123,
        });

        expect(capture).toHaveBeenCalledWith('scm_operation_result', {
            operation: 'stage',
            status: 'failed',
            surface: 'file',
            error_code: 'CHANGE_APPLY_FAILED',
            error_category: 'change',
            has_path: true,
            has_detail: true,
            detail_length: 5,
        });
    });

    it('does not include sensitive detail contents in telemetry props', () => {
        const capture = vi.fn();

        reportSessionScmOperation({
            state: {
                appendSessionProjectScmOperation: vi.fn(),
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
            'scm_operation_result',
            expect.objectContaining({
                error_code: 'none',
                error_category: 'none',
            })
        );
        expect(capture).toHaveBeenCalledWith(
            'scm_operation_result',
            expect.not.objectContaining({
                detail: expect.anything(),
                path: expect.anything(),
            })
        );
    });

    it('includes raw SCM error in telemetry when explicitly provided', () => {
        const capture = vi.fn();

        reportSessionScmOperation({
            state: {
                appendSessionProjectScmOperation: vi.fn(),
            },
            sessionId: 'session-3',
            operation: 'commit',
            status: 'failed',
            detail: 'Source control command failed',
            errorCode: 'COMMAND_FAILED',
            rawError: 'fatal: unable to write new index file',
            surface: 'files',
            tracking: { capture },
            now: 789,
        });

        expect(capture).toHaveBeenCalledWith(
            'scm_operation_result',
            expect.objectContaining({
                raw_error: 'fatal: unable to write new index file',
                raw_error_length: 37,
            })
        );
    });
});

describe('trackBlockedScmOperation', () => {
    it('captures blocked operation reason with sanitized props', () => {
        const capture = vi.fn();

        trackBlockedScmOperation({
            operation: 'push',
            reason: 'preflight',
            message: 'Worktree is dirty',
            surface: 'files',
            tracking: { capture },
        });

        expect(capture).toHaveBeenCalledWith('scm_operation_blocked', {
            operation: 'push',
            reason: 'preflight',
            surface: 'files',
            has_message: true,
            message_length: 17,
        });
    });
});
