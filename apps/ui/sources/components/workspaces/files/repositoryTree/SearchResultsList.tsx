import * as React from 'react';
import { Platform, View, type ScrollViewProps } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Typography } from '@/constants/Typography';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { t } from '@/text';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import { Icon } from '@/components/ui/icons/Icon';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';

type SearchResultsListProps = {
    theme: any;
    isSearching: boolean;
    searchQuery: string;
    searchResultsQuery?: string;
    searchError?: boolean;
    hasMore?: boolean;
    /** Another page of names can be shown (lab FB1 "Show more"); the search owner keeps its source bounds. */
    canLoadMore?: boolean;
    onLoadMore?: () => void;
    onRetry?: () => void;
    searchResults: FileItem[];
    onFilePress: (file: FileItem) => void;
    fileHref?: (fullPath: string) => string | null;
    workspaceScope?: WorkspaceScopeBase | null;
    onFilePressPinned?: (file: FileItem) => void;
    onFolderPress?: (folder: FileItem) => void;
    onLayout?: ScrollViewProps['onLayout'];
    onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
    onScroll?: ScrollViewProps['onScroll'];
    scrollEventThrottle?: number;
};

const SEARCH_RESULTS_ESTIMATED_ITEM_SIZE = 38;
const NATIVE_SEARCH_RESULTS_INITIAL_RENDER_COUNT = 12;
const NATIVE_SEARCH_RESULTS_RENDER_BATCH_COUNT = 12;
const WEB_SEARCH_RESULTS_INITIAL_RENDER_COUNT = 32;
const WEB_SEARCH_RESULTS_RENDER_BATCH_COUNT = 32;
const searchResultListStyle = { flex: 1, minHeight: 0 } as const;

function renderFileIconForSearch(file: FileItem, theme: any) {
    if (file.fileType === 'folder') {
        return <Icon name="folder" size={16} color={theme.colors.text.secondary} />;
    }

    const { name } = normalizeRepoPathParts({ fileName: file.fileName, filePath: file.filePath, fullPath: file.fullPath });
    return <FileIcon fileName={name || file.fileName} size={18} />;
}

