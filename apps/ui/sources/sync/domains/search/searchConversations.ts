import { isMemorySessionSearchHitV1, isMemoryExternalTranscriptSearchHitV1, type MemorySearchQueryV1, type MemorySearchResultHitV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { ExternalSessionCandidateV1, ExternalSessionsSource } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import type { MemoryIndexSourceStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { fetchDaemonMemorySettings } from '../memory/fetchDaemonMemorySettings';
import { fetchDaemonMemoryStatus } from '../memory/fetchDaemonMemoryStatus';
import { searchDaemonMemory } from '../memory/searchDaemonMemory';
import { searchHomeMemory } from '../memory/searchHomeMemory';
import { isDaemonMemorySearchUsable } from '../memory/isDaemonMemorySearchUsable';
import { normalizeMemorySearchSessionId } from '../memory/applyMemorySearchSessionEligibility';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';

export type ConversationSearchMachine = Readonly<{ id: string; online: boolean }>;
export type ConversationSearchSource = Readonly<{ agentId: string; sourceKey: string; source: ExternalSessionsSource; contentSearch: boolean; key?: string; label?: string; detail?: string }>;
export type ConversationSearchHit =
    | Readonly<{ machineId: string | null; mode: 'indexed'; hit: MemorySearchResultHitV1 }>
    | Readonly<{ machineId: string; mode: 'standard'; agentId: string; sourceKey: string; source: ExternalSessionsSource; candidate: ExternalSessionCandidateV1 }>;
export type ConversationSearchMachineStatus = Readonly<{ machineId: string; status: 'ok' | 'offline' | 'outdated' | 'partial' | 'disabled-by-settings'; standardSearchEnabled: boolean; documents?: 'ready' | 'pending' | 'unavailable' }>;
export type ConversationSearchResult = Readonly<{
    hits: readonly ConversationSearchHit[];
    machines: readonly ConversationSearchMachineStatus[];
    sources?: readonly (ConversationSearchSource & Readonly<{ machineId: string; indexReady?: boolean }>)[];
    homeStatus?: 'ok' | 'partial' | 'unavailable';
    /** Cursor identity stays with its producing machine/source; never sent to a different index. */
    continuations?: readonly Readonly<{ machineId: string | null; sourceKey?: string; cursor: string }>[];
    /** A producer rejected its continuation; that source's prior projection is replaced. */
    resetSources?: readonly Readonly<{ machineId: string; sourceKey: string }>[];
    completedStandardSources?: readonly Readonly<{ machineId: string; agentId: string; sourceKey: string }>[];
}>;

/** Unknown source coverage remains eligible for an explicit scan. */
export function hasConversationSearchScanFallback(result: ConversationSearchResult | null): boolean {
    return result?.machines.some(machine => machine.standardSearchEnabled && (
        !result.sources?.some(source => source.machineId === machine.machineId)
        || result.sources.some(source => source.machineId === machine.machineId && source.indexReady !== true)
    )) ?? false;
}

function hitTime(row: ConversationSearchHit): number {
    return row.mode === 'standard' ? row.candidate.updatedAtMs
        : 'createdAtToMs' in row.hit && typeof row.hit.createdAtToMs === 'number' ? row.hit.createdAtToMs : 0;
}

function indexedRows(machineId: string | null, hits: readonly MemorySearchResultHitV1[]): ConversationSearchHit[] {
    return hits.flatMap<ConversationSearchHit>(hit => {
        if (!isMemorySessionSearchHitV1(hit)) return [{ machineId, mode: 'indexed' as const, hit }];
        const sessionId = normalizeMemorySearchSessionId(hit.sessionId);
        return sessionId ? [{ machineId, mode: 'indexed' as const, hit: { ...hit, sessionId } }] : [];
    });
}

/** Action callers serialize one returned continuation into MemorySearchQuery.cursor. */
function readQualifiedCursor(cursor: string | undefined): NonNullable<ConversationSearchResult['continuations']>[number] | undefined {
    if (!cursor) return undefined;
    let value: unknown;
    try { value = JSON.parse(cursor); } catch { return undefined; }
    if (!value || typeof value !== 'object' || !('machineId' in value) || !('cursor' in value)
        || (value.machineId !== null && typeof value.machineId !== 'string') || typeof value.cursor !== 'string'
        || ('sourceKey' in value && typeof value.sourceKey !== 'string')
        || Object.keys(value).some(key => key !== 'machineId' && key !== 'sourceKey' && key !== 'cursor')) return undefined;
    return { machineId: value.machineId, cursor: value.cursor,
        ...('sourceKey' in value && typeof value.sourceKey === 'string' ? { sourceKey: value.sourceKey } : {}) };
}

/** Scores are local to each index. Session identity is shared by Home and daemon. */
export function mergeConversationSearchHits(rows: readonly ConversationSearchHit[]): ConversationSearchHit[] {
    const sorted = [...rows].sort((a, b) => hitTime(b) - hitTime(a));
    const sessions = new Set<string>();
    const native = new Set<string>();
    return sorted.filter(row => {
        if (row.mode === 'indexed' && isMemorySessionSearchHitV1(row.hit)) {
            const id = row.hit.sessionId.trim();
            if (!id || sessions.has(id)) return false;
            sessions.add(id);
        } else if (row.mode === 'indexed' && isMemoryExternalTranscriptSearchHitV1(row.hit)) {
            const id = JSON.stringify([row.machineId, row.hit.source.agentId, row.hit.source.sourceKey, row.hit.source.nativeSessionId, row.hit.sourceItemId]);
            if (native.has(id)) return false;
            native.add(id);
        } else if (row.mode === 'standard') {
            if (row.candidate.linkedSessionId) {
                const sessionId = row.candidate.linkedSessionId.trim();
                if (sessions.has(sessionId)) return false;
                sessions.add(sessionId);
            }
            const id = JSON.stringify([row.machineId, row.agentId, row.sourceKey, row.candidate.remoteSessionId, row.candidate.match?.sourceItemId]);
            if (native.has(id)) return false;
            native.add(id);
        }
        return true;
    });
}

export async function searchConversations(input: Readonly<{
    serverId: string;
    accountId: string;
    machines: readonly ConversationSearchMachine[];
    query: MemorySearchQueryV1;
    signal?: AbortSignal;
    concurrencyLimit: number;
    mode?: 'auto' | 'indexed' | 'standard';
    homeSessions?: boolean;
    daemonEnabled?: boolean;
    includeThreads?: boolean;
    /** Source materialization is shared with the History browser's projection owner. */
    readSources?: (machineId: string) => Promise<readonly ConversationSearchSource[]>;
    continuation?: NonNullable<ConversationSearchResult['continuations']>[number];
    /** Account adapter authorizes before deduplication, so an invalid newer hit cannot hide a valid one. */
    authorize?: (rows: readonly ConversationSearchHit[]) => Promise<readonly ConversationSearchHit[]>;
    onSources?: (sources: NonNullable<ConversationSearchResult['sources']>) => void;
}>): Promise<ConversationSearchResult> {
    input.signal?.throwIfAborted();
    const mode = input.mode ?? 'indexed';
    // Resolve the one transport adapter before starting concurrent machine work.
    // Indexed typing never loads the standard scanner's dependency corridor.
    const listCandidates = mode === 'indexed' ? null
        : (await import('@/sync/ops/machineExternalSessions')).machineExternalSessionsCandidatesList;
    input.signal?.throwIfAborted();
    const hits: ConversationSearchHit[] = [];
    const continuations: NonNullable<ConversationSearchResult['continuations']>[number][] = [];
    const sourcesResult: NonNullable<ConversationSearchResult['sources']>[number][] = [];
    const resetSources: NonNullable<ConversationSearchResult['resetSources']>[number][] = [];
    const completedStandardSources: NonNullable<ConversationSearchResult['completedStandardSources']>[number][] = [];
    const { cursor: rawCursor, ...query } = input.query;
    const externalSource = query.externalSource;
    const continuation = input.continuation ?? readQualifiedCursor(rawCursor);
    const cursor = continuation ? undefined : rawCursor;
    // A raw daemon cursor has no cross-machine meaning. Public callers may use it
    // only with one explicit index; load-more hooks carry the producer identity.
    const usesHome = input.homeSessions && mode !== 'standard' && (!query.corpora || query.corpora.includes('sessions'));
    if (cursor && !continuation && (input.machines.length !== 1 || usesHome)) {
        throw new Error('Conversation search cursor requires an exact producing index');
    }
    const home = query.query.trim().length > 0 && input.homeSessions && mode !== 'standard' && (!query.corpora || query.corpora.includes('sessions'))
        && (!continuation || continuation.machineId === null)
        ? searchHomeMemory({ ...query, cursor: continuation?.cursor, serverId: input.serverId, accountId: input.accountId, signal: input.signal })
        : null;
    const machineWork = runTasksWithLimit(input.machines.filter(machine => !continuation || continuation.machineId === machine.id).map(machine => async (): Promise<ConversationSearchMachineStatus> => {
        input.signal?.throwIfAborted();
        if (!machine.online) return { machineId: machine.id, status: 'offline', standardSearchEnabled: false };
        const target = { serverId: input.serverId, accountId: input.accountId, machineId: machine.id, signal: input.signal };
        let standardSearchEnabled = false;
        try {
            const settingsRead = await fetchDaemonMemorySettings(target);
            input.signal?.throwIfAborted();
            if (!settingsRead.supported) return { machineId: machine.id, status: 'outdated', standardSearchEnabled: false };
            const settings = settingsRead.settings;
            standardSearchEnabled = settings.conversationSearch.standardSearch.enabled;
            let sourcesUnavailable = false;
            const sources = input.readSources && query.scope.type === 'global'
                && (!query.corpora || query.corpora.includes('external_transcripts'))
                ? (await input.readSources(machine.id).catch(() => { input.signal?.throwIfAborted(); sourcesUnavailable = true; return []; })).filter(source => !externalSource
                    || (source.agentId === externalSource.agentId && source.sourceKey === externalSource.sourceKey)) : [];
            input.signal?.throwIfAborted();
            let machineStatus: ConversationSearchMachineStatus['status'] = 'disabled-by-settings';
            let documents: ConversationSearchMachineStatus['documents'];
            let indexed = false;
            let nativeIndexedUsable = false;
            let indexSources: readonly MemoryIndexSourceStatusV1[] | undefined;
            if (mode !== 'standard' && !continuation?.sourceKey && input.daemonEnabled !== false && settings.enabled) {
                let statusFailure: 'outdated' | 'partial' | undefined;
                const status = await fetchDaemonMemoryStatus(target).catch(error => {
                    input.signal?.throwIfAborted();
                    statusFailure = isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error) ? 'outdated' : 'partial';
                    return null;
                });
                input.signal?.throwIfAborted();
                indexSources = status?.sources;
                const nativeReady = settings.conversationSearch.indexExternal.enabled && status?.deepIndexReady === true;
                nativeIndexedUsable = nativeReady && !query.query.trim();
                const queuePending = status?.queue ? status.queue.queuedSessionCount + status.queue.indexingSessionCount + status.queue.failedSessionCount + status.queue.waitingSessionCount : 0;
                indexed = isDaemonMemorySearchUsable(status) || nativeReady;
                machineStatus = status === null ? statusFailure ?? 'outdated' : indexed ? 'ok' : 'partial';
                // Pre-X5 daemons can answer Session search without the readiness RPC.
                // Keep only that released direction; native/doc readiness is never guessed.
                if (query.query.trim() && status === null && !input.homeSessions && (!query.corpora || query.corpora.includes('sessions'))) {
                    const result = await searchDaemonMemory({ ...query, corpora: undefined, ...target, cursor: continuation?.cursor ?? cursor });
                    input.signal?.throwIfAborted();
                    documents = 'unavailable';
                    if (result.ok) hits.push(...indexedRows(machine.id, result.hits.filter(isMemorySessionSearchHitV1)));
                }
                if (indexed && query.query.trim()) {
                    const corpora = (query.corpora ?? ['sessions', 'external_transcripts']).filter(corpus =>
                        (corpus !== 'sessions' || !input.homeSessions) && (corpus !== 'external_transcripts' || settings.conversationSearch.indexExternal.enabled));
                    if (corpora.length > 0) {
                        const result = await searchDaemonMemory({ ...query, ...target, corpora, cursor: continuation?.cursor ?? cursor });
                        input.signal?.throwIfAborted();
                        if (result.ok) {
                            nativeIndexedUsable = nativeReady && corpora.includes('external_transcripts');
                            if (nativeIndexedUsable && (!indexSources || (externalSource
                                ? !indexSources.some(source => source.source.type === 'external_transcript'
                                    && source.source.agentId === externalSource.agentId && source.source.sourceKey === externalSource.sourceKey && source.state === 'ready')
                                : indexSources.some(source => source.source.type === 'external_transcript' && source.state !== 'ready')))) machineStatus = 'partial';
                            if (corpora.includes('sessions') && indexSources?.some(source => source.source.type === 'happier_session' && source.state !== 'ready')) machineStatus = 'partial';
                            hits.push(...indexedRows(machine.id, result.hits));
                            documents = result.documents?.state ?? 'unavailable';
                            if (result.nextCursor) continuations.push({ machineId: machine.id, cursor: result.nextCursor });
                            if (result.hasMore || queuePending > 0) machineStatus = 'partial';
                        } else machineStatus = result.errorCode === 'memory_disabled' ? 'disabled-by-settings'
                            : result.errorCode === 'memory_index_missing' ? 'outdated' : 'partial';
                    }
                }
            }
            const projectedSources = sources.map(source => ({ ...source, machineId: machine.id,
                key: JSON.stringify([machine.id, source.key ?? source.sourceKey]),
                // Native inventory currently indexes top-level conversations, not threads.
                indexReady: nativeIndexedUsable && !input.includeThreads && (indexSources?.some(row => row.source.type === 'external_transcript'
                    && row.source.agentId === source.agentId && row.source.sourceKey === source.sourceKey && row.state === 'ready') ?? false),
            }));
            sourcesResult.push(...projectedSources);
            input.onSources?.([...sourcesResult]);
            if (sourcesUnavailable || (nativeIndexedUsable && projectedSources.some(source => !source.indexReady))) machineStatus = 'partial';
            // Only an explicit caller (Action or activated scan surface) selects auto/standard.
            // Palette typing always selects indexed and cannot enter this branch.
            if (query.query.trim() && mode !== 'indexed' && listCandidates && (standardSearchEnabled || nativeIndexedUsable) && input.readSources && query.scope.type === 'global'
                && (!query.corpora || query.corpora.includes('external_transcripts'))) {
                input.signal?.throwIfAborted();
                if (!nativeIndexedUsable) machineStatus = sources.length ? 'ok' : 'outdated';
                for (const source of projectedSources) {
                    if (continuation && continuation.sourceKey !== undefined && continuation.sourceKey !== source.sourceKey) continue;
                    if (continuation && continuation.sourceKey === undefined) continue;
                    input.signal?.throwIfAborted();
                    const ready = source.indexReady;
                    if (mode === 'auto' && ready) continue;
                    if (nativeIndexedUsable && !ready) machineStatus = 'partial';
                    if (!standardSearchEnabled) continue;
                    // Standard RPCs have no message-date filter contract. Do not
                    // substitute conversation modification time for message time.
                    if (query.createdAfterMs !== undefined || query.createdBeforeMs !== undefined) { machineStatus = 'partial'; continue; }
                    if (!source.contentSearch) { machineStatus = 'partial'; continue; }
                    const request = { machineId: machine.id, agentId: source.agentId,
                        source: source.source, searchTerm: query.query, searchTarget: 'content',
                        ...(input.includeThreads ? { includeThreads: true } : {}),
                    } as const;
                    let result = await listCandidates({ ...request,
                        ...(continuation ? { cursor: continuation.cursor } : {}) }, target);
                    input.signal?.throwIfAborted();
                    if (continuation && result.ok && result.cursorReset) {
                        resetSources.push({ machineId: machine.id, sourceKey: source.sourceKey });
                        result = await listCandidates(request, target);
                    }
                    input.signal?.throwIfAborted();
                    if (!result.ok) { machineStatus = 'partial'; continue; }
                    if (result.contentCoverage === 'complete' && !result.nextCursor && !result.preparation && !result.searchIncomplete) {
                        completedStandardSources.push({ machineId: machine.id, agentId: source.agentId, sourceKey: source.sourceKey });
                    }
                    hits.push(...result.candidates.filter(candidate => candidate.match)
                        .map(candidate => ({ machineId: machine.id, mode: 'standard' as const, agentId: source.agentId, sourceKey: source.sourceKey, source: source.source, candidate })));
                    if (result.nextCursor) continuations.push({ machineId: machine.id, sourceKey: source.sourceKey, cursor: result.nextCursor });
                    if (result.contentCoverage !== 'complete' || result.nextCursor || result.preparation || result.searchIncomplete) machineStatus = 'partial';
                }
            }
            return { machineId: machine.id, status: machineStatus, standardSearchEnabled, ...(documents ? { documents } : {}) };
        } catch (error) {
            input.signal?.throwIfAborted();
            return { machineId: machine.id,
                status: isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error) ? 'outdated' : 'partial', standardSearchEnabled };
        }
    }), input.concurrencyLimit);
    const [machines, homeResult] = await Promise.all([machineWork, home]);
    let homeStatus: ConversationSearchResult['homeStatus'];
    if (homeResult) {
        const result = homeResult;
        input.signal?.throwIfAborted();
        if (result.ok) {
            hits.push(...indexedRows(null, result.hits));
            if (result.nextCursor) continuations.push({ machineId: null, cursor: result.nextCursor });
            homeStatus = result.hasMore ? 'partial' : 'ok';
        } else homeStatus = 'unavailable';
    }
    // A fully consumed current scan supersedes that source's potentially stale
    // indexed projection. Partial scans cannot prove an indexed item disappeared.
    const currentHits = hits.filter(row => {
        if (row.mode !== 'indexed') return true;
        const hit = row.hit;
        return !isMemoryExternalTranscriptSearchHitV1(hit) || !completedStandardSources.some(source => source.machineId === row.machineId
            && source.agentId === hit.source.agentId && source.sourceKey === hit.source.sourceKey);
    });
    const authorized = input.authorize ? await input.authorize(currentHits) : currentHits;
    input.signal?.throwIfAborted();
    return { hits: mergeConversationSearchHits(authorized), machines,
        ...(homeStatus ? { homeStatus } : {}), ...(sourcesResult.length ? { sources: sourcesResult } : {}),
        ...(continuations.length ? { continuations } : {}), ...(resetSources.length ? { resetSources } : {}),
        ...(completedStandardSources.length ? { completedStandardSources } : {}) };
}
