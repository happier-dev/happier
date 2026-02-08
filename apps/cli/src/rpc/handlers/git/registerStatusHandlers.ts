import { resolve } from 'path';

import type { GitStatusSnapshotRequest, GitStatusSnapshotResponse } from '@happier-dev/protocol';
import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { getSnapshotForCwd, resolveCwd } from './runtime';

export function registerGitStatusHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<GitStatusSnapshotRequest, GitStatusSnapshotResponse>(
        RPC_METHODS.GIT_STATUS_SNAPSHOT,
        async (request) => {
            const cwdResult = resolveCwd(request.cwd, workingDirectory);
            if (!cwdResult.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: cwdResult.error,
                };
            }
            const projectKey = `${resolve(workingDirectory)}:${cwdResult.cwd}`;
            return getSnapshotForCwd(cwdResult.cwd, projectKey);
        }
    );
}
