import * as React from 'react';
import type { DirectSessionActivityV1, DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';

import { machineDirectSessionsCandidatesList } from '@/sync/ops/machineDirectSessions';
import { t } from '@/text';

export type DirectBrowseCandidate = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    activity?: DirectSessionActivityV1;
    details?: Record<string, unknown>;
}>;

const CANDIDATES_PAGE_LIMIT = 50;

export function useDirectBrowseCandidates(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    providerId: DirectSessionsProviderId | null;
    source: DirectSessionsSource | null;
}>) {
    const { machineId, providerId, source, serverId } = params;

    const [candidates, setCandidates] = React.useState<readonly DirectBrowseCandidate[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

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
                ? await machineDirectSessionsCandidatesList(request, { serverId })
                : await machineDirectSessionsCandidatesList(request);

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
            })) satisfies readonly DirectBrowseCandidate[];

            setCandidates((current) => append ? [...current, ...nextItems] : nextItems);
            setNextCursor(result.nextCursor ?? null);
            setError(null);
        } catch (loadError) {
            if (loadGenerationRef.current !== currentGeneration) {
                return;
            }
            const message = loadError instanceof Error ? loadError.message : t('directSessions.browseFailedToLoad');
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
    }, [machineId, providerId, serverId, source]);

    React.useEffect(() => {
        void loadCandidates();
    }, [loadCandidates]);

    const loadMore = React.useCallback(async () => {
        if (!nextCursor || loadingMore) return;
        await loadCandidates({ cursor: nextCursor, append: true });
    }, [loadCandidates, loadingMore, nextCursor]);

    return {
        candidates,
        nextCursor,
        loading,
        loadingMore,
        error,
        loadMore,
    } as const;
}

