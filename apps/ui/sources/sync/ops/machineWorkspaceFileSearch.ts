import {
    DaemonWorkspaceFileSearchRequestSchema,
    DaemonWorkspaceFileSearchResponseSchema,
    type DaemonWorkspaceFileSearchRequest,
    type DaemonWorkspaceFileSearchResponse,
} from '@happier-dev/protocol/machines/workspaceFiles';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export async function machineWorkspaceFileSearch(
    machineId: string,
    input: DaemonWorkspaceFileSearchRequest,
    options?: Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal }>,
): Promise<DaemonWorkspaceFileSearchResponse | Readonly<{ ok: false; errorCode: 'method_unavailable' | 'transport_failed' }>> {
    const payload = DaemonWorkspaceFileSearchRequestSchema.parse(input);
    try {
        const response = await machineRpcWithServerScope<unknown, DaemonWorkspaceFileSearchRequest>({
            machineId,
            method: RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH,
            payload,
            serverId: options?.serverId ?? null,
            accountId: options?.accountId ?? null,
            operationTimeoutMs: null,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        const parsed = DaemonWorkspaceFileSearchResponseSchema.safeParse(response);
        return parsed.success ? parsed.data : { ok: false, errorCode: 'transport_failed' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        const code = readRpcErrorCode(error);
        const updateRequired = code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
            || code === RPC_ERROR_CODES.METHOD_NOT_FOUND
            || code === RPC_ERROR_CODES.UPDATE_REQUIRED;
        return { ok: false, errorCode: updateRequired ? 'method_unavailable' : 'transport_failed' };
    }
}
