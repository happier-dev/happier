import {
    MemorySearchQueryV1Schema,
    type MemorySearchQueryV1,
    type MemorySearchResultV1,
} from '@happier-dev/protocol';
import { openHomeSearchDb, type HomeSearchDb } from './homeSearchDb';
import { resolveHomeSearchCapability, type HomeSearchCapability } from './homeSearchCapability';

export type HomeSearchService = Readonly<{
    capability(): HomeSearchCapability;
    search(query: MemorySearchQueryV1, context?: Readonly<{ visibleSessionIds?: readonly string[] }>): MemorySearchResultV1;
    close(): void;
}>;

export async function createHomeSearchService(params: Readonly<{
    dbPath: string;
    homeServerIdentityId: string;
    storagePolicy: string;
}>): Promise<HomeSearchService> {
    let db: HomeSearchDb | null = null;
    let dbError = false;
    try {
        db = await openHomeSearchDb({ dbPath: params.dbPath });
    } catch {
        dbError = true;
    }

    return {
        capability() {
            return resolveHomeSearchCapability({
                storagePolicy: params.storagePolicy,
                indexReady: db !== null && !dbError,
            });
        },
        search(query, context) {
            const parsed = MemorySearchQueryV1Schema.safeParse(query);
            if (!parsed.success) {
                return { v: 1, ok: false, errorCode: 'memory_invalid_query', error: 'Invalid Home search query' };
            }
            const capability = resolveHomeSearchCapability({
                storagePolicy: params.storagePolicy,
                indexReady: db !== null && !dbError,
            });
            if (!capability.enabled || !db) {
                return {
                    v: 1,
                    ok: false,
                    errorCode: capability.reason === 'non_plain_home' ? 'memory_disabled' : 'memory_index_missing',
                    error: capability.reason === 'non_plain_home'
                        ? 'Personal Home search is unavailable for encrypted content'
                        : 'Personal Home search index is unavailable',
                };
            }
            try {
                if (
                    context?.visibleSessionIds
                    && parsed.data.scope.type === 'session'
                    && !context.visibleSessionIds.includes(parsed.data.scope.sessionId)
                ) {
                    return { v: 1, ok: true, hits: [] };
                }
                const hits = db.search({
                    query: parsed.data.query,
                    sessionId: parsed.data.scope.type === 'session' ? parsed.data.scope.sessionId : undefined,
                    sessionIds: parsed.data.scope.type === 'global' ? context?.visibleSessionIds : undefined,
                    maxResults: parsed.data.maxResults,
                });
                const minScore = parsed.data.minScore ?? 0;
                return {
                    v: 1,
                    ok: true,
                    hits: hits.filter((hit) => hit.score >= minScore).map((hit) => ({
                        sessionId: hit.sessionId,
                        seqFrom: hit.seqFrom,
                        seqTo: hit.seqTo,
                        createdAtFromMs: hit.createdAtFromMs,
                        createdAtToMs: hit.createdAtToMs,
                        summary: hit.snippet || hit.text,
                        score: hit.score,
                        homeServerIdentityId: params.homeServerIdentityId,
                        role: hit.role,
                    })),
                };
            } catch (error) {
                return {
                    v: 1,
                    ok: false,
                    errorCode: 'memory_failed',
                    error: error instanceof Error ? error.message : 'Personal Home search failed',
                };
            }
        },
        close() {
            db?.close();
            db = null;
        },
    };
}
