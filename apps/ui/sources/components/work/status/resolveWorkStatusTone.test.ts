import { describe, expect, it, vi } from 'vitest';
import type { AgentActivityStatusV1 } from '@happier-dev/protocol';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import { describeWorkflowInvocationLifecycle, describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { resolveWorkStatusTone } from './resolveWorkStatusTone';
import { t } from '@/text';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

describe('resolveWorkStatusTone', () => {
    it('uses retained native power for the exact enrolled Machine instead of equating disconnection with Offline', () => {
        const managed: ManagedMachineV1 = { id: 'managed-a', homeId: 'home-a', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: { id: 'retained-native' } },
            retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained', daemon: 'disconnected' } };
        const facts = { online: false, needsYouCount: 0, runningSessionCount: 0, word: 'Offline', machineId: 'guest', managedMachine: managed };
        expect(resolveWorkStatusTone({ kind: 'machine', facts })).toEqual({ bucket: 'idle', tone: 'neutral', word: t('managedPower.asleep') });
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, machineId: 'other' } }).bucket).toBe('offline');
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, managedMachine: { ...managed, archivedAt: 20 } } }).bucket).toBe('offline');
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, revokedAt: 20 } }).bucket).toBe('offline');
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, managedMachine: { ...managed, observation: undefined } } }).word).not.toBe(t('managedPower.asleep'));
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, managedMachine: { ...managed, wakeOnAcceptedMessage: false } } }).word).toBe(t('managedMachines.detail.power.stopped'));
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, managedMachine: { ...managed, desired: 'delete' } } }).word).toBe(t('managedMachines.detail.power.stopped'));
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { ...facts, managedMachine: { ...managed,
            submittedNativeEffect: { intent: 'start', intentRevision: 2, controller: managed.controller, requestId: 'start-a' } } } })).toMatchObject({ bucket: 'working', word: t('managedWake.starting', { machine: 'Build box' }) });
    });
    it('uses operation settlement facts and never presents lost active observation as completed', () => {
        const status = (state: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled', observation: 'available' | 'unavailable' = 'available') =>
            resolveWorkStatusTone({ kind: 'action_operation', facts: { state, observation, word: state } });
        expect(status('accepted')).toEqual({ bucket: 'working', tone: 'neutral', word: 'accepted' });
        expect(resolveWorkStatusTone({ kind: 'action_operation', facts: {
            state: 'accepted', observation: 'available', word: 'Needs you',
            setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed', reviewedEffect: {} },
        } })).toEqual({ bucket: 'needs_you', tone: 'attention', word: 'Needs you' });
        expect(status('running', 'unavailable')).toEqual({ bucket: 'working', tone: 'attention', word: 'running' });
        expect(status('succeeded', 'unavailable')).toEqual({ bucket: 'finished', tone: 'neutral', word: 'succeeded' });
        expect(status('failed')).toEqual({ bucket: 'finished', tone: 'danger', word: 'failed' });
        expect(status('cancelled')).toEqual({ bucket: 'finished', tone: 'neutral', word: 'cancelled' });
    });
    it('derives worker update tone from owner state and explicit wake facts', () => {
        const base = { v: 1, headline: 'Check complete', result: '', canInspect: false } as const;
        expect(resolveWorkStatusTone({ kind: 'worker_update', facts: { word: 'Failed', update: {
            ...base, workerKind: 'execution_run', workerId: 'run_1', ownerState: 'failed', wake: 'finished',
        } } })).toEqual({ bucket: 'finished', tone: 'danger', word: 'Failed' });
        expect(resolveWorkStatusTone({ kind: 'worker_update', facts: { word: 'Settled', update: {
            ...base, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'needs_you',
        } } })).toEqual({ bucket: 'needs_you', tone: 'attention', word: 'Settled' });
        expect(resolveWorkStatusTone({ kind: 'worker_update', facts: { word: 'Stalled', update: {
            ...base, workerKind: 'session', workerId: 'worker', ownerState: 'stalled', wake: 'stalled',
        } } })).toEqual({ bucket: 'offline', tone: 'neutral', word: 'Stalled' });
        expect(resolveWorkStatusTone({ kind: 'worker_update', facts: { word: 'Stalled', update: {
            ...base, workerKind: 'session', workerId: 'worker', ownerState: 'stalled', wake: 'finished',
        } } })).toEqual({ bucket: 'offline', tone: 'neutral', word: 'Stalled' });
        expect(resolveWorkStatusTone({ kind: 'worker_update', facts: { word: 'Failed', update: {
            ...base, workerKind: 'workflow_run', workerId: 'workflow', ownerState: 'failed', wake: 'finished',
        } } })).toEqual({ bucket: 'finished', tone: 'danger', word: 'Failed' });
    });
    it('keeps healthy workflow presenters neutral', () => {
        for (const state of ['queued', 'claimed', 'running', 'pause_requested', 'paused', 'succeeded', 'cancelled', 'skipped'] as const) {
            expect(describeWorkflowRunState(state).variant).toBe('neutral');
        }
        for (const lifecycle of ['pending', 'waiting_for_capacity', 'admitting', 'running', 'completed', 'cancelled', 'skipped', 'superseded'] as const) {
            expect(describeWorkflowInvocationLifecycle(lifecycle).variant).toBe('neutral');
        }
    });

    it('gives attention precedence over reachability and keeps the run word', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'running', inAttentionWindow: true, machineReachable: false, word: 'Running',
        } })).toEqual({ bucket: 'needs_you', tone: 'attention', word: 'Running' });
    });

    it('keeps exhausted reviews finished and neutral even when their machine is offline', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'succeeded', outcome: 'exhausted', machineReachable: false, word: 'Completed',
        } })).toEqual({ bucket: 'finished', tone: 'neutral', word: 'Completed' });
    });

    it('tints completed failures but never interprets a declared outcome as trouble', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'succeeded', outcome: 'completed_with_failures', word: 'Completed with failures',
        } })).toEqual({ bucket: 'finished', tone: 'danger', word: 'Completed with failures' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'succeeded', outcome: 'declared', word: 'Completed',
        } }).tone).toBe('neutral');
    });

    it('maps held steps from the attention owner and preserves their specific word', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_step', facts: {
            lifecycle: 'waiting_for_review', inAttentionWindow: true, word: 'Waiting for you',
        } })).toEqual({ bucket: 'needs_you', tone: 'attention', word: 'Waiting for you' });
    });

    it('distinguishes offline nonterminal work, terminal steps, and manual pause or interruption', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_step', facts: {
            lifecycle: 'running', machineReachable: false, word: 'Running',
        } })).toEqual({ bucket: 'offline', tone: 'neutral', word: 'Running' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'running', machineReachable: false, word: 'Running',
        } })).toEqual({ bucket: 'offline', tone: 'neutral', word: 'Running' });
        expect(resolveWorkStatusTone({ kind: 'workflow_step', facts: {
            lifecycle: 'completed', machineReachable: false, word: 'Completed',
        } }).bucket).toBe('finished');
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { state: 'paused', word: 'Paused' } }))
            .toEqual({ bucket: 'idle', tone: 'neutral', word: 'Paused' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { state: 'interrupted', word: 'Interrupted' } }))
            .toEqual({ bucket: 'idle', tone: 'attention', word: 'Interrupted' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: { state: 'running', word: 'Running' } }).bucket)
            .toBe('working');
    });

    it('uses session awareness and does not promote background activity to primary work', () => {
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'waiting', operational: { primary: 'permission_required', reasons: ['permission_required'] } }, word: 'Needs your permission',
        } })).toEqual({ bucket: 'needs_you', tone: 'attention', word: 'Needs your permission' });
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'working', operational: { primary: 'working', reasons: ['working'] } }, word: 'Working',
        } }).bucket).toBe('working');
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'background_active', operational: { primary: 'none', reasons: ['background_activity'] } }, word: 'Background activity',
        } })).toEqual({ bucket: 'idle', tone: 'neutral', word: 'Background activity' });
    });

    it('orders machine presence before attention before running session counts', () => {
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { online: false, needsYouCount: 1, runningSessionCount: 2, word: 'Offline' } }))
            .toEqual({ bucket: 'offline', tone: 'neutral', word: 'Offline' });
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { online: true, needsYouCount: 1, runningSessionCount: 2, word: 'Needs you' } }))
            .toEqual({ bucket: 'needs_you', tone: 'attention', word: 'Needs you' });
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { online: true, needsYouCount: 0, runningSessionCount: 2, word: 'Working' } }).bucket).toBe('working');
        expect(resolveWorkStatusTone({ kind: 'machine', facts: { online: true, needsYouCount: 0, runningSessionCount: 0, word: 'Idle' } }).bucket).toBe('idle');
    });

    it('maps workflow definition summary attention and active-run evidence', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow', facts: { needsYouCount: 1, hasActiveRun: true, word: 'Needs you' } }))
            .toEqual({ bucket: 'needs_you', tone: 'attention', word: 'Needs you' });
        expect(resolveWorkStatusTone({ kind: 'workflow', facts: { needsYouCount: 0, hasActiveRun: true, word: 'Running' } }).bucket).toBe('working');
        expect(resolveWorkStatusTone({ kind: 'workflow', facts: { needsYouCount: 0, hasActiveRun: false, word: 'Idle' } }))
            .toEqual({ bucket: 'idle', tone: 'neutral', word: 'Idle' });
    });

    it('keeps trouble in Finished unless the attention owner places it in Needs you', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'failed', machineReachable: false, word: 'Failed',
        } })).toEqual({ bucket: 'finished', tone: 'danger', word: 'Failed' });
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'outcome_uncertain', inAttentionWindow: true, word: 'Outcome uncertain',
        } })).toEqual({ bucket: 'needs_you', tone: 'attention', word: 'Outcome uncertain' });
        expect(resolveWorkStatusTone({ kind: 'workflow_step', facts: {
            lifecycle: 'cancel_requested', inAttentionWindow: false, word: 'Stopping',
        } })).toEqual({ bucket: 'working', tone: 'neutral', word: 'Stopping' });
    });

    it('preserves supplied words while offline Session facts stay neutral', () => {
        expect(resolveWorkStatusTone({ kind: 'workflow_run', facts: {
            state: 'queued', word: 'Waiting to start',
        } })).toEqual({ bucket: 'working', tone: 'neutral', word: 'Waiting to start' });
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'offline', operational: { primary: 'failed', reasons: ['failed', 'runtime_offline'] } }, word: 'Failed',
        } })).toEqual({ bucket: 'offline', tone: 'neutral', word: 'Failed' });
    });

    it('keeps offline Session attention facts behind the shared reachability precedence', () => {
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'offline', operational: { primary: 'none', reasons: ['runtime_offline'] } }, word: 'Offline',
        } })).toEqual({ bucket: 'offline', tone: 'neutral', word: 'Offline' });
        expect(resolveWorkStatusTone({ kind: 'session', facts: {
            awareness: { runtime: 'offline', operational: { primary: 'permission_required', reasons: ['permission_required', 'runtime_offline'] } }, word: 'Needs your permission',
        } })).toEqual({ bucket: 'offline', tone: 'neutral', word: 'Needs your permission' });
    });

    it('reads agent activity (runs, sub-agents, teammates) from its own vocabulary: waiting asks for you, only failure is danger', () => {
        const tone = (status: AgentActivityStatusV1) =>
            resolveWorkStatusTone({ kind: 'agent_activity', facts: { status, word: status } });
        expect(tone('waiting')).toEqual({ bucket: 'needs_you', tone: 'attention', word: 'waiting' });
        for (const status of ['queued', 'starting', 'running', 'blocked'] as const) {
            expect(tone(status)).toEqual({ bucket: 'working', tone: 'neutral', word: status });
        }
        expect(tone('failed')).toEqual({ bucket: 'finished', tone: 'danger', word: 'failed' });
        for (const status of ['succeeded', 'cancelled'] as const) {
            expect(tone(status)).toEqual({ bucket: 'finished', tone: 'neutral', word: status });
        }
        // A timed-out run was interrupted, not chosen: attention, as a worker update's timeout reads.
        expect(tone('timedOut')).toEqual({ bucket: 'finished', tone: 'attention', word: 'timedOut' });
        expect(tone('unknown')).toEqual({ bucket: 'idle', tone: 'neutral', word: 'unknown' });
    });
});
