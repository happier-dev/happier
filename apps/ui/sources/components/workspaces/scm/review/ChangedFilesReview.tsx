import * as React from 'react';
import { Platform, Pressable, View, type ScrollViewProps } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionAttributedFile, SessionAttributionReliability, ChangedFilesViewMode } from '@/scm/scmAttribution';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import type { RepositoryCheckpointTurnMetadata, ScmDiffArea } from '@happier-dev/protocol';
import { useChangedFilesReviewDiffLoading } from '@/components/workspaces/scm/review/useChangedFilesReviewDiffLoading';
import { type ChangedFilesReviewRow } from '@/components/workspaces/scm/review/buildChangedFilesReviewRows';
import { useChangedFilesReviewPrefetch } from '@/components/workspaces/scm/review/useChangedFilesReviewPrefetch';
import { useChangedFilesReviewFocusPath } from '@/components/workspaces/scm/review/useChangedFilesReviewFocusPath';
import { entryToDelta, fileHasDeltaForArea, toAreaFileStatus, totalsChangedLines, type ScmEntryDelta } from '@/components/workspaces/scm/review/scmEntryDelta';
import { ChangedFilesSectionHeader } from '@/components/workspaces/scm/review/ChangedFilesSectionHeader';
import { ChangedFilesReviewDiffAreaSelector } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffAreaSelector';
import { useChangedFilesReviewDiffBlockRenderer } from '@/components/workspaces/scm/review/useChangedFilesReviewDiffBlockRenderer';
import { useInitialScrollRestore } from '@/components/workspaces/scm/review/useInitialScrollRestore';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { buildSnapshotSignature } from '@/scm/statusSync/projectState';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { resolveDefaultDiffModeForFile } from '@/scm/diff/defaultMode';
import { useSetting } from '@/sync/domains/state/storage';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { filterDirectoryLikeScmFileStatuses, isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import { DiffFilesListView, type DiffFilesListViewHandle } from '@/components/ui/code/diff/DiffFilesListView';
import { useScmDiffExpandedKeys } from '@/components/workspaces/scm/review/useScmDiffExpandedKeys';
import { useScmReviewViewabilityConfig } from '@/scm/review/useScmReviewViewabilityConfig';
import { resolveWebScrollableElement } from '@/components/ui/scroll/resolveWebScrollableElement';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';
import type { Theme } from '@/theme';
import { Icon } from '@/components/ui/icons/Icon';
import { preserveWebScrollAnchorAfterToggle } from './preserveWebScrollAnchorAfterToggle';

const ViewWithClick = View as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof View> & { onClick?: any; onKeyDown?: any; tabIndex?: number }
>;

const REVIEW_DIFF_LIST_DRAW_DISTANCE_MULTIPLIER = 0.75;

type ChangedFilesReviewTheme = Theme;

function resolveCheckpointAttributionCopy(metadata: RepositoryCheckpointTurnMetadata | null | undefined): string | null {
    if (!metadata) return null;
    if (metadata.contentConfidence === 'unavailable') return t('files.checkpointUnavailable');
    if (metadata.attributionScope === 'shared_worktree') return t('files.checkpointAttributionShared');
    return t('files.checkpointAttributionUnknown');
}

type ChangedFilesReviewProps = {
    theme: ChangedFilesReviewTheme;
    sessionId: string;
    snapshot: ScmWorkingSnapshot | null;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    turnAttributedFiles?: SessionAttributedFile[];
    turnAgentReportedFiles?: SessionAttributedFile[];
    turnCheckpointFiles?: SessionAttributedFile[];
    turnCheckpointMetadata?: RepositoryCheckpointTurnMetadata | null;
    turnRepositoryOnlyFiles?: ScmFileStatus[];
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
    providerDiffByPath?: ReadonlyMap<string, string> | null;
    reviewCommentsEnabled?: boolean;
    reviewCommentDrafts?: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
    onScroll?: ScrollViewProps['onScroll'];
    onLayout?: ScrollViewProps['onLayout'];
    onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
    workspaceScope?: WorkspaceScopeBase | null;
    fetchUnifiedDiffForPath?: ScmReviewUnifiedDiffFetcher;
};

function areChangedFilesReviewThemesEqual(
    a: ChangedFilesReviewTheme | null | undefined,
    b: ChangedFilesReviewTheme | null | undefined,
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
        a.colors.surface.inset === b.colors.surface.inset &&
        a.colors.border.default === b.colors.border.default &&
        a.colors.text.secondary === b.colors.text.secondary
    );
}

