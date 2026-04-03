import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import {
    workspaceDeletePath,
    workspaceRenamePath,
    workspaceStatFile,
} from '@/sync/ops/workspaceFileSystem';

export type SessionStatFileResponse =
  | Readonly<{
      success: true;
      exists: boolean;
      kind?: 'file' | 'directory' | 'other';
      sizeBytes?: number;
      modifiedMs?: number;
    }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionStatFile(sessionId: string, path: string): Promise<SessionStatFileResponse> {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget) {
        return {
            success: false,
            error: 'Machine target not available for session',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    return await workspaceStatFile({
        machineId: machineTarget.machineId,
        rootPath: machineTarget.basePath,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
    }, path);
}

export type SessionRenamePathResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionRenamePath(
  sessionId: string,
  input: Readonly<{ from: string; to: string; overwrite?: boolean }>,
): Promise<SessionRenamePathResponse> {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget) {
        return {
            success: false,
            error: 'Machine target not available for session',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    return await workspaceRenamePath({
        machineId: machineTarget.machineId,
        rootPath: machineTarget.basePath,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
    }, input);
}

export type SessionDeletePathResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionDeletePath(
  sessionId: string,
  input: Readonly<{ path: string; recursive?: boolean }>,
): Promise<SessionDeletePathResponse> {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget) {
        return {
            success: false,
            error: 'Machine target not available for session',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    return await workspaceDeletePath({
        machineId: machineTarget.machineId,
        rootPath: machineTarget.basePath,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
    }, input);
}
