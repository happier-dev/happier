import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
    SCM_OPERATION_ERROR_CODES,
    createScmCapabilities,
    type ScmRemoteResponse,
    type ScmOperationOutcome,
} from '@happier-dev/protocol/scm';
import {
    createModalModuleMock,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

const {
    sessionScmRemoteFetch,
    sessionScmRemotePush,
    sessionScmRemotePull,
    sessionScmRepositoryRemoveIndexLock,
    invalidateFromMutationAndAwait,
    loadCommitHistory,
    refreshScmData,
} = vi.hoisted(() => ({
    sessionScmRemoteFetch: vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: 'fetched' })),
    sessionScmRemotePush: vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: 'pushed' })),
    sessionScmRemotePull: vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: 'pulled' })),
    sessionScmRepositoryRemoveIndexLock: vi.fn(async () => ({ success: true as const, removed: true, lockPath: '/repo/.git/index.lock' })),
    invalidateFromMutationAndAwait: vi.fn(async () => {}),
    loadCommitHistory: vi.fn(async () => {}),
    refreshScmData: vi.fn(async () => {}),
}));

const modalMock = createModalModuleMock({ confirmResult: true });

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({ importOriginal, overrides: {
        sessionScmRemoteFetch,
        sessionScmRemotePull,
        sessionScmRemotePush,
        sessionScmRepositoryRemoveIndexLock,
    } });
});

vi.mock('@/modal', () => modalMock.module);
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait,
    },
}));

vi.mock('@/track', () => ({
    tracking: { capture: vi.fn() },
}));

