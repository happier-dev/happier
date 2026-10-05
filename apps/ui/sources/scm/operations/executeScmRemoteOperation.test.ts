import { SCM_OPERATION_ERROR_CODES, type ScmRemotePolicy, type ScmRemoteResponse } from '@happier-dev/protocol/scm';
import { describe, expect, it, vi } from 'vitest';
import { mergeScmCapabilities } from '@/scm/core/snapshotMappers';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { withSessionProjectScmOperationLock } from './withOperationLock';

const { alert, confirm } = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn(async () => true) }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert, confirm } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const { executeScmRemoteOperation } = await import('./executeScmRemoteOperation');

function run(failureFeedback: 'alert' | 'outcomeLine', behavior?: Readonly<{ execute?: (kind: 'fetch' | 'pull' | 'push') => Promise<ScmRemoteResponse>; refresh?: () => Promise<void>; policy?: ScmRemotePolicy; leaseSupported?: boolean; pushRejectPolicy?: 'prompt_fetch' | 'auto_fetch'; kind?: 'pull' | 'push'; pushAfterPull?: boolean; confirmPolicy?: 'always' | 'never'; shouldContinue?: () => boolean; refreshedBranch?: string | null }>) {
    const reportOperation = vi.fn();
    const executeRemoteOperation = vi.fn(async () => ({
        success: false as const,
        errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
        error: '! [rejected] v0.3 -> v0.3 (non-fast-forward)',
    }));
    const snapshot = {
        projectKey: 'machine:/repo', fetchedAt: 1, stashCount: 0, hasConflicts: false,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git' },
        branch: { head: 'v0.3', upstream: 'origin/v0.3', upstreamOid: 'a'.repeat(40), ahead: 3, behind: behavior?.kind === 'pull' ? 2 : 0, detached: false },
        capabilities: mergeScmCapabilities({ changeSetModel: 'index', writeRemotePush: true, writeRemotePull: true, writeRemoteFetch: true, writeRemotePolicies: true, writeRemoteForceWithLease: behavior?.leaseSupported ?? true }),
        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
        entries: [],
    } satisfies ScmWorkingSnapshot;
    projectManager.clear();
    projectManager.addSession(createSessionFixture({ id: 'remote-session', metadata: { machineId: 'machine', path: '/repo', host: 'host' } }));
    projectManager.updateSessionProjectScmSnapshot('remote-session', snapshot);
    // Repository-read transport observations are fixtures; storage and all policy/target normalization remain real.
    const refreshedSnapshot: ScmWorkingSnapshot | null = behavior?.refreshedBranch === null ? null : {
        ...snapshot,
        branch: { ...snapshot.branch, head: behavior?.refreshedBranch ?? snapshot.branch.head, upstream: `origin/${behavior?.refreshedBranch ?? snapshot.branch.head}`, behind: 0 },
    };
    const done = executeScmRemoteOperation({
        kind: behavior?.kind ?? 'push',
        pushAfterPull: behavior?.pushAfterPull,
        repoPath: '/repo',
        scmSnapshot: snapshot,
        readSnapshotAfterSuccess: () => projectManager.getSessionProjectScmSnapshot('remote-session'),
        shouldContinue: behavior?.shouldContinue,
        scmWriteEnabled: true,
        scmCommitStrategy: 'atomic',
        scmRemoteConfirmPolicy: behavior?.confirmPolicy ?? 'never',
        scmPushRejectPolicy: behavior?.pushRejectPolicy ?? 'prompt_fetch',
        surface: 'update',
        setScmOperationBusy: vi.fn(),
        setScmOperationStatus: vi.fn(),
        runWithOperationLock: (operation, body) => withSessionProjectScmOperationLock({
            sessionId: 'remote-session', operation, run: body,
            // Delegate the storage facade to its real domain owner; ProjectManager takes a clock, not a server, as its third argument.
            state: {
                beginSessionProjectScmOperation: (sessionId, kind) => projectManager.beginSessionProjectScmOperation(sessionId, kind),
                finishSessionProjectScmOperation: (sessionId, operationId) => projectManager.finishSessionProjectScmOperation(sessionId, operationId),
                updateSessionProjectScmOperationProgress: (sessionId, operationId, progressText) => projectManager.updateSessionProjectScmOperationProgress(sessionId, operationId, progressText),
            },
        }),
        executeRemoteOperation: behavior?.execute ?? executeRemoteOperation,
        reportOperation,
        refreshAfterSuccess: async () => {
            await behavior?.refresh?.();
            projectManager.updateSessionProjectScmSnapshot('remote-session', refreshedSnapshot);
        },
        failureFeedback,
        policy: behavior?.policy,
    });
    return { done, reportOperation };
}

