import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { SearchResultsList } from '@/components/sessions/files/content/SearchResultsList';
import { FilesystemBrowserToolbarChrome, type FilesystemBrowserToolbarAction } from '@/components/ui/filesystemBrowser/FilesystemBrowserToolbarChrome';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { t } from '@/text';

import { clearCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';
import { searchWorkspaceFiles, workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { WorkspaceRepositoryTreeList, type WorkspaceRepositoryTreeWebDropTarget } from './WorkspaceRepositoryTreeList';

export type WorkspaceRepositoryTreeBrowserViewProps = Readonly<{
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId?: string | null;
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
    | 'workspace-repository-tree-toggle-details'
    | 'workspace-repository-tree-clear-search'
    | 'workspace-repository-tree-refresh'
    | 'workspace-repository-tree-collapse-all'
    | 'workspace-repository-tree-close';

type ToolbarActionConfig = FilesystemBrowserToolbarAction;

export const WorkspaceRepositoryTreeBrowserView = React.memo((props: WorkspaceRepositoryTreeBrowserViewProps) => {
    const { theme } = useUnistyles();
    const [detailsMode, setDetailsMode] = React.useState(false);
    const [treeReloadNonce, setTreeReloadNonce] = React.useState(0);

    const [uncontrolledExpandedPaths, setUncontrolledExpandedPaths] = React.useState<readonly string[]>([]);
    const expandedPaths = props.expandedPaths ?? uncontrolledExpandedPaths;
    const setExpandedPaths = props.onExpandedPathsChange ?? setUncontrolledExpandedPaths;

    const [uncontrolledSearchQuery, setUncontrolledSearchQuery] = React.useState('');
    const searchQuery = props.searchQuery ?? uncontrolledSearchQuery;
    const setSearchQuery = props.onSearchQueryChange ?? setUncontrolledSearchQuery;

    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const showSearchBar = props.showSearchBar !== false;

    React.useEffect(() => {
        let cancelled = false;
        const q = searchQuery.trim();
        if (!q) {
            setSearchResults([]);
            setIsSearching(false);
            return;
        }

        setIsSearching(true);
        const handle = setTimeout(() => {
            void (async () => {
                try {
                    const results = await searchWorkspaceFiles({
                        workspaceCacheKey: props.workspaceCacheKey,
                        machineId: props.machineId,
                        rootPath: props.rootPath,
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
    }, [props.machineId, props.rootPath, props.workspaceCacheKey, searchQuery, treeReloadNonce]);

    const shouldShowSearchResults = searchQuery.trim().length > 0;
    const canClearSearch = searchQuery.length > 0;

    const refresh = React.useCallback(() => {
        workspaceFileSearchCache.clearCache(props.workspaceCacheKey);
        clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey: props.workspaceCacheKey });
        setTreeReloadNonce((n) => n + 1);
    }, [props.workspaceCacheKey]);

    const collapseAll = React.useCallback(() => {
        setExpandedPaths([]);
    }, [setExpandedPaths]);

    const toolbarActions = React.useMemo((): ToolbarActionConfig[] => {
        const actions: ToolbarActionConfig[] = [
            {
                id: 'workspace-repository-tree-toggle-details',
                priority: 2,
                order: 0,
                icon: <Ionicons name={detailsMode ? 'list' : 'list-outline'} size={16} color={detailsMode ? theme.colors.textLink : theme.colors.textSecondary} />,
                menuIcon: 'list-outline',
                accessibilityLabel: t('common.details'),
                selected: detailsMode,
                onPress: () => setDetailsMode((v) => !v),
            },
            {
                id: 'workspace-repository-tree-refresh',
                priority: 0,
                order: 1,
                icon: <Ionicons name="refresh-outline" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'refresh-outline',
                accessibilityLabel: t('common.refresh'),
                onPress: refresh,
            },
            {
                id: 'workspace-repository-tree-collapse-all',
                priority: 7,
                order: 2,
                icon: <Ionicons name="contract-outline" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'contract-outline',
                accessibilityLabel: t('files.repositoryCollapseAll'),
                disabled: expandedPaths.length === 0,
                onPress: collapseAll,
            },
        ];

        if (props.onRequestClose) {
            actions.push({
                id: 'workspace-repository-tree-close',
                priority: 8,
                order: 3,
                icon: <Ionicons name="close-outline" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'close-outline',
                accessibilityLabel: t('common.close'),
                onPress: props.onRequestClose,
            });
        }

        if (canClearSearch) {
            actions.push({
                id: 'workspace-repository-tree-clear-search',
                priority: 4,
                order: 4,
                icon: <Ionicons name="close-circle-outline" size={16} color={theme.colors.textSecondary} />,
                menuIcon: 'close-outline',
                accessibilityLabel: t('files.clearSearchA11y'),
                onPress: () => setSearchQuery(''),
            });
        }

        return actions;
    }, [
        canClearSearch,
        collapseAll,
        detailsMode,
        expandedPaths.length,
        props.onRequestClose,
        refresh,
        setSearchQuery,
        theme.colors.textLink,
        theme.colors.textSecondary,
    ]);

    const buildOverflowItems = React.useCallback((hiddenActions: readonly FilesystemBrowserToolbarAction[]): ItemAction[] => {
        return hiddenActions.map((action) => ({
            id: action.id,
            title: action.accessibilityLabel,
            icon: action.menuIcon,
            onPress: action.onPress,
            disabled: action.disabled,
        }));
    }, []);

    return (
        <View style={{ flex: 1 }}>
            {showSearchBar ? (
                <FilesystemBrowserToolbarChrome
                    searchValue={searchQuery}
                    onSearchValueChange={setSearchQuery}
                    searchPlaceholder={t('files.searchPlaceholder')}
                    actions={toolbarActions}
                    buildOverflowItems={buildOverflowItems}
                    overflowTitle={t('common.moreActions')}
                />
            ) : null}
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
                ) : (
                    <WorkspaceRepositoryTreeList
                        theme={theme}
                        workspaceCacheKey={props.workspaceCacheKey}
                        machineId={props.machineId}
                        rootPath={props.rootPath}
                        serverId={props.serverId}
                        reloadToken={treeReloadNonce}
                        detailsMode={detailsMode}
                        expandedPaths={expandedPaths}
                        onExpandedPathsChange={(paths) => setExpandedPaths(paths)}
                        onOpenFile={props.onOpenFile}
                        onOpenFilePinned={props.onOpenFilePinned}
                        scmSnapshot={props.scmSnapshot ?? null}
                        onWebDropTargetChange={Platform.OS === 'web' ? (props.onWebDropTargetChange ?? null) : null}
                        webDropHoverPath={props.webDropHoverPath ?? null}
                        renderRowActions={props.renderRowActions ?? null}
                    />
                )}
            </View>
        </View>
    );
});
