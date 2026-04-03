import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import {
    type WorkspaceDirectoryEntry,
    type WorkspaceTreeNode,
    workspaceCreateDirectory,
    workspaceGetDirectoryTree,
    workspaceListDirectory,
} from '@/sync/ops/workspaceFileSystem';

export type SessionCreateDirectoryResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionCreateDirectory(sessionId: string, path: string): Promise<SessionCreateDirectoryResponse> {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget) {
        return {
            success: false,
            error: 'Machine target not available for session',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    return await workspaceCreateDirectory({
        machineId: machineTarget.machineId,
        rootPath: machineTarget.basePath,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
    }, path);
}

export type DirectoryEntry = WorkspaceDirectoryEntry;

export type SessionListDirectoryResponse =
    | Readonly<{ success: true; entries: DirectoryEntry[] }>
    | Readonly<{ success: false; error: string }>;

export async function sessionListDirectory(sessionId: string, path: string): Promise<SessionListDirectoryResponse> {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget) {
        return {
            success: false,
            error: 'Machine target not available for session',
        };
    }

    return await workspaceListDirectory({
        machineId: machineTarget.machineId,
        rootPath: machineTarget.basePath,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
    }, path);
}

export type TreeNode = WorkspaceTreeNode;

export type SessionGetDirectoryTreeResponse =
    | Readonly<{ success: true; tree: TreeNode }>
    | Readonly<{ success: false; error: string }>;

export async function sessionGetDirectoryTree(
  sessionId: string,
  path: string,
  maxDepth: number,
): Promise<SessionGetDirectoryTreeResponse> {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget) {
        return {
            success: false,
            error: 'Machine target not available for session',
        };
    }

    return await workspaceGetDirectoryTree({
        machineId: machineTarget.machineId,
        rootPath: machineTarget.basePath,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
    }, path, maxDepth);
}
