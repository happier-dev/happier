import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

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

type WorkspaceRenamePathRequest = Readonly<{ rootPath: string; from: string; to: string; overwrite: boolean }>;

export type WorkspaceRenamePathResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function workspaceRenamePath(
    target: WorkspaceFileSystemTarget,
    input: Readonly<{ from: string; to: string; overwrite?: boolean }>,
): Promise<WorkspaceRenamePathResponse> {
    try {
        const response = await callGuardedMachineRpcWithPolicy<unknown, WorkspaceRenamePathRequest>({
            machineId: target.machineId,
            serverId: target.serverId,
            method: getActionSpec('daemon.filesystem.rename').bindings!.rpcMethod!,
            payload: {
                rootPath: target.rootPath,
                from: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: input.from }),
                to: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: input.to }),
                overwrite: input.overwrite === true,
            },
        });

        return assertRpcResponseWithSuccess<WorkspaceRenamePathResponse>(response);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}

type WorkspaceDeletePathRequest = Readonly<{ rootPath: string; path: string; recursive: boolean }>;

export type WorkspaceDeletePathResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function workspaceDeletePath(
    target: WorkspaceFileSystemTarget,
    input: Readonly<{ path: string; recursive?: boolean }>,
): Promise<WorkspaceDeletePathResponse> {
    try {
        const response = await callGuardedMachineRpcWithPolicy<unknown, WorkspaceDeletePathRequest>({
            machineId: target.machineId,
            serverId: target.serverId,
            method: getActionSpec('daemon.filesystem.delete').bindings!.rpcMethod!,
            payload: {
                rootPath: target.rootPath,
                path: resolveAbsoluteWorkspacePath({ rootPath: target.rootPath, agentRootPath: target.agentRootPath, requestPath: input.path }),
                recursive: input.recursive === true,
            },
        });

        return assertRpcResponseWithSuccess<WorkspaceDeletePathResponse>(response);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
}
