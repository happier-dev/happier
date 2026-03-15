import * as React from 'react';
import { Platform, Pressable, View, type ScrollViewProps } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { FlashList, type FlashListRef } from '@shopify/flash-list';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionAttributedFile, SessionAttributionReliability, ChangedFilesViewMode } from '@/scm/scmAttribution';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import type { ScmDiffArea } from '@happier-dev/protocol';
import { PierreScrollRootVirtualizerProvider } from '@/components/ui/code/diff/pierre/PierreScrollRootVirtualizerProvider';
import { useChangedFilesReviewCollapsedPaths } from '@/components/sessions/files/content/review/useChangedFilesReviewCollapsedPaths';
import { useChangedFilesReviewDiffLoading } from '@/components/sessions/files/content/review/useChangedFilesReviewDiffLoading';
import { buildChangedFilesReviewRows, type ChangedFilesReviewRow } from '@/components/sessions/files/content/review/buildChangedFilesReviewRows';
import { ChangedFilesReviewDiffBlock, type ReviewDiffState } from '@/components/sessions/files/content/review/ChangedFilesReviewDiffBlock';
import { useChangedFilesReviewPrefetch } from '@/components/sessions/files/content/review/useChangedFilesReviewPrefetch';
import { useChangedFilesReviewFocusPath } from '@/components/sessions/files/content/review/useChangedFilesReviewFocusPath';
import { entryToDelta, fileHasDeltaForArea, toAreaFileStatus, totalsChangedLines, type ScmEntryDelta } from '@/components/sessions/files/content/review/scmEntryDelta';
import { ChangedFilesSectionHeader } from '@/components/sessions/files/changedFiles/ChangedFilesSectionHeader';
import { ChangedFilesReviewDiffAreaSelector } from '@/components/sessions/files/content/review/ChangedFilesReviewDiffAreaSelector';
import { useChangedFilesReviewDiffBlockRenderer } from '@/components/sessions/files/content/review/useChangedFilesReviewDiffBlockRenderer';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ScmChangeRow } from '@/components/sessions/sourceControl/changes/ScmChangeRow';
import { buildSnapshotSignature } from '@/scm/statusSync/projectState';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { resolveDefaultDiffModeForFile } from '@/scm/diff/defaultMode';
import { useSetting } from '@/sync/domains/state/storage';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { filterDirectoryLikeScmFileStatuses, isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';

const ViewWithClick = View as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof View> & { onClick?: any; onKeyDown?: any; tabIndex?: number }
>;

type ChangedFilesReviewTheme = Readonly<{
    colors: Readonly<{
        surfaceHigh: string;
        divider: string;
        textSecondary: string;
    }>;
}>;

type ChangedFilesReviewProps = {
    theme: ChangedFilesReviewTheme;
    sessionId: string;
    snapshot: ScmWorkingSnapshot | null;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    maxFiles: number;
    maxChangedLines: number;
    onFilePress: (file: ScmFileStatus) => void;
    onFilePressPinned?: (file: ScmFileStatus) => void;
    onToggleSelectionForFile?: (file: ScmFileStatus) => void;
    renderFileActions?: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions?: (file: ScmFileStatus) => React.ReactNode;
    focusPath?: string | null;
    rowDensity?: 'comfortable' | 'compact';
    initialCollapsedPaths?: readonly string[] | null;
    onCollapsedPathsChange?: (paths: string[]) => void;
    initialScrollTop?: number | null;
    onScrollTopChange?: (top: number) => void;
    diffAutoRefreshIntervalMs?: number;
    diffRefreshToken?: number;
    reviewCommentsEnabled?: boolean;
    reviewCommentDrafts?: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
    onScroll?: ScrollViewProps['onScroll'];
    onLayout?: ScrollViewProps['onLayout'];
    onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
};

export function ChangedFilesReview(props: ChangedFilesReviewProps) {
    const {
        theme,
        sessionId,
        snapshot,
        changedFilesViewMode,
        attributionReliability,
        allRepositoryChangedFiles,
        sessionAttributedFiles,
        repositoryOnlyFiles,
        suppressedInferredCount,
        maxFiles,
        maxChangedLines,
        onFilePress,
        rowDensity = 'comfortable',
    } = props;

    const plugin = scmUiBackendRegistry.getPluginForSnapshot(snapshot);
    const diffConfig = plugin.diffModeConfig(snapshot);
    const scmDefaultDiffModeByBackend = useSetting('scmDefaultDiffModeByBackend');
    const reviewCommentsEnabled = props.reviewCommentsEnabled === true;
    const reviewCommentDrafts = props.reviewCommentDrafts ?? [];
    const diffAutoRefreshIntervalMs =
        typeof props.diffAutoRefreshIntervalMs === 'number' && Number.isFinite(props.diffAutoRefreshIntervalMs)
            ? Math.max(0, props.diffAutoRefreshIntervalMs)
            : 60_000;
    const diffRefreshToken =
        typeof props.diffRefreshToken === 'number' && Number.isFinite(props.diffRefreshToken)
            ? props.diffRefreshToken
            : 0;

    const userSelectedDiffAreaRef = React.useRef(false);
    const hasIncludedDelta = Number(snapshot?.totals?.includedFiles ?? 0) > 0;
    const hasPendingDelta = Number(snapshot?.totals?.pendingFiles ?? 0) > 0;
    const [diffArea, setDiffAreaRaw] = React.useState<ScmDiffArea>(() => {
        return resolveDefaultDiffModeForFile({
            snapshot,
            backendOverrides: scmDefaultDiffModeByBackend as Record<string, ScmDiffArea> | undefined,
            hasIncludedDelta,
            hasPendingDelta,
        });
    });
    const setDiffArea = React.useCallback((next: ScmDiffArea) => {
        userSelectedDiffAreaRef.current = true;
        setDiffAreaRaw(next);
    }, []);
    React.useEffect(() => {
        const available = new Set<ScmDiffArea>(diffConfig.availableModes);
        const fallback = available.has(diffConfig.defaultMode)
            ? diffConfig.defaultMode
            : (diffConfig.availableModes[0] ?? 'pending');
        setDiffAreaRaw((prev) => (available.has(prev) ? prev : fallback));
    }, [diffConfig.availableModes, diffConfig.defaultMode]);

    React.useEffect(() => {
        if (userSelectedDiffAreaRef.current) return;
        const available = new Set<ScmDiffArea>(diffConfig.availableModes);

        if (hasIncludedDelta && !hasPendingDelta && available.has('included')) {
            setDiffAreaRaw((prev) => (prev === 'included' ? prev : 'included'));
            return;
        }
        if (hasPendingDelta && !hasIncludedDelta && available.has('pending')) {
            setDiffAreaRaw((prev) => (prev === 'pending' ? prev : 'pending'));
        }
    }, [diffConfig.availableModes, hasIncludedDelta, hasPendingDelta]);

    const entryDeltaByPath = React.useMemo(() => {
        const map = new Map<string, ScmEntryDelta>();
        for (const entry of snapshot?.entries ?? []) {
            if (!entry?.path) continue;
            map.set(entry.path, entryToDelta(entry));
        }
        return map;
    }, [snapshot?.entries]);

    const baseSections = React.useMemo(() => {
        const repositoryChangedFiles = filterDirectoryLikeScmFileStatuses(allRepositoryChangedFiles);
        const sessionChangedFiles = sessionAttributedFiles
            .filter((entry) => entry?.file && !isDirectoryLikeScmFileStatus(entry.file))
            .map((entry) => entry.file);
        const otherRepositoryChangedFiles = filterDirectoryLikeScmFileStatuses(repositoryOnlyFiles);

        if (changedFilesViewMode === 'repository') {
            return [
                {
                    key: 'repository',
                    kind: 'repository',
                    files: repositoryChangedFiles,
                },
            ] as const;
        }

        return [
            {
                key: 'session',
                kind: 'session',
                files: sessionChangedFiles,
            },
            ...(otherRepositoryChangedFiles.length > 0
                ? ([
                    {
                        key: 'other',
                        kind: 'other',
                        files: otherRepositoryChangedFiles,
                    },
                ] as const)
                : ([] as const)),
        ] as const;
    }, [allRepositoryChangedFiles, changedFilesViewMode, repositoryOnlyFiles, sessionAttributedFiles]);

    const sections = React.useMemo(() => {
        const out: { key: string; title: string; files: ScmFileStatus[] }[] = [];
        for (const section of baseSections) {
            const files: ScmFileStatus[] = [];
            const seen = new Set<string>();
            for (const file of section.files) {
                if (!file?.fullPath) continue;
                if (seen.has(file.fullPath)) continue;
                seen.add(file.fullPath);

                const delta = entryDeltaByPath.get(file.fullPath) ?? null;
                if (!fileHasDeltaForArea(file, delta, diffArea)) continue;
                files.push(toAreaFileStatus(file, delta, diffArea));
            }

            if (section.kind === 'repository') {
                out.push({
                    key: section.key,
                    title: t('files.repositoryChangedFiles', { count: files.length }),
                    files,
                });
                continue;
            }
            if (section.kind === 'session') {
                out.push({
                    key: section.key,
                    title: t('files.sessionAttributedChanges', { count: files.length }),
                    files,
                });
                continue;
            }
            out.push({
                key: section.key,
                title: t('files.otherRepositoryChanges', { count: files.length }),
                files,
            });
        }
        return out;
    }, [baseSections, diffArea, entryDeltaByPath]);

    const reviewFiles = React.useMemo(() => {
        const out: ScmFileStatus[] = [];
        const seen = new Set<string>();
        for (const section of sections) {
            for (const file of section.files) {
                if (!file?.fullPath) continue;
                if (seen.has(file.fullPath)) continue;
                seen.add(file.fullPath);
                out.push(file);
            }
        }
        return out;
    }, [sections]);

    const tooLarge = reviewFiles.length > maxFiles || totalsChangedLines(snapshot, diffArea) > maxChangedLines;
    const rows = React.useMemo(() => buildChangedFilesReviewRows({ sections }), [sections]);
    const pathToRowIndex = React.useMemo(() => {
        const map = new Map<string, number>();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row?.kind === 'file' && row.file?.fullPath) {
                map.set(row.file.fullPath, i);
            }
        }
        return map;
    }, [rows]);
    const listRef = React.useRef<FlashListRef<ChangedFilesReviewRow> | null>(null);
    const lastScrollTopRef = React.useRef<number>(typeof props.initialScrollTop === 'number' ? props.initialScrollTop : 0);
    const hasAppliedInitialScrollRef = React.useRef(false);

    const snapshotSignature = React.useMemo(() => {
        if (!snapshot) return null;
        return buildSnapshotSignature(snapshot);
    }, [snapshot]);

    const { collapsedPaths, isCollapsed, toggleCollapsed, expandPath } = useChangedFilesReviewCollapsedPaths({
        reviewFiles,
        initialCollapsedPaths: props.initialCollapsedPaths,
        onCollapsedPathsChange: props.onCollapsedPathsChange,
    });
    const fallbackError = t('files.reviewDiffRequestFailed');

    const initialRequestedPaths = React.useMemo(() => {
        const count = Math.max(1, Math.min(maxFiles, reviewFiles.length));
        const out: string[] = [];
        for (const file of reviewFiles.slice(0, count)) {
            if (file?.fullPath) out.push(file.fullPath);
        }
        return out;
    }, [maxFiles, reviewFiles]);

    const reportScrollTop = React.useCallback((nextTop: number) => {
        if (!Number.isFinite(nextTop)) return;
        lastScrollTopRef.current = nextTop;
        props.onScrollTopChange?.(nextTop);
    }, [props.onScrollTopChange]);

    const webScrollRootRef = React.useRef<HTMLElement | null>(null);
    const resolveWebScrollRoot = React.useCallback((): HTMLElement | null => {
        if (Platform.OS !== 'web') return null;
        const rawList: any = listRef.current as any;
        // In the UI app we compile shared RN code without DOM typings; `HTMLElement` can be `never`.
        // Treat DOM nodes as `any` within the web-only branch.
        const host = (rawList?.getScrollableNode?.() as any) ?? null;
        if (!host) return null;

        const win = (globalThis as any).window as Window | undefined;
        const isScrollable = (el: any): el is any => {
            if (!el) return false;
            if (!win?.getComputedStyle) return false;
            const style = win.getComputedStyle(el);
            const overflowY = style.overflowY;
            if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false;
            return el.scrollHeight > el.clientHeight + 1;
        };

        const boundary = (host.closest?.('[data-testid="session-details-panel-root"]') as any) ?? null;
        let cursor: any = host;
        let steps = 0;
        while (cursor && steps < 40) {
            if (isScrollable(cursor)) {
                try {
                    cursor.style.setProperty('overflow-anchor', 'none');
                } catch {
                    // ignore
                }
                webScrollRootRef.current = cursor as any;
                return cursor as any;
            }
            if (boundary && cursor === boundary) break;
            cursor = (cursor as any)?.parentElement ?? null;
            steps += 1;
        }

        return null;
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        let cancelled = false;
        const raf: (cb: FrameRequestCallback) => number =
            typeof globalThis.requestAnimationFrame === 'function'
                ? globalThis.requestAnimationFrame.bind(globalThis)
                : (cb) => globalThis.setTimeout(() => cb(Date.now()), 0);

        let attempts = 0;
        const maxAttempts = 12;
        const step = () => {
            if (cancelled) return;
            if (webScrollRootRef.current) return;
            resolveWebScrollRoot();
            attempts += 1;
            if (attempts >= maxAttempts) return;
            raf(() => step());
        };
        raf(() => step());
        return () => {
            cancelled = true;
            webScrollRootRef.current = null;
        };
    }, [resolveWebScrollRoot]);

    const handleScroll = React.useCallback((event: any) => {
        // Some consumers (scroll-edge fades) assume `event.nativeEvent` exists. FlashList can invoke
        // onScroll with non-standard shapes on web, so guard defensively.
        if (event?.nativeEvent) {
            props.onScroll?.(event);
        }

        if (Platform.OS === 'web') {
            // Prefer DOM scrollTop over RN-web's `contentOffset.y` (often unreliable with FlashList).
            const scrollRoot = webScrollRootRef.current ?? resolveWebScrollRoot();
            const current = scrollRoot && typeof (scrollRoot as any).scrollTop === 'number' ? (scrollRoot as any).scrollTop : null;
            if (typeof current === 'number') {
                reportScrollTop(current);
                return;
            }
        }

        const y = event?.nativeEvent?.contentOffset?.y;
        if (typeof y === 'number') {
            reportScrollTop(y);
        }
    }, [props.onScroll, reportScrollTop, resolveWebScrollRoot]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (hasAppliedInitialScrollRef.current) return;
        const initial = props.initialScrollTop;
        if (typeof initial !== 'number' || !Number.isFinite(initial) || initial <= 0) return;
        hasAppliedInitialScrollRef.current = true;
        deferOnWeb(() => {
            const raf: (cb: FrameRequestCallback) => number =
                typeof globalThis.requestAnimationFrame === 'function'
                    ? globalThis.requestAnimationFrame.bind(globalThis)
                    : (cb) => globalThis.setTimeout(() => cb(Date.now()), 0);

            let attempts = 0;
            const maxAttempts = 12;
            const tryApply = () => {
                const scrollRoot = webScrollRootRef.current ?? resolveWebScrollRoot();
                if (!scrollRoot) {
                    attempts += 1;
                    if (attempts >= maxAttempts) return;
                    raf(() => tryApply());
                    return;
                }

                const rawList: any = listRef.current as any;
                try {
                    rawList?.scrollToOffset?.({ offset: initial, animated: false });
                } catch {
                    // ignore
                }
                try {
                    (scrollRoot as any).scrollTop = initial;
                } catch {
                    // ignore
                }

                // Re-apply a couple times to beat post-layout adjustments.
                raf(() => {
                    try {
                        rawList?.scrollToOffset?.({ offset: initial, animated: false });
                    } catch {
                        // ignore
                    }
                    try {
                        (scrollRoot as any).scrollTop = initial;
                    } catch {
                        // ignore
                    }
                    raf(() => {
                        try {
                            rawList?.scrollToOffset?.({ offset: initial, animated: false });
                        } catch {
                            // ignore
                        }
                        try {
                            (scrollRoot as any).scrollTop = initial;
                        } catch {
                            // ignore
                        }
                    });
                });
            };

            tryApply();
        });
    }, [props.initialScrollTop, resolveWebScrollRoot]);

    React.useEffect(() => {
        return () => {
            props.onScrollTopChange?.(lastScrollTopRef.current);
        };
    }, [props.onScrollTopChange]);

    const preserveScrollOnToggleCollapsed = React.useCallback((path: string) => {
        const rawList: any = listRef.current as any;
        // FlashList caches row measurements; clear before expanding/collapsing highly variable diff rows.
        // This is especially important on web to avoid stale measurement artifacts, but it's safe to
        // call on all platforms.
        try {
            const clearLayoutCache = rawList?.clearLayoutCacheOnUpdate;
            if (typeof clearLayoutCache === 'function') {
                clearLayoutCache.call(rawList);
            }
        } catch {
            // ignore
        }

        toggleCollapsed(path);
    }, [toggleCollapsed]);

    const prefetch = useChangedFilesReviewPrefetch({
        sessionId,
        snapshotSignature,
        diffArea,
        rows,
        reviewFiles,
        isCollapsed,
        normalizeError: plugin.errorNormalizer,
        fallbackError,
        initialRequestedPaths,
    });

    const { getDiffState } = useChangedFilesReviewDiffLoading({
        sessionId,
        isRepo: Boolean(snapshot?.repo.isRepo),
        reviewFiles,
        diffArea,
        // Review is now virtualized, so we no longer force a "single-file" mode when thresholds are exceeded.
        // Render cost is bounded by virtualization; diff fetch is bounded via requestedPaths + cache/prefetch.
        tooLarge: false,
        selectedPath: '',
        snapshotSignature,
        diffCache: prefetch.prefetchEnabled ? scmDiffCache : null,
        requestedPaths: prefetch.requestedPaths ?? undefined,
        maxConcurrency: prefetch.maxDiffLoadConcurrency,
        minRefetchMs: diffAutoRefreshIntervalMs,
        refreshToken: diffRefreshToken,
        normalizeError: plugin.errorNormalizer,
        fallbackError,
    });

    const scrollToPath = React.useCallback((path: string) => {
        const index = pathToRowIndex.get(path);
        if (typeof index !== 'number') return;
        // On web, animated programmatic scrolls can trigger subtle event/restore-state glitches in
        // some browsers / RN-web stacks. Focus navigation should be deterministic, so keep it
        // non-animated on web.
        listRef.current?.scrollToIndex({ index, animated: Platform.OS !== 'web', viewPosition: 0 });
    }, [pathToRowIndex]);

    const highlightedPath = useChangedFilesReviewFocusPath({
        focusPath: typeof props.focusPath === 'string' ? props.focusPath : null,
        reviewFiles,
        expandPath,
        scrollToPath,
    });

    // Prefetch scheduling + viewability windowing is handled by useChangedFilesReviewPrefetch.

    // FlashList can aggressively recycle rows; ensure collapsed/expanded state is reflected by
    // baking it into the `data` items (in addition to `extraData`) so visible rows always update.
    const rowsWithViewState = React.useMemo(() => {
        if (collapsedPaths.size === 0) return rows;
        return rows.map((row) => {
            if (row.kind !== 'file') return row;
            const path = row.file.fullPath;
            const nextCollapsed = isCollapsed(path);
            if (row.collapsed === nextCollapsed) return row;
            return { ...row, collapsed: nextCollapsed };
        });
    }, [collapsedPaths, isCollapsed, rows]);

    const renderDiffBlock = useChangedFilesReviewDiffBlockRenderer({
        theme,
        sessionId,
        snapshotSignature,
        getDiffState,
        reviewCommentsEnabled,
        reviewCommentDrafts,
        onUpsertReviewCommentDraft: props.onUpsertReviewCommentDraft,
        onDeleteReviewCommentDraft: props.onDeleteReviewCommentDraft,
        onReviewCommentError: props.onReviewCommentError,
    });

    const onFilePressPinned = props.onFilePressPinned;
    const onToggleSelectionForFile = props.onToggleSelectionForFile;
    const renderFileActions = props.renderFileActions;
    const renderFileTrailingActions = props.renderFileTrailingActions;

    const ListHeaderComponent = React.useCallback(() => {
        return (
            <View>
                <ChangedFilesReviewDiffAreaSelector
                    theme={theme}
                    diffArea={diffArea}
                    availableModes={diffConfig.availableModes}
                    labels={diffConfig.labels}
                    onChange={setDiffArea}
                />

                {reviewFiles.length === 0 && (
                    <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 }}>
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {t('files.noChanges')}
                        </Text>
                    </View>
                )}

                {tooLarge && reviewFiles.length > 0 && (
                    <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {t('files.reviewLargeDiffOneAtATime')}
                        </Text>
                    </View>
                )}

                {changedFilesViewMode === 'session' && (
                    <View
                        style={{
                            backgroundColor: theme.colors.surfaceHigh,
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: theme.colors.divider,
                        }}
                    >
                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {attributionReliability === 'high'
                                ? t('files.attributionReliabilityHigh')
                                : t('files.attributionReliabilityLimited')}
                        </Text>
                        {suppressedInferredCount > 0 && (
                            <Text style={{ marginTop: 2, fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                                {t('files.inferredSuppressed', { count: suppressedInferredCount })}
                            </Text>
                        )}
                    </View>
                )}
            </View>
        );
    }, [
        attributionReliability,
        changedFilesViewMode,
        diffArea,
        diffConfig.availableModes,
        diffConfig.labels,
        diffConfig.defaultMode,
        reviewFiles.length,
        setDiffArea,
        suppressedInferredCount,
        theme.colors.divider,
        theme.colors.surfaceHigh,
        theme.colors.textSecondary,
        tooLarge,
    ]);

    const renderRow = React.useCallback(({ item, index }: { item: ChangedFilesReviewRow; index: number }) => {
        if (item.kind === 'section') {
            return (
                <ChangedFilesSectionHeader theme={theme} color={theme.colors.textSecondary}>
                    {item.title}
                </ChangedFilesSectionHeader>
            );
        }

        const file = item.file;
        const safePath = toTestIdSafeValue(file.fullPath);
        const collapsed = item.collapsed === true || isCollapsed(file.fullPath);
        const showDiff = !collapsed;
        const stopPropagationIfPossible = (event: unknown) => {
            const maybeEvent: any = event as any;
            try {
                maybeEvent?.stopPropagation?.();
            } catch {
                // ignore
            }
            try {
                // Some web event implementations can expose a `nativeEvent` getter that throws
                // (e.g. pooled events or cross-realm wrappers). Treat this as best-effort.
                maybeEvent?.nativeEvent?.stopPropagation?.();
            } catch {
                // ignore
            }
        };

        const openFileTestId = `scm-change-open-file-${safePath}`;
        const onOpenFile = (event: unknown) => {
            stopPropagationIfPossible(event);
            deferOnWeb(() => onFilePress(file));
        };
        const openFileButton =
            Platform.OS === 'web'
                ? (
                    <ViewWithClick
                        testID={openFileTestId}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.open')}
                        onClick={onOpenFile}
                        onKeyDown={(event: any) => {
                            const key = String(event?.key ?? '');
                            if (key !== 'Enter' && key !== ' ') return;
                            onOpenFile(event);
                        }}
                        tabIndex={0}
                        style={{ paddingHorizontal: 8, paddingVertical: 6 }}
                    >
                        <Octicons name="link-external" size={14} color={theme.colors.textSecondary} />
                    </ViewWithClick>
                )
                : (
                    <Pressable
                        testID={openFileTestId}
                        onPress={onOpenFile as any}
                        style={{ paddingHorizontal: 8, paddingVertical: 6 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.open')}
                    >
                        <Octicons name="link-external" size={14} color={theme.colors.textSecondary} />
                    </Pressable>
                );

        const rightElement = (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                {renderFileActions ? renderFileActions(file) : null}
                {renderFileTrailingActions ? renderFileTrailingActions(file) : null}
                {openFileButton}
            </View>
        );

        const next = rowsWithViewState[index + 1];
        const showDivider = next?.kind === 'file' && next.sectionKey === item.sectionKey;

        return (
            <View>
                <ScmChangeRow
                    theme={theme}
                    file={file}
                    density={rowDensity}
                    highlighted={highlightedPath === file.fullPath}
                    onPressPinned={
                        onFilePressPinned
                            ? () => deferOnWeb(() => onFilePressPinned(file))
                            : undefined
                    }
                    onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(file) : undefined}
                    trailingElement={rightElement}
                    showDivider={showDivider}
                    onPress={() => preserveScrollOnToggleCollapsed(file.fullPath)}
                />
                {showDiff && renderDiffBlock(file.fullPath)}
            </View>
        );
    }, [
        highlightedPath,
        isCollapsed,
        onFilePressPinned,
        onFilePress,
        onToggleSelectionForFile,
        preserveScrollOnToggleCollapsed,
        renderFileActions,
        renderFileTrailingActions,
        renderDiffBlock,
        rowDensity,
        rowsWithViewState,
        theme,
    ]);

      return (
	          <PierreScrollRootVirtualizerProvider>
	                <View style={{ flex: 1, minHeight: 0 }}>
	                <FlashList
	                    ref={listRef}
	                    testID="scm-review-list"
	                    style={
	                        Platform.OS === 'web'
	                            ? {
	                                flex: 1,
	                                minHeight: 0,
	                                // @ts-expect-error RN style types omit CSS `overflow-anchor`; required to disable browser scroll anchoring on web.
	                                overflowAnchor: 'none',
	                            }
	                            : { flex: 1, minHeight: 0 }
	                    }
	                    data={rowsWithViewState}
	                    keyExtractor={(item) => item.key}
	                    getItemType={(item) => item.kind}
	                    drawDistance={1200}
                    // FlashList memoizes row rendering; ensure UI state like collapsed paths triggers visible re-renders.
                    extraData={collapsedPaths}
                    onScroll={handleScroll}
                    onLayout={props.onLayout}
                    onContentSizeChange={props.onContentSizeChange}
                    onViewableItemsChanged={prefetch.onViewableItemsChanged}
                    renderItem={renderRow}
                    ListHeaderComponent={ListHeaderComponent}
                />
            </View>
        </PierreScrollRootVirtualizerProvider>
    );
}
