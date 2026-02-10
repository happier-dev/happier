import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { GitProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';

export type FileDisplayMode = 'file' | 'diff';
export type FileDiffMode = 'staged' | 'unstaged' | 'both';

type FileActionToolbarProps = {
    theme: any;
    displayMode: FileDisplayMode;
    onDisplayMode: (mode: FileDisplayMode) => void;
    diffMode: FileDiffMode;
    onDiffMode: (mode: FileDiffMode) => void;
    hasUnstagedDelta: boolean;
    hasStagedDelta: boolean;
    isUntrackedFile?: boolean;
    gitWriteEnabled: boolean;
    lineSelectionEnabled: boolean;
    selectedLineCount: number;
    isApplyingStage: boolean;
    hasConflicts: boolean;
    inFlightGitOperation: GitProjectInFlightOperation | null;
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
        hasUnstagedDelta,
        hasStagedDelta,
        isUntrackedFile,
        gitWriteEnabled,
        lineSelectionEnabled,
        selectedLineCount,
        isApplyingStage,
        hasConflicts,
        inFlightGitOperation,
        onStageFile,
        onUnstageFile,
        onApplySelectedLines,
        onClearSelection,
    } = props;

    const actionBusy = isApplyingStage || hasConflicts || Boolean(inFlightGitOperation);
    const canStageFile = hasUnstagedDelta || isUntrackedFile === true;

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

            {hasUnstagedDelta && (
                <Pressable
                    onPress={() => onDiffMode('unstaged')}
                    style={chipStyle(diffMode === 'unstaged')}
                >
                    <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        Unstaged
                    </Text>
                </Pressable>
            )}

            {hasStagedDelta && (
                <Pressable
                    onPress={() => onDiffMode('staged')}
                    style={chipStyle(diffMode === 'staged')}
                >
                    <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        Staged
                    </Text>
                </Pressable>
            )}

            {hasStagedDelta && hasUnstagedDelta && (
                <Pressable
                    onPress={() => onDiffMode('both')}
                    style={chipStyle(diffMode === 'both')}
                >
                    <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        Combined
                    </Text>
                </Pressable>
            )}

            {gitWriteEnabled && canStageFile && (
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
                    <Text style={{ color: 'white', fontSize: 13, ...Typography.default('semiBold') }}>Stage file</Text>
                </Pressable>
            )}

            {gitWriteEnabled && hasStagedDelta && (
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
                    <Text style={{ color: 'white', fontSize: 13, ...Typography.default('semiBold') }}>Unstage file</Text>
                </Pressable>
            )}

            {gitWriteEnabled && diffMode === 'both' && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    Select Staged or Unstaged to enable line selection.
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
                            {diffMode === 'staged' ? 'Unstage selected lines' : 'Stage selected lines'}
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
