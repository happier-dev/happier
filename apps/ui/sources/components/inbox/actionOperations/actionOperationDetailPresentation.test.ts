import { describe, expect, it } from 'vitest';

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
        expect(failed.errorSummary).toEqual([
            { label: 'code', value: 'plugin_publish_failed' },
            { label: 'message', value: 'Preview publishing failed' },
        ]);
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
});
