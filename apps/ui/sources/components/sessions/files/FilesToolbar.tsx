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
    showSourceControlToggle?: boolean;
    sourceControlExpanded?: boolean;
    onToggleSourceControl?: () => void;
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
        showSourceControlToggle,
        sourceControlExpanded,
        onToggleSourceControl,
    } = props;

    const segmentStyle = (opts: { active: boolean; pressed: boolean; disabled: boolean; first: boolean; last: boolean }) => {
        const { active, pressed, disabled, first, last } = opts;
        return {
            paddingVertical: 7,
            paddingHorizontal: 10,
            borderTopLeftRadius: first ? 12 : 0,
            borderBottomLeftRadius: first ? 12 : 0,
            borderTopRightRadius: last ? 12 : 0,
            borderBottomRightRadius: last ? 12 : 0,
            backgroundColor: active ? theme.colors.surface : (theme.colors.surfaceHigh ?? theme.colors.surface),
            opacity: disabled ? 0.55 : pressed ? 0.85 : 1,
        } as const;
    };

    const Segment = (p: {
        active: boolean;
        disabled?: boolean;
        label: string;
        iconName: React.ComponentProps<typeof Octicons>['name'];
        badge?: React.ReactNode;
        first: boolean;
        last: boolean;
        onPress?: () => void;
    }) => {
        const disabled = p.disabled ?? false;
        return (
            <Pressable
                disabled={disabled || !p.onPress}
                onPress={p.onPress}
                style={(s) => segmentStyle({
                    active: p.active,
                    pressed: s.pressed,
                    disabled,
                    first: p.first,
                    last: p.last,
                })}
            >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                    <Octicons name={p.iconName} size={14} color={theme.colors.textSecondary} />
                    <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        {p.label}
                    </Text>
                    {p.badge}
                </View>
            </Pressable>
        );
    };

    const SegmentGroup = (p: { children: React.ReactNode }) => (
        <View
            style={{
                flexDirection: 'row',
                borderRadius: 12,
                borderWidth: 1,
                borderColor: theme.colors.divider,
                overflow: 'hidden',
                backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
            }}
        >
            {p.children}
        </View>
    );

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
                padding: 12,
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
                        fontSize: 15,
                        ...Typography.default(),
                    }}
                    placeholderTextColor={theme.colors.input.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10, gap: 8 }}>
                <SegmentGroup>
                    <Segment
                        active={!showAllRepositoryFiles}
                        label="Changed"
                        iconName="diff"
                        badge={!showAllRepositoryFiles ? <CountBadge count={changedFilesCount} /> : undefined}
                        first={true}
                        last={false}
                        onPress={onShowChangedFiles}
                    />
                    <View style={{ width: 1, backgroundColor: theme.colors.divider }} />
                    <Segment
                        active={showAllRepositoryFiles}
                        label="Browse"
                        iconName="repo"
                        first={false}
                        last={true}
                        onPress={onShowAllRepositoryFiles}
                    />
                </SegmentGroup>

                {showSourceControlToggle ? (
                    <Pressable
                        testID="files-scm-toggle"
                        accessibilityRole="button"
                        onPress={onToggleSourceControl}
                        style={({ pressed }) => ({
                            paddingVertical: 7,
                            paddingHorizontal: 10,
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
                            opacity: pressed ? 0.85 : 1,
                        })}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                            <Octicons name="git-commit" size={14} color={theme.colors.textSecondary} />
                            <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default('semiBold') }}>
                                SCM
                            </Text>
                            <Octicons
                                name={sourceControlExpanded ? 'chevron-up' : 'chevron-down'}
                                size={14}
                                color={theme.colors.textSecondary}
                            />
                        </View>
                    </Pressable>
                ) : null}
                {!showAllRepositoryFiles && changedFilesCount > 0 ? (
                    <>
                        <SegmentGroup>
                            <Segment
                                active={changedFilesViewMode === 'repository'}
                                label="Repository"
                                iconName="list-unordered"
                                first={true}
                                last={!showSessionViewToggle}
                                onPress={() => onChangedFilesViewMode('repository')}
                            />
                            {showSessionViewToggle ? (
                                <>
                                    <View style={{ width: 1, backgroundColor: theme.colors.divider }} />
                                    <Segment
                                        active={changedFilesViewMode === 'session'}
                                        label="Session"
                                        iconName="history"
                                        first={false}
                                        last={true}
                                        onPress={() => onChangedFilesViewMode('session')}
                                    />
                                </>
                            ) : null}
                        </SegmentGroup>

                        <SegmentGroup>
                            <Segment
                                active={changedFilesPresentation === 'review'}
                                label="Review"
                                iconName="diff"
                                first={true}
                                last={false}
                                onPress={() => onChangedFilesPresentationChange('review')}
                            />
                            <View style={{ width: 1, backgroundColor: theme.colors.divider }} />
                            <Segment
                                active={changedFilesPresentation === 'list'}
                                label="List"
                                iconName="list-unordered"
                                first={false}
                                last={true}
                                onPress={() => onChangedFilesPresentationChange('list')}
                            />
                        </SegmentGroup>
                    </>
                ) : null}
            </View>

            {!showAllRepositoryFiles && changedFilesCount > 0 && !showSessionViewToggle && (
                <View
                    style={{
                        marginTop: 8,
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
