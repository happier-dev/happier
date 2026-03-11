import * as React from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';

import { RepositoryTreeList } from '@/components/sessions/files/content/RepositoryTreeList';
import { SearchResultsList } from '@/components/sessions/files/content/SearchResultsList';
import { ChangedFilesTreeList } from '@/components/sessions/files/content/ChangedFilesTreeList';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { RepositoryTreeDropOverlay } from '@/components/sessions/files/repositoryTree/RepositoryTreeDropOverlay';
import { RepositoryTreeTransferStatusBar } from '@/components/sessions/files/repositoryTree/RepositoryTreeTransferStatusBar';
import { WebDropTargetView } from '@/components/sessions/files/repositoryTree/WebDropTargetView';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { fileSearchCache, searchFiles } from '@/sync/domains/input/suggestionFile';
import { clearCachedRepositoryDirectoryEntries } from '@/sync/domains/input/repositoryDirectory';
import { storage, useSessionProjectScmSnapshot, useSessionRepositoryTreeExpandedPaths } from '@/sync/domains/state/storage';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { sessionCreateDirectory, sessionWriteFile } from '@/sync/ops';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { computeExpandedPathsForReveal } from '@/components/sessions/files/repositoryTree/computeExpandedPathsForReveal';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import { readWebDroppedEntries } from '@/utils/files/webDroppedEntries';
import { nativePickFiles } from '@/utils/files/nativePickFiles';
import { applyWebDirectoryInputAttributes } from '@/utils/files/applyWebDirectoryInputAttributes';
import { useWorkspaceFileTransfers, type WorkspaceUploadEntry } from '@/hooks/session/files/useWorkspaceFileTransfers';
import { showUploadConflictResolutionDialog } from '@/components/sessions/files/repositoryTree/showUploadConflictResolutionDialog';
import { shouldUseRepositoryRootDropTarget } from '@/components/sessions/files/repositoryTree/shouldUseRepositoryRootDropTarget';
import { createRepositoryTreeUploadMenuConfig } from '@/components/sessions/files/repositoryTree/createRepositoryTreeUploadMenuConfig';
import { useRepositoryTreeWebDropState } from '@/components/sessions/files/repositoryTree/useRepositoryTreeWebDropState';
import { promptRepositoryUploadDestination } from '@/components/sessions/files/views/promptRepositoryUploadDestination';

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

type ToolbarActionConfig = Readonly<{
    id: ToolbarActionId;
    priority: number;
    order: number;
    icon: React.ReactNode;
    menuIcon: React.ComponentProps<typeof Ionicons>['name'];
    accessibilityLabel: string;
    disabled?: boolean;
    selected?: boolean;
    onPress: () => void;
}>;

const TOOLBAR_HORIZONTAL_PADDING = 24;
const TOOLBAR_GAP = 8;
const TOOLBAR_BUTTON_FOOTPRINT = 34 + TOOLBAR_GAP;
const TOOLBAR_MIN_SEARCH_WIDTH = 180;
const TOOLBAR_MIN_VISIBLE_ACTIONS = 2;

function resolveVisibleToolbarActionIds(input: Readonly<{
    toolbarWidth: number | null;
    actions: ReadonlyArray<ToolbarActionConfig>;
}>): Set<ToolbarActionId> {
    if (input.toolbarWidth == null) {
        return new Set(input.actions.map((action) => action.id));
    }

    const availableActionSlots = Math.floor(
        Math.max(0, input.toolbarWidth - TOOLBAR_HORIZONTAL_PADDING - TOOLBAR_MIN_SEARCH_WIDTH + TOOLBAR_GAP)
        / TOOLBAR_BUTTON_FOOTPRINT,
    );

    if (availableActionSlots >= input.actions.length) {
        return new Set(input.actions.map((action) => action.id));
    }

    const visibleCount = Math.max(TOOLBAR_MIN_VISIBLE_ACTIONS, availableActionSlots - 1);
    const prioritized = [...input.actions]
        .sort((left, right) => left.priority - right.priority)
        .slice(0, Math.min(input.actions.length, visibleCount));

    return new Set(prioritized.map((action) => action.id));
}

