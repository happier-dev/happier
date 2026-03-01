import * as React from 'react';

import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmDiffCache } from '@/scm/diffCache/scmDiffCache';
import { fetchSessionUnifiedDiffForPath } from '@/scm/diff/fetchSessionUnifiedDiffForPath';

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
    requestedPaths?: readonly string[];
    snapshotSignature?: string | null;
    diffCache?: ScmDiffCache | null;
    tooLarge: boolean;
    selectedPath: string;
    maxConcurrency?: number;
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
        requestedPaths,
        snapshotSignature,
        diffCache,
        tooLarge,
        selectedPath,
        maxConcurrency,
        normalizeError,
        fallbackError,
        minRefetchMs,
        refreshToken,
    } = input;

    const requestedPathsNormalized = React.useMemo<readonly string[] | null>(() => {
        if (!Array.isArray(requestedPaths) || requestedPaths.length === 0) return null;
        const out: string[] = [];
        for (const p of requestedPaths) {
            if (typeof p !== 'string') continue;
            const trimmed = p.trim();
            if (trimmed.length === 0) continue;
            out.push(trimmed);
        }
        return out.length > 0 ? out : null;
    }, [requestedPaths]);

    const requestedPathsKey = React.useMemo(() => {
        const normalized = requestedPathsNormalized;
        if (!normalized) return '';
        return normalized.join('\u0000');
    }, [requestedPathsNormalized]);

    const requestedPathsNormalizedRef = React.useRef<readonly string[] | null>(null);
    requestedPathsNormalizedRef.current = requestedPathsNormalized;

    const [diffStateByPath, setDiffStateByPath] = React.useState<Record<string, DiffState>>({});
    const diffStateByPathRef = React.useRef(diffStateByPath);
    React.useEffect(() => {
        diffStateByPathRef.current = diffStateByPath;
    }, [diffStateByPath]);

    const lastFetchAtMsByPathRef = React.useRef<Record<string, number>>({});
    const inFlightPathsRef = React.useRef<Set<string>>(new Set());
    const fileStatusByPath = React.useMemo(() => {
        const map = new Map<string, ScmFileStatus>();
        for (const file of reviewFiles) {
            if (!file?.fullPath) continue;
            map.set(file.fullPath, file);
        }
        return map;
    }, [reviewFiles]);

    const minRefetchMsResolved = React.useMemo<null | number>(() => {
        if (minRefetchMs === null || minRefetchMs === undefined) return null;
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
        // This is used for manual refresh, and for snapshot signature changes from SCM refresh.
        lastFetchAtMsByPathRef.current = {};
    }, [diffArea, refreshToken, sessionId, snapshotSignature]);

    React.useEffect(() => {
        const normalized = requestedPathsNormalizedRef.current;
        if (!normalized || normalized.length === 0) return;
        const allowed = new Set<string>();
        for (const p of normalized) {
            allowed.add(p);
        }
        if (allowed.size === 0) return;

        // Keep in-flight entries so callers don't flip-flop loading indicators during fast scroll.
        for (const p of inFlightPathsRef.current) {
            allowed.add(p);
        }

        setDiffStateByPath((prev) => {
            const keys = Object.keys(prev);
            if (keys.length === 0) return prev;

            let changed = false;
            const next: Record<string, DiffState> = {};
            for (const key of keys) {
                if (!allowed.has(key)) {
                    changed = true;
                    continue;
                }
                next[key] = prev[key]!;
            }
            return changed ? next : prev;
        });
    }, [requestedPathsKey]);

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
                if (lastFetchAtMs > 0) {
                    // Default behavior is stale-while-revalidate: do not refetch already-loaded diffs
                    // unless explicitly requested (refreshToken/snapshotSignature clears lastFetchAt).
                    if (minRefetchMsResolved === null) {
                        return;
                    }
                    if (minRefetchMsResolved > 0 && (nowMs - lastFetchAtMs) < minRefetchMsResolved) {
                        return;
                    }
                }
            }
            if (inFlightPathsRef.current.has(path)) {
                return;
            }
            inFlightPathsRef.current.add(path);

            const signature = typeof snapshotSignature === 'string' && snapshotSignature.trim().length > 0 ? snapshotSignature : null;
            if (signature && diffCache) {
                const cached = diffCache.get({ sessionId, snapshotSignature: signature, diffArea, path });
                if (cached && typeof cached.diff === 'string') {
                    setDiffStateByPath((prev) => ({
                        ...prev,
                        [path]: { status: 'loaded', diff: cached.diff, error: null },
                    }));
                    lastFetchAtMsByPathRef.current[path] = Date.now();
                    inFlightPathsRef.current.delete(path);
                    return;
                }
            }

            setDiffStateByPath((prev) => {
                const existing = prev[path];
                // Stale-while-revalidate: keep already-loaded diffs visible while we refresh in the background.
                if (existing?.status === 'loaded' && existing.diff) {
                    return prev;
                }
                return { ...prev, [path]: { status: 'loading', diff: '', error: null } };
            });
            try {
                const file = fileStatusByPath.get(path) ?? null;
                const response = await fetchSessionUnifiedDiffForPath({
                    sessionId,
                    diffArea,
                    path,
                    file,
                    normalizeError,
                    fallbackError,
                });
                lastFetchAtMsByPathRef.current[path] = Date.now();
                if (cancelled) return;
                if (!response.success) {
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
                                error: response.error,
                            },
                        };
                    });
                    return;
                }

                setDiffStateByPath((prev) => ({
                    ...prev,
                    [path]: { status: 'loaded', diff: response.diff ?? '', error: null },
                }));
                if (signature && diffCache) {
                    diffCache.set({ sessionId, snapshotSignature: signature, diffArea, path }, response.diff ?? '');
                }
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
            const pathsToEnsure: string[] = [];
            const normalized = requestedPathsNormalizedRef.current;
            if (normalized && normalized.length > 0) {
                pathsToEnsure.push(...normalized);
            } else if (tooLarge) {
                const path = selectedPath || reviewFiles[0]!.fullPath;
                if (path) pathsToEnsure.push(path);
            } else {
                // When no explicit requestedPaths are provided (for example during initial load),
                // avoid fetching every diff up-front. Fetch a single "anchor" diff, then rely on
                // callers to provide requestedPaths as the user scrolls/expands.
                const anchor = selectedPath || reviewFiles[0]?.fullPath;
                if (anchor) pathsToEnsure.push(anchor);
            }

            const seen = new Set<string>();
            const uniquePaths = pathsToEnsure.filter((p) => {
                if (seen.has(p)) return false;
                seen.add(p);
                return true;
            });

            const resolvedConcurrency = (() => {
                const raw = typeof maxConcurrency === 'number' && Number.isFinite(maxConcurrency) ? maxConcurrency : 1;
                return Math.max(1, Math.floor(raw));
            })();

            const queue = uniquePaths.slice();
            const workerCount = Math.min(resolvedConcurrency, queue.length);
            const workers = Array.from({ length: workerCount }, async () => {
                while (!cancelled) {
                    const next = queue.shift();
                    if (!next) return;
                    await loadDiff(next);
                }
            });
            await Promise.all(workers);
        };

        run();
        return () => {
            cancelled = true;
        };
    }, [
        diffArea,
        diffCache,
        fallbackError,
        fileStatusByPath,
        isRepo,
        minRefetchMsResolved,
        normalizeError,
        refreshToken,
        requestedPathsKey,
        reviewFiles,
        selectedPath,
        sessionId,
        snapshotSignature,
        tooLarge,
    ]);

    const getDiffState = React.useCallback((path: string) => diffStateByPath[path] ?? initialDiffState(), [diffStateByPath]);

    return {
        diffStateByPath,
        getDiffState,
    };
}
