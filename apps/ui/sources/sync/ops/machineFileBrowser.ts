import {
    DaemonFilesystemListDirectoryRequestSchema,
    DaemonFilesystemListDirectoryResponseSchema,
    DaemonFilesystemListRootsResponseSchema,
    type DaemonFilesystemListDirectoryRequest,
    type DaemonFilesystemListDirectoryResponse,
    type DaemonFilesystemListRootsResponse,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

type MachineFileBrowserOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
    signal?: AbortSignal;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

/**
 * A throw out of the machine RPC means no answer came back: the transport failed, timed out, or the
 * machine is unreachable. The `error` string here is rendered verbatim by the folder picker
 * (`components/ui/filesystemBrowser/FilesystemBrowser.tsx`), so passing `error.message` through put
 * internal exception text — `Cannot read properties of undefined (reading 'emit')` — in front of the
 * user (`F-UI-2`). The local-services inventory adapter, which shares this transport, turns the same
 * throw into a typed reason and never lets the message escape; do the same here. A failure the
 * daemon itself reports still arrives as a parsed `{ ok: false, error }` response and is untouched.
 */
function toMachineFileBrowserRpcError(error: unknown): Readonly<{ ok: false; error: string; errorCode: string }> {
    return {
        ok: false,
        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
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