const stylesheet = StyleSheet.create((theme) => ({
    toolbar: {
        position: 'relative',
        zIndex: 10,
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 8,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    searchInput: {
        flex: 1,
        height: 34,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 10,
        color: theme.colors.text,
        backgroundColor: theme.colors.surfaceHigh,
        ...Typography.default(),
        fontSize: 13,
    },
    iconButton: {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
}));

export const SessionRepositoryTreeBrowserView = React.memo((props: SessionRepositoryTreeBrowserViewProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { machineRpcTargetAvailable } = useSessionMachineReachability(props.sessionId);

    const expandedPaths = useSessionRepositoryTreeExpandedPaths(props.sessionId);
    const scmSnapshot = useSessionProjectScmSnapshot(props.sessionId);
    const didWarmScmRef = React.useRef<string | null>(null);

    const [uncontrolledSearchQuery, setUncontrolledSearchQuery] = React.useState('');
    const searchQuery = props.searchQuery ?? uncontrolledSearchQuery;
    const setSearchQuery = props.onSearchQueryChange ?? setUncontrolledSearchQuery;
    const [showChangedOnly, setShowChangedOnly] = React.useState(false);
    const [detailsMode, setDetailsMode] = React.useState(false);
    const [treeReloadNonce, setTreeReloadNonce] = React.useState(0);
    const [uploadMenuOpen, setUploadMenuOpen] = React.useState(false);
    const [uploadDestinationDir, setUploadDestinationDir] = React.useState('');
    const [toolbarWidth, setToolbarWidth] = React.useState<number | null>(null);
    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const showSearchBar = props.showSearchBar !== false;
    const allowCreateActions = machineRpcTargetAvailable;
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
                    const results = await searchFiles(props.sessionId, q, { limit: 200 });
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
    }, [props.sessionId, searchQuery, showChangedOnly, treeReloadNonce]);

    const shouldShowSearchResults = !showChangedOnly && searchQuery.trim().length > 0;
    const canClearSearch = searchQuery.length > 0;
    const refresh = React.useCallback(() => {
        fileSearchCache.clearCache(props.sessionId);
        clearCachedRepositoryDirectoryEntries({ sessionId: props.sessionId });
        scmStatusSync.invalidateFromUser(props.sessionId);
        setTreeReloadNonce((n) => n + 1);
    }, [props.sessionId]);

    const transfers = useWorkspaceFileTransfers({
        sessionId: props.sessionId,
        onResolveUploadConflicts: showUploadConflictResolutionDialog,
        onAfterUploadSuccess: refresh,
    });

    const dropZoneHandlers = useWebFileDropZone({
        enabled: allowCreateActions && Platform.OS === 'web',
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

            const res = await sessionWriteFile(props.sessionId, path, '', null);
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

            const res = await sessionCreateDirectory(props.sessionId, directoryPath);
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
    }, [transfers]);

    const startNativeUploads = React.useCallback(async () => {
        const picked = await nativePickFiles({ multiple: true });
        if (picked.length === 0) return;
        const entries: WorkspaceUploadEntry[] = picked.map((p) => ({
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
        allowCreateActions,
        isWeb: Platform.OS === 'web',
    }), [allowCreateActions]);

    const uploadMenuItems = React.useMemo(() => [
        {
            id: 'repository-tree-upload-destination-select',
            title: t('settingsAttachments.workspaceDirectory.uploadsDirectory.title'),
            subtitle: uploadDestinationDir || t('files.projectRoot'),
            category: t('common.path'),
            icon: <Ionicons name="folder-open-outline" size={16} color={theme.colors.textSecondary} />,
            disabled: !allowCreateActions,
        },
        ...uploadMenuConfig.items.map((item) => ({
            id: item.id,
            title: t(item.titleKey),
            subtitle: uploadDestinationDir || t('files.projectRoot'),
            category: t('files.toolbar.upload'),
            icon: <Ionicons name={item.iconName} size={16} color={theme.colors.textSecondary} />,
            disabled: item.disabled,
        })),
    ], [allowCreateActions, theme.colors.textSecondary, uploadDestinationDir, uploadMenuConfig.items]);

    const onSelectUploadMenuItem = React.useCallback((itemId: string) => {
        setUploadMenuOpen(false);
        if (!allowCreateActions) return;
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
    }, [allowCreateActions, selectUploadDestination, startNativeUploads]);

    const toolbarActions = React.useMemo<ToolbarActionConfig[]>(() => {
        const actions: ToolbarActionConfig[] = [
            {
                id: 'repository-tree-filter-changed',
                priority: 1,
                order: 0,
                icon: <Octicons name="filter" size={16} color={showChangedOnly ? theme.colors.textLink : theme.colors.textSecondary} />,
                menuIcon: 'funnel-outline',
                accessibilityLabel: t('files.toolbar.changedFiles'),
                selected: showChangedOnly,
                onPress: () => setShowChangedOnly((prev) => !prev),
            },
            {
                id: 'repository-tree-toggle-details',
                priority: 2,
                order: 1,
                icon: <Ionicons name={detailsMode ? 'list' : 'list-outline'} size={16} color={detailsMode ? theme.colors.textLink : theme.colors.textSecondary} />,
                menuIcon: 'list-outline',
                accessibilityLabel: t('common.details'),
                selected: detailsMode,
                onPress: () => setDetailsMode((prev) => !prev),
            },
            {
                id: 'repository-tree-upload',
                priority: 3,
                order: 2,
                icon: <Ionicons name="cloud-upload-outline" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'cloud-upload-outline',
                accessibilityLabel: t('files.toolbar.upload'),
                disabled: !allowCreateActions,
                selected: uploadDestinationDir.length > 0,
                onPress: () => setUploadMenuOpen(true),
            },
            {
                id: 'repository-tree-create-file',
                priority: 5,
                order: 3,
                icon: <Ionicons name="document-text-outline" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'document-text-outline',
                accessibilityLabel: t('files.createFileA11y'),
                disabled: !allowCreateActions,
                onPress: createFile,
            },
            {
                id: 'repository-tree-create-folder',
                priority: 6,
                order: 4,
                icon: <Ionicons name="folder-outline" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'folder-outline',
                accessibilityLabel: t('files.createFolderA11y'),
                disabled: !allowCreateActions,
                onPress: createFolder,
            },
            {
                id: 'repository-tree-clear-search',
                priority: 4,
                order: 5,
                icon: <Octicons name="x" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'close-outline',
                accessibilityLabel: t('files.clearSearchA11y'),
                onPress: () => setSearchQuery(''),
            },
            {
                id: 'repository-tree-refresh',
                priority: 0,
                order: 6,
                icon: <Octicons name="sync" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'refresh-outline',
                accessibilityLabel: t('common.refresh'),
                onPress: refresh,
            },
            {
                id: 'repository-tree-collapse-all',
                priority: 7,
                order: 7,
                icon: <Ionicons name="contract-outline" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'contract-outline',
                accessibilityLabel: t('files.repositoryCollapseAll'),
                disabled: expandedPaths.length === 0,
                onPress: collapseAll,
            },
        ];

        if (props.onRequestClose) {
            actions.push({
                id: 'repository-tree-close',
                priority: 8,
                order: 8,
                icon: <Octicons name="x" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'close-outline',
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
        canClearSearch,
        collapseAll,
        createFile,
        createFolder,
        detailsMode,
        expandedPaths.length,
        refresh,
        setSearchQuery,
        showChangedOnly,
        uploadDestinationDir.length,
        props.onRequestClose,
        theme.colors.textLink,
        theme.colors.textSecondary,
    ]);

    const visibleToolbarActionIds = React.useMemo(
        () => resolveVisibleToolbarActionIds({ toolbarWidth, actions: toolbarActions }),
        [toolbarActions, toolbarWidth],
    );

    const visibleToolbarActions = React.useMemo(
        () => toolbarActions.filter((action) => visibleToolbarActionIds.has(action.id)).sort((left, right) => left.order - right.order),
        [toolbarActions, visibleToolbarActionIds],
    );

    const hiddenToolbarActions = React.useMemo(
        () => toolbarActions.filter((action) => !visibleToolbarActionIds.has(action.id)).sort((left, right) => left.order - right.order),
        [toolbarActions, visibleToolbarActionIds],
    );

    const uploadShouldBeVisible = visibleToolbarActionIds.has('repository-tree-upload');

    const overflowMenuItems = React.useMemo<ItemAction[]>(() => {
        const uploadOverflowItems: ItemAction[] = [
            {
                id: 'repository-tree-upload-destination-select',
                title: t('settingsAttachments.workspaceDirectory.uploadsDirectory.title'),
                icon: 'folder-open-outline',
                disabled: !allowCreateActions,
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
        const hiddenItems = hiddenToolbarActions
            .filter((action) => action.id !== 'repository-tree-upload')
            .map((action) => ({
            id: action.id,
            title: action.accessibilityLabel,
            icon: action.menuIcon,
            disabled: action.disabled,
            onPress: action.onPress,
        }));

        if (!uploadShouldBeVisible) {
            return [
                ...uploadOverflowItems,
                ...hiddenItems,
            ];
        }

        return hiddenItems;
    }, [allowCreateActions, hiddenToolbarActions, onSelectUploadMenuItem, uploadMenuConfig.items, uploadShouldBeVisible]);

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
                        <Pressable
                            testID="repository-tree-upload"
                            accessibilityRole="button"
                            accessibilityLabel={action.accessibilityLabel}
                            onPress={toggle}
                            style={[
                                styles.iconButton,
                                action.selected ? { backgroundColor: theme.colors.surface, borderColor: theme.colors.textLink } : null,
                                action.disabled ? { opacity: 0.35 } : null,
                            ]}
                            hitSlop={10}
                            disabled={action.disabled}
                        >
                            {action.icon}
                        </Pressable>
                    )}
                />
            );
        }

        return (
            <Pressable
                key={action.id}
                testID={action.id}
                accessibilityRole="button"
                accessibilityLabel={action.accessibilityLabel}
                onPress={action.onPress}
                style={[
                    styles.iconButton,
                    action.selected ? { backgroundColor: theme.colors.surface, borderColor: theme.colors.textLink } : null,
                    action.disabled ? { opacity: 0.35 } : null,
                ]}
                hitSlop={10}
                disabled={action.disabled}
            >
                {action.icon}
            </Pressable>
        );
    }, [onSelectUploadMenuItem, styles.iconButton, theme.colors.surface, theme.colors.textLink, uploadMenuConfig.matchTriggerWidth, uploadMenuItems, uploadMenuOpen]);

    return (
        <View style={{ flex: 1 }}>
            {showSearchBar ? (
                <View
                    testID="repository-tree-toolbar"
                    style={styles.toolbar}
                    onLayout={(event) => {
                        const width = event?.nativeEvent?.layout?.width;
                        if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
                            setToolbarWidth(width);
                        }
                    }}
                >
                    <TextInput
                        testID="repository-tree-search"
                        placeholder={t('files.searchPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        style={styles.searchInput}
                    />
                    {visibleToolbarActions.map(renderToolbarIconButton)}
                    {overflowMenuItems.length > 0 ? (
                        <ItemRowActions
                            title={t('common.moreActions')}
                            actions={overflowMenuItems}
                            overflowTriggerTestID="repository-tree-toolbar-overflow"
                            compactThreshold={Number.POSITIVE_INFINITY}
                            compactActionIds={[]}
                            renderOverflowTrigger={({ open, toggle, testID, accessibilityLabel, accessibilityHint }) => (
                                <Pressable
                                    testID={testID}
                                    accessibilityRole="button"
                                    accessibilityLabel={accessibilityLabel}
                                    accessibilityHint={accessibilityHint}
                                    accessibilityState={{ expanded: open }}
                                    onPress={toggle}
                                    style={styles.iconButton}
                                    hitSlop={10}
                                >
                                    <Ionicons name="ellipsis-horizontal" size={16} color={theme.colors.textSecondary} />
                                </Pressable>
                            )}
                        />
                    ) : null}
                </View>
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
                            onLayout={scrollFades.onViewportLayout}
                            onContentSizeChange={scrollFades.onContentSizeChange}
                            onScroll={scrollFades.onScroll}
                            scrollEventThrottle={16}
                        />
                    ) : showChangedOnly && scmSnapshot?.repo.isRepo ? (
                        <ChangedFilesTreeList
                            theme={theme}
                            snapshot={scmSnapshot}
                            searchQuery={searchQuery}
                            onOpenFile={props.onOpenFile}
                            onOpenFilePinned={props.onOpenFilePinned}
                            onLayout={scrollFades.onViewportLayout}
                            onContentSizeChange={scrollFades.onContentSizeChange}
                            onScroll={scrollFades.onScroll}
                            scrollEventThrottle={16}
                        />
                    ) : (
                        <RepositoryTreeList
                            theme={theme}
                            sessionId={props.sessionId}
                            reloadToken={treeReloadNonce}
                            detailsMode={detailsMode}
                            writeActionsEnabled={allowCreateActions}
                            onRequestRefresh={refresh}
                            onRequestDownload={(params) => transfers.startDownload(params)}
                            onWebDropTargetChange={webDropState.onDropTargetChange}
                            webDropHoverPath={webDropState.dropHoverPath}
                            expandedPaths={expandedPaths}
                            onExpandedPathsChange={(paths) => storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, paths)}
                            onOpenFile={props.onOpenFile}
                            onOpenFilePinned={props.onOpenFilePinned}
                            scmSnapshot={scmSnapshot}
                            onLayout={scrollFades.onViewportLayout}
                            onContentSizeChange={scrollFades.onContentSizeChange}
                            onScroll={scrollFades.onScroll}
                            scrollEventThrottle={16}
                        />
                    )}
                    <RepositoryTreeDropOverlay
                        visible={webDropState.fileDragActive}
                        destinationLabel={webDropState.dropDestinationDir || t('files.projectRoot')}
                    />
                    <ScrollEdgeFades
                        color={theme.colors.surface}
                        size={18}
                        edges={scrollFades.visibility}
                    />
                    <ScrollEdgeIndicators
                        edges={scrollFades.visibility}
                        color={theme.colors.textSecondary}
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
            </WebDropTargetView>
        </View>
    );
});
