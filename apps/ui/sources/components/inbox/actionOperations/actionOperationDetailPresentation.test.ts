import { describe, expect, it } from 'vitest';
import { t } from '@/text';

import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

import { projectActionOperationDetail } from './actionOperationDetailPresentation';

type ActionOperationSnapshot = ActionOperationProjection['snapshot'];

function operation(overrides: Partial<ActionOperationSnapshot> = {}): ActionOperationSnapshot {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: 1,
        actionId: 'acme.preview/deploy',
        state: 'running',
        scope: { accountId: 'account-1', machineId: 'machine-1' },
        title: 'Deploy preview',
        createdAt: 1_000,
        startedAt: 1_010,
        cancellation: 'unsupported',
        ...overrides,
    };
}

describe('action operation detail presentation', () => {
    it.each([undefined, 'Refresh apt package indexes, then review and retry.'])('shows the native owner recovery when supplied (%s)', remedy => {
        const detail = projectActionOperationDetail(operation({ actionId: 'machines.setup.apply', state: 'failed',
            settledAt: 2_000, error: { errorCode: 'native_check_unsupported', error: 'native_check_unsupported',
                details: { kind: 'machineSetup', failure: { kind: 'native_check_unsupported',
                    reason: 'required_fact_unavailable', requiredFact: 'packageAvailability', ...(remedy ? { remedy } : {}) } } },
        }), 'available');
        expect(detail.failure?.reason).toBe(remedy ?? t('errors.machineNativeCheckUnsupported'));
        expect(detail.failure?.technicalLines).toContainEqual({ key: 'failure-code', label: t('common.error'), value: 'native_check_unsupported' });
    });

    it.each([
        ['machine_admin_access_required', 'errors.machineAdminAccessRequired'],
        ['managed_cli_unavailable', 'errors.machineManagedCliUnavailable'],
    ] as const)('explains refused Domain setup %s while keeping its typed code in Technical details', (errorCode, messageKey) => {
        const detail = projectActionOperationDetail(operation({ actionId: 'deployments.domains.add', state: 'failed',
            settledAt: 2_000, error: { errorCode, error: errorCode },
        }), 'available');
        expect(detail.failure).toEqual({
            reason: t(messageKey),
            technicalLines: [{ key: 'failure-code', label: t('common.error'), value: errorCode }],
        });
    });

    it.each([
        ['projects.script.run', 'script', 'project_command_step_failed'],
        ['projects.setup.apply', 'setup', 'project_setup_step_failed'],
    ] as const)('presents the observed process exit for %s', (actionId, purpose, errorCode) => {
        const detail = projectActionOperationDetail(operation({ actionId, state: 'failed', settledAt: 2_000,
            domainRef: { kind: 'projectCommand', purpose, serverId: 'target-home', machineId: 'worker',
                workspaceRefId: 'workspace', cwd: '/project', terminalId: 'terminal', exitCode: 17 },
            error: { errorCode, error: errorCode },
        }), 'available');
        expect(detail.failure).toEqual({
            reason: t('localServices.actions.failure.exitCode', { code: '17' }),
            technicalLines: [{ key: 'failure-code', label: t('common.error'), value: errorCode }],
        });
    });

    it('does not infer a process exit without the typed failure and observed exit code together', () => {
        const attachment = { kind: 'projectCommand' as const, purpose: 'script' as const,
            serverId: 'target-home', machineId: 'worker', workspaceRefId: 'workspace', cwd: '/project', terminalId: 'terminal' };
        for (const snapshot of [
            { domainRef: attachment, error: { errorCode: 'project_command_step_failed', error: 'project_command_step_failed' } },
            { domainRef: { ...attachment, exitCode: 17 }, error: { errorCode: 'output_unavailable', error: 'Output could not be retained' } },
        ]) {
            const detail = projectActionOperationDetail(operation({ ...snapshot, state: 'failed', settledAt: 2_000 }), 'available');
            expect(detail.failure?.reason).toBe(snapshot.error.errorCode === 'project_command_step_failed'
                ? t('inbox.actionOperations.failureGeneric') : 'Output could not be retained');
        }
    });

    it('uses the shared typed setup failure copy for managed installation operations', () => {
        const detail = projectActionOperationDetail(operation({
            actionId: 'machines.managed.acquire', state: 'failed', settledAt: 2_000,
            error: { errorCode: 'remote_cli_update_required', error: 'legacy daemon diagnostic' },
        }), 'available');
        expect(detail.failure?.reason).toBe(t('setupOnboarding.remoteSshChecklist.remoteCliUpdateRequired'));
    });

    it('keeps machine setup output on its exact joined target without inventing a Project', () => {
        const attachment = { kind: 'machineEnvironment' as const, serverId: 'target-home', machineId: 'joined-guest',
            preset: { id: 'preset', revision: 4 }, managedId: 'paid', terminalId: 'setup-output',
            terminals: { install: 'install-output', setup: 'setup-output' }, exitCode: 1 };
        const detail = projectActionOperationDetail(operation({ actionId: 'machines.environment.apply', state: 'failed',
            scope: { accountId: 'account-1', machineId: 'joined-guest' }, domainRef: attachment,
            settledAt: 2_000, error: { errorCode: 'setup_failed', error: 'Exit 1' } }), 'available');
        expect(detail).toMatchObject({ kind: 'machineEnvironment', machineEnvironment: attachment });
        expect(detail.nextAction).toEqual({ kind: 'open_output', serverId: 'target-home', machineId: 'joined-guest', terminalId: 'setup-output' });
    });
    it('retains exact command output targets before exit and after failure or cancellation', () => {
        const attachment = {
            kind: 'projectCommand' as const, purpose: 'script' as const,
            serverId: 'target-home', machineId: 'worker', workspaceRefId: 'workspace',
            cwd: '/project', terminalId: 'terminal',
            originRun: { kind: 'workflow_run' as const, serverId: 'workflow-home', runId: 'run' },
        };
        for (const state of ['accepted', 'failed', 'cancelled'] as const) {
            const detail = projectActionOperationDetail(operation({
                actionId: 'projects.script.run', state, domainRef: attachment,
                ...(state === 'accepted' ? { startedAt: undefined } : { settledAt: 2_000 }),
                ...(state === 'failed' ? { error: { errorCode: 'process_exited', error: 'Exit 1' } } : {}),
            }), 'available');
            expect(detail).toMatchObject({ kind: 'projectCommand', projectCommand: attachment });
            expect(detail.nextAction).toEqual({ kind: 'open_output', serverId: 'target-home', machineId: 'worker',
                workspaceRefId: 'workspace', cwd: '/project', terminalId: 'terminal' });
            expect(detail.canCancel).toBe(false);
        }
    });

    it('projects fork strategy, created child, and unavailable-status recovery from canonical references', () => {
        const completed = projectActionOperationDetail(operation({
            actionId: 'session.fork',
            state: 'succeeded',
            settledAt: 2_000,
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'parent-session' },
            domainRef: { kind: 'forkRequest', id: 'fork-request-1' },
            result: { childSessionId: 'child-session', strategy: 'replay' },
        }), 'available');

        expect(completed.kind).toBe('fork');
        expect(completed.fields).toEqual(expect.arrayContaining([
            { id: 'strategy', value: 'replay' },
            { id: 'result', value: 'child-session' },
        ]));
        expect(completed.nextAction).toEqual({ kind: 'open_session', sessionId: 'child-session' });

        const unavailable = projectActionOperationDetail(operation({
            actionId: 'session.fork',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'parent-session' },
            domainRef: { kind: 'forkRequest', id: 'fork-request-1' },
        }), 'unavailable');
        expect(unavailable.recovery).toEqual({
            kind: 'fork_lineage',
            referenceId: 'fork-request-1',
            sessionId: 'parent-session',
        });
        expect(unavailable.nextAction).toEqual({ kind: 'open_session', sessionId: 'parent-session' });
    });

    it('projects spawn settlement and offers an explicit Open session destination', () => {
        const detail = projectActionOperationDetail(operation({
            actionId: 'session.spawn_new',
            state: 'succeeded',
            settledAt: 2_000,
            domainRef: { kind: 'spawnAttempt', id: 'spawn-attempt-1' },
            result: {
                type: 'success',
                disposition: 'rejoined',
                sessionId: 'spawned-session',
            },
        }), 'available');

        expect(detail.kind).toBe('spawn');
        expect(detail.fields).toEqual(expect.arrayContaining([
            { id: 'result', value: 'rejoined' },
            { id: 'session', value: 'spawned-session' },
        ]));
        expect(detail.nextAction).toEqual({ kind: 'open_session', sessionId: 'spawned-session' });
    });

    it('projects handoff phase, recovery state, and source-cleanup success warning', () => {
        const detail = projectActionOperationDetail(operation({
            actionId: 'session.handoff',
            state: 'succeeded',
            settledAt: 2_000,
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            progress: { kind: 'phase', phase: 'cleaning_source', label: 'Cleaning up source' },
            domainRef: { kind: 'handoff', id: 'handoff-1', targetMachineId: 'machine-target' },
            result: {
                handoffId: 'handoff-1',
                status: 'completed',
                recoveryActions: ['restart_on_source'],
                warning: { code: 'source_cleanup_failed', message: 'cleanup_failed' },
            },
        }), 'available');

        expect(detail.kind).toBe('handoff');
        expect(detail.fields).toEqual(expect.arrayContaining([
            { id: 'phase', value: 'Cleaning up source' },
            { id: 'result', value: 'completed' },
        ]));
        expect(detail.recovery).toEqual({ kind: 'handoff', actions: ['restart_on_source'] });
        expect(detail.warning).toEqual({
            code: 'source_cleanup_failed',
            message: 'cleanup_failed',
        });
    });

    it('exposes the existing handoff resume flow only from the canonical resumable phase and domain id', () => {
        const detail = projectActionOperationDetail(operation({
            actionId: 'session.handoff',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            progress: { kind: 'phase', phase: 'awaiting_user_resume', label: 'Ready to resume' },
            domainRef: { kind: 'handoff', id: 'handoff-1', targetMachineId: 'machine-target' },
        }), 'available');

        expect(detail.nextAction).toEqual({
            kind: 'resume_handoff',
            handoffId: 'handoff-1',
            sessionId: 'session-1',
            targetMachineId: 'machine-target',
        });
        expect(projectActionOperationDetail(operation({
            actionId: 'session.handoff',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            progress: { kind: 'phase', phase: 'awaiting_user_resume', label: 'Ready to resume' },
        }), 'available').nextAction).toBeNull();
        expect(projectActionOperationDetail(operation({
            actionId: 'session.handoff',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            progress: { kind: 'phase', phase: 'awaiting_user_resume', label: 'Ready to resume' },
            domainRef: { kind: 'handoff', id: 'handoff-1' },
        }), 'available').nextAction).toBeNull();
    });

    it('uses the standard host summary for validated plugin results and errors', () => {
        const succeeded = projectActionOperationDetail(operation({
            state: 'succeeded',
            settledAt: 2_000,
            result: {
                url: 'https://preview.example',
                deployment: { region: 'zrh', revision: 7 },
                published: true,
            },
        }), 'available');
        expect(succeeded.kind).toBe('plugin');
        expect(succeeded.resultSummary).toEqual([
            { label: 'deployment', value: '{"region":"zrh","revision":7}' },
            { label: 'published', value: 'true' },
            { label: 'url', value: 'https://preview.example' },
        ]);

        const failed = projectActionOperationDetail(operation({
            state: 'failed',
            settledAt: 2_000,
            error: {
                errorCode: 'plugin_publish_failed',
                error: 'Preview publishing failed',
            },
        }), 'available');
        // The sentence leads and appears once; the typed code waits for Technical details.
        expect(failed.failure).toEqual({
            reason: 'Preview publishing failed',
            technicalLines: [{ key: 'failure-code', label: t('common.error'), value: 'plugin_publish_failed' }],
        });

        // A bare machine code is never the words: a failure with no sentence reads neutrally, a busy Home reads as busy.
        expect(projectActionOperationDetail(operation({
            state: 'failed', settledAt: 2_000,
            error: { errorCode: 'plugin_publish_failed', error: 'plugin_publish_failed' },
        }), 'available').failure?.reason).toBe(t('inbox.actionOperations.failureGeneric'));
        expect(projectActionOperationDetail(operation({
            state: 'failed', settledAt: 2_000,
            error: { errorCode: 'database_transaction_conflict_exhausted', error: 'database_transaction_conflict_exhausted' },
        }), 'available').failure).toEqual({
            reason: t('approvals.transientFailure'),
            technicalLines: [{ key: 'failure-code', label: t('common.error'), value: 'database_transaction_conflict_exhausted' }],
        });
    });

    it('never offers cancellation when the canonical snapshot says it is unsupported', () => {
        expect(projectActionOperationDetail(operation({ cancellation: 'unsupported' }), 'available').canCancel)
            .toBe(false);
        expect(projectActionOperationDetail(operation({ cancellation: 'supported' }), 'available').canCancel)
            .toBe(true);
        expect(projectActionOperationDetail(operation({
            state: 'succeeded',
            settledAt: 2_000,
            cancellation: 'supported',
        }), 'available').canCancel).toBe(false);
    });
    it('opens the canonical external session for recovery and derives Stop from owner availability', () => {
        const external = operation({ actionId: 'sessions.external.takeover.start', cancellation: 'supported',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'external-session' },
            progress: { kind: 'phase', phase: 'awaiting_user_resume', label: 'Needs resume' } });
        expect(projectActionOperationDetail(external, 'available')).toMatchObject({ nextAction: { kind: 'open_session', sessionId: 'external-session' }, canCancel: true });
        expect(projectActionOperationDetail(external, 'unavailable').canCancel).toBe(false);
    });

});
