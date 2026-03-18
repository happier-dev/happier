import type { ScmBackendDescribeResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import type { ScmBackend } from '../../types';
import { createSaplingCapabilities } from './capabilities';
import { mapSaplingErrorCode } from './errorCodes';
import { saplingChangeDiscard, saplingChangeExclude, saplingChangeInclude } from './operations/changeOperations';
import { saplingCommitBackout, saplingCommitCreate } from './operations/commitOperations';
import { saplingDiffCommit, saplingDiffFile, saplingLogList } from './operations/readOperations';
import { saplingRemoteFetch, saplingRemotePull, saplingRemotePush } from './operations/remoteOperations';
import { detectSaplingRepo, getSaplingSnapshot } from './repository';

export function createSaplingBackend(): ScmBackend {
    return {
        id: 'sapling',
        selection: {
            modeSelectionScores: {
                '.sl': 300,
                '.git': 100,
            },
            preferenceAllowedModes: ['.git'],
        },
        detectRepo: detectSaplingRepo,
        getCapabilities: () => createSaplingCapabilities(),
        async describeBackend({ context }): Promise<ScmBackendDescribeResponse> {
            return {
                success: true,
                backendId: 'sapling',
                repoMode: context.detection.mode ?? undefined,
                isRepo: context.detection.isRepo,
                capabilities: createSaplingCapabilities(),
            };
        },
        async statusSnapshot({ context }) {
            try {
                const snapshot = await getSaplingSnapshot({
                    cwd: context.cwd,
                    projectKey: context.projectKey,
                    detection: context.detection,
                });
                return {
                    success: true,
                    snapshot,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error ?? 'Status snapshot failed');
                return {
                    success: false,
                    error: message,
                    errorCode: mapSaplingErrorCode(message),
                };
            }
        },
        diffFile: saplingDiffFile,
        diffCommit: saplingDiffCommit,
        async changeInclude() {
            return saplingChangeInclude();
        },
        async changeExclude() {
            return saplingChangeExclude();
        },
        changeDiscard: saplingChangeDiscard,
        commitCreate: saplingCommitCreate,
        commitBackout: saplingCommitBackout,
        logList: saplingLogList,
        async branchList() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support branch operations',
            };
        },
        async branchCreate() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support branch operations',
            };
        },
        async branchCheckout() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support branch operations',
            };
        },
        async worktreeCreate() {
            return {
                success: false,
                worktreePath: '',
                branchName: '',
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support worktree operations',
            };
        },
        async worktreeRemove() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support worktree operations',
            };
        },
        async worktreePrune() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support worktree operations',
            };
        },
        remoteFetch: saplingRemoteFetch,
        remotePull: saplingRemotePull,
        remotePush: saplingRemotePush,
        async remotePublish() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support remote publish operations',
            };
        },
        async stashList() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support stash operations',
            };
        },
        async stashDrop() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support stash operations',
            };
        },
        async stashPop() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support stash operations',
            };
        },
        async stashApply() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support stash operations',
            };
        },
        async stashShow() {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                error: 'The selected backend does not support stash operations',
            };
        },
    };
}
