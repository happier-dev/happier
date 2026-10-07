import {
    MemorySearchQueryV1Schema,
    MemorySearchResultV1Schema,
    type MemorySearchMode,
    type MemorySearchResultV1,
    type MemorySearchScope,
} from '@happier-dev/protocol/memory/memorySearch';

import { serverFetch } from '@/sync/http/client';
import {
    createServerRequestWithServerScope,
    runWithServerRequestAuthorityForServerAccountScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { applyMemorySearchSessionEligibility } from './applyMemorySearchSessionEligibility';

/**
 * Home-local memory search adapter for the plain Personal Home derived index.
 *
 * The Home target is explicit: the caller names the Home whose index it is
 * searching, and the canonical server-scoped request owner binds the request to
 * that Home. Focusing another Home mid-query can therefore never retarget the
 * request or publish its results under a different Home. Requests and responses
 * reuse the shared memory-search protocol schemas so daemon and Home results
 * stay interchangeable for presentation.
 */
function createHomeMemorySearchAbortError(): Error {
    const error = new Error('Personal Home search was cancelled');
    error.name = 'AbortError';
    return error;
}

/** Rebuilds the selected Personal Home's derived search index from canonical transcript rows. */
export async function rebuildHomeSearchIndex(args: Readonly<{ serverId: string }>): Promise<void> {
    const serverId = args.serverId.trim();
    if (!serverId) throw new Error('Rebuilding Home search requires an explicit Home target.');
    const request = createServerRequestWithServerScope({
        serverId,
        preferScoped: true,
        activeRequest: async (path, init) => await serverFetch(path, init),
    });
    const response = await request('/v1/home/search/rebuild', { method: 'POST' });
    if (!response.ok) {
        throw new Error(`Home search could not be rebuilt (status ${response.status}).`);
    }
}

export async function searchHomeMemory(args: Readonly<{
    /** Exact Home/server profile identity to search; never resolved from focus. */
    serverId: string;
    /** Exact Account expected from the target Home credential. */
    accountId: string;
    query: string;
    scope: MemorySearchScope;
    mode: MemorySearchMode;
    eligibleSessionIds?: readonly string[];
    maxResults?: number;
    minScore?: number;
    /**
     * Caller cancellation. A superseded query stops waiting locally and the
     * in-flight HTTP request is aborted through the incumbent fetch transport
     * rather than a second cancellation mechanism.
     */
    signal?: AbortSignal;
}>): Promise<MemorySearchResultV1> {
    if (args.signal?.aborted) throw createHomeMemorySearchAbortError();
    const serverId = String(args.serverId ?? '').trim();
    const accountScope = createServerAccountScope(serverId, args.accountId);
    if (!accountScope) {
        return {
            v: 1,
            ok: false,
            errorCode: 'memory_invalid_query',
            error: 'Personal Home search requires an explicit Home target.',
        };
    }

    const parsedQuery = MemorySearchQueryV1Schema.safeParse({
        v: 1,
        query: args.query.trim(),
        scope: args.scope,
        mode: args.mode,
        ...(args.eligibleSessionIds !== undefined ? { eligibleSessionIds: args.eligibleSessionIds } : {}),
        ...(typeof args.maxResults === 'number' ? { maxResults: args.maxResults } : {}),
        ...(typeof args.minScore === 'number' ? { minScore: args.minScore } : {}),
    });
    if (!parsedQuery.success) {
        return {
            v: 1,
            ok: false,
            errorCode: 'memory_invalid_query',
            error: 'Memory search requires a non-empty query within supported limits.',
        };
    }

    try {
        return await runWithServerRequestAuthorityForServerAccountScope({
            scope: accountScope,
            activeRequest: async (path, init) => await serverFetch(path, init),
        }, async (authority) => {
            const response = await authority.request('/v1/home/search', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(parsedQuery.data),
                ...(args.signal ? { signal: args.signal } : {}),
            });
            if (response.status === 404) {
                return {
                    v: 1 as const,
                    ok: false as const,
                    errorCode: 'memory_index_missing' as const,
                    error: 'Personal Home search is not available on this server.',
                };
            }
            if (!response.ok) {
                return {
                    v: 1 as const,
                    ok: false as const,
                    errorCode: 'memory_failed' as const,
                    error: `Personal Home search failed with status ${response.status}.`,
                };
            }
            return applyMemorySearchSessionEligibility(
                MemorySearchResultV1Schema.parse(await response.json()),
                args.eligibleSessionIds,
            );
        });
    } catch (error) {
        // Cancellation is supersession, not a failed search: the caller owns the
        // next query and must not publish a failure for the abandoned one.
        if (args.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
            throw createHomeMemorySearchAbortError();
        }
        return {
            v: 1,
            ok: false,
            errorCode: 'memory_failed',
            error: 'Personal Home search failed.',
        };
    }
}
