import * as React from 'react';
import type {
    ExternalSessionActivityV1,
    ExternalSessionsAgentId,
    ExternalSessionsCandidatesListResponse,
    ExternalSessionsSource,
    PluginAgentExternalSessionLinkData,
} from '@happier-dev/protocol';

import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { machineExternalSessionsCandidatesList } from '@/sync/ops/machineExternalSessions';
import { t } from '@/text';
import {
    resolveExternalSessionBrowseRpcErrorMessage,
    resolveExternalSessionBrowseThrownErrorMessage,
} from './externalSessionBrowseErrorPresentation';

export type ExternalSessionBrowseCandidate = Readonly<{
    remoteSessionId: string;
    candidateKey?: string;
    title?: string;
    updatedAtMs: number;
    activity?: ExternalSessionActivityV1;
    details?: Record<string, unknown>;
    linkData?: PluginAgentExternalSessionLinkData;
    linkedSessionId?: string;
    imported?: boolean;
    materializedThrough?: number;
}>;

export type ExternalSessionBrowsePreparation = NonNullable<
    Extract<ExternalSessionsCandidatesListResponse, { ok: true }>['preparation']
>;
export type ExternalSessionBrowseAutoLinkPolicyScope = NonNullable<
    Extract<ExternalSessionsCandidatesListResponse, { ok: true }>['autoLinkPolicyScopeV1']
>;

export function readExternalSessionBrowseCandidateKey(
    candidate: Pick<ExternalSessionBrowseCandidate, 'candidateKey' | 'remoteSessionId'>,
): string {
    return candidate.candidateKey ?? candidate.remoteSessionId;
}

export function readExternalSessionBrowseCandidatePath(
    details: ExternalSessionBrowseCandidate['details'],
): string | null {
    const cwd = typeof details?.cwd === 'string' ? details.cwd.trim() : '';
    if (cwd) return cwd;
    const path = typeof details?.path === 'string' ? details.path.trim() : '';
    return path || null;
}

const CANDIDATES_PAGE_LIMIT = 50;
const MAX_CANDIDATE_INDEX_PREPARATION_REQUESTS = 250;
const MAX_EMPTY_FULL_SEARCH_PAGE_REQUESTS = 20;

/**
 * `republish` is the completed-full-search arm: the served page is authoritative
 * for its own order and field values, but it is not a superset of what is on
 * screen — the fast pass reads on-disk rollouts (exec-mode sessions no app
 * server owns) that a full search cannot return. It therefore leads with the
 * canonical page and keeps the rows this page did not serve, instead of
 * blanking candidates the user was already looking at.
 */
type CandidateApplyMode = 'replace' | 'append' | 'merge' | 'republish';
type CandidateSearchMode = 'fast' | 'full';
type CandidateContinuation = Readonly<{
    cursor: string;
    searchMode?: CandidateSearchMode;
}>;

function readCandidateContinuationKey(continuation: CandidateContinuation): string {
    return JSON.stringify([continuation.searchMode ?? null, continuation.cursor]);
}

function hasCandidateTitle(candidate: ExternalSessionBrowseCandidate): boolean {
    return typeof candidate.title === 'string' && candidate.title.trim().length > 0;
}

function mergeCandidateDetails(
    current: ExternalSessionBrowseCandidate['details'],
    next: ExternalSessionBrowseCandidate['details'],
): ExternalSessionBrowseCandidate['details'] {
    if (!current) return next;
    if (!next) return current;
    return { ...current, ...next };
}

function mergeExternalSessionBrowseCandidate(
    current: ExternalSessionBrowseCandidate,
    next: ExternalSessionBrowseCandidate,
): ExternalSessionBrowseCandidate {
    return {
        remoteSessionId: current.remoteSessionId,
        candidateKey: next.candidateKey ?? current.candidateKey,
        title: hasCandidateTitle(next) ? next.title : current.title,
        updatedAtMs: Math.max(current.updatedAtMs, next.updatedAtMs),
        activity: next.activity ?? current.activity,
        details: mergeCandidateDetails(current.details, next.details),
        linkData: next.linkData ?? current.linkData,
        linkedSessionId: next.linkedSessionId ?? current.linkedSessionId,
        imported: next.imported ?? current.imported,
        materializedThrough: next.materializedThrough ?? current.materializedThrough,
    };
}

