import {
    DaemonFilesystemListDirectoryRequestSchema,
    DaemonFilesystemListDirectoryResponseSchema,
    DaemonFilesystemListRootsResponseSchema,
    type DaemonFilesystemListDirectoryRequest,
    type DaemonFilesystemListDirectoryResponse,
    type DaemonFilesystemListRootsResponse,
} from '@happier-dev/protocol/machines/fileBrowser';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError, isMachineRpcTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { isTerminalAuthError } from '@/sync/runtime/connectivity/authErrors';

import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

type MachineFileBrowserOpts = Readonly<{
    serverId?: string | null;
    accountId?: string | null;
    timeoutMs?: number | null;
    signal?: AbortSignal;
}>;

function throwUnsupportedResponse(method: string): never {
    throw createRpcCallError({ error: `Unsupported response from machine RPC (${method})`, errorCode: 'MACHINE_RPC_INVALID_RESPONSE' });
}

/**
 * Keep the failure class, not the internal exception message. The shared filesystem
 * presenter translates the code; an unclassified relay exception is not evidence
 * that a daemon method is missing. Parsed daemon failures remain unchanged.
 */
function toMachineFileBrowserRpcError(error: unknown): Readonly<{ ok: false; error: string; errorCode: string }> {
    const errorCode = readRpcErrorCode(error)
        ?? (isMachineRpcTimeoutError(error) ? MACHINE_RPC_TIMEOUT_ERROR_CODE
            : isTerminalAuthError(error) ? 'not_authenticated' : 'MACHINE_RPC_FAILED');
    return {
        ok: false,
        error: errorCode,
        errorCode,
    };
}

function toMachineFileBrowserRootsRpcError(error: unknown): Extract<DaemonFilesystemListRootsResponse, { ok: false }> {
    return toMachineFileBrowserRpcError(error);
}

function toMachineFileBrowserDirectoryRpcError(error: unknown): Extract<DaemonFilesystemListDirectoryResponse, { ok: false }> {
    return toMachineFileBrowserRpcError(error);
}

export async function machineFilesystemListRoots(
    machineId: string,
    opts?: MachineFileBrowserOpts,
): Promise<DaemonFilesystemListRootsResponse> {
    try {
        const response = await callGuardedMachineRpcWithPolicy<unknown, undefined>({
            machineId,
            serverId: opts?.serverId,
            accountId: opts?.accountId,
            timeoutMs: opts?.timeoutMs ?? undefined,
            method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS,
            payload: undefined,
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        const parsed = DaemonFilesystemListRootsResponseSchema.safeParse(response);
        if (!parsed.success) {
            throwUnsupportedResponse(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS);
        }
        return parsed.data;
    } catch (error) {
        if (opts?.signal?.aborted) throw error;
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
        const response = await callGuardedMachineRpcWithPolicy<unknown, DaemonFilesystemListDirectoryRequest>({
            machineId,
            serverId: opts?.serverId,
            accountId: opts?.accountId,
            timeoutMs: opts?.timeoutMs ?? undefined,
            method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
            payload,
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        const parsed = DaemonFilesystemListDirectoryResponseSchema.safeParse(response);
        if (!parsed.success) {
            throwUnsupportedResponse(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY);
        }
        return parsed.data;
    } catch (error) {
        if (opts?.signal?.aborted) throw error;
        return toMachineFileBrowserDirectoryRpcError(error);
    }
}
