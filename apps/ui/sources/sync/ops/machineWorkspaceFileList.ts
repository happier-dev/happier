import {
    DaemonWorkspaceFileListRequestSchema,
    DaemonWorkspaceFileListResponseSchema,
    type DaemonWorkspaceFileListRequest,
    type DaemonWorkspaceFileListResponse,
} from '@happier-dev/protocol/machines/workspaceFiles';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export async function machineWorkspaceFileList(
    machineId: string,
    input: DaemonWorkspaceFileListRequest,
    options?: Readonly<{
        serverId?: string | null;
        accountId?: string | null;
        timeoutMs?: number;
        signal?: AbortSignal;
    }>,
): Promise<DaemonWorkspaceFileListResponse> {
    const payload = DaemonWorkspaceFileListRequestSchema.parse(input);
    try {
        const response = await machineRpcWithServerScope<unknown, DaemonWorkspaceFileListRequest>({
            machineId,
            method: RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST,
            payload,
            serverId: options?.serverId ?? null,
            accountId: options?.accountId ?? null,
            timeoutMs: options?.timeoutMs,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        const parsed = DaemonWorkspaceFileListResponseSchema.safeParse(response);
        return parsed.success ? parsed.data : { ok: false, errorCode: 'method_unavailable' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { ok: false, errorCode: 'method_unavailable' };
    }
}