const { storage } = await import('@/sync/domains/state/storage');
const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
const snapshot = {
    fetchedAt: 1,
    projectKey: 'machine-1:/repo',
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
    capabilities: createScmCapabilities({
        writeRemoteFetch: true,
        writeRemotePush: true,
        writeRemotePull: true,
        writeRemotePolicies: true,
    }),
    branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
    stashCount: 0,
    hasConflicts: false,
    entries: [],
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
} satisfies ScmWorkingSnapshot;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useScmRemoteOperations', () => {
    beforeEach(() => {
        storage.setState(storage.getInitialState(), true);
        projectManager.clear();
        storage.getState().applySessions([createSessionFixture({ id: 'session-1', active: true, metadata: { path: '/repo', host: 'localhost', machineId: 'machine-1' } })]);
        modalMock.spies.confirm.mockClear();
        modalMock.spies.alert.mockClear();
        sessionScmRemoteFetch.mockReset();
        sessionScmRemoteFetch.mockResolvedValue({ success: true, stdout: 'fetched' });
        sessionScmRemotePush.mockReset();
        sessionScmRemotePush.mockResolvedValue({ success: true, stdout: 'pushed' });
        sessionScmRemotePull.mockReset().mockResolvedValue({ success: true, stdout: 'pulled' });
        sessionScmRepositoryRemoveIndexLock.mockClear();
        invalidateFromMutationAndAwait.mockClear();
        loadCommitHistory.mockClear();
        refreshScmData.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    it('can run push through the canonical remote hook without confirmation when requested', async () => {
        const { useScmRemoteOperations } = await import('./useScmRemoteOperations');
        const hook = await renderHook(() => useScmRemoteOperations({
            sessionId: 'session-1',
            sessionPath: '/repo',
            scmSnapshot: snapshot,
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        }));

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push', { skipConfirmation: true });
        });

        expect(modalMock.spies.confirm).not.toHaveBeenCalled();
        expect(sessionScmRemotePush).toHaveBeenCalledWith('session-1', {
            remote: 'origin',
            branch: 'main',
        }, undefined);
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledWith('session-1', undefined);
        expect(loadCommitHistory).toHaveBeenCalledWith({ reset: true });
    });

    it('pushes only the observed upstream lease after explicit confirmation, even when confirmations are skipped', async () => {
        const { useScmRemoteOperations } = await import('./useScmRemoteOperations');
        const expectedRemoteOid = 'a'.repeat(40);
        const hook = await renderHook(() => useScmRemoteOperations({
            sessionId: 'session-1', sessionPath: '/repo',
            scmSnapshot: { ...snapshot, capabilities: { ...snapshot.capabilities, writeRemoteForceWithLease: true },
                branch: { ...snapshot.branch, head: 'local-name', upstream: 'upstream/feature', upstreamOid: expectedRemoteOid, behind: 2 } },
            scmWriteEnabled: true, scmCommitStrategy: 'atomic', scmRemoteConfirmPolicy: 'never',
            scmPushRejectPolicy: 'prompt_fetch', refreshScmData, loadCommitHistory,
        }));
        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push', { skipConfirmation: true, policy: { pushMode: 'force_with_lease', expectedRemoteOid } });
        });
        expect(modalMock.spies.confirm).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ destructive: true }));
        expect(sessionScmRemotePush).toHaveBeenCalledWith('session-1', {
            remote: 'upstream', branch: 'feature', pushMode: 'force_with_lease', expectedRemoteOid,
        }, undefined);
        expect(sessionScmRemoteFetch).not.toHaveBeenCalled();
    });

    it('offers stale Git index-lock recovery and retries remote push once', async () => {
        sessionScmRemotePush
            .mockResolvedValueOnce({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            })
            .mockResolvedValueOnce({ success: true, stdout: 'pushed after recovery' });

        const { useScmRemoteOperations } = await import('./useScmRemoteOperations');
        const hook = await renderHook(() => useScmRemoteOperations({
            sessionId: 'session-1',
            sessionPath: '/repo',
            scmSnapshot: snapshot,
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'never',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        }));

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push');
        });

        expect(modalMock.spies.confirm).toHaveBeenCalledTimes(1);
        expect(sessionScmRepositoryRemoveIndexLock).toHaveBeenCalledWith('session-1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
        }, undefined);
        expect(sessionScmRemotePush).toHaveBeenCalledTimes(2);
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledWith('session-1', undefined);
    });

    it('waits for the owning refresh rather than treating an elapsed timer as completion', async () => {
        let completeRefresh!: () => void;
        refreshScmData.mockImplementationOnce(() => new Promise<void>((resolve) => { completeRefresh = resolve; }));
        vi.useFakeTimers();

        const { useScmRemoteOperations } = await import('./useScmRemoteOperations');
        const hook = await renderHook(() => useScmRemoteOperations({
            sessionId: 'session-1',
            sessionPath: '/repo',
            scmSnapshot: snapshot,
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'never',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        }));

        let settled = false;
        await act(async () => {
            void hook.getCurrent().runRemoteOperation('fetch').finally(() => {
                settled = true;
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().scmRemoteOperationBusy).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
            await Promise.resolve();
        });

        expect(settled).toBe(false);
        expect(hook.getCurrent().scmRemoteOperationBusy).toBe(true);
        expect(refreshScmData).toHaveBeenCalledTimes(1);
        await act(async () => { completeRefresh(); });
        expect(settled).toBe(true);
        expect(hook.getCurrent().scmRemoteOperationBusy).toBe(false);
    });

    it('passes the one-time pull policy to the machine and preserves a needs-input outcome in the real log', async () => {
        const outcome: ScmOperationOutcome = { v: 1, kind: 'needs_input', errorCode: 'REMOTE_FF_ONLY_REQUIRED', nextActions: [{ kind: 'choose_reconcile' }] };
        sessionScmRemotePull.mockResolvedValueOnce({ success: false, outcome, errorCode: 'REMOTE_FF_ONLY_REQUIRED' });
        const { useScmRemoteOperations } = await import('./useScmRemoteOperations');
        const hook = await renderHook(() => useScmRemoteOperations({
            sessionId: 'session-1', sessionPath: '/repo', scmSnapshot: snapshot,
            scmWriteEnabled: true, scmCommitStrategy: 'atomic', scmRemoteConfirmPolicy: 'never',
            scmPushRejectPolicy: 'prompt_fetch', refreshScmData, loadCommitHistory,
        }));

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('pull', { policy: { dirtyPolicy: 'autostash', reconcile: 'rebase' } });
        });

        expect(sessionScmRemotePull).toHaveBeenCalledWith('session-1', { remote: 'origin', branch: 'main', dirtyPolicy: 'autostash', reconcile: 'rebase' }, undefined);
        expect(storage.getState().getSessionProjectScmOperationLog('session-1')).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'pull', status: 'failed', outcome }),
        ]));
        expect(hook.getCurrent().scmRemoteOperationBusy).toBe(false);
        expect(storage.getState().getSessionProjectScmInFlightOperation('session-1')).toBeNull();
        expect(modalMock.spies.alert).not.toHaveBeenCalled();
    });
});
