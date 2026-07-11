import * as React from 'react';
import type { ExternalSessionActivityV1, ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';

import { machineExternalSessionsCandidatesList } from '@/sync/ops/machineExternalSessions';
import { t } from '@/text';

export type ExternalSessionBrowseCandidate = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    activity?: ExternalSessionActivityV1;
    details?: Record<string, unknown>;
}>;

const CANDIDATES_PAGE_LIMIT = 50;

type CandidateApplyMode = 'replace' | 'append' | 'merge';

function isMethodUnavailableMessage(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return normalized === 'rpc method not available' || normalized === 'method not found';
}

function isMachineRpcTimeoutError(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && (error as { code?: unknown }).code === 'MACHINE_RPC_TIMEOUT',
    );
}

function resolveExternalSessionBrowseErrorMessage(error: unknown): string {
    if (isRpcMethodNotAvailableError(error)) {
        return t('newSession.daemonRpcUnavailableBody');
    }
    if (isMachineRpcTimeoutError(error)) {
        return t('newSession.daemonRpcUnavailableBody');
    }
    if (typeof error === 'string' && isMethodUnavailableMessage(error)) {
        return t('newSession.daemonRpcUnavailableBody');
    }
    if (error instanceof Error && isMethodUnavailableMessage(error.message)) {
        return t('newSession.daemonRpcUnavailableBody');
    }
    return error instanceof Error ? error.message : t('externalSessions.browseFailedToLoad');
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
        title: hasCandidateTitle(next) ? next.title : current.title,
        updatedAtMs: Math.max(current.updatedAtMs, next.updatedAtMs),
        activity: next.activity ?? current.activity,
        details: mergeCandidateDetails(current.details, next.details),
    };
}

function compareExternalSessionBrowseCandidates(
    a: ExternalSessionBrowseCandidate,
    b: ExternalSessionBrowseCandidate,
): number {
    return b.updatedAtMs - a.updatedAtMs || a.remoteSessionId.localeCompare(b.remoteSessionId);
}

function mergeExternalSessionBrowseCandidates(
    current: readonly ExternalSessionBrowseCandidate[],
    next: readonly ExternalSessionBrowseCandidate[],
): readonly ExternalSessionBrowseCandidate[] {
    const merged = new Map<string, ExternalSessionBrowseCandidate>();
    for (const candidate of current) {
        merged.set(candidate.remoteSessionId, candidate);
    }
    for (const candidate of next) {
        const existing = merged.get(candidate.remoteSessionId);
        merged.set(candidate.remoteSessionId, existing ? mergeExternalSessionBrowseCandidate(existing, candidate) : candidate);
    }
    return Array.from(merged.values()).sort(compareExternalSessionBrowseCandidates);
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

    const [candidates, setCandidates] = React.useState<readonly ExternalSessionBrowseCandidate[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [searchAugmenting, setSearchAugmenting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [loadedScopeKey, setLoadedScopeKey] = React.useState<string | null>(null);

    const loadGenerationRef = React.useRef(0);

    const loadCandidates = React.useCallback(async (opts?: Readonly<{ cursor?: string | null; append?: boolean }>) => {
        if (!machineId || !providerId || !source) return;

        const append = opts?.append === true;
        if (!append) {
            loadGenerationRef.current += 1;
        }
        const currentGeneration = loadGenerationRef.current;

        if (append) {
            setLoadingMore(true);
        } else {
            setLoading(true);
            setSearchAugmenting(false);
            setError(null);
        }

        const shouldStartWithFastSearch = !append && !opts?.cursor && normalizedSearchTerm.length > 0;
        const requestCandidates = async (searchMode?: 'fast' | 'full') => {
            const request = {
                machineId,
                agentId: providerId,
                source,
                limit: CANDIDATES_PAGE_LIMIT,
                ...(normalizedSearchTerm ? { searchTerm: normalizedSearchTerm } : {}),
                ...(opts?.cursor ? { cursor: opts.cursor } : {}),
                ...(searchMode ? { searchMode } : {}),
            };
            return serverId
                ? machineExternalSessionsCandidatesList(request, { serverId })
                : machineExternalSessionsCandidatesList(request);
        };
        const applyResult = (result: Awaited<ReturnType<typeof machineExternalSessionsCandidatesList>>, mode: CandidateApplyMode): boolean => {
            if (!result.ok) {
                if (mode === 'merge') {
                    return false;
                }
                setError(resolveExternalSessionBrowseErrorMessage(result.error));
                if (!append) {
                    setCandidates([]);
                    setNextCursor(null);
                }
                return false;
            }

            const nextItems = result.candidates.map((candidate) => ({
                remoteSessionId: candidate.remoteSessionId,
                title: candidate.title,
                updatedAtMs: candidate.updatedAtMs,
                activity: candidate.activity,
                details: candidate.details,
            })) satisfies readonly ExternalSessionBrowseCandidate[];

            setLoadedScopeKey(currentScopeKey);
            setCandidates((current) => {
                if (mode === 'append') return [...current, ...nextItems];
                if (mode === 'merge') return mergeExternalSessionBrowseCandidates(current, nextItems);
                return nextItems;
            });
            if (mode === 'merge') {
                setNextCursor((current) => result.nextCursor ?? (result.searchIncomplete ? current : null));
            } else {
                setNextCursor(result.nextCursor ?? null);
            }
            setError(null);
            return true;
        };

        try {
            const result = await requestCandidates(shouldStartWithFastSearch ? 'fast' : undefined);

            if (loadGenerationRef.current !== currentGeneration) {
                return;
            }

            const ok = applyResult(result, append ? 'append' : 'replace');
            if (!ok || !shouldStartWithFastSearch || !result.ok || !result.searchIncomplete) {
                return;
            }

            setLoading(false);
            setSearchAugmenting(true);
            try {
                const augmentedResult = await requestCandidates('full');
                if (loadGenerationRef.current !== currentGeneration) {
                    return;
                }
                applyResult(augmentedResult, 'merge');
            } catch {
                // Keep fast search results visible if slower augmentation fails.
            }
        } catch (loadError) {
            if (loadGenerationRef.current !== currentGeneration) {
                return;
            }
            setLoadedScopeKey(currentScopeKey);
            setError(resolveExternalSessionBrowseErrorMessage(loadError));
            if (!append) {
                setCandidates([]);
                setNextCursor(null);
            }
        } finally {
            if (loadGenerationRef.current === currentGeneration) {
                if (append) {
                    setLoadingMore(false);
                } else {
                    setLoading(false);
                    setSearchAugmenting(false);
                }
            }
        }
    }, [currentScopeKey, machineId, normalizedSearchTerm, providerId, serverId, source]);

    React.useEffect(() => {
        void loadCandidates();
    }, [loadCandidates]);

    const loadMore = React.useCallback(async () => {
        if (!nextCursor || loadingMore) return;
        await loadCandidates({ cursor: nextCursor, append: true });
    }, [loadCandidates, loadingMore, nextCursor]);

    const scopeMatches = loadedScopeKey === currentScopeKey;

    return {
        candidates: scopeMatches ? candidates : [],
        nextCursor: scopeMatches ? nextCursor : null,
        loading,
        loadingMore,
        searchAugmenting: scopeMatches ? searchAugmenting : false,
        error: scopeMatches ? error : null,
        loadMore,
    } as const;
}
