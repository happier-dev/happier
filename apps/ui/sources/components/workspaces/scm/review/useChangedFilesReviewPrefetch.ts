import * as React from 'react';

import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useSetting } from '@/sync/domains/state/storage';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { ScmDiffPrefetchScheduler } from '@/scm/diffCache/scmDiffPrefetchScheduler';
import { fetchSessionUnifiedDiffForPath } from '@/scm/diff/fetchSessionUnifiedDiffForPath';
import { useViewableItemIndices } from '@/components/ui/scroll/useViewableItemIndices';
import { useScmReviewViewabilityConfig } from '@/scm/review/useScmReviewViewabilityConfig';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';

import type { ChangedFilesReviewRow } from './buildChangedFilesReviewRows';
import { resolveReviewPrefetchWindow } from './resolveReviewPrefetchWindow';

export type ChangedFilesReviewPrefetchState = Readonly<{
    prefetchEnabled: boolean;
    requestedPaths: readonly string[] | null;
    /**
     * Buffer window around the currently viewable rows (ahead/behind) used for background diff prefetching.
     * When the review UI is in "large diff" mode, this can also be used to limit which diffs are rendered
     * at once to keep scrolling smooth.
     */
    prefetchWindowPaths: readonly string[] | null;
    onViewableItemsChanged: (info: any) => void;
    viewableRowIndices: readonly number[];
    maxDiffLoadConcurrency: number;
}>;

