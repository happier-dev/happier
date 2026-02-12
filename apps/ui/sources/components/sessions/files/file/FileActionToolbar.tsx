import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';

export type FileDisplayMode = 'file' | 'diff';
export type FileDiffMode = 'included' | 'pending' | 'both';

type FileActionToolbarProps = {
    theme: any;
    displayMode: FileDisplayMode;
    onDisplayMode: (mode: FileDisplayMode) => void;
    diffMode: FileDiffMode;
    onDiffMode: (mode: FileDiffMode) => void;
    hasPendingDelta: boolean;
    hasIncludedDelta: boolean;
    isUntrackedFile?: boolean;
    scmWriteEnabled: boolean;
    includeExcludeEnabled: boolean;
    virtualSelectionEnabled: boolean;
    isSelectedForCommit: boolean;
    lineSelectionEnabled: boolean;
    selectedLineCount: number;
    isApplyingStage: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    onStageFile: () => void;
    onUnstageFile: () => void;
    onApplySelectedLines: () => void;
    onClearSelection: () => void;
};

export function FileActionToolbar(props: FileActionToolbarProps) {
    const {
        theme,
        displayMode,
        onDisplayMode,
        diffMode,
        onDiffMode,
        hasPendingDelta,
        hasIncludedDelta,
        isUntrackedFile,
        scmWriteEnabled,
        includeExcludeEnabled,
        virtualSelectionEnabled,
        isSelectedForCommit,
        lineSelectionEnabled,
        selectedLineCount,
        isApplyingStage,
        inFlightScmOperation,
        onStageFile,
        onUnstageFile,
        onApplySelectedLines,
        onClearSelection,
    } = props;

    const actionBusy = isApplyingStage || Boolean(inFlightScmOperation);
    const canIncludeFile = hasPendingDelta || isUntrackedFile === true;
    const canUseSelectionActions = includeExcludeEnabled || virtualSelectionEnabled;
    const canRemoveFromSelection = virtualSelectionEnabled ? isSelectedForCommit : hasIncludedDelta;

    const chipStyle = (active: boolean) => ({
        paddingVertical: 7,
        paddingHorizontal: 11,
        borderRadius: 10,
        backgroundColor: active ? theme.colors.surfaceHigh : theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    }) as const;

    return (
        <View
            style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
                backgroundColor: theme.colors.surface,
                gap: 8,
            }}
        >
            <Pressable
                onPress={() => onDisplayMode('diff')}
                style={chipStyle(displayMode === 'diff')}
            >
                <Text
                    style={{
                        fontSize: 13,
                        fontWeight: '600',
                        color: displayMode === 'diff' ? theme.colors.text : theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    {t('files.diff')}
                </Text>
            </Pressable>

            <Pressable
                onPress={() => onDisplayMode('file')}
                style={chipStyle(displayMode === 'file')}
            >
                <Text
                    style={{
                        fontSize: 13,
                        fontWeight: '600',
                        color: displayMode === 'file' ? theme.colors.text : theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    {t('files.file')}
                </Text>
            </Pressable>

            {hasPendingDelta && (
                <Pressable
                    onPress={() => onDiffMode('pending')}
                    style={chipStyle(diffMode === 'pending')}
                >
                    <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        Pending
                    </Text>
                </Pressable>
            )}

            {hasIncludedDelta && (
                <Pressable
                    onPress={() => onDiffMode('included')}
                    style={chipStyle(diffMode === 'included')}
                >
                    <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        Included
                    </Text>
                </Pressable>
            )}

            {hasIncludedDelta && hasPendingDelta && (
                <Pressable
                    onPress={() => onDiffMode('both')}
                    style={chipStyle(diffMode === 'both')}
                >
                    <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        Combined
                    </Text>
                </Pressable>
            )}

            {scmWriteEnabled && canUseSelectionActions && canIncludeFile && (
                <Pressable
                    disabled={actionBusy}
                    onPress={onStageFile}
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 10,
                        backgroundColor: theme.colors.success,
                        opacity: actionBusy ? 0.6 : 1,
                    }}
                >
                    <Text style={{ color: 'white', fontSize: 13, ...Typography.default('semiBold') }}>
                        {virtualSelectionEnabled ? 'Select for commit' : 'Stage file'}
                    </Text>
                </Pressable>
            )}

            {scmWriteEnabled && canUseSelectionActions && canRemoveFromSelection && (
                <Pressable
                    disabled={actionBusy}
                    onPress={onUnstageFile}
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 10,
                        backgroundColor: theme.colors.warning,
                        opacity: actionBusy ? 0.6 : 1,
                    }}
                >
                    <Text style={{ color: 'white', fontSize: 13, ...Typography.default('semiBold') }}>
                        {virtualSelectionEnabled ? 'Remove from selection' : 'Unstage file'}
                    </Text>
                </Pressable>
            )}

            {scmWriteEnabled && canUseSelectionActions && diffMode === 'both' && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    Select Included or Pending to enable line selection.
                </Text>
            )}

            {lineSelectionEnabled && selectedLineCount > 0 && (
                <>
                    <Pressable
                        disabled={actionBusy}
                        onPress={onApplySelectedLines}
                        style={{
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            borderRadius: 10,
                            backgroundColor: theme.colors.textLink,
                            opacity: actionBusy ? 0.6 : 1,
                        }}
                    >
                        <Text style={{ color: 'white', fontSize: 13, ...Typography.default('semiBold') }}>
                            {virtualSelectionEnabled
                                ? 'Select lines for commit'
                                : diffMode === 'included'
                                    ? 'Unstage selected lines'
                                    : 'Stage selected lines'}
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={onClearSelection}
                        style={chipStyle(false)}
                    >
                        <Text style={{ color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') }}>
                            Clear selection
                        </Text>
                    </Pressable>
                </>
            )}
        </View>
    );
}