describe('executeScmRemoteOperation failure feedback', () => {
    it('records the dispatched remote target with a successful push for branch-qualified history', async () => {
        const { done, reportOperation } = run('outcomeLine', { execute: async () => ({ success: true }) });
        await done;
        expect(reportOperation).toHaveBeenCalledWith(expect.objectContaining({ operation: 'push', status: 'success', outcome: expect.objectContaining({ effect: { kind: 'remote', remote: 'origin', branch: 'v0.3' } }) }));
    });
    it('pulls with the chosen reconciliation before pushing, only after confirmed success and refresh', async () => {
        const actions: string[] = [];
        await run('outcomeLine', { kind: 'pull', pushAfterPull: true, policy: { reconcile: 'merge' }, execute: async (kind) => { actions.push(kind); return { success: true }; }, refresh: async () => { actions.push('refresh'); } }).done;
        expect(actions).toEqual(['pull', 'refresh', 'push', 'refresh']);
    });

    it('never pushes after a rejected, uncertain, unrefreshed, or cancelled pull', async () => {
        const failures: ReadonlyArray<Readonly<{ execute: () => Promise<ScmRemoteResponse>; refresh?: () => Promise<void> }>> = [
            { execute: async () => ({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD }) },
            { execute: async () => { throw new Error('response lost'); } },
            { execute: async () => ({ success: true }), refresh: async () => { throw new Error('refresh failed'); } },
        ];
        for (const failure of failures) {
            const execute = vi.fn(failure.execute);
            await run('outcomeLine', { ...failure, execute, kind: 'pull', pushAfterPull: true, policy: { reconcile: 'merge' } }).done;
            expect(execute.mock.calls).toHaveLength(1);
        }
        confirm.mockResolvedValue(false);
        const execute = vi.fn(async () => ({ success: true }));
        await run('outcomeLine', { execute, kind: 'pull', pushAfterPull: true, confirmPolicy: 'always', policy: { reconcile: 'merge' } }).done;
        expect(execute).not.toHaveBeenCalled();
        confirm.mockResolvedValue(true);
    });

    it('does not push if the owning pane retires between the confirmed pull and push', async () => {
        let mounted = true;
        const execute = vi.fn(async () => ({ success: true }));
        await run('outcomeLine', { kind: 'pull', pushAfterPull: true, policy: { reconcile: 'merge' }, execute, refresh: async () => { mounted = false; }, shouldContinue: () => mounted }).done;
        expect(execute.mock.calls).toHaveLength(1);
    });

    it('never pushes a different branch or uses the stale snapshot when refreshed facts are unavailable', async () => {
        for (const refreshedBranch of ['other-branch', null]) {
            const execute = vi.fn(async () => ({ success: true }));
            const { done, reportOperation } = run('outcomeLine', { kind: 'pull', pushAfterPull: true, policy: { reconcile: 'merge' }, execute, refreshedBranch });
            await done;
            expect(execute.mock.calls).toHaveLength(1);
            if (refreshedBranch) expect(reportOperation).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'push', status: 'failed', outcome: expect.objectContaining({ kind: 'needs_input', nextActions: [{ kind: 'refresh' }] }) }));
        }
    });
    it('always asks before rewriting an observed remote even when ordinary push confirmation is disabled', async () => {
        confirm.mockClear().mockResolvedValue(false);
        const execute = vi.fn(async () => ({ success: true }));
        await run('outcomeLine', { execute, policy: { pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) } }).done;
        expect(confirm).toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    });

    it('rejects an unadvertised lease without dispatching an ordinary push', async () => {
        const execute = vi.fn(async () => ({ success: true }));
        const { done, reportOperation } = run('outcomeLine', { execute, leaseSupported: false, policy: { pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) } });
        await done;
        expect(execute).not.toHaveBeenCalled();
        expect(reportOperation).toHaveBeenCalledWith(expect.objectContaining({ outcome: expect.objectContaining({ kind: 'failed', errorCode: 'FEATURE_UNSUPPORTED' }) }));
    });

    it('keeps the typed stale-lease refusal for explicit recovery without automatic fetch or replay', async () => {
        confirm.mockClear().mockResolvedValue(true);
        const execute = vi.fn(async () => ({ success: false as const, errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD }));
        const { done, reportOperation } = run('outcomeLine', { execute, pushRejectPolicy: 'auto_fetch', policy: { pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) } });
        await done;
        expect(execute).toHaveBeenCalledTimes(1);
        expect(reportOperation).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: expect.objectContaining({ kind: 'needs_input', errorCode: 'REMOTE_NON_FAST_FORWARD' }) }));
    });

    it('leaves a rejected push to the outcome line: logged, no modal and no fetch prompt', async () => {
        alert.mockClear();
        confirm.mockClear();
        const { done, reportOperation } = run('outcomeLine');
        await done;
        expect(reportOperation).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'push', status: 'failed', errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
            outcome: expect.objectContaining({ kind: 'needs_input', errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD }),
        }));
        expect(alert).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
    });

    it('keeps the alert and the fetch prompt for surfaces without an outcome line', async () => {
        alert.mockClear();
        confirm.mockClear().mockResolvedValue(false);
        await run('alert').done;
        expect(alert).toHaveBeenCalled();
        expect(confirm).toHaveBeenCalled();
    });

    it('logs an unknown result when the transport loses a push response', async () => {
        const { done, reportOperation } = run('outcomeLine', { execute: async () => { throw new Error('socket closed'); } });
        await done;
        expect(reportOperation).toHaveBeenCalledWith(expect.objectContaining({ outcome: { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN', reconciliation: { kind: 'remote_ref', remote: 'origin', branch: 'v0.3' }, nextActions: [{ kind: 'refresh' }] } }));
    });

    it('reports the applied remote effect when a following refresh fails', async () => {
        const { done, reportOperation } = run('outcomeLine', { execute: async () => ({ success: true }), refresh: async () => { throw new Error('status unavailable'); } });
        await done;
        expect(reportOperation).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: { v: 1, kind: 'effect_applied_with_warning', errorCode: 'REPOSITORY_REFRESH_FAILED', effect: { kind: 'remote', remote: 'origin', branch: 'v0.3' }, nextActions: [{ kind: 'refresh' }] } }));
    });
});
