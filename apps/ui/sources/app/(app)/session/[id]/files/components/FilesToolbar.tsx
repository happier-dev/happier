import * as React from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ChangedFilesViewMode } from '@/sync/git/gitAttribution';

type FilesToolbarProps = {
    theme: any;
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    showAllRepositoryFiles: boolean;
    onShowChangedFiles: () => void;
    onShowAllRepositoryFiles: () => void;
    changedFilesCount: number;
    changedFilesViewMode: ChangedFilesViewMode;
    showSessionViewToggle: boolean;
    onChangedFilesViewMode: (mode: ChangedFilesViewMode) => void;
};

export function FilesToolbar(props: FilesToolbarProps) {
    const {
        theme,
        searchQuery,
        onSearchQueryChange,
        showAllRepositoryFiles,
        onShowChangedFiles,
        onShowAllRepositoryFiles,
        changedFilesCount,
        changedFilesViewMode,
        showSessionViewToggle,
        onChangedFilesViewMode,
    } = props;

    return (
        <View
            style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
            }}
        >
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: theme.colors.input.background,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                }}
            >
                <Octicons name="search" size={16} color={theme.colors.textSecondary} style={{ marginRight: 8 }} />
                <TextInput
                    value={searchQuery}
                    onChangeText={onSearchQueryChange}
                    placeholder={t('files.searchPlaceholder')}
                    style={{
                        flex: 1,
                        fontSize: 16,
                        ...Typography.default(),
                    }}
                    placeholderTextColor={theme.colors.input.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
            </View>

            <View style={{ flexDirection: 'row', marginTop: 10, gap: 8 }}>
                <Pressable
                    onPress={onShowChangedFiles}
                    style={{
                        paddingVertical: 6,
                        paddingHorizontal: 10,
                        borderRadius: 8,
                        backgroundColor: !showAllRepositoryFiles ? theme.colors.surfaceHigh : theme.colors.surface,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                    }}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        Changed files
                    </Text>
                </Pressable>
                <Pressable
                    onPress={onShowAllRepositoryFiles}
                    style={{
                        paddingVertical: 6,
                        paddingHorizontal: 10,
                        borderRadius: 8,
                        backgroundColor: showAllRepositoryFiles ? theme.colors.surfaceHigh : theme.colors.surface,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                    }}
                >
                    <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        All repository files
                    </Text>
                </Pressable>
            </View>

            {!showAllRepositoryFiles && changedFilesCount > 0 && (
                <View style={{ flexDirection: 'row', marginTop: 10, gap: 8 }}>
                    <Pressable
                        onPress={() => onChangedFilesViewMode('repository')}
                        style={{
                            paddingVertical: 6,
                            paddingHorizontal: 10,
                            borderRadius: 8,
                            backgroundColor:
                                changedFilesViewMode === 'repository'
                                    ? theme.colors.surfaceHigh
                                    : theme.colors.surface,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                        }}
                    >
                        <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') }}>
                            Repository view
                        </Text>
                    </Pressable>
                    {showSessionViewToggle && (
                        <Pressable
                            onPress={() => onChangedFilesViewMode('session')}
                            style={{
                                paddingVertical: 6,
                                paddingHorizontal: 10,
                                borderRadius: 8,
                                backgroundColor:
                                    changedFilesViewMode === 'session'
                                        ? theme.colors.surfaceHigh
                                        : theme.colors.surface,
                                borderWidth: 1,
                                borderColor: theme.colors.divider,
                            }}
                        >
                            <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') }}>
                                Session view
                            </Text>
                        </Pressable>
                    )}
                </View>
            )}

            {!showAllRepositoryFiles && changedFilesCount > 0 && !showSessionViewToggle && (
                <Text
                    style={{
                        marginTop: 8,
                        fontSize: 11,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    {t('files.attributionReliabilityLimited')}
                </Text>
            )}
        </View>
    );
}