function mergeExternalSessionBrowseCandidates(
    current: readonly ExternalSessionBrowseCandidate[],
    next: readonly ExternalSessionBrowseCandidate[],
): readonly ExternalSessionBrowseCandidate[] {
    const merged = new Map<string, ExternalSessionBrowseCandidate>();
    for (const candidate of current) {
        merged.set(readExternalSessionBrowseCandidateKey(candidate), candidate);
    }
    for (const candidate of next) {
        const candidateKey = readExternalSessionBrowseCandidateKey(candidate);
        const existing = merged.get(candidateKey);
        merged.set(candidateKey, existing ? mergeExternalSessionBrowseCandidate(existing, candidate) : candidate);
    }
    return Array.from(merged.values());
}

/**
 * Publish an authoritative page in its own canonical order while keeping the
 * rows it did not serve. Overlapping rows take the served page's fields, so a
 * refreshed title still wins; unserved rows follow, still reachable.
 */
function republishExternalSessionBrowseCandidates(
    current: readonly ExternalSessionBrowseCandidate[],
    next: readonly ExternalSessionBrowseCandidate[],
): readonly ExternalSessionBrowseCandidate[] {
    const currentByKey = new Map(current.map((candidate) => [
        readExternalSessionBrowseCandidateKey(candidate),
        candidate,
    ] as const));
    const servedKeys = new Set<string>();
    const served = next.map((candidate) => {
        const candidateKey = readExternalSessionBrowseCandidateKey(candidate);
        servedKeys.add(candidateKey);
        const existing = currentByKey.get(candidateKey);
        return existing
            ? mergeExternalSessionBrowseCandidate(existing, candidate)
            : candidate;
    });
    return [
        ...served,
        ...current.filter((candidate) => !servedKeys.has(
            readExternalSessionBrowseCandidateKey(candidate),
        )),
    ];
}

/**
 * A candidate index that is still building re-serves the same sorted prefix on
 * every progress round-trip, so equal rows keep their object identity and an
 * unchanged listing keeps its array identity instead of rebuilding the list on
 * each of the thousands of round-trips a cold index needs.
 */
function preserveExternalSessionBrowseCandidateIdentity(
    current: readonly ExternalSessionBrowseCandidate[],
    next: readonly ExternalSessionBrowseCandidate[],
): readonly ExternalSessionBrowseCandidate[] {
    if (current === next) return current;
    const currentByKey = new Map(current.map((candidate) => [
        readExternalSessionBrowseCandidateKey(candidate),
        candidate,
    ] as const));
    let changed = current.length !== next.length;
    const preserved = next.map((candidate, index) => {
        const existing = currentByKey.get(readExternalSessionBrowseCandidateKey(candidate));
        if (existing && (existing === candidate || JSON.stringify(existing) === JSON.stringify(candidate))) {
            if (current[index] !== existing) changed = true;
            return existing;
        }
        changed = true;
        return candidate;
    });
    return changed ? preserved : current;
}