export const SearchResultsList = React.memo(({
    theme,
    isSearching,
    searchQuery,
    searchResultsQuery,
    searchError,
    hasMore,
    canLoadMore,
    onLoadMore,
    onRetry,
    searchResults,
    onFilePress,
    fileHref,
    workspaceScope,
    onFilePressPinned,
    onFolderPress,
    onLayout,
    onContentSizeChange,
    onScroll,
    scrollEventThrottle,
}: SearchResultsListProps) => {
    const accountScope = useActiveServerAccountScope();
    const bottomClearance = useFloatingChromeClearance();
    // Keep empty/loading content centered and the last result above floating chrome.
    const searchResultContentContainerStyle = React.useMemo(() => ({
        paddingBottom: theme.space.s20 + bottomClearance,
        flexGrow: 1,
    }), [bottomClearance, theme.space.s20]);
    const showsPreviousResults = isSearching || (searchResultsQuery !== undefined && searchResultsQuery !== searchQuery.trim());
    const keyExtractor = React.useCallback((file: FileItem) => `file-${file.fullPath}`, []);
    // Retain both the scroll owner and the previous query's rows while updating.
    const listData = searchResults;
    const hasResults = listData.length > 0;
    const coverageNotice = React.useMemo(() => searchError ? (
        <SurfaceStateCard testID="files-search-error" size="line" kind="unavailable" title={t('errors.unknownError')}
            action={onRetry ? { label: t('common.retry'), onPress: onRetry } : undefined} />
    ) : hasMore && !(canLoadMore && onLoadMore) ? (
        <SurfaceStateCard testID="files-search-incomplete" size="line" kind="warning" title={t('universalSearch.moreResultsAvailable')} />
    ) : null, [searchError, hasMore, canLoadMore, onLoadMore, onRetry]);
    const listHeaderComponent = React.useMemo(() => (
        Boolean(searchQuery) && hasResults ? (
            <>
            <View
                style={{
                    backgroundColor: theme.colors.surface.inset,
                    paddingHorizontal: theme.space.s16,
                    paddingVertical: theme.space.s12,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.border.default,
                }}
            >
                <Text
                    style={{
                        ...Typography.variant('label', 'semiBold'),
                        color: theme.colors.text.link,
                    }}
                >
                    {showsPreviousResults ? t('files.previousSearchResults') : t('files.searchResults', { count: searchResults.length })}
                    {isSearching ? ` · ${t('files.searching')}` : null}
                </Text>
            </View>
            {coverageNotice}
            </>
        ) : null
    ), [
        isSearching,
        showsPreviousResults,
        hasResults,
        searchQuery,
        searchResults.length,
        coverageNotice,
        theme.colors.border.default,
        theme.colors.surface.inset,
        theme.colors.text.link,
    ]);

    // A search in progress or without results is one quiet line in the list (lab 0 "N"); a project with
    // no files at all is the pane's own empty state.
    const listEmptyComponent = React.useMemo(() => (
        isSearching ? (
            <SurfaceStateCard testID="files-search-searching" size="line" kind="loading" title={t('files.searching')} />
        ) : coverageNotice ? coverageNotice : searchQuery ? (
            <SurfaceStateCard
                testID="files-search-no-results"
                size="line"
                kind="empty"
                iconName="magnifying-glass"
                title={t('files.noFilesFound')}
                reason={t('files.tryDifferentTerm')}
            />
        ) : (
            <SurfaceStateCard testID="files-search-empty" kind="empty" iconName="folder" title={t('files.noFilesInProject')} />
        )
    ), [isSearching, searchQuery, coverageNotice]);

    const renderItem = React.useCallback(({ item: file, index }: { item: FileItem; index: number }) => (
        <WorkspaceDestinationRow href={file.fileType === 'file' ? fileHref?.(file.fullPath) ?? null : null}
            entityTitle={file.fileType === 'folder' ? `${file.fileName}/` : file.fileName}
            entityItem={workspaceScope && accountScope?.serverId === workspaceScope.serverId
                ? { kind: 'repository-file', scope: accountScope, machineId: workspaceScope.machineId,
                    entryKind: file.fileType === 'folder' ? 'directory' : 'file',
                    path: resolveMachineAbsolutePath({ rootPath: workspaceScope.rootPath, requestPath: file.fullPath }) } : null}>
        {actions => (
        <Item
            onLongPress={actions.openMenu}
            title={(
                <InlineRepoPathLabel
                    fileName={file.fileName}
                    filePath={file.filePath}
                    fullPath={file.fullPath}
                    nameSuffix={file.fileType === 'folder' ? '/' : undefined}
                    nameMaxWidth={220}
                    pathTextStyle={{
                        ...Typography.variant('body'),
                        color: theme.colors.text.secondary,
                    }}
                    nameTextStyle={{
                        ...Typography.variant('body', 'semiBold'),
                        color: theme.colors.text.primary,
                    }}
                />
            )}
            rightElement={null}
            icon={renderFileIconForSearch(file, theme)}
            density="compact"
            onPress={file.fileType === 'file' ? () => onFilePress(file) : onFolderPress ? () => onFolderPress(file) : undefined}
            onDoublePress={
                file.fileType === 'file' && onFilePressPinned
                    ? () => onFilePressPinned(file)
                    : undefined
            }
            showChevron={false}
            showDivider={index < searchResults.length - 1}
            style={{
                paddingHorizontal: theme.space.s12,
            }}
        />
        )}
        </WorkspaceDestinationRow>
    ), [
        workspaceScope,
        accountScope,
        fileHref,
        onFilePress,
        onFilePressPinned,
        onFolderPress,
        searchResults.length,
        theme,
    ]);

    // Paging, not a cap: the next page arrives under the rows already shown (P3 §3.5).
    const listFooterComponent = React.useMemo(() => canLoadMore && onLoadMore && hasResults && !showsPreviousResults ? (
        <View style={{ paddingHorizontal: theme.space.s12, paddingVertical: theme.space.s8, alignItems: 'flex-start' }}>
            <TextLinkButton testID="files-search-show-more" size="meta" label={t('universalSearch.quickOpen.showMore')} onPress={onLoadMore} />
        </View>
    ) : null, [canLoadMore, hasResults, onLoadMore, showsPreviousResults, theme.space.s12, theme.space.s8]);

    const sharedListProps = {
        data: listData,
        keyExtractor,
        style: searchResultListStyle,
        ListHeaderComponent: listHeaderComponent,
        ListEmptyComponent: listEmptyComponent,
        ListFooterComponent: listFooterComponent,
        contentContainerStyle: searchResultContentContainerStyle,
        renderItem,
        initialNumToRender: Platform.OS === 'web'
            ? Math.min(WEB_SEARCH_RESULTS_INITIAL_RENDER_COUNT, listData.length)
            : Math.min(NATIVE_SEARCH_RESULTS_INITIAL_RENDER_COUNT, listData.length),
        maxToRenderPerBatch: Platform.OS === 'web'
            ? WEB_SEARCH_RESULTS_RENDER_BATCH_COUNT
            : NATIVE_SEARCH_RESULTS_RENDER_BATCH_COUNT,
        windowSize: 7,
        removeClippedSubviews: Platform.OS !== 'web',
        onLayout,
        onContentSizeChange,
        onScroll,
        scrollEventThrottle: scrollEventThrottle ?? 16,
        getItemLayout: Platform.OS === 'web'
            ? (_data: unknown, index: number) => {
                const length = SEARCH_RESULTS_ESTIMATED_ITEM_SIZE;
                return { length, offset: length * index, index };
            }
            : undefined,
    } as const;

    // The virtualized abstraction owns the backend choice; `auto` resolves to
    // the canonical Legend backend on every platform.
    return (
        <VirtualizedList<FileItem>
            {...sharedListProps}
            estimatedItemSize={SEARCH_RESULTS_ESTIMATED_ITEM_SIZE}
        />
    );
});
