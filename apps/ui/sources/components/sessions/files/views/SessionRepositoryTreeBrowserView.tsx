import * as React from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SearchResultsList } from '@/components/workspaces/files/repositoryTree/SearchResultsList';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { FileBrowserToolbarIconButton } from '@/components/ui/filesystemBrowser/FileBrowserToolbar';
import { FilesystemBrowserToolbarChrome, type FilesystemBrowserToolbarAction } from '@/components/ui/filesystemBrowser/FilesystemBrowserToolbarChrome';
import { RepositoryTreeDropOverlay } from '@/components/workspaces/files/repositoryTree/RepositoryTreeDropOverlay';
import { RepositoryTreeTransferStatusBar } from '@/components/workspaces/files/repositoryTree/RepositoryTreeTransferStatusBar';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionFileUploadAvailability } from '@/components/sessions/files/useSessionFileUploadAvailability';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { storage, useSessionProjectScmSnapshot, useSessionRepositoryTreeExpandedPaths } from '@/sync/domains/state/storage';
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
import { shouldUseRepositoryRootDropTarget } from '@/components/workspaces/files/repositoryTree/shouldUseRepositoryRootDropTarget';
import { createRepositoryTreeUploadMenuConfig } from '@/components/workspaces/files/repositoryTree/createRepositoryTreeUploadMenuConfig';
import { useRepositoryTreeWebDropState } from '@/components/sessions/files/repositoryTree/useRepositoryTreeWebDropState';
import { promptRepositoryUploadDestination } from '@/components/workspaces/files/repositoryTree/promptRepositoryUploadDestination';
import { RepositoryTreeChangedFilesPane } from '@/components/sessions/files/views/repositoryTreeBrowser/RepositoryTreeChangedFilesPane';
import { WorkspaceRepositoryTreeList } from '@/components/projects/files/WorkspaceRepositoryTreeList';
import { clearCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { searchWorkspaceFiles, workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { RepositoryTreeRowActionsMenu } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRowActionsMenu';
import { useRepositoryTreeRowActions } from '@/components/sessions/files/repositoryTree/useRepositoryTreeRowActions';
import { useSessionFileTransferAvailabilityState } from '@/components/sessions/files/useSessionFileTransferAvailability';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { workspaceCreateDirectory, workspaceWriteFile } from '@/sync/ops/workspaceFileSystem';
import { SourceControlUnavailableState } from '@/components/workspaces/scm/states';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

const Ionicons = SafeIonicons;

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
});

export type SessionRepositoryTreeBrowserViewProps = Readonly<{
    sessionId: string;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    density?: 'panel' | 'screen' | 'modal';
    searchQuery?: string;
    onSearchQueryChange?: (value: string) => void;
    showSearchBar?: boolean;
    onRequestClose?: () => void;
}>;

type ToolbarActionId =
    | 'repository-tree-filter-changed'
    | 'repository-tree-toggle-details'
    | 'repository-tree-upload'
    | 'repository-tree-create-file'
    | 'repository-tree-create-folder'
    | 'repository-tree-clear-search'
    | 'repository-tree-refresh'
    | 'repository-tree-collapse-all'
    | 'repository-tree-close';

type ToolbarActionConfig = FilesystemBrowserToolbarAction;

