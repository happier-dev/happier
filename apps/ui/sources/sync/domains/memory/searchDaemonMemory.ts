import {
    MemorySearchResultV1Schema,
    RPC_ERROR_CODES,
    RPC_METHODS,
    readRpcErrorCode,
    type MemorySearchMode,
    type MemorySearchResultV1,
    type MemorySearchScope,
} from '@happier-dev/protocol';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE } from '@/sync/runtime/sessionMachineRpcErrorCodes';

export async function searchDaemonMemory(args: Readonly<{
    serverId: string | null | undefined;
    machineId: string | null | undefined;
    query: string;
    scope: MemorySearchScope;
    mode: MemorySearchMode;
    maxResults?: number;
    minScore?: number;
    timeoutMs?: number;
}>): Promise<MemorySearchResultV1> {
    const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : '';
    const machineId = typeof args.machineId === 'string' ? args.machineId.trim() : '';
    const query = args.query.trim();
    if (!serverId || !machineId || !query) {
        return {
            v: 1,
            ok: false,
            errorCode: 'memory_invalid_query',
            error: 'Memory search requires a server, machine, and query.',
        };
    }

    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId,
            serverId,
            method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
            payload: {
                v: 1,
                query,
                scope: args.scope,
                mode: args.mode,
                ...(typeof args.maxResults === 'number' ? { maxResults: args.maxResults } : {}),
                ...(typeof args.minScore === 'number' ? { minScore: args.minScore } : {}),
            },
            ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        });
        return MemorySearchResultV1Schema.parse(raw);
    } catch (error) {
        const errorCode = readRpcErrorCode(error);
        if (
            errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
            || errorCode === SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE
        ) {
            return {
                v: 1,
                ok: false,
                errorCode: 'memory_index_missing',
                error: 'Memory search is unavailable on this machine.',
            };
        }
        throw error;
    }
}
