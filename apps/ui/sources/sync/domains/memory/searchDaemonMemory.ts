import { MemorySearchResultV1Schema, type MemorySearchMode, type MemorySearchResultV1, type MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';
import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { applyMemorySearchSessionEligibility } from './applyMemorySearchSessionEligibility';

export async function searchDaemonMemory(args: Readonly<{
    serverId: string | null | undefined;
    accountId: string | null | undefined;
    machineId: string | null | undefined;
    query: string;
    scope: MemorySearchScope;
    mode: MemorySearchMode;
    eligibleSessionIds?: readonly string[];
    maxResults?: number;
    minScore?: number;
    timeoutMs?: number;
    /**
     * Caller cancellation. It is handed to the incumbent machine-RPC
     * cancellation path rather than a second transport, so a superseded query
     * stops waiting locally and relays the cancel for an issued call.
     */
    signal?: AbortSignal;
}>): Promise<MemorySearchResultV1> {
    if (args.signal?.aborted) {
        const error = new Error('Daemon memory search was cancelled');
        error.name = 'AbortError';
        throw error;
    }

    const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : '';
    const accountId = typeof args.accountId === 'string' ? args.accountId.trim() : '';
    const machineId = typeof args.machineId === 'string' ? args.machineId.trim() : '';
    const query = args.query.trim();
    if (!serverId || !accountId || !machineId || !query) {
        return {
            v: 1,
            ok: false,
            errorCode: 'memory_invalid_query',
            error: 'Memory search requires a server, Account, machine, and query.',
        };
    }

    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId,
            serverId,
            accountId,
            preferScoped: true,
            method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
            payload: {
                v: 1,
                query,
                scope: args.scope,
                mode: args.mode,
                ...(args.eligibleSessionIds !== undefined ? { eligibleSessionIds: args.eligibleSessionIds } : {}),
                ...(typeof args.maxResults === 'number' ? { maxResults: args.maxResults } : {}),
                ...(typeof args.minScore === 'number' ? { minScore: args.minScore } : {}),
            },
            ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
            ...(args.signal ? { signal: args.signal } : {}),
        });
        return applyMemorySearchSessionEligibility(
            MemorySearchResultV1Schema.parse(raw),
            args.eligibleSessionIds,
        );
    } catch (error) {
        const errorCode = readRpcErrorCode(error);
        if (errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
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
