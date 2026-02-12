import type { ScmBackendDescribeResponse } from '@happier-dev/protocol';

import type { ScmBackend } from '../../types';
import { detectGitRepo, getGitSnapshot } from './repository';
import { createGitCapabilities } from './statusSnapshot';
import { gitChangeExclude, gitChangeInclude } from './operations/changeApply';
import { gitCommitBackout, gitCommitCreate } from './operations/commitOperations';
import { gitDiffCommit, gitDiffFile, gitLogList } from './operations/readOperations';
import { gitRemoteFetch, gitRemotePull, gitRemotePush } from './operations/remoteOperations';

function createUnsupportedGitModeCapabilities() {
    return {
        ...createGitCapabilities(),
        readStatus: false,
        readDiffFile: false,
        readDiffCommit: false,
        readLog: false,
        writeInclude: false,
        writeExclude: false,
        writeCommit: false,
        writeCommitPathSelection: false,
        writeCommitLineSelection: false,
        writeBackout: false,
        writeRemoteFetch: false,
        writeRemotePull: false,
        writeRemotePush: false,
        workspaceWorktreeCreate: false,
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
        commitCreate: gitCommitCreate,
        commitBackout: gitCommitBackout,
        logList: gitLogList,
        remoteFetch: gitRemoteFetch,
        remotePull: gitRemotePull,
        remotePush: gitRemotePush,
    };
}