export function useExternalSessionBrowseCandidates(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    providerId: ExternalSessionsAgentId | null;
    source: ExternalSessionsSource | null;
    searchTerm?: string;
    enabled?: boolean;
}>) {
    const { machineId, providerId, searchTerm, source, serverId } = params;
    const enabled = params.enabled !== false;
    const normalizedSearchTerm = typeof searchTerm === 'string' ? searchTerm.trim() : '';
    const currentScopeKey = React.useMemo(() => JSON.stringify({
        machineId,
        serverId: serverId ?? null,
        providerId,
        source,
        searchTerm: normalizedSearchTerm || null,
    }), [machineId, normalizedSearchTerm, providerId, serverId, source]);
    const scopedSourceRef = React.useRef<Readonly<{
        scopeKey: string;
        source: ExternalSessionsSource | null;
    }>>({
        scopeKey: currentScopeKey,
        source,
    });
    if (scopedSourceRef.current.scopeKey !== currentScopeKey) {
        scopedSourceRef.current = {
            scopeKey: currentScopeKey,
            source,
        };
    }
    const scopedSource = scopedSourceRef.current.source;

    const [candidates, setCandidates] = React.useState<readonly ExternalSessionBrowseCandidate[]>([]);
    const [nextPage, setNextPage] = React.useState<CandidateContinuation | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [searchAugmenting, setSearchAugmenting] = React.useState(false);
    const [searchIncomplete, setSearchIncomplete] = React.useState(false);
    const [annotationsIncomplete, setAnnotationsIncomplete] = React.useState(false);
    const [preparation, setPreparation] = React.useState<ExternalSessionBrowsePreparation | null>(null);
    const [autoLinkPolicyScope, setAutoLinkPolicyScope] =
        React.useState<ExternalSessionBrowseAutoLinkPolicyScope | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [cancelled, setCancelled] = React.useState(false);
    const [loadedScopeKey, setLoadedScopeKey] = React.useState<string | null>(null);
    /**
     * Whether the rows on screen were published by the request that owns the current
     * scope, rather than retained from a superseded one while a new request
     * re-establishes authority.
     *
     * This is a statement about the listing's provenance, never about how much of the
     * candidate index is built: a still-building index publishes its digest-verified
     * prefix through this same request, so rows it has already served are
     * authoritative while `loading` stays true for every remaining progress
     * round-trip.
     */
    const [candidatesAuthoritative, setCandidatesAuthoritative] = React.useState(false);
    /**
     * Whether the rows on screen come from a candidate-index build that stopped
     * before it completed — a crawl that stopped advancing, or one that exhausted the
     * bounded request budget. The rows stay live and actionable, but the listing is a
     * prefix of the source rather than all of it, so the surface keeps saying so and
     * offers the retry that restarts the build instead of declaring the list finished.
     */
    const [preparationStopped, setPreparationStopped] = React.useState(false);

    const loadGenerationRef = React.useRef(0);
    const loadedScopeKeyRef = React.useRef<string | null>(null);
    const activePageRequestKeysRef = React.useRef(new Set<string>());
    const activeScopeAbortControllerRef = React.useRef<AbortController | null>(null);
    /**
     * The Account lifetime that owns the in-flight scope request, captured from the
     * canonical active-scope owner. Browse rows, annotations and continuations are
     * Account-scoped data: a listing started under Account A must never publish into
     * Account B after a switch. Paging requests join the scope request's fence rather
     * than capturing a second one.
     */
    const activeScopeAccountCurrentnessRef = React.useRef<Readonly<{
        isCurrent(): boolean;
    }> | null>(null);
    const activeScopeAccountRetirementRef = React.useRef<Readonly<{ dispose(): void }> | null>(null);
    const seenPageContinuationsRef = React.useRef<{
        scopeKey: string;
        continuations: Set<string>;
    }>({ scopeKey: currentScopeKey, continuations: new Set<string>() });

    const loadCandidates = React.useCallback(async (opts?: Readonly<{
        continuation?: CandidateContinuation;
        append?: boolean;
    }>) => {
        const append = opts?.append === true;
        const requestedContinuation = opts?.continuation ?? null;
        const requestedCursor = requestedContinuation?.cursor ?? null;
        const requestedSearchMode = requestedContinuation?.searchMode;
        const hasValidScope = Boolean(machineId && providerId && scopedSource);
        const preserveExistingCandidatesOnFailure = !append
            && loadedScopeKeyRef.current === currentScopeKey;

        if (!enabled) {
            if (!append) {
                loadGenerationRef.current += 1;
                activeScopeAbortControllerRef.current?.abort();
                activeScopeAbortControllerRef.current = null;
                activePageRequestKeysRef.current.clear();
                setCandidatesAuthoritative(false);
                setLoading(false);
                setLoadingMore(false);
                setSearchAugmenting(false);
                setPreparation(null);
                setPreparationStopped(false);
                setAutoLinkPolicyScope(null);
                setError(null);
                setCancelled(false);
            }
            return;
        }

        let abortController: AbortController;
        if (!append) {
            activeScopeAbortControllerRef.current?.abort();
            activeScopeAbortControllerRef.current = null;
            activePageRequestKeysRef.current.clear();
            loadGenerationRef.current += 1;
            // Rows already on screen belong to the superseded request until this one
            // publishes; a paging (`append`) request never revokes that authority.
            setCandidatesAuthoritative(false);
            if (!hasValidScope) {
                loadedScopeKeyRef.current = currentScopeKey;
                setLoadedScopeKey(currentScopeKey);
                seenPageContinuationsRef.current = {
                    scopeKey: currentScopeKey,
                    continuations: new Set<string>(),
                };
                setCandidates([]);
                setNextPage(null);
                setLoading(false);
                setLoadingMore(false);
                setSearchAugmenting(false);
                setSearchIncomplete(false);
                setAnnotationsIncomplete(false);
                setPreparation(null);
                setPreparationStopped(false);
                setAutoLinkPolicyScope(null);
                setError(null);
                setCancelled(false);
                return;
            }
            abortController = new AbortController();
            activeScopeAbortControllerRef.current = abortController;
            activeScopeAccountRetirementRef.current?.dispose();
            const accountCurrentness = captureActiveServerAccountScopeCurrentness();
            activeScopeAccountCurrentnessRef.current = accountCurrentness;
            activeScopeAccountRetirementRef.current = accountCurrentness.onRetire(() => {
                abortController.abort();
            });
            if (loadedScopeKeyRef.current !== currentScopeKey) {
                loadedScopeKeyRef.current = null;
                setLoadedScopeKey(null);
                setAutoLinkPolicyScope(null);
            }
            seenPageContinuationsRef.current = {
                scopeKey: currentScopeKey,
                continuations: new Set<string>(),
            };
        } else {
            if (!hasValidScope) return;
            abortController = activeScopeAbortControllerRef.current ?? new AbortController();
        }
        if (!machineId || !providerId || !scopedSource) return;
        const accountCurrentness = activeScopeAccountCurrentnessRef.current;
        const accountScopeIsCurrent = () => accountCurrentness?.isCurrent() !== false;
        const currentGeneration = loadGenerationRef.current;
        const pageRequestKey = JSON.stringify([
            currentGeneration,
            currentScopeKey,
            requestedContinuation ? readCandidateContinuationKey(requestedContinuation) : null,
        ]);
        if (activePageRequestKeysRef.current.has(pageRequestKey)) return;
        activePageRequestKeysRef.current.add(pageRequestKey);

        if (append) {
            setLoadingMore(true);
        } else {
            setLoading(true);
            setLoadingMore(false);
            setSearchAugmenting(false);
            setSearchIncomplete(false);
            setPreparation(null);
            setPreparationStopped(false);
            setError(null);
            setCancelled(false);
        }

        const shouldStartWithFastSearch = !append && !requestedContinuation && normalizedSearchTerm.length > 0;
        let requestObservedPreparation = false;
        const requestCandidates = async (
            searchMode?: CandidateSearchMode,
            cursor: string | null = requestedCursor,
        ) => {
            const request = {
                machineId,
                agentId: providerId,
                source: scopedSource,
                limit: CANDIDATES_PAGE_LIMIT,
                ...(normalizedSearchTerm ? { searchTerm: normalizedSearchTerm } : {}),
                ...(cursor ? { cursor } : {}),
                ...(searchMode ? { searchMode } : {}),
            };
            return machineExternalSessionsCandidatesList(request, {
                ...(serverId ? { serverId } : {}),
                signal: abortController.signal,
            });
        };
        const applyResult = (
            result: Awaited<ReturnType<typeof machineExternalSessionsCandidatesList>>,
            mode: CandidateApplyMode,
            searchMode?: CandidateSearchMode,
        ): boolean => {
            // Account lifetime is the outermost fence on this listing. A response that
            // resolves after a switch describes Account A's machines and sources; it can
            // publish neither rows, annotations, continuations nor an auto-link policy
            // scope into Account B.
            if (!accountScopeIsCurrent()) return false;
            if (!result.ok) {
                loadedScopeKeyRef.current = currentScopeKey;
                setLoadedScopeKey(currentScopeKey);
                if (mode === 'merge') {
                    return false;
                }
                setPreparation(null);
                if (!append) setAutoLinkPolicyScope(null);
                setError(resolveExternalSessionBrowseRpcErrorMessage(result.errorCode, 'list'));
                if (!append) {
                    if (!preserveExistingCandidatesOnFailure) {
                        setCandidates([]);
                        setAnnotationsIncomplete(false);
                    }
                    setNextPage(null);
                }
                return false;
            }

            const nextItems = result.candidates.map((candidate) => ({
                remoteSessionId: candidate.remoteSessionId,
                candidateKey: candidate.candidateKey,
                title: candidate.title,
                updatedAtMs: candidate.updatedAtMs,
                activity: candidate.activity,
                details: candidate.details,
                linkData: candidate.linkData,
                linkedSessionId: candidate.linkedSessionId,
                imported: candidate.imported,
                materializedThrough: candidate.materializedThrough,
            })) satisfies readonly ExternalSessionBrowseCandidate[];

            loadedScopeKeyRef.current = currentScopeKey;
            setLoadedScopeKey(currentScopeKey);
            /**
             * Published rows are what confer authority. A merge that carries none only
             * keeps whatever is already on screen — an index rebuilding from a drifted
             * source republishes exactly that — so it must not re-authorize rows this
             * request never served.
             */
            if (mode !== 'merge' || nextItems.length > 0) setCandidatesAuthoritative(true);
            setPreparation(null);
            if (mode !== 'append') {
                setAutoLinkPolicyScope(result.autoLinkPolicyScopeV1 ?? null);
            }
            setCandidates((current) => preserveExternalSessionBrowseCandidateIdentity(
                current,
                mode === 'replace'
                    ? mergeExternalSessionBrowseCandidates([], nextItems)
                    : mode === 'republish'
                        ? republishExternalSessionBrowseCandidates(current, nextItems)
                        : mergeExternalSessionBrowseCandidates(current, nextItems),
            ));
            setSearchIncomplete(result.searchIncomplete === true);
            setAnnotationsIncomplete((current) => mode === 'replace' || mode === 'republish'
                ? result.annotationsIncomplete === true
                : current || result.annotationsIncomplete === true);
            if (mode === 'merge') {
                if (result.nextCursor) {
                    const returnedContinuation = {
                        cursor: result.nextCursor,
                        ...(searchMode ? { searchMode } : {}),
                    };
                    const continuationKey = readCandidateContinuationKey(returnedContinuation);
                    const seenContinuations = seenPageContinuationsRef.current.continuations;
                    if (seenContinuations.has(continuationKey)) {
                        setNextPage(null);
                    } else {
                        seenContinuations.add(continuationKey);
                        setNextPage(returnedContinuation);
                    }
                } else if (!result.searchIncomplete) {
                    setNextPage(null);
                }
            } else {
                const returnedCursor = result.nextCursor ?? null;
                const continuationState = seenPageContinuationsRef.current;
                if (continuationState.scopeKey !== currentScopeKey) {
                    seenPageContinuationsRef.current = {
                        scopeKey: currentScopeKey,
                        continuations: new Set<string>(),
                    };
                }
                const returnedContinuation = returnedCursor
                    ? { cursor: returnedCursor, ...(searchMode ? { searchMode } : {}) }
                    : null;
                const continuationKey = returnedContinuation
                    ? readCandidateContinuationKey(returnedContinuation)
                    : null;
                const seenContinuations = seenPageContinuationsRef.current.continuations;
                if (continuationKey && seenContinuations.has(continuationKey)) {
                    setNextPage(null);
                } else {
                    if (continuationKey) seenContinuations.add(continuationKey);
                    setNextPage(returnedContinuation);
                }
            }
            setError(null);
            return true;
        };
        const requestCandidatePage = async (
            searchMode?: CandidateSearchMode,
            cursor: string | null = requestedCursor,
        ): Promise<Readonly<{
            result: Awaited<ReturnType<typeof machineExternalSessionsCandidatesList>>;
            prepared: boolean;
        }> | null> => {
            let prepared = false;
            let preparationRequestCount = 0;
            let lastPreparationScanned: number | null = null;
            let lastServedPreparationResult:
                Awaited<ReturnType<typeof machineExternalSessionsCandidatesList>> | null = null;
            while (preparationRequestCount < MAX_CANDIDATE_INDEX_PREPARATION_REQUESTS) {
                const result = await requestCandidates(searchMode, cursor);
                if (
                    abortController.signal.aborted
                    || loadGenerationRef.current !== currentGeneration
                    || !accountScopeIsCurrent()
                ) {
                    return null;
                }
                if (!result.ok || !result.preparation || append || cursor !== null) {
                    return { result, prepared };
                }
                preparationRequestCount += 1;
                const previousScanned = lastPreparationScanned;
                lastPreparationScanned = result.preparation.scanned;
                /**
                 * A preparing index only ever grows the digest-verified prefix it
                 * serves, so a response that serves nothing after one already served
                 * rows — or one whose scanned count went backwards — reports a source
                 * generation that restarted, not more progress on the generation those
                 * rows came from. They stay on screen so a rebuild never blanks the
                 * listing, but they describe a superseded generation: they lose their
                 * authority and stop counting as this crawl's served prefix, so no later
                 * stop can present them as the current generation's finished result.
                 */
                const generationRestarted = lastServedPreparationResult !== null
                    && (result.candidates.length === 0
                        || (previousScanned !== null && result.preparation.scanned < previousScanned));
                if (generationRestarted) {
                    lastServedPreparationResult = null;
                    setCandidatesAuthoritative(false);
                }
                if (result.candidates.length > 0) lastServedPreparationResult = result;
                /**
                 * A crawl that stopped advancing is only a failure while the index has
                 * nothing to show. With served rows in hand it is a stop-polling
                 * condition, so the listing keeps them — flagged as the incomplete
                 * prefix they are — instead of being destroyed. A restart is progress on
                 * a new generation, not a stall, so it keeps the crawl going.
                 */
                const crawlStalled = !generationRestarted
                    && previousScanned !== null
                    && result.preparation.scanned <= previousScanned;
                if (crawlStalled) {
                    if (!lastServedPreparationResult) {
                        throw new Error(t('externalSessions.browseFailedToLoad'));
                    }
                    setPreparationStopped(true);
                    return { result: lastServedPreparationResult, prepared };
                }

                prepared = true;
                requestObservedPreparation = true;
                /**
                 * A preparation response carries the digest-verified rows the index has
                 * already built, so it publishes through the same candidate path a
                 * completed page uses. An empty response merges instead of replacing so
                 * an in-progress rebuild never blanks rows already on screen.
                 */
                applyResult(result, result.candidates.length > 0 ? 'replace' : 'merge', searchMode);
                setPreparation(result.preparation);
                setLoading(true);
                setSearchAugmenting(false);
            }
            if (lastServedPreparationResult) {
                setPreparationStopped(true);
                return { result: lastServedPreparationResult, prepared };
            }
            throw new Error(t('externalSessions.browseFailedToLoad'));
        };

        try {
            const initialSearchMode = shouldStartWithFastSearch ? 'fast' : requestedSearchMode;
            const pageResult = await requestCandidatePage(initialSearchMode);
            if (!pageResult) return;
            const { result } = pageResult;

            const ok = applyResult(result, append ? 'append' : 'replace', initialSearchMode);
            if (!ok || !shouldStartWithFastSearch || !result.ok || !result.searchIncomplete) {
                return;
            }

            setLoading(false);
            setSearchAugmenting(true);
            try {
                requestObservedPreparation = false;
                let augmentedPageResult = await requestCandidatePage('full');
                if (!augmentedPageResult) return;
                const observedEmptySearchCursors = new Set<string>();
                let fullSearchPageRequests = 1;
                while (
                    augmentedPageResult.result.ok
                    && augmentedPageResult.result.searchIncomplete
                    && augmentedPageResult.result.candidates.length === 0
                    && augmentedPageResult.result.nextCursor
                    && fullSearchPageRequests < MAX_EMPTY_FULL_SEARCH_PAGE_REQUESTS
                ) {
                    const continuationCursor = augmentedPageResult.result.nextCursor;
                    if (observedEmptySearchCursors.has(continuationCursor)) {
                        throw new Error(t('externalSessions.browseFailedToLoad'));
                    }
                    observedEmptySearchCursors.add(continuationCursor);
                    const continuationPage = await requestCandidatePage('full', continuationCursor);
                    if (!continuationPage) return;
                    augmentedPageResult = continuationPage;
                    fullSearchPageRequests += 1;
                }
                const fullSearchIsComplete = augmentedPageResult.result.ok
                    && !augmentedPageResult.result.searchIncomplete
                    && !augmentedPageResult.result.preparation;
                applyResult(
                    augmentedPageResult.result,
                    augmentedPageResult.prepared
                        ? 'replace'
                        : fullSearchIsComplete
                            ? 'republish'
                            : 'merge',
                    'full',
                );
            } catch (augmentationError) {
                if (
                    abortController.signal.aborted
                    || loadGenerationRef.current !== currentGeneration
                    || !accountScopeIsCurrent()
                ) {
                    return;
                }
                if (requestObservedPreparation) {
                    setCandidatesAuthoritative(false);
                    setCandidates([]);
                    setAnnotationsIncomplete(false);
                    setNextPage(null);
                    setPreparation(null);
                    setError(resolveExternalSessionBrowseThrownErrorMessage(augmentationError, 'list'));
                }
                // Otherwise keep fast search results visible if slower augmentation fails.
            }
        } catch (loadError) {
            if (
                abortController.signal.aborted
                || loadGenerationRef.current !== currentGeneration
                || !accountScopeIsCurrent()
            ) {
                return;
            }
            loadedScopeKeyRef.current = currentScopeKey;
            setLoadedScopeKey(currentScopeKey);
            setPreparation(null);
            setError(resolveExternalSessionBrowseThrownErrorMessage(loadError, 'list'));
            if (!append) {
                if (!preserveExistingCandidatesOnFailure) {
                    setCandidates([]);
                    setAnnotationsIncomplete(false);
                }
                setNextPage(null);
            }
        } finally {
            activePageRequestKeysRef.current.delete(pageRequestKey);
            if (!abortController.signal.aborted && loadGenerationRef.current === currentGeneration) {
                if (append) {
                    setLoadingMore(false);
                } else {
                    setLoading(false);
                    setSearchAugmenting(false);
                }
            }
        }
    }, [currentScopeKey, enabled, machineId, normalizedSearchTerm, providerId, scopedSource, serverId]);

    React.useEffect(() => {
        void loadCandidates();
    }, [loadCandidates]);

    React.useEffect(() => () => {
        loadGenerationRef.current += 1;
        activeScopeAbortControllerRef.current?.abort();
        activePageRequestKeysRef.current.clear();
    }, []);

    const loadMore = React.useCallback(async () => {
        if (!nextPage || loadingMore) return;
        await loadCandidates({ continuation: nextPage, append: true });
    }, [loadCandidates, loadingMore, nextPage]);
    const cancelPreparation = React.useCallback(() => {
        loadGenerationRef.current += 1;
        activeScopeAbortControllerRef.current?.abort();
        activeScopeAbortControllerRef.current = null;
        activePageRequestKeysRef.current.clear();
        loadedScopeKeyRef.current = currentScopeKey;
        setLoadedScopeKey(currentScopeKey);
        setCandidatesAuthoritative(false);
        setCandidates([]);
        setNextPage(null);
        setLoading(false);
        setLoadingMore(false);
        setSearchAugmenting(false);
        setSearchIncomplete(false);
        setAnnotationsIncomplete(false);
        setPreparation(null);
        setPreparationStopped(false);
        setAutoLinkPolicyScope(null);
        setError(t('externalSessions.browseIndexingCancelled'));
        setCancelled(true);
    }, [currentScopeKey]);
    const reload = React.useCallback(async () => {
        await loadCandidates();
    }, [loadCandidates]);

    const scopeMatches = loadedScopeKey === currentScopeKey;
    const paginationRequestKey = scopeMatches && nextPage !== null
        ? `${currentScopeKey}\u0000${readCandidateContinuationKey(nextPage)}`
        : null;

    return {
        candidates: scopeMatches ? candidates : [],
        candidatesAuthoritative: scopeMatches && candidatesAuthoritative,
        nextCursor: scopeMatches ? nextPage?.cursor ?? null : null,
        paginationRequestKey,
        loading: loading || (enabled && !scopeMatches),
        loadingMore,
        searchAugmenting: scopeMatches ? searchAugmenting : false,
        searchIncomplete: scopeMatches ? searchIncomplete : false,
        annotationsIncomplete: scopeMatches ? annotationsIncomplete : false,
        preparation: scopeMatches ? preparation : null,
        preparationStopped: scopeMatches ? preparationStopped : false,
        autoLinkPolicyScope: scopeMatches ? autoLinkPolicyScope : null,
        error: scopeMatches ? error : null,
        cancelled: scopeMatches ? cancelled : false,
        loadMore,
        cancelPreparation,
        reload,
    } as const;
}
