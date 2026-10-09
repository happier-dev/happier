import {
  createScmCapabilitiesFromBackendCapabilities,
  resolveScmBackendCapabilities,
  type ScmBackendDescribeResponse,
} from '@happier-dev/plugin-sdk/scm/backend';
import type { BackendRuntimeRegistration as ScmBackendRuntimeRegistration } from '@happier-dev/plugin-sdk/scm/backend';

import { classifyGitDirectoryIgnores } from './directoryIgnores.js';
import type { ScmBackend } from './types.js';
import { createGitExecutionFeatureDetector, detectGitRepo, getGitSnapshot, getGitWorktreesEnrichment } from './repository.js';
import { GIT_SCM_BACKEND_CAPABILITIES } from './capabilities.js';
import {
    assertPortableGitWorkspaceEntries,
    classifyGitPortableWorkspacePath,
    classifyGitPortableWorkspaceTransferEntry,
    createGitWorkspaceCheckout,
    inspectGitWorkspaceLocation,
    materializeGitWorkspaceSourceCheckout,
    isGitAdministrativeWorkspacePath,
    prepareGitReviewWorkspaceAtSelectedRoot,
    verifyGitPreparedReviewWorkspace,
    realizeGitWorkspaceCheckout,
    reconcileGitWorkspacePostMaterialization,
    resolveGitWorkspaceTransferSource,
    resolveGitWorkspaceTransferSourceEntries,
    resolveGitWorkspaceTransferSourceMetadata,
} from './workspaceIntegration.js';
import { gitBranchCheckout, gitBranchCreate, gitBranchList } from './operations/branchOperations.js';
import {
    gitBranchMerge,
    gitBranchOperationAbort,
    gitBranchOperationContinue,
    gitBranchOperationSkip,
    gitBranchRebase,
    gitConflictAcceptSide,
    gitConflictMarkResolved,
} from './operations/branchIntegrationOperations.js';
import { gitChangeExclude, gitChangeInclude } from './operations/changeApply.js';
import { gitChangeDiscard } from './operations/changeDiscard.js';
import { gitCommitBackout, gitCommitCreate, gitCommitUndoLast } from './operations/commitOperations.js';
import { gitCommitResolveOutcome } from './operations/commitOutcome.js';
import { captureGitCommitTarget } from './operations/commitPublication.js';
import { gitRemotePublish } from './operations/publishOperations.js';
import { gitDiffCommit, gitDiffFile, gitLogList, gitHistoryEntries } from './operations/readOperations.js';
import { gitRemoteAdd, gitRemoteRemove, gitRemoteSetUrl } from './operations/remoteManagementOperations.js';
import { gitRemoteFetch, gitRemotePull, gitRemotePush } from './operations/remoteOperations.js';
import { gitRemoveIndexLock } from './operations/removeIndexLockOperation.js';
import { gitRepositoryClone } from './operations/repositoryCloneOperations.js';
import { gitRepositoryInit } from './operations/repositoryInitOperations.js';
import { gitStashApply, gitStashCreate, gitStashDrop, gitStashList, gitStashPop, gitStashShow } from './operations/stashOperations.js';
import { gitWorktreeCreate, gitWorktreePrune, gitWorktreeRemove } from './operations/worktreeOperations.js';
import { GIT_INSTALLABLE_DEP_ID } from './installables/gitInstallable.js';

