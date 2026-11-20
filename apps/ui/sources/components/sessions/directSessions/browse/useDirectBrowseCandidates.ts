import * as React from 'react';
import type { DirectSessionActivityV1, DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';

import { machineDirectSessionsCandidatesList } from '@/sync/ops/machineDirectSessions';
import { t } from '@/text';

export type DirectBrowseCandidate = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    createdAtMs?: number;
    activity?: DirectSessionActivityV1;
    details?: Record<string, unknown>;
}>;

const CANDIDATES_PAGE_LIMIT = 50;

type CandidateApplyMode = 'replace' | 'append' | 'merge';

function hasCandidateTitle(candidate: DirectBrowseCandidate): boolean {
    return typeof candidate.title === 'string' && candidate.title.trim().length > 0;
}

function mergeCandidateDetails(
    current: DirectBrowseCandidate['details'],
    next: DirectBrowseCandidate['details'],
): DirectBrowseCandidate['details'] {
    if (!current) return next;
    if (!next) return current;
    return { ...current, ...next };
}

function mergeDirectBrowseCandidate(current: DirectBrowseCandidate, next: DirectBrowseCandidate): DirectBrowseCandidate {
    return {
        remoteSessionId: current.remoteSessionId,
        title: hasCandidateTitle(next) ? next.title : current.title,
        updatedAtMs: Math.max(current.updatedAtMs, next.updatedAtMs),
        activity: next.activity ?? current.activity,
        details: mergeCandidateDetails(current.details, next.details),
    };
}

function compareDirectBrowseCandidates(a: DirectBrowseCandidate, b: DirectBrowseCandidate): number {
    return b.updatedAtMs - a.updatedAtMs || a.remoteSessionId.localeCompare(b.remoteSessionId);
}

function mergeDirectBrowseCandidates(
    current: readonly DirectBrowseCandidate[],
    next: readonly DirectBrowseCandidate[],
): readonly DirectBrowseCandidate[] {
    const merged = new Map<string, DirectBrowseCandidate>();
    for (const candidate of current) {
        merged.set(candidate.remoteSessionId, candidate);
    }
    for (const candidate of next) {
        const existing = merged.get(candidate.remoteSessionId);
        merged.set(candidate.remoteSessionId, existing ? mergeDirectBrowseCandidate(existing, candidate) : candidate);
    }
    return Array.from(merged.values()).sort(compareDirectBrowseCandidates);
}

export function useDirectBrowseCandidates(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    providerId: DirectSessionsProviderId | null;
    source: DirectSessionsSource | null;
    searchTerm?: string;
}>) {
    const { machineId, providerId, searchTerm, source, serverId } = params;

    const [candidates, setCandidates] = React.useState<readonly DirectBrowseCandidate[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [searchAugmenting, setSearchAugmenting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [canDeleteCandidates, setCanDeleteCandidates] = React.useState(false);

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

        const normalizedSearchTerm = typeof searchTerm === 'string' ? searchTerm.trim() : '';
        const shouldStartWithFastSearch = !append && !opts?.cursor && normalizedSearchTerm.length > 0;
        const requestCandidates = async (searchMode?: 'fast' | 'full') => {
            const request = {
                machineId,
                providerId,
                source,
                limit: CANDIDATES_PAGE_LIMIT,
                ...(opts?.cursor ? { cursor: opts.cursor } : {}),
                ...(normalizedSearchTerm.length > 0 ? { searchTerm: normalizedSearchTerm } : {}),
                ...(searchMode ? { searchMode } : {}),
            };
            return serverId
                ? machineDirectSessionsCandidatesList(request, { serverId })
                : machineDirectSessionsCandidatesList(request);
        };
        const applyResult = (result: Awaited<ReturnType<typeof machineDirectSessionsCandidatesList>>, mode: CandidateApplyMode): boolean => {
            if (!result.ok) {
                if (mode === 'merge') {
                    return false;
                }
                setError(result.error);
                if (!append) {
                    setCandidates([]);
                    setNextCursor(null);
                    setCanDeleteCandidates(false);
                }
                return false;
            }

            const nextItems = result.candidates.map((candidate) => ({
                remoteSessionId: candidate.remoteSessionId,
                title: candidate.title,
                updatedAtMs: candidate.updatedAtMs,
                createdAtMs: candidate.createdAtMs,
                activity: candidate.activity,
                details: candidate.details,
            })) satisfies readonly DirectBrowseCandidate[];

            setCandidates((current) => {
                if (mode === 'append') return [...current, ...nextItems];
                if (mode === 'merge') return mergeDirectBrowseCandidates(current, nextItems);
                return nextItems;
            });
            if (mode === 'merge') {
                setNextCursor((current) => result.nextCursor ?? (result.searchIncomplete ? current : null));
            } else {
                setNextCursor(result.nextCursor ?? null);
            }
            setCanDeleteCandidates(result.capabilities?.deleteCandidate === true);
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
                // Keep the fast search results visible when slower augmentation fails.
            }
        } catch (loadError) {
            if (loadGenerationRef.current !== currentGeneration) {
                return;
            }
            const message = loadError instanceof Error ? loadError.message : t('directSessions.browseFailedToLoad');
            setError(message);
            if (!append) {
                setCandidates([]);
                setNextCursor(null);
                setCanDeleteCandidates(false);
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
    }, [machineId, providerId, searchTerm, serverId, source]);

    React.useEffect(() => {
        void loadCandidates();
    }, [loadCandidates]);

    const loadMore = React.useCallback(async () => {
        if (!nextCursor || loadingMore) return;
        await loadCandidates({ cursor: nextCursor, append: true });
    }, [loadCandidates, loadingMore, nextCursor]);

    const removeCandidate = React.useCallback((remoteSessionId: string) => {
        setCandidates((current) => current.filter((candidate) => candidate.remoteSessionId !== remoteSessionId));
    }, []);

    return {
        candidates,
        nextCursor,
        loading,
        loadingMore,
        searchAugmenting,
        error,
        canDeleteCandidates,
        loadMore,
        removeCandidate,
    } as const;
}
