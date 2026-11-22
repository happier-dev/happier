import { FilesystemTreeRowActive, useFilesystemTreeKeyboard } from '@/components/ui/filesystemBrowser/useFilesystemTreeKeyboard';
import { useFilesystemTreeScrollAnchor } from '@/components/ui/filesystemBrowser/useFilesystemTreeScrollAnchor';
import { DiffStat } from '@/components/workspaces/scm/DiffStat';
import * as React from 'react';
import { Platform, View, type ScrollViewProps } from 'react-native';
import type { useUnistyles } from 'react-native-unistyles';

import { FilesystemBrowser } from '@/components/ui/filesystemBrowser/FilesystemBrowser';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { FilesystemBrowserRow, type FilesystemBrowserRowActionsControl } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import type { FilesystemBrowserRowRenderInput } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWorkspaceRepositoryTreeBrowser } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser';
import { RepositoryTreeRootErrorState } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRootErrorState';
import { MANAGED_POWER_REQUIRED, ManagedWorkspaceStoppedState } from '@/components/workspaces/reachability/ManagedWorkspaceStoppedState';
import { t } from '@/text';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useScmTreeBadgeIndex } from '@/components/workspaces/files/repositoryTree/useScmTreeBadgeIndex';
import { buildScmTreeBadgeSignature } from '@/components/workspaces/files/repositoryTree/scmTreeBadges';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import type { RepositoryFileDropTarget } from '@/components/workspaces/files/repositoryTree/repositoryFileDropTarget';
import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import Reanimated, { FadeIn } from 'react-native-reanimated';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLiveFileWriteAgentLabels } from '@/components/workspaces/files/useWorkspaceFileWriteTabPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { HAPPIER_TREE_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { SelectionCheckState } from '@/components/ui/selection/SelectionCheckGlyph';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { buildChangedOnlyTreeNodes } from '@/components/workspaces/files/repositoryTree/buildChangedFilesOutlineTree';
import { resolveScmChangeToneColor, resolveScmChangeToneForCode } from '@/scm/scmChangeKind';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { ScmChangeMark } from '@/components/workspaces/scm/changes/ScmChangeMark';
import { resolveScmChangePathTag } from '@/scm/scmChangePathTag';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

export type WorkspaceRepositoryTreeWebDropTarget = RepositoryFileDropTarget;
export type WorkspaceRepositoryDirectoryState = Readonly<{ loaded: boolean; loading: boolean; error: string | null }>;

type WorkspaceRepositoryTreeNode = LazyDirectoryTreeNode;

/**
 * A controlled checkbox per row. `revision` must change whenever any row's state changes, so mounted
 * (virtualized) rows redraw; `getState` answers per row (a folder may be `mixed`).
 */
export type WorkspaceRepositoryTreeRowProposal = Readonly<{
    paths: ReadonlySet<string>;
    notes: ReadonlyMap<string, string>;
    /** Changes whenever the proposal's paths or notes change (mounted rows redraw on it). */
    revision: string;
}>;

function proposalEmphasisOf(proposal: WorkspaceRepositoryTreeRowProposal, node: WorkspaceRepositoryTreeNode): 'in' | 'out' {
    if (node.type === 'directory') {
        const prefix = `${node.path}/`;
        for (const path of proposal.paths) if (path.startsWith(prefix)) return 'in';
        return 'out';
    }
    return proposal.paths.has(node.path) ? 'in' : 'out';
}

export type WorkspaceRepositoryTreeRowSelection = Readonly<{
    revision: string | number;
    getState: (node: WorkspaceRepositoryTreeNode) => SelectionCheckState;
    onToggle: (node: WorkspaceRepositoryTreeNode) => void;
    accessibilityLabel: (node: WorkspaceRepositoryTreeNode) => string;
    isDisabled?: (node: WorkspaceRepositoryTreeNode) => boolean;
    isSelectable?: (node: WorkspaceRepositoryTreeNode) => boolean;
}>;

type AppTheme = ReturnType<typeof useUnistyles>['theme'];

