import { executeScmRemoteOperation, type ScmRemoteOperationKind } from '@/scm/operations/executeScmRemoteOperation';
import { withWorkspaceScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportWorkspaceScmOperation, type ScmOperationTracker } from '@/scm/operations/reporting';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy } from '@/scm/settings/preferences';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ScmRemotePolicy } from '@happier-dev/protocol/scm';
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
    scmPushRejectPolicy: ScmPushRejectPolicy;
    refreshScmData: () => Promise<void>;
    setScmOperationBusy: (busy: boolean) => void;
    setScmOperationStatus: (status: string | null) => void;
    tracking: ScmOperationTracker | null;
    shouldContinue?: () => boolean;
    skipConfirmation?: boolean;
    policy?: ScmRemotePolicy;
}>): Promise<void> {
    await executeScmRemoteOperation({
        kind: input.kind,
        repoPath: input.scope.rootPath,
        workspace: input.scope.workspace,
        scmSnapshot: input.scmSnapshot,
        scmWriteEnabled: input.scmWriteEnabled,
        scmCommitStrategy: input.scmCommitStrategy,
        scmPushRejectPolicy: input.scmPushRejectPolicy,
        policy: input.policy,
        surface: 'files',
        failureFeedback: 'outcomeLine',
        tracking: input.tracking,
        setScmOperationBusy: input.setScmOperationBusy,
        setScmOperationStatus: input.setScmOperationStatus,
        runWithOperationLock: async (operation, run) => {
            const lockResult = await withWorkspaceScmOperationLock({
                state: storage.getState(),
                scope: input.scope,
                operation,
                deferRunning: true,
                run,
            });
            return lockResult.started ? { started: true } : lockResult;
        },
        executeRemoteOperation: async (operation, remoteTarget, call) => {
            const options = { serverId: input.scope.serverId, workspace: input.scope.workspace, ...call };
            const usePushTarget = !input.scope.workspace || !!input.scmSnapshot?.branch.upstream
                || input.policy?.pushMode === 'force_with_lease';
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
                        ...input.policy,
                    }, options)
                    : await machineScmRemotePush(input.scope.machineId, {
                        cwd: input.scope.rootPath,
                        ...(usePushTarget ? { remote: remoteTarget.remote, branch: remoteTarget.branch ?? undefined } : {}),
                        ...input.policy,
                    }, options);
        },
        removeIndexLock: async (request) =>
            await machineScmRepositoryRemoveIndexLock(input.scope.machineId, request,
                { serverId: input.scope.serverId, workspace: input.scope.workspace }),
        reportOperation: (report) => {
            reportWorkspaceScmOperation({
                ...report,
                state: storage.getState(),
                scope: input.scope,
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
