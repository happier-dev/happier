import * as React from 'react';
import { ActivityIndicator, FlatList, Platform, View, type ScrollViewProps } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Typography } from '@/constants/Typography';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { t } from '@/text';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';

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

function renderFileIconForSearch(file: FileItem, theme: any) {
    if (file.fileType === 'folder') {
        return <Ionicons name="folder-outline" size={18} color={theme.colors.text.secondary} />;
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
    if (isSearching) {
        return (
            <View
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingTop: 40,
                }}
            >
                <ActivityIndicator size="small" color={theme.colors.text.secondary} />
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
        );
    }

    if (searchResults.length === 0) {
        return (
            <View
                style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    paddingTop: 40,
                    paddingHorizontal: 20,
                }}
            >
                <Octicons
                    name={searchQuery ? 'search' : 'file-directory'}
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
        );
    }

    return (
        <FlatList
            data={searchResults}
            keyExtractor={(file) => `file-${file.fullPath}`}
            style={{ flex: 1, minHeight: 0 }}
            ListHeaderComponent={
                Boolean(searchQuery) ? (
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
            }
            contentContainerStyle={{ paddingBottom: 20 }}
            renderItem={({ item: file, index }) => {
                return (
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
                );
            }}
            initialNumToRender={Math.min(32, searchResults.length)}
            maxToRenderPerBatch={32}
            windowSize={7}
            removeClippedSubviews={Platform.OS !== 'web'}
            onLayout={onLayout}
            onContentSizeChange={onContentSizeChange}
            onScroll={onScroll}
            scrollEventThrottle={scrollEventThrottle ?? 16}
            getItemLayout={
                Platform.OS === 'web'
                    ? (_data, index) => {
                        const length = 38;
                        return { length, offset: length * index, index };
                    }
                    : undefined
            }
        />
    );
});
