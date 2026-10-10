import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { invokeWorkspaceFileSystemMutation, type WorkspaceFileSystemMutationResponse } from './actionInvocation';

import type { WorkspaceFileSystemTarget } from './directoryBrowsing';

function resolveAbsoluteWorkspacePath(params: Readonly<{
    rootPath: string;
    agentRootPath?: string | null;
    requestPath: string;
}>): string {
    return resolveMachineAbsolutePath({
        rootPath: params.rootPath,
        agentRootPath: params.agentRootPath,
        requestPath: params.requestPath,
        pathKind: 'workspace_entry',
    });
}

export type WorkspaceRenamePathResponse = WorkspaceFileSystemMutationResponse;

export async function workspaceRenamePath(
    target: WorkspaceFileSystemTarget,
    input: Readonly<{ from: string; to: string; overwrite?: boolean }>,
): Promise<WorkspaceRenamePathResponse> {
    try {
        return await invokeWorkspaceFileSystemMutation(target, 'daemon.filesystem.rename', {
            rootPath: target.rootPath,
            from: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: input.from }),
            to: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: input.to }),
            overwrite: input.overwrite === true,
        });
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}

export type WorkspaceDeletePathResponse = WorkspaceFileSystemMutationResponse;

export async function workspaceDeletePath(
    target: WorkspaceFileSystemTarget,
    input: Readonly<{ path: string; recursive?: boolean }>,
): Promise<WorkspaceDeletePathResponse> {
    try {
        return await invokeWorkspaceFileSystemMutation(target, 'daemon.filesystem.delete', {
            rootPath: target.rootPath,
            path: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: input.path }),
            recursive: input.recursive === true,
        });
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}