type WorkspaceRepositoryTreeListProps = Readonly<{
    theme: AppTheme;
    /** Inline search replaces the rows while the canonical directory controller keeps reconciling. */
    visible?: boolean;
    /** The workspace, as one identity: what the tree is keyed by AND read through. */
    scope: WorkspaceScopeBase;
    reloadToken?: number;
    reconciliationPaused?: boolean;
    detailsMode?: boolean;
    visibilityMode?: 'project' | 'all';
    revealedPaths?: readonly string[];
    revealRequest?: Readonly<{ path: string }>;
    onGitIgnoreAvailableChange?: (available: boolean | undefined) => void;
    onRequestRefresh?: (() => void) | null;
    onRequestDownload?: ((params: Readonly<{ path: string; asZip: boolean }>) => Promise<{ ok: true } | { ok: false; error: string }>) | null;
    webFileDropEnabled?: boolean;
    webDropHoverPath?: string | null;
    expandedPaths: readonly string[];
    onExpandedPathsChange: (paths: string[]) => void;
    onOpenFile: (fullPath: string) => void;
    fileHref?: (fullPath: string) => string | null;
    onOpenFilePinned?: (fullPath: string) => void;
    scmSnapshot?: ScmWorkingSnapshot | null;
    /** Trailing per-row actions; the row reveals them (hover/focus/selected; long press on touch). */
    renderRowActions?: ((node: WorkspaceRepositoryTreeNode, control: FilesystemBrowserRowActionsControl) => React.ReactNode) | null;
    /** Permanent trailing metadata, visible without hover or opening the row's actions. */
    renderRowMetadata?: ((node: WorkspaceRepositoryTreeNode) => React.ReactNode) | null;
    /** A second line under the name (a Code folder page on a phone: the entry's latest commit subject). */
    renderRowSubtitle?: ((node: WorkspaceRepositoryTreeNode) => React.ReactNode) | null;
    showInlineLoadingHeader?: boolean;
    /**
     * A reload of a root already listed (a refresh): the toolbar's View menu shows it. The first load is the
     * body's own loading state, so the toolbar keeps its controls as they will stay.
     */
    onRootLoadingChange?: (loading: boolean) => void;
    /**
     * Changed only (session tabs lab FC): the same tree pruned to the changed files
     * (`selectScmChangedFiles`), folders open, single-child folder chains as one row.
     */
    changedOnly?: boolean;
    preferredChangedPaths?: ReadonlySet<string>;
    /** Changed only has nothing to show: the one way back to every file. */
    onShowAllFiles?: (() => void) | null;
    /** The file open in Details: its row stays selected (lab F1). */
    selectedPath?: string | null;
    /** The folder the tree starts at (a Code folder page); the repository root by default. */
    rootDirectoryPath?: string;
    /**
     * A Code folder page (plan 13 §2, lab p-code BROWSE): the rows are a table, a folder's name goes
     * into that folder's page, and its chevron alone opens it in place.
     */
    folderPage?: Readonly<{ onOpenFolder: (path: string) => void }> | null;
    /** What an empty folder says (default: the project's empty-files line). */
    emptyLabel?: string;
    /** Loaded rows, used for directory facts such as README discovery and entry count. */
    onNodesChange?: ((nodes: readonly WorkspaceRepositoryTreeNode[], directory: WorkspaceRepositoryDirectoryState) => void) | null;
    /** Rows in the list's current viewport; history demand follows this boundary. */
    onVisibleNodesChange?: ((nodes: readonly WorkspaceRepositoryTreeNode[]) => void) | null;
    /** The machine the files live on, named by the root failure. */
    machineName?: string | null;
    /**
     * The leading control. Omitted: each row shows its entry icon. Given: each row shows a checkbox the
     * consumer controls (the Git changed-files tree). Trailing per-row actions stay `renderRowActions`.
     */
    rowSelection?: WorkspaceRepositoryTreeRowSelection | null;
    /**
     * A selected commit proposal over the tree (Walkthrough lab WT4-C2), the same view state as the list's
     * rows: its files take the accent rule and tint with the part they hold ("2 of 3 changes"), folders that
     * hold none of them and every other file dim. Never a selection; the checkboxes keep their meaning.
     */
    rowProposal?: WorkspaceRepositoryTreeRowProposal | null;
    /**
     * Read the folder listing under Changed only (default): Files keeps it warm for its way back to every
     * file. The Git tree has no way back and shows only changes, so it asks the machine for nothing.
     */
    directoryListing?: boolean;
    /** A qualified target is unavailable; cached rows remain usable, but an empty read is not an empty folder. */
    directoryUnavailable?: boolean;
    /** Drawn after the last row, in the tree's own scroll. */
    listFooter?: React.ReactElement | null;
    listHeader?: React.ReactElement | null;
    listEmpty?: React.ReactElement | null;
    /** `inline`: rows drawn in place inside an enclosing scroll (a turn card), see `FilesystemBrowserListProps`. */
    presentation?: 'scroll' | 'inline';
    /** A preview of the folder (the Overview Code widget): at most this many rows are drawn; counts still see every entry. */
    maxRows?: number | null;
    /** Changed only: the folders that start closed (a large turn opens as one page of folders). */
    initialClosedChangedPaths?: ReadonlySet<string>;
    /**
     * Changed only. `files` (default): the Files tree's rows. `changes`: rows of a change list (a turn,
     * a comparison rail): a file's Git letter in the icon slot and its evidence class ("Lockfile") before
     * its counts; a folder's file count beside its name and its added/removed totals at the end.
     */
    rowStyle?: 'files' | 'changes';
    onLayout?: ScrollViewProps['onLayout'];
    onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
    onScroll?: ScrollViewProps['onScroll'];
    scrollEventThrottle?: number;
}>;

function isDirectoryNode(node: { type: WorkspaceRepositoryTreeNode['type'] }): boolean {
    return node.type === 'directory';
}

