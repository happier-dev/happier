import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

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
    });
}

type WorkspaceCreateDirectoryRequest = Readonly<{ path: string }>;

export type WorkspaceCreateDirectoryResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function workspaceCreateDirectory(
    target: WorkspaceFileSystemTarget,
    path: string,
): Promise<WorkspaceCreateDirectoryResponse> {
    try {
        const response = await callGuardedMachineRpcWithPolicy<unknown, WorkspaceCreateDirectoryRequest>({
            machineId: target.machineId,
            serverId: target.serverId,
            method: RPC_METHODS.CREATE_DIRECTORY,
            payload: { path: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: path }) },
        });

        return assertRpcResponseWithSuccess<WorkspaceCreateDirectoryResponse>(response);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}

type WorkspaceListDirectoryRequest = Readonly<{ path: string }>;

export type WorkspaceDirectoryEntry = Readonly<{
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number;
}>;

export type WorkspaceListDirectoryResponse =
    | Readonly<{ success: true; entries: WorkspaceDirectoryEntry[] }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function workspaceListDirectory(
    target: WorkspaceFileSystemTarget,
    path: string,
): Promise<WorkspaceListDirectoryResponse> {
    try {
        const response = await callGuardedMachineRpcWithPolicy<unknown, WorkspaceListDirectoryRequest>({
            machineId: target.machineId,
            serverId: target.serverId,
            method: RPC_METHODS.LIST_DIRECTORY,
            payload: { path: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: path }) },
        });

        return assertRpcResponseWithSuccess<WorkspaceListDirectoryResponse>(response);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}

type WorkspaceGetDirectoryTreeRequest = Readonly<{ path: string; maxDepth: number }>;

export type WorkspaceTreeNode = Readonly<{
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: WorkspaceTreeNode[];
}>;

export type WorkspaceGetDirectoryTreeResponse =
    | Readonly<{ success: true; tree: WorkspaceTreeNode }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function workspaceGetDirectoryTree(
    target: WorkspaceFileSystemTarget,
    path: string,
    maxDepth: number,
): Promise<WorkspaceGetDirectoryTreeResponse> {
    try {
        const response = await callGuardedMachineRpcWithPolicy<unknown, WorkspaceGetDirectoryTreeRequest>({
            machineId: target.machineId,
            serverId: target.serverId,
            method: RPC_METHODS.GET_DIRECTORY_TREE,
            payload: {
                path: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: path }),
                maxDepth,
            },
        });

        return assertRpcResponseWithSuccess<WorkspaceGetDirectoryTreeResponse>(response);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}
