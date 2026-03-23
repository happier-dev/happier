import {
    DaemonFilesystemListDirectoryRequestSchema,
    DaemonFilesystemListDirectoryResponseSchema,
    DaemonFilesystemListRootsResponseSchema,
    type DaemonFilesystemListDirectoryRequest,
    type DaemonFilesystemListDirectoryResponse,
    type DaemonFilesystemListRootsResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachineFileBrowserOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

function toMachineFileBrowserRootsRpcError(error: unknown): Extract<DaemonFilesystemListRootsResponse, { ok: false }> {
    return {
        ok: false,
        error: error instanceof Error ? error.message : 'Machine RPC failed',
        errorCode: readRpcErrorCode(error),
    };
}

function toMachineFileBrowserDirectoryRpcError(error: unknown): Extract<DaemonFilesystemListDirectoryResponse, { ok: false }> {
    return {
        ok: false,
        error: error instanceof Error ? error.message : 'Machine RPC failed',
        errorCode: readRpcErrorCode(error),
    };
}

export async function machineFilesystemListRoots(
    machineId: string,
    opts?: MachineFileBrowserOpts,
): Promise<DaemonFilesystemListRootsResponse> {
    try {
        const response = await machineRpcWithServerScope<unknown, undefined>({
            machineId,
            serverId: opts?.serverId,
            timeoutMs: opts?.timeoutMs ?? undefined,
            method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS,
            payload: undefined,
        });
        const parsed = DaemonFilesystemListRootsResponseSchema.safeParse(response);
        if (!parsed.success) {
            throwUnsupportedResponse(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS);
        }
        return parsed.data;
    } catch (error) {
        return toMachineFileBrowserRootsRpcError(error);
    }
}

export async function machineFilesystemListDirectory(
    machineId: string,
    input: DaemonFilesystemListDirectoryRequest,
    opts?: MachineFileBrowserOpts,
): Promise<DaemonFilesystemListDirectoryResponse> {
    const payload = DaemonFilesystemListDirectoryRequestSchema.parse(input);
    try {
        const response = await machineRpcWithServerScope<unknown, DaemonFilesystemListDirectoryRequest>({
            machineId,
            serverId: opts?.serverId,
            timeoutMs: opts?.timeoutMs ?? undefined,
            method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
            payload,
        });
        const parsed = DaemonFilesystemListDirectoryResponseSchema.safeParse(response);
        if (!parsed.success) {
            throwUnsupportedResponse(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY);
        }
        return parsed.data;
    } catch (error) {
        return toMachineFileBrowserDirectoryRpcError(error);
    }
}
