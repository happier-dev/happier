import type { CodeLinesExternalScrollView } from '@/components/ui/code/view/CodeLinesViewCore';
import * as React from 'react';
import { Platform, Pressable, View, type ScrollViewProps } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import {
    ChangedFileEvidenceDisclosure,
    checkpointAttributionDescription,
    sessionAttributedFileAccessibilityQualification,
} from '@/components/workspaces/scm/changes/ChangedFileEvidenceDisclosure';
import { Text } from '@/components/ui/text/Text';
import { ChangedFilesReviewNavigation } from './ChangedFilesReviewNavigation';
import { useChangedFilesReviewLineScroll } from './useChangedFilesReviewLineScroll';
import { Typography } from '@/constants/Typography';
import {
    filterPresentableSessionAttributedFiles,
    resolveChangedFilesEmptyStateTranslationKey,
    type SessionAttributedFile,
    type ChangedFilesViewMode,
} from '@/scm/scmAttribution';
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
import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';
import { ChangedFilesReviewDiffAreaSelector } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffAreaSelector';
import { useChangedFilesReviewDiffBlockRenderer } from '@/components/workspaces/scm/review/useChangedFilesReviewDiffBlockRenderer';
import { ScmComparisonBar } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { useInitialScrollRestore } from '@/components/workspaces/scm/review/useInitialScrollRestore';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { buildSnapshotSignature } from '@/scm/statusSync/projectState';
import { buildScmDiffSnapshotSignature } from '@/scm/diffCache/scmDiffCacheKey';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { resolveDefaultDiffModeForFile } from '@/scm/diff/defaultMode';
import { useSetting } from '@/sync/domains/state/storage';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { filterDirectoryLikeScmFileStatuses, isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import { DiffFilesListView, type DiffFilesListViewHandle } from '@/components/ui/code/diff/DiffFilesListView';
import { WrapLinesToggleButton } from '@/components/ui/code/WrapLinesToggleButton';
import { useScmDiffExpandedKeys } from '@/components/workspaces/scm/review/useScmDiffExpandedKeys';
import { useScmReviewViewabilityConfig } from '@/scm/review/useScmReviewViewabilityConfig';
import { resolveWebScrollableElement } from '@/components/ui/scroll/resolveWebScrollableElement';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';
import type { Theme } from '@/theme';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { preserveWebScrollAnchorAfterToggle } from './preserveWebScrollAnchorAfterToggle';
import { ChangedFilesReviewIndex } from './ChangedFilesReviewIndex';
import { ChangedFilesReviewPhoneFileControl } from './ChangedFilesReviewPhoneFileControl';
import { ChangedFilesReviewKeyboardShortcuts } from './ChangedFilesReviewKeyboardShortcuts';
import { ChangedFilesReviewMoreMenu } from './ChangedFilesReviewMoreMenu';
import { DiffFileActionsMenu } from '@/components/ui/code/diff/DiffFileActionsMenu';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { resolveScmChangePathTag } from '@/scm/scmChangePathTag';
import { publishActiveReviewFile, useActiveReviewFileRequest } from './activeReviewFile';
import { DetailsTabHeader, type DetailsTabHeaderMetaFact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { ToolbarSelect } from '@/components/ui/forms/ToolbarSelect';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { resolveScmDiffAreaLabels, resolveScmDiffAreaVocabulary } from '@/scm/diff/diffAreaLabels';
import { useChangedFilesReviewFind, type ReviewFindTarget } from './useChangedFilesReviewFind';
import { ChangedFilesReviewFindSurface, ChangedFilesReviewFindButton, ChangedFilesReviewFindCount } from './ChangedFilesReviewFind';

const ViewWithClick = View as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof View> & { onClick?: any; onKeyDown?: any; tabIndex?: number }
>;

const REVIEW_DIFF_LIST_DRAW_DISTANCE_MULTIPLIER = 0.75;
const NO_INDEX_FILES: readonly ScmFileStatus[] = [];
const NO_ATTRIBUTED_FILES: SessionAttributedFile[] = [];

export function resolveChangedFilesReviewCurrentWebScrollRoot<T>(params: Readonly<{
    resolveCurrent: () => T | null;
    retained: T | null;
}>): T | null {
    return params.resolveCurrent() ?? params.retained;
}

type ChangedFilesReviewTheme = Theme;

/** The source coverage of the files Review lists: how many, and their line totals when every file has them. */
export type ChangedFilesReviewCoverage = Readonly<{
    fileCount: number;
    added: number;
    removed: number;
    linesKnown: boolean;
}>;


type ChangedFilesReviewProps = {
    /** Captured endpoints: one fixed comparison, with no checkout file reads or mutation controls. */
    evidenceOnly?: boolean;
    toolbarLeading?: React.ReactNode;
    /**
     * Drawn as a Details tab (details lab 2, R1): the Review header with one honest count, then the
     * file list first, then the stream. Absent, the compact toolbar of an embedded list stays.
     */
    detailsHeader?: Readonly<{
        /** Whether a file goes in the next commit, when the Review owner has a commit selection. */
        isSelectedForCommit?: ((file: ScmFileStatus) => boolean) | null;
    }> | null;
    /** Room kept under the stream for a tray floating over its foot. */
    bottomInsetPx?: number;
    /**
     * A comparison view's chrome (Walkthrough lab WT8) in place of the Details header: one bar (the
     * caller's scope and actions around Review's own controls), an editorial header heading the
     * stream, and the file list as a left rail when there is room for it.
     */
    comparisonChrome?: Readonly<{
        /** Drawn from Review's own coverage, so the scope's count and the header's count are one number. */
        renderBarLeading: (coverage: ChangedFilesReviewCoverage) => React.ReactNode;
        barTrailing?: React.ReactNode;
        /** Narrow screens recompose the same toolbar into their standard navigation header. */
        renderBar?: (coverage: ChangedFilesReviewCoverage, displayActions: React.ReactNode) => React.ReactNode;
        renderHeader: (coverage: ChangedFilesReviewCoverage) => React.ReactNode;
        indexPlacement: 'rail' | 'stream' | 'phone';
        /** Where the files live, for the rail's tree (no listing is read). */
        rootPath?: string | null;
        /**
         * Files' Explain (lab WT8-F2): notes for a file's hunks, beside its diff when the rail has room and
         * above it otherwise. Null (or a null result) draws the diff alone.
         */
        renderFileNotes?: ((path: string, placement: 'column' | 'inline') => React.ReactNode) | null;
        /** Hunk-anchored Explain notes. File notes remain for evidence-availability notices. */
        renderHunkNotes?: ((path: string, hunkIndex: number, placement: 'column' | 'inline') => React.ReactNode) | null;
        hunkNotesColumnWidth?: number;
    }> | null;
    /**
     * The shared active-file scope (`activeReviewFile`): while `presented`, Review reports the file it
     * is on and brings a file a changed-files list asks for into view.
     */
    activeReviewFile?: Readonly<{ key: string; presented: boolean; externalLifecycle?: boolean }> | null;
    theme: ChangedFilesReviewTheme;
    sessionId?: string;
    /** Presentation/cache identity only. Workspace hosts always supply their Machine diff reader. */
    reviewScopeKey?: string;
    snapshot: ScmWorkingSnapshot | null;
    changedFilesViewMode: ChangedFilesViewMode;
    allRepositoryChangedFiles: ScmFileStatus[];
    turnAttributedFiles?: SessionAttributedFile[];
    turnAgentReportedFiles?: SessionAttributedFile[];
    turnCheckpointFiles?: SessionAttributedFile[];
    turnCheckpointMetadata?: RepositoryCheckpointTurnMetadata | null;
    turnRepositoryOnlyFiles?: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
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
    providerDiffByPath?: ReadonlyMap<string, string | null> | null;
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
} & (Readonly<{ sessionId: string }> | Readonly<{ reviewScopeKey: string; fetchUnifiedDiffForPath: ScmReviewUnifiedDiffFetcher }>);

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
        sessionId = '',
        snapshot,
        changedFilesViewMode,
            allRepositoryChangedFiles,
        turnAttributedFiles = NO_ATTRIBUTED_FILES,
        turnAgentReportedFiles = NO_ATTRIBUTED_FILES,
        turnCheckpointFiles = NO_ATTRIBUTED_FILES,
        turnCheckpointMetadata = null,
        sessionAttributedFiles,
            maxFiles,
        maxChangedLines,
        onFilePress,
        rowDensity = 'comfortable',
    } = props;
    const workspaceScope = props.workspaceScope ?? null;
    const reviewScopeKey = props.reviewScopeKey ?? sessionId;

    const plugin = React.useMemo(() => scmUiBackendRegistry.getPluginForSnapshot(snapshot), [snapshot]);
    const diffConfig = React.useMemo(() => plugin.diffModeConfig(snapshot), [plugin, snapshot]);
    const commitStrategySetting = useSetting('scmCommitStrategy');
    const diffAreaLabels = React.useMemo(() => resolveScmDiffAreaLabels(resolveScmDiffAreaVocabulary(
        commitStrategySetting === 'git_staging' ? 'git_staging' : 'atomic',
    )), [commitStrategySetting]);
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
    const [selectedDiffArea, setDiffAreaRaw] = React.useState<ScmDiffArea>(() => {
        return resolveDefaultDiffModeForFile({
            snapshot,
            backendOverrides: scmDefaultDiffModeByBackend as Record<string, ScmDiffArea> | undefined,
            hasIncludedDelta,
            hasPendingDelta,
        });
    });
    const diffArea: ScmDiffArea = props.evidenceOnly ? 'both' : selectedDiffArea;
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
        const latestTurnFiles = filterPresentableSessionAttributedFiles(turnAttributedFiles)
            .map((entry) => entry.file);
        const agentReportedTurnFiles = filterPresentableSessionAttributedFiles(turnAgentReportedFiles)
            .map((entry) => entry.file);
        const checkpointTurnFiles = filterPresentableSessionAttributedFiles(turnCheckpointFiles)
            .map((entry) => entry.file);
        const sessionChangedFiles = filterPresentableSessionAttributedFiles(sessionAttributedFiles)
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
                const isUnmatchedAttributedEvidence = delta === null
                    && (
                        section.kind === 'turn'
                        || section.kind === 'turn_agent_reported'
                        || section.kind === 'turn_checkpoint'
                        || section.kind === 'session'
                    );
                if (!isUnmatchedAttributedEvidence && !fileHasDeltaForArea(file, delta, diffArea)) continue;
                files.push(isUnmatchedAttributedEvidence ? file : toAreaFileStatus(file, delta, diffArea));
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
    const coverageFileCount = reviewListFiles.length;
    const coverageAdded = reviewListFiles.reduce((sum, file) => sum + Math.max(0, file.linesAdded ?? 0), 0);
    const coverageRemoved = reviewListFiles.reduce((sum, file) => sum + Math.max(0, file.linesRemoved ?? 0), 0);
    const coverageLinesKnown = reviewListFiles.every((file) => file.isComplete !== false);
    const coverage = React.useMemo<ChangedFilesReviewCoverage>(() => ({
        fileCount: coverageFileCount,
        added: coverageAdded,
        removed: coverageRemoved,
        linesKnown: coverageLinesKnown,
    }), [coverageAdded, coverageFileCount, coverageLinesKnown, coverageRemoved]);

    const diffFiles = React.useMemo(() => {
        const mapKind = (status: ScmFileStatus['status']): 'new' | 'deleted' | 'renamed' | undefined => {
            if (status === 'added' || status === 'untracked') return 'new';
            if (status === 'deleted') return 'deleted';
            if (status === 'renamed') return 'renamed';
            return undefined;
        };
        return reviewFileEntries.map((entry) => ({
            key: entry.key,
            isComplete: entry.file.isComplete,
            filePath: entry.key,
            added: typeof entry.file.linesAdded === 'number' ? entry.file.linesAdded : 0,
            removed: typeof entry.file.linesRemoved === 'number' ? entry.file.linesRemoved : 0,
            kind: mapKind(entry.file.status),
        }));
    }, [reviewFileEntries]);

    const allKeys = React.useMemo(() => diffFiles.map((f) => f.key), [diffFiles]);
    const binaryReviewPaths = React.useMemo(() => new Set(reviewFiles.filter((file) => file.isBinary === true).map((file) => file.fullPath)), [reviewFiles]);
    const reviewFind = useChangedFilesReviewFind();
    const findOpen = React.useSyncExternalStore(reviewFind.subscribe, () => reviewFind.getSnapshot().open);
    const [findTarget, setFindTarget] = React.useState<ReviewFindTarget | null>(null);
    const findSurfaceRef = React.useRef<View | null>(null);
    const findSurfaceInstance = React.useId();
    const findSurfaceId = `review:${reviewScopeKey}:${findSurfaceInstance}`;
    const pathToRowIndex = React.useMemo(() => {
        const map = new Map<string, number>();
        for (let i = 0; i < allKeys.length; i++) map.set(allKeys[i] as string, i);
        return map;
    }, [allKeys]);

    const listRef = React.useRef<DiffFilesListViewHandle | null>(null);
    // One list owns the scroll. The phone control follows its measured editorial header, then pins;
    // shared values keep scroll frames out of React and preserve this viewport across layout changes.
    const phoneScrollTop = useSharedValue(0);
    const phoneHeaderHeight = useSharedValue(0);
    const phoneControlHeight = useSharedValue(0);
    const phoneControlStyle = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(0, phoneHeaderHeight.value - phoneScrollTop.value) }] }));
    const phoneControlSpace = useAnimatedStyle(() => ({ height: phoneControlHeight.value }));
    const onPhoneHeaderLayout = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ height: number }> }> }>) => {
        phoneHeaderHeight.value = event.nativeEvent.layout.height;
    }, [phoneHeaderHeight]);
    const onPhoneControlLayout = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ height: number }> }> }>) => {
        phoneControlHeight.value = event.nativeEvent.layout.height;
    }, [phoneControlHeight]);
    const lastScrollTopRef = React.useRef<number>(typeof props.initialScrollTop === 'number' ? props.initialScrollTop : 0);
    const [viewableExpansionEnabled, setViewableExpansionEnabled] = React.useState(() => {
        return typeof props.initialScrollTop === 'number' && props.initialScrollTop > 2;
    });

    const snapshotShapeSignature = React.useMemo(() => snapshot ? buildSnapshotSignature(snapshot) : null, [snapshot]);
    const snapshotSignature = React.useMemo(() => {
        if (!snapshot) return null;
        // Captured bytes must never enter the working-copy diff cache under a status-only signature.
        if (props.evidenceOnly) return `comparison:${snapshot.projectKey}`;
        return buildScmDiffSnapshotSignature(snapshot, snapshotShapeSignature ?? undefined);
    }, [snapshot, snapshotShapeSignature, props.evidenceOnly]);

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

    // A comparison opens with lockfiles and generated output folded (lab WT8): listed and tagged, one tap
    // from their diff, never hidden. A person's own folding, once stored, wins.
    const comparisonDefaultCollapsedPaths = React.useMemo(() => (
        props.comparisonChrome
            ? reviewFiles.map((file) => file.fullPath).filter((path) => resolveScmChangePathTag(path) !== null)
            : null
    ), [props.comparisonChrome, reviewFiles]);
    const { expandedKeys, collapsedKeys, toggleCollapsed } = useScmDiffExpandedKeys({
        allKeys,
        viewableIndices: prefetch.viewableRowIndices,
        tooLarge: tooLargeForExpansion,
        aheadCount: viewabilityConfig.aheadCount,
        behindCount: viewabilityConfig.behindCount,
        resetKey: `${reviewScopeKey}:${snapshotShapeSignature ?? 'nosig'}:${diffArea}`,
        initialCollapsedKeys: props.initialCollapsedPaths ?? comparisonDefaultCollapsedPaths,
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

        const scrollRoot = resolveChangedFilesReviewCurrentWebScrollRoot({
            resolveCurrent: resolveWebScrollRoot,
            retained: webScrollRootRef.current,
        });
        const beforeTop =
            scrollRoot && typeof (scrollRoot as any).scrollTop === 'number'
                ? Number((scrollRoot as any).scrollTop)
                : null;
        const beforeAnchorTop = readWebAnchorTop(path);

        toggleCollapsed(path);

        if ((beforeTop === null || !Number.isFinite(beforeTop)) && beforeAnchorTop === null) return;

        const anchorY = beforeAnchorTop ?? (beforeTop === null ? null : -beforeTop);
        if (anchorY === null || !Number.isFinite(anchorY)) return;
        preserveWebScrollAnchorAfterToggle({
            anchorY,
            requestFrame: scheduleWebFrame,
            readCurrentAnchor: () => {
                const currentRoot = resolveChangedFilesReviewCurrentWebScrollRoot({
                    resolveCurrent: resolveWebScrollRoot,
                    retained: webScrollRootRef.current,
                });
                if (!currentRoot || typeof (currentRoot as any).scrollTop !== 'number') return null;
                const currentAnchorTop = beforeAnchorTop === null ? null : readWebAnchorTop(path);
                const currentY = beforeAnchorTop === null ? -Number((currentRoot as any).scrollTop) : currentAnchorTop;
                return typeof currentY === 'number' && Number.isFinite(currentY)
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

    // Once the file list has scrolled away, the header offers the jump menu in its place (SG).
    const indexHeightRef = React.useRef<number | null>(null);
    const [scrolledPastIndex, setScrolledPastIndex] = React.useState(false);
    const onIndexLayout = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ height: number }> }> }>) => {
        indexHeightRef.current = event.nativeEvent.layout.height;
    }, []);
    const trackIndexScroll = React.useCallback((top: number) => {
        const indexHeight = indexHeightRef.current;
        const past = indexHeight !== null && top > indexHeight;
        setScrolledPastIndex((current) => (current === past ? current : past));
    }, []);

    const handleScroll = React.useCallback((event: any) => {
        // Some virtualized-list implementations can invoke onScroll with non-standard shapes on web,
        // while scroll-edge consumers assume `event.nativeEvent` exists.
        if (event?.nativeEvent) {
            props.onScroll?.(event);
        }

        if (Platform.OS === 'web') {
            // Prefer DOM scrollTop over RN-web's sometimes-unreliable `contentOffset.y`.
            const scrollRoot = resolveChangedFilesReviewCurrentWebScrollRoot({
                resolveCurrent: resolveWebScrollRoot,
                retained: webScrollRootRef.current,
            });
            const current = scrollRoot && typeof (scrollRoot as any).scrollTop === 'number' ? (scrollRoot as any).scrollTop : null;
            if (typeof current === 'number') {
                phoneScrollTop.value = current;
                reportScrollTop(current);
                trackIndexScroll(current);
                return;
            }
        }

        const y = event?.nativeEvent?.contentOffset?.y;
        if (typeof y === 'number') {
            phoneScrollTop.value = y;
            reportScrollTop(y);
            trackIndexScroll(y);
        }
    }, [props.onScroll, reportScrollTop, resolveWebScrollRoot, trackIndexScroll, phoneScrollTop]);

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
        if (findOpen) return allKeys;
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
    }, [findOpen, allKeys, expandedKeys, prefetch.prefetchWindowPaths, prefetch.requestedPaths, reviewListFiles, tooLargeForExpansion]);

    const { diffStateSource } = useChangedFilesReviewDiffLoading({
        sessionId,
        reviewScopeKey,
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
        listRef.current?.scrollToIndex({ index, animated: Platform.OS !== 'web', viewPosition: 0,
            ...(props.comparisonChrome?.indexPlacement === 'phone' ? { viewOffset: phoneControlHeight.value } : null) });
    }, [pathToRowIndex, phoneControlHeight, props.comparisonChrome?.indexPlacement]);

    const navigationPaths = React.useMemo(() => reviewListFiles.map((file) => file.fullPath), [reviewListFiles]);
    const revealFindTarget = React.useCallback((target: ReviewFindTarget | null) => {
        setFindTarget((previous) => previous?.filePath === target?.filePath && previous?.lineId === target?.lineId ? previous : target);
        if (target) scrollToPath(target.filePath);
    }, [scrollToPath]);
    React.useEffect(() => reviewFind.connect({ paths: allKeys, binaryPaths: binaryReviewPaths, diffStateSource, reveal: revealFindTarget }),
        [reviewFind, allKeys, binaryReviewPaths, diffStateSource, revealFindTarget]);
    React.useEffect(() => { reviewFind.close(); }, [reviewFind, sessionId, changedFilesViewMode, diffArea]);
    React.useEffect(() => { if (props.activeReviewFile?.presented === false) reviewFind.close(); }, [reviewFind, props.activeReviewFile?.presented]);
    const findExpandedKeys = React.useMemo(() => findTarget && findOpen
        ? new Set([...expandedKeys, findTarget.filePath]) : expandedKeys, [expandedKeys, findTarget, findOpen]);
    const { highlightedPath, focus: focusReviewPath } = useChangedFilesReviewFocusPath({
        focusPath: props.focusPath ?? null,
        reviewFiles: reviewListFiles,
        expandPath,
        scrollToPath,
    });
    const [lineTarget, setLineTarget] = React.useState<Readonly<{ filePath: string; lineId: string }> | null>(null);
    React.useEffect(() => { setLineTarget(null); }, [sessionId, changedFilesViewMode, diffArea]);
    const visibleReviewPaths = React.useMemo(() => prefetch.viewableRowIndices.flatMap((index) => {
        const file = reviewListFiles[index];
        return file ? [file.fullPath] : [];
    }), [prefetch.viewableRowIndices, reviewListFiles]);
    const preferredReviewPath = findTarget?.filePath ?? lineTarget?.filePath ?? highlightedPath ?? props.focusPath ?? null;
    const activeReviewPath = preferredReviewPath && navigationPaths.includes(preferredReviewPath) && (visibleReviewPaths.length === 0 || visibleReviewPaths.includes(preferredReviewPath))
        ? preferredReviewPath
        : (visibleReviewPaths[0] ?? navigationPaths[0] ?? null);
    const expandReviewPathRef = React.useRef(expandPath);
    expandReviewPathRef.current = expandPath;
    const focusLine = React.useCallback((target: Readonly<{ filePath: string; lineId: string }> | null) => {
        if (target) {
            setFindTarget(null);
            expandReviewPathRef.current(target.filePath);
        }
        setLineTarget(target);
    }, []);
    const focusFile = React.useCallback((path: string) => {
        setFindTarget(null);
        setLineTarget(null);
        focusReviewPath(path);
    }, [focusReviewPath]);

    React.useEffect(() => {
        setLineTarget((current) => current && current.filePath !== activeReviewPath ? null : current);
    }, [activeReviewPath]);

    const activeReviewFileKey = props.activeReviewFile?.key ?? null;
    const activeReviewFilePresented = props.activeReviewFile?.presented === true;
    React.useEffect(() => {
        if (!activeReviewFileKey) return;
        publishActiveReviewFile(activeReviewFileKey, { presented: activeReviewFilePresented, activePath: activeReviewPath });
    }, [activeReviewFileKey, activeReviewFilePresented, activeReviewPath]);
    React.useEffect(() => () => {
        if (activeReviewFileKey && !props.activeReviewFile?.externalLifecycle) publishActiveReviewFile(activeReviewFileKey, { presented: false, activePath: null });
    }, [activeReviewFileKey, props.activeReviewFile?.externalLifecycle]);
    const activeReviewFileRequest = useActiveReviewFileRequest(activeReviewFileKey);
    const handledRequestNonceRef = React.useRef<number | null>(props.activeReviewFile?.externalLifecycle ? null : activeReviewFileRequest?.nonce ?? null);
    React.useEffect(() => {
        // The shared body first promotes a qualified request to its exact comparison.
        if (!activeReviewFileRequest || activeReviewFileRequest.comparison || !activeReviewFilePresented
            || handledRequestNonceRef.current === activeReviewFileRequest.nonce
            || !navigationPaths.includes(activeReviewFileRequest.path)) return;
        handledRequestNonceRef.current = activeReviewFileRequest.nonce;
        focusFile(activeReviewFileRequest.path);
    }, [activeReviewFileRequest, activeReviewFilePresented, focusFile, navigationPaths]);

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

    const reviewViewportRef = React.useRef<View | null>(null);
    const onScrollToLine = useChangedFilesReviewLineScroll({
        viewportRef: reviewViewportRef,
        listRef,
        scrollTopRef: lastScrollTopRef,
    });

    const externalScrollView = React.useMemo<CodeLinesExternalScrollView>(() => ({
        viewportRef: reviewViewportRef,
        offsetRef: lastScrollTopRef,
        scrollRef: { current: { scrollTo: ({ y, animated }) => {
            listRef.current?.scrollToOffset({ offset: y ?? 0, animated });
        } } },
    }), []);

    const hunkNotes = React.useMemo(() => props.comparisonChrome?.renderHunkNotes ? {
        placement: props.comparisonChrome.indexPlacement === 'rail' ? 'column' as const : 'inline' as const,
        columnWidth: props.comparisonChrome.hunkNotesColumnWidth ?? 0,
        render: props.comparisonChrome.renderHunkNotes,
    } : null, [props.comparisonChrome?.renderHunkNotes, props.comparisonChrome?.indexPlacement, props.comparisonChrome?.hunkNotesColumnWidth]);
    const renderDiffBlock = useChangedFilesReviewDiffBlockRenderer({
        hunkNotes,
        evidenceOnly: props.evidenceOnly,
        externalScrollView: Platform.OS === 'web' ? undefined : externalScrollView,
        onScrollToLine,
        lineTarget: findTarget ?? lineTarget,
        findModel: reviewFind,
        findActive: findOpen,
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
        flat: Boolean(props.comparisonChrome),
    });

    const onFilePressPinned = props.onFilePressPinned;
    const onToggleSelectionForFile = props.onToggleSelectionForFile;
    const renderFileActions = props.renderFileActions;
    const renderFileTrailingActions = props.renderFileTrailingActions;

    const detailsHeader = props.detailsHeader ?? null;
    const showIndex = detailsHeader !== null && !tooLarge && reviewListFiles.length > 0;
    // Only the index reads these, so a review drawn without it keeps a stable list header.
    const indexFiles = showIndex ? reviewListFiles : NO_INDEX_FILES;
    const indexDrafts = showIndex ? props.reviewCommentDrafts : undefined;
    const commentCountByPath = React.useMemo(() => {
        const counts = new Map<string, number>();
        for (const draft of indexDrafts ?? []) {
            counts.set(draft.filePath, (counts.get(draft.filePath) ?? 0) + 1);
        }
        return counts;
    }, [indexDrafts]);
    const indexRenderCommitToggle = showIndex ? props.renderFileActions ?? null : null;
    const onIndexFocusPath = focusFile;

    const comparisonChrome = props.comparisonChrome ?? null;
    const indexInRail = comparisonChrome?.indexPlacement === 'rail';
    const phoneFileControl = comparisonChrome?.indexPlacement === 'phone' && reviewListFiles.length > 0;
    const phoneHeaderSpaceStyle = phoneFileControl ? phoneControlSpace : null;
    const renderComparisonHeader = comparisonChrome?.renderHeader ?? null;
    const streamHeader = React.useMemo(
        () => (renderComparisonHeader ? renderComparisonHeader(coverage) : null),
        [coverage, renderComparisonHeader],
    );
    const ListHeaderComponent = React.useCallback(() => {
        return (
            <View>
                {phoneFileControl ? <><View onLayout={onPhoneHeaderLayout}>{streamHeader}</View><Animated.View style={phoneHeaderSpaceStyle} /></> : streamHeader}
                {showIndex && !indexInRail && !phoneFileControl ? (
                    <ChangedFilesReviewIndex
                        findModel={reviewFind}
                        files={indexFiles}
                        activePath={null}
                        commentCountByPath={commentCountByPath}
                        onFocusPath={onIndexFocusPath}
                        activeReviewFileKey={props.activeReviewFile?.key ?? null}
                        renderCommitToggle={indexRenderCommitToggle}
                        onLayout={onIndexLayout}
                        {...(comparisonChrome ? { placement: 'comparisonStream' as const, rootPath: comparisonChrome.rootPath ?? snapshot?.repo.rootPath ?? null } : null)}
                    />
                ) : null}
                {reviewFiles.length === 0 && !(changedFilesViewMode === 'turn_checkpoint' && turnCheckpointMetadata?.contentConfidence === 'unavailable') && (
                    <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 }}>
                        <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                            {t(resolveChangedFilesEmptyStateTranslationKey(changedFilesViewMode))}
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
                            {checkpointAttributionDescription(turnCheckpointMetadata)}
                        </Text>
                    </View>
                )}


            </View>
        );
    }, [
        changedFilesViewMode,
        diffArea,
        diffConfig.availableModes,
        diffAreaLabels,
        reviewFiles.length,
        setDiffArea,
        theme.colors.border.default,
        theme.colors.surface.inset,
        theme.colors.text.secondary,
        tooLarge,
        turnCheckpointMetadata,
        showIndex,
        indexFiles,
        commentCountByPath,
        showIndex ? onIndexFocusPath : null,
        indexRenderCommitToggle,
        onIndexLayout,
        props.activeReviewFile?.key,
        streamHeader,
        indexInRail,
        phoneFileControl,
        onPhoneHeaderLayout,
        phoneHeaderSpaceStyle,
        comparisonChrome,
        snapshot?.repo.rootPath,
    ]);

    const renderBeforeFileRow = React.useCallback(({ file }: Readonly<{ file: any; index: number }>) => {
        // A lone section is already named by the scope control (the toolbar menu or the comparison bar).
        if (changedFilesViewMode === 'repository' || ((props.toolbarLeading || comparisonChrome) && sectionHeaderTitleByKey.size === 1)) return null;
        const title = sectionHeaderTitleByKey.get(file.key as string);
        if (!title) return null;
        return (
            <ChangedFilesSectionHeader theme={theme} color={theme.colors.text.secondary}>
                {title}
            </ChangedFilesSectionHeader>
        );
    }, [changedFilesViewMode, comparisonChrome, props.toolbarLeading, sectionHeaderTitleByKey, theme]);

    const attributedEntriesByPath = React.useMemo(() => {
        const entries = changedFilesViewMode === 'session' ? sessionAttributedFiles
            : changedFilesViewMode === 'turn_agent_reported' ? turnAgentReportedFiles
            : changedFilesViewMode === 'turn_checkpoint' ? turnCheckpointFiles
            : changedFilesViewMode === 'turn' ? turnAttributedFiles : [];
        return new Map(entries.map((entry) => [entry.file.fullPath, entry]));
    }, [changedFilesViewMode, sessionAttributedFiles, turnAgentReportedFiles, turnCheckpointFiles, turnAttributedFiles]);

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
        const openFileButton = props.evidenceOnly ? null :
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
                <ChangedFilesReviewFindCount model={reviewFind} path={file.fullPath} />
                {renderFileActions ? renderFileActions(file) : null}
                {renderFileTrailingActions ? renderFileTrailingActions(file) : null}
                {openFileButton}
                {props.evidenceOnly ? null : <DiffFileActionsMenu filePath={file.fullPath} onOpenFile={() => deferOnWeb(() => onFilePress(file))} />}
            </View>
        );

        if (comparisonChrome) {
            // The comparison stream's file header (lab WT8): chevron, file icon, folder and name, counts,
            // then the file's controls. How the change was attributed stays one hover or focus away.
            const attributed = attributedEntriesByPath.get(file.fullPath);
            const qualification = attributed ? sessionAttributedFileAccessibilityQualification(attributed) : undefined;
            return (
                <ScmChangeRow
                    theme={theme}
                    file={file}
                    layout="inline"
                    density="compact"
                    showChangeMark={false}
                    tag={resolveScmChangePathTag(file.fullPath)}
                    accessibilityQualification={qualification}
                    highlighted={highlightedPath === file.fullPath}
                    leadingElement={(
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Icon name={params.expanded ? 'caret-down' : 'caret-right'} size={12} color={theme.colors.text.secondary} />
                            <FileIcon fileName={file.fileName} size={16} />
                        </View>
                    )}
                    trailingElement={(
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                            <ChangedFilesReviewFindCount model={reviewFind} path={file.fullPath} />
                            {qualification ? (
                                <Tooltip label={qualification} testID={`scm-review-attribution-${safePath}`}>
                                    <Icon name="info" size={14} color={theme.colors.text.tertiary} />
                                </Tooltip>
                            ) : null}
                            {renderFileActions ? renderFileActions(file) : null}
                            {renderFileTrailingActions ? renderFileTrailingActions(file) : null}
                            {props.evidenceOnly ? null : <DiffFileActionsMenu filePath={file.fullPath} onOpenFile={() => deferOnWeb(() => onFilePress(file))} />}
                        </View>
                    )}
                    onPressPinned={onFilePressPinned ? () => deferOnWeb(() => onFilePressPinned(file)) : undefined}
                    onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(file) : undefined}
                    showDivider={false}
                    onPress={params.onToggleExpanded}
                />
            );
        }

        return (
            <View>
            <ScmChangeRow
                theme={theme}
                file={file}
                layout="inline"
                showChangeMark={false}
                leadingElement={(
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Icon name={params.expanded ? 'caret-down' : 'caret-right'} size={12} color={theme.colors.text.secondary} />
                        <FileIcon fileName={file.fileName} size={16} appearance="line" />
                    </View>
                )}
                accessibilityQualification={attributedEntriesByPath.has(file.fullPath)
                    ? sessionAttributedFileAccessibilityQualification(attributedEntriesByPath.get(file.fullPath)!)
                    : undefined}
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
            {attributedEntriesByPath.has(file.fullPath) ? <ChangedFileEvidenceDisclosure entry={attributedEntriesByPath.get(file.fullPath)!} /> : null}
            </View>
        );
    }, [
        attributedEntriesByPath,
        fileMetaByKey,
        highlightedPath,
        onFilePressPinned,
        onFilePress,
        onToggleSelectionForFile,
        renderFileActions,
        renderFileTrailingActions,
        rowDensity,
        theme,
        comparisonChrome,
        props.evidenceOnly,
    ]);

    const renderFileNotes = props.comparisonChrome?.renderFileNotes ?? null;
    const notesPlacement = props.comparisonChrome?.indexPlacement === 'rail' ? 'column' as const : 'inline' as const;
    const renderInlineUnifiedDiff = React.useCallback(({ file }: any) => {
        const path = typeof file.filePath === 'string' ? file.filePath : String(file.key ?? '');
        const block = renderDiffBlock(path);
        const notes = renderFileNotes ? renderFileNotes(path, notesPlacement) : null;
        if (!notes) return block;
        if (notesPlacement === 'inline') return <View>{notes}{block}</View>;
        return (
            <View style={{ flexDirection: 'row' }}>
                <View style={{ flex: 1, minWidth: 0 }}>{block}</View>
                {notes}
            </View>
        );
    }, [notesPlacement, renderDiffBlock, renderFileNotes]);

    const reviewTotals = reviewListFiles.reduce(
        (sum, file) => ({
            added: sum.added + Math.max(0, file.linesAdded ?? 0),
            removed: sum.removed + Math.max(0, file.linesRemoved ?? 0),
        }),
        { added: 0, removed: 0 },
    );
    const reviewMeta: DetailsTabHeaderMetaFact[] = [
        { key: 'files', text: t('detailsSurface.review.files', { count: reviewFiles.length }), testID: 'scm-review-count-files' },
    ];
    if (reviewTotals.added > 0 || reviewTotals.removed > 0) {
        reviewMeta.push({ key: 'stat', kind: 'diffStat', added: reviewTotals.added, removed: reviewTotals.removed });
    }
    const isSelectedForCommit = detailsHeader?.isSelectedForCommit ?? null;
    const nextCommitCount = isSelectedForCommit ? reviewListFiles.filter((file) => isSelectedForCommit(file)).length : 0;
    if (nextCommitCount > 0) {
        reviewMeta.push({ key: 'commit', text: t('detailsSurface.review.nextCommit', { count: nextCommitCount }), testID: 'scm-review-count-commit' });
    }
    if (snapshot && typeof snapshot.fetchedAt === 'number' && snapshot.fetchedAt > 0) {
        reviewMeta.push({ key: 'asOf', text: t('surfaceState.asOf', { time: formatAsOfTime(snapshot.fetchedAt) }), tone: 'muted' });
    }
    const activeIndex = activeReviewPath ? navigationPaths.indexOf(activeReviewPath) : -1;
    const jumpItems = navigationPaths.map((path, index) => ({
        id: path,
        title: `${index + 1} / ${navigationPaths.length}  ${path.split('/').pop() ?? path}`,
    }));
    const chromeStyles = changedFilesReviewChromeStyles(theme);
    // With the file list in a rail it never scrolls away, so the jump menu is only for the stream list.
    const showJump = navigationPaths.length > 1 && (!showIndex || (!indexInRail && scrolledPastIndex));

    const reviewDisplayActions = (
        <>
            <ChangedFilesReviewFindButton surfaceId={findSurfaceId} />
            {Platform.OS === 'web' ? <DiffPresentationStyleToggleButton size={16} presentation="segmented" /> : null}
            <WrapLinesToggleButton />
            {tooLarge && reviewFiles.length > 0 ? (
                <Tooltip label={t('files.reviewLargeDiffOneAtATime')} testID="scm-review-large-diff-info" style={{ width: Platform.OS === 'web' ? 28 : 48, height: Platform.OS === 'web' ? 28 : 48, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="info" size={16} color={theme.colors.text.secondary} />
                </Tooltip>
            ) : null}
        </>
    );
    const reviewNavigationControls = (
        <>
            {props.evidenceOnly ? null : <ChangedFilesReviewDiffAreaSelector
                theme={theme}
                diffArea={diffArea}
                availableModes={diffConfig.availableModes}
                labels={diffAreaLabels}
                onChange={setDiffArea}
                inline
            />}
            {showJump ? (
                <ToolbarSelect
                    testID="scm-review-jump"
                    label={t('detailsSurface.review.jumpA11y')}
                    items={jumpItems}
                    selectedId={activeIndex >= 0 ? navigationPaths[activeIndex] : navigationPaths[0] ?? null}
                    onSelect={focusFile}
                />
            ) : null}
            <ChangedFilesReviewNavigation
                paths={navigationPaths}
                activePath={activeReviewPath}
                onFocusPath={focusFile}
                diffStateSource={diffStateSource}
                onFocusLine={focusLine}
            />
        </>
    );

    // The comparison bar holds only the lab's controls (WT8): the scope, its actions and a ⋯ with Review's
    // display choices; moving between files and changes is J / K / N (hinted in the rail).
    const comparisonDisplayActions = <><ChangedFilesReviewFindButton surfaceId={findSurfaceId} /><ChangedFilesReviewMoreMenu diffArea={diffArea} availableDiffAreas={diffConfig.availableModes}
        diffAreaLabels={diffAreaLabels} onDiffArea={setDiffArea} /></>;
    const comparisonKeyboardShortcuts = <ChangedFilesReviewKeyboardShortcuts enabled={props.activeReviewFile?.presented !== false}
        paths={navigationPaths} activePath={activeReviewPath} onFocusPath={focusFile} diffStateSource={diffStateSource} onFocusLine={focusLine} />;
    const detailsHeaderElement = comparisonChrome?.renderBar ? <>
        {comparisonChrome.renderBar(coverage, comparisonDisplayActions)}
        {comparisonKeyboardShortcuts}
    </> : comparisonChrome ? (
        <ScmComparisonBar
            leading={comparisonChrome.renderBarLeading(coverage)}
            trailing={(
                <>
                    {comparisonChrome.barTrailing ?? null}
                    {comparisonDisplayActions}
                </>
            )}
        >
            {comparisonKeyboardShortcuts}
        </ScmComparisonBar>
    ) : detailsHeader ? (
        <DetailsTabHeader
            testID="scm-review-header"
            title={t('detailsSurface.review.title')}
            leading={<Icon name="file-text" size={20} color={theme.colors.text.secondary} />}
            meta={reviewMeta}
            actions={(
                <View testID="scm-review-toolbar" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {props.toolbarLeading}
                    {reviewDisplayActions}
                </View>
            )}
            controls={reviewNavigationControls}
            menu={<ChangedFilesReviewMoreMenu diffArea={diffArea} availableDiffAreas={diffConfig.availableModes} diffAreaLabels={diffAreaLabels} onDiffArea={setDiffArea} />}
        />
    ) : null;

    return (
        <View ref={findSurfaceRef} collapsable={false} style={{ flex: 1, minHeight: 0 }}>
            {detailsHeaderElement ?? (
            <HorizontalScrollableRow testID="scm-review-toolbar" fadeColor={theme.colors.surface.base ?? theme.colors.surface.inset} indicatorColor={theme.colors.text.secondary} containerStyle={{ flexGrow: 0, flexShrink: 0 }} contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 4 }}>
                {props.toolbarLeading}
                <ChangedFilesReviewFindButton surfaceId={findSurfaceId} />
                {props.evidenceOnly ? null : <ChangedFilesReviewDiffAreaSelector
                    theme={theme}
                    diffArea={diffArea}
                    availableModes={diffConfig.availableModes}
                    labels={diffAreaLabels}
                    onChange={setDiffArea}
                    inline
                />}

            <ChangedFilesReviewNavigation
                paths={navigationPaths}
                activePath={activeReviewPath}
                onFocusPath={focusFile}
                diffStateSource={diffStateSource}
                onFocusLine={focusLine}
            />
                <WrapLinesToggleButton />
                {tooLarge && reviewFiles.length > 0 ? (
                    <Tooltip label={t('files.reviewLargeDiffOneAtATime')} testID="scm-review-large-diff-info" style={{ width: Platform.OS === 'web' ? 28 : 48, height: Platform.OS === 'web' ? 28 : 48, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="info" size={16} color={theme.colors.text.secondary} />
                    </Tooltip>
                ) : null}
            </HorizontalScrollableRow>
            )}
            <View style={{ flex: 1, minHeight: 0, flexDirection: indexInRail && showIndex ? 'row' : 'column' }}>
            {indexInRail && showIndex ? (
                <View testID="scm-comparison-rail" style={chromeStyles.rail}>
                    <ChangedFilesReviewIndex
                        findModel={reviewFind}
                        files={indexFiles}
                        activePath={null}
                        commentCountByPath={commentCountByPath}
                        onFocusPath={onIndexFocusPath}
                        activeReviewFileKey={props.activeReviewFile?.key ?? null}
                        renderCommitToggle={indexRenderCommitToggle}
                        placement="rail"
                        rootPath={comparisonChrome?.rootPath ?? snapshot?.repo.rootPath ?? null}
                    />
                </View>
            ) : null}
            <View ref={reviewViewportRef} collapsable={false} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <DiffFilesListView
                    ref={listRef as any}
                    testID="scm-review-list"
                    files={diffFiles as any}
                    expandedKeys={findExpandedKeys}
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
                    ListFooterComponent={props.bottomInsetPx ? (() => <View style={{ height: props.bottomInsetPx }} />) as any : undefined}
                    onScroll={handleScroll}
                    onLayout={props.onLayout as any}
                    onContentSizeChange={props.onContentSizeChange as any}
                    onViewableItemsChanged={prefetch.onViewableItemsChanged as any}
                    scrollEventThrottle={16}
                />
                {phoneFileControl ? <Animated.View testID="scm-comparison-file-sticky" onLayout={onPhoneControlLayout}
                    style={[{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 }, phoneControlStyle]}>
                    <ChangedFilesReviewPhoneFileControl files={reviewListFiles} activePath={activeReviewPath}
                        findModel={reviewFind}
                        rootPath={comparisonChrome?.rootPath ?? snapshot?.repo.rootPath ?? null}
                        commentCountByPath={commentCountByPath} onFocusPath={focusFile} />
                </Animated.View> : null}
            </View>
            </View>
            <ChangedFilesReviewFindSurface model={reviewFind} surfaceId={findSurfaceId} surfaceRef={findSurfaceRef}
                presented={props.activeReviewFile?.presented !== false} />
        </View>
    );
}

/** The comparison chrome's geometry; colours come from the theme. */
function changedFilesReviewChromeStyles(theme: ChangedFilesReviewTheme) {
    return {
        rail: {
            width: CHANGED_FILES_REVIEW_RAIL_WIDTH_PX,
            borderRightWidth: Platform.select({ ios: 0.33, default: 1 }),
            borderRightColor: theme.colors.border.default,
        },
    };
}

/** The comparison view's file rail (lab WT8: about a third of a desktop details column). */
export const CHANGED_FILES_REVIEW_RAIL_WIDTH_PX = 300;

export const ChangedFilesReview = React.memo(ChangedFilesReviewInner, areChangedFilesReviewPropsEqual);