function buildWebDropTarget(node: WorkspaceRepositoryTreeNode): WorkspaceRepositoryTreeWebDropTarget {
    if (node.type === 'directory') {
        return {
            destinationDir: node.path,
            hoverPath: node.path,
            autoExpandDirectoryPath: !node.isExpanded && !node.isLoadingChildren ? node.path : null,
        };
    }
    return {
        destinationDir: node.parentDirectoryPath ?? '',
        hoverPath: node.path,
        autoExpandDirectoryPath: null,
    };
}

const NO_CHANGED_FILES: readonly never[] = [];
const NO_CLOSED_PATHS: ReadonlySet<string> = new Set();


/** A change list labels lockfiles and generated output where they appear (the shared path classifier). */
/**
 * The open file's mark is read per row: opening a file redraws the previous and the new row, not every
 * mounted row through the list's shared `extraData`.
 */
function RepositoryTreeRowSelection(props: Readonly<{
    store: StoreApi<string | null>;
    path: string | null;
    children: (selected: boolean) => React.ReactElement;
}>): React.ReactElement {
    const { store, path } = props;
    const selected = React.useSyncExternalStore(store.subscribe,
        () => path !== null && store.getState() === path, () => false);
    return props.children(selected);
}

function ScmChangePathTag(props: Readonly<{ path: string; theme: AppTheme }>) {
    const label = resolveScmChangePathTag(props.path);
    if (!label) return null;
    return (
        <View style={{ alignSelf: 'center', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: props.theme.colors.surface.inset }}>
            <Text style={{ ...Typography.variant('micro', 'semiBold'), color: props.theme.colors.text.secondary,  }}>{label}</Text>
        </View>
    );
}

/**
 * A row that appeared while the tree was open (an Agent created the file) fades in over `durationMs.fast`,
 * opacity only; reduced motion shows it at once. Decided once, when the row mounts.
 */
function TreeRowArrival(props: Readonly<{ arrived: boolean; children: React.ReactNode }>) {
    const reducedMotion = useReducedMotionPreference();
    const [entering] = React.useState(() => props.arrived && !reducedMotion ? FadeIn.duration(motionTokens.durationMs.fast) : undefined);
    if (!entering) return <>{props.children}</>;
    return <Reanimated.View entering={entering}>{props.children}</Reanimated.View>;
}

function renderEntryIcon(node: WorkspaceRepositoryTreeNode, theme: AppTheme) {
    if (node.type === 'directory') {
        return <Icon name="folder" size={16} color={theme.colors.text.secondary} />;
    }
    if (node.type === 'info') {
        return <Icon name="info" size={16} color={theme.colors.text.secondary} />;
    }
    return <FileIcon fileName={node.name} size={16} appearance="line" />;
}

