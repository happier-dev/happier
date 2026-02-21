import * as React from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Typography } from '@/constants/Typography';
import type { FileItem } from '@/sync/domains/input/suggestionFile';
import { t } from '@/text';

type SearchResultsListProps = {
    theme: any;
    isSearching: boolean;
    searchQuery: string;
    searchResults: FileItem[];
    onFilePress: (file: FileItem) => void;
};

function renderFileIconForSearch(file: FileItem, theme: any) {
    if (file.fileType === 'folder') {
        return <Octicons name="file-directory" size={29} color={theme.colors.accent.blue} />;
    }

    return <FileIcon fileName={file.fileName} size={29} />;
}

export function SearchResultsList({
    theme,
    isSearching,
    searchQuery,
    searchResults,
    onFilePress,
}: SearchResultsListProps) {
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
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
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
                    color={theme.colors.textSecondary}
                />
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
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
                            color: theme.colors.textSecondary,
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
        <>
            {Boolean(searchQuery) && (
                <View
                    style={{
                        backgroundColor: theme.colors.surfaceHigh,
                        paddingHorizontal: 16,
                        paddingVertical: 12,
                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderBottomColor: theme.colors.divider,
                    }}
                >
                    <Text
                        style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: theme.colors.textLink,
                            ...Typography.default(),
                        }}
                    >
                        {t('files.searchResults', { count: searchResults.length })}
                    </Text>
                </View>
            )}
            {searchResults.map((file, index) => (
                <Item
                    key={`file-${file.fullPath}-${index}`}
                    title={file.fileName}
                    subtitle={file.filePath || t('files.projectRoot')}
                    icon={renderFileIconForSearch(file, theme)}
                    density="compact"
                    onPress={file.fileType === 'file' ? () => onFilePress(file) : undefined}
                    showDivider={index < searchResults.length - 1}
                />
            ))}
        </>
    );
}
