import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ChangedFilesPresentation, ChangedFilesViewMode } from '@/scm/scmAttribution';
import { ChangedFilesViewModeMenu } from './ChangedFilesViewModeMenu';

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
    showTurnViewToggle?: boolean;
    showTurnAgentReportedViewToggle?: boolean;
    showTurnCheckpointViewToggle?: boolean;
    showSessionViewToggle: boolean;
    onChangedFilesViewMode: (mode: ChangedFilesViewMode) => void;
    onChangedFilesPresentationChange: (mode: ChangedFilesPresentation) => void;
    scmPanelExpanded: boolean;
    onToggleScmPanel: () => void;
    onRefresh?: () => void;
    showScmToggle?: boolean;
    showAttributionReliabilityNotice?: boolean;
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
        showTurnViewToggle = false,
        showTurnAgentReportedViewToggle = false,
        showTurnCheckpointViewToggle = false,
        showSessionViewToggle,
        onChangedFilesViewMode,
        onChangedFilesPresentationChange,
        scmPanelExpanded,
        onToggleScmPanel,
        onRefresh,
        showScmToggle = true,
        showAttributionReliabilityNotice = true,
    } = props;
    const hasScopedChangedFilesView =
        showTurnViewToggle
        || showTurnAgentReportedViewToggle
        || showTurnCheckpointViewToggle
        || showSessionViewToggle;
    const showChangedFilesControls =
        !showAllRepositoryFiles
        && (changedFilesCount > 0 || hasScopedChangedFilesView);

    const chipStyle = (active: boolean) => ({
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 12,
        backgroundColor: active ? theme.colors.surface.inset : theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
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
                    <Text style={{ fontSize: 12, color: theme.colors.text.primary, ...Typography.default('semiBold') }}>
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
                    borderColor: theme.colors.border.default,
                    backgroundColor: theme.colors.surface.inset,
                }}
            >
                <Text style={{ fontSize: 11, color: theme.colors.text.secondary, ...Typography.mono('semiBold') }}>
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
                borderBottomColor: theme.colors.border.default,
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
                    borderColor: theme.colors.border.default,
                }}
            >
                <Octicons name="search" size={16} color={theme.colors.text.secondary} style={{ marginRight: 8 }} />
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
                    label={t('files.toolbar.changedFiles')}
                    icon={<Octicons name="diff" size={14} color={theme.colors.text.secondary} />}
                    badge={!showAllRepositoryFiles ? <CountBadge count={changedFilesCount} /> : undefined}
                    onPress={onShowChangedFiles}
                />
                <Chip
                    active={showAllRepositoryFiles}
                    label={t('files.toolbar.allRepositoryFiles')}
                    icon={<Octicons name="repo" size={14} color={theme.colors.text.secondary} />}
                    onPress={onShowAllRepositoryFiles}
                />

                {showChangedFilesControls ? (
                    <>
                        <ChangedFilesViewModeMenu
                            theme={theme}
                            changedFilesViewMode={changedFilesViewMode}
                            showTurnViewToggle={showTurnViewToggle}
                            showTurnAgentReportedViewToggle={showTurnAgentReportedViewToggle}
                            showTurnCheckpointViewToggle={showTurnCheckpointViewToggle}
                            showSessionViewToggle={showSessionViewToggle}
                            onChangedFilesViewMode={onChangedFilesViewMode}
                        />

                        <Chip
                            active={changedFilesPresentation === 'review'}
                            label={t('files.toolbar.review')}
                            icon={<Octicons name="diff" size={14} color={theme.colors.text.secondary} />}
                            onPress={() => onChangedFilesPresentationChange('review')}
                        />
                        <Chip
                            active={changedFilesPresentation === 'list'}
                            label={t('files.toolbar.list')}
                            icon={<Octicons name="list-unordered" size={14} color={theme.colors.text.secondary} />}
                            onPress={() => onChangedFilesPresentationChange('list')}
                        />
                    </>
                ) : null}

                {showScmToggle ? (
                    <Chip
                        active={scmPanelExpanded}
                        label={t('files.toolbar.scm')}
                        icon={<Octicons name="git-branch" size={14} color={theme.colors.text.secondary} />}
                        onPress={onToggleScmPanel}
                    />
                ) : null}

                {onRefresh ? (
                    <Chip
                        active={false}
                        label={t('common.refresh')}
                        icon={<Octicons name="sync" size={14} color={theme.colors.text.secondary} />}
                        onPress={onRefresh}
                    />
                ) : null}
            </View>

            {showAttributionReliabilityNotice
            && !showAllRepositoryFiles
            && changedFilesCount > 0
            && !hasScopedChangedFilesView && (
                <View
                    style={{
                        marginTop: 10,
                        paddingHorizontal: 10,
                        paddingVertical: 8,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.inset,
                    }}
                >
                    <Text
                        style={{
                            fontSize: 11,
                            color: theme.colors.text.secondary,
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
