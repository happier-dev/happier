import * as React from 'react';

import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { sessionScmDiffFile } from '@/sync/ops';

type DiffState = {
    status: 'idle' | 'loading' | 'loaded' | 'error';
    diff: string;
    error: string | null;
};

function initialDiffState(): DiffState {
    return { status: 'idle', diff: '', error: null };
}

export function useChangedFilesReviewDiffLoading(input: {
    sessionId: string;
    isRepo: boolean;
    reviewFiles: readonly ScmFileStatus[];
    diffArea: ScmDiffArea;
    tooLarge: boolean;
    selectedPath: string;
    minRefetchMs?: number;
    refreshToken?: number;
    normalizeError: (input: unknown) => string;
    fallbackError: string;
}) {
    const {
        sessionId,
        isRepo,
        reviewFiles,
        diffArea,
        tooLarge,
        selectedPath,
        normalizeError,
        fallbackError,
        minRefetchMs,
        refreshToken,
    } = input;

    const [diffStateByPath, setDiffStateByPath] = React.useState<Record<string, DiffState>>({});
    const diffStateByPathRef = React.useRef(diffStateByPath);
    React.useEffect(() => {
        diffStateByPathRef.current = diffStateByPath;
    }, [diffStateByPath]);

    const lastFetchAtMsByPathRef = React.useRef<Record<string, number>>({});
    const inFlightPathsRef = React.useRef<Set<string>>(new Set());

    const minRefetchMsResolved = React.useMemo(() => {
        const raw = typeof minRefetchMs === 'number' && Number.isFinite(minRefetchMs) ? minRefetchMs : 0;
        return Math.max(0, raw);
    }, [minRefetchMs]);

    React.useEffect(() => {
        setDiffStateByPath({});
        lastFetchAtMsByPathRef.current = {};
        inFlightPathsRef.current = new Set();
    }, [diffArea, sessionId]);

    React.useEffect(() => {
        // Force a revalidate on the next effect run without clearing already-loaded diffs.
        lastFetchAtMsByPathRef.current = {};
    }, [diffArea, refreshToken, sessionId]);

    React.useEffect(() => {
        if (!sessionId) return;
        if (!isRepo) return;
        if (reviewFiles.length === 0) return;

        let cancelled = false;

        const loadDiff = async (path: string) => {
            const existing = diffStateByPathRef.current[path];
            const nowMs = Date.now();
            if (existing?.status === 'loaded' || existing?.status === 'error') {
                const lastFetchAtMs = lastFetchAtMsByPathRef.current[path] ?? 0;
                if (minRefetchMsResolved > 0 && (nowMs - lastFetchAtMs) < minRefetchMsResolved) {
                    return;
                }
            }
            if (inFlightPathsRef.current.has(path)) {
                return;
            }
            inFlightPathsRef.current.add(path);

            setDiffStateByPath((prev) => {
                const existing = prev[path];
                // Stale-while-revalidate: keep already-loaded diffs visible while we refresh in the background.
                if (existing?.status === 'loaded' && existing.diff) {
                    return prev;
                }
                return { ...prev, [path]: { status: 'loading', diff: '', error: null } };
            });
            try {
                const response = await sessionScmDiffFile(sessionId, { path, area: diffArea });
                if (cancelled) return;
                if (!response.success) {
                    const rawError = typeof response.error === 'string' ? response.error : '';
                    const normalized = rawError.trim() ? normalizeError(rawError) : '';
                    setDiffStateByPath((prev) => {
                        const existing = prev[path];
                        if (existing?.status === 'loaded' && existing.diff) {
                            return prev;
                        }
                        return {
                            ...prev,
                            [path]: {
                                status: 'error',
                                diff: '',
                                error: (typeof normalized === 'string' && normalized.trim()) ? normalized : fallbackError,
                            },
                        };
                    });
                    lastFetchAtMsByPathRef.current[path] = Date.now();
                    return;
                }
                lastFetchAtMsByPathRef.current[path] = Date.now();
                setDiffStateByPath((prev) => ({
                    ...prev,
                    [path]: { status: 'loaded', diff: response.diff ?? '', error: null },
                }));
            } catch (err) {
                if (cancelled) return;
                const normalized = normalizeError(err);
                setDiffStateByPath((prev) => {
                    const existing = prev[path];
                    if (existing?.status === 'loaded' && existing.diff) {
                        return prev;
                    }
                    return {
                        ...prev,
                        [path]: {
                            status: 'error',
                            diff: '',
                            error: (typeof normalized === 'string' && normalized.trim()) ? normalized : fallbackError,
                        },
                    };
                });
                lastFetchAtMsByPathRef.current[path] = Date.now();
            } finally {
                inFlightPathsRef.current.delete(path);
            }
        };

        const run = async () => {
            if (tooLarge) {
                const path = selectedPath || reviewFiles[0]!.fullPath;
                if (!path) return;
                await loadDiff(path);
                return;
            }

            for (const file of reviewFiles) {
                if (cancelled) return;
                await loadDiff(file.fullPath);
            }
        };

        run();
        return () => {
            cancelled = true;
        };
    }, [diffArea, fallbackError, isRepo, minRefetchMsResolved, normalizeError, refreshToken, reviewFiles, selectedPath, sessionId, tooLarge]);

    const getDiffState = React.useCallback((path: string) => diffStateByPath[path] ?? initialDiffState(), [diffStateByPath]);

    return {
        diffStateByPath,
        getDiffState,
    };
}