export function useChangedFilesReviewPrefetch(input: Readonly<{
    sessionId: string;
    snapshotSignature: string | null;
    diffArea: ScmDiffArea;
    rows: readonly ChangedFilesReviewRow[];
    reviewFiles: readonly ScmFileStatus[];
    isCollapsed: (path: string) => boolean;
    normalizeError: (input: unknown) => string;
    fallbackError: string;
    /**
     * Used as a safe fallback during initial render before viewability callbacks fire.
     * Prevents the diff loader from trying to fetch every diff up-front.
     */
    initialRequestedPaths?: readonly string[];
    fetchUnifiedDiffForPath?: ScmReviewUnifiedDiffFetcher;
}>): ChangedFilesReviewPrefetchState {
    const viewabilityConfig = useScmReviewViewabilityConfig();
    const prefetchConcurrencySetting = useSetting('scmReviewPrefetchConcurrency');
    const fetchUnifiedDiffForPath = input.fetchUnifiedDiffForPath;

    const viewabilityEnabled = input.rows.length > 0;

    const prefetchEnabled = (
        Boolean(input.sessionId)
        && Boolean(input.snapshotSignature)
        && viewabilityConfig.enabled
        && typeof prefetchConcurrencySetting === 'number' && Number.isFinite(prefetchConcurrencySetting)
    );

    const prefetchConcurrency = React.useMemo(() => {
        if (!prefetchEnabled) return 0;
        return Math.max(1, Math.floor(prefetchConcurrencySetting as number));
    }, [prefetchConcurrencySetting, prefetchEnabled]);

    const viewability = useViewableItemIndices({
        enabled: viewabilityEnabled,
        debounceMs: viewabilityConfig.debounceMs,
    });
    const viewableRowIndices = viewability.viewableIndices;
    const onViewableItemsChanged = viewability.onViewableItemsChanged;

    const requestedPaths = React.useMemo(() => {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const rowIndex of viewableRowIndices) {
            const row = input.rows[rowIndex];
            if (!row || row.kind !== 'file') continue;
            const path = row.file?.fullPath;
            if (!path) continue;
            if (seen.has(path)) continue;
            seen.add(path);
            out.push(path);
        }
        if (viewableRowIndices.length > 0) return out;

        const initialRequested = Array.isArray(input.initialRequestedPaths)
            ? input.initialRequestedPaths.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0)
            : [];
        if (initialRequested.length > 0) return initialRequested.slice(0, 1);

        const initialCount = 1;
        const initial: string[] = [];
        for (const file of input.reviewFiles.slice(0, initialCount)) {
            if (file?.fullPath) initial.push(file.fullPath);
        }
        // If prefetch settings are missing, fall back to fetching a single anchor diff.
        if (initial.length > 0) return initial;
        const anchor = input.reviewFiles[0]?.fullPath;
        return anchor ? [anchor] : null;
    }, [input.initialRequestedPaths, input.isCollapsed, input.reviewFiles, input.rows, viewabilityConfig.aheadCount, viewabilityConfig.behindCount, viewableRowIndices]);

    const fileStatusByPath = React.useMemo(() => {
        const map = new Map<string, ScmFileStatus>();
        for (const file of input.reviewFiles) {
            if (!file?.fullPath) continue;
            map.set(file.fullPath, file);
        }
        return map;
    }, [input.reviewFiles]);

    const normalizeErrorRef = React.useRef(input.normalizeError);
    React.useEffect(() => {
        normalizeErrorRef.current = input.normalizeError;
    }, [input.normalizeError]);
    const fileStatusByPathRef = React.useRef(fileStatusByPath);
    React.useEffect(() => {
        fileStatusByPathRef.current = fileStatusByPath;
    }, [fileStatusByPath]);

    const prefetchScheduler = React.useMemo(() => new ScmDiffPrefetchScheduler({
            cache: scmDiffCache,
            fetchDiff: async ({ sessionId, diffArea, path, snapshotSignature }) => {
                const file = fileStatusByPathRef.current.get(path) ?? null;
                const response = await fetchSessionUnifiedDiffForPath({
                    sessionId,
                    diffArea,
                    snapshotSignature,
                    diffCache: scmDiffCache,
                    path,
                    file,
                    normalizeError: (e) => normalizeErrorRef.current(e),
                    fallbackError: input.fallbackError,
                });
                return response.success
                    ? ({ success: true, diff: response.diff } as const)
                    : ({ success: false, error: response.error } as const);
            },
            now: () => Date.now(),
            maxConcurrency: Math.max(1, prefetchConcurrency || 1),
        }), [input.fallbackError]);
    React.useEffect(() => {
        if (!prefetchEnabled) return;
        prefetchScheduler.setMaxConcurrency(prefetchConcurrency);
    }, [prefetchConcurrency, prefetchEnabled, prefetchScheduler]);

    const reviewFilePaths = React.useMemo(() => {
        return input.reviewFiles.map((f) => f.fullPath).filter(Boolean);
    }, [input.reviewFiles]);

    const prefetchWindowPaths = React.useMemo(() => {
        if (!prefetchEnabled) return null;
        if (!reviewFilePaths.length) return null;
        const window = resolveReviewPrefetchWindow({
            rows: input.rows,
            viewableRowIndices,
            aheadCount: viewabilityConfig.aheadCount,
            behindCount: viewabilityConfig.behindCount,
            maxFileIndex: Math.max(0, reviewFilePaths.length - 1),
        });
        if (!window) return null;
        return reviewFilePaths.slice(window.startFileIndex, window.endFileIndex + 1);
    }, [input.rows, prefetchEnabled, reviewFilePaths, viewabilityConfig.aheadCount, viewabilityConfig.behindCount, viewableRowIndices]);

    React.useEffect(() => {
        if (!prefetchEnabled) return;
        // Custom read ports belong to the demand loader, which owns their queue
        // and cancellation. They do not share the live Session acquisition cache.
        if (fetchUnifiedDiffForPath) return;
        const signature = input.snapshotSignature;
        if (!signature) return;
        if (!prefetchWindowPaths || prefetchWindowPaths.length === 0) return;

        const visible = new Set<string>(requestedPaths ?? []);
        // The foreground loader owns visible demand. Buffer acquisition is useful
        // only for expanded rows; it shares that loader's acquisition cache.
        const toPrefetch = prefetchWindowPaths.filter((p) => !visible.has(p) && !input.isCollapsed(p));
        if (toPrefetch.length === 0) return;

        prefetchScheduler.prefetch({
            sessionId: input.sessionId,
            snapshotSignature: signature,
            diffArea: input.diffArea,
            paths: toPrefetch,
        });
    }, [input.diffArea, input.isCollapsed, input.sessionId, input.snapshotSignature, prefetchEnabled, prefetchWindowPaths, requestedPaths, prefetchScheduler, fetchUnifiedDiffForPath]);

    const maxDiffLoadConcurrency = prefetchEnabled ? prefetchConcurrency : 1;
    return { prefetchEnabled, requestedPaths, prefetchWindowPaths, onViewableItemsChanged, viewableRowIndices, maxDiffLoadConcurrency };
}