export function createGitBackend(): ScmBackend {
    const gitFeatures = createGitExecutionFeatureDetector();
    const commitCreate: ScmBackend['commitCreate'] = (input) => gitCommitCreate({ ...input, gitFeatures });
    return {
        id: 'git',
        declaredCapabilities: GIT_SCM_BACKEND_CAPABILITIES,
        selection: {
            modeSelectionScores: {
                '.git': 200,
            },
            preferenceAllowedModes: ['.git'],
        },
        workspaceIntegration: {
            classifyDirectoryIgnores: classifyGitDirectoryIgnores,
            inspectWorkspaceLocation: inspectGitWorkspaceLocation,
            reconcilePostMaterialization: reconcileGitWorkspacePostMaterialization,
            prepareReviewWorkspace: prepareGitReviewWorkspaceAtSelectedRoot,
            verifyPreparedReviewWorkspace: verifyGitPreparedReviewWorkspace,
            realizeWorkspaceCheckout: realizeGitWorkspaceCheckout,
            createWorkspaceCheckout: createGitWorkspaceCheckout,
            materializeWorkspaceCheckout: materializeGitWorkspaceSourceCheckout,
            resolveWorkspaceTransfer: resolveGitWorkspaceTransferSource,
            // Retained so a host that predates the combined handler still
            // resolves a Git transfer; the combined handler wins when present.
            resolveWorkspaceTransferEntries: resolveGitWorkspaceTransferSourceEntries,
            resolveWorkspaceTransferMetadata: resolveGitWorkspaceTransferSourceMetadata,
            assertPortableWorkspaceEntries: assertPortableGitWorkspaceEntries,
            classifyPortableWorkspaceTransferEntry: classifyGitPortableWorkspaceTransferEntry,
            isAdministrativeWorkspacePath: isGitAdministrativeWorkspacePath,
            classifyPortableWorkspacePath: classifyGitPortableWorkspacePath,
        },
        detectRepo: detectGitRepo,
        getCapabilities: ({ mode, executableAvailable }) => {
            return createScmCapabilitiesFromBackendCapabilities(resolveScmBackendCapabilities({
                declaredCapabilities: GIT_SCM_BACKEND_CAPABILITIES,
                mode,
                supportedRepoModes: ['.git'],
                executableAvailable,
            }));
        },
        async describeBackend({ context }): Promise<ScmBackendDescribeResponse> {
            return {
                success: true,
                backendId: 'git',
                repoMode: context.detection.mode ?? undefined,
                isRepo: context.detection.isRepo,
                capabilities: createScmCapabilitiesFromBackendCapabilities(resolveScmBackendCapabilities({
                    declaredCapabilities: GIT_SCM_BACKEND_CAPABILITIES,
                    mode: context.detection.mode,
                    supportedRepoModes: ['.git'],
                })),
            };
        },
        async statusSnapshot({ context, request }) {
            return getGitSnapshot({ context, request });
        },
        async worktreesEnrichment({ context, request }) {
            return getGitWorktreesEnrichment({ context, request });
        },
        diffFile: gitDiffFile,
        diffCommit: gitDiffCommit,
        changeInclude: gitChangeInclude,
        changeExclude: gitChangeExclude,
        changeDiscard: gitChangeDiscard,
        commitCreate,
        async commitCaptureTarget({ context }) {
            const captured = await captureGitCommitTarget(context, { message: '' });
            if (!captured.success) return { success: false, errorCode: captured.response.errorCode, error: captured.response.error };
            const { headOid, ref, baseTreeOid } = captured.target;
            return { success: true, target: { headOid, ref, baseTreeOid } };
        },
        commitResolveOutcome: gitCommitResolveOutcome,
        commitBackout: gitCommitBackout,
        commitUndoLast: gitCommitUndoLast,
        logList: gitLogList,
        historyEntries: gitHistoryEntries,
        branchList: gitBranchList,
        branchCreate: gitBranchCreate,
        branchCheckout: gitBranchCheckout,
        branchMerge: gitBranchMerge,
        branchRebase: gitBranchRebase,
        branchOperationContinue: gitBranchOperationContinue,
        branchOperationAbort: gitBranchOperationAbort,
        branchOperationSkip: gitBranchOperationSkip,
        conflictAcceptSide: gitConflictAcceptSide,
        conflictMarkResolved: gitConflictMarkResolved,
        worktreeCreate: gitWorktreeCreate,
        worktreeRemove: gitWorktreeRemove,
        worktreePrune: gitWorktreePrune,
        remoteAdd: gitRemoteAdd,
        remoteSetUrl: gitRemoteSetUrl,
        remoteRemove: gitRemoteRemove,
        remoteFetch: gitRemoteFetch,
        remotePull: gitRemotePull,
        remotePush: gitRemotePush,
        remotePublish: gitRemotePublish,
        hostingRepositoryDescribePublishTargets: async (input) => {
            const { createGitHostingRepositoryPublishOperation } = await import('./operations/hostingRepositoryPublishOperations.js');
            return await createGitHostingRepositoryPublishOperation().describePublishTargets(input);
        },
        hostingRepositoryPublish: async (input) => {
            const { createGitHostingRepositoryPublishOperation } = await import('./operations/hostingRepositoryPublishOperations.js');
            return await createGitHostingRepositoryPublishOperation().publish(input);
        },
        repositoryClone: gitRepositoryClone,
        pullRequestList: async (input) => {
            const { gitPullRequestList } = await import('./operations/pullRequestReadOperations.js');
            return await gitPullRequestList(input);
        },
        pullRequestGet: async (input) => {
            const { gitPullRequestGet } = await import('./operations/pullRequestReadOperations.js');
            return await gitPullRequestGet(input);
        },
        pullRequestOpenCompose: async (input) => {
            const { gitPullRequestOpenCompose } = await import('./operations/pullRequestReadOperations.js');
            return await gitPullRequestOpenCompose(input);
        },
        pullRequestOpenOrReuse: async (input) => {
            const { gitPullRequestOpenOrReuse } = await import('./operations/pullRequestOpenOrReuseOperation.js');
            return await gitPullRequestOpenOrReuse(input);
        },
        pullRequestCheckout: async (input) => {
            const { gitPullRequestCheckout } = await import('./operations/pullRequestCheckoutOperations.js');
            return await gitPullRequestCheckout(input);
        },
        pullRequestPrepareWorktree: async (input) => {
            const { gitPullRequestPrepareWorktree } = await import('./operations/pullRequestCheckoutOperations.js');
            return await gitPullRequestPrepareWorktree(input);
        },
        pullRequestRunStacked: async (input) => {
            const { createGitRunStackedPullRequestAction } = await import('./operations/runStackedPullRequestAction.js');
            return await createGitRunStackedPullRequestAction({ commitCreate }).runStacked(input);
        },
        repositoryInit: gitRepositoryInit,
        removeIndexLock: gitRemoveIndexLock,
        stashList: gitStashList,
        stashCreate: gitStashCreate,
        stashDrop: gitStashDrop,
        stashPop: gitStashPop,
        stashApply: gitStashApply,
        stashShow: gitStashShow,
    };
}

