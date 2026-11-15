import { describe, expect, it, vi } from 'vitest';
import type { AgentActivityStatusV1 } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityStatusV1';
import type { WorkerUpdateV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { describeWorkflowInvocationLifecycle, describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { describeWorkerUpdateState, resolveWorkStatusTone } from './resolveWorkStatusTone';
import { t } from '@/text';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

describe('resolveWorkStatusTone', () => {
    it('keeps classified managed sleep and wake on nonterminal runs without hiding outcomes or attention', () => {
        for (const nativeState of ['asleep', 'starting'] as const) {
            const machineStatus = resolveWorkStatusTone({ kind: 'machine', facts: {
                online: false, nativeState, word: 'Offline', machineName: 'Build box', needsYouCount: 0, runningSessionCount: 0,
            } });
            const facts = { state: 'running', word: 'Running', machineReachable: false, machineStatus } as const;
            expect(resolveWorkStatusTone({ kind: 'workflow_run', facts })).toEqual(machineStatus);
            expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { ...facts, cancelRequested: true } })).toEqual(machineStatus);
            expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { ...facts, state: 'succeeded' } }))
                .toMatchObject({ state: 'succeeded', bucket: 'finished' });
            expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { ...facts, inAttentionWindow: true } }))
                .toMatchObject({ state: 'running', bucket: 'needs_you' });
            expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { ...facts, state: 'failed', failureUnseen: true } }))
                .toMatchObject({ state: 'failed', tone: 'danger', bucket: 'finished' });
        }
    });
    it('uses current authorized teammate work without treating unavailable or stale summaries as idle', () => {
        const facts = { online: true, needsYouCount: 0, runningSessionCount: 0, word: 'Online' };
        const summary = { kind: 'summary', summary: { kind: 'current', requesters: [
            { accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 },
        ] } } as const;
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, workSummary: summary } }))
            .toMatchObject({ bucket: 'working', tone: 'neutral' });
        for (const workSummary of [{ ...summary, stale: 'unavailable' }, { kind: 'summary', summary: { kind: 'unavailable' } },
            { kind: 'loading' }] as const) {
            expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, workSummary } }))
                .toMatchObject({ state: 'unknown', word: t('common.unknown') });
        }
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, workSummary: { kind: 'denied' } } }).bucket).toBe('idle');
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts,
            workSummary: { kind: 'summary', summary: { kind: 'current', requesters: [] } } } }).bucket).toBe('idle');
    });
    it('keeps the unseen failure signal independent of an actionable request and Workflow acknowledgement', () => {
        const awareness = { runtime: 'offline', operational: { primary: 'permission_required', reasons: ['permission_required'] } } as const;
        const viewer = { attention: { needsAttention: true, reasons: ['failed', 'permission_required'], primary: 'failed', presentation: 'full' } } as const;
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness, viewer, attentionType: 'approval', word: 'Failed',
        } })).toMatchObject({ state: 'failed', tone: 'danger', attentionType: 'approval' });
        const run = { state: 'failed', word: 'Failed', inAttentionWindow: true, invocationAttentionRequired: false } as const;
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { ...run, failureUnseen: true } }))
            .toMatchObject({ state: 'failed', bucket: 'finished', tone: 'danger', attentionType: 'update' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { ...run, failureUnseen: true, invocationAttentionRequired: true } }))
            .toMatchObject({ state: 'failed', bucket: 'needs_you', tone: 'danger', attentionType: 'decision' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { ...run, inAttentionWindow: false, failureUnseen: false } }))
            .toMatchObject({ state: 'failed', bucket: 'finished', tone: 'neutral', attentionType: null });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { ...run, failureUnseen: false, invocationAttentionRequired: true } }))
            .toMatchObject({ state: 'failed', bucket: 'needs_you', tone: 'attention', attentionType: 'decision' });
    });
    it('keeps unknown Machine presence neutral without treating retained work counts as current', () => {
        expect(resolveWorkStatusTone({ kind: 'machine', facts: {
            online: null, word: t('common.unknown'), needsYouCount: 2, runningSessionCount: 3,
        } })).toMatchObject({ bucket: 'idle', tone: 'neutral', word: t('common.unknown') });
    });
    it('classifies an unlinked task by its tracker category and linked work by the shared Session status', () => {
        const task = (category: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | null) =>
            resolveWorkStatusTone({ kind: 'task', facts: { category, word: 'Tracker state', linkedStatuses: [] } });
        expect(task('backlog').bucket).toBe('idle');
        expect(task('unstarted').bucket).toBe('idle');
        expect(task('started').bucket).toBe('working');
        expect(task('completed').bucket).toBe('finished');
        expect(task('canceled').bucket).toBe('finished');
        expect(task(null).bucket).toBe('idle');
        expect(resolveWorkStatusTone({ kind: 'task', facts: { category: 'started', linkedStatuses: [] } }))
            .toMatchObject({ bucket: 'working', word: 'workStatus.buckets.working' });
        const needsYou = { state: 'permission_required', bucket: 'needs_you', tone: 'attention', attentionType: 'approval', word: 'Permission required' } as const;
        expect(resolveWorkStatusTone({ kind: 'task', facts: {
            category: 'backlog', word: 'Backlog', linkedStatuses: [needsYou],
        } })).toEqual(needsYou);
        expect(resolveWorkStatusTone({ kind: 'task', facts: {
            category: 'completed', word: 'Completed', linkedStatuses: [
                { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' }, needsYou,
            ],
        } })).toEqual(needsYou);
    });

    it('uses retained native power for the exact enrolled Machine instead of equating disconnection with Offline', () => {
        const managed: ManagedMachineV1 = { id: 'managed-a', homeId: 'home-a', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: { id: 'retained-native' } },
            retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained' } };
        const facts = { online: false, needsYouCount: 0, runningSessionCount: 0, word: 'Offline', machineId: 'guest', managedMachine: managed };
        expect(resolveWorkStatusTone({ kind: 'machine', facts })).toMatchObject({ bucket: 'idle', tone: 'neutral', word: t('managedPower.asleep') });
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, online: null } }))
            .toMatchObject({ bucket: 'idle', tone: 'neutral', word: t('managedPower.asleep') });
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, machineId: 'other' } }).bucket).toBe('offline');
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, managedMachine: { ...managed, archivedAt: 20 } } }).bucket).toBe('offline');
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, revokedAt: 20 } }).bucket).toBe('offline');
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, managedMachine: { ...managed, observation: undefined } } }).word).not.toBe(t('managedPower.asleep'));
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, managedMachine: { ...managed, wakeOnAcceptedMessage: false } } }).word).toBe(t('managedPower.asleep'));
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, managedMachine: { ...managed, desired: 'delete' } } }).word).toBe(t('managedPower.asleep'));
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, managedMachine: { ...managed,
            submittedNativeEffect: { intent: 'start', intentRevision: 2, controller: managed.controller, requestId: 'start-a' } } } })).toMatchObject({ bucket: 'working', word: t('managedWake.starting', { machine: 'Build box' }) });
        const stopping: ManagedMachineV1 = { ...managed, observation: { ...managed.observation!, power: 'running' },
            submittedNativeEffect: { intent: 'stop', intentRevision: 1, controller: managed.controller, requestId: 'stop-a' } };
        for (const online of [true, false]) {
            expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, online, managedMachine: stopping } }))
                .toMatchObject({ bucket: 'working', tone: 'neutral', word: t('managedPower.stopPending') });
            expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, online, managedMachine: {
                ...stopping, submittedNativeEffect: undefined, cleanup: { disposition: 'unavailable', reason: 'native_refused' },
            } } })).toMatchObject({ bucket: 'needs_you', tone: 'attention' });
        }
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, online: true, managedMachine: {
            ...stopping, submittedNativeEffect: undefined, desiredWhen: 'after-idle',
        } } }).bucket).toBe('idle');
    });
    it('uses operation settlement facts and never presents lost active observation as completed', () => {
        const status = (state: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled', observation: 'available' | 'unavailable' = 'available') =>
            resolveWorkStatusTone({ kind: 'action_operation', facts: { state, observation, word: state } });
        expect(status('accepted')).toMatchObject({ bucket: 'working', tone: 'neutral', word: 'accepted' });
        expect(resolveWorkStatusTone({ kind: 'action_operation', facts: {
            state: 'accepted', observation: 'available', word: 'Needs you',
            setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed', reviewedEffect: {} },
        } })).toMatchObject({ bucket: 'needs_you', tone: 'attention', word: 'Needs you' });
        expect(status('running', 'unavailable')).toMatchObject({ bucket: 'working', tone: 'attention', word: 'running' });
        expect(status('succeeded', 'unavailable')).toMatchObject({ bucket: 'finished', tone: 'neutral', word: 'succeeded' });
        expect(status('failed')).toMatchObject({ bucket: 'finished', tone: 'danger', word: 'failed' });
        expect(status('cancelled')).toMatchObject({ bucket: 'finished', tone: 'neutral', word: 'cancelled' });
    });
    it('derives a worker update\'s tone and its state word from the update alone', () => {
        const base = { v: 1, headline: 'Check complete', result: '', canInspect: false } as const;
        const status = (update: WorkerUpdateV1) => resolveWorkStatusTone({ kind: 'worker_update', facts: { update } });
        expect(status({ ...base, workerKind: 'execution_run', workerId: 'run_1', ownerState: 'failed', wake: 'finished' }))
            .toMatchObject({ bucket: 'finished', tone: 'danger', word: t('sessionWork.workerUpdate.state.failed') });
        expect(status({ ...base, workerKind: 'execution_run', workerId: 'run_1', ownerState: 'failed', wake: 'needs_you' }))
            .toMatchObject({ bucket: 'finished', tone: 'danger', word: t('sessionWork.workerUpdate.state.failed') });
        expect(status({ ...base, workerKind: 'execution_run', workerId: 'run_1', ownerState: 'timeout', wake: 'finished' }))
            .toMatchObject({ bucket: 'finished', tone: 'attention', word: t('sessionWork.workerUpdate.state.timedOut') });
        expect(status({ ...base, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'finished' }))
            .toMatchObject({ bucket: 'finished', tone: 'neutral', word: t('sessionWork.workerUpdate.state.settled') });
        // A wake that needs the person says so, whatever the owner's last state was.
        expect(status({ ...base, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'needs_you' }))
            .toMatchObject({ bucket: 'needs_you', tone: 'attention', word: t('sessionWork.workerUpdate.state.needsYou') });
        expect(status({ ...base, workerKind: 'workflow_run', workerId: 'workflow', ownerState: 'running', wake: 'needs_you' }))
            .toMatchObject({ bucket: 'needs_you', tone: 'attention', word: t('sessionWork.workerUpdate.state.needsYou') });
        // An earlier notice the transcript has moved past is told in the past tense and stops asking, but a failure stays one.
        const earlier = (update: WorkerUpdateV1) => resolveWorkStatusTone({ kind: 'worker_update', facts: { update, earlier: true } });
        expect(earlier({ ...base, workerKind: 'session', workerId: 'worker', ownerState: 'needs_input', wake: 'needs_you' }))
            .toMatchObject({ bucket: 'finished', tone: 'neutral', word: t('sessionWork.workerUpdate.state.neededYou') });
        expect(earlier({ ...base, workerKind: 'session', workerId: 'worker', ownerState: 'failed', wake: 'needs_you' }).tone).toBe('danger');
        expect(earlier({ ...base, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'finished' }).word)
            .toBe(t('sessionWork.workerUpdate.state.settled'));
        expect(status({ ...base, workerKind: 'session', workerId: 'worker', ownerState: 'stalled', wake: 'stalled' }))
            .toMatchObject({ bucket: 'offline', tone: 'neutral', word: t('sessionWork.workerUpdate.state.stalled') });
        expect(status({ ...base, workerKind: 'session', workerId: 'worker', ownerState: 'stalled', wake: 'finished' }))
            .toMatchObject({ bucket: 'offline', tone: 'neutral', word: t('sessionWork.workerUpdate.state.stalled') });
        expect(status({ ...base, workerKind: 'workflow_run', workerId: 'workflow', ownerState: 'failed', wake: 'finished' }))
            .toMatchObject({ bucket: 'finished', tone: 'danger', word: t('sessionWork.workerUpdate.state.failed') });
        expect(status({ ...base, workerKind: 'workflow_run', workerId: 'workflow', ownerState: 'succeeded', wake: 'finished' }).word)
            .toBe(t('sessionWork.workerUpdate.state.finished'));
        // A workflow state the card has no word of its own for keeps the run owner's word.
        expect(status({ ...base, workerKind: 'workflow_run', workerId: 'workflow', ownerState: 'interrupted', wake: 'finished' }).word)
            .toBe(t('workflows.runState.interrupted'));
        expect(describeWorkerUpdateState({ workerKind: 'session', ownerState: 'published', wake: 'published' }))
            .toBe(t('sessionWork.workerUpdate.state.published'));
    });
    it('keeps healthy workflow presenters neutral', () => {
        for (const state of ['queued', 'claimed', 'running', 'pause_requested', 'paused', 'succeeded', 'cancelled', 'skipped'] as const) {
            expect(describeWorkflowRunState(state).variant).toBe('neutral');
        }
        for (const lifecycle of ['pending', 'waiting_for_capacity', 'admitting', 'running', 'completed', 'cancelled', 'skipped', 'superseded'] as const) {
            expect(describeWorkflowInvocationLifecycle(lifecycle).variant).toBe('neutral');
        }
    });

    it('keeps canonical cancellation finished while unresolved custody keeps header actions nonterminal', () => {
        const facts = { state: 'cancelled' as const, workflowCustodyState: 'pending' as const,
            machineReachable: false, machineName: 'Build box', inAttentionWindow: true, word: 'Stopped' };
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts })).toMatchObject({
            bucket: 'finished', tone: 'neutral', word: 'Stopped',
        });
        expect(describeWorkflowRunState(facts.state, facts)).toMatchObject({ terminal: false, variant: 'neutral',
            label: 'Stopped' });
        expect(resolveWorkStatusTone({ kind: 'workflow_step', facts: { lifecycle: 'cancel_requested',
            machineReachable: false, machineName: 'Build box', inAttentionWindow: true, word: 'Stopping' } }))
            .toMatchObject({ bucket: 'offline', tone: 'neutral', word: t('workflows.run.stopWhenMachineReconnects', { machine: 'Build box' }) });
    });

    it('gives attention precedence over reachability and keeps the run word', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'running', inAttentionWindow: true, machineReachable: false, word: 'Running',
        } })).toMatchObject({ bucket: 'needs_you', tone: 'attention', word: 'Running' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'cancelled', inAttentionWindow: true, machineReachable: false, word: 'Stopped',
        } })).toMatchObject({ bucket: 'finished', tone: 'neutral', word: 'Stopped' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'cancelled', inAttentionWindow: false, machineReachable: false, word: 'Stopped',
        } })).toMatchObject({ bucket: 'finished', tone: 'neutral', word: 'Stopped' });
    });

    it('keeps exhausted reviews finished and neutral even when their machine is offline', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'succeeded', outcome: 'exhausted', machineReachable: false, word: 'Completed',
        } })).toMatchObject({ bucket: 'finished', tone: 'neutral', word: 'Completed' });
    });

    it('tints completed failures but never interprets a declared outcome as trouble', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'succeeded', outcome: 'completed_with_failures', word: 'Completed with failures',
        } })).toMatchObject({ bucket: 'finished', tone: 'danger', word: 'Completed with failures' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'succeeded', outcome: 'declared', word: 'Completed',
        } }).tone).toBe('neutral');
    });

    it('maps held steps from the attention owner and preserves their specific word', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_step', facts: {
            lifecycle: 'waiting_for_review', inAttentionWindow: true, word: 'Waiting for you',
        } })).toMatchObject({ bucket: 'needs_you', tone: 'attention', word: 'Waiting for you' });
    });

    it('distinguishes offline nonterminal work, terminal steps, and manual pause or interruption', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_step', facts: {
            lifecycle: 'running', machineReachable: false, word: 'Running',
        } })).toMatchObject({ bucket: 'offline', tone: 'neutral', word: 'Running' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'running', machineReachable: false, word: 'Running',
        } })).toMatchObject({ bucket: 'offline', tone: 'neutral', word: 'Running' });
        expect(resolveWorkStatusTone({ kind: 'workflow_step', facts: {
            lifecycle: 'completed', machineReachable: false, word: 'Completed',
        } }).bucket).toBe('finished');
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { state: 'paused', word: 'Paused' } }))
            .toMatchObject({ bucket: 'idle', tone: 'neutral', word: 'Paused' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { state: 'interrupted', word: 'Interrupted' } }))
            .toMatchObject({ bucket: 'idle', tone: 'attention', word: 'Interrupted' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { state: 'running', word: 'Running' } }).bucket)
            .toBe('working');
    });

    it('uses session awareness to keep foreground and background activity in Working', () => {
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'waiting', operational: { primary: 'permission_required', reasons: ['permission_required'] } }, attentionType: 'approval', word: 'Needs your permission',
        } })).toMatchObject({ bucket: 'needs_you', tone: 'attention', word: 'Needs your permission' });
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'working', operational: { primary: 'working', reasons: ['working'] } }, word: 'Working',
        } }).bucket).toBe('working');
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'background_active', operational: { primary: 'none', reasons: ['background_activity'] } }, word: 'Background activity',
        } })).toMatchObject({ bucket: 'working', tone: 'neutral', word: 'Background activity' });
    });

    it('orders machine presence before attention before running session counts', () => {
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { online: false, needsYouCount: 1, runningSessionCount: 2, word: 'Offline' } }))
            .toMatchObject({ bucket: 'offline', tone: 'neutral', word: 'Offline' });
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { online: true, needsYouCount: 1, runningSessionCount: 2, word: 'Needs you' } }))
            .toMatchObject({ bucket: 'needs_you', tone: 'attention', word: 'Needs you' });
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { online: true, needsYouCount: 0, runningSessionCount: 2, word: 'Working' } }).bucket).toBe('working');
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { online: true, needsYouCount: 0, runningSessionCount: 0, word: 'Idle' } }).bucket).toBe('idle');
    });

    it('maps workflow definition summary attention and active-run evidence', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow', facts: { needsYouCount: 1, hasActiveRun: true, word: 'Needs you' } }))
            .toMatchObject({ bucket: 'needs_you', tone: 'attention', word: 'Needs you' });
        expect(resolveWorkStatusTone({ kind: 'workflow', facts: { needsYouCount: 0, hasActiveRun: true, word: 'Running' } }).bucket).toBe('working');
        expect(resolveWorkStatusTone({ kind: 'workflow', facts: { needsYouCount: 0, hasActiveRun: false, word: 'Idle' } }))
            .toMatchObject({ bucket: 'idle', tone: 'neutral', word: 'Idle' });
    });

    it('retains a latest Run failure on its definition while an independent live review stays actionable', () => {
        const lastRunStatus = resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'failed', word: 'Failed', inAttentionWindow: true, failureUnseen: true, invocationAttentionRequired: false,
        } });
        expect(resolveWorkStatusTone({ kind: 'workflow', facts: {
            needsYouCount: 0, hasActiveRun: false, word: 'Idle', lastRunStatus,
        } })).toMatchObject({ state: 'failed', tone: 'danger', attentionType: 'update' });
        expect(resolveWorkStatusTone({ kind: 'workflow', facts: {
            needsYouCount: 1, hasActiveRun: true, word: 'Running', lastRunStatus,
        } })).toMatchObject({ state: 'failed', tone: 'danger', attentionType: 'decision' });
    });

    it('keeps report progress on its owner while emitting only the compact Work status', () => {
        const status = resolveWorkStatusTone({ kind: 'session_reports', facts: {
            reports: { total: 5, working: 1, needsYou: 1, stalled: 0, finished: 3, attentionPrimary: 'failed' }, word: 'Failed',
        } });
        expect(status).toEqual({ state: 'failed', bucket: 'idle', tone: 'danger', word: 'Failed', attentionType: 'decision', glyph: 'failure' });
    });

    it('keeps trouble in Finished unless the attention owner places it in Needs you', () => {
        for (const facts of [
            { state: 'cancel_requested' as const },
            { state: 'running' as const, cancelRequested: true },
        ]) {
            expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
                ...facts, inAttentionWindow: true, word: 'Previous outcome',
            } })).toMatchObject({ bucket: 'working', tone: 'neutral', word: t('workflows.run.stopping') });
        }
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'failed', machineReachable: false, word: 'Failed',
        } })).toMatchObject({ bucket: 'finished', tone: 'danger', word: 'Failed' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'outcome_uncertain', inAttentionWindow: true, word: 'Outcome uncertain',
        } })).toMatchObject({ bucket: 'needs_you', tone: 'attention', word: 'Outcome uncertain' });
        expect(resolveWorkStatusTone({ kind: 'workflow_step', facts: {
            lifecycle: 'cancel_requested', inAttentionWindow: false, word: 'Stopping',
        } })).toMatchObject({ bucket: 'working', tone: 'neutral', word: t('workflows.run.stopping') });
    });

    it('preserves supplied words while offline Session facts stay neutral', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'queued', word: 'Waiting to start',
        } })).toMatchObject({ bucket: 'working', tone: 'neutral', word: 'Waiting to start' });
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'offline', operational: { primary: 'failed', reasons: ['failed', 'runtime_offline'] } }, word: 'Failed',
        } })).toMatchObject({ bucket: 'offline', tone: 'neutral', word: 'Failed' });
    });

    it('names who is waiting in a Discussion\u2019s attention word, and keeps the generic word when no one is known', () => {
        const waiting = (attentionReason: 'draft_waiting' | 'approval_pending', agentName?: string | null) =>
            resolveWorkStatusTone({ kind: 'discussion', facts: { attentionReason, attentionType: 'approval', agentName } });
        for (const reason of ['draft_waiting', 'approval_pending'] as const) {
            const generic = waiting(reason).word;
            expect(generic).toBeTruthy();
            expect(waiting(reason, 'Release bot').word).toContain('Release bot');
            expect(waiting(reason, 'Release bot').word).not.toBe(generic);
            expect(waiting(reason, '  ').word).toBe(generic);
            expect(waiting(reason, null)).toMatchObject({ bucket: 'needs_you', tone: 'attention' });
        }
        expect(waiting('draft_waiting', 'Release bot').word).not.toBe(waiting('approval_pending', 'Release bot').word);
    });

    it('keeps admitted current requests independent from Session reachability', () => {
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'offline', operational: { primary: 'none', reasons: ['runtime_offline'] } }, word: 'Offline',
        } })).toMatchObject({ bucket: 'offline', tone: 'neutral', word: 'Offline' });
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'offline', operational: { primary: 'permission_required', reasons: ['permission_required', 'runtime_offline'] } }, attentionType: 'approval', word: 'Needs your permission',
        } })).toMatchObject({ state: 'permission_required', bucket: 'needs_you', tone: 'attention', attentionType: 'approval', word: 'Needs your permission' });
    });

    it('reads agent activity (runs, sub-agents, teammates) from its own vocabulary: waiting asks for you, only failure is danger', () => {
        const tone = (status: AgentActivityStatusV1) =>
            resolveWorkStatusTone({ kind: 'agent_activity', facts: { status, word: status } });
        expect(tone('waiting')).toMatchObject({ bucket: 'needs_you', tone: 'attention', word: 'waiting' });
        for (const status of ['queued', 'starting', 'running', 'blocked'] as const) {
            expect(tone(status)).toMatchObject({ bucket: 'working', tone: 'neutral', word: status });
        }
        expect(tone('failed')).toMatchObject({ bucket: 'finished', tone: 'danger', word: 'failed' });
        for (const status of ['succeeded', 'cancelled'] as const) {
            expect(tone(status)).toMatchObject({ bucket: 'finished', tone: 'neutral', word: status });
        }
        // A timed-out run was interrupted, not chosen: attention, as a worker update's timeout reads.
        expect(tone('timedOut')).toMatchObject({ bucket: 'finished', tone: 'attention', word: 'timedOut' });
        expect(tone('unknown')).toMatchObject({ bucket: 'idle', tone: 'neutral', word: 'unknown' });
    });
});