export const WorkspaceRepositoryTreeList = React.memo(function WorkspaceRepositoryTreeList(props: WorkspaceRepositoryTreeListProps): React.ReactElement | null {
    const touchPrimaryPointer = useHappierTouchPrimaryPointer(Platform.OS);
    const { theme, expandedPaths, onExpandedPathsChange, onOpenFile } = props;
    const accountScope = useActiveServerAccountScope();
    const detailsMode = props.detailsMode === true;

    const preservedPaths = React.useMemo(() => [
        ...(props.revealedPaths ?? []),
        ...(props.scmSnapshot?.entries.flatMap(entry => entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]) ?? []),
    ], [props.revealedPaths, props.scmSnapshot]);
    const { rootLoading: treeRootLoading, rootError: treeRootError, rootLoaded, nodes: treeNodes, toggleDirectory: toggleTreeDirectory, retryRoot, retryDirectory, gitIgnoreAvailable, liveFileWrites, arrivedPaths, recoveryInFlight } = useWorkspaceRepositoryTreeBrowser({
        scope: props.scope,
        enabled: props.directoryListing !== false,
        expandedPaths,
        onExpandedPathsChange,
        reloadToken: props.reloadToken,
        visibilityMode: props.visibilityMode,
        preservedPaths,
        rootDirectoryPath: props.rootDirectoryPath,
        reconciliationPaused: props.reconciliationPaused,
    });

    // Changed only is a presentation of the same tree: the one changed-file list (the header's and
    // Git's count) pruned into rows, with the directory listing kept warm underneath for the way back.
    const changedOnly = props.changedOnly === true;
    const scmRepo = props.scmSnapshot?.repo.isRepo === true ? props.scmSnapshot : null;
    const changedFiles = changedOnly && scmRepo ? selectScmChangedFiles(scmRepo) : NO_CHANGED_FILES;
    const [closedChangedPaths, setClosedChangedPaths] = React.useState<ReadonlySet<string>>(() => props.initialClosedChangedPaths ?? NO_CLOSED_PATHS);
    const changedNodes = React.useMemo(
        () => (changedOnly ? buildChangedOnlyTreeNodes(changedFiles, closedChangedPaths, props.preferredChangedPaths) : []),
        [changedFiles, changedOnly, closedChangedPaths, props.preferredChangedPaths],
    );
    const toggleChangedDirectory = React.useCallback(async (path: string) => {
        setClosedChangedPaths((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);
    const nodes = changedOnly ? changedNodes : treeNodes;
    const maxRows = props.maxRows ?? null;
    const shownNodes = React.useMemo(() => (maxRows != null && nodes.length > maxRows ? nodes.slice(0, maxRows) : nodes), [maxRows, nodes]);
    const toggleDirectory = changedOnly ? toggleChangedDirectory : toggleTreeDirectory;
    // The controller came back and the listing is being read again: the rows it had stay, and the table says it is
    // reconnecting rather than naming the refusal that read is replacing (lab project-reconnecting).
    const reconnecting = !changedOnly && recoveryInFlight === true && treeNodes.length > 0;
    const rootLoading = changedOnly ? props.scmSnapshot == null : treeRootLoading || reconnecting;
    // A stopped workspace over rows the tree kept is said once above them, with Start (lab project-stopped), not as a
    // listing failure; with nothing kept, the root state below owns it.
    const stoppedOverRows = !changedOnly && !reconnecting && treeRootError === MANAGED_POWER_REQUIRED && treeNodes.length > 0;
    const rootError = changedOnly || reconnecting || stoppedOverRows ? null : treeRootError;

    const rootRefreshing = rootLoading && rootLoaded;
    React.useEffect(() => {
        props.onRootLoadingChange?.(rootRefreshing);
    }, [props.onRootLoadingChange, rootRefreshing]);

    const onNodesChange = props.onNodesChange;
    React.useEffect(() => {
        onNodesChange?.(nodes, { loaded: rootLoaded, loading: treeRootLoading, error: treeRootError });
    }, [nodes, onNodesChange, rootLoaded, treeRootLoading, treeRootError]);

    React.useEffect(() => {
        props.onGitIgnoreAvailableChange?.(gitIgnoreAvailable);
    }, [props.onGitIgnoreAvailableChange, gitIgnoreAvailable]);

    const keyboardListRef = React.useRef<import('@/components/ui/lists/virtualized/virtualizedListTypes').VirtualizedListRef>(null);
    const rememberVisibleNodes = useFilesystemTreeScrollAnchor({ nodes: shownNodes,
        scopeKey: JSON.stringify([props.scope.serverId, props.scope.machineId, props.scope.rootPath, props.rootDirectoryPath ?? '', changedOnly]),
        listRef: keyboardListRef });
    const onVisibleNodesChange = React.useCallback((visible: readonly WorkspaceRepositoryTreeNode[]) => {
        rememberVisibleNodes(visible);
        props.onVisibleNodesChange?.(visible);
    }, [rememberVisibleNodes, props.onVisibleNodesChange]);
    const focusIndex = React.useCallback((index: number) => keyboardListRef.current?.scrollToIndex({ index, animated: false }), []);
    const treeKeyboard = useFilesystemTreeKeyboard(shownNodes, focusIndex);
    const focusedRevealRef = React.useRef<typeof props.revealRequest>(undefined);
    React.useEffect(() => {
        const request = props.revealRequest;
        if (!request || focusedRevealRef.current === request || !nodes.some(node => node.path === request.path)) return;
        focusedRevealRef.current = request;
        treeKeyboard.focusPath(request.path);
    }, [nodes, props.revealRequest, treeKeyboard.focusPath]);
    // The one moving thing in the tree: the file an Agent is writing now (lab FB1), named for assistive tech.
    const writerLabels = useLiveFileWriteAgentLabels(liveFileWrites);
    const liveWriteSignature = React.useMemo(() => [...liveFileWrites.keys()].join('\n'), [liveFileWrites]);
    // A row that appeared after a re-list fades in once (opacity only, siblings move at once); scrolling
    // back to it later does not replay the fade.
    const fadedArrivalsRef = React.useRef<Readonly<{ source: ReadonlySet<string>; faded: Set<string> }>>({ source: arrivedPaths, faded: new Set() });
    if (fadedArrivalsRef.current.source !== arrivedPaths) fadedArrivalsRef.current = { source: arrivedPaths, faded: new Set() };
    const claimArrival = React.useCallback((path: string) => {
        const arrivals = fadedArrivalsRef.current;
        if (!arrivals.source.has(path) || arrivals.faded.has(path)) return false;
        arrivals.faded.add(path);
        return true;
    }, []);
    const badgeIndex = useScmTreeBadgeIndex(props.scmSnapshot ?? null);
    const badgeSignature = buildScmTreeBadgeSignature(props.scmSnapshot ?? null);
    const selectedPath = props.selectedPath ?? null;
    const [selectedPathStore] = React.useState(() => createStore<string | null>(() => selectedPath));
    React.useLayoutEffect(() => { selectedPathStore.setState(selectedPath, true); }, [selectedPathStore, selectedPath]);
    const rowRenderState = React.useMemo(() => ({
        accountScope,
        workspaceScope: props.scope,
        treeKeyboard,
        badgeIndex,
        changedOnly,
        selectedPathStore,
        detailsMode,
        liveFileWrites,
        writerLabels,
        claimArrival,
        onOpenFile,
        fileHref: props.fileHref,
        onOpenFilePinned: props.onOpenFilePinned,
        webFileDropEnabled: props.webFileDropEnabled,
        renderRowActions: props.renderRowActions,
        renderRowMetadata: props.renderRowMetadata,
        renderRowSubtitle: props.renderRowSubtitle ?? null,
        rowSelection: props.rowSelection ?? null,
        rowProposal: props.rowProposal ?? null,
        changeRows: changedOnly && props.rowStyle === 'changes',
        retryDirectory,
        scmSnapshot: props.scmSnapshot,
        theme,
        toggleDirectory,
        webDropHoverPath: props.webDropHoverPath,
        folderPage: props.folderPage ?? null,
    }), [
        accountScope,
        props.scope.serverId,
        props.scope.machineId,
        props.scope.rootPath,
        treeKeyboard,
        badgeIndex,
        changedOnly,
        selectedPathStore,
        detailsMode,
        liveFileWrites,
        writerLabels,
        claimArrival,
        onOpenFile,
        props.fileHref,
        props.onOpenFilePinned,
        props.webFileDropEnabled,
        props.renderRowActions,
        props.renderRowMetadata,
        props.renderRowSubtitle,
        props.rowSelection,
        props.rowProposal,
        props.rowStyle,
        retryDirectory,
        props.scmSnapshot,
        theme,
        toggleDirectory,
        props.webDropHoverPath,
        props.folderPage,
    ]);
    const rowRenderStateRef = React.useRef(rowRenderState);
    rowRenderStateRef.current = rowRenderState;
    const rowVisualSignature = React.useMemo(() => [
        props.scope.serverId,
        props.scope.machineId,
        props.scope.rootPath,
        accountScope?.serverId,
        accountScope?.accountId,
        badgeSignature,
        liveWriteSignature,
        // The web badge index lands a tick after the snapshot (useScmTreeBadgeIndex): mounted rows must
        // redraw when it arrives, or they keep the badge-less first render.
        badgeIndex ? 'badges' : 'no-badges',
        changedOnly ? 'changed' : 'all',
        detailsMode ? 'details' : 'compact',
        props.renderRowActions ? 'actions' : 'no-actions',
        props.rowSelection ? `select:${props.rowSelection.revision}` : 'no-select',
        props.rowProposal ? `proposal:${props.rowProposal.revision}` : 'no-proposal',
        props.rowStyle === 'changes' ? 'change-rows' : 'file-rows',
        props.folderPage ? 'folder-page' : 'tree',
        props.webFileDropEnabled ? 'drop' : 'no-drop',
        props.webDropHoverPath ?? '',
        theme.colors.text?.secondary,
        theme.colors.text?.link,
        theme.colors.surface?.pressed,
        theme.colors.state?.neutral?.textForeground,
        theme.colors.state?.success?.textForeground,
        theme.colors.state?.danger?.textForeground,
        theme.colors.state?.warning?.textForeground,
        theme.colors.state.active.foreground,
        theme.colors.state.active.textForeground,
    ].join('|'), [
        props.scope.serverId,
        props.scope.machineId,
        props.scope.rootPath,
        accountScope?.serverId,
        accountScope?.accountId,
        badgeSignature,
        liveWriteSignature,
        badgeIndex,
        changedOnly,
        detailsMode,
        props.webFileDropEnabled,
        props.renderRowActions,
        props.rowSelection,
        props.rowProposal,
        props.rowStyle,
        props.folderPage,
        props.webDropHoverPath,
        theme.colors.state?.danger?.textForeground,
        theme.colors.state?.neutral?.textForeground,
        theme.colors.state?.success?.textForeground,
        theme.colors.state?.warning?.textForeground,
        theme.colors.state.active.foreground,
        theme.colors.state.active.textForeground,
        theme.colors.surface?.pressed,
        theme.colors.text?.link,
        theme.colors.text?.secondary,
    ]);
    const rowVisualExtraData = React.useMemo(() => ({
        href: props.fileHref,
        metadata: props.renderRowMetadata,
        subtitle: props.renderRowSubtitle,
        visual: rowVisualSignature,
        touchPrimaryPointer,
    }), [props.fileHref, props.renderRowMetadata, props.renderRowSubtitle, rowVisualSignature, touchPrimaryPointer]);

    const renderRow = React.useCallback(({ node, showDivider }: FilesystemBrowserRowRenderInput) => {
        const rowState = rowRenderStateRef.current;
        const rowTestId = `repository-tree-row-${toTestIdSafeValue(node.path)}`;
        const badge = rowState.badgeIndex
            ? (
                node.type === 'file'
                    ? rowState.badgeIndex.getFileBadge(node.path)
                    : node.type === 'directory'
                        ? rowState.badgeIndex.getDirectoryBadge(node.path)
                        : null
            )
            : null;

        const renderActions = rowState.renderRowActions;
        const rowActions = renderActions && (node.type === 'file' || node.type === 'directory')
            ? (control: FilesystemBrowserRowActionsControl) => renderActions(node, control)
            : null;
        const changeToneColor = badge
            ? resolveScmChangeToneColor(resolveScmChangeToneForCode(badge.kindLetter), rowState.theme)
            : undefined;

        const showDetailsInline = node.type !== 'error' && rowState.detailsMode && Platform.OS === 'web';
        const detailsSize =
            node.type === 'file' && typeof node.sizeBytes === 'number'
                ? formatHappierDataBytes(node.sizeBytes, { kind: 'storage' })
                : '';
        const detailsModified =
            typeof node.modifiedMs === 'number'
                ? new Date(node.modifiedMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '';

        const metadata = rowState.renderRowMetadata?.(node);
        const liveWrite = node.type === 'file' ? rowState.liveFileWrites.get(node.path) : undefined;
        // Spins in the change mark's slot while the write runs, then the letter returns (lab FB1 `.fl-wspin`).
        const writingMark = liveWrite ? (
            <ActivitySpinner testID={`${rowTestId}-writing`} size={iconMatchedSpinnerSize(12)} color={rowState.theme.colors.text.secondary}
                accessibilityLabel={t('files.agentWritingThisFile', { agent: rowState.writerLabels.get(liveWrite.sessionId) })} />
        ) : null;
        const shouldShowRight = showDetailsInline || metadata != null || Boolean(badge) || writingMark != null || (isDirectoryNode(node) && node.isLoadingChildren);
        const right = shouldShowRight ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s10 }}>
                {metadata}
                {showDetailsInline ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s12 }}>
                        <Text
                            style={{
                                width: 74,
                                textAlign: 'right',
                                fontSize: 12,
                                color: rowState.theme.colors.text.secondary,
                                ...Typography.mono(),
                            }}
                            numberOfLines={1}
                        >
                            {detailsSize}
                        </Text>
                        <Text
                            style={{
                                width: 132,
                                textAlign: 'right',
                                fontSize: 12,
                                color: rowState.theme.colors.text.secondary,
                                ...Typography.mono(),
                            }}
                            numberOfLines={1}
                        >
                            {detailsModified}
                        </Text>
                    </View>
                ) : null}
                {badge && node.type === 'directory' && rowState.changeRows ? (
                    // A change list totals each folder's lines, like a file's, so a large turn reads at a glance.
                    badge.isComplete !== false ? <DiffStat testID={`${rowTestId}-totals`} added={badge.added} removed={badge.removed} /> : null
                ) : badge && node.type === 'directory' ? (
                    // A folder says how many changed files it holds, in the tone of its strongest change.
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 }}>
                        {rowState.rowSelection ? null : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: changeToneColor }} />}
                        <Text
                            testID={`${rowTestId}-changes`}
                            style={{ ...Typography.variant('meta'), color: rowState.theme.colors.text.secondary, fontVariant: ['tabular-nums'],  }}
                        >
                            {formatExactCount(badge.changedCount)}
                        </Text>
                    </View>
                ) : badge ? (
                    // A file carries the same letter as its Git row; Changed only adds its lines. With a
                    // checkbox (the Git tree) the letter moves to the icon slot after it (Git lab TV).
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s6 }}>
                        {rowState.rowProposal?.notes.get(node.path) ? (
                            <Text testID={`${rowTestId}-proposal-note`} numberOfLines={1} style={{ ...Typography.variant('meta', 'semiBold'), color: rowState.theme.colors.state.active.textForeground,  }}>
                                {rowState.rowProposal.notes.get(node.path)}
                            </Text>
                        ) : null}
                        {rowState.changeRows || rowState.rowSelection ? <ScmChangePathTag path={node.path} theme={rowState.theme} /> : null}
                        {rowState.changedOnly && badge.isComplete !== false ? <DiffStat added={badge.added} removed={badge.removed} /> : null}
                        {rowState.rowSelection || rowState.changeRows ? null : writingMark ?? (
                            <Text
                                testID={`${rowTestId}-change`}
                                style={{ fontSize: 12, width: 12, textAlign: 'center', color: changeToneColor, ...Typography.mono('semiBold') }}
                            >
                                {badge.kindLetter}
                            </Text>
                        )}
                    </View>
                ) : writingMark}
                {isDirectoryNode(node) && node.isLoadingChildren ? (
                    <ActivitySpinner size="small" color={rowState.theme.colors.text.secondary} />
                ) : null}
            </View>
        ) : undefined;

        const subtitle = rowState.renderRowSubtitle?.(node) ?? (() => {
            if (node.type === 'info') return undefined;
            if (!rowState.detailsMode || Platform.OS === 'web') return undefined;
            const parts: string[] = [];
            if (node.type === 'file' && typeof node.sizeBytes === 'number') {
                parts.push(formatHappierDataBytes(node.sizeBytes, { kind: 'storage' }));
            }
            if (typeof node.modifiedMs === 'number') {
                parts.push(new Date(node.modifiedMs).toLocaleString());
            }
            return parts.length > 0 ? parts.join(' · ') : undefined;
        })();

        const proposalEmphasis = rowState.rowProposal && (node.type === 'file' || node.type === 'directory')
            ? proposalEmphasisOf(rowState.rowProposal, node)
            : null;
        const arrived = (node.type === 'file' || node.type === 'directory') && rowState.claimArrival(node.path);
        return (
            <TreeRowArrival arrived={arrived}>
            <WorkspaceDestinationRow existingMenu={Boolean(rowActions)} href={node.type === 'file' ? rowState.fileHref?.(node.path) ?? null : null}
                dragSource={rowState.accountScope?.serverId === rowState.workspaceScope.serverId}
                entityTitle={node.type === 'directory' ? `${node.name}/` : node.name}
                entityItem={(node.type === 'file' || node.type === 'directory') && rowState.accountScope?.serverId === rowState.workspaceScope.serverId ? {
                    kind: 'repository-file', scope: rowState.accountScope,
                    entryKind: node.type,
                    machineId: rowState.workspaceScope.machineId,
                    path: resolveMachineAbsolutePath({ rootPath: rowState.workspaceScope.rootPath, requestPath: node.path }),
                } : null}
                // Every row mounts again as it scrolls in: the emphasis rides the destination's own host.
                style={proposalEmphasis === 'in'
                    ? { backgroundColor: rowState.theme.colors.state.active.background }
                    : proposalEmphasis === 'out' ? { opacity: 0.42 } : undefined}>
            {proposalEmphasis === 'in' ? (
                <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 3, bottom: 3, width: 3, borderRadius: 2, zIndex: 1, backgroundColor: rowState.theme.colors.state.active.foreground }} />
            ) : null}
            <RepositoryTreeRowSelection store={rowState.selectedPathStore} path={node.type === 'file' ? node.path : null}>
            {(selected) => (
            <FilesystemTreeRowActive source={rowState.treeKeyboard.activePath} path={node.path}>
            {(active) => (
            <FilesystemBrowserRow
                testID={rowTestId}
                treeItemProps={rowState.treeKeyboard.getRowProps(node, active,
                    node.type === 'directory' ? () => { void rowState.toggleDirectory(node.path); } : undefined,
                    node.type === 'file' ? () => (rowState.onOpenFilePinned ?? rowState.onOpenFile)(node.path) : undefined,
                )}
                node={node}
                title={node.type === 'info' && node.infoKind === 'truncated'
                    ? t('newSession.pathPicker.truncatedDirectoryInfo', { count: node.entryCount ?? 0 })
                    : node.name}
                titleAccessory={rowState.changeRows && node.type === 'directory' && badge ? (
                    <Text testID={`${rowTestId}-count`} style={{ ...Typography.variant('meta'), color: rowState.theme.colors.text.tertiary, fontVariant: ['tabular-nums'],  }}>
                        {formatExactCount(badge.changedCount)}
                    </Text>
                ) : undefined}
                selected={selected}
                subtitle={subtitle}
                icon={rowState.changeRows && node.type === 'file' && badge
                    ? <ScmChangeMark testID={`${rowTestId}-change`} code={badge.kindLetter} color={changeToneColor} size="compact" />
                    : renderEntryIcon(node, rowState.theme)}
                disclosure
                rowPresentation={rowState.folderPage ? 'table' : 'tree'}
                onDisclosurePress={rowState.folderPage
                    ? (node.type === 'directory' ? () => { void rowState.toggleDirectory(node.path); } : null)
                    : undefined}
                disclosureAccessibilityLabel={node.type === 'directory'
                    ? t(node.isExpanded ? 'projects.code.collapseFolder' : 'projects.code.expandFolder', { name: node.name })
                    : undefined}
                rowActions={rowActions}
                selection={rowState.rowSelection && rowState.rowSelection.isSelectable?.(node) !== false && (node.type === 'file' || node.type === 'directory')
                    ? {
                        state: rowState.rowSelection.getState(node),
                        onToggle: () => rowState.rowSelection?.onToggle(node),
                        accessibilityLabel: rowState.rowSelection.accessibilityLabel(node),
                        disabled: rowState.rowSelection.isDisabled?.(node) === true,
                    }
                    : undefined}
                selectionMark={rowState.rowSelection && node.type === 'file' && badge
                    ? <ScmChangeMark testID={`${rowTestId}-change`} code={badge.kindLetter} color={changeToneColor} size="compact" />
                    : undefined}
                density="tight"
                showDivider={showDivider}
                rightElement={right}
                onRetryError={(errorNode: WorkspaceRepositoryTreeNode) => {
                    const parentDirectoryPath =
                        typeof errorNode.parentDirectoryPath === 'string' && errorNode.parentDirectoryPath.trim()
                            ? errorNode.parentDirectoryPath
                            : null;
                    if (parentDirectoryPath) {
                        void rowState.retryDirectory(parentDirectoryPath);
                    }
                }}
                onPress={
                    node.type !== 'file' && node.type !== 'directory'
                        ? undefined
                        : node.type === 'file'
                            ? () => rowState.onOpenFile(node.path)
                            : rowState.folderPage
                                ? () => rowState.folderPage?.onOpenFolder(node.path)
                                : () => {
                                    void rowState.toggleDirectory(node.path);
                                }
                }
                onDoublePress={
                    node.type === 'file'
                        ? () => (rowState.onOpenFilePinned ?? rowState.onOpenFile)(node.path)
                        : undefined
                }
                paddingRight={8}
                style={{
                    backgroundColor: rowState.webDropHoverPath === node.path ? rowState.theme.colors.surface.pressed : undefined,
                }}
                wrapContent={
                    Platform.OS === 'web'
                        ? ({ content }) => (node.type === 'directory' || node.type === 'file') && rowState.webFileDropEnabled === true
                            ? (
                                <WebDropTargetView testID={`${rowTestId}-drop-target`} repositoryFileDropTarget={buildWebDropTarget(node)}>
                                    {content}
                                </WebDropTargetView>
                            )
                            : <View testID={`${rowTestId}-drop-target`}>{content}</View>
                        : null
                }
            />
            )}
            </FilesystemTreeRowActive>
            )}
            </RepositoryTreeRowSelection>
            </WorkspaceDestinationRow>
            </TreeRowArrival>
        );
    }, []);

    if (props.visible === false) return null;

    if (changedOnly && props.scmSnapshot != null && changedNodes.length === 0) {
        return (
            <SurfaceStateCard
                testID="repository-tree-changed-only-empty"
                kind="empty"
                iconName="check-circle"
                title={scmRepo ? t('files.pane.noChangedFilesTitle') : t('files.notRepo')}
                reason={scmRepo ? t('files.pane.noChangedFilesReason') : undefined}
                action={props.onShowAllFiles ? { label: t('files.pane.showAllFiles'), onPress: props.onShowAllFiles } : undefined}
            />
        );
    }

    const emptyRootState = !changedOnly && props.directoryUnavailable && nodes.length === 0
        ? <RepositoryTreeRootErrorState kind="unavailable" machineName={props.machineName} onRetry={() => props.onRequestRefresh?.()} />
        : rootError && nodes.length === 0 ? (
            <View testID="workspace-repository-tree-error" style={{ flex: 1 }}>
                <RepositoryTreeRootErrorState
                    error={rootError}
                    machineName={props.machineName}
                    workspaceScope={props.scope}
                    onRetry={() => {
                        void retryRoot();
                    }}
                />
            </View>
        ) : null;
    if (emptyRootState && !props.listHeader && !props.listFooter && !props.listEmpty) return emptyRootState;

    return (
        <FilesystemBrowser
            treeRole
            presentation={props.presentation}
            listRef={keyboardListRef}
            nodes={shownNodes}
            rootLoading={rootLoading}
            showInlineLoadingHeader={props.showInlineLoadingHeader}
            listFooter={props.listFooter}
            // A first listing that failed is the whole body: its state names the cause, with nothing summarized above it.
            listHeader={emptyRootState ? null : stoppedOverRows ? (
                <>
                    <ManagedWorkspaceStoppedState testID="repository-tree-stopped" size="line" workspaceName={props.machineName ?? null}
                        reason={t('files.pane.managedStoppedReason')} workspaceScope={props.scope} />
                    {props.listHeader}
                </>
            ) : props.listHeader}
            listEmpty={emptyRootState ?? props.listEmpty}
            onVisibleNodesChange={onVisibleNodesChange}
            rootError={rootError}
            retryRoot={retryRoot}
            emptyLabel={props.emptyLabel ?? t('files.noFilesInProject')}
            emptyIconName="folder"
            loadingLabel={reconnecting
                ? t('files.pane.reconnectingTo', { workspace: props.machineName || t('common.machine') })
                : t('common.loading')}
            inlineRetryLabel={t('common.retry')}
            renderRow={renderRow}
            extraData={rowVisualExtraData}
            initialNumToRender={Math.min(32, shownNodes.length)}
            maxToRenderPerBatch={32}
            windowSize={7}
            removeClippedSubviews={Platform.OS !== 'web'}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            onScroll={props.onScroll}
            scrollEventThrottle={props.scrollEventThrottle ?? 16}
            getItemLayout={
                Platform.OS === 'web'
                    ? (_data, index) => {
                        const heights = props.folderPage ? HAPPIER_TREE_ROW_METRICS.tableMinHeightPx : HAPPIER_TREE_ROW_METRICS.minHeightPx;
                        const length = touchPrimaryPointer ? heights.touch : heights.precise;
                        return { length, offset: length * index, index };
                    }
                    : undefined
            }
        />
    );
});
