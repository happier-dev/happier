import * as React from 'react';
import type { ExternalSessionActivityV1, ExternalSessionsProviderId, ExternalSessionsSource } from '@happier-dev/protocol';

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

export function useExternalSessionBrowseCandidates(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    providerId: ExternalSessionsProviderId | null;
    source: ExternalSessionsSource | null;
}>) {
    const { machineId, providerId, source, serverId } = params;
    const currentScopeKey = React.useMemo(() => JSON.stringify({
        machineId,
        serverId: serverId ?? null,
        providerId,
        source,
    }), [machineId, providerId, serverId, source]);

    const [candidates, setCandidates] = React.useState<readonly ExternalSessionBrowseCandidate[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
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
            setError(null);
        }

        try {
            const request = {
                machineId,
                providerId,
                source,
                limit: CANDIDATES_PAGE_LIMIT,
                ...(opts?.cursor ? { cursor: opts.cursor } : {}),
            };
            const result = serverId
                ? await machineExternalSessionsCandidatesList(request, { serverId })
                : await machineExternalSessionsCandidatesList(request);

            if (loadGenerationRef.current !== currentGeneration) {
                return;
            }

            if (!result.ok) {
                setError(result.error);
                if (!append) {
                    setCandidates([]);
                    setNextCursor(null);
                }
                return;
            }

            const nextItems = result.candidates.map((candidate) => ({
                remoteSessionId: candidate.remoteSessionId,
                title: candidate.title,
                updatedAtMs: candidate.updatedAtMs,
                activity: candidate.activity,
                details: candidate.details,
            })) satisfies readonly ExternalSessionBrowseCandidate[];

            setLoadedScopeKey(currentScopeKey);
            setCandidates((current) => append ? [...current, ...nextItems] : nextItems);
            setNextCursor(result.nextCursor ?? null);
            setError(null);
        } catch (loadError) {
            if (loadGenerationRef.current !== currentGeneration) {
                return;
            }
            const message = loadError instanceof Error ? loadError.message : t('externalSessions.browseFailedToLoad');
            setLoadedScopeKey(currentScopeKey);
            setError(message);
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
                }
            }
        }
    }, [currentScopeKey, machineId, providerId, serverId, source]);

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
        error: scopeMatches ? error : null,
        loadMore,
    } as const;
}
