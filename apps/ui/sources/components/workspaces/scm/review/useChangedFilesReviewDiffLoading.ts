import * as React from 'react';

import type { ScmComparisonFile, ScmDiffArea } from '@happier-dev/protocol';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmDiffCache } from '@/scm/diffCache/scmDiffCache';
import { fetchSessionUnifiedDiffForPath } from '@/scm/diff/fetchSessionUnifiedDiffForPath';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';

import {
    createChangedFilesReviewDiffStateSource,
    type ChangedFilesReviewDiffStateSource,
} from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';

function resolveReviewDiffPathsToEnsure(input: Readonly<{
    requestedPaths: readonly string[] | null;
    tooLarge: boolean;
    selectedPath: string;
    reviewFiles: readonly ScmFileStatus[];
}>): string[] {
    const pathsToEnsure: string[] = [];
    if (input.requestedPaths !== null) {
        pathsToEnsure.push(...input.requestedPaths);
    } else if (input.tooLarge) {
        const path = input.selectedPath || input.reviewFiles[0]?.fullPath;
        if (path) pathsToEnsure.push(path);
    } else {
        const anchor = input.selectedPath || input.reviewFiles[0]?.fullPath;
        if (anchor) pathsToEnsure.push(anchor);
    }

    const seen = new Set<string>();
    return pathsToEnsure.filter((path) => {
        if (seen.has(path)) return false;
        seen.add(path);
        return true;
    });
}

