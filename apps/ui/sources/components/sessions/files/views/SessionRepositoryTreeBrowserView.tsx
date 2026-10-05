import { useRepositoryTreeVisibility } from '@/hooks/workspaces/files/useRepositoryTreeVisibility';
import { RepositoryTreeVisibilityControl } from '@/components/workspaces/files/repositoryTree/RepositoryTreeVisibilityControl';
import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SearchResultsList } from '@/components/workspaces/files/repositoryTree/SearchResultsList';
import { hrefForDestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { RepositoryTreeToolbar } from '@/components/workspaces/files/repositoryTree/RepositoryTreeToolbar';
import { RepositoryTreeCreateMenu, type RepositoryTreeCreateMenuItemId } from '@/components/workspaces/files/repositoryTree/RepositoryTreeCreateMenu';
import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { useSessionMachineName } from '@/components/sessions/agents/presentation/useSessionMachineName';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { RepositoryTreeDropOverlay } from '@/components/workspaces/files/repositoryTree/RepositoryTreeDropOverlay';
import { RepositoryTreeTransferStatusBar } from '@/components/workspaces/files/repositoryTree/RepositoryTreeTransferStatusBar';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionFileUploadAvailability } from '@/components/sessions/files/useSessionFileUploadAvailability';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { storage, useSessionDirectoryKind, useSessionProjectScmSnapshot, useSessionRepositoryTreeExpandedPaths } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Modal } from '@/modal';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { computeExpandedPathsForReveal } from '@/components/workspaces/files/repositoryTree/computeExpandedPathsForReveal';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import { readWebDroppedEntries } from '@/utils/files/webDroppedEntries';
import { nativePickFiles, type NativePickedFile } from '@/utils/files/nativePickFiles';
import { applyWebDirectoryInputAttributes } from '@/utils/files/applyWebDirectoryInputAttributes';
import { useWorkspaceFileTransfers, type WorkspaceUploadEntry } from '@/hooks/session/files/useWorkspaceFileTransfers';
import { showUploadConflictResolutionDialog } from '@/components/workspaces/files/repositoryTree/showUploadConflictResolutionDialog';
import { readRepositoryFileDropTarget } from '@/components/workspaces/files/repositoryTree/repositoryFileDropTarget';
import type { WebFileDragEvent } from '@/components/ui/treeDragDrop/externalFileDropAdapter';
import { useRepositoryTreeWebDropState } from '@/components/sessions/files/repositoryTree/useRepositoryTreeWebDropState';
import { useRepositoryUploadActionTarget } from '@/components/workspaces/files/repositoryTree/useRepositoryUploadActionTarget';
import { promptRepositoryUploadDestination } from '@/components/workspaces/files/repositoryTree/promptRepositoryUploadDestination';
import { WorkspaceRepositoryTreeList } from '@/components/projects/files/WorkspaceRepositoryTreeList';
import { clearCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { useWorkspaceFileQuery } from '@/sync/domains/workspaces/files/useWorkspaceFileQuery';
import { RepositoryTreeRowActionsMenu } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRowActionsMenu';
import { useRepositoryTreeRowActions } from '@/components/sessions/files/repositoryTree/useRepositoryTreeRowActions';
import { useSessionFileTransferAvailabilityState } from '@/components/sessions/files/useSessionFileTransferAvailability';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { workspaceCreateDirectory, workspaceWriteFile } from '@/sync/ops/workspaceFileSystem';
import { SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { TREE_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';

const repositoryTreeBrowserStyles = StyleSheet.create({
    root: {
        flex: 1,
    },
    dropZone: {
        flex: 1,
    },
    content: {
        flex: 1,
        position: 'relative',
    },
    sessionFilesRoot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: TREE_ROW_METRICS.basePaddingPx,
        paddingRight: 12,
    },
});

/**
 * The root of a no-folder session's tree (plan 03 §3.5, lab FL3): the private folder is never
 * named by its path, so the tree is titled "Session files". A folder session's tree has no heading.
 */
function SessionFilesRootHeading(props: Readonly<{ label: string }>) {
    const { theme } = useUnistyles();
    return (
        <View
            testID="repository-tree-session-files-root"
            accessibilityRole="header"
            style={[
                repositoryTreeBrowserStyles.sessionFilesRoot,
                { minHeight: isTouchPrimaryPointer() ? TREE_ROW_METRICS.minHeightPx.touch : TREE_ROW_METRICS.minHeightPx.precise },
            ]}
        >
            <Icon name="folder" size={16} color={theme.colors.text.secondary} />
            <Text numberOfLines={1} style={[Typography.rowTitle(), { color: theme.colors.text.primary }]}>{props.label}</Text>
        </View>
    );
}

export type SessionRepositoryTreeBrowserViewProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    density?: 'panel' | 'screen' | 'modal';
    searchQuery?: string;
    onSearchQueryChange?: (value: string) => void;
    showSearchBar?: boolean;
    onRequestClose?: () => void;
    revealRequest?: Readonly<{ path: string }>;
    /** The file open in Details: its row stays selected (lab F1). */
    selectedPath?: string | null;
}>;

export const SessionRepositoryTreeBrowserView = React.memo((props: SessionRepositoryTreeBrowserViewProps) => {
    const { theme } = useUnistyles();
    const { machineRpcTargetAvailable } = useSessionMachineReachability(props.sessionId, props.serverId);
    const workspaceTarget = useSessionWorkspaceTarget(props.sessionId, props.serverId);
    const routeServerId = workspaceTarget?.serverId ?? props.serverId;
    const fileHref = React.useCallback((path: string) => hrefForDestinationRef([], {
        kind: 'sessionDetails', params: {
            id: props.sessionId, ...(routeServerId ? { serverId: routeServerId } : {}),
            ...serializeSessionPaneUrlState({ details: { kind: 'file', path } }),
        },
    }), [routeServerId, props.sessionId]);
    // One identity for the whole surface. Spreading the target into a key plus three separate
    // address parts is what let a sibling browser key by one server and read through another.
    //
    // Memoized on the three FIELDS, never on `workspaceTarget` itself: that hook recomputes
    // whenever the machine or session collections change identity, so keying on the object
    // would hand every effect below a fresh scope on most renders. The effects used to depend
    // on primitive strings and were immune to that; the scope has to be just as stable.
    const workspaceScope = React.useMemo((): WorkspaceScopeBase | null => (
        workspaceTarget
            ? {
                serverId: workspaceTarget.serverId,
                machineId: workspaceTarget.machineId,
                rootPath: workspaceTarget.rootPath,
            }
            : null
    ), [workspaceTarget?.serverId, workspaceTarget?.machineId, workspaceTarget?.rootPath]);

    const expandedPaths = useSessionRepositoryTreeExpandedPaths(props.sessionId);
    // A no-folder session names its root "Session files" everywhere this pane names the root.
    const withoutFolder = useSessionDirectoryKind(props.sessionId) === 'managed';
    const rootLabel = withoutFolder ? t('session.folderless.sessionFiles') : t('files.projectRoot');
    // Read through the same qualified Home the resolved workspace scope and the changed-files pane
    // already use, so a second Home hosting this Session id cannot supply the working tree.
    const scmSnapshot = useSessionProjectScmSnapshot(props.sessionId, workspaceScope?.serverId ?? props.serverId);
    const didWarmScmRef = React.useRef<string | null>(null);

    const [uncontrolledSearchQuery, setUncontrolledSearchQuery] = React.useState('');
    const searchQuery = props.searchQuery ?? uncontrolledSearchQuery;
    const setSearchQuery = props.onSearchQueryChange ?? setUncontrolledSearchQuery;
    const [showChangedOnly, setShowChangedOnly] = React.useState(false);
    const { visibilityMode, setVisibilityMode, gitIgnoreAvailable, setGitIgnoreAvailable, revealedPaths, revealPath, latestRequest } = useRepositoryTreeVisibility(props.sessionId);
    const [detailsMode, setDetailsMode] = React.useState(false);
    const [treeReloadNonce, setTreeReloadNonce] = React.useState(0);
    const [treeRootLoading, setTreeRootLoading] = React.useState(false);
    const [uploadDestinationDir, setUploadDestinationDir] = React.useState('');
    const fileQuery = useWorkspaceFileQuery({ scope: workspaceScope, query: searchQuery, enabled: !showChangedOnly, limit: 200, reloadToken: treeReloadNonce, contextKey: props.sessionId });
    const searchResults = fileQuery.items;
    const isSearching = fileQuery.isSearching;

    const showSearchBar = props.showSearchBar !== false;
    const hasWorkspaceTarget = workspaceTarget !== null;
    const allowCreateActions = machineRpcTargetAvailable && hasWorkspaceTarget;
    const uploadActionsAvailable = useSessionFileUploadAvailability(
        props.sessionId,
        workspaceTarget?.serverId ?? props.serverId,
    ) && hasWorkspaceTarget;
    const webDropState = useRepositoryTreeWebDropState({
        sessionId: props.sessionId,
        enabled: uploadActionsAvailable && Platform.OS === 'web',
        expandedPaths,
    });
    const webFileInputRef = React.useRef<HTMLInputElement | null>(null);
    const webFolderInputRef = React.useRef<HTMLInputElement | null>(null);
    const pickedUploadSelectionRef = React.useRef<Readonly<{ destinationDir: string; isCurrent: () => boolean }> | null>(null);
    const setWebFolderInputRef = React.useCallback((node: HTMLInputElement | null) => {
        webFolderInputRef.current = node;
        applyWebDirectoryInputAttributes(node);
    }, []);

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const handleRevealPath = React.useCallback((path: string, isDirectory = false) => {
        if (!isSafeWorkspaceRelativePath(path)) return;
        setSearchQuery('');
        setShowChangedOnly(false);
        revealPath(path, { focus: true });
        const expandedPaths = computeExpandedPathsForReveal({
            expandedPaths: storage.getState().getSessionRepositoryTreeExpandedPaths(props.sessionId),
            fullPath: path,
        });
        storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId,
            isDirectory && !expandedPaths.includes(path) ? [...expandedPaths, path] : expandedPaths);
    }, [props.sessionId, setSearchQuery, revealPath]);

    React.useEffect(() => {
        if (props.revealRequest) handleRevealPath(props.revealRequest.path);
    }, [props.revealRequest, handleRevealPath]);

    const handleSearchFolderPress = React.useCallback((folder: FileItem) => {
        handleRevealPath(folder.fullPath.replace(/\/+$/, ''), true);
    }, [handleRevealPath]);

    const handleTreeOpenFile = React.useCallback((path: string) => {
        revealPath(path);
        props.onOpenFile(path);
    }, [props.onOpenFile, revealPath]);
    const handleTreeOpenFilePinned = React.useCallback((path: string) => {
        revealPath(path);
        (props.onOpenFilePinned ?? props.onOpenFile)(path);
    }, [props.onOpenFile, props.onOpenFilePinned, revealPath]);

    React.useEffect(() => {
        if (!machineRpcTargetAvailable) return;
        const key = `${props.sessionId}:${treeReloadNonce}`;
        if (didWarmScmRef.current === key) return;
        didWarmScmRef.current = key;
        // Warm SCM snapshot so the file tree can display change badges even if the user
        // hasn't opened the Source control panel yet.
        scmStatusSync.invalidateFromUser(props.sessionId, workspaceScope?.serverId ?? props.serverId);
    }, [machineRpcTargetAvailable, props.sessionId, treeReloadNonce]);


    const shouldShowSearchResults = !showChangedOnly && searchQuery.trim().length > 0;

    React.useEffect(() => {
        if (shouldShowSearchResults || showChangedOnly) {
            setTreeRootLoading(false);
        }
    }, [shouldShowSearchResults, showChangedOnly]);

    const refresh = React.useCallback(() => {
        const workspaceCacheKey = workspaceScope ? tryBuildWorkspaceCacheKey(workspaceScope) : null;
        if (workspaceScope && workspaceCacheKey) {
            workspaceFileSearchCache.clearCache(workspaceScope);
            clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey });
        }
        scmStatusSync.invalidateFromUser(props.sessionId, workspaceScope?.serverId ?? props.serverId);
        setTreeReloadNonce((n) => n + 1);
    }, [props.sessionId, workspaceScope]);

    const transfers = useWorkspaceFileTransfers({
        sessionId: props.sessionId,
        onResolveUploadConflicts: showUploadConflictResolutionDialog,
        onAfterUploadSuccess: refresh,
    });

    const transferAvailability = useSessionFileTransferAvailabilityState(
        props.sessionId,
        workspaceTarget?.serverId ?? props.serverId,
    );
    const canDownload = React.useCallback((_transferSizeBytes?: number | null) => {
        return transferAvailability.available;
    }, [transferAvailability.available]);
    const handleExpandedPathsChange = React.useCallback((paths: string[]) => {
        storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, paths);
    }, [props.sessionId]);
    const handleRequestDownload = React.useCallback((params: Readonly<{ path: string; asZip: boolean }>) => {
        return transfers.startDownload(params);
    }, [transfers.startDownload]);
    const rowActions = useRepositoryTreeRowActions({
        sessionId: props.sessionId,
        writeActionsEnabled: allowCreateActions,
        expandedPaths,
        onExpandedPathsChange: handleExpandedPathsChange,
        onRequestRefresh: refresh,
        onRequestDownload: handleRequestDownload,
    });

    const renderRowActions = React.useCallback<NonNullable<React.ComponentProps<typeof WorkspaceRepositoryTreeList>['renderRowActions']>>((node, control) => {
        if (node.type !== 'file' && node.type !== 'directory') return null;
        const nodeKind: 'file' | 'directory' = node.type === 'file' ? 'file' : 'directory';
        const transferSizeBytes = node.type === 'file' && typeof node.sizeBytes === 'number'
            ? node.sizeBytes
            : null;
        return (
            <RepositoryTreeRowActionsMenu
                href={node.type === 'file' ? fileHref(node.path) : null}
                path={node.path}
                kind={nodeKind}
                disableWriteActions={!allowCreateActions}
                downloadActionsEnabled={canDownload(transferSizeBytes)}
                onSelect={(itemId) => rowActions.onSelectRowMenuItem({ path: node.path, type: nodeKind }, itemId)}
                control={control}
            />
        );
    }, [allowCreateActions, canDownload, fileHref, rowActions]);

    const handleFilesDropped = React.useCallback(async (event: WebFileDragEvent) => {
        const dataTransfer = event?.dataTransfer;
        if (!dataTransfer) return;
        const destinationDir = readRepositoryFileDropTarget(event)?.destinationDir ?? '';
        // The browser supplies the concrete DataTransfer at this external boundary.
        const dropped = await readWebDroppedEntries(dataTransfer as DataTransfer);
        const entries: WorkspaceUploadEntry[] = dropped.map((entry) => ({
            kind: 'web',
            file: entry.file,
            relativePath: entry.relativePath,
        }));
        const res = await transfers.startUploads({ entries, destinationDir });
        if (!res.ok) {
            Modal.alert(t('common.error'), res.error);
        }
    }, [transfers.startUploads]);

    const dropZoneHandlers = useWebFileDropZone({
        enabled: uploadActionsAvailable && Platform.OS === 'web',
        onFileDragActiveChange: webDropState.onFileDragActiveChange,
        onFilesDropped: handleFilesDropped,
    });

    const dropZoneHandlersWithRoot = React.useMemo(() => ({
        ...dropZoneHandlers,
        onDragEnter: (event: WebFileDragEvent) => {
            const target = readRepositoryFileDropTarget(event);
            if (target) webDropState.onDropTargetChange(target);
            dropZoneHandlers.onDragEnter(event);
        },
        onDragOver: (event: WebFileDragEvent) => {
            const target = readRepositoryFileDropTarget(event);
            if (target) webDropState.onDropTargetChange(target);
            dropZoneHandlers.onDragOver(event);
        },
    }), [dropZoneHandlers, webDropState.onDropTargetChange]);

    const collapseAll = React.useCallback(() => {
        storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, []);
    }, [props.sessionId]);

    const createFile = React.useCallback(() => {
        if (!allowCreateActions) return;
        void (async () => {
            const raw = await Modal.prompt(
                t('files.createFilePromptTitle'),
                t('files.createFilePromptBody'),
                { placeholder: 'src/new-file.ts' },
            );
            if (typeof raw !== 'string') return;
            const path = raw.trim();
            if (!path) return;
            if (!isSafeWorkspaceRelativePath(path) || path.endsWith('/')) {
                Modal.alert(t('common.error'), t('files.createFileInvalidPath'));
                return;
            }

            const target = resolveWorkspaceTargetForSession(props.sessionId);
            if (!target) {
                Modal.alert(t('common.error'), t('files.createFileFailed'));
                return;
            }

            const res = await workspaceWriteFile({
                machineId: target.machineId,
                rootPath: target.rootPath,
                serverId: target.serverId,
            }, path, '', null);
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('files.createFileFailed'));
                return;
            }

            const nextExpanded = computeExpandedPathsForReveal({
                expandedPaths,
                fullPath: path,
            });
            storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, nextExpanded);
            refresh();

            revealPath(path);
            (props.onOpenFilePinned ?? props.onOpenFile)(path);
        })();
    }, [allowCreateActions, expandedPaths, props.onOpenFile, props.onOpenFilePinned, props.sessionId, refresh, revealPath]);

    const createFolder = React.useCallback(() => {
        if (!allowCreateActions) return;
        void (async () => {
            const raw = await Modal.prompt(
                t('files.createFolderPromptTitle'),
                t('files.createFolderPromptBody'),
                { placeholder: 'src/new-folder' },
            );
            if (typeof raw !== 'string') return;
            const directoryPath = raw.trim().replace(/\/+$/, '');
            if (!directoryPath) return;
            if (!isSafeWorkspaceRelativePath(directoryPath)) {
                Modal.alert(t('common.error'), t('files.createFolderInvalidPath'));
                return;
            }

            const target = resolveWorkspaceTargetForSession(props.sessionId);
            if (!target) {
                Modal.alert(t('common.error'), t('files.createFolderFailed'));
                return;
            }

            const res = await workspaceCreateDirectory({
                machineId: target.machineId,
                rootPath: target.rootPath,
                serverId: target.serverId,
            }, directoryPath);
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('files.createFolderFailed'));
                return;
            }

            const nextExpanded = computeExpandedPathsForReveal({
                expandedPaths,
                // Expand the newly-created directory itself by using a synthetic child path.
                fullPath: `${directoryPath}/.placeholder`,
            });
            revealPath(directoryPath);
            const withDir = nextExpanded.includes(directoryPath) ? nextExpanded : [...nextExpanded, directoryPath];
            storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, withDir);
            refresh();
        })();
    }, [allowCreateActions, expandedPaths, props.sessionId, refresh, revealPath]);

    const startWebUploads = React.useCallback(async (files: readonly File[], destinationDir: string) => {
        const entries: WorkspaceUploadEntry[] = files.map((file) => ({
            kind: 'web',
            file,
            relativePath: (file as any).webkitRelativePath || file.name,
        }));
        const res = await transfers.startUploads({ entries, destinationDir });
        if (!res.ok) {
            Modal.alert(t('common.error'), res.error);
        }
    }, [transfers.startUploads]);

    const startNativeUploads = React.useCallback(async (destinationDir: string, isCurrent: () => boolean) => {
        if (!isCurrent()) return 'cancelled' as const;
        const picked = await nativePickFiles({ multiple: true });
        if (!isCurrent()) return 'cancelled' as const;
        const nativePicked = picked.filter((p): p is Extract<NativePickedFile, { kind: 'native' }> => p.kind === 'native');
        if (nativePicked.length === 0) return 'cancelled' as const;
        const entries: WorkspaceUploadEntry[] = nativePicked.map((p) => ({
            kind: 'native',
            uri: p.uri,
            name: p.name,
            sizeBytes: p.sizeBytes,
            mimeType: p.mimeType,
            relativePath: p.name,
        }));
        const res = await transfers.startUploads({ entries, destinationDir });
        if (!res.ok) {
            Modal.alert(t('common.error'), res.error);
        }
        return 'requested' as const;
    }, [transfers.startUploads]);

    const captureCurrentUploadAcquisition = useRepositoryUploadActionTarget({
        workspaceScope,
        enabled: uploadActionsAvailable,
        pick: async ({ kind, destinationDir, signal }, isCurrent) => {
            if (signal?.aborted) return { status: 'cancelled' };
            if (Platform.OS !== 'web') {
                if (kind === 'folder') return { status: 'unavailable' };
                return { status: await startNativeUploads(destinationDir, isCurrent) };
            }
            const input = kind === 'folder' ? webFolderInputRef.current : webFileInputRef.current;
            if (!input) return { status: 'unavailable' };
            pickedUploadSelectionRef.current = { destinationDir, isCurrent };
            input.click();
            return { status: 'requested' };
        },
    });

    const selectUploadDestination = React.useCallback(async () => {
        const nextDestination = await promptRepositoryUploadDestination(uploadDestinationDir, rootLabel);
        if (nextDestination === null) return;
        setUploadDestinationDir(nextDestination);
    }, [rootLabel, uploadDestinationDir]);

    const onSelectCreateMenuItem = React.useCallback((itemId: RepositoryTreeCreateMenuItemId) => {
        if (itemId === 'repository-tree-create-file') {
            createFile();
            return;
        }
        if (itemId === 'repository-tree-create-folder') {
            createFolder();
            return;
        }
        if (!uploadActionsAvailable) return;
        if (itemId === 'repository-tree-upload-destination-select') {
            void selectUploadDestination();
            return;
        }
        if (itemId === 'repository-tree-upload-files') {
            if (Platform.OS === 'web') {
                const isCurrent = captureCurrentUploadAcquisition();
                if (!isCurrent()) return;
                pickedUploadSelectionRef.current = { destinationDir: uploadDestinationDir, isCurrent };
                webFileInputRef.current?.click();
                return;
            }
            void startNativeUploads(uploadDestinationDir, captureCurrentUploadAcquisition());
        }
        if (itemId === 'repository-tree-upload-folder') {
            if (Platform.OS !== 'web') return;
            const isCurrent = captureCurrentUploadAcquisition();
            if (!isCurrent()) return;
            pickedUploadSelectionRef.current = { destinationDir: uploadDestinationDir, isCurrent };
            webFolderInputRef.current?.click();
        }
    }, [captureCurrentUploadAcquisition, createFile, createFolder, selectUploadDestination, startNativeUploads, uploadActionsAvailable, uploadDestinationDir]);

    // The pane header is just "Files" with the + menu as its trailing action (user ruling over lab H1: no
    // live line); the one change count lives on the Changed only chip. Outside a header-owning pane (the
    // link picker) nothing is published.
    const machineName = useSessionMachineName(props.sessionId, workspaceScope?.serverId ?? props.serverId);
    const changedCount = showChangedOnly && scmSnapshot?.repo.isRepo === true ? selectScmChangedFiles(scmSnapshot).length : null;
    // The menu reads its handlers through a ref, so the header action keeps one identity while the
    // tree underneath changes (expanding a folder must not re-publish the header).
    const createMenuSelectRef = React.useRef(onSelectCreateMenuItem);
    createMenuSelectRef.current = onSelectCreateMenuItem;
    const selectCreateMenuItem = React.useCallback((itemId: RepositoryTreeCreateMenuItemId) => createMenuSelectRef.current(itemId), []);
    const uploadDestinationLabel = uploadDestinationDir || rootLabel;
    const headerAction = React.useMemo(() => (
        <RepositoryTreeCreateMenu
            createEnabled={allowCreateActions}
            uploadEnabled={uploadActionsAvailable}
            isWeb={Platform.OS === 'web'}
            uploadDestinationLabel={uploadDestinationLabel}
            onSelect={selectCreateMenuItem}
        />
    ), [allowCreateActions, selectCreateMenuItem, uploadActionsAvailable, uploadDestinationLabel]);
    usePaneHeaderSlotContent(React.useMemo(() => ({ action: headerAction }), [headerAction]));

    const canCollapseAll = !showChangedOnly && expandedPaths.length > 0;

    const repositoryTreeTheme = React.useMemo(() => theme, [
        theme.colors.state.danger.foreground,
        theme.colors.state.neutral.foreground,
        theme.colors.state.success.foreground,
        theme.colors.surface.base,
        theme.colors.surface.pressed,
        theme.colors.text.link,
        theme.colors.text.secondary,
    ]);

    const handleShowAllRepositoryFiles = React.useCallback(() => {
        setShowChangedOnly(false);
    }, []);

    const handleSearchFilePress = React.useCallback((file: FileItem) => {
        props.onOpenFile(file.fullPath);
    }, [props.onOpenFile]);

    const handleSearchFilePressPinned = React.useCallback((file: FileItem) => {
        (props.onOpenFilePinned ?? props.onOpenFile)(file.fullPath);
    }, [props.onOpenFile, props.onOpenFilePinned]);

    const dropZoneContent = React.useMemo(() => (
        <>
            {withoutFolder && workspaceScope && !shouldShowSearchResults ? <SessionFilesRootHeading label={rootLabel} /> : null}
            <View style={repositoryTreeBrowserStyles.content}>
                {shouldShowSearchResults ? (
                    <SearchResultsList
                        workspaceScope={workspaceScope}
                        fileHref={fileHref}
                        theme={repositoryTreeTheme}
                        isSearching={isSearching}
                        searchQuery={searchQuery}
                        searchResults={searchResults}
                        searchResultsQuery={fileQuery.resultQuery}
                        searchError={Boolean(fileQuery.error)}
                        hasMore={fileQuery.hasMore}
                        onRetry={fileQuery.retry}
                        onFolderPress={handleSearchFolderPress}
                        onFilePress={handleSearchFilePress}
                        onFilePressPinned={handleSearchFilePressPinned}
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                        scrollEventThrottle={16}
                    />
                ) : workspaceScope ? (
                    <WorkspaceRepositoryTreeList
                        fileHref={fileHref}
                        theme={repositoryTreeTheme}
                        scope={workspaceScope}
                        reloadToken={treeReloadNonce}
                        detailsMode={detailsMode}
                        visibilityMode={visibilityMode}
                        revealedPaths={revealedPaths}
                        revealRequest={latestRequest}
                        onGitIgnoreAvailableChange={setGitIgnoreAvailable}
                        webFileDropEnabled={uploadActionsAvailable && Platform.OS === 'web'}
                        webDropHoverPath={webDropState.dropHoverPath}
                        expandedPaths={expandedPaths}
                        onExpandedPathsChange={handleExpandedPathsChange}
                        onOpenFile={handleTreeOpenFile}
                        onOpenFilePinned={handleTreeOpenFilePinned}
                        scmSnapshot={scmSnapshot}
                        changedOnly={showChangedOnly}
                        onShowAllFiles={handleShowAllRepositoryFiles}
                        selectedPath={props.selectedPath ?? null}
                        machineName={machineName}
                        showInlineLoadingHeader={false}
                        onRootLoadingChange={setTreeRootLoading}
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                        scrollEventThrottle={16}
                        renderRowActions={renderRowActions}
                    />
                ) : (
                    <View style={repositoryTreeBrowserStyles.root}>
                        <SourceControlUnavailableState onRetry={refresh} />
                    </View>
                )}
                <RepositoryTreeDropOverlay
                    visible={webDropState.fileDragActive}
                    destinationLabel={webDropState.dropDestinationDir || rootLabel}
                />
                <ScrollEdgeFades
                    color={repositoryTreeTheme.colors.surface.base}
                    size={18}
                    edges={scrollFades.visibility}
                />
                <ScrollEdgeIndicators
                    edges={scrollFades.visibility}
                    color={repositoryTreeTheme.colors.text.secondary}
                    size={14}
                    opacity={0.35}
                />
            </View>
            <RepositoryTreeTransferStatusBar
                uploadState={transfers.uploadState}
                downloadState={transfers.downloadState}
                onCancelUploads={transfers.cancelUploads}
                onCancelDownload={transfers.cancelDownload}
            />
        </>
    ), [
        detailsMode,
        expandedPaths,
        rootLabel,
        withoutFolder,
        handleExpandedPathsChange,
        visibilityMode,
        revealedPaths,
        latestRequest,
        machineName,
        props.selectedPath,
        setGitIgnoreAvailable,
        handleTreeOpenFile,
        handleTreeOpenFilePinned,
        handleSearchFolderPress,
        handleSearchFilePress,
        handleSearchFilePressPinned,
        handleShowAllRepositoryFiles,
        isSearching,
        props.onOpenFile,
        props.onOpenFilePinned,
        props.sessionId,
        refresh,
        renderRowActions,
        repositoryTreeTheme,
        scmSnapshot,
        scrollFades.onContentSizeChange,
        scrollFades.onScroll,
        scrollFades.onViewportLayout,
        scrollFades.visibility,
        searchQuery,
        searchResults,
        fileQuery.resultQuery,
        fileQuery.error,
        fileQuery.hasMore,
        fileQuery.retry,
        setSearchQuery,
        shouldShowSearchResults,
        showChangedOnly,
        transfers.cancelDownload,
        transfers.cancelUploads,
        transfers.downloadState,
        transfers.uploadState,
        treeReloadNonce,
        webDropState.dropDestinationDir,
        webDropState.dropHoverPath,
        webDropState.fileDragActive,
        webDropState.onDropTargetChange,
        workspaceScope,
    ]);

    return (
        <View style={repositoryTreeBrowserStyles.root}>
            {showSearchBar ? (
                <RepositoryTreeToolbar
                    testIDPrefix="repository-tree"
                    searchValue={searchQuery}
                    onSearchValueChange={setSearchQuery}
                    changedOnly={showChangedOnly}
                    changedCount={changedCount}
                    onChangedOnlyChange={setShowChangedOnly}
                    detailsMode={detailsMode}
                    onDetailsModeChange={setDetailsMode}
                    onCollapseAll={canCollapseAll ? collapseAll : null}
                    onRefresh={refresh}
                    refreshing={treeRootLoading}
                    onRequestClose={props.onRequestClose}
                />
            ) : null}
            {!showChangedOnly && !shouldShowSearchResults ? <RepositoryTreeVisibilityControl mode={visibilityMode} available={gitIgnoreAvailable} onChange={setVisibilityMode} /> : null}
            {Platform.OS === 'web' ? (
                <>
                    <input
                        data-testid="repository-tree-upload-input-files"
                        ref={webFileInputRef}
                        type="file"
                        style={{ display: 'none' }}
                        multiple
                        onChange={(e) => {
                            const selection = pickedUploadSelectionRef.current;
                            pickedUploadSelectionRef.current = null;
                            const files = Array.from(e.target.files ?? []);
                            if (files.length > 0 && selection?.isCurrent()) {
                                void startWebUploads(files, selection.destinationDir);
                            }
                            e.target.value = '';
                        }}
                    />
                    {React.createElement('input', {
                        'data-testid': 'repository-tree-upload-input-folder',
                        ref: setWebFolderInputRef,
                        type: 'file',
                        style: { display: 'none' },
                        multiple: true,
                        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                            const selection = pickedUploadSelectionRef.current;
                            pickedUploadSelectionRef.current = null;
                            const files = Array.from(e.target.files ?? []);
                            if (files.length > 0 && selection?.isCurrent()) {
                                void startWebUploads(files, selection.destinationDir);
                            }
                            e.target.value = '';
                        },
                    })}
                </>
            ) : null}
            <WebDropTargetView testID="repository-tree-drop-zone" style={repositoryTreeBrowserStyles.dropZone} {...dropZoneHandlersWithRoot}>
                {dropZoneContent}
            </WebDropTargetView>
        </View>
    );
});
