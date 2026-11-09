import { isMemorySessionSearchHitV1, isMemoryExternalTranscriptSearchHitV1, type MemoryDocumentSearchCoverageV1, type MemorySearchHitV1, type MemorySearchQueryV1, type MemorySearchResultHitV1 } from '@happier-dev/protocol/memory/memorySearch';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ExternalSessionCandidateV1, ExternalSessionsCandidatesListResponse, ExternalSessionsSource } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import type { MemoryIndexSourceStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import type { ConversationSearchSourceFailureV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { fetchDaemonMemorySettings } from '../memory/fetchDaemonMemorySettings';
import { fetchDaemonMemoryStatus } from '../memory/fetchDaemonMemoryStatus';
import { searchDaemonMemory } from '../memory/searchDaemonMemory';
import { searchHomeMemory } from '../memory/searchHomeMemory';
import { isDaemonMemorySearchUsable } from '../memory/isDaemonMemorySearchUsable';
import { normalizeMemorySearchSessionId } from '../memory/applyMemorySearchSessionEligibility';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { mergeConversationSearchHits } from './mergeConversationSearchHits';
export { mergeConversationSearchHits } from './mergeConversationSearchHits';

export type ConversationSearchMachine = Readonly<{ id: string; online: boolean }>;
export type ConversationSearchSource = Readonly<{ agentId: string; sourceKey: string; source: ExternalSessionsSource; contentSearch: boolean; key?: string; label?: string; detail?: string }>;
export type ConversationSearchHit =
    | Readonly<{ machineId: string | null; mode: 'indexed'; hit: MemorySearchResultHitV1 }>
    | Readonly<{ machineId: string; mode: 'standard'; agentId: string; sourceKey: string; source: ExternalSessionsSource; candidate: ExternalSessionCandidateV1 }>;
export type ConversationSearchMachineStatus = Readonly<{ machineId: string; status: 'ok' | 'offline' | 'outdated' | 'partial' | 'disabled-by-settings'; standardSearchEnabled?: boolean; documents?: MemoryDocumentSearchCoverageV1['state'] }>;
export type ConversationSearchResult = Readonly<{
    hits: readonly ConversationSearchHit[];
    machines: readonly ConversationSearchMachineStatus[];
    failures?: readonly ConversationSearchSourceFailureV1[];
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
        || result.sources.some(source => source.machineId === machine.machineId && source.indexReady !== true
            && !result.failures?.some(failure => failure.machineId === source.machineId && failure.agentId === source.agentId
                && failure.sourceKey === source.sourceKey && !failure.retryable))
    )) ?? false;
}