export function useChangedFilesReviewDiffLoading(input: {
    sessionId: string;
    reviewScopeKey?: string;
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
    providerDiffByPath?: ReadonlyMap<string, string | null> | null;
    fetchUnifiedDiffForPath?: ScmReviewUnifiedDiffFetcher;
    findContext?: boolean;
    workspaceScope?: WorkspaceScopeBase | null;
    comparisonFiles?: readonly ScmComparisonFile[];
    normalizeError: (input: unknown) => string;
    fallbackError: string;
}) {
    const {
        sessionId,
        reviewScopeKey = sessionId,
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
        fetchUnifiedDiffForPath,
    } = input;

    const requestedPathsNormalized = React.useMemo<readonly string[] | null>(() => {
        if (!Array.isArray(requestedPaths)) return null;
        const out: string[] = [];
        for (const p of requestedPaths) {
            if (typeof p !== 'string') continue;
            const trimmed = p.trim();
            if (trimmed.length === 0) continue;
            out.push(trimmed);
        }
        return out;
    }, [requestedPaths]);

    const requestedPathsKey = React.useMemo(() => {
        return JSON.stringify(requestedPathsNormalized);
    }, [requestedPathsNormalized]);

    const requestedPathsNormalizedRef = React.useRef<readonly string[] | null>(null);
    requestedPathsNormalizedRef.current = requestedPathsNormalized;

    const diffStateSourceRef = React.useRef<ChangedFilesReviewDiffStateSource | null>(null);
    if (!diffStateSourceRef.current) {
        diffStateSourceRef.current = createChangedFilesReviewDiffStateSource();
    }
    const diffStateSource = diffStateSourceRef.current;
    const retryDiffRef = React.useRef<((path: string) => void) | null>(null);
    const retryDiff = React.useCallback((path: string) => retryDiffRef.current?.(path), []);
    const setLoadedDiff = React.useCallback((path: string, diff: string, emptyFile = false) => {
        diffStateSource.updateDiffState(path, previous => {
            // Revalidation must not discard Find's already-loaded revision corpus.
            if (previous.status === 'loaded' && previous.diff === diff && previous.error === null && Boolean(previous.emptyFile) === emptyFile) return previous;
            return { status: 'loaded', diff, error: null, ...(emptyFile ? { emptyFile: true } : {}) };
        });
    }, [diffStateSource]);
    const findContext = input.findContext === true;
    const { serverId, machineId, rootPath } = input.workspaceScope ?? {};
    const comparisonFiles = input.comparisonFiles;

    React.useEffect(() => {
        if (findContext) return;
        for (const [path, state] of diffStateSource.getSnapshot()) {
            if (!state.context) continue;
            const { context: _context, ...withoutContext } = state;
            diffStateSource.setDiffState(path, withoutContext);
        }
    }, [diffStateSource, findContext]);

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

    const hasScopedDiffs = providerDiffByPath != null;
    const latestRef = React.useRef({ input, fileStatusByPath, minRefetchMsResolved });
    latestRef.current = { input, fileStatusByPath, minRefetchMsResolved };
    const scheduleRef = React.useRef<(() => void) | null>(null);
    React.useEffect(() => {
        diffStateSource.reset();
        lastFetchAtMsByPathRef.current = {};
        inFlightPathsRef.current = new Set();
    }, [diffArea, hasScopedDiffs, reviewScopeKey]);

    React.useEffect(() => {
        inFlightPathsRef.current = new Set();
        // Force a revalidate on the next effect run without clearing already-loaded diffs.
        // This is used for manual refresh, and for snapshot signature changes from SCM refresh.
        lastFetchAtMsByPathRef.current = {};
    }, [diffArea, refreshToken, reviewScopeKey, snapshotSignature]);

    React.useEffect(() => {
        diffStateSource.prune(new Set(fileStatusByPath.keys()), inFlightPathsRef.current);
    }, [fileStatusByPath]);

    React.useEffect(() => {
        if (!providerDiffByPath || providerDiffByPath.size === 0) return;
        if (findContext) return; // The worker publishes a patch and its revision context together.
        const pathsToEnsure = resolveReviewDiffPathsToEnsure({
            requestedPaths: requestedPathsNormalizedRef.current,
            tooLarge,
            selectedPath,
            reviewFiles,
        });
        for (const path of pathsToEnsure) {
            const providerDiff = providerDiffByPath.get(path);
            if (providerDiff === undefined) continue;
            if (providerDiff === null) diffStateSource.setDiffState(path, {
                status: 'error',
                diff: '',
                error: fallbackError,
            });
            else setLoadedDiff(path, providerDiff);
            lastFetchAtMsByPathRef.current[path] = Date.now();
        }
    }, [diffStateSource, setLoadedDiff, fallbackError, providerDiffByPath, requestedPathsKey, reviewFiles, selectedPath, tooLarge, findContext]);

    React.useEffect(() => {
        if (!isRepo) return;
        let cancelled = false;
        const contextRead = new AbortController();
        const inFlightPaths = inFlightPathsRef.current;
        const failDiff = (path: string, error: string, errorCode = 'COMMAND_FAILED') => {
            lastFetchAtMsByPathRef.current[path] = Date.now();
            diffStateSource.updateDiffState(path, previous => previous.status === 'loaded'
                ? { ...previous, error, errorCode } : { status: 'error', diff: '', error, errorCode });
        };

        const ensureFindContext = async (path: string, next?: Readonly<{ diff: string; emptyFile?: true }>) => {
            const { input, fileStatusByPath } = latestRef.current;
            const findContext = input.findContext === true;
            const comparisonFiles = input.comparisonFiles;
            const { machineId, rootPath } = input.workspaceScope ?? {};
            const previous = diffStateSource.getDiffState(path);
            const state = next ? { status: 'loaded' as const, error: null, ...next } : previous;
            if (!findContext || state.status !== 'loaded' || (!next && previous.context && previous.context.status !== 'loading') || !state.diff) {
                if (next) setLoadedDiff(path, next.diff, next.emptyFile);
                return;
            }
            const file = fileStatusByPath.get(path);
            if (file?.isBinary) {
                if (next) setLoadedDiff(path, next.diff, next.emptyFile);
                return;
            }
            const captured = comparisonFiles?.find(file => file.path === path);
            const scope = machineId && rootPath ? input.workspaceScope : resolveWorkspaceTargetForSession(sessionId);
            const retainCorpus = previous.status === 'loaded' && previous.context?.status === 'loaded';
            if (!retainCorpus) diffStateSource.setDiffState(path, { ...state, context: { status: 'loading' } });
            let baseText: string | null = null;
            try {
                if (file?.status === 'added' || file?.status === 'untracked') baseText = '';
                else if (scope && (!hasScopedDiffs || captured?.beforeBlobId)) {
                    const { fetchWorkspaceFileAtRevision } = await import('@/scm/files/fetchWorkspaceFileAtRevision');
                    const read = await fetchWorkspaceFileAtRevision({ scope, path: captured?.previousPath ?? path,
                        selector: captured?.beforeBlobId ? { blobId: captured.beforeBlobId } : { side: 'before', area: diffArea },
                        signal: contextRead.signal });
                    if (read.success && !read.bytes.includes(0)) baseText = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
                }
            } catch { /* The patch remains searchable; unreadable context is partial coverage. */ }
            if (cancelled || latestRef.current.input.findContext !== true) return;
            diffStateSource.updateDiffState(path, current => current.diff !== (retainCorpus ? previous.diff : state.diff) ? current : { ...state,
                context: baseText === null ? { status: 'unavailable' } : { status: 'loaded', baseText } });
        };

        const loadDiff = async (path: string) => {
            const { input, fileStatusByPath, minRefetchMsResolved } = latestRef.current;
            const { providerDiffByPath, fetchUnifiedDiffForPath, normalizeError, fallbackError } = input;
            const existing = diffStateSource.getDiffState(path);
            const providerDiff = providerDiffByPath?.get(path);
            const nowMs = Date.now();
            if (existing?.status === 'loaded' || existing?.status === 'error') {
                const lastFetchAtMs = lastFetchAtMsByPathRef.current[path] ?? 0;
                if (lastFetchAtMs > 0 && (providerDiff === undefined || providerDiff === existing.diff)) {
                    // Default behavior is stale-while-revalidate: do not refetch already-loaded diffs
                    // unless explicitly requested (refreshToken/snapshotSignature clears lastFetchAt).
                    // A snapshot's lifetime is owned by SCM invalidation, not render
                    // timing. Equal status counts alone are not its signature.
                    if (snapshotSignature || minRefetchMsResolved === null) {
                        await ensureFindContext(path);
                        return;
                    }
                    if (minRefetchMsResolved > 0 && (nowMs - lastFetchAtMs) < minRefetchMsResolved) {
                        await ensureFindContext(path);
                        return;
                    }
                }
            }
            if (inFlightPaths.has(path)) {
                return;
            }
            if (providerDiff !== undefined) {
                if (providerDiff === null) diffStateSource.setDiffState(path, {
                    status: 'error',
                    diff: '',
                    error: fallbackError,
                });
                else await ensureFindContext(path, { diff: providerDiff });
                if (!cancelled) lastFetchAtMsByPathRef.current[path] = Date.now();
                return;
            }
            if (!sessionId && !fetchUnifiedDiffForPath) return;
            inFlightPaths.add(path);

            diffStateSource.updateDiffState(path, (prev) => {
                // Stale-while-revalidate: keep already-loaded diffs visible while we refresh in the background.
                if (prev?.status === 'loaded') {
                    return prev;
                }
                return { status: 'loading', diff: '', error: null };
            });
            try {
                const file = fileStatusByPath.get(path) ?? null;
                const response = fetchUnifiedDiffForPath
                    ? await fetchUnifiedDiffForPath({
                        diffArea,
                        path,
                        file,
                        normalizeError,
                        fallbackError,
                        snapshotSignature,
                        diffCache,
                        signal: contextRead.signal,
                    })
                    : await fetchSessionUnifiedDiffForPath({
                        sessionId,
                        diffArea,
                        path,
                        file,
                        normalizeError,
                        fallbackError,
                        snapshotSignature,
                        diffCache,
                    });
                if (cancelled) return;
                if (!response.success) {
                    const errorCode = 'errorCode' in response && typeof response.errorCode === 'string' ? response.errorCode : undefined;
                    if (errorCode === 'COMMAND_CANCELLED') {
                        diffStateSource.updateDiffState(path, previous => previous.status === 'loaded'
                            ? previous : { status: 'idle', diff: '', error: null });
                        return;
                    }
                    failDiff(path, response.error.trim() ? response.error : fallbackError, errorCode);
                    return;
                }

                // Equal patches can still have different omitted base lines after SCM changes.
                await ensureFindContext(path, { diff: response.diff ?? '',
                    ...('emptyFile' in response && response.emptyFile ? { emptyFile: true as const } : {}) });
                if (!cancelled) lastFetchAtMsByPathRef.current[path] = Date.now();

            } catch (err) {
                if (cancelled) return;
                const normalized = normalizeError(err);
                failDiff(path, (typeof normalized === 'string' && normalized.trim()) ? normalized : fallbackError, readRpcErrorCode(err));
            } finally {
                inFlightPaths.delete(path);
            }
        };

        const retry = (path: string) => {
            delete lastFetchAtMsByPathRef.current[path];
            void loadDiff(path);
        };
        retryDiffRef.current = retry;

        // Hydration and viewport changes update demand, not the lifetime of admitted
        // reads. One queue owns concurrency and never starts a path already in flight.
        let queue: string[] = [];
        let activeWorkers = 0;
        const run = () => {
            const current = latestRef.current.input;
            const uniquePaths = resolveReviewDiffPathsToEnsure({
                requestedPaths: requestedPathsNormalizedRef.current,
                tooLarge: current.tooLarge,
                selectedPath: current.selectedPath,
                reviewFiles: current.reviewFiles,
            });

            const resolvedConcurrency = (() => {
                const raw = typeof current.maxConcurrency === 'number' && Number.isFinite(current.maxConcurrency) ? current.maxConcurrency : 1;
                return Math.max(1, Math.floor(raw));
            })();

            queue = uniquePaths.filter(path => !inFlightPaths.has(path));
            const worker = async () => {
                activeWorkers++;
                try {
                    while (!cancelled) {
                        const next = queue.shift();
                        if (!next) return;
                        await loadDiff(next);
                    }
                } finally {
                    activeWorkers--;
                }
            };
            while (activeWorkers < resolvedConcurrency && queue.length > 0) void worker();
        };

        scheduleRef.current = run;
        run();
        return () => {
            cancelled = true;
            scheduleRef.current = null;
            retryDiffRef.current = null;
            contextRead.abort();
        };
    }, [diffArea, diffCache, isRepo, hasScopedDiffs, sessionId, reviewScopeKey, snapshotSignature, refreshToken,
        serverId, machineId, rootPath, diffStateSource, setLoadedDiff]);

    React.useEffect(() => scheduleRef.current?.(), [
        diffArea,
        diffCache,
        setLoadedDiff,
        fallbackError,
        fileStatusByPath,
        fetchUnifiedDiffForPath,
        isRepo,
        minRefetchMsResolved,
        maxConcurrency,
        normalizeError,
        refreshToken,
        requestedPathsKey,
        reviewFiles,
        selectedPath,
        sessionId,
        reviewScopeKey,
        snapshotSignature,
        tooLarge,
        providerDiffByPath,
        findContext, serverId, machineId, rootPath, comparisonFiles,
    ]);

    return {
        diffStateSource,
        retryDiff,
    };
}
