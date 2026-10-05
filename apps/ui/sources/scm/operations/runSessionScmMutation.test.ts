import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES, type ScmOperationOutcome } from '@happier-dev/protocol/scm';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: vi.fn(), confirm: vi.fn(async () => false), show: vi.fn() } }).module;
});
// Session/machine RPC are external boundaries; no index-lock removal is expected here.
vi.mock('@/sync/ops/sessionScm', () => ({ sessionScmRepositoryRemoveIndexLock: () => { throw new Error('Unexpected index-lock RPC'); } }));
vi.mock('@/sync/ops/scm/machineScm', () => ({ machineScmRepositoryRemoveIndexLock: () => { throw new Error('Unexpected index-lock RPC'); } }));
import { projectManager, type ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { selectScmWriteOperation } from './selectScmWriteOperation';
import { reportWorkspaceScmOperation } from './reporting';
const { runSessionScmMutation } = await import('./runSessionScmMutation');

/** Exercise the real operation owner; the network callback remains the system boundary. */
function createOperationState(options?: { busy?: boolean }) {
    projectManager.clear();
    projectManager.addSession(createSessionFixture({ id: 's1', metadata: { machineId: 'm1', path: '/repo', host: 'h' } }));
    if (options?.busy) projectManager.beginSessionProjectScmOperation('s1', 'push');
    return {
        get log() { return projectManager.getSessionProjectScmOperationLog('s1'); },
        get inFlight() { return projectManager.getSessionProjectScmInFlightOperation('s1'); },
        beginSessionProjectScmOperation: (sessionId: string, operation: ScmProjectOperationLogEntry['operation']) => projectManager.beginSessionProjectScmOperation(sessionId, operation),
        finishSessionProjectScmOperation: (sessionId: string, operationId: string) => projectManager.finishSessionProjectScmOperation(sessionId, operationId),
        updateSessionProjectScmOperationProgress: (sessionId: string, operationId: string, progressText?: string) => projectManager.updateSessionProjectScmOperationProgress(sessionId, operationId, progressText),
        appendSessionProjectScmOperation: (sessionId: string, entry: Omit<ScmProjectOperationLogEntry, 'id' | 'sessionId'>) => { projectManager.appendSessionProjectScmOperation(sessionId, entry); },
    };
}

describe('runSessionScmMutation', () => {
    it.each(['conflicted', 'outcome_unknown'] as const)('reconciles %s without replaying or replacing the canonical result', async (kind) => {
        const state = createOperationState();
        const outcome: ScmOperationOutcome = kind === 'conflicted'
            ? { v: 1, kind, errorCode: 'CONFLICTING_WORKTREE', repositoryState: { hasConflicts: true, operation: null }, nextActions: [{ kind: 'resolve_conflicts' }] }
            : { v: 1, kind, errorCode: 'COMMAND_OUTCOME_UNKNOWN', reconciliation: { kind: 'repository_status' }, nextActions: [{ kind: 'refresh' }] };
        let readState = 'stale';
        const run = vi.fn(async () => ({ success: false, outcome }));
        await runSessionScmMutation({ state, sessionId: 's1', operation: 'branch_merge', cwd: '/repo', fallbackError: 'failed', run,
            refreshAfterMutation: async () => { readState = 'current'; } });
        expect(readState).toBe('current');
        expect(state.log[0]?.outcome).toEqual(outcome);
        expect(run).toHaveBeenCalledOnce();
    });
    it('retains a known conflict when reconciliation fails and does not read for an unapplied refusal', async () => {
        const state = createOperationState();
        const outcome: ScmOperationOutcome = { v: 1, kind: 'conflicted', errorCode: 'CONFLICTING_WORKTREE',
            repositoryState: { hasConflicts: true, operation: null }, nextActions: [{ kind: 'resolve_conflicts' }] };
        const refresh = vi.fn(async () => { throw new Error('Read unavailable'); });
        await runSessionScmMutation({ state, sessionId: 's1', operation: 'branch_merge', cwd: '/repo', fallbackError: 'failed',
            run: async () => ({ success: false, outcome }), refreshAfterMutation: refresh });
        expect(state.log[0]?.outcome).toEqual(outcome);
        refresh.mockClear();
        await runSessionScmMutation({ state, sessionId: 's1', operation: 'commit_undo', cwd: '/repo', fallbackError: 'failed',
            run: async () => ({ success: false, outcome: { v: 1, kind: 'needs_input', errorCode: 'COMMIT_UNDO_HEAD_CHANGED', nextActions: [{ kind: 'refresh' }] } }),
            refreshAfterMutation: refresh });
        expect(refresh).not.toHaveBeenCalled();
    });
    it('retains an applied effect when its following repository refresh fails, without repeating the write', async () => {
        const state = createOperationState();
        const effect = { kind: 'branch' as const, name: 'feature', headOid: 'a'.repeat(40) };
        const run = vi.fn(async () => ({ success: true, outcome: { v: 1 as const, kind: 'succeeded' as const, effect, nextActions: [] } }));
        const refreshAfterMutation = vi.fn(async () => { throw new Error('Repository is unavailable'); });
        await runSessionScmMutation({ state, sessionId: 's1', operation: 'commit_undo', cwd: '/repo', fallbackError: 'failed', run, refreshAfterMutation });
        expect(selectScmWriteOperation({ inFlight: null, log: state.log, machineReachable: true })).toMatchObject({
            phase: 'effect_applied_with_warning', action: 'commit_undo', outcome: { effect, errorCode: 'REPOSITORY_REFRESH_FAILED', nextActions: [{ kind: 'refresh' }] },
        });
        expect(run).toHaveBeenCalledTimes(1);
        expect(state.inFlight).toBeNull();
    });
    it('records a successful branch switch in the one operation log the outcome line reads', async () => {
        const state = createOperationState();
        const result = await runSessionScmMutation({
            state, sessionId: 's1', operation: 'branch_switch', cwd: '/repo',
            fallbackError: 'failed',
            run: async () => ({ success: true }),
            successDetail: () => 'dev',
        });

        expect(result).toEqual({ started: true, response: { success: true, outcome: { v: 1, kind: 'succeeded', nextActions: [] } } });
        expect(state.inFlight).toBeNull();
        expect(selectScmWriteOperation({ inFlight: null, log: state.log, machineReachable: true })).toMatchObject({
            phase: 'succeeded', action: 'branch_switch',
        });
        expect(state.log[0]).toMatchObject({ operation: 'branch_switch', status: 'success', detail: 'dev' });
    });

    it('records a failure with its code instead of raising a modal, and survives a thrown RPC', async () => {
        const { Modal } = await import('@/modal');
        const state = createOperationState();
        await runSessionScmMutation({
            state, sessionId: 's1', operation: 'stash_create', cwd: '/repo',
            fallbackError: 'Could not keep changes aside',
            run: async () => ({ success: false, error: 'conflict in a.ts', errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE }),
        });
        expect(selectScmWriteOperation({ inFlight: null, log: state.log, machineReachable: true })).toMatchObject({
            phase: 'failed', action: 'stash_create', outcome: { errorCode: 'CONFLICTING_WORKTREE' },
        });

        const thrown = await runSessionScmMutation({
            state, sessionId: 's1', operation: 'branch_create', cwd: '/repo',
            fallbackError: 'Could not create the branch',
            run: async () => { throw new Error('socket closed'); },
        });
        expect(thrown).toMatchObject({ started: true, response: { success: false } });
        expect(state.log[0]).toMatchObject({ operation: 'branch_create', status: 'failed' });
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('does not run or log anything while another operation holds the lock', async () => {
        const state = createOperationState({ busy: true });
        const run = vi.fn(async () => ({ success: true }));
        const result = await runSessionScmMutation({ state, sessionId: 's1', operation: 'branch_switch', cwd: '/repo', fallbackError: 'x', run });
        expect(result.started).toBe(false);
        expect(run).not.toHaveBeenCalled();
        expect(state.log).toEqual([]);
    });

    it('preserves the backend terminal outcome and never retries a known applied effect', async () => {
        const state = createOperationState();
        const outcome: ScmOperationOutcome = { v: 1, kind: 'effect_applied_with_warning', errorCode: 'INDEX_RECONCILIATION_FAILED', effect: { kind: 'commit', commitSha: 'abc123' }, nextActions: [{ kind: 'reconcile_index' }] };
        const run = vi.fn(async () => ({ success: false, errorCode: 'COMMAND_FAILED' as const, error: "Unable to create '/repo/.git/index.lock': File exists", outcome }));
        await runSessionScmMutation({ state, sessionId: 's1', operation: 'commit', cwd: '/repo', fallbackError: 'failed', run });
        expect(state.log[0]).toMatchObject({ outcome });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('retains the same canonical outcome in the shared workspace operation log', () => {
        createOperationState();
        const scope = projectManager.getProjectForSession('s1')!.key;
        const outcome: ScmOperationOutcome = { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN', reconciliation: { kind: 'remote_ref', remote: 'origin' }, nextActions: [{ kind: 'refresh' }] };
        reportWorkspaceScmOperation({ state: { appendWorkspaceScmOperation: (target, entry) => { projectManager.appendWorkspaceScmOperation(target, entry); } }, scope, operation: 'push', status: 'failed', surface: 'update', outcome });
        expect(projectManager.getWorkspaceScmOperationLog(scope)[0]).toMatchObject({ outcome });
    });
});
