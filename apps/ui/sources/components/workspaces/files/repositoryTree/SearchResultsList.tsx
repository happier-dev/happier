import * as React from 'react';
import { Platform, View, type ScrollViewProps } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Typography } from '@/constants/Typography';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { t } from '@/text';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import { Icon } from '@/components/ui/icons/Icon';

type SearchResultsListProps = {
    theme: any;
    isSearching: boolean;
    searchQuery: string;
    searchResults: FileItem[];
    onFilePress: (file: FileItem) => void;
    onFilePressPinned?: (file: FileItem) => void;
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
// `flexGrow` lets the loading/empty content fill the scroll viewport so it keeps
// the centered composition it had when it was rendered as a standalone screen.
const searchResultContentContainerStyle = { paddingBottom: 20, flexGrow: 1 } as const;
const EMPTY_SEARCH_RESULTS: readonly FileItem[] = [];

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
    searchResults,
    onFilePress,
    onFilePressPinned,
    onLayout,
    onContentSizeChange,
    onScroll,
    scrollEventThrottle,
}: SearchResultsListProps) => {
    const keyExtractor = React.useCallback((file: FileItem) => `file-${file.fullPath}`, []);
    // A search cycle is a transient state, so it may only change what the list
    // renders — never whether the list (the scroll owner) is mounted. While a
    // search is in flight the previous rows are withheld exactly as before, and
    // the spinner/empty copy render as list content.
    const listData = isSearching ? EMPTY_SEARCH_RESULTS : searchResults;
    const hasResults = listData.length > 0;
    const listHeaderComponent = React.useMemo(() => (
        Boolean(searchQuery) && hasResults ? (
            <View
                style={{
                    backgroundColor: theme.colors.surface.inset,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.border.default,
                }}
            >
                <Text
                    style={{
                        fontSize: 14,
                        fontWeight: '600',
                        color: theme.colors.text.link,
                        ...Typography.default(),
                    }}
                >
                    {t('files.searchResults', { count: searchResults.length })}
                </Text>
            </View>
        ) : null
    ), [
        hasResults,
        searchQuery,
        searchResults.length,
        theme.colors.border.default,
        theme.colors.surface.inset,
        theme.colors.text.link,
    ]);

    const listEmptyComponent = React.useMemo(() => (
        isSearching ? (
            <View
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingTop: 40,
                }}
            >
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.text.secondary,
                        textAlign: 'center',
                        marginTop: 16,
                        ...Typography.default(),
                    }}
                >
                    {t('files.searching')}
                </Text>
            </View>
        ) : (
            <View
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingTop: 40,
                    paddingHorizontal: 20,
                }}
            >
                <Icon
                    name={searchQuery ? 'magnifying-glass' : 'folder'}
                    size={48}
                    color={theme.colors.text.secondary}
                />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.text.secondary,
                        textAlign: 'center',
                        marginTop: 16,
                        ...Typography.default(),
                    }}
                >
                    {searchQuery ? t('files.noFilesFound') : t('files.noFilesInProject')}
                </Text>
                {Boolean(searchQuery) && (
                    <Text
                        style={{
                            fontSize: 14,
                            color: theme.colors.text.secondary,
                            textAlign: 'center',
                            marginTop: 8,
                            ...Typography.default(),
                        }}
                    >
                        {t('files.tryDifferentTerm')}
                    </Text>
                )}
            </View>
        )
    ), [isSearching, searchQuery, theme.colors.text.secondary]);

    const renderItem = React.useCallback(({ item: file, index }: { item: FileItem; index: number }) => (
        <Item
            title={(
                <InlineRepoPathLabel
                    fileName={file.fileName}
                    filePath={file.filePath}
                    fullPath={file.fullPath}
                    nameSuffix={file.fileType === 'folder' ? '/' : undefined}
                    nameMaxWidth={220}
                    pathTextStyle={{
                        fontSize: 13,
                        color: theme.colors.text.secondary,
                        ...Typography.default(),
                    }}
                    nameTextStyle={{
                        fontSize: 13,
                        color: theme.colors.text.primary,
                        ...Typography.default('semiBold'),
                    }}
                />
            )}
            rightElement={null}
            icon={renderFileIconForSearch(file, theme)}
            density="compact"
            onPress={file.fileType === 'file' ? () => onFilePress(file) : undefined}
            onDoublePress={
                file.fileType === 'file' && onFilePressPinned
                    ? () => onFilePressPinned(file)
                    : undefined
            }
            showChevron={false}
            showDivider={index < searchResults.length - 1}
            style={{
                paddingHorizontal: 12,
            }}
        />
    ), [
        onFilePress,
        onFilePressPinned,
        searchResults.length,
        theme,
    ]);

    const sharedListProps = {
        data: listData,
        keyExtractor,
        style: searchResultListStyle,
        ListHeaderComponent: listHeaderComponent,
        ListEmptyComponent: listEmptyComponent,
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
