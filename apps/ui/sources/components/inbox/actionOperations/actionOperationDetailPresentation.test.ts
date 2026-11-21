import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { MachineAgentIsolationPreviewResultV1Schema } from '@happier-dev/protocol';
import isolationPreviews from '../../../../../../packages/tests/fixtures/machines/agentIsolationRecoveryPreviews.json';

import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';

import { projectActionOperationDetail, projectAgentIsolationRecovery, projectMachineSetupStepChecklist, readMachineSetupRunFailure } from './actionOperationDetailPresentation';

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
    it('shows an opaque child policy refusal with the required and requested surfaces', () => {
        const reason = 'Approval required by happier.machine.lima/actions/acquire; required surface: ui; requested surface: ui.';
        const detail = projectActionOperationDetail(operation({ actionId: 'machines.managed.bootstrap.retry',
            state: 'failed', settledAt: 2_000, error: { errorCode: 'credential_scope_denied', error: reason,
                failureCause: { phase: 'deployment.reviewed_child', errorClass: 'Error', errorCode: 'approval_required', httpStatus: null } },
        }), 'available');
        expect(detail.failure?.reason).toBe(reason);
        expect(detail.failure?.technicalLines).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'failure-code', value: 'credential_scope_denied' }),
            expect.objectContaining({ key: 'failure-cause-code', value: 'approval_required' }),
        ]));
    });
    it('uses a retained Action failure instead of its coarse settlement summary', () => {
        const detail = projectActionOperationDetail(operation({ state: 'failed', settledAt: 2_000,
            error: { errorCode: 'credential_unavailable', error: 'credential_unavailable' },
            result: { ok: false, code: 'credential_unavailable', message: 'Sign in to Docker: run sbx login', retryable: true },
        }), 'available');
        expect(detail.failure?.reason).toBe('Sign in to Docker: run sbx login');
    });
    it('shows the retained exhausted-pool cause using the shared Action result presenter', () => {
        const detail = projectActionOperationDetail(operation({ actionId: 'session.spawn_new', state: 'failed', settledAt: 2_000,
            requestId: 'pool-request', error: { errorCode: 'spawn_failed', error: 'spawn_failed' },
            result: { type: 'error', code: 'spawn_failed', retryable: false,
                launchError: { kind: 'launch_error', code: 'connected_service_auth_group_exhausted', message: 'Pool has no eligible account',
                    connectedAccountPool: { serviceId: 'openai-codex', excluded: [
                        { profileId: 'spent-account', reason: 'quota_exhausted' },
                    ] } } },
        }), 'available');
        expect(detail.failure?.reason).toBe('No fallback account is available: 1 is used up');
        expect(detail.failure?.technicalLines).toContainEqual(expect.objectContaining({ value: 'pool-request' }));
    });

    it('shows retained Setup command failure evidence through the shared failure presenter', () => {
        const detail = projectActionOperationDetail(operation({ actionId: 'machines.setup.apply', state: 'failed',
            requestId: 'setup-request', settledAt: 2_000,
            domainRef: { kind: 'machineSetup', serverId: 'home', machineId: 'machine-1' },
            error: { errorCode: 'machine_setup_setup_failed', error: 'machine_setup_setup_failed',
                details: { kind: 'finiteCommand', phase: 'setup', step: 1, exitCode: 23, signal: 0 } },
        }), 'available');
        expect(detail.failure?.reason).toBe(t('localServices.actions.failure.exitCode', { code: '23' }));
        expect(detail.failure?.technicalLines).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'failure-phase', value: 'setup' }),
            expect.objectContaining({ key: 'failure-step', value: '2' }),
            expect.objectContaining({ key: 'failure-native-exit-code', value: '23' }),
            expect.objectContaining({ key: 'failure-request-id', value: 'setup-request' }),
        ]));
    });
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
        ['machine_network_review_required', 'errors.machineNetworkReviewRequired'],
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
        ['qualificationPending', 'needs'],
        ['effective', 'satisfied'],
    ] as const)('projects the registered %s CHECK as %s despite retained root and ancestor inventories', (name, kind) => {
        const preview = MachineAgentIsolationPreviewResultV1Schema.parse(isolationPreviews[name]);
        expect(projectAgentIsolationRecovery({ enabled: true, preview }, 'machine')).toMatchObject({ kind });
    });

    it('keeps native changes, runtime replacement, and failed CHECKs distinct from settled isolation', () => {
        const effective = MachineAgentIsolationPreviewResultV1Schema.parse(isolationPreviews.effective);
        if (effective.kind !== 'ready') throw new Error('Expected a registered ready CHECK');
        for (const plan of [
            { ...effective.plan, requiresAdmin: true },
            { ...effective.plan, sessionsToReplace: 1 },
        ]) {
            expect(projectAgentIsolationRecovery({ enabled: true, preview: { ...effective, plan } }, 'machine').kind).toBe('needs');
        }
        expect(projectAgentIsolationRecovery({ enabled: true, preview: { ...effective,
            status: { kind: 'applying', phase: 'runtime_replacement' } } }, 'machine')).toEqual({ kind: 'applying' });
        expect(projectAgentIsolationRecovery({ enabled: true, preview: { kind: 'unavailable',
            status: { kind: 'unavailable', code: 'provisioning_unavailable' } } }, 'machine')).toEqual({ kind: 'unavailable' });
        expect(projectAgentIsolationRecovery({ enabled: false, preview: { ...effective,
            policy: { enabled: false }, status: { kind: 'disabled' },
            plan: { ...effective.plan, roots: [], ancestorAcls: [] } } }, 'machine')).toEqual({ kind: 'satisfied', enabled: false });
    });

    it('retains exact reboot attendance on its Machine without inventing terminal output or restored success', () => {
        const attachment = { kind: 'machineReboot' as const, serverId: 'target-home', machineId: 'joined-guest',
            installationId: 'installation', task: { id: 'reboot-task', taskKind: 'machine.reboot.v1' as const,
                prompt: { kind: 'sudo.password' as const, adminUsername: 'operator' } } };
        const detail = projectActionOperationDetail(operation({ actionId: 'machines.reboot', state: 'running',
            scope: { accountId: 'account-1', machineId: 'joined-guest' }, domainRef: attachment,
        }), 'available');
        expect(detail).toMatchObject({ kind: 'machineReboot', machineReboot: attachment,
            projectCommand: null, machineSetup: null, nextAction: null, resultSummary: [] });
        const dispatched = projectActionOperationDetail(operation({ actionId: 'machines.reboot', state: 'running',
            scope: { accountId: 'account-1', machineId: 'joined-guest' },
            domainRef: { ...attachment, task: { id: 'reboot-task', taskKind: 'machine.reboot.v1' } },
            result: { kind: 'accepted', operation: { operationId: 'operation-1' }, bootedAt: 1_000 },
        }), 'available');
        expect(dispatched).toMatchObject({ kind: 'machineReboot',
            machineReboot: { task: { id: 'reboot-task' } }, nextAction: null, resultSummary: [] });
        expect(dispatched).not.toMatchObject({ machineReboot: { task: { prompt: expect.anything() } } });
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
        const attachment = { kind: 'machineSetup' as const, serverId: 'target-home', machineId: 'joined-guest',
            preset: { id: 'preset', revision: 4 }, managedId: 'paid', terminalId: 'setup-output',
            terminals: { install: 'install-output', setup: 'setup-output' }, exitCode: 1 };
        const detail = projectActionOperationDetail(operation({ actionId: 'machines.setup.apply', state: 'failed',
            scope: { accountId: 'account-1', machineId: 'joined-guest' }, domainRef: attachment,
            settledAt: 2_000, error: { errorCode: 'setup_failed', error: 'Exit 1' } }), 'available');
        expect(detail).toMatchObject({ kind: 'machineSetup', machineSetup: attachment });
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

    it('says where a stopped run failed with the run\'s own failure, not a coarser step reason', () => {
        const attachment = { kind: 'machineSetup' as const, serverId: 'home', machineId: 'web-2', steps: [
            { planIndex: 0, stepId: 'package-apt', label: 'Install ripgrep', state: 'failed' as const, failureCause: 'required_fact_unavailable' },
            { planIndex: 0, stepId: 'caddy', label: 'Caddy', state: 'cancelled' as const },
        ] };
        const runFailure = 'Check the selected packages and enabled apt repositories, then review and retry.';
        const checklist = projectMachineSetupStepChecklist(attachment, String, null, 'available', runFailure);
        expect(checklist?.items.map((item) => item.subtitle ?? null)).toEqual([runFailure, t('inbox.actionOperations.status.cancelled')]);
        expect(projectMachineSetupStepChecklist(attachment, String)?.items[0]?.subtitle)
            .toBe(t('machineDetailPage.security.reasons.requiredFactUnavailable'));
        // The run's failure is read from the setup owner's typed remedy; a failure without one leaves the step reason.
        const failed = (details: unknown) => operation({ actionId: 'machines.setup.apply', state: 'failed', settledAt: 2_000,
            error: { errorCode: 'required_fact_unavailable', error: 'required_fact_unavailable', details } as ActionOperationSnapshot['error'] });
        expect(readMachineSetupRunFailure(failed({ kind: 'machineSetup', failure: { kind: 'native_check_unsupported',
            reason: 'required_fact_unavailable', requiredFact: 'packageAvailability', remedy: runFailure } }))).toBe(runFailure);
        expect(readMachineSetupRunFailure(failed({ kind: 'machineSetup', failure: { kind: 'native_effect_failed' } }))).toBeNull();
    });

    it('names the failed setup script and its exit code in the checklist reason', () => {
        // The #190 setup run settled with the fourth script's finite-command failure.
        const failure = readMachineSetupRunFailure(operation({ state: 'failed', settledAt: 2_000,
            error: { errorCode: 'machine_setup_setup_failed', error: 'machine_setup_setup_failed',
                details: { kind: 'finiteCommand', phase: 'setup', step: 3, exitCode: 23, signal: 0 } },
        }));
        const checklist = projectMachineSetupStepChecklist({ kind: 'machineSetup', serverId: 'home', machineId: 'web-2', steps: [
            { planIndex: 0, stepId: 'script-4', label: { key: 'machinePresets.setup.scriptNumbered', params: { index: 4 }, fallback: 'Script 4' },
                state: 'failed', failureCause: 'machine_setup_setup_failed' },
        ] }, String, null, 'available', failure);
        expect(checklist?.items[0]?.subtitle).toContain(checklist?.items[0]?.title);
        expect(checklist?.items[0]?.subtitle).toContain('23');
    });

    it('maps reviewed setup steps onto checklist rows keyed by plan and step, with failures in words', () => {
        const attachment = { kind: 'machineSetup' as const, serverId: 'home', machineId: 'web-2', steps: [
            { planIndex: 0, stepId: 'docker', label: { key: 'recipe.docker', fallback: 'Docker' }, state: 'succeeded' as const },
            { planIndex: 1, stepId: 'docker', label: 'Docker for apps', state: 'running' as const },
            { planIndex: 1, stepId: 'caddy', label: 'Caddy', state: 'failed' as const, failureCause: 'package_manager_busy' },
            { planIndex: 1, stepId: 'audit', label: 'Audit logging', state: 'failed' as const, failureCause: 'exit_status_7' },
            { planIndex: 1, stepId: 'logs', label: 'Keep logs', state: 'cancelled' as const },
            { planIndex: 2, stepId: 'firewall', label: 'Firewall', state: 'pending' as const },
        ] };
        const checklist = projectMachineSetupStepChecklist(attachment, (label) => typeof label === 'string' ? label : (label as { fallback: string }).fallback);
        expect(checklist?.items.map((item) => [item.id, item.title, item.subtitle ?? null])).toEqual([
            ['0:docker', 'Docker', null],
            ['1:docker', 'Docker for apps', null],
            ['1:caddy', 'Caddy', t('machineDetailPage.security.reasons.packageManagerBusy')],
            ['1:audit', 'Audit logging', t('machineDetailPage.security.reasons.checkFailed')],
            ['1:logs', 'Keep logs', t('inbox.actionOperations.status.cancelled')],
            ['2:firewall', 'Firewall', null],
        ]);
        expect(checklist?.selectedIds).toEqual(checklist?.items.map((item) => item.id));
        expect(Object.fromEntries(Object.entries(checklist?.executionById ?? {}).map(([id, state]) => [id, state.status]))).toEqual({
            '0:docker': 'done', '1:docker': 'running', '1:caddy': 'error', '1:audit': 'error', '1:logs': 'idle', '2:firewall': 'queued' });
        expect(projectMachineSetupStepChecklist({ kind: 'machineSetup', serverId: 'home', machineId: 'web-2' }, String)).toBeNull();
    });

    it('associates a current typed question and private output with their running setup row only', () => {
        const attachment = { kind: 'machineSetup' as const, serverId: 'home', machineId: 'web-2', steps: [
            { planIndex: 0, stepId: 'first', label: 'First', state: 'succeeded' as const, terminalId: 'first-output' },
            { planIndex: 0, stepId: 'second', label: 'Second', state: 'running' as const, terminalId: 'second-output' },
            { planIndex: 0, stepId: 'third', label: 'Third', state: 'pending' as const },
        ] };
        const question = { id: 'current-task', taskKind: 'machine.setup.apply.v1' as const,
            prompt: { kind: 'sudo.password' as const, adminUsername: 'admin' } };
        const waiting = projectMachineSetupStepChecklist(attachment, String, question);
        expect(waiting?.items).toMatchObject([
            { id: '0:first', needsAttention: false, output: { terminalId: 'first-output' } },
            { id: '0:second', needsAttention: true, output: { kind: 'open_output', serverId: 'home', machineId: 'web-2', terminalId: 'second-output' } },
            { id: '0:third', needsAttention: false, output: null },
        ]);
        expect(projectMachineSetupStepChecklist(attachment, String)?.items.every(item => !item.needsAttention)).toBe(true);
        expect(projectMachineSetupStepChecklist({ ...attachment, steps: attachment.steps.map(step => ({ ...step, state: 'pending' as const })) },
            String, question)?.items.every(item => !item.needsAttention)).toBe(true);
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
        // Readable values are facts; structured values are kept whole behind Technical details, never a JSON row.
        expect(succeeded.resultSummary).toEqual([
            { label: 'published', value: 'true' },
            { label: 'url', value: 'https://preview.example' },
        ]);
        expect(succeeded.resultTechnicalLines).toEqual([
            { key: 'result.deployment', label: 'deployment', value: '{"region":"zrh","revision":7}' },
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

    describe('a completed backup run', () => {
        const digest = (seed: string) => seed.repeat(64).slice(0, 64);
        const manifest = (sourceId: string, kind: 'dump' | 'volume', bytes: number) => ({
            schemaVersion: 1, environmentId: 'env-1', sourceId, kind, configRevision: 1, repositoryId: digest('a'),
            snapshot: { snapshotId: digest('b'), treeId: digest('c'), hostname: 'host', time: '2026-11-13T10:00:00Z', paths: ['/data'], tags: [] },
            totalBytesProcessed: bytes, totalFilesProcessed: 3, ...(kind === 'dump' ? { producerChecksumSha256: digest('d') } : {}),
        });
        const backup = (result: unknown) => operation({
            actionId: DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, title: 'Back up deployment', state: 'succeeded', settledAt: 2_000,
            domainRef: { kind: 'deployment', serverId: 'server-1', environmentId: 'env-1', deploymentId: 'receipt-1' },
            result,
        });

        it('says what was saved, with each source and its size, and opens the Environment backups', () => {
            const detail = projectActionOperationDetail(backup({ kind: 'verified', operationId: 'operation-1',
                manifests: [manifest('db', 'dump', 2_500_000)] }), 'available');
            expect(detail.resultSummary).toEqual([{ label: 'db', value: formatMachineBytes(2_500_000, 'storage') }]);
            expect(detail.resultTechnicalLines).toEqual([]);
            expect(detail.nextAction).toEqual({ kind: 'open_deployment_backups', serverId: 'server-1', environmentId: 'env-1' });
        });

        it('names sources the way Backup settings does when the run kept its capture', () => {
            const configuration = {
                configRevision: 1, destinationRef: { pluginId: 'happier.backup-destinations', localId: 'local' }, occurrenceId: 'occurrence-1',
                config: { path: '/backups' }, credentialBindings: [],
                sources: [
                    { kind: 'dump', sourceId: 'db', service: 'postgres', consistency: 'logical' },
                    { kind: 'volume', sourceId: 'files', service: 'app', volume: 'uploads', consistency: 'stopDuringCopy' },
                ],
                ownership: { environmentId: 'env-1', prefix: 'env-1' }, retention: { kind: 'keepEverything' },
            };
            const detail = projectActionOperationDetail(backup({ kind: 'verified', operationId: 'operation-1',
                manifests: [manifest('db', 'dump', 2_500_000), manifest('files', 'volume', 40_000_000)],
                restoreCaptures: [{ source: manifest('files', 'volume', 40_000_000), sourceFormat: 'volume',
                    target: { service: 'app', adapter: 'volume-v1', volume: 'uploads' }, configuration,
                    repository: { repository: '/backups/env-1' } }],
            }), 'available');
            expect(detail.resultSummary).toEqual([
                { label: t('projects.deployments.backupSourceDump', { service: 'postgres' }), value: formatMachineBytes(2_500_000, 'storage') },
                { label: t('projects.deployments.backupSourceVolume', { service: 'app', volume: 'uploads' }), value: formatMachineBytes(40_000_000, 'storage') },
            ]);
        });
    });

});
