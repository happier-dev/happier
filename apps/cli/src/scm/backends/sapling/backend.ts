import type { ScmBackendDescribeResponse } from '@happier-dev/protocol';

import type { ScmBackend } from '../../types';
import { createSaplingCapabilities } from './capabilities';
import { mapSaplingErrorCode } from './errorCodes';
import { saplingChangeExclude, saplingChangeInclude } from './operations/changeOperations';
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
        commitCreate: saplingCommitCreate,
        commitBackout: saplingCommitBackout,
        logList: saplingLogList,
        remoteFetch: saplingRemoteFetch,
        remotePull: saplingRemotePull,
        remotePush: saplingRemotePush,
    };
}