export const SessionRepositoryTreeBrowserView = React.memo((props: SessionRepositoryTreeBrowserViewProps) => {
    const { theme } = useUnistyles();
    const { machineRpcTargetAvailable } = useSessionMachineReachability(props.sessionId);
    const workspaceTarget = useSessionWorkspaceTarget(props.sessionId);
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
    const scmSnapshot = useSessionProjectScmSnapshot(props.sessionId);
    const didWarmScmRef = React.useRef<string | null>(null);

    const [uncontrolledSearchQuery, setUncontrolledSearchQuery] = React.useState('');
    const searchQuery = props.searchQuery ?? uncontrolledSearchQuery;
    const setSearchQuery = props.onSearchQueryChange ?? setUncontrolledSearchQuery;
    const [showChangedOnly, setShowChangedOnly] = React.useState(false);
    const [detailsMode, setDetailsMode] = React.useState(false);
    const [treeReloadNonce, setTreeReloadNonce] = React.useState(0);
    const [treeRootLoading, setTreeRootLoading] = React.useState(false);
    const [uploadMenuOpen, setUploadMenuOpen] = React.useState(false);
    const [uploadDestinationDir, setUploadDestinationDir] = React.useState('');
    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const showSearchBar = props.showSearchBar !== false;
    const hasWorkspaceTarget = workspaceTarget !== null;
    const allowCreateActions = machineRpcTargetAvailable && hasWorkspaceTarget;
    const uploadActionsAvailable = useSessionFileUploadAvailability(props.sessionId) && hasWorkspaceTarget;
    const webDropState = useRepositoryTreeWebDropState({
        sessionId: props.sessionId,
        enabled: allowCreateActions && Platform.OS === 'web',
        expandedPaths,
    });
    const webFileInputRef = React.useRef<HTMLInputElement | null>(null);
    const webFolderInputRef = React.useRef<HTMLInputElement | null>(null);
    const setWebFolderInputRef = React.useCallback((node: HTMLInputElement | null) => {
        webFolderInputRef.current = node;
        applyWebDirectoryInputAttributes(node);
    }, []);

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    React.useEffect(() => {
        if (!machineRpcTargetAvailable) return;
        const key = `${props.sessionId}:${treeReloadNonce}`;
        if (didWarmScmRef.current === key) return;
        didWarmScmRef.current = key;
        // Warm SCM snapshot so the file tree can display change badges even if the user
        // hasn't opened the Source control panel yet.
        scmStatusSync.invalidateFromUser(props.sessionId);
    }, [machineRpcTargetAvailable, props.sessionId, treeReloadNonce]);

    React.useEffect(() => {
        let cancelled = false;
        const q = searchQuery.trim();
        if (showChangedOnly) {
            setSearchResults([]);
            setIsSearching(false);
            return;
        }
        if (!q) {
            setSearchResults([]);
            setIsSearching(false);
            return;
        }

        setIsSearching(true);
        const handle = setTimeout(() => {
            void (async () => {
                try {
                    if (!workspaceScope) {
                        if (cancelled) return;
                        setSearchResults([]);
                        return;
                    }
                    const results = await searchWorkspaceFiles({
                        scope: workspaceScope,
                        query: q,
                        limit: 200,
                    });
                    if (cancelled) return;
                    setSearchResults(results);
                } finally {
                    if (cancelled) return;
                    setIsSearching(false);
                }
            })();
        }, 120);

        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }, [props.sessionId, searchQuery, showChangedOnly, treeReloadNonce, workspaceScope]);

    const shouldShowSearchResults = !showChangedOnly && searchQuery.trim().length > 0;
    const canClearSearch = searchQuery.length > 0;

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
        scmStatusSync.invalidateFromUser(props.sessionId);
        setTreeReloadNonce((n) => n + 1);
    }, [props.sessionId, workspaceScope]);

    const transfers = useWorkspaceFileTransfers({
        sessionId: props.sessionId,
        onResolveUploadConflicts: showUploadConflictResolutionDialog,
        onAfterUploadSuccess: refresh,
    });

    const transferAvailability = useSessionFileTransferAvailabilityState(props.sessionId);
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

    const renderRowActions = React.useCallback((node: Parameters<NonNullable<React.ComponentProps<typeof WorkspaceRepositoryTreeList>['renderRowActions']>>[0]) => {
        if (node.type !== 'file' && node.type !== 'directory') return null;
        const nodeKind: 'file' | 'directory' = node.type === 'file' ? 'file' : 'directory';
        const transferSizeBytes = node.type === 'file' && typeof node.sizeBytes === 'number'
            ? node.sizeBytes
            : null;
        return (
            <RepositoryTreeRowActionsMenu
                path={node.path}
                kind={nodeKind}
                disableWriteActions={!allowCreateActions}
                downloadActionsEnabled={canDownload(transferSizeBytes)}
                onSelect={(itemId) => rowActions.onSelectRowMenuItem({ path: node.path, type: nodeKind }, itemId)}
            />
        );
    }, [allowCreateActions, canDownload, rowActions]);

    const handleFilesDropped = React.useCallback(async (event: any) => {
        const dataTransfer = event?.dataTransfer;
        if (!dataTransfer) return;
        const dropped = await readWebDroppedEntries(dataTransfer as any);
        const entries: WorkspaceUploadEntry[] = dropped.map((entry) => ({
            kind: 'web',
            file: entry.file,
            relativePath: entry.relativePath,
        }));
        const res = await transfers.startUploads({ entries, destinationDir: webDropState.dropDestinationDir });
        if (!res.ok) {
            Modal.alert(t('common.error'), res.error);
        }
    }, [transfers.startUploads, webDropState.dropDestinationDir]);

    const dropZoneHandlers = useWebFileDropZone({
        enabled: allowCreateActions && Platform.OS === 'web',
        onFileDragActiveChange: webDropState.onFileDragActiveChange,
        onFilesDropped: handleFilesDropped,
    });

    const dropZoneHandlersWithRoot = React.useMemo(() => ({
        ...dropZoneHandlers,
        onDragEnter: (event: any) => {
            if (shouldUseRepositoryRootDropTarget(event)) {
                webDropState.setRootDropTarget();
            }
            dropZoneHandlers.onDragEnter(event);
        },
        onDragOver: (event: any) => {
            if (shouldUseRepositoryRootDropTarget(event)) {
                webDropState.setRootDropTarget();
            }
            dropZoneHandlers.onDragOver(event);
        },
    }), [dropZoneHandlers, webDropState.setRootDropTarget]);

    const collapseAll = React.useCallback(() => {
        storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, []);
    }, [props.sessionId]);

    const createFile = React.useCallback(() => {
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

            (props.onOpenFilePinned ?? props.onOpenFile)(path);
        })();
    }, [expandedPaths, props.onOpenFile, props.onOpenFilePinned, props.sessionId, refresh]);

    const createFolder = React.useCallback(() => {
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
            const withDir = nextExpanded.includes(directoryPath) ? nextExpanded : [...nextExpanded, directoryPath];
            storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, withDir);
            refresh();
        })();
    }, [expandedPaths, props.sessionId, refresh]);

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

    const startNativeUploads = React.useCallback(async () => {
        const picked = await nativePickFiles({ multiple: true });
        const nativePicked = picked.filter((p): p is Extract<NativePickedFile, { kind: 'native' }> => p.kind === 'native');
        if (nativePicked.length === 0) return;
        const entries: WorkspaceUploadEntry[] = nativePicked.map((p) => ({
            kind: 'native',
            uri: p.uri,
            name: p.name,
            sizeBytes: p.sizeBytes,
            mimeType: p.mimeType,
            relativePath: p.name,
        }));
        const res = await transfers.startUploads({ entries, destinationDir: uploadDestinationDir });
        if (!res.ok) {
            Modal.alert(t('common.error'), res.error);
        }
    }, [transfers.startUploads, uploadDestinationDir]);

    const selectUploadDestination = React.useCallback(async () => {
        const nextDestination = await promptRepositoryUploadDestination(uploadDestinationDir);
        if (nextDestination === null) return;
        setUploadDestinationDir(nextDestination);
    }, [uploadDestinationDir]);

    const uploadMenuConfig = React.useMemo(() => createRepositoryTreeUploadMenuConfig({
        uploadActionsAvailable,
        isWeb: Platform.OS === 'web',
    }), [uploadActionsAvailable]);

    const uploadMenuItems = React.useMemo(() => [
        {
            id: 'repository-tree-upload-destination-select',
            title: t('settingsAttachments.workspaceDirectory.uploadsDirectory.title'),
            subtitle: uploadDestinationDir || t('files.projectRoot'),
            category: t('common.path'),
            icon: <Icon name="folder-open" size={16} color={theme.colors.text.secondary} />,
            disabled: !uploadActionsAvailable,
        },
        ...uploadMenuConfig.items.map((item) => ({
            id: item.id,
            title: t(item.titleKey),
            subtitle: uploadDestinationDir || t('files.projectRoot'),
            category: t('files.toolbar.upload'),
            icon: <Icon name={item.iconName} size={16} color={theme.colors.text.secondary} />,
            disabled: item.disabled,
        })),
    ], [theme.colors.text.secondary, uploadActionsAvailable, uploadDestinationDir, uploadMenuConfig.items]);

    const onSelectUploadMenuItem = React.useCallback((itemId: string) => {
        setUploadMenuOpen(false);
        if (!uploadActionsAvailable) return;
        if (itemId === 'repository-tree-upload-destination-select') {
            void selectUploadDestination();
            return;
        }
        if (itemId === 'repository-tree-upload-files') {
            if (Platform.OS === 'web') {
                webFileInputRef.current?.click();
                return;
            }
            void startNativeUploads();
        }
        if (itemId === 'repository-tree-upload-folder') {
            if (Platform.OS !== 'web') return;
            webFolderInputRef.current?.click();
        }
    }, [selectUploadDestination, startNativeUploads, uploadActionsAvailable]);

    const toolbarActions = React.useMemo<ToolbarActionConfig[]>(() => {
        const actions: ToolbarActionConfig[] = [
            {
                id: 'repository-tree-filter-changed',
                priority: 1,
                order: 0,
                icon: <Icon name="funnel-simple" size={16} color={showChangedOnly ? theme.colors.text.link : theme.colors.text.secondary} />,
                menuIcon: 'funnel-simple',
                accessibilityLabel: t('files.toolbar.changedFiles'),
                selected: showChangedOnly,
                onPress: () => setShowChangedOnly((prev) => !prev),
            },
            {
                id: 'repository-tree-toggle-details',
                priority: 2,
                order: 1,
                icon: <Icon name="list" size={16} color={detailsMode ? theme.colors.text.link : theme.colors.text.secondary} />,
                menuIcon: 'list',
                accessibilityLabel: t('common.details'),
                selected: detailsMode,
                onPress: () => setDetailsMode((prev) => !prev),
            },
            {
                id: 'repository-tree-upload',
                priority: 3,
                order: 2,
                icon: <Icon name="cloud-arrow-up" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'cloud-arrow-up',
                accessibilityLabel: t('files.toolbar.upload'),
                disabled: !uploadActionsAvailable,
                selected: uploadDestinationDir.length > 0,
                onPress: () => setUploadMenuOpen(true),
            },
            {
                id: 'repository-tree-create-file',
                priority: 5,
                order: 3,
                icon: <Icon name="file-text" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'file-text',
                accessibilityLabel: t('files.createFileA11y'),
                disabled: !allowCreateActions,
                onPress: createFile,
            },
            {
                id: 'repository-tree-create-folder',
                priority: 6,
                order: 4,
                icon: <Icon name="folder" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'folder',
                accessibilityLabel: t('files.createFolderA11y'),
                disabled: !allowCreateActions,
                onPress: createFolder,
            },
            {
                id: 'repository-tree-clear-search',
                priority: 4,
                order: 5,
                icon: <Icon name="x" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'x',
                accessibilityLabel: t('files.clearSearchA11y'),
                onPress: () => setSearchQuery(''),
            },
            {
                id: 'repository-tree-refresh',
                priority: 10,
                order: 6,
                icon: treeRootLoading ? (
                    <ActivitySpinner testID="repository-tree-refresh-loading" size="small" color={theme.colors.text.secondary} />
                ) : (
                    <Icon name="arrows-clockwise" size={16} color={theme.colors.text.secondary} />
                ),
                menuIcon: 'arrow-clockwise',
                accessibilityLabel: t('common.refresh'),
                onPress: refresh,
            },
        ];

        if (expandedPaths.length > 0) {
            actions.push({
                id: 'repository-tree-collapse-all',
                priority: 0,
                order: 7,
                icon: <Icon name="arrows-in" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'arrows-in',
                accessibilityLabel: t('files.repositoryCollapseAll'),
                onPress: collapseAll,
            });
        }

        if (props.onRequestClose) {
            actions.push({
                id: 'repository-tree-close',
                priority: 8,
                order: 8,
                icon: <Icon name="x" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'x',
                accessibilityLabel: t('common.close'),
                onPress: props.onRequestClose,
            });
        }

        if (canClearSearch !== true) {
            return actions.filter((action) => action.id !== 'repository-tree-clear-search');
        }

        return actions;
    }, [
        allowCreateActions,
        uploadActionsAvailable,
        canClearSearch,
        collapseAll,
        createFile,
        createFolder,
        detailsMode,
        expandedPaths.length,
        refresh,
        setSearchQuery,
        showChangedOnly,
        treeRootLoading,
        uploadDestinationDir.length,
        props.onRequestClose,
        theme.colors.text.link,
        theme.colors.text.secondary,
    ]);

    const buildOverflowItems = React.useCallback((hiddenActions: readonly ToolbarActionConfig[]) => {
        const hiddenItems = hiddenActions
            .filter((action) => action.id !== 'repository-tree-upload')
            .map((action) => ({
                id: action.id,
                title: action.accessibilityLabel,
                icon: action.menuIcon,
                disabled: action.disabled,
                onPress: action.onPress,
            }));
        if (!hiddenActions.some((action) => action.id === 'repository-tree-upload')) {
            return hiddenItems;
        }

        const uploadOverflowItems: ItemAction[] = [
            {
                id: 'repository-tree-upload-destination-select',
                title: t('settingsAttachments.workspaceDirectory.uploadsDirectory.title'),
                icon: 'folder-open',
                disabled: !uploadActionsAvailable,
                onPress: () => onSelectUploadMenuItem('repository-tree-upload-destination-select'),
            },
            ...uploadMenuConfig.items.map((item) => ({
                id: item.id,
                title: t(item.titleKey),
                icon: item.iconName,
                disabled: item.disabled,
                onPress: () => onSelectUploadMenuItem(item.id),
            })),
        ];

        return [...uploadOverflowItems, ...hiddenItems];
    }, [onSelectUploadMenuItem, uploadActionsAvailable, uploadMenuConfig.items]);

    const renderToolbarIconButton = React.useCallback((action: ToolbarActionConfig) => {
        if (action.id === 'repository-tree-upload') {
            return (
                <DropdownMenu
                    key={action.id}
                    open={uploadMenuOpen}
                    onOpenChange={setUploadMenuOpen}
                    items={uploadMenuItems}
                    onSelect={onSelectUploadMenuItem}
                    matchTriggerWidth={uploadMenuConfig.matchTriggerWidth}
                    trigger={({ toggle }) => (
                        <FileBrowserToolbarIconButton
                            testID="repository-tree-upload"
                            accessibilityLabel={action.accessibilityLabel}
                            onPress={toggle}
                            selected={action.selected}
                            disabled={action.disabled}
                        >
                            {action.icon}
                        </FileBrowserToolbarIconButton>
                    )}
                />
            );
        }

        return (
            <FileBrowserToolbarIconButton
                key={action.id}
                testID={action.id}
                accessibilityLabel={action.accessibilityLabel}
                onPress={action.onPress}
                selected={action.selected}
                disabled={action.disabled}
            >
                {action.icon}
            </FileBrowserToolbarIconButton>
        );
    }, [onSelectUploadMenuItem, uploadMenuConfig.matchTriggerWidth, uploadMenuItems, uploadMenuOpen]);

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
            <View style={repositoryTreeBrowserStyles.content}>
                {showChangedOnly ? (
                    <RepositoryTreeChangedFilesPane
                        sessionId={props.sessionId}
                        scmSnapshot={scmSnapshot}
                        searchQuery={searchQuery}
                        onSearchQueryChange={setSearchQuery}
                        onShowAllRepositoryFiles={handleShowAllRepositoryFiles}
                        onOpenFile={props.onOpenFile}
                        onOpenFilePinned={props.onOpenFilePinned}
                    />
                ) : shouldShowSearchResults ? (
                    <SearchResultsList
                        theme={repositoryTreeTheme}
                        isSearching={isSearching}
                        searchQuery={searchQuery}
                        searchResults={searchResults}
                        onFilePress={handleSearchFilePress}
                        onFilePressPinned={handleSearchFilePressPinned}
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                        scrollEventThrottle={16}
                    />
                ) : workspaceScope ? (
                    <WorkspaceRepositoryTreeList
                        theme={repositoryTreeTheme}
                        scope={workspaceScope}
                        reloadToken={treeReloadNonce}
                        detailsMode={detailsMode}
                        onWebDropTargetChange={webDropState.onDropTargetChange}
                        webDropHoverPath={webDropState.dropHoverPath}
                        expandedPaths={expandedPaths}
                        onExpandedPathsChange={handleExpandedPathsChange}
                        onOpenFile={props.onOpenFile}
                        onOpenFilePinned={props.onOpenFilePinned}
                        scmSnapshot={scmSnapshot}
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
                    destinationLabel={webDropState.dropDestinationDir || t('files.projectRoot')}
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
        handleExpandedPathsChange,
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
                <FilesystemBrowserToolbarChrome
                    testID="repository-tree-toolbar"
                    searchTestID="repository-tree-search"
                    searchPlaceholder={t('files.searchPlaceholder')}
                    searchValue={searchQuery}
                    onSearchValueChange={setSearchQuery}
                    actions={toolbarActions}
                    buildOverflowItems={buildOverflowItems}
                    overflowTriggerTestID="repository-tree-toolbar-overflow"
                    renderActionNode={renderToolbarIconButton}
                />
            ) : null}
            {Platform.OS === 'web' ? (
                <>
                    <input
                        data-testid="repository-tree-upload-input-files"
                        ref={webFileInputRef}
                        type="file"
                        style={{ display: 'none' }}
                        multiple
                        onChange={(e) => {
                            const files = Array.from(e.target.files ?? []);
                            if (files.length > 0) {
                                void startWebUploads(files, uploadDestinationDir);
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
                            const files = Array.from(e.target.files ?? []);
                            if (files.length > 0) {
                                void startWebUploads(files, uploadDestinationDir);
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
