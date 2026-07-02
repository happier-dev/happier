import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
    SCM_OPERATION_ERROR_CODES,
    type ScmRemoteResponse,
} from '@happier-dev/protocol';
import {
    createModalModuleMock,
    createStorageModuleStub,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

const {
    sessionScmRemoteFetch,
    sessionScmRemotePush,
    sessionScmRepositoryRemoveIndexLock,
    invalidateFromMutationAndAwait,
    loadCommitHistory,
    refreshScmData,
} = vi.hoisted(() => ({
    sessionScmRemoteFetch: vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: 'fetched' })),
    sessionScmRemotePush: vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: 'pushed' })),
    sessionScmRepositoryRemoveIndexLock: vi.fn(async () => ({ success: true, removed: true, lockPath: '/repo/.git/index.lock' })),
    invalidateFromMutationAndAwait: vi.fn(async () => {}),
    loadCommitHistory: vi.fn(async () => {}),
    refreshScmData: vi.fn(async () => {}),
}));

const storageMock = createStorageModuleStub({});
const modalMock = createModalModuleMock({ confirmResult: true });

vi.mock('@/sync/ops', () => ({
    sessionScmRemoteFetch,
    sessionScmRemotePull: vi.fn(async () => ({ success: true, stdout: 'pulled' })),
    sessionScmRemotePush,
    sessionScmRepositoryRemoveIndexLock,
}));

vi.mock('@/sync/domains/state/storage', () => storageMock);
vi.mock('@/modal', () => modalMock.module);

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait,
    },
}));

vi.mock('@/scm/core/operationPolicy', () => ({
    evaluateScmOperationPreflight: () => ({ allowed: true }),
}));

vi.mock('@/scm/operations/remoteTarget', () => ({
    inferRemoteTargetFromSnapshot: () => ({ remote: 'origin', branch: 'main' }),
}));

vi.mock('@/scm/operations/withOperationLock', () => ({
    withSessionProjectScmOperationLock: async ({ run }: { run: () => Promise<void> }) => {
        await run();
        return { started: true };
    },
}));

vi.mock('@/scm/operations/reporting', () => ({
    reportSessionScmOperation: vi.fn(),
    trackBlockedScmOperation: vi.fn(),
}));

vi.mock('@/track', () => ({
    tracking: {},
}));

vi.mock('@/scm/operations/scmDaemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForScmOperationFailure: () => false,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useScmRemoteOperations', () => {
    beforeEach(() => {
        modalMock.spies.confirm.mockClear();
        sessionScmRemoteFetch.mockReset();
        sessionScmRemoteFetch.mockResolvedValue({ success: true, stdout: 'fetched' });
        sessionScmRemotePush.mockReset();
        sessionScmRemotePush.mockResolvedValue({ success: true, stdout: 'pushed' });
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
            scmSnapshot: null,
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
        });
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledWith('session-1');
        expect(loadCommitHistory).toHaveBeenCalledWith({ reset: true });
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
            scmSnapshot: null,
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
        });
        expect(sessionScmRemotePush).toHaveBeenCalledTimes(2);
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledWith('session-1');
    });

    it('releases the remote operation lifecycle when the post-fetch refresh stalls', async () => {
        refreshScmData.mockImplementationOnce(() => new Promise<void>(() => {}));
        vi.useFakeTimers();

        const { useScmRemoteOperations } = await import('./useScmRemoteOperations');
        const hook = await renderHook(() => useScmRemoteOperations({
            sessionId: 'session-1',
            sessionPath: '/repo',
            scmSnapshot: null,
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

        expect(settled).toBe(true);
        expect(hook.getCurrent().scmRemoteOperationBusy).toBe(false);
        expect(refreshScmData).toHaveBeenCalledTimes(1);
    });
});
