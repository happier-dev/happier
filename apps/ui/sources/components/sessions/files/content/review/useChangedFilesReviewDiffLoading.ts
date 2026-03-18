import * as React from 'react';

import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmDiffCache } from '@/scm/diffCache/scmDiffCache';
import { fetchSessionUnifiedDiffForPath } from '@/scm/diff/fetchSessionUnifiedDiffForPath';

import {
    createChangedFilesReviewDiffStateSource,
    type ChangedFilesReviewDiffStateSource,
} from '@/components/sessions/files/content/review/ChangedFilesReviewDiffStore';

type DiffState = {
    status: 'idle' | 'loading' | 'loaded' | 'error';
    diff: string;
    error: string | null;
};

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
    providerDiffByPath?: ReadonlyMap<string, string> | null;
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
        providerDiffByPath,
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

    const diffStateSourceRef = React.useRef<ChangedFilesReviewDiffStateSource | null>(null);
    if (!diffStateSourceRef.current) {
        diffStateSourceRef.current = createChangedFilesReviewDiffStateSource();
    }
    const diffStateSource = diffStateSourceRef.current;

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
        diffStateSource.reset();
        lastFetchAtMsByPathRef.current = {};
        inFlightPathsRef.current = new Set();
    }, [diffArea, sessionId]);

    React.useEffect(() => {
        // Force a revalidate on the next effect run without clearing already-loaded diffs.
        // This is used for manual refresh, and for snapshot signature changes from SCM refresh.
        lastFetchAtMsByPathRef.current = {};
    }, [diffArea, refreshToken, sessionId, snapshotSignature]);

    React.useEffect(() => {
        diffStateSource.prune(new Set(fileStatusByPath.keys()), inFlightPathsRef.current);
    }, [fileStatusByPath]);

    React.useEffect(() => {
        if (!providerDiffByPath || providerDiffByPath.size === 0) return;
        for (const path of fileStatusByPath.keys()) {
            const providerDiff = providerDiffByPath.get(path);
            if (typeof providerDiff !== 'string' || providerDiff.trim().length === 0) continue;
            diffStateSource.setDiffState(path, {
                status: 'loaded',
                diff: providerDiff,
                error: null,
            });
            lastFetchAtMsByPathRef.current[path] = Date.now();
        }
    }, [diffStateSource, fileStatusByPath, providerDiffByPath]);

    React.useEffect(() => {
        if (!sessionId) return;
        if (!isRepo) return;
        if (reviewFiles.length === 0) return;

        let cancelled = false;

        const loadDiff = async (path: string) => {
            const existing = diffStateSource.getDiffState(path);
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
            const providerDiff = providerDiffByPath?.get(path);
            if (typeof providerDiff === 'string' && providerDiff.trim().length > 0) {
                diffStateSource.setDiffState(path, {
                    status: 'loaded',
                    diff: providerDiff,
                    error: null,
                });
                lastFetchAtMsByPathRef.current[path] = Date.now();
                return;
            }
            inFlightPathsRef.current.add(path);

            const signature = typeof snapshotSignature === 'string' && snapshotSignature.trim().length > 0 ? snapshotSignature : null;
            if (signature && diffCache) {
                const cached = diffCache.get({ sessionId, snapshotSignature: signature, diffArea, path });
                if (cached && typeof cached.diff === 'string') {
                    diffStateSource.setDiffState(path, { status: 'loaded', diff: cached.diff, error: null });
                    lastFetchAtMsByPathRef.current[path] = Date.now();
                    inFlightPathsRef.current.delete(path);
                    return;
                }
            }

            diffStateSource.updateDiffState(path, (prev) => {
                // Stale-while-revalidate: keep already-loaded diffs visible while we refresh in the background.
                if (prev?.status === 'loaded' && prev.diff) {
                    return prev;
                }
                return { status: 'loading', diff: '', error: null };
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
                    diffStateSource.updateDiffState(path, (prev) => {
                        if (prev?.status === 'loaded' && prev.diff) {
                            return prev;
                        }
                        return { status: 'error', diff: '', error: response.error };
                    });
                    return;
                }

                diffStateSource.setDiffState(path, { status: 'loaded', diff: response.diff ?? '', error: null });
                if (signature && diffCache) {
                    diffCache.set({ sessionId, snapshotSignature: signature, diffArea, path }, response.diff ?? '');
                }
            } catch (err) {
                if (cancelled) return;
                const normalized = normalizeError(err);
                diffStateSource.updateDiffState(path, (prev) => {
                    if (prev?.status === 'loaded' && prev.diff) {
                        return prev;
                    }
                    return {
                        status: 'error',
                        diff: '',
                        error: (typeof normalized === 'string' && normalized.trim()) ? normalized : fallbackError,
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
        providerDiffByPath,
    ]);

    return {
        diffStateSource,
    };
}
