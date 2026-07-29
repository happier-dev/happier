import { executeScmRemoteOperation, type ScmRemoteOperationKind } from '@/scm/operations/executeScmRemoteOperation';
import { withWorkspaceScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportWorkspaceScmOperation, type ScmOperationTracker } from '@/scm/operations/reporting';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy, ScmRemoteConfirmPolicy } from '@/scm/settings/preferences';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
    machineScmRemoteFetch,
    machineScmRemotePull,
    machineScmRemotePush,
    machineScmRepositoryRemoveIndexLock,
} from '@/sync/ops/scm/machineScm';

export async function executeWorkspaceScmRemoteOperation(input: Readonly<{
    kind: ScmRemoteOperationKind;
    scope: WorkspaceScopeBase;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    scmRemoteConfirmPolicy: ScmRemoteConfirmPolicy;
    scmPushRejectPolicy: ScmPushRejectPolicy;
    refreshScmData: () => Promise<void>;
    setScmOperationBusy: (busy: boolean) => void;
    setScmOperationStatus: (status: string | null) => void;
    tracking: ScmOperationTracker | null;
    shouldContinue?: () => boolean;
    skipConfirmation?: boolean;
}>): Promise<void> {
    await executeScmRemoteOperation({
        kind: input.kind,
        repoPath: input.scope.rootPath,
        scmSnapshot: input.scmSnapshot,
        scmWriteEnabled: input.scmWriteEnabled,
        scmCommitStrategy: input.scmCommitStrategy,
        scmRemoteConfirmPolicy: input.scmRemoteConfirmPolicy,
        scmPushRejectPolicy: input.scmPushRejectPolicy,
        surface: 'files',
        tracking: input.tracking,
        setScmOperationBusy: input.setScmOperationBusy,
        setScmOperationStatus: input.setScmOperationStatus,
        runWithOperationLock: async (operation, run) => {
            const lockResult = await withWorkspaceScmOperationLock({
                state: storage.getState(),
                scope: input.scope,
                operation,
                run,
            });
            return lockResult.started ? { started: true } : lockResult;
        },
        executeRemoteOperation: async (operation, remoteTarget) => {
            const options = { serverId: input.scope.serverId };
            return operation === 'fetch'
                ? await machineScmRemoteFetch(input.scope.machineId, {
                    cwd: input.scope.rootPath,
                    remote: remoteTarget.remote,
                }, options)
                : operation === 'pull'
                    ? await machineScmRemotePull(input.scope.machineId, {
                        cwd: input.scope.rootPath,
                        remote: remoteTarget.remote,
                        branch: remoteTarget.branch ?? undefined,
                    }, options)
                    : await machineScmRemotePush(input.scope.machineId, {
                        cwd: input.scope.rootPath,
                        remote: remoteTarget.remote,
                        branch: remoteTarget.branch ?? undefined,
                    }, options);
        },
        removeIndexLock: async (request) =>
            await machineScmRepositoryRemoveIndexLock(input.scope.machineId, request, { serverId: input.scope.serverId }),
        reportOperation: ({ operation, status, detail, rawError, errorCode }) => {
            reportWorkspaceScmOperation({
                state: storage.getState(),
                scope: input.scope,
                operation,
                status,
                detail,
                rawError,
                errorCode,
                surface: 'files',
                tracking: input.tracking,
            });
        },
        refreshAfterSuccess: async () => {
            await input.refreshScmData();
        },
        shouldContinue: input.shouldContinue ?? null,
        skipConfirmation: input.skipConfirmation,
        retrySkipConfirmation: input.skipConfirmation,
    });
}
