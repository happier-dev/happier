import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { workspaceReadFile, workspaceWriteFile } from '@/sync/ops/workspaceFileSystem';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

export type SessionReadFileResponse =
  | Readonly<{ success: true; content: string }>
  | Readonly<{ success: false; error: string }>;

export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget) {
        return { success: false, error: 'Machine target not available for session' };
    }
    return await workspaceReadFile({
        machineId: machineTarget.machineId,
        rootPath: machineTarget.basePath,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
    }, path);
}

export type SessionWriteFileResponse =
  | Readonly<{ success: true; hash: string }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionWriteFile(
  sessionId: string,
  path: string,
  content: string,
  expectedHash?: string | null,
): Promise<SessionWriteFileResponse> {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget) {
        return {
            success: false,
            error: 'Machine target not available for session',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
    const response = await workspaceWriteFile({
        machineId: machineTarget.machineId,
        rootPath: machineTarget.basePath,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
    }, path, content, expectedHash);
    if (response.success !== true && response.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
        return {
            success: false,
            error: response.error,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }
    return response;
}
