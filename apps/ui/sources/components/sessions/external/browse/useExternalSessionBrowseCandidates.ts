import * as React from 'react';
import type {
    ExternalSessionActivityV1,
    ExternalSessionsAgentId,
    ExternalSessionsCandidatesListResponse,
    ExternalSessionsSource,
    PluginAgentExternalSessionLinkData,
} from '@happier-dev/protocol';

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

const CANDIDATES_PAGE_LIMIT = 50;
const MAX_CANDIDATE_INDEX_PREPARATION_REQUESTS = 250;
const MAX_EMPTY_FULL_SEARCH_PAGE_REQUESTS = 20;

type CandidateApplyMode = 'replace' | 'append' | 'merge';

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

export function useExternalSessionBrowseCandidates(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    providerId: ExternalSessionsAgentId | null;
    source: ExternalSessionsSource | null;
    searchTerm?: string;
}>) {
    const { machineId, providerId, searchTerm, source, serverId } = params;
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
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [searchAugmenting, setSearchAugmenting] = React.useState(false);
    const [searchIncomplete, setSearchIncomplete] = React.useState(false);
    const [preparation, setPreparation] = React.useState<ExternalSessionBrowsePreparation | null>(null);
    const [autoLinkPolicyScope, setAutoLinkPolicyScope] =
        React.useState<ExternalSessionBrowseAutoLinkPolicyScope | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [loadedScopeKey, setLoadedScopeKey] = React.useState<string | null>(null);

    const loadGenerationRef = React.useRef(0);
    const loadedScopeKeyRef = React.useRef<string | null>(null);
    const activePageRequestKeysRef = React.useRef(new Set<string>());
    const activeScopeAbortControllerRef = React.useRef<AbortController | null>(null);
    const seenPageCursorsRef = React.useRef<{
        scopeKey: string;
        cursors: Set<string>;
    }>({ scopeKey: currentScopeKey, cursors: new Set<string>() });

    const loadCandidates = React.useCallback(async (opts?: Readonly<{ cursor?: string | null; append?: boolean }>) => {
        if (!machineId || !providerId || !scopedSource) return;

        const append = opts?.append === true;
        const requestedCursor = opts?.cursor ?? null;

        let abortController: AbortController;
        if (!append) {
            activeScopeAbortControllerRef.current?.abort();
            abortController = new AbortController();
            activeScopeAbortControllerRef.current = abortController;
            loadGenerationRef.current += 1;
            if (loadedScopeKeyRef.current !== currentScopeKey) {
                loadedScopeKeyRef.current = null;
                setLoadedScopeKey(null);
                setAutoLinkPolicyScope(null);
            }
            seenPageCursorsRef.current = {
                scopeKey: currentScopeKey,
                cursors: new Set<string>(),
            };
        } else {
            abortController = activeScopeAbortControllerRef.current ?? new AbortController();
        }
        const currentGeneration = loadGenerationRef.current;
        const pageRequestKey = `${currentGeneration}\u0000${currentScopeKey}\u0000${requestedCursor ?? '<root>'}`;
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
            setError(null);
        }

        const shouldStartWithFastSearch = !append && !opts?.cursor && normalizedSearchTerm.length > 0;
        let requestObservedPreparation = false;
        const requestCandidates = async (
            searchMode?: 'fast' | 'full',
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
        const applyResult = (result: Awaited<ReturnType<typeof machineExternalSessionsCandidatesList>>, mode: CandidateApplyMode): boolean => {
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
                    setCandidates([]);
                    setNextCursor(null);
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
            setPreparation(null);
            if (mode !== 'append') {
                setAutoLinkPolicyScope(result.autoLinkPolicyScopeV1 ?? null);
            }
            setCandidates((current) => {
                if (mode === 'append') return mergeExternalSessionBrowseCandidates(current, nextItems);
                if (mode === 'merge') return mergeExternalSessionBrowseCandidates(current, nextItems);
                return mergeExternalSessionBrowseCandidates([], nextItems);
            });
            setSearchIncomplete(result.searchIncomplete === true);
            if (mode === 'merge') {
                setNextCursor((current) => result.nextCursor ?? (result.searchIncomplete ? current : null));
            } else {
                const returnedCursor = result.nextCursor ?? null;
                const cursorState = seenPageCursorsRef.current;
                if (cursorState.scopeKey !== currentScopeKey) {
                    seenPageCursorsRef.current = {
                        scopeKey: currentScopeKey,
                        cursors: new Set<string>(),
                    };
                }
                const seenCursors = seenPageCursorsRef.current.cursors;
                if (returnedCursor && seenCursors.has(returnedCursor)) {
                    setNextCursor(null);
                } else {
                    if (returnedCursor) seenCursors.add(returnedCursor);
                    setNextCursor(returnedCursor);
                }
            }
            setError(null);
            return true;
        };
        const requestCandidatePage = async (
            searchMode?: 'fast' | 'full',
            cursor: string | null = requestedCursor,
        ): Promise<Readonly<{
            result: Awaited<ReturnType<typeof machineExternalSessionsCandidatesList>>;
            prepared: boolean;
        }> | null> => {
            let prepared = false;
            let preparationRequestCount = 0;
            let lastPreparationScanned: number | null = null;
            while (preparationRequestCount < MAX_CANDIDATE_INDEX_PREPARATION_REQUESTS) {
                const result = await requestCandidates(searchMode, cursor);
                if (abortController.signal.aborted || loadGenerationRef.current !== currentGeneration) {
                    return null;
                }
                if (!result.ok || !result.preparation || append || cursor !== null) {
                    return { result, prepared };
                }
                preparationRequestCount += 1;
                if (
                    lastPreparationScanned !== null
                    && result.preparation.scanned <= lastPreparationScanned
                ) {
                    throw new Error(t('externalSessions.browseFailedToLoad'));
                }
                lastPreparationScanned = result.preparation.scanned;

                prepared = true;
                requestObservedPreparation = true;
                loadedScopeKeyRef.current = currentScopeKey;
                setLoadedScopeKey(currentScopeKey);
                setCandidates([]);
                setNextCursor(null);
                setAutoLinkPolicyScope(null);
                setError(null);
                setPreparation(result.preparation);
                setLoading(true);
                setSearchAugmenting(false);
            }
            throw new Error(t('externalSessions.browseFailedToLoad'));
        };

        try {
            const pageResult = await requestCandidatePage(shouldStartWithFastSearch ? 'fast' : undefined);
            if (!pageResult) return;
            const { result } = pageResult;

            const ok = applyResult(result, append ? 'append' : 'replace');
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
                applyResult(
                    augmentedPageResult.result,
                    augmentedPageResult.prepared ? 'replace' : 'merge',
                );
            } catch (augmentationError) {
                if (abortController.signal.aborted || loadGenerationRef.current !== currentGeneration) {
                    return;
                }
                if (requestObservedPreparation) {
                    setCandidates([]);
                    setNextCursor(null);
                    setPreparation(null);
                    setError(resolveExternalSessionBrowseThrownErrorMessage(augmentationError, 'list'));
                }
                // Otherwise keep fast search results visible if slower augmentation fails.
            }
        } catch (loadError) {
            if (abortController.signal.aborted || loadGenerationRef.current !== currentGeneration) {
                return;
            }
            loadedScopeKeyRef.current = currentScopeKey;
            setLoadedScopeKey(currentScopeKey);
            setPreparation(null);
            setError(resolveExternalSessionBrowseThrownErrorMessage(loadError, 'list'));
            if (!append) {
                setCandidates([]);
                setNextCursor(null);
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
    }, [currentScopeKey, machineId, normalizedSearchTerm, providerId, scopedSource, serverId]);

    React.useEffect(() => {
        void loadCandidates();
    }, [loadCandidates]);

    React.useEffect(() => () => {
        loadGenerationRef.current += 1;
        activeScopeAbortControllerRef.current?.abort();
        activePageRequestKeysRef.current.clear();
    }, []);

    const loadMore = React.useCallback(async () => {
        if (!nextCursor || loadingMore) return;
        await loadCandidates({ cursor: nextCursor, append: true });
    }, [loadCandidates, loadingMore, nextCursor]);
    const cancelPreparation = React.useCallback(() => {
        loadGenerationRef.current += 1;
        activeScopeAbortControllerRef.current?.abort();
        activeScopeAbortControllerRef.current = null;
        activePageRequestKeysRef.current.clear();
        loadedScopeKeyRef.current = currentScopeKey;
        setLoadedScopeKey(currentScopeKey);
        setCandidates([]);
        setNextCursor(null);
        setLoading(false);
        setLoadingMore(false);
        setSearchAugmenting(false);
        setSearchIncomplete(false);
        setPreparation(null);
        setAutoLinkPolicyScope(null);
        setError(t('externalSessions.browseIndexingCancelled'));
    }, [currentScopeKey]);
    const reload = React.useCallback(async () => {
        await loadCandidates();
    }, [loadCandidates]);

    const scopeMatches = loadedScopeKey === currentScopeKey;

    return {
        candidates: scopeMatches ? candidates : [],
        nextCursor: scopeMatches ? nextCursor : null,
        loading,
        loadingMore,
        searchAugmenting: scopeMatches ? searchAugmenting : false,
        searchIncomplete: scopeMatches ? searchIncomplete : false,
        preparation: scopeMatches ? preparation : null,
        autoLinkPolicyScope: scopeMatches ? autoLinkPolicyScope : null,
        error: scopeMatches ? error : null,
        loadMore,
        cancelPreparation,
        reload,
    } as const;
}
