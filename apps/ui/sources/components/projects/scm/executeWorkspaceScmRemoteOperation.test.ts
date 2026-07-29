import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
    SCM_OPERATION_ERROR_CODES,
    type ScmRemoteResponse,
} from '@happier-dev/protocol';
import {
    createModalModuleMock,
    createStorageModuleStub,
    createStorageStoreMock,
} from '@/dev/testkit';

const {
    beginWorkspaceScmOperation,
    finishWorkspaceScmOperation,
    machineScmRemotePush,
    machineScmRepositoryRemoveIndexLock,
    refreshScmData,
} = vi.hoisted(() => ({
    beginWorkspaceScmOperation: vi.fn(() => ({
        started: true as const,
        operation: { id: 'workspace-op-1', startedAt: 1, sessionId: 'workspace', operation: 'push' as const },
    })),
    finishWorkspaceScmOperation: vi.fn(() => true),
    machineScmRemotePush: vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: 'pushed' })),
    machineScmRepositoryRemoveIndexLock: vi.fn(async () => ({
        success: true,
        removed: true,
        lockPath: '/repo/.git/index.lock',
    })),
    refreshScmData: vi.fn(async () => {}),
}));

const modalMock = createModalModuleMock({ confirmResult: true });
const storageMock = createStorageModuleStub({
    storage: createStorageStoreMock({
        beginWorkspaceScmOperation,
        finishWorkspaceScmOperation,
    }),
});

vi.mock('@/modal', () => modalMock.module);
vi.mock('@/sync/domains/state/storage', () => storageMock);
vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmRemoteFetch: vi.fn(async () => ({ success: true, stdout: 'fetched' })),
    machineScmRemotePull: vi.fn(async () => ({ success: true, stdout: 'pulled' })),
    machineScmRemotePush,
    machineScmRepositoryRemoveIndexLock,
}));
vi.mock('@/scm/core/operationPolicy', () => ({
    evaluateScmOperationPreflight: () => ({ allowed: true }),
}));
vi.mock('@/scm/operations/remoteTarget', () => ({
    inferRemoteTargetFromSnapshot: () => ({ remote: 'origin', branch: 'main' }),
}));
vi.mock('@/scm/operations/reporting', () => ({
    reportWorkspaceScmOperation: vi.fn(),
    trackBlockedScmOperation: vi.fn(),
}));
vi.mock('@/scm/operations/scmDaemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForScmOperationFailure: () => false,
}));

describe('executeWorkspaceScmRemoteOperation', () => {
    beforeEach(() => {
        modalMock.spies.confirm.mockClear();
        beginWorkspaceScmOperation.mockClear();
        finishWorkspaceScmOperation.mockClear();
        machineScmRemotePush.mockReset();
        machineScmRemotePush.mockResolvedValue({ success: true, stdout: 'pushed' });
        machineScmRepositoryRemoveIndexLock.mockClear();
        refreshScmData.mockClear();
    });

    it('offers stale Git index-lock recovery and retries workspace remote push once', async () => {
        machineScmRemotePush
            .mockResolvedValueOnce({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            })
            .mockResolvedValueOnce({ success: true, stdout: 'pushed after recovery' });

        const { executeWorkspaceScmRemoteOperation } = await import('./executeWorkspaceScmRemoteOperation');

        await executeWorkspaceScmRemoteOperation({
            kind: 'push',
            scope: { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' },
            scmSnapshot: null,
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'never',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            setScmOperationBusy: vi.fn(),
            setScmOperationStatus: vi.fn(),
            tracking: null,
        });

        expect(modalMock.spies.confirm).toHaveBeenCalledTimes(1);
        expect(machineScmRepositoryRemoveIndexLock).toHaveBeenCalledWith('machine-1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
        }, { serverId: 'server-1' });
        expect(machineScmRemotePush).toHaveBeenCalledTimes(2);
        expect(machineScmRemotePush).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            expect.objectContaining({
                cwd: '/repo',
                remote: 'origin',
                branch: 'main',
            }),
            { serverId: 'server-1' },
        );
        expect(refreshScmData).toHaveBeenCalledTimes(1);
    });
});
