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

import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { invokeWorkspaceFileSystemAction, projectWorkspaceFileSystemActionFailure } from './workspaceFileSystem/actionInvocation';

type MachineFileBrowserOpts = Readonly<{
    serverId?: string | null;
    accountId?: string | null;
    timeoutMs?: number | null;
    signal?: AbortSignal;
    callerContext?: ActionExecutorContext;
}>;

function throwUnsupportedResponse(method: string): never {
    throw createRpcCallError({ error: `Unsupported response from machine RPC (${method})`, errorCode: 'MACHINE_RPC_INVALID_RESPONSE' });
}

/**
 * Keep the failure class, not the internal exception message. The shared filesystem
 * presenter translates the code; an unclassified relay exception is not evidence
 * that a daemon method is missing. Daemon failures are normalized separately.
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

function normalizeDaemonFilesystemFailure(
    failure: Extract<DaemonFilesystemListDirectoryResponse, { ok: false }>,
): Extract<DaemonFilesystemListDirectoryResponse, { ok: false }> {
    // Older daemons (including 0.2) send Node's message without its code.
    // Decode that shape once at ingress; presenters consume codes, never paths.
    const errorCode = failure.errorCode ?? /^(ENOENT|EACCES|EPERM)(?=:|$)/.exec(failure.error)?.[1];
    return errorCode ? { ...failure, error: errorCode, errorCode } : failure;
}

export async function machineFilesystemListRoots(
    machineId: string,
    opts?: MachineFileBrowserOpts,
): Promise<DaemonFilesystemListRootsResponse> {
    try {
        const result = await invokeWorkspaceFileSystemAction({ machineId, serverId: opts?.serverId, rootPath: '' },
            FILESYSTEM_BROWSER_ACTION_IDS_V1.listRoots, {}, { ...opts, accountId: opts?.accountId ?? undefined });
        if (!result.ok) {
            const failure = projectWorkspaceFileSystemActionFailure(result);
            return { ok: false, error: failure.errorCode ?? failure.error, errorCode: failure.errorCode,
                ...(failure.details ? { details: failure.details } : {}) };
        }
        const response = result.result;
        const parsed = DaemonFilesystemListRootsResponseSchema.safeParse(response);
        if (!parsed.success) {
            throwUnsupportedResponse(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS);
        }
        return parsed.data.ok ? parsed.data : normalizeDaemonFilesystemFailure(parsed.data);
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
        const result = await invokeWorkspaceFileSystemAction({ machineId, serverId: opts?.serverId, rootPath: payload.path },
            FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory, payload, { ...opts, accountId: opts?.accountId ?? undefined });
        if (!result.ok) {
            const failure = projectWorkspaceFileSystemActionFailure(result);
            return { ok: false, error: failure.errorCode ?? failure.error, errorCode: failure.errorCode,
                ...(failure.details ? { details: failure.details } : {}) };
        }
        const response = result.result;
        const parsed = DaemonFilesystemListDirectoryResponseSchema.safeParse(response);
        if (!parsed.success) {
            throwUnsupportedResponse(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY);
        }
        return parsed.data.ok ? parsed.data : normalizeDaemonFilesystemFailure(parsed.data);
    } catch (error) {
        if (opts?.signal?.aborted) throw error;
        return toMachineFileBrowserDirectoryRpcError(error);
    }
}
