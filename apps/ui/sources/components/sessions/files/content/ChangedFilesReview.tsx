import * as React from 'react';
import { Platform, Pressable, View, type ScrollViewProps } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionAttributedFile, SessionAttributionReliability, ChangedFilesViewMode } from '@/scm/scmAttribution';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import type { ScmDiffArea } from '@happier-dev/protocol';
import { useChangedFilesReviewDiffLoading } from '@/components/sessions/files/content/review/useChangedFilesReviewDiffLoading';
import { type ChangedFilesReviewRow } from '@/components/sessions/files/content/review/buildChangedFilesReviewRows';
import { useChangedFilesReviewPrefetch } from '@/components/sessions/files/content/review/useChangedFilesReviewPrefetch';
import { useChangedFilesReviewFocusPath } from '@/components/sessions/files/content/review/useChangedFilesReviewFocusPath';
import { entryToDelta, fileHasDeltaForArea, toAreaFileStatus, totalsChangedLines, type ScmEntryDelta } from '@/components/sessions/files/content/review/scmEntryDelta';
import { ChangedFilesSectionHeader } from '@/components/sessions/files/changedFiles/ChangedFilesSectionHeader';
import { ChangedFilesReviewDiffAreaSelector } from '@/components/sessions/files/content/review/ChangedFilesReviewDiffAreaSelector';
import { useChangedFilesReviewDiffBlockRenderer } from '@/components/sessions/files/content/review/useChangedFilesReviewDiffBlockRenderer';
import { useInitialScrollRestore } from '@/components/sessions/files/content/review/useInitialScrollRestore';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ScmChangeRow } from '@/components/sessions/sourceControl/changes/ScmChangeRow';
import { buildSnapshotSignature } from '@/scm/statusSync/projectState';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { resolveDefaultDiffModeForFile } from '@/scm/diff/defaultMode';
import { useSetting } from '@/sync/domains/state/storage';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { filterDirectoryLikeScmFileStatuses, isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import { DiffFilesListView, type DiffFilesListViewHandle } from '@/components/ui/code/diff/DiffFilesListView';
import { useScmDiffExpandedKeys } from '@/components/sessions/files/content/review/useScmDiffExpandedKeys';
import { useScmReviewViewabilityConfig } from '@/scm/review/useScmReviewViewabilityConfig';
import { resolveWebScrollableElement } from '@/components/ui/scroll/resolveWebScrollableElement';

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

    const reviewFileEntries = React.useMemo(() => {
        const out: Array<{
            key: string;
            sectionKey: string;
            sectionTitle: string;
            indexInSection: number;
            fileIndex: number;
            file: ScmFileStatus;
        }> = [];
        const seen = new Set<string>();
        let fileIndex = 0;
        for (const section of sections) {
            if (!section || section.files.length === 0) continue;
            for (let indexInSection = 0; indexInSection < section.files.length; indexInSection++) {
                const file = section.files[indexInSection];
                const path = file?.fullPath;
                if (!path) continue;
                if (seen.has(path)) continue;
                seen.add(path);
                out.push({
                    key: path,
                    sectionKey: section.key,
                    sectionTitle: section.title,
                    indexInSection,
                    fileIndex,
                    file,
                });
                fileIndex += 1;
            }
        }
        return out;
    }, [sections]);

    const sectionHeaderTitleByKey = React.useMemo(() => {
        const map = new Map<string, string>();
        for (const entry of reviewFileEntries) {
            if (entry.indexInSection !== 0) continue;
            map.set(entry.key, entry.sectionTitle);
        }
        return map;
    }, [reviewFileEntries]);

    const fileMetaByKey = React.useMemo(() => {
        const map = new Map<string, { file: ScmFileStatus; showDivider: boolean }>();
        for (let i = 0; i < reviewFileEntries.length; i++) {
            const entry = reviewFileEntries[i];
            const next = reviewFileEntries[i + 1];
            map.set(entry.key, { file: entry.file, showDivider: Boolean(next && next.sectionKey === entry.sectionKey) });
        }
        return map;
    }, [reviewFileEntries]);

    const reviewListFiles = React.useMemo(() => reviewFileEntries.map((entry) => entry.file), [reviewFileEntries]);

    const diffFiles = React.useMemo(() => {
        const mapKind = (status: ScmFileStatus['status']): 'new' | 'deleted' | 'renamed' | undefined => {
            if (status === 'added' || status === 'untracked') return 'new';
            if (status === 'deleted') return 'deleted';
            if (status === 'renamed') return 'renamed';
            return undefined;
        };
        return reviewFileEntries.map((entry) => ({
            key: entry.key,
            filePath: entry.key,
            added: typeof entry.file.linesAdded === 'number' ? entry.file.linesAdded : 0,
            removed: typeof entry.file.linesRemoved === 'number' ? entry.file.linesRemoved : 0,
            kind: mapKind(entry.file.status),
        }));
    }, [reviewFileEntries]);

    const allKeys = React.useMemo(() => diffFiles.map((f) => f.key), [diffFiles]);
    const pathToRowIndex = React.useMemo(() => {
        const map = new Map<string, number>();
        for (let i = 0; i < allKeys.length; i++) map.set(allKeys[i] as string, i);
        return map;
    }, [allKeys]);

    const listRef = React.useRef<DiffFilesListViewHandle | null>(null);
    const lastScrollTopRef = React.useRef<number>(typeof props.initialScrollTop === 'number' ? props.initialScrollTop : 0);

    const snapshotSignature = React.useMemo(() => {
        if (!snapshot) return null;
        return buildSnapshotSignature(snapshot);
    }, [snapshot]);

    const collapsedKeysRef = React.useRef<ReadonlySet<string>>(new Set());
    const isCollapsed = React.useCallback((path: string) => collapsedKeysRef.current.has(path), []);

    const fallbackError = t('files.reviewDiffRequestFailed');

    const initialRequestedPaths = React.useMemo(() => {
        const count = Math.max(1, Math.min(maxFiles, reviewListFiles.length));
        const out: string[] = [];
        for (const file of reviewListFiles.slice(0, count)) {
            if (file?.fullPath) out.push(file.fullPath);
        }
        return out;
    }, [maxFiles, reviewListFiles]);

    const prefetchRows = React.useMemo(() => {
        return reviewFileEntries.map((entry) => ({
            kind: 'file',
            key: `file:${entry.key}`,
            sectionKey: entry.sectionKey,
            indexInSection: entry.indexInSection,
            fileIndex: entry.fileIndex,
            file: entry.file,
        } satisfies ChangedFilesReviewRow));
    }, [reviewFileEntries]);

    const prefetch = useChangedFilesReviewPrefetch({
        sessionId,
        snapshotSignature,
        diffArea,
        rows: prefetchRows,
        reviewFiles: reviewListFiles,
        isCollapsed,
        normalizeError: plugin.errorNormalizer,
        fallbackError,
        initialRequestedPaths,
    });

    const viewabilityConfig = useScmReviewViewabilityConfig();
    const tooLargeForExpansion = tooLarge && viewabilityConfig.enabled;
    const { expandedKeys, collapsedKeys, toggleCollapsed } = useScmDiffExpandedKeys({
        allKeys,
        viewableIndices: prefetch.viewableRowIndices,
        tooLarge: tooLargeForExpansion,
        aheadCount: viewabilityConfig.aheadCount,
        behindCount: viewabilityConfig.behindCount,
        resetKey: `${sessionId}:${snapshotSignature ?? 'nosig'}:${diffArea}`,
        initialCollapsedKeys: props.initialCollapsedPaths ?? null,
        onCollapsedKeysChange: props.onCollapsedPathsChange,
    });

    React.useEffect(() => {
        collapsedKeysRef.current = collapsedKeys;
    }, [collapsedKeys]);

    const expandPath = React.useCallback((path: string) => {
        if (!collapsedKeys.has(path)) return;
        toggleCollapsed(path);
    }, [collapsedKeys, toggleCollapsed]);

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

        const win = (globalThis as any).window as Window | undefined;
        if (!win) return null;
        const doc = win.document as Document | undefined;
        const listHost = (doc?.querySelector?.('[data-testid="scm-review-list"]') as Element | null) ?? null;
        const rootCandidate: Element | null = listHost ?? (host as Element | null);
        if (!rootCandidate) return null;

        const disableOverflowAnchor = (el: any) => {
            try {
                el?.style?.setProperty?.('overflow-anchor', 'none');
            } catch {
                // ignore
            }
        };

        // Match our Playwright e2e helper semantics:
        // 1) Prefer host itself if scrollable.
        // 2) Otherwise prefer a nested scroll container inside the host.
        // 3) Fall back to ancestors.
        const resolved = resolveWebScrollableElement(rootCandidate as any, {
            win,
            pick: 'first',
            maxDescendants: 1200,
            maxAncestors: 40,
        });
        if (!resolved) return null;

        disableOverflowAnchor(resolved);
        webScrollRootRef.current = resolved as any;
        return resolved as any;
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

    useInitialScrollRestore({
        initialScrollTop: typeof props.initialScrollTop === 'number' ? props.initialScrollTop : null,
        latestScrollTopRef: lastScrollTopRef,
        applyInitialScrollTop: React.useCallback((initial) => {
            if (Platform.OS === 'web') {
                const scrollRoot = webScrollRootRef.current;
                const currentTop =
                    scrollRoot && typeof (scrollRoot as any).scrollTop === 'number' ? Number((scrollRoot as any).scrollTop) : null;
                const trackedTop = Number.isFinite(lastScrollTopRef.current) ? lastScrollTopRef.current : 0;
                // If the user has already scrolled but we haven't yet observed a stable scrollTop via
                // FlashList events (common during early mount on web), do not override their position.
                if (typeof currentTop === 'number' && currentTop > 0 && trackedTop <= 0) {
                    return true;
                }
            }

            const rawList: any = listRef.current as any;
            if (!rawList || typeof rawList.scrollToOffset !== 'function') return false;
            try {
                rawList.scrollToOffset({ offset: initial, animated: false });
            } catch {
                return false;
            }

            if (Platform.OS === 'web') {
                const scrollRoot = webScrollRootRef.current;
                if (scrollRoot && typeof (scrollRoot as any).scrollTop === 'number') {
                    try {
                        (scrollRoot as any).scrollTop = initial;
                    } catch {
                        // ignore
                    }
                }
            }

            return true;
        }, []),
    });

    React.useEffect(() => {
        return () => {
            props.onScrollTopChange?.(lastScrollTopRef.current);
        };
    }, [props.onScrollTopChange]);

    const { diffStateSource } = useChangedFilesReviewDiffLoading({
        sessionId,
        isRepo: Boolean(snapshot?.repo.isRepo),
        reviewFiles: reviewListFiles,
        diffArea,
        tooLarge,
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
        reviewFiles: reviewListFiles,
        expandPath,
        scrollToPath,
    });

    // Prefetch scheduling + viewability windowing is handled by useChangedFilesReviewPrefetch.

    const estimatedChangedLinesByPath = React.useMemo(() => {
        const map = new Map<string, number>();
        for (const file of reviewListFiles) {
            if (!file?.fullPath) continue;
            const added = typeof file.linesAdded === 'number' && Number.isFinite(file.linesAdded) ? file.linesAdded : 0;
            const removed = typeof file.linesRemoved === 'number' && Number.isFinite(file.linesRemoved) ? file.linesRemoved : 0;
            map.set(file.fullPath, Math.max(0, added) + Math.max(0, removed));
        }
        return map;
    }, [reviewListFiles]);
    const getEstimatedChangedLines = React.useCallback((path: string) => {
        return estimatedChangedLinesByPath.get(path) ?? null;
    }, [estimatedChangedLinesByPath]);

    const renderDiffBlock = useChangedFilesReviewDiffBlockRenderer({
        theme,
        sessionId,
        snapshotSignature,
        diffStateSource,
        getEstimatedChangedLines,
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

    const renderBeforeFileRow = React.useCallback(({ file }: Readonly<{ file: any; index: number }>) => {
        const title = sectionHeaderTitleByKey.get(file.key as string);
        if (!title) return null;
        return (
            <ChangedFilesSectionHeader theme={theme} color={theme.colors.textSecondary}>
                {title}
            </ChangedFilesSectionHeader>
        );
    }, [sectionHeaderTitleByKey, theme]);

    const renderFileRow = React.useCallback((params: any) => {
        const meta = fileMetaByKey.get(params.file.key as string);
        if (!meta) return null;
        const file = meta.file;
        const safePath = toTestIdSafeValue(file.fullPath);

        const stopPropagationIfPossible = (event: unknown) => {
            const maybeEvent: any = event as any;
            try { maybeEvent?.stopPropagation?.(); } catch {}
            try { maybeEvent?.nativeEvent?.stopPropagation?.(); } catch {}
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

        return (
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
                showDivider={meta.showDivider}
                onPress={params.onToggleExpanded}
            />
        );
    }, [
        fileMetaByKey,
        highlightedPath,
        onFilePressPinned,
        onFilePress,
        onToggleSelectionForFile,
        renderFileActions,
        renderFileTrailingActions,
        rowDensity,
        theme,
    ]);

    const renderInlineUnifiedDiff = React.useCallback(({ file }: any) => {
        const path = typeof file.filePath === 'string' ? file.filePath : String(file.key ?? '');
        return renderDiffBlock(path);
    }, [renderDiffBlock]);

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <DiffFilesListView
                ref={listRef as any}
                testID="scm-review-list"
                files={diffFiles as any}
                expandedKeys={expandedKeys}
                onToggleExpanded={toggleCollapsed}
                canRenderInlineDiffs={true}
                wrapLines={true}
                showLineNumbers={true}
                showPrefix={true}
                virtualizeFileList
                inlineDiffContainerVariant="none"
                renderBeforeFileRow={renderBeforeFileRow as any}
                renderFileRow={renderFileRow as any}
                renderInlineUnifiedDiff={renderInlineUnifiedDiff as any}
                ListHeaderComponent={ListHeaderComponent as any}
                onScroll={handleScroll}
                onLayout={props.onLayout as any}
                onContentSizeChange={props.onContentSizeChange as any}
                onViewableItemsChanged={prefetch.onViewableItemsChanged as any}
                scrollEventThrottle={16}
            />
        </View>
    );
}
