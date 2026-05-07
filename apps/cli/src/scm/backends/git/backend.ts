import type { ScmBackendDescribeResponse } from '@happier-dev/protocol';

import type { ScmBackend } from '../../types';
import { detectGitRepo, getGitSnapshot } from './repository';
import { createGitCapabilities } from './statusSnapshot';
import {
    assertPortableGitWorkspaceEntries,
    classifyGitPortableWorkspacePath,
    classifyGitPortableWorkspaceTransferEntry,
    createGitWorkspaceCheckout,
    inspectGitWorkspaceLocation,
    materializeGitWorkspaceSourceCheckout,
    isGitAdministrativeWorkspacePath,
    realizeGitWorkspaceCheckout,
    reconcileGitWorkspacePostMaterialization,
    resolveGitWorkspaceTransferSourceEntries,
    resolveGitWorkspaceTransferSourceMetadata,
} from './sourceController';
import { gitBranchCheckout, gitBranchCreate, gitBranchList } from './operations/branchOperations';
import {
    gitBranchMerge,
    gitBranchOperationAbort,
    gitBranchOperationContinue,
    gitBranchRebase,
} from './operations/branchIntegrationOperations';
import { gitChangeExclude, gitChangeInclude } from './operations/changeApply';
import { gitChangeDiscard } from './operations/changeDiscard';
import { gitCommitBackout, gitCommitCreate } from './operations/commitOperations';
import { gitRemotePublish } from './operations/publishOperations';
import {
    gitPullRequestCheckout,
    gitPullRequestGet,
    gitPullRequestList,
    gitPullRequestOpenCompose,
    gitPullRequestOpenOrReuse,
    gitPullRequestPrepareWorktree,
    gitPullRequestRunStacked,
} from './operations/pullRequestOperations';
import { gitDiffCommit, gitDiffFile, gitLogList } from './operations/readOperations';
import { gitRemoteFetch, gitRemotePull, gitRemotePush } from './operations/remoteOperations';
import { gitRemoteAdd, gitRemoteRemove, gitRemoteSetUrl } from './operations/remoteManagementOperations';
import { createGitRepositoryProvisioningBackend } from './operations/repositoryProvisioningOperations';
import { gitStashApply, gitStashDrop, gitStashList, gitStashPop, gitStashShow } from './operations/stashOperations';
import { gitWorktreeCreate, gitWorktreePrune, gitWorktreeRemove } from './operations/worktreeOperations';

function createUnsupportedGitModeCapabilities() {
    return {
        ...createGitCapabilities(),
        readStatus: false,
        readDiffFile: false,
        readDiffCommit: false,
        readLog: false,
        writeInclude: false,
        writeExclude: false,
        writeDiscard: false,
        writeCommit: false,
        writeCommitPathSelection: false,
        writeCommitLineSelection: false,
        writeBackout: false,
        writeRemoteFetch: false,
        writeRemotePull: false,
        writeRemotePush: false,
        writeRemotePublish: false,
        worktreeCreate: false,
        readBranches: false,
        writeBranchCreate: false,
        writeBranchCheckout: false,
        writeBranchMerge: false,
        writeBranchRebase: false,
        writeBranchOperationControl: false,
        writeRemoteAdd: false,
        writeRemoteSetUrl: false,
        writeRemoteRemove: false,
        readStash: false,
        writeStash: false,
        writeRepositoryInit: false,
        readHostingRepositoryPublishTargets: false,
        writeHostingRepositoryPublish: false,
    };
}

export function createGitBackend(): ScmBackend {
    return {
        id: 'git',
        selection: {
            modeSelectionScores: {
                '.git': 200,
            },
            preferenceAllowedModes: ['.git'],
        },
        sourceController: {
            inspectWorkspaceLocation: inspectGitWorkspaceLocation,
            reconcilePostMaterialization: reconcileGitWorkspacePostMaterialization,
            realizeWorkspaceCheckout: realizeGitWorkspaceCheckout,
            createWorkspaceCheckout: createGitWorkspaceCheckout,
            materializeWorkspaceCheckout: materializeGitWorkspaceSourceCheckout,
            resolveWorkspaceTransferEntries: resolveGitWorkspaceTransferSourceEntries,
            resolveWorkspaceTransferMetadata: resolveGitWorkspaceTransferSourceMetadata,
            assertPortableWorkspaceEntries: assertPortableGitWorkspaceEntries,
            classifyPortableWorkspaceTransferEntry: classifyGitPortableWorkspaceTransferEntry,
            isAdministrativeWorkspacePath: isGitAdministrativeWorkspacePath,
            classifyPortableWorkspacePath: classifyGitPortableWorkspacePath,
        },
        pullRequests: {
            list: gitPullRequestList,
            get: gitPullRequestGet,
            openCompose: gitPullRequestOpenCompose,
            openOrReuse: gitPullRequestOpenOrReuse,
            checkout: gitPullRequestCheckout,
            prepareWorktree: gitPullRequestPrepareWorktree,
            runStacked: gitPullRequestRunStacked,
        },
        repository: createGitRepositoryProvisioningBackend(),
        detectRepo: detectGitRepo,
        getCapabilities: ({ mode }) => {
            if (mode !== '.git') {
                return createUnsupportedGitModeCapabilities();
            }
            return createGitCapabilities();
        },
        async describeBackend({ context }): Promise<ScmBackendDescribeResponse> {
            return {
                success: true,
                backendId: 'git',
                repoMode: context.detection.mode ?? undefined,
                isRepo: context.detection.isRepo,
                capabilities: createGitCapabilities(),
            };
        },
        async statusSnapshot({ context }) {
            return getGitSnapshot({ context });
        },
        diffFile: gitDiffFile,
        diffCommit: gitDiffCommit,
        changeInclude: gitChangeInclude,
        changeExclude: gitChangeExclude,
        changeDiscard: gitChangeDiscard,
        commitCreate: gitCommitCreate,
        commitBackout: gitCommitBackout,
        logList: gitLogList,
        branchList: gitBranchList,
        branchCreate: gitBranchCreate,
        branchCheckout: gitBranchCheckout,
        branchMerge: gitBranchMerge,
        branchRebase: gitBranchRebase,
        branchOperationContinue: gitBranchOperationContinue,
        branchOperationAbort: gitBranchOperationAbort,
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
        stashList: gitStashList,
        stashDrop: gitStashDrop,
        stashPop: gitStashPop,
        stashApply: gitStashApply,
        stashShow: gitStashShow,
    };
}
