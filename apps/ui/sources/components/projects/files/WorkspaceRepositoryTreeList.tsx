import { useFilesystemTreeKeyboard } from '@/components/ui/filesystemBrowser/useFilesystemTreeKeyboard';
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
import { t } from '@/text';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useScmTreeBadgeIndex } from '@/components/workspaces/files/repositoryTree/useScmTreeBadgeIndex';
import { buildScmTreeBadgeSignature } from '@/components/workspaces/files/repositoryTree/scmTreeBadges';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import type { RepositoryFileDropTarget } from '@/components/workspaces/files/repositoryTree/repositoryFileDropTarget';
import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { TREE_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';
import type { SelectionCheckState } from '@/components/ui/selection/SelectionCheckGlyph';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { buildChangedOnlyTreeNodes } from '@/components/workspaces/files/repositoryTree/buildChangedFilesOutlineTree';
import { resolveScmChangeToneColor, resolveScmChangeToneForCode } from '@/scm/scmChangeKind';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { ScmChangeMark } from '@/components/workspaces/scm/changes/ScmChangeMark';
import { resolveScmChangePathTag } from '@/scm/scmChangePathTag';

export type WorkspaceRepositoryTreeWebDropTarget = RepositoryFileDropTarget;

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
    /** The workspace, as one identity: what the tree is keyed by AND read through. */
    scope: WorkspaceScopeBase;
    reloadToken?: number;
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
    showInlineLoadingHeader?: boolean;
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
    /** Drawn after the last row, in the tree's own scroll. */
    listFooter?: React.ReactElement | null;
    /** `inline`: rows drawn in place inside an enclosing scroll (a turn card), see `FilesystemBrowserListProps`. */
    presentation?: 'scroll' | 'inline';
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

/** A change-list folder's line totals (its files' counts summed by the one badge index). */
function ScmLineTotals(props: Readonly<{ testID: string; added: number; removed: number; complete: boolean; theme: AppTheme }>) {
    if (!props.complete) return null;
    return (
        <View testID={props.testID} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            {props.added > 0 ? (
                <Text style={{ fontSize: 12, color: props.theme.colors.state.success.foreground, ...Typography.mono() }}>{`+${props.added.toLocaleString()}`}</Text>
            ) : null}
            {props.removed > 0 ? (
                <Text style={{ fontSize: 12, color: props.theme.colors.state.danger.foreground ?? props.theme.colors.state.neutral.foreground, ...Typography.mono() }}>{`−${props.removed.toLocaleString()}`}</Text>
            ) : null}
        </View>
    );
}

/** A change list labels lockfiles and generated output where they appear (the shared path classifier). */
function ScmChangePathTag(props: Readonly<{ path: string; theme: AppTheme }>) {
    const label = resolveScmChangePathTag(props.path);
    if (!label) return null;
    return (
        <View style={{ alignSelf: 'center', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: props.theme.colors.surface.inset }}>
            <Text style={{ fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}>{label}</Text>
        </View>
    );
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

export const WorkspaceRepositoryTreeList = React.memo(function WorkspaceRepositoryTreeList(props: WorkspaceRepositoryTreeListProps): React.ReactElement {
    const { theme, expandedPaths, onExpandedPathsChange, onOpenFile } = props;
    const accountScope = useActiveServerAccountScope();
    const detailsMode = props.detailsMode === true;

    const preservedPaths = React.useMemo(() => [
        ...(props.revealedPaths ?? []),
        ...(props.scmSnapshot?.entries.flatMap(entry => entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]) ?? []),
    ], [props.revealedPaths, props.scmSnapshot]);
    const { rootLoading: treeRootLoading, rootError: treeRootError, nodes: treeNodes, toggleDirectory: toggleTreeDirectory, retryRoot, retryDirectory, gitIgnoreAvailable } = useWorkspaceRepositoryTreeBrowser({
        scope: props.scope,
        enabled: props.directoryListing !== false,
        expandedPaths,
        onExpandedPathsChange,
        reloadToken: props.reloadToken,
        visibilityMode: props.visibilityMode,
        preservedPaths,
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
    const toggleDirectory = changedOnly ? toggleChangedDirectory : toggleTreeDirectory;
    const rootLoading = changedOnly ? props.scmSnapshot == null : treeRootLoading;
    const rootError = changedOnly ? null : treeRootError;

    React.useEffect(() => {
        props.onRootLoadingChange?.(rootLoading);
    }, [props.onRootLoadingChange, rootLoading]);

    React.useEffect(() => {
        props.onGitIgnoreAvailableChange?.(gitIgnoreAvailable);
    }, [props.onGitIgnoreAvailableChange, gitIgnoreAvailable]);

    const keyboardListRef = React.useRef<import('@/components/ui/lists/virtualized/virtualizedListTypes').VirtualizedListRef>(null);
    const focusIndex = React.useCallback((index: number) => keyboardListRef.current?.scrollToIndex({ index, animated: false }), []);
    const treeKeyboard = useFilesystemTreeKeyboard(nodes, focusIndex);
    const focusedRevealRef = React.useRef<typeof props.revealRequest>(undefined);
    React.useEffect(() => {
        const request = props.revealRequest;
        if (!request || focusedRevealRef.current === request || !nodes.some(node => node.path === request.path)) return;
        focusedRevealRef.current = request;
        treeKeyboard.focusPath(request.path);
    }, [nodes, props.revealRequest, treeKeyboard.focusPath]);
    const badgeIndex = useScmTreeBadgeIndex(props.scmSnapshot ?? null);
    const badgeSignature = buildScmTreeBadgeSignature(props.scmSnapshot ?? null);
    const selectedPath = props.selectedPath ?? null;
    const rowRenderState = React.useMemo(() => ({
        accountScope,
        workspaceScope: props.scope,
        treeKeyboard,
        badgeIndex,
        changedOnly,
        selectedPath,
        detailsMode,
        onOpenFile,
        fileHref: props.fileHref,
        onOpenFilePinned: props.onOpenFilePinned,
        webFileDropEnabled: props.webFileDropEnabled,
        renderRowActions: props.renderRowActions,
        renderRowMetadata: props.renderRowMetadata,
        rowSelection: props.rowSelection ?? null,
        rowProposal: props.rowProposal ?? null,
        changeRows: changedOnly && props.rowStyle === 'changes',
        retryDirectory,
        scmSnapshot: props.scmSnapshot,
        theme,
        toggleDirectory,
        webDropHoverPath: props.webDropHoverPath,
    }), [
        accountScope,
        props.scope.serverId,
        props.scope.machineId,
        props.scope.rootPath,
        treeKeyboard,
        badgeIndex,
        changedOnly,
        selectedPath,
        detailsMode,
        onOpenFile,
        props.fileHref,
        props.onOpenFilePinned,
        props.webFileDropEnabled,
        props.renderRowActions,
        props.renderRowMetadata,
        props.rowSelection,
        props.rowProposal,
        props.rowStyle,
        retryDirectory,
        props.scmSnapshot,
        theme,
        toggleDirectory,
        props.webDropHoverPath,
    ]);
    const rowRenderStateRef = React.useRef(rowRenderState);
    rowRenderStateRef.current = rowRenderState;
    const rowVisualSignature = React.useMemo(() => [
        props.scope.serverId,
        props.scope.machineId,
        props.scope.rootPath,
        accountScope?.serverId,
        accountScope?.accountId,
        treeKeyboard.activePath,
        badgeSignature,
        // The web badge index lands a tick after the snapshot (useScmTreeBadgeIndex): mounted rows must
        // redraw when it arrives, or they keep the badge-less first render.
        badgeIndex ? 'badges' : 'no-badges',
        changedOnly ? 'changed' : 'all',
        selectedPath ?? '',
        detailsMode ? 'details' : 'compact',
        props.renderRowActions ? 'actions' : 'no-actions',
        props.rowSelection ? `select:${props.rowSelection.revision}` : 'no-select',
        props.rowProposal ? `proposal:${props.rowProposal.revision}` : 'no-proposal',
        props.rowStyle === 'changes' ? 'change-rows' : 'file-rows',
        props.webFileDropEnabled ? 'drop' : 'no-drop',
        props.webDropHoverPath ?? '',
        theme.colors.text?.secondary,
        theme.colors.text?.link,
        theme.colors.surface?.pressed,
        theme.colors.state?.neutral?.foreground,
        theme.colors.state?.success?.foreground,
        theme.colors.state?.danger?.foreground,
    ].join('|'), [
        props.scope.serverId,
        props.scope.machineId,
        props.scope.rootPath,
        accountScope?.serverId,
        accountScope?.accountId,
        treeKeyboard.activePath,
        badgeSignature,
        badgeIndex,
        changedOnly,
        selectedPath,
        detailsMode,
        props.webFileDropEnabled,
        props.renderRowActions,
        props.rowSelection,
        props.rowProposal,
        props.rowStyle,
        props.webDropHoverPath,
        theme.colors.state?.danger?.foreground,
        theme.colors.state?.neutral?.foreground,
        theme.colors.state?.success?.foreground,
        theme.colors.surface?.pressed,
        theme.colors.text?.link,
        theme.colors.text?.secondary,
    ]);
    const rowVisualExtraData = React.useMemo(() => ({
        href: props.fileHref,
        metadata: props.renderRowMetadata,
        visual: rowVisualSignature,
    }), [props.fileHref, props.renderRowMetadata, rowVisualSignature]);

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
                ? formatByteSize(node.sizeBytes)
                : '';
        const detailsModified =
            typeof node.modifiedMs === 'number'
                ? new Date(node.modifiedMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '';

        const metadata = rowState.renderRowMetadata?.(node);
        const shouldShowRight = showDetailsInline || metadata != null || Boolean(badge) || (isDirectoryNode(node) && node.isLoadingChildren);
        const right = shouldShowRight ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                {metadata}
                {showDetailsInline ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
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
                    <ScmLineTotals testID={`${rowTestId}-totals`} added={badge.added} removed={badge.removed} complete={badge.isComplete !== false} theme={rowState.theme} />
                ) : badge && node.type === 'directory' ? (
                    // A folder says how many changed files it holds, in the tone of its strongest change.
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        {rowState.rowSelection ? null : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: changeToneColor }} />}
                        <Text
                            testID={`${rowTestId}-changes`}
                            style={{ fontSize: 12, color: rowState.theme.colors.text.secondary, fontVariant: ['tabular-nums'], ...Typography.default() }}
                        >
                            {formatExactCount(badge.changedCount)}
                        </Text>
                    </View>
                ) : badge ? (
                    // A file carries the same letter as its Git row; Changed only adds its lines. With a
                    // checkbox (the Git tree) the letter moves to the icon slot after it (Git lab TV).
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                        {rowState.rowProposal?.notes.get(node.path) ? (
                            <Text testID={`${rowTestId}-proposal-note`} numberOfLines={1} style={{ fontSize: 12, color: rowState.theme.colors.state.active.foreground, ...Typography.default('semiBold') }}>
                                {rowState.rowProposal.notes.get(node.path)}
                            </Text>
                        ) : null}
                        {rowState.changeRows || rowState.rowSelection ? <ScmChangePathTag path={node.path} theme={rowState.theme} /> : null}
                        {rowState.changedOnly && badge.isComplete !== false && badge.added > 0 ? (
                            <Text style={{ fontSize: 12, color: rowState.theme.colors.state.success.foreground, ...Typography.mono() }}>
                                {`+${badge.added}`}
                            </Text>
                        ) : null}
                        {rowState.changedOnly && badge.isComplete !== false && badge.removed > 0 ? (
                            <Text style={{ fontSize: 12, color: rowState.theme.colors.state.danger.foreground ?? rowState.theme.colors.state.neutral.foreground, ...Typography.mono() }}>
                                {`−${badge.removed}`}
                            </Text>
                        ) : null}
                        {rowState.rowSelection || rowState.changeRows ? null : (
                            <Text
                                testID={`${rowTestId}-change`}
                                style={{ fontSize: 12, width: 12, textAlign: 'center', color: changeToneColor, ...Typography.mono('semiBold') }}
                            >
                                {badge.kindLetter}
                            </Text>
                        )}
                    </View>
                ) : null}
                {isDirectoryNode(node) && node.isLoadingChildren ? (
                    <ActivitySpinner size="small" color={rowState.theme.colors.text.secondary} />
                ) : null}
            </View>
        ) : undefined;

        const subtitle = (() => {
            if (node.type === 'info') return undefined;
            if (!rowState.detailsMode || Platform.OS === 'web') return undefined;
            const parts: string[] = [];
            if (node.type === 'file' && typeof node.sizeBytes === 'number') {
                parts.push(formatByteSize(node.sizeBytes));
            }
            if (typeof node.modifiedMs === 'number') {
                parts.push(new Date(node.modifiedMs).toLocaleString());
            }
            return parts.length > 0 ? parts.join(' · ') : undefined;
        })();

        const proposalEmphasis = rowState.rowProposal && (node.type === 'file' || node.type === 'directory')
            ? proposalEmphasisOf(rowState.rowProposal, node)
            : null;
        return (
            <WorkspaceDestinationRow existingMenu={Boolean(rowActions)} href={node.type === 'file' ? rowState.fileHref?.(node.path) ?? null : null}
                dragSource={rowState.accountScope?.serverId === rowState.workspaceScope.serverId}
                entityItem={node.type === 'file' && rowState.accountScope?.serverId === rowState.workspaceScope.serverId ? {
                    kind: 'repository-file', scope: rowState.accountScope,
                    machineId: rowState.workspaceScope.machineId,
                    path: resolveMachineAbsolutePath({ rootPath: rowState.workspaceScope.rootPath, requestPath: node.path }),
                } : null}>
            <View style={proposalEmphasis === 'in'
                ? { backgroundColor: rowState.theme.colors.state.active.background }
                : proposalEmphasis === 'out' ? { opacity: 0.42 } : null}>
            {proposalEmphasis === 'in' ? (
                <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 3, bottom: 3, width: 3, borderRadius: 2, zIndex: 1, backgroundColor: rowState.theme.colors.state.active.foreground }} />
            ) : null}
            <FilesystemBrowserRow
                testID={rowTestId}
                treeItemProps={rowState.treeKeyboard.getRowProps(node,
                    node.type === 'directory' ? () => { void rowState.toggleDirectory(node.path); } : undefined,
                    node.type === 'file' ? () => (rowState.onOpenFilePinned ?? rowState.onOpenFile)(node.path) : undefined,
                )}
                node={node}
                title={node.name}
                titleAccessory={rowState.changeRows && node.type === 'directory' && badge ? (
                    <Text testID={`${rowTestId}-count`} style={{ fontSize: 12, color: rowState.theme.colors.text.tertiary, fontVariant: ['tabular-nums'], ...Typography.default() }}>
                        {formatExactCount(badge.changedCount)}
                    </Text>
                ) : undefined}
                selected={node.type === 'file' && node.path === rowState.selectedPath}
                subtitle={subtitle}
                icon={rowState.changeRows && node.type === 'file' && badge
                    ? <ScmChangeMark testID={`${rowTestId}-change`} code={badge.kindLetter} color={changeToneColor} size="compact" />
                    : renderEntryIcon(node, rowState.theme)}
                disclosure
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
                    node.type === 'error'
                        ? undefined
                        : node.type === 'file'
                            ? () => rowState.onOpenFile(node.path)
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
                    borderRadius: 10,
                }}
                wrapContent={
                    Platform.OS === 'web'
                        ? ({ content }) => {
                            const shouldWrapDropTarget =
                                (node.type === 'directory' || node.type === 'file')
                                && rowState.webFileDropEnabled === true;
                            const wrappedContent = shouldWrapDropTarget
                                ? (
                                    <WebDropTargetView
                                        repositoryFileDropTarget={buildWebDropTarget(node)}
                                    >
                                        {content}
                                    </WebDropTargetView>
                                )
                                : content;

                            return (
                                <View testID={`${rowTestId}-drop-target`}>
                                    {wrappedContent}
                                </View>
                            );
                        }
                        : null
                }
            />
            </View>
            </WorkspaceDestinationRow>
        );
    }, []);

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

    if (rootError && nodes.length === 0) {
        return (
            <View testID="workspace-repository-tree-error" style={{ flex: 1 }}>
                <RepositoryTreeRootErrorState
                    error={rootError}
                    machineName={props.machineName}
                    onRetry={() => {
                        void retryRoot();
                    }}
                />
            </View>
        );
    }

    return (
        <FilesystemBrowser
            treeRole
            presentation={props.presentation}
            listRef={keyboardListRef}
            nodes={nodes}
            rootLoading={rootLoading}
            showInlineLoadingHeader={props.showInlineLoadingHeader}
            listFooter={props.listFooter}
            rootError={rootError}
            retryRoot={retryRoot}
            emptyLabel={t('files.noFilesInProject')}
            emptyIconName="folder"
            loadingLabel={t('common.loading')}
            inlineRetryLabel={t('errors.tryAgain')}
            renderRow={renderRow}
            extraData={rowVisualExtraData}
            initialNumToRender={Math.min(32, nodes.length)}
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
                        const length = isTouchPrimaryPointer() ? TREE_ROW_METRICS.minHeightPx.touch : TREE_ROW_METRICS.minHeightPx.precise;
                        return { length, offset: length * index, index };
                    }
                    : undefined
            }
        />
    );
});
