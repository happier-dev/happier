import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { FilesystemGetDirectoryTreeOutputSchema, FilesystemListDirectoryOutputSchema, type FilesystemTreeNode } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { invokeWorkspaceFileSystemAction, invokeWorkspaceFileSystemMutation, projectWorkspaceFileSystemActionFailure, type WorkspaceFileSystemFailure, type WorkspaceFileSystemMutationResponse } from './actionInvocation';

export type WorkspaceFileSystemTarget = Readonly<{
    machineId: string;
    rootPath: string;
    agentRootPath?: string | null;
    serverId?: string | null;
}>;

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

export type WorkspaceCreateDirectoryResponse = WorkspaceFileSystemMutationResponse;

export async function workspaceCreateDirectory(
    target: WorkspaceFileSystemTarget,
    path: string,
    options?: Readonly<{ signal?: AbortSignal; callerContext?: ActionExecutorContext }>,
): Promise<WorkspaceCreateDirectoryResponse> {
    try {
        return await invokeWorkspaceFileSystemMutation(target, 'daemon.filesystem.createDirectory', {
            rootPath: target.rootPath,
            path: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: path }),
        }, options);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}

export type WorkspaceListDirectoryResponse =
    | Extract<ReturnType<typeof FilesystemListDirectoryOutputSchema.parse>, { success: true }>
    | WorkspaceFileSystemFailure;

export async function workspaceListDirectory(
    target: WorkspaceFileSystemTarget,
    path: string,
    options?: Readonly<{ signal?: AbortSignal; callerContext?: ActionExecutorContext; accountId?: string; includeGitIgnore?: boolean }>,
): Promise<WorkspaceListDirectoryResponse> {
    try {
        const result = await invokeWorkspaceFileSystemAction(target, 'daemon.filesystem.listDirectory', {
            rootPath: target.rootPath,
            path: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: path }),
            ...(options?.includeGitIgnore === undefined ? {} : { includeGitIgnore: options.includeGitIgnore }),
        }, options);
        if (!result.ok) return projectWorkspaceFileSystemActionFailure(result);
        const response = FilesystemListDirectoryOutputSchema.safeParse(result.result);
        return response.success ? response.data : { success: false, error: 'The filesystem Action response could not be validated.', errorCode: 'invalid_action_output' };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}

export type WorkspaceTreeNode = FilesystemTreeNode;

export type WorkspaceGetDirectoryTreeResponse =
    | Readonly<{ success: true; tree: WorkspaceTreeNode }>
    | WorkspaceFileSystemFailure;

export async function workspaceGetDirectoryTree(
    target: WorkspaceFileSystemTarget,
    path: string,
    maxDepth: number,
    options?: Readonly<{ signal?: AbortSignal; callerContext?: ActionExecutorContext }>,
): Promise<WorkspaceGetDirectoryTreeResponse> {
    try {
        const result = await invokeWorkspaceFileSystemAction(target, 'daemon.filesystem.getDirectoryTree', {
            rootPath: target.rootPath,
            path: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: path }),
            maxDepth,
        }, options);
        if (!result.ok) return projectWorkspaceFileSystemActionFailure(result);
        const response = FilesystemGetDirectoryTreeOutputSchema.safeParse(result.result);
        return response.success ? response.data : { success: false, error: 'The filesystem Action response could not be validated.', errorCode: 'invalid_action_output' };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}
