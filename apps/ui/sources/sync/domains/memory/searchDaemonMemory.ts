import { negotiateMemorySearchV1, type MemorySearchCorpusV1, type MemorySearchMode, type MemorySearchResultV1, type MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';
import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { applyMemorySearchSessionEligibility } from './applyMemorySearchSessionEligibility';
import { fetchDaemonMemoryStatus } from './fetchDaemonMemoryStatus';

export async function searchDaemonMemory(args: Readonly<{
    serverId: string | null | undefined;
    accountId: string | null | undefined;
    machineId: string | null | undefined;
    query: string;
    scope: MemorySearchScope;
    mode: MemorySearchMode;
    corpora?: readonly MemorySearchCorpusV1[];
    eligibleSessionIds?: readonly string[];
    externalSource?: Readonly<{ agentId: string; sourceKey: string }>;
    maxResults?: number;
    minScore?: number;
    cursor?: string;
    createdAfterMs?: number;
    createdBeforeMs?: number;
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
        const result = await negotiateMemorySearchV1({
            query: {
                v: 1,
                query,
                scope: args.scope,
                mode: args.mode,
                ...(args.corpora !== undefined ? { corpora: [...args.corpora] } : {}),
                ...(args.eligibleSessionIds !== undefined ? { eligibleSessionIds: [...args.eligibleSessionIds] } : {}),
                ...(args.externalSource ? { externalSource: args.externalSource } : {}),
                ...(typeof args.maxResults === 'number' ? { maxResults: args.maxResults } : {}),
                ...(typeof args.minScore === 'number' ? { minScore: args.minScore } : {}),
                ...(args.cursor ? { cursor: args.cursor } : {}),
                ...(args.createdAfterMs !== undefined ? { createdAfterMs: args.createdAfterMs } : {}),
                ...(args.createdBeforeMs !== undefined ? { createdBeforeMs: args.createdBeforeMs } : {}),
            },
            readDocumentSearchSupport: async () => (await fetchDaemonMemoryStatus({
                machineId, serverId, accountId,
                ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
                ...(args.signal ? { signal: args.signal } : {}),
            }))?.documentSearchSupported === true,
            search: async (payload) => await machineRpcWithServerScope<unknown, unknown>({
                machineId, serverId, accountId, preferScoped: true,
                method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
                payload,
                ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
                ...(args.signal ? { signal: args.signal } : {}),
            }),
            ...(args.signal ? { signal: args.signal } : {}),
        });
        return applyMemorySearchSessionEligibility(
            result,
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