export function createGitScmBackendRuntimeRegistration(): ScmBackendRuntimeRegistration {
    const backend = createGitBackend();
    return {
        id: backend.id,
        runtime: {
            repoModes: ['.git'],
            capabilities: GIT_SCM_BACKEND_CAPABILITIES,
            commands: [{ installableKey: GIT_INSTALLABLE_DEP_ID, command: 'git' }],
        },
        handlers: {
            detection: {
                detectRepo: backend.detectRepo,
                describeBackend: backend.describeBackend,
            },
            read: {
                statusSnapshot: backend.statusSnapshot,
                worktreesEnrichment: backend.worktreesEnrichment,
                diffFile: backend.diffFile,
                diffCommit: backend.diffCommit,
                logList: backend.logList,
                historyEntries: backend.historyEntries,
                stashList: backend.stashList,
            },
            changeSet: {
                include: backend.changeInclude,
                exclude: backend.changeExclude,
                discard: backend.changeDiscard,
            },
            commit: {
                captureTarget: backend.commitCaptureTarget,
                create: backend.commitCreate,
                resolveOutcome: backend.commitResolveOutcome,
                backout: backend.commitBackout,
                undoLast: backend.commitUndoLast,
            },
            remote: {
                add: backend.remoteAdd,
                setUrl: backend.remoteSetUrl,
                remove: backend.remoteRemove,
                fetch: backend.remoteFetch,
                pull: backend.remotePull,
                push: backend.remotePush,
                publish: backend.remotePublish,
            },
            branch: {
                list: backend.branchList,
                create: backend.branchCreate,
                checkout: backend.branchCheckout,
                merge: backend.branchMerge,
                rebase: backend.branchRebase,
                operationContinue: backend.branchOperationContinue,
                operationAbort: backend.branchOperationAbort,
                operationSkip: backend.branchOperationSkip,
                conflictAcceptSide: backend.conflictAcceptSide,
                conflictMarkResolved: backend.conflictMarkResolved,
            },
            worktree: {
                create: backend.worktreeCreate,
                remove: backend.worktreeRemove,
                prune: backend.worktreePrune,
            },
            lifecycle: {
                init: backend.repositoryInit,
                clone: backend.repositoryClone,
                removeIndexLock: backend.removeIndexLock,
            },
            hosting: {
                repositoryDescribePublishTargets: backend.hostingRepositoryDescribePublishTargets,
                repositoryPublish: backend.hostingRepositoryPublish,
                pullRequestList: backend.pullRequestList,
                pullRequestGet: backend.pullRequestGet,
                pullRequestOpenCompose: backend.pullRequestOpenCompose,
                pullRequestOpenOrReuse: backend.pullRequestOpenOrReuse,
                pullRequestCheckout: backend.pullRequestCheckout,
                pullRequestPrepareWorktree: backend.pullRequestPrepareWorktree,
                pullRequestRunStacked: backend.pullRequestRunStacked,
            },
            stash: {
                create: backend.stashCreate,
                drop: backend.stashDrop,
                pop: backend.stashPop,
                apply: backend.stashApply,
                show: backend.stashShow,
            },
            workspaceIntegration: backend.workspaceIntegration,
        },
    };
}