/** A read setting explicitly blocks the standard fallback needed for this search. */
export function isConversationSearchOnDemandOff(result: ConversationSearchResult | null, machineId: string | null | undefined): boolean {
    const machine = result?.machines.find(value => value.machineId === machineId);
    return machine?.status === 'disabled-by-settings' && machine.standardSearchEnabled === false;
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

export async function searchConversations(input: Readonly<{
    serverId: string;
    accountId: string;
    machines: readonly ConversationSearchMachine[];
    /** A person's Retry must reach the daemon even after a failed admission observation. */
    retryUnreachableMachines?: boolean;
    query: MemorySearchQueryV1;
    signal?: AbortSignal;
    /** Temporary cap on concurrent Machines; see the machine fan-out below. */
    concurrencyLimit?: number;
    mode?: 'auto' | 'indexed' | 'standard';
    homeSessions?: boolean;
    daemonEnabled?: boolean;
    includeThreads?: boolean;
    /** Source materialization is shared with the History browser's projection owner. */
    readSources?: (machineId: string) => Promise<readonly ConversationSearchSource[]>;
    continuation?: NonNullable<ConversationSearchResult['continuations']>[number];
    /** Reuses the page owner for a failed first page, without inventing a cursor. */
    retrySource?: Pick<ConversationSearchSourceFailureV1, 'machineId' | 'agentId' | 'sourceKey'>;
    /** Qualifies arriving hits and retained ranges of the same Sessions before deduplication. */
    authorize?: (rows: readonly ConversationSearchHit[]) => Promise<readonly ConversationSearchHit[]>;
    onSources?: (sources: NonNullable<ConversationSearchResult['sources']>) => void;
    /** Completed pages are authorized before publication while other sources run. */
    onProgress?: (result: ConversationSearchResult) => void;
}>): Promise<ConversationSearchResult> {
    input.signal?.throwIfAborted();
    const mode = input.retrySource ? 'standard' : input.mode ?? 'indexed';
    // Resolve the one transport adapter before starting concurrent machine work.
    // Indexed typing never loads the standard scanner's dependency corridor.
    const listCandidates = mode === 'indexed' ? null
        : (await import('@/sync/ops/machineExternalSessions')).machineExternalSessionsCandidatesList;
    input.signal?.throwIfAborted();
    const { cursor: rawCursor, ...query } = input.query;
    const externalSource = query.externalSource;
    const continuation = input.continuation ?? readQualifiedCursor(rawCursor);
    const cursor = continuation ? undefined : rawCursor;
    // A failed page has not consumed its cursor. Keep it available to
    // every caller until the producing source returns a page or rejects it.
    let pendingContinuation = continuation;
    const pendingHits: ConversationSearchHit[] = [];
    let hits: readonly ConversationSearchHit[] = [];
    const continuations: NonNullable<ConversationSearchResult['continuations']>[number][] = [];
    const sourcesResult: NonNullable<ConversationSearchResult['sources']>[number][] = [];
    const resetSources: NonNullable<ConversationSearchResult['resetSources']>[number][] = [];
    const failures: ConversationSearchSourceFailureV1[] = [];
    const completedStandardSources: NonNullable<ConversationSearchResult['completedStandardSources']>[number][] = [];
    const machineStatuses = new Map<string, ConversationSearchMachineStatus>();
    let homeStatus: ConversationSearchResult['homeStatus'];
    const readResult = async (machines: readonly ConversationSearchMachineStatus[]): Promise<ConversationSearchResult> => {
        input.signal?.throwIfAborted();
        // Progress carries arrivals separately from the operation's admitted
        // results: peer/status-only publications never repeat Session reads.
        const received = pendingHits.splice(0);
        if (received.length) {
            // Machine carriers do not change a Session hit's canonical identity.
            // Compare the admitted wire facts, including seq ranges and content,
            // so a peer replay cannot trigger another visibility read.
            const admittedBySession = new Map<string, MemorySearchHitV1[]>();
            for (const row of hits) {
                if (row.mode !== 'indexed' || !isMemorySessionSearchHitV1(row.hit)) continue;
                const previous = admittedBySession.get(row.hit.sessionId);
                if (previous) previous.push(row.hit);
                else admittedBySession.set(row.hit.sessionId, [row.hit]);
            }
            const arriving = received.filter(row => row.mode !== 'indexed' || !isMemorySessionSearchHitV1(row.hit)
                || !admittedBySession.get(row.hit.sessionId)?.some(hit => sameStrictJsonValue(hit, row.hit, { omitUndefinedObjectMembers: true })));
            const changedSessions = new Set(arriving.flatMap(row => row.mode === 'indexed' && isMemorySessionSearchHitV1(row.hit)
                ? [row.hit.sessionId] : []));
            const retained: ConversationSearchHit[] = [];
            const candidates: ConversationSearchHit[] = [];
            for (const row of hits) {
                // A new range supplies fresh visibility for all retained ranges
                // of its Session, including denial or a lower visible ceiling.
                if (row.mode === 'indexed' && isMemorySessionSearchHitV1(row.hit) && changedSessions.has(row.hit.sessionId)) candidates.push(row);
                else retained.push(row);
            }
            candidates.push(...arriving);
            if (candidates.length) {
                const authorized = input.authorize ? await input.authorize(candidates) : candidates;
                input.signal?.throwIfAborted();
                hits = [...retained, ...authorized];
            }
        }
        // A complete current scan supersedes only its own stale indexed projection.
        const currentHits = hits.filter(row => {
            if (row.mode !== 'indexed') return true;
            const hit = row.hit;
            return !isMemoryExternalTranscriptSearchHitV1(hit) || !completedStandardSources.some(source => source.machineId === row.machineId
                && source.agentId === hit.source.agentId && source.sourceKey === hit.source.sourceKey);
        });
        const remainingContinuations = pendingContinuation ? [pendingContinuation, ...continuations] : continuations;
        const result = { machines, ...(failures.length ? { failures: [...failures] } : {}),
            ...(homeStatus ? { homeStatus } : {}), ...(sourcesResult.length ? { sources: [...sourcesResult] } : {}),
            ...(remainingContinuations.length ? { continuations: [...remainingContinuations] } : {}), ...(resetSources.length ? { resetSources: [...resetSources] } : {}),
            ...(completedStandardSources.length ? { completedStandardSources: [...completedStandardSources] } : {}) };
        input.signal?.throwIfAborted();
        return { ...result, hits: mergeConversationSearchHits(currentHits, sourcesResult) };
    };
    // Authorization is asynchronous. Publish in order so a slower visibility
    // read cannot replace a newer page with an older snapshot.
    let publication = Promise.resolve();
    const publish = () => {
        if (!input.onProgress) return Promise.resolve();
        publication = publication.then(async () => {
            input.signal?.throwIfAborted();
            const result = await readResult(input.machines.flatMap(machine => {
                const status = machineStatuses.get(machine.id);
                return status ? [status] : [];
            }));
            input.onProgress?.(result);
        });
        return publication;
    };
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
    const searchMachine = async (machine: ConversationSearchMachine): Promise<ConversationSearchMachineStatus> => {
        input.signal?.throwIfAborted();
        if (!machine.online && input.retryUnreachableMachines !== true) return { machineId: machine.id, status: 'offline' };
        const target = { serverId: input.serverId, accountId: input.accountId, machineId: machine.id, signal: input.signal };
        // An unread setting is unknown. Only a successful read can establish
        // that standard search is enabled or disabled on this Machine.
        let standardSearchEnabled: boolean | undefined;
        try {
            const settingsRead = await fetchDaemonMemorySettings(target);
            input.signal?.throwIfAborted();
            if (!settingsRead.supported) return { machineId: machine.id, status: 'outdated' };
            const settings = settingsRead.settings;
            standardSearchEnabled = settings.conversationSearch.standardSearch.enabled;
            let sourcesUnavailable = false;
            const sourcesRead = input.readSources && query.scope.type === 'global'
                && (!query.corpora || query.corpora.includes('external_transcripts'))
                ? input.readSources(machine.id).catch(() => { input.signal?.throwIfAborted(); sourcesUnavailable = true; return []; })
                    .then(sources => sources.filter(source => !externalSource
                        || (source.agentId === externalSource.agentId && source.sourceKey === externalSource.sourceKey))) : [];
            const needsStatus = mode !== 'standard' && !continuation?.sourceKey && input.daemonEnabled !== false && settings.enabled;
            let statusFailure: 'outdated' | 'partial' | undefined;
            // Source declarations and index readiness are independent reads once
            // settings admit the index. Gather both before awaiting either reply.
            const statusRead = needsStatus ? fetchDaemonMemoryStatus(target).catch(error => {
                input.signal?.throwIfAborted();
                statusFailure = isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error) ? 'outdated' : 'partial';
                return null;
            }) : null;
            const [sources, status] = await Promise.all([sourcesRead, statusRead]);
            input.signal?.throwIfAborted();
            let machineStatus: ConversationSearchMachineStatus['status'] = 'disabled-by-settings';
            let documents: ConversationSearchMachineStatus['documents'];
            let indexed = false;
            let indexReadFailed = false;
            let nativeIndexedUsable = false;
            let indexSources: readonly MemoryIndexSourceStatusV1[] | undefined;
            if (needsStatus) {
                indexSources = status?.sources;
                const nativeReady = settings.conversationSearch.indexExternal.enabled && status?.deepIndexReady === true;
                nativeIndexedUsable = nativeReady && !query.query.trim();
                const queuePending = status?.queue ? status.queue.queuedSessionCount + status.queue.indexingSessionCount + status.queue.failedSessionCount + status.queue.waitingSessionCount : 0;
                indexed = isDaemonMemorySearchUsable(status) || nativeReady;
                machineStatus = status === null ? statusFailure ?? 'outdated' : indexed ? 'ok' : 'partial';
                if (indexed && query.query.trim()) {
                    const corpora = (query.corpora ?? ['sessions', 'external_transcripts']).filter(corpus =>
                        (corpus !== 'sessions' || !input.homeSessions) && (corpus !== 'external_transcripts' || settings.conversationSearch.indexExternal.enabled));
                    // Document admission reads current attachments before disclosure. It
                    // must not hold already indexed conversations behind that separate IO.
                    const separateDocuments = corpora.includes('documents') && corpora.some(corpus => corpus !== 'documents');
                    const documentSearch = separateDocuments && !continuation && !cursor
                        ? searchDaemonMemory({ ...query, ...target, corpora: ['documents'], cursor: undefined }).catch(() => null)
                        : null;
                    if (documentSearch) documents = 'pending';
                    if (corpora.length > 0) {
                        const result = await searchDaemonMemory({ ...query, ...target,
                            corpora: separateDocuments ? corpora.filter(corpus => corpus !== 'documents') : corpora,
                            cursor: continuation?.cursor ?? cursor }).catch(() => {
                            input.signal?.throwIfAborted();
                            indexReadFailed = true;
                            return null;
                        });
                        input.signal?.throwIfAborted();
                        if (result?.ok) {
                            pendingContinuation = undefined;
                            nativeIndexedUsable = nativeReady && corpora.includes('external_transcripts');
                            if (nativeIndexedUsable && (!indexSources || (externalSource
                                ? !indexSources.some(source => source.source.type === 'external_transcript'
                                    && source.source.agentId === externalSource.agentId && source.source.sourceKey === externalSource.sourceKey && source.state === 'ready')
                                : indexSources.some(source => source.source.type === 'external_transcript' && source.state !== 'ready')))) machineStatus = 'partial';
                            if (corpora.includes('sessions') && indexSources?.some(source => source.source.type === 'happier_session' && source.state !== 'ready')) machineStatus = 'partial';
                            pendingHits.push(...indexedRows(machine.id, result.hits));
                            if (!separateDocuments) documents = result.documents?.state ?? 'unavailable';
                            if (result.nextCursor) continuations.push({ machineId: machine.id, cursor: result.nextCursor });
                            if (result.hasMore || queuePending > 0) machineStatus = 'partial';
                        } else machineStatus = result?.errorCode === 'memory_disabled' ? 'disabled-by-settings'
                            : result?.errorCode === 'memory_index_missing' ? 'outdated' : 'partial';
                    }
                    if (documentSearch) {
                        machineStatuses.set(machine.id, { machineId: machine.id, status: 'partial', standardSearchEnabled, documents: 'pending' });
                        await publish();
                        const result = await documentSearch;
                        input.signal?.throwIfAborted();
                        documents = result?.ok ? result.documents?.state ?? 'unavailable' : 'unavailable';
                        if (result?.ok) pendingHits.push(...indexedRows(machine.id, result.hits));
                        if (documents !== 'ready') machineStatus = 'partial';
                    }
                }
            }
            // Required decoder diagnostics have already established an unreadable
            // source. Preserve that typed failure; the scan uses the same decoder.
            for (const source of indexSources ?? []) {
                if (source.source.type !== 'external_transcript' || source.state !== 'error' || source.errorCode !== 'unsupported'
                    || source.errorReason !== 'external_sessions_transcript_read_failed') continue;
                if (externalSource && (source.source.agentId !== externalSource.agentId || source.source.sourceKey !== externalSource.sourceKey)) continue;
                failures.push({ machineId: machine.id, agentId: source.source.agentId, sourceKey: source.source.sourceKey,
                    errorCode: 'agent_unavailable', retryable: false });
            }
            const projectedSources = sources.map(source => ({ ...source, machineId: machine.id,
                key: JSON.stringify([machine.id, source.key ?? source.sourceKey]),
                // Native inventory currently indexes top-level conversations, not threads.
                indexReady: nativeIndexedUsable && !input.includeThreads && (indexSources?.some(row => row.source.type === 'external_transcript'
                    && row.source.agentId === source.agentId && row.source.sourceKey === source.sourceKey && row.state === 'ready') ?? false),
            }));
            sourcesResult.push(...projectedSources);
            input.onSources?.([...sourcesResult]);
            machineStatuses.set(machine.id, { machineId: machine.id, status: 'partial', standardSearchEnabled, ...(documents ? { documents } : {}) });
            await publish();
            if (sourcesUnavailable || (nativeIndexedUsable && projectedSources.some(source => !source.indexReady))) machineStatus = 'partial';
            // Only an explicit caller (Action or activated scan surface) selects auto/standard.
            // Palette typing always selects indexed and cannot enter this branch.
            if (query.query.trim() && mode !== 'indexed' && listCandidates && (standardSearchEnabled || nativeIndexedUsable) && input.readSources && query.scope.type === 'global'
                && (!query.corpora || query.corpora.includes('external_transcripts'))) {
                input.signal?.throwIfAborted();
                if (!nativeIndexedUsable) machineStatus = sources.length ? 'ok' : 'outdated';
                for (const source of projectedSources) {
                    if (input.retrySource && (source.agentId !== input.retrySource.agentId || source.sourceKey !== input.retrySource.sourceKey)) continue;
                    if (continuation && continuation.sourceKey !== undefined && continuation.sourceKey !== source.sourceKey) continue;
                    if (continuation && continuation.sourceKey === undefined) continue;
                    input.signal?.throwIfAborted();
                    const ready = source.indexReady;
                    if (mode === 'auto' && ready) continue;
                    if (mode === 'auto' && failures.some(failure => failure.machineId === machine.id && failure.agentId === source.agentId
                        && failure.sourceKey === source.sourceKey && !failure.retryable)) continue;
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
                    let result: ExternalSessionsCandidatesListResponse;
                    try {
                        result = await listCandidates({ ...request,
                            ...(continuation ? { cursor: continuation.cursor } : {}) }, target);
                        input.signal?.throwIfAborted();
                        if (continuation && result.ok && result.cursorReset) {
                            pendingContinuation = undefined;
                            resetSources.push({ machineId: machine.id, sourceKey: source.sourceKey });
                            result = await listCandidates(request, target);
                        }
                    } catch (error) {
                        input.signal?.throwIfAborted();
                        machineStatus = isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error) ? 'outdated' : 'partial';
                        // No native failure envelope arrived. Preserve a retryable
                        // operation failure without inventing an Agent diagnosis.
                        if (machineStatus !== 'outdated') failures.push({ machineId: machine.id, agentId: source.agentId, sourceKey: source.sourceKey,
                            errorCode: 'internal_error', retryable: true });
                        await publish();
                        continue;
                    }
                    input.signal?.throwIfAborted();
                    if (!result.ok) {
                        machineStatus = 'partial';
                        failures.push({ machineId: machine.id, agentId: source.agentId, sourceKey: source.sourceKey,
                            errorCode: result.errorCode, retryable: result.retryable !== false });
                        await publish();
                        continue;
                    }
                    pendingContinuation = undefined;
                    if (result.contentCoverage === 'complete' && !result.nextCursor && !result.preparation && !result.searchIncomplete) {
                        completedStandardSources.push({ machineId: machine.id, agentId: source.agentId, sourceKey: source.sourceKey });
                    }
                    pendingHits.push(...result.candidates.filter(candidate => candidate.match)
                        .map(candidate => ({ machineId: machine.id, mode: 'standard' as const, agentId: source.agentId, sourceKey: source.sourceKey, source: source.source, candidate })));
                    if (result.nextCursor) continuations.push({ machineId: machine.id, sourceKey: source.sourceKey, cursor: result.nextCursor });
                    if (result.contentCoverage !== 'complete' || result.nextCursor || result.preparation || result.searchIncomplete) machineStatus = 'partial';
                    await publish();
                }
            }
            const standardFallbackBlocked = !standardSearchEnabled && query.scope.type === 'global'
                && (!query.corpora || query.corpora.includes('external_transcripts'))
                && (!nativeIndexedUsable || sourcesUnavailable || projectedSources.some(source => !source.indexReady));
            return { machineId: machine.id, status: standardFallbackBlocked ? 'disabled-by-settings'
                : indexReadFailed ? 'partial' : machineStatus, standardSearchEnabled, ...(documents ? { documents } : {}) };
        } catch (error) {
            input.signal?.throwIfAborted();
            return { machineId: machine.id,
                status: isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error) ? 'outdated' : 'partial',
                ...(standardSearchEnabled === undefined ? {} : { standardSearchEnabled }) };
        }
    };
    // Each Machine has its own daemon and admitted RPC lifetime. A pending peer
    // must not occupy a Session-hydration slot and block unrelated Machines.
    const machineTasks = input.machines.filter(machine => (!continuation || continuation.machineId === machine.id)
        && (!input.retrySource || input.retrySource.machineId === machine.id)).map(machine => async () => {
        const status = await searchMachine(machine);
        machineStatuses.set(machine.id, status);
        await publish();
        return status;
    });
    // Temporary mitigation (FSP perf-r337 / Systemic rpc-lost-ack-1028): the scoped Machine
    // relay loses completed replies under wide concurrent fan-out, and a lost reply never
    // settles. Callers may cap Machines until that fix lands; then remove this input.
    const machineWork = input.concurrencyLimit === undefined
        ? Promise.all(machineTasks.map(task => task()))
        : runTasksWithLimit(machineTasks, input.concurrencyLimit);
    const homeWork = home?.then(async result => {
        input.signal?.throwIfAborted();
        if (result.ok) {
            pendingContinuation = undefined;
            pendingHits.push(...indexedRows(null, result.hits));
            if (result.nextCursor) continuations.push({ machineId: null, cursor: result.nextCursor });
            homeStatus = result.hasMore ? 'partial' : 'ok';
        } else homeStatus = 'unavailable';
        await publish();
    });
    const [machines] = await Promise.all([machineWork, homeWork]);
    return readResult(machines);
}
