import { describe, expect, it, vi } from 'vitest';

import { reportSessionScmOperation, reportWorkspaceScmOperation, trackBlockedScmOperation } from './reporting';
import type { ScmOperationOutcome } from '@happier-dev/protocol/scm';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

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
            errorCode: 'CHANGE_APPLY_FAILED',
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
        }, { serverId: null });
    });

    it('retains typed recovery evidence in the log and sends only its kind to telemetry', () => {
        const appendSessionProjectScmOperation = vi.fn();
        const capture = vi.fn();
        const outcome: ScmOperationOutcome = { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN', reconciliation: { kind: 'repository_status', cwd: '/private/repo' }, nextActions: [{ kind: 'refresh' }], message: 'private diagnostics' };
        reportSessionScmOperation({ state: { appendSessionProjectScmOperation }, sessionId: 's', operation: 'commit', status: 'failed', outcome, surface: 'commit', tracking: { capture } });
        expect(appendSessionProjectScmOperation).toHaveBeenCalledWith('s', expect.objectContaining({ outcome }));
        expect(capture).toHaveBeenCalledWith('scm_operation_result', expect.objectContaining({ outcome: 'outcome_unknown', error_code: 'COMMAND_OUTCOME_UNKNOWN', error_category: 'command' }), { serverId: null });
        expect(JSON.stringify(capture.mock.calls)).not.toContain('/private/repo');
        expect(JSON.stringify(capture.mock.calls)).not.toContain('private diagnostics');
    });

    it('sends telemetry without detail contents or the raw SCM error, and codes a success as none', () => {
        const capture = vi.fn();
        const state = { appendSessionProjectScmOperation: vi.fn() };

        reportSessionScmOperation({
            state, sessionId: 'session-2', operation: 'commit', status: 'success',
            detail: 'abc123def456', surface: 'files', tracking: { capture },
        });
        reportSessionScmOperation({
            state, sessionId: 'session-3', operation: 'commit', status: 'failed',
            detail: 'Source control command failed', errorCode: 'COMMAND_FAILED',
            rawError: 'fatal: unable to write new index file', surface: 'files', tracking: { capture },
        });

        expect(capture.mock.calls).toEqual([
            ['scm_operation_result', {
                operation: 'commit', status: 'success', surface: 'files', error_code: 'none', error_category: 'none',
                has_path: false, has_detail: true, detail_length: 12,
            }, { serverId: null }],
            ['scm_operation_result', {
                operation: 'commit', status: 'failed', surface: 'files', error_code: 'COMMAND_FAILED', error_category: 'command',
                has_path: false, has_detail: true, detail_length: 29,
            }, { serverId: null }],
        ]);
    });
});

describe('reportWorkspaceScmOperation', () => {
    it('appends operation log entry and captures sanitized telemetry', () => {
        const appendWorkspaceScmOperation = vi.fn();
        const capture = vi.fn();

        reportWorkspaceScmOperation({
            state: {
                appendWorkspaceScmOperation,
            },
            scope: { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' },
            operation: 'commit',
            status: 'success',
            detail: 'abc123',
            surface: 'files',
            tracking: { capture },
            now: 321,
        });

        expect(appendWorkspaceScmOperation).toHaveBeenCalledWith(
            expect.objectContaining({ machineId: 'machine-1', rootPath: '/repo' }),
            {
                operation: 'commit',
                status: 'success',
                detail: 'abc123',
                timestamp: 321,
            },
        );

        expect(capture).toHaveBeenCalledWith(
            'scm_operation_result',
            expect.objectContaining({
                operation: 'commit',
                status: 'success',
                surface: 'files',
            }),
            // The event belongs to the workspace's server, which decides its server_kind.
            { serverId: 'server-1' },
        );
    });

    it('retains the canonical outcome in the shared workspace operation log', () => {
        projectManager.clear();
        projectManager.addSession(createSessionFixture({ id: 's1', metadata: { machineId: 'm1', path: '/repo', host: 'h' } }));
        const scope = projectManager.getProjectForSession('s1')!.key;
        const outcome: ScmOperationOutcome = { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN', reconciliation: { kind: 'remote_ref', remote: 'origin' }, nextActions: [{ kind: 'refresh' }] };
        reportWorkspaceScmOperation({ state: { appendWorkspaceScmOperation: (target, entry) => { projectManager.appendWorkspaceScmOperation(target, entry); } }, scope, operation: 'push', status: 'failed', surface: 'update', outcome });
        expect(projectManager.getWorkspaceScmOperationLog(scope)[0]).toMatchObject({ outcome });
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
