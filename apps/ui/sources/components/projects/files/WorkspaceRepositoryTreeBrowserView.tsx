import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ChangedFilesTreeList } from '@/components/workspaces/files/repositoryTree/ChangedFilesTreeList';
import { SearchResultsList } from '@/components/workspaces/files/repositoryTree/SearchResultsList';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FileBrowserToolbarIconButton } from '@/components/ui/filesystemBrowser/FileBrowserToolbar';
import { FilesystemBrowserToolbarChrome, type FilesystemBrowserToolbarAction } from '@/components/ui/filesystemBrowser/FilesystemBrowserToolbarChrome';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { Modal } from '@/modal';
import { t } from '@/text';

import { computeExpandedPathsForReveal } from '@/components/workspaces/files/repositoryTree/computeExpandedPathsForReveal';
import { clearCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { searchWorkspaceFiles, workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { workspaceCreateDirectory, workspaceWriteFile } from '@/sync/ops/workspaceFileSystem';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { storage, useMachine, useWorkspaceRepositoryTreeExpandedPaths } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { useWorkspaceFileTransfers, type WorkspaceUploadEntry } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
import { RepositoryTreeDropOverlay } from '@/components/workspaces/files/repositoryTree/RepositoryTreeDropOverlay';
import { RepositoryTreeTransferStatusBar } from '@/components/workspaces/files/repositoryTree/RepositoryTreeTransferStatusBar';
import { WebDropTargetView } from '@/components/workspaces/files/repositoryTree/WebDropTargetView';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import { readWebDroppedEntries } from '@/utils/files/webDroppedEntries';
import { nativePickFiles, type NativePickedFile } from '@/utils/files/nativePickFiles';
import { applyWebDirectoryInputAttributes } from '@/utils/files/applyWebDirectoryInputAttributes';
import { showUploadConflictResolutionDialog } from '@/components/workspaces/files/repositoryTree/showUploadConflictResolutionDialog';
import { shouldUseRepositoryRootDropTarget } from '@/components/workspaces/files/repositoryTree/shouldUseRepositoryRootDropTarget';
import { createRepositoryTreeUploadMenuConfig } from '@/components/workspaces/files/repositoryTree/createRepositoryTreeUploadMenuConfig';
import { promptRepositoryUploadDestination } from '@/components/workspaces/files/repositoryTree/promptRepositoryUploadDestination';
import { RepositoryTreeRowActionsMenu } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRowActionsMenu';
import { useWorkspaceRepositoryTreeWebDropState } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeWebDropState';
import { useWorkspaceRepositoryTreeRowActions } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeRowActions';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { resolveTransferAvailability } from '@/sync/domains/transfers/runtime/transferRuntime';
import { WorkspaceRepositoryTreeList, type WorkspaceRepositoryTreeWebDropTarget } from './WorkspaceRepositoryTreeList';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

export type WorkspaceRepositoryTreeBrowserViewProps = Readonly<{
    /**
     * The workspace, as ONE identity. This used to be a `workspaceCacheKey` alongside a
     * separate `machineId`/`rootPath`/`serverId` address, and this component is where the two
     * came apart: it passed the server-scoped key while calling the file search without the
     * server, so the index was built through the ACTIVE server and filed under the ADDRESSED
     * server's key — poisoning the entry the composer then read.
     */
    scope: WorkspaceScopeBase;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    density?: 'panel' | 'screen' | 'modal';
    searchQuery?: string;
    onSearchQueryChange?: (value: string) => void;
    showSearchBar?: boolean;
    onRequestClose?: () => void;
    scmSnapshot?: ScmWorkingSnapshot | null;
    expandedPaths?: readonly string[];
    onExpandedPathsChange?: (paths: string[]) => void;
    onWebDropTargetChange?: ((target: WorkspaceRepositoryTreeWebDropTarget) => void) | null;
    webDropHoverPath?: string | null;
    renderRowActions?: React.ComponentProps<typeof WorkspaceRepositoryTreeList>['renderRowActions'];
}>;

type ToolbarActionId =
    | 'workspace-repository-tree-filter-changed'
    | 'workspace-repository-tree-toggle-details'
    | 'workspace-repository-tree-upload'
    | 'workspace-repository-tree-create-file'
    | 'workspace-repository-tree-create-folder'
    | 'workspace-repository-tree-clear-search'
    | 'workspace-repository-tree-refresh'
    | 'workspace-repository-tree-collapse-all'
    | 'workspace-repository-tree-close';

type ToolbarActionConfig = FilesystemBrowserToolbarAction;

export const WorkspaceRepositoryTreeBrowserView = React.memo((props: WorkspaceRepositoryTreeBrowserViewProps) => {
    const { theme } = useUnistyles();
    const [showChangedOnly, setShowChangedOnly] = React.useState(false);
    const [detailsMode, setDetailsMode] = React.useState(false);
    const [treeReloadNonce, setTreeReloadNonce] = React.useState(0);
    const [treeRootLoading, setTreeRootLoading] = React.useState(false);
    const [uploadMenuOpen, setUploadMenuOpen] = React.useState(false);
    const [uploadDestinationDir, setUploadDestinationDir] = React.useState('');

    // Stabilized on the three FIELDS: several hosts build this prop inline, and the search
    // effect / row actions below key on the scope OBJECT. A fresh literal every render would
    // re-run them every render — the primitive props they used to depend on could not.
    const workspaceScope = React.useMemo(
        () => props.scope,
        [props.scope.serverId, props.scope.machineId, props.scope.rootPath],
    );
    const workspaceScmController = useWorkspaceScmSnapshotController(props.scmSnapshot === undefined ? workspaceScope : null);
    const effectiveScmSnapshot = props.scmSnapshot ?? workspaceScmController.snapshot ?? null;
    const machine = useMachine(workspaceScope.machineId);
    const machineRpcTargetAvailable = Boolean(machine && isMachineOnline(machine));
    const serverSnapshot = useServerFeaturesSnapshotForServerId(workspaceScope.serverId, {
        enabled: Boolean(workspaceScope.serverId) && machineRpcTargetAvailable,
    });
    const machineTransferEnabled = serverSnapshot.status === 'ready'
        ? resolveTransferAvailability({
            serverFeatures: serverSnapshot.features,
            directPeerRoute: { status: 'unknown' },
            machineRpcDirectRoute: { status: 'unknown' },
        }).machineTransferEnabled
        : false;
    const transferActionsAvailable = machineTransferEnabled && machineRpcTargetAvailable;

    const workspaceExpandedPaths = useWorkspaceRepositoryTreeExpandedPaths(workspaceScope);

    const expandedPaths = props.expandedPaths ?? workspaceExpandedPaths;
    const setExpandedPaths = props.onExpandedPathsChange
        ?? ((paths: string[]) => storage.getState().setWorkspaceRepositoryTreeExpandedPaths(workspaceScope, paths));

    const [uncontrolledSearchQuery, setUncontrolledSearchQuery] = React.useState('');
    const searchQuery = props.searchQuery ?? uncontrolledSearchQuery;
    const setSearchQuery = props.onSearchQueryChange ?? setUncontrolledSearchQuery;

    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const showSearchBar = props.showSearchBar !== false;
    const webFileInputRef = React.useRef<HTMLInputElement | null>(null);
    const webFolderInputRef = React.useRef<HTMLInputElement | null>(null);
    const setWebFolderInputRef = React.useCallback((node: HTMLInputElement | null) => {
        webFolderInputRef.current = node;
        applyWebDirectoryInputAttributes(node);
    }, []);

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
                    // One scope: the index's key and the server it is read through can no
                    // longer name different workspaces. This call site is why the owner's
                    // signature was contracted — it used to pass the server-scoped key while
                    // routing without the server.
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
    }, [searchQuery, showChangedOnly, treeReloadNonce, workspaceScope]);

    const shouldShowSearchResults = !showChangedOnly && searchQuery.trim().length > 0;
    const canClearSearch = searchQuery.length > 0;

    React.useEffect(() => {
        if (shouldShowSearchResults || showChangedOnly) {
            setTreeRootLoading(false);
        }
    }, [shouldShowSearchResults, showChangedOnly]);

    const refresh = React.useCallback(() => {
        workspaceFileSearchCache.clearCache(workspaceScope);
        const workspaceCacheKey = tryBuildWorkspaceCacheKey(workspaceScope);
        if (workspaceCacheKey) {
            clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey });
        }
        setTreeReloadNonce((n) => n + 1);
        if (props.scmSnapshot === undefined) {
            void workspaceScmController.refresh();
        }
    }, [props.scmSnapshot, workspaceScmController, workspaceScope]);

    const collapseAll = React.useCallback(() => {
        setExpandedPaths([]);
    }, [setExpandedPaths]);

    const allowCreateActions = React.useMemo(() => (
        Boolean(workspaceScope.machineId.trim() && workspaceScope.rootPath.trim())
    ), [workspaceScope]);
    const webDropState = useWorkspaceRepositoryTreeWebDropState({
        enabled: transferActionsAvailable && Platform.OS === 'web',
        expandedPaths,
        onExpandedPathsChange: setExpandedPaths,
    });

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

            const res = await workspaceWriteFile(workspaceScope, path, '', null);
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('files.createFileFailed'));
                return;
            }

            const nextExpanded = computeExpandedPathsForReveal({
                expandedPaths,
                fullPath: path,
            });
            setExpandedPaths(nextExpanded);
            refresh();
            (props.onOpenFilePinned ?? props.onOpenFile)(path);
        })();
    }, [allowCreateActions, expandedPaths, props.onOpenFile, props.onOpenFilePinned, refresh, setExpandedPaths, workspaceScope]);

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

            const res = await workspaceCreateDirectory(workspaceScope, directoryPath);
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('files.createFolderFailed'));
                return;
            }

            const nextExpanded = computeExpandedPathsForReveal({
                expandedPaths,
                fullPath: `${directoryPath}/.placeholder`,
            });
            const withDir = nextExpanded.includes(directoryPath) ? nextExpanded : [...nextExpanded, directoryPath];
            setExpandedPaths(withDir);
            refresh();
        })();
    }, [allowCreateActions, expandedPaths, refresh, setExpandedPaths, workspaceScope]);

    const transfers = useWorkspaceFileTransfers({
        workspaceScope,
        onResolveUploadConflicts: showUploadConflictResolutionDialog,
        onAfterUploadSuccess: refresh,
    });
    const rowActions = useWorkspaceRepositoryTreeRowActions({
        workspaceScope,
        writeActionsEnabled: allowCreateActions,
        expandedPaths,
        onExpandedPathsChange: setExpandedPaths,
        onRequestRefresh: refresh,
        onRequestDownload: (params) => transfers.startDownload(params),
    });

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
    }, [transfers]);

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
    }, [transfers, uploadDestinationDir]);

    const selectUploadDestination = React.useCallback(async () => {
        const nextDestination = await promptRepositoryUploadDestination(uploadDestinationDir);
        if (nextDestination === null) return;
        setUploadDestinationDir(nextDestination);
    }, [uploadDestinationDir]);

    const uploadMenuConfig = React.useMemo(() => createRepositoryTreeUploadMenuConfig({
        uploadActionsAvailable: transferActionsAvailable,
        isWeb: Platform.OS === 'web',
    }), [transferActionsAvailable]);

    const uploadMenuItems = React.useMemo(() => [
        {
            id: 'repository-tree-upload-destination-select',
            title: t('settingsAttachments.workspaceDirectory.uploadsDirectory.title'),
            subtitle: uploadDestinationDir || t('files.projectRoot'),
            category: t('common.path'),
            icon: <Icon name="folder-open" size={16} color={theme.colors.text.secondary} />,
            disabled: !transferActionsAvailable,
        },
        ...uploadMenuConfig.items.map((item) => ({
            id: item.id,
            title: t(item.titleKey),
            subtitle: uploadDestinationDir || t('files.projectRoot'),
            category: t('files.toolbar.upload'),
            icon: <Icon name={item.iconName} size={16} color={theme.colors.text.secondary} />,
            disabled: item.disabled,
        })),
    ], [theme.colors.text.secondary, transferActionsAvailable, uploadDestinationDir, uploadMenuConfig.items]);

    const onSelectUploadMenuItem = React.useCallback((itemId: string) => {
        setUploadMenuOpen(false);
        if (!transferActionsAvailable) return;
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
    }, [selectUploadDestination, startNativeUploads, transferActionsAvailable]);

    const dropZoneHandlers = useWebFileDropZone({
        enabled: transferActionsAvailable && Platform.OS === 'web',
        onFileDragActiveChange: webDropState.onFileDragActiveChange,
        onFilesDropped: async (event: any) => {
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
        },
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
    }), [dropZoneHandlers, webDropState]);

    const toolbarActions = React.useMemo((): ToolbarActionConfig[] => {
        const actions: ToolbarActionConfig[] = [
            {
                id: 'workspace-repository-tree-filter-changed',
                priority: 1,
                order: 0,
                icon: <Icon name="funnel-simple" size={16} color={showChangedOnly ? theme.colors.text.link : theme.colors.text.secondary} />,
                menuIcon: 'funnel-simple',
                accessibilityLabel: t('files.toolbar.changedFiles'),
                selected: showChangedOnly,
                onPress: () => setShowChangedOnly((prev) => !prev),
            },
            {
                id: 'workspace-repository-tree-toggle-details',
                priority: 2,
                order: 1,
                icon: <Icon name="list" size={16} color={detailsMode ? theme.colors.text.link : theme.colors.text.secondary} />,
                menuIcon: 'list',
                accessibilityLabel: t('common.details'),
                selected: detailsMode,
                onPress: () => setDetailsMode((v) => !v),
            },
            {
                id: 'workspace-repository-tree-upload',
                priority: 3,
                order: 2,
                icon: <Icon name="cloud-arrow-up" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'cloud-arrow-up',
                accessibilityLabel: t('files.toolbar.upload'),
                disabled: !transferActionsAvailable,
                selected: uploadDestinationDir.length > 0,
                onPress: () => setUploadMenuOpen(true),
            },
            {
                id: 'workspace-repository-tree-create-file',
                priority: 5,
                order: 3,
                icon: <Icon name="file-text" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'file-text',
                accessibilityLabel: t('files.createFileA11y'),
                disabled: !allowCreateActions,
                onPress: createFile,
            },
            {
                id: 'workspace-repository-tree-create-folder',
                priority: 6,
                order: 4,
                icon: <Icon name="folder" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'folder',
                accessibilityLabel: t('files.createFolderA11y'),
                disabled: !allowCreateActions,
                onPress: createFolder,
            },
            {
                id: 'workspace-repository-tree-refresh',
                priority: 10,
                order: 5,
                icon: treeRootLoading ? (
                    <ActivitySpinner testID="workspace-repository-tree-refresh-loading" size="small" color={theme.colors.text.secondary} />
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
                id: 'workspace-repository-tree-collapse-all',
                priority: 0,
                order: 6,
                icon: <Icon name="arrows-in" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'arrows-in',
                accessibilityLabel: t('files.repositoryCollapseAll'),
                onPress: collapseAll,
            });
        }

        if (props.onRequestClose) {
            actions.push({
                id: 'workspace-repository-tree-close',
                priority: 8,
                order: 7,
                icon: <Icon name="x" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'x',
                accessibilityLabel: t('common.close'),
                onPress: props.onRequestClose,
            });
        }

        if (canClearSearch) {
            actions.push({
                id: 'workspace-repository-tree-clear-search',
                priority: 4,
                order: 8,
                icon: <Icon name="x" size={16} color={theme.colors.text.secondary} />,
                menuIcon: 'x',
                accessibilityLabel: t('files.clearSearchA11y'),
                onPress: () => setSearchQuery(''),
            });
        }

        return actions;
    }, [
        allowCreateActions,
        canClearSearch,
        collapseAll,
        createFile,
        createFolder,
        detailsMode,
        expandedPaths.length,
        props.onRequestClose,
        refresh,
        setSearchQuery,
        showChangedOnly,
        treeRootLoading,
        transferActionsAvailable,
        uploadDestinationDir.length,
        theme.colors.text.link,
        theme.colors.text.secondary,
    ]);

    const buildOverflowItems = React.useCallback((hiddenActions: readonly FilesystemBrowserToolbarAction[]): ItemAction[] => {
        const hiddenItems = hiddenActions
            .filter((action) => action.id !== 'workspace-repository-tree-upload')
            .map((action) => ({
                id: action.id,
                title: action.accessibilityLabel,
                icon: action.menuIcon,
                onPress: action.onPress,
                disabled: action.disabled,
            }));
        if (!hiddenActions.some((action) => action.id === 'workspace-repository-tree-upload')) {
            return hiddenItems;
        }

        const uploadOverflowItems: ItemAction[] = [
            {
                id: 'repository-tree-upload-destination-select',
                title: t('settingsAttachments.workspaceDirectory.uploadsDirectory.title'),
                icon: 'folder-open',
                disabled: !transferActionsAvailable,
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
    }, [onSelectUploadMenuItem, transferActionsAvailable, uploadMenuConfig.items]);

    const renderToolbarIconButton = React.useCallback((action: ToolbarActionConfig) => {
        if (action.id === 'workspace-repository-tree-upload') {
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
                            testID="workspace-repository-tree-upload"
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

    const defaultRenderRowActions = React.useCallback<NonNullable<WorkspaceRepositoryTreeBrowserViewProps['renderRowActions']>>((node) => {
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
                downloadActionsEnabled={transferActionsAvailable && (transferSizeBytes == null || transferSizeBytes >= 0)}
                onSelect={(itemId) => rowActions.onSelectRowMenuItem({ path: node.path, type: nodeKind }, itemId)}
            />
        );
    }, [allowCreateActions, rowActions, transferActionsAvailable]);

    const handleWebDropTargetChange = React.useCallback((target: WorkspaceRepositoryTreeWebDropTarget) => {
        webDropState.onDropTargetChange(target);
        props.onWebDropTargetChange?.(target);
    }, [props, webDropState]);

    return (
        <View style={{ flex: 1 }}>
            {showSearchBar ? (
                <FilesystemBrowserToolbarChrome
                    testID="repository-tree-toolbar"
                    searchTestID="repository-tree-search"
                    searchValue={searchQuery}
                    onSearchValueChange={setSearchQuery}
                    searchPlaceholder={t('files.searchPlaceholder')}
                    actions={toolbarActions}
                    buildOverflowItems={buildOverflowItems}
                    overflowTitle={t('common.moreActions')}
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
            <WebDropTargetView testID="repository-tree-drop-zone" style={{ flex: 1 }} {...dropZoneHandlersWithRoot}>
                <View style={{ flex: 1, position: 'relative' }}>
                    {shouldShowSearchResults ? (
                        <SearchResultsList
                            theme={theme}
                            isSearching={isSearching}
                            searchQuery={searchQuery}
                            searchResults={searchResults}
                            onFilePress={(file) => props.onOpenFile(file.fullPath)}
                            onFilePressPinned={(file) => (props.onOpenFilePinned ?? props.onOpenFile)(file.fullPath)}
                        />
                    ) : showChangedOnly && effectiveScmSnapshot?.repo.isRepo === true ? (
                        <ChangedFilesTreeList
                            theme={theme}
                            snapshot={effectiveScmSnapshot}
                            searchQuery={searchQuery}
                            onOpenFile={props.onOpenFile}
                            onOpenFilePinned={props.onOpenFilePinned}
                        />
                    ) : (
                        <WorkspaceRepositoryTreeList
                            theme={theme}
                            scope={workspaceScope}
                            reloadToken={treeReloadNonce}
                            detailsMode={detailsMode}
                            expandedPaths={expandedPaths}
                            onExpandedPathsChange={(paths) => setExpandedPaths(paths)}
                            onOpenFile={props.onOpenFile}
                            onOpenFilePinned={props.onOpenFilePinned}
                            scmSnapshot={effectiveScmSnapshot}
                            onWebDropTargetChange={Platform.OS === 'web' ? handleWebDropTargetChange : null}
                            webDropHoverPath={props.webDropHoverPath ?? webDropState.dropHoverPath}
                            renderRowActions={props.renderRowActions ?? defaultRenderRowActions}
                            showInlineLoadingHeader={false}
                            onRootLoadingChange={setTreeRootLoading}
                        />
                    )}
                    <RepositoryTreeDropOverlay
                        visible={webDropState.fileDragActive}
                        destinationLabel={webDropState.dropDestinationDir || t('files.projectRoot')}
                    />
                </View>
                <RepositoryTreeTransferStatusBar
                    uploadState={transfers.uploadState}
                    downloadState={transfers.downloadState}
                    onCancelUploads={transfers.cancelUploads}
                    onCancelDownload={transfers.cancelDownload}
                />
            </WebDropTargetView>
        </View>
    );
});
