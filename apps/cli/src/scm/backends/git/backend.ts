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
import { gitChangeExclude, gitChangeInclude } from './operations/changeApply';
import { gitChangeDiscard } from './operations/changeDiscard';
import { gitCommitBackout, gitCommitCreate } from './operations/commitOperations';
import { gitRemotePublish } from './operations/publishOperations';
import { gitDiffCommit, gitDiffFile, gitLogList } from './operations/readOperations';
import { gitRemoteFetch, gitRemotePull, gitRemotePush } from './operations/remoteOperations';
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
        readStash: false,
        writeStash: false,
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
        worktreeCreate: gitWorktreeCreate,
        worktreeRemove: gitWorktreeRemove,
        worktreePrune: gitWorktreePrune,
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
