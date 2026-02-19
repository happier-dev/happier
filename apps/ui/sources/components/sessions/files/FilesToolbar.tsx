import * as React from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ChangedFilesPresentation, ChangedFilesViewMode } from '@/scm/scmAttribution';

type FilesToolbarProps = {
    theme: any;
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    showAllRepositoryFiles: boolean;
    onShowChangedFiles: () => void;
    onShowAllRepositoryFiles: () => void;
    changedFilesCount: number;
    changedFilesViewMode: ChangedFilesViewMode;
    changedFilesPresentation: ChangedFilesPresentation;
    showSessionViewToggle: boolean;
    onChangedFilesViewMode: (mode: ChangedFilesViewMode) => void;
    onChangedFilesPresentationChange: (mode: ChangedFilesPresentation) => void;
    scmPanelExpanded: boolean;
    onToggleScmPanel: () => void;
    onRefresh?: () => void;
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
        changedFilesPresentation,
        showSessionViewToggle,
        onChangedFilesViewMode,
        onChangedFilesPresentationChange,
        scmPanelExpanded,
        onToggleScmPanel,
        onRefresh,
    } = props;

    const chipStyle = (active: boolean) => ({
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 12,
        backgroundColor: active ? theme.colors.surfaceHigh : theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    }) as const;

    const Chip = (p: {
        active: boolean;
        label: string;
        icon: React.ReactNode;
        badge?: React.ReactNode;
        onPress: () => void;
    }) => {
        return (
            <Pressable onPress={p.onPress} style={chipStyle(p.active)}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                    {p.icon}
                    <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        {p.label}
                    </Text>
                    {p.badge}
                </View>
            </Pressable>
        );
    };

    const CountBadge = ({ count }: { count: number }) => {
        if (count <= 0) return null;
        return (
            <View
                style={{
                    minWidth: 20,
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh,
                }}
            >
                <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.mono('semiBold') }}>
                    {String(count)}
                </Text>
            </View>
        );
    };

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
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
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

            <View style={{ flexDirection: 'row', marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip
                    active={!showAllRepositoryFiles}
                    label="Changed files"
                    icon={<Octicons name="diff" size={14} color={theme.colors.textSecondary} />}
                    badge={!showAllRepositoryFiles ? <CountBadge count={changedFilesCount} /> : undefined}
                    onPress={onShowChangedFiles}
                />
                <Chip
                    active={showAllRepositoryFiles}
                    label="All repository files"
                    icon={<Octicons name="repo" size={14} color={theme.colors.textSecondary} />}
                    onPress={onShowAllRepositoryFiles}
                />

                {!showAllRepositoryFiles && changedFilesCount > 0 ? (
                    <>
                        <Chip
                            active={changedFilesViewMode === 'repository'}
                            label="Repository view"
                            icon={<Octicons name="list-unordered" size={14} color={theme.colors.textSecondary} />}
                            onPress={() => onChangedFilesViewMode('repository')}
                        />
                        {showSessionViewToggle && (
                            <Chip
                                active={changedFilesViewMode === 'session'}
                                label="Session view"
                                icon={<Octicons name="history" size={14} color={theme.colors.textSecondary} />}
                                onPress={() => onChangedFilesViewMode('session')}
                            />
                        )}

                        <Chip
                            active={changedFilesPresentation === 'review'}
                            label="Review"
                            icon={<Octicons name="diff" size={14} color={theme.colors.textSecondary} />}
                            onPress={() => onChangedFilesPresentationChange('review')}
                        />
                        <Chip
                            active={changedFilesPresentation === 'list'}
                            label="List"
                            icon={<Octicons name="list-unordered" size={14} color={theme.colors.textSecondary} />}
                            onPress={() => onChangedFilesPresentationChange('list')}
                        />
                    </>
                ) : null}

                <Chip
                    active={scmPanelExpanded}
                    label="SCM"
                    icon={<Octicons name="git-branch" size={14} color={theme.colors.textSecondary} />}
                    onPress={onToggleScmPanel}
                />

                {onRefresh ? (
                    <Chip
                        active={false}
                        label={t('common.refresh')}
                        icon={<Octicons name="sync" size={14} color={theme.colors.textSecondary} />}
                        onPress={onRefresh}
                    />
                ) : null}
            </View>

            {!showAllRepositoryFiles && changedFilesCount > 0 && !showSessionViewToggle && (
                <View
                    style={{
                        marginTop: 10,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        backgroundColor: theme.colors.surfaceHigh,
                    }}
                >
                    <Text
                        style={{
                            fontSize: 11,
                            color: theme.colors.textSecondary,
                            ...Typography.default(),
                        }}
                    >
                        {t('files.attributionReliabilityLimited')}
                    </Text>
                </View>
            )}
        </View>
    );
}