export function areChangedFilesReviewPropsEqual(
    previous: ChangedFilesReviewProps,
    next: ChangedFilesReviewProps,
): boolean {
    const previousKeys = Object.keys(previous) as Array<keyof ChangedFilesReviewProps>;
    const nextKeys = Object.keys(next) as Array<keyof ChangedFilesReviewProps>;
    if (previousKeys.length !== nextKeys.length) return false;
    for (const key of previousKeys) {
        if (!Object.prototype.hasOwnProperty.call(next, key)) return false;
        if (key === 'theme') {
            if (!areChangedFilesReviewThemesEqual(previous.theme, next.theme)) return false;
            continue;
        }
        if (!Object.is(previous[key], next[key])) return false;
    }
    return true;
}

function ChangedFilesReviewInner(props: ChangedFilesReviewProps) {
    const {
        theme,
        sessionId,
        snapshot,
        changedFilesViewMode,
        attributionReliability,
        allRepositoryChangedFiles,
        turnAttributedFiles = [],
        turnAgentReportedFiles = [],
        turnCheckpointFiles = [],
        turnCheckpointMetadata = null,
        sessionAttributedFiles,
        suppressedInferredCount,
        maxFiles,
        maxChangedLines,
        onFilePress,
        rowDensity = 'comfortable',
    } = props;
    const workspaceScope = props.workspaceScope ?? null;

    const plugin = React.useMemo(() => scmUiBackendRegistry.getPluginForSnapshot(snapshot), [snapshot]);
    const diffConfig = React.useMemo(() => plugin.diffModeConfig(snapshot), [plugin, snapshot]);
    const scmDefaultDiffModeByBackend = useSetting('scmDefaultDiffModeByBackend');
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    const showLineNumbers = useSetting('showLineNumbers');
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
    const effectiveWrapLines = wrapLinesInDiffs !== false;
    const effectiveShowLineNumbers = showLineNumbers !== false;

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
        const latestTurnFiles = turnAttributedFiles
            .filter((entry) => entry?.file && !isDirectoryLikeScmFileStatus(entry.file))
            .map((entry) => entry.file);
        const agentReportedTurnFiles = turnAgentReportedFiles
            .filter((entry) => entry?.file && !isDirectoryLikeScmFileStatus(entry.file))
            .map((entry) => entry.file);
        const checkpointTurnFiles = turnCheckpointFiles
            .filter((entry) => entry?.file && !isDirectoryLikeScmFileStatus(entry.file))
            .map((entry) => entry.file);
        const sessionChangedFiles = sessionAttributedFiles
            .filter((entry) => entry?.file && !isDirectoryLikeScmFileStatus(entry.file))
            .map((entry) => entry.file);

        if (changedFilesViewMode === 'repository') {
            return [
                {
                    key: 'repository',
                    kind: 'repository',
                    files: repositoryChangedFiles,
                },
            ] as const;
        }

        if (changedFilesViewMode === 'turn') {
            return [
                {
                    key: 'turn',
                    kind: 'turn',
                    files: latestTurnFiles,
                },
            ] as const;
        }

        if (changedFilesViewMode === 'turn_agent_reported') {
            return [
                {
                    key: 'turn_agent_reported',
                    kind: 'turn_agent_reported',
                    files: agentReportedTurnFiles,
                },
            ] as const;
        }

        if (changedFilesViewMode === 'turn_checkpoint') {
            return [
                {
                    key: 'turn_checkpoint',
                    kind: 'turn_checkpoint',
                    files: checkpointTurnFiles,
                },
            ] as const;
        }

        return [
            {
                key: 'session',
                kind: 'session',
                files: sessionChangedFiles,
            },
        ] as const;
    }, [
        allRepositoryChangedFiles,
        changedFilesViewMode,
        sessionAttributedFiles,
        turnAgentReportedFiles,
        turnAttributedFiles,
        turnCheckpointFiles,
    ]);

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
                const isUnmatchedTurnEvidence = delta === null
                    && (
                        section.kind === 'turn'
                        || section.kind === 'turn_agent_reported'
                        || section.kind === 'turn_checkpoint'
                    );
                if (!isUnmatchedTurnEvidence && !fileHasDeltaForArea(file, delta, diffArea)) continue;
                files.push(isUnmatchedTurnEvidence ? file : toAreaFileStatus(file, delta, diffArea));
            }

            if (section.kind === 'repository') {
                out.push({
                    key: section.key,
                    title: t('files.repositoryChangedFiles', { count: files.length }),
                    files,
                });
                continue;
            }
            if (section.kind === 'turn') {
                out.push({
                    key: section.key,
                    title: t('files.latestTurnChanges', { count: files.length }),
                    files,
                });
                continue;
            }
            if (section.kind === 'turn_agent_reported') {
                out.push({
                    key: section.key,
                    title: t('files.agentReportedTurnChanges', { count: files.length }),
                    files,
                });
                continue;
            }
            if (section.kind === 'turn_checkpoint') {
                out.push({
                    key: section.key,
                    title: t('files.checkpointTurnChanges', { count: files.length }),
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
            }
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
    const [viewableExpansionEnabled, setViewableExpansionEnabled] = React.useState(() => {
        return typeof props.initialScrollTop === 'number' && props.initialScrollTop > 2;
    });

    const snapshotSignature = React.useMemo(() => {
        if (!snapshot) return null;
        return buildSnapshotSignature(snapshot);
    }, [snapshot]);

    const collapsedKeysRef = React.useRef<ReadonlySet<string>>(new Set());
    const isCollapsed = React.useCallback((path: string) => collapsedKeysRef.current.has(path), []);

    const fallbackError = t('files.reviewDiffRequestFailed');
    const viewabilityConfig = useScmReviewViewabilityConfig();
    const tooLargeForExpansion = tooLarge && viewabilityConfig.enabled;

    const initialRequestedPaths = React.useMemo(() => {
        const count = tooLargeForExpansion
            ? Math.max(1, Math.min(
                reviewListFiles.length,
                viewabilityConfig.aheadCount + viewabilityConfig.behindCount + 1,
            ))
            : (tooLarge ? 1 : Math.max(1, Math.min(maxFiles, reviewListFiles.length)));
        const out: string[] = [];
        for (const file of reviewListFiles.slice(0, count)) {
            if (file?.fullPath) out.push(file.fullPath);
        }
        return out;
    }, [maxFiles, reviewListFiles, tooLarge, tooLargeForExpansion, viewabilityConfig.aheadCount, viewabilityConfig.behindCount]);

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
        fetchUnifiedDiffForPath: props.fetchUnifiedDiffForPath,
    });

    const { expandedKeys, collapsedKeys, toggleCollapsed } = useScmDiffExpandedKeys({
        allKeys,
        viewableIndices: prefetch.viewableRowIndices,
        tooLarge: tooLargeForExpansion,
        aheadCount: viewabilityConfig.aheadCount,
        behindCount: viewabilityConfig.behindCount,
        resetKey: `${sessionId}:${snapshotSignature ?? 'nosig'}:${diffArea}`,
        initialCollapsedKeys: props.initialCollapsedPaths ?? null,
        onCollapsedKeysChange: props.onCollapsedPathsChange,
        viewableExpansionEnabled,
    });

    React.useEffect(() => {
        collapsedKeysRef.current = collapsedKeys;
    }, [collapsedKeys]);

    const reportScrollTop = React.useCallback((nextTop: number) => {
        if (!Number.isFinite(nextTop)) return;
        lastScrollTopRef.current = nextTop;
        if (nextTop > 2) {
            setViewableExpansionEnabled((prev) => (prev ? prev : true));
        }
        props.onScrollTopChange?.(nextTop);
    }, [props.onScrollTopChange]);

    const scheduleWebFrame = React.useCallback((cb: FrameRequestCallback) => {
        if (typeof globalThis.requestAnimationFrame === 'function') {
            globalThis.requestAnimationFrame(cb);
            return;
        }
        globalThis.setTimeout(() => cb(Date.now()), 0);
    }, []);

    const webScrollRootRef = React.useRef<HTMLElement | null>(null);
    const resolveWebAnchorRow = React.useCallback((path: string): HTMLElement | null => {
        if (Platform.OS !== 'web') return null;
        const win = (globalThis as any).window as Window | undefined;
        const doc = win?.document as Document | undefined;
        if (!doc?.querySelector) return null;
        const safePath = toTestIdSafeValue(path);
        return (doc.querySelector(`[data-testid="scm-change-row-${safePath}"]`) as HTMLElement | null) ?? null;
    }, []);
    const readWebAnchorTop = React.useCallback((path: string): number | null => {
        const row = resolveWebAnchorRow(path) as any;
        const top = row?.getBoundingClientRect?.()?.top;
        return typeof top === 'number' && Number.isFinite(top) ? Number(top) : null;
    }, [resolveWebAnchorRow]);
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
        const rootCandidate: Element | null = (host as Element | null) ?? listHost;
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
        const fallback =
            host && typeof host.scrollTop === 'number'
                ? host
                : listHost && typeof (listHost as any).scrollTop === 'number'
                    ? listHost
                    : null;
        const scrollRoot = (resolved as any) ?? fallback;
        if (!scrollRoot) return null;

        disableOverflowAnchor(scrollRoot);
        webScrollRootRef.current = scrollRoot as any;
        return scrollRoot as any;
    }, []);

    const toggleCollapsedPreservingWebScroll = React.useCallback((path: string) => {
        if (Platform.OS !== 'web') {
            toggleCollapsed(path);
            return;
        }

        const scrollRoot = webScrollRootRef.current ?? resolveWebScrollRoot();
        const beforeTop =
            scrollRoot && typeof (scrollRoot as any).scrollTop === 'number'
                ? Number((scrollRoot as any).scrollTop)
                : null;
        const beforeAnchorTop = readWebAnchorTop(path);

        toggleCollapsed(path);

        if ((beforeTop === null || !Number.isFinite(beforeTop)) && beforeAnchorTop === null) return;

        const anchorY = beforeAnchorTop ?? beforeTop;
        if (anchorY === null || !Number.isFinite(anchorY)) return;
        preserveWebScrollAnchorAfterToggle({
            anchorY,
            requestFrame: scheduleWebFrame,
            readCurrentAnchor: () => {
                const currentRoot = webScrollRootRef.current ?? resolveWebScrollRoot();
                if (!currentRoot || typeof (currentRoot as any).scrollTop !== 'number') return null;
                const currentAnchorTop = beforeAnchorTop === null ? null : readWebAnchorTop(path);
                const currentY = currentAnchorTop ?? Number((currentRoot as any).scrollTop);
                return Number.isFinite(currentY)
                    ? { scrollRoot: currentRoot, anchorY: currentY }
                    : null;
            },
            onRestored: reportScrollTop,
        });
    }, [readWebAnchorTop, reportScrollTop, resolveWebScrollRoot, scheduleWebFrame, toggleCollapsed]);

    const expandPath = React.useCallback((path: string) => {
        if (!collapsedKeys.has(path)) return;
        toggleCollapsedPreservingWebScroll(path);
    }, [collapsedKeys, toggleCollapsedPreservingWebScroll]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        let cancelled = false;

        let attempts = 0;
        const maxAttempts = 12;
        const step = () => {
            if (cancelled) return;
            if (webScrollRootRef.current) return;
            resolveWebScrollRoot();
            attempts += 1;
            if (attempts >= maxAttempts) return;
            scheduleWebFrame(() => step());
        };
        scheduleWebFrame(() => step());
        return () => {
            cancelled = true;
            webScrollRootRef.current = null;
        };
    }, [resolveWebScrollRoot, scheduleWebFrame]);

    const handleScroll = React.useCallback((event: any) => {
        // Some virtualized-list implementations can invoke onScroll with non-standard shapes on web,
        // while scroll-edge consumers assume `event.nativeEvent` exists.
        if (event?.nativeEvent) {
            props.onScroll?.(event);
        }

        if (Platform.OS === 'web') {
            // Prefer DOM scrollTop over RN-web's sometimes-unreliable `contentOffset.y`.
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
                // virtualized-list events during early mount on web, do not override their position.
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

    const requestedDiffPaths = React.useMemo(() => {
        if (!tooLargeForExpansion) return prefetch.requestedPaths;

        const requested = new Set<string>();
        for (const path of prefetch.requestedPaths ?? []) {
            if (typeof path === 'string' && path.trim().length > 0) requested.add(path);
        }
        for (const path of prefetch.prefetchWindowPaths ?? []) {
            if (typeof path === 'string' && path.trim().length > 0) requested.add(path);
        }
        for (const path of expandedKeys) {
            if (typeof path === 'string' && path.trim().length > 0) requested.add(path);
        }

        const out: string[] = [];
        const seen = new Set<string>();
        for (const file of reviewListFiles) {
            const path = file?.fullPath;
            if (!path || seen.has(path) || !requested.has(path)) continue;
            seen.add(path);
            out.push(path);
        }
        if (out.length > 0) return out;

        const fallbackPath = prefetch.requestedPaths?.find((path) => (
            typeof path === 'string' && path.trim().length > 0
        ));
        return fallbackPath ? [fallbackPath] : prefetch.requestedPaths;
    }, [expandedKeys, prefetch.prefetchWindowPaths, prefetch.requestedPaths, reviewListFiles, tooLargeForExpansion]);

    const { diffStateSource } = useChangedFilesReviewDiffLoading({
        sessionId,
        isRepo: Boolean(snapshot?.repo.isRepo),
        reviewFiles: reviewListFiles,
        diffArea,
        tooLarge,
        selectedPath: '',
        snapshotSignature,
        diffCache: prefetch.prefetchEnabled ? scmDiffCache : null,
        requestedPaths: requestedDiffPaths ?? undefined,
        maxConcurrency: prefetch.maxDiffLoadConcurrency,
        minRefetchMs: diffAutoRefreshIntervalMs,
        refreshToken: diffRefreshToken,
        providerDiffByPath: props.providerDiffByPath,
        fetchUnifiedDiffForPath: props.fetchUnifiedDiffForPath,
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
        workspaceScope,
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

                {reviewFiles.length === 0 && !(changedFilesViewMode === 'turn_checkpoint' && turnCheckpointMetadata?.contentConfidence === 'unavailable') && (
                    <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 }}>
                        <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                            {t('files.noChanges')}
                        </Text>
                    </View>
                )}

                {tooLarge && reviewFiles.length > 0 && (
                    <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
                        <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                            {t('files.reviewLargeDiffOneAtATime')}
                        </Text>
                    </View>
                )}

                {(changedFilesViewMode === 'turn' || changedFilesViewMode === 'turn_checkpoint') && turnCheckpointMetadata && (
                    <View
                        style={{
                            backgroundColor: theme.colors.surface.inset,
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: theme.colors.border.default,
                        }}
                    >
                        <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                            {resolveCheckpointAttributionCopy(turnCheckpointMetadata)}
                        </Text>
                    </View>
                )}

                {changedFilesViewMode === 'session' && (
                    <View
                        style={{
                            backgroundColor: theme.colors.surface.inset,
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: theme.colors.border.default,
                        }}
                    >
                        <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                            {attributionReliability === 'high'
                                ? t('files.attributionReliabilityHigh')
                                : t('files.attributionReliabilityLimited')}
                        </Text>
                        {suppressedInferredCount > 0 && (
                            <Text style={{ marginTop: 2, fontSize: 11, color: theme.colors.text.secondary, ...Typography.default() }}>
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
        reviewFiles.length,
        setDiffArea,
        suppressedInferredCount,
        theme.colors.border.default,
        theme.colors.surface.inset,
        theme.colors.text.secondary,
        tooLarge,
        turnCheckpointMetadata,
    ]);

    const renderBeforeFileRow = React.useCallback(({ file }: Readonly<{ file: any; index: number }>) => {
        const title = sectionHeaderTitleByKey.get(file.key as string);
        if (!title) return null;
        return (
            <ChangedFilesSectionHeader theme={theme} color={theme.colors.text.secondary}>
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
                        <Icon name="arrow-square-out" size={14} color={theme.colors.text.secondary} />
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
                        <Icon name="arrow-square-out" size={14} color={theme.colors.text.secondary} />
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
                onToggleExpanded={toggleCollapsedPreservingWebScroll}
                canRenderInlineDiffs={true}
                wrapLines={effectiveWrapLines}
                showLineNumbers={effectiveShowLineNumbers}
                showPrefix={effectiveShowLineNumbers}
                virtualizeFileList
                drawDistanceMultiplier={REVIEW_DIFF_LIST_DRAW_DISTANCE_MULTIPLIER}
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

export const ChangedFilesReview = React.memo(ChangedFilesReviewInner, areChangedFilesReviewPropsEqual);
