import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';

export type FileDisplayMode = 'file' | 'diff';
export type FileDiffMode = 'included' | 'pending' | 'both';

type FileActionToolbarProps = {
    theme: any;
    displayMode: FileDisplayMode;
    onDisplayMode: (mode: FileDisplayMode) => void;
    showDiffToggle?: boolean;
    showFileToggle?: boolean;
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
    fileEditorEnabled?: boolean;
    isEditingFile?: boolean;
    fileEditorDirty?: boolean;
    fileEditorBusy?: boolean;
    onStartEditingFile?: () => void;
    onCancelEditingFile?: () => void;
    onSaveEditingFile?: () => void;
};

export function FileActionToolbar(props: FileActionToolbarProps) {
    const {
        theme,
        displayMode,
        onDisplayMode,
        showDiffToggle,
        showFileToggle,
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
        fileEditorEnabled,
        isEditingFile,
        fileEditorDirty,
        fileEditorBusy,
        onStartEditingFile,
        onCancelEditingFile,
        onSaveEditingFile,
    } = props;

    const actionBusy = isApplyingStage || Boolean(inFlightScmOperation);
    const canIncludeFile = hasPendingDelta || isUntrackedFile === true;
    const canUseSelectionActions = includeExcludeEnabled || virtualSelectionEnabled;
    const canRemoveFromSelection = virtualSelectionEnabled ? isSelectedForCommit : hasIncludedDelta;
    const showFileEditorActions = fileEditorEnabled === true;
    const shouldShowDiffToggle = showDiffToggle !== false;
    const shouldShowFileToggle = showFileToggle !== false;
    const displayToggleCount = (shouldShowDiffToggle ? 1 : 0) + (shouldShowFileToggle ? 1 : 0);
    const shouldShowDisplayToggles = displayToggleCount > 1;
    const stageLabel = virtualSelectionEnabled ? t('files.fileActions.selectForCommit') : t('files.fileActions.stageFile');
    const unstageLabel = virtualSelectionEnabled ? t('files.fileActions.removeFromSelection') : t('files.fileActions.unstageFile');

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
            {shouldShowDisplayToggles ? (
                <>
                    {shouldShowDiffToggle ? (
                        <Pressable
                            onPress={() => onDisplayMode('diff')}
                            testID="file-details-toggle-diff"
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
                    ) : null}

                    {shouldShowFileToggle ? (
                        <Pressable
                            onPress={() => onDisplayMode('file')}
                            testID="file-details-toggle-file"
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
                    ) : null}
                </>
            ) : null}

            {showFileEditorActions && !isEditingFile && onStartEditingFile ? (
                <Pressable
                    onPress={() => {
                        onDisplayMode('file');
                        onStartEditingFile();
                    }}
                    testID="file-details-edit"
                    style={chipStyle(false)}
                >
                    <Text
                        style={{
                            fontSize: 13,
                            fontWeight: '600',
                            color: theme.colors.text,
                            ...Typography.default(),
                        }}
                      >
                          {t('common.edit')}
                      </Text>
                  </Pressable>
              ) : null}

            {showFileEditorActions && displayMode === 'file' && isEditingFile ? (
                <>
                    <Pressable
                        disabled={Boolean(fileEditorBusy) || !fileEditorDirty}
                        onPress={onSaveEditingFile}
                        testID="file-details-save"
                        style={{
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            borderRadius: 10,
                            backgroundColor: theme.colors.textLink,
                            opacity: Boolean(fileEditorBusy) || !fileEditorDirty ? 0.6 : 1,
                        }}
                      >
                          <Text style={{ color: 'white', fontSize: 13, ...Typography.default('semiBold') }}>
                              {t('common.save')}
                          </Text>
                      </Pressable>
                      <Pressable onPress={onCancelEditingFile} testID="file-details-cancel" style={chipStyle(false)}>
                          <Text style={{ color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') }}>
                              {t('common.cancel')}
                          </Text>
                      </Pressable>
                </>
            ) : null}

            {hasPendingDelta && (
                <Pressable
                    onPress={() => onDiffMode('pending')}
                    style={chipStyle(diffMode === 'pending')}
                  >
                      <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                          {t('files.diffModes.pending')}
                      </Text>
                  </Pressable>
              )}

            {hasIncludedDelta && (
                <Pressable
                    onPress={() => onDiffMode('included')}
                    style={chipStyle(diffMode === 'included')}
                  >
                      <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                          {t('files.diffModes.included')}
                      </Text>
                  </Pressable>
              )}

            {hasIncludedDelta && hasPendingDelta && (
                <Pressable
                    onPress={() => onDiffMode('both')}
                    style={chipStyle(diffMode === 'both')}
                  >
                      <Text style={{ fontSize: 13, color: theme.colors.text, ...Typography.default('semiBold') }}>
                          {t('files.diffModes.combined')}
                      </Text>
                  </Pressable>
              )}

            {scmWriteEnabled && canUseSelectionActions && canIncludeFile && (
                <Pressable
                    disabled={actionBusy}
                    onPress={onStageFile}
                    testID="file-details-stage-file"
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 10,
                        backgroundColor: theme.colors.success,
                        opacity: actionBusy ? 0.6 : 1,
                    }}
                  >
                      <Text style={{ color: 'white', fontSize: 13, ...Typography.default('semiBold') }}>
                          {stageLabel}
                      </Text>
                  </Pressable>
              )}

            {scmWriteEnabled && canUseSelectionActions && canRemoveFromSelection && (
                <Pressable
                    disabled={actionBusy}
                    onPress={onUnstageFile}
                    testID="file-details-unstage-file"
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 10,
                        backgroundColor: theme.colors.warning,
                        opacity: actionBusy ? 0.6 : 1,
                    }}
                  >
                      <Text style={{ color: 'white', fontSize: 13, ...Typography.default('semiBold') }}>
                          {unstageLabel}
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
                      {t('files.fileActions.selectionHint')}
                  </Text>
              )}

            {lineSelectionEnabled && selectedLineCount > 0 && (
                <>
                    <Pressable
                        disabled={actionBusy}
                        onPress={onApplySelectedLines}
                        testID="file-details-apply-selected-lines"
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
                                  ? t('files.fileActions.selectedLines.selectLinesForCommit')
                                  : diffMode === 'included'
                                      ? t('files.fileActions.selectedLines.unstageSelectedLines')
                                      : t('files.fileActions.selectedLines.stageSelectedLines')}
                          </Text>
                      </Pressable>
                      <Pressable
                          onPress={onClearSelection}
                          testID="file-details-clear-selection"
                        style={chipStyle(false)}
                      >
                          <Text style={{ color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') }}>
                              {t('files.fileActions.clearSelection')}
                          </Text>
                      </Pressable>
                  </>
              )}
        </View>
    );
}
