import * as React from 'react';
import { Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';

export type FileDisplayMode = 'file' | 'diff' | 'markdown';
export type FileDiffMode = 'included' | 'pending' | 'both';

const FILE_ACTION_TOOLBAR_COMPACT_WIDTH = 520;

type FileActionToolbarProps = {
    theme: any;
    fileName?: string;
    filePathDir?: string;
    rightElement?: React.ReactNode;
    displayMode: FileDisplayMode;
    onDisplayMode: (mode: FileDisplayMode) => void;
    showDiffToggle?: boolean;
    showFileToggle?: boolean;
    showMarkdownToggle?: boolean;
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
        fileName,
        filePathDir,
        rightElement,
        displayMode,
        onDisplayMode,
        showDiffToggle,
        showFileToggle,
        showMarkdownToggle,
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
    const shouldShowMarkdownToggle = showMarkdownToggle === true;
    const displayToggleCount = (shouldShowDiffToggle ? 1 : 0)
        + (shouldShowFileToggle ? 1 : 0)
        + (shouldShowMarkdownToggle ? 1 : 0);
    const shouldShowDisplayToggles = displayToggleCount > 1;
    const [toolbarWidth, setToolbarWidth] = React.useState<number | null>(null);
    const [displayMenuOpen, setDisplayMenuOpen] = React.useState(false);
    const [diffAreaMenuOpen, setDiffAreaMenuOpen] = React.useState(false);
    const stageLabel = virtualSelectionEnabled ? t('files.fileActions.selectForCommit') : t('files.fileActions.stageFile');
    const unstageLabel = virtualSelectionEnabled ? t('files.fileActions.removeFromSelection') : t('files.fileActions.unstageFile');
    const commandIconSize = 14;
    const pathDir = typeof filePathDir === 'string' ? filePathDir.trim().replace(/\/+$/, '') : '';
    const pathName = typeof fileName === 'string' ? fileName.trim() : '';
    const pathLabel = pathDir && pathName
        ? `${pathDir}/${pathName}`
        : pathName || pathDir || null;
    const useCompactLayout = toolbarWidth !== null && toolbarWidth < FILE_ACTION_TOOLBAR_COMPACT_WIDTH;

    const onToolbarLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = Number(event.nativeEvent.layout.width);
        if (!Number.isFinite(width) || width <= 0) return;
        setToolbarWidth((current) => current === width ? current : width);
    }, []);

    const chipStyle = (active: boolean) => ({
        minHeight: 32,
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 10,
        backgroundColor: active ? theme.colors.surfaceHigh : theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        alignItems: 'center',
        justifyContent: 'center',
    }) as const;

    const displayModeItems = React.useMemo<DropdownMenuItem[]>(() => {
        const items: DropdownMenuItem[] = [];
        if (shouldShowDiffToggle) {
            items.push({
                id: 'diff',
                title: t('files.diff'),
                icon: <Octicons name="diff" size={commandIconSize} color={theme.colors.textSecondary} />,
            });
        }
        if (shouldShowFileToggle) {
            items.push({
                id: 'file',
                title: t('files.file'),
                icon: <Octicons name="file" size={commandIconSize} color={theme.colors.textSecondary} />,
            });
        }
        if (shouldShowMarkdownToggle) {
            items.push({
                id: 'markdown',
                title: t('files.markdown'),
                icon: <Octicons name="markdown" size={commandIconSize} color={theme.colors.textSecondary} />,
            });
        }
        return items;
    }, [commandIconSize, shouldShowDiffToggle, shouldShowFileToggle, shouldShowMarkdownToggle, theme.colors.textSecondary]);

    const diffAreaItems = React.useMemo<DropdownMenuItem[]>(() => {
        const items: DropdownMenuItem[] = [];
        if (hasPendingDelta) {
            items.push({
                id: 'pending',
                title: t('files.diffModes.pending'),
                icon: <Octicons name="clock" size={commandIconSize} color={theme.colors.textSecondary} />,
            });
        }
        if (hasIncludedDelta) {
            items.push({
                id: 'included',
                title: t('files.diffModes.included'),
                icon: <Octicons name="checklist" size={commandIconSize} color={theme.colors.textSecondary} />,
            });
        }
        if (hasIncludedDelta && hasPendingDelta) {
            items.push({
                id: 'both',
                title: t('files.diffModes.combined'),
                icon: <Octicons name="diff" size={commandIconSize} color={theme.colors.textSecondary} />,
            });
        }
        return items;
    }, [commandIconSize, hasIncludedDelta, hasPendingDelta, theme.colors.textSecondary]);

    const selectedDisplayLabel = displayMode === 'diff'
        ? t('files.diff')
        : displayMode === 'markdown'
            ? t('files.markdown')
            : t('files.file');
    const selectedDisplayIconName = displayMode === 'diff'
        ? 'diff'
        : displayMode === 'markdown'
            ? 'markdown'
            : 'file';
    const selectedDiffAreaLabel = diffAreaItems.find((item) => item.id === diffMode)?.title
        ?? (diffMode === 'included'
            ? t('files.diffModes.included')
            : diffMode === 'both'
                ? t('files.diffModes.combined')
                : t('files.diffModes.pending'));

    const renderDropdownTrigger = React.useCallback((input: Readonly<{
        label: string;
        icon: React.ReactNode;
        testID: string;
        selected?: boolean;
        toggle: () => void;
    }>) => (
        <Pressable
            onPress={input.toggle}
            testID={input.testID}
            style={chipStyle(input.selected === true)}
            accessibilityRole="button"
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {input.icon}
                <Text
                    style={{
                        fontSize: 13,
                        fontWeight: '600',
                        color: theme.colors.text,
                        ...Typography.default(),
                    }}
                    numberOfLines={1}
                >
                    {input.label}
                </Text>
                <Octicons name="chevron-down" size={12} color={theme.colors.textSecondary} />
            </View>
        </Pressable>
    ), [chipStyle, theme.colors.text, theme.colors.textSecondary]);

    const pathElement = pathLabel ? (
        <View
            testID="file-details-path"
            style={{
                minHeight: 32,
                justifyContent: 'center',
                maxWidth: useCompactLayout ? '100%' : 190,
                width: useCompactLayout ? '100%' : undefined,
                paddingHorizontal: 4,
            }}
        >
            <Text
                style={{
                    fontSize: 12,
                    color: theme.colors.textSecondary,
                    ...(Typography.mono ? Typography.mono() : Typography.default()),
                }}
                numberOfLines={1}
            >
                {pathLabel}
            </Text>
        </View>
    ) : null;

    const viewActionsElement = (
        <View
            testID="file-details-view-actions"
            style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 8,
            }}
        >
            {shouldShowDisplayToggles ? (
                <DropdownMenu
                    open={displayMenuOpen}
                    onOpenChange={setDisplayMenuOpen}
                    items={displayModeItems}
                    selectedId={displayMode}
                    onSelect={(itemId) => {
                        if (itemId === 'diff' || itemId === 'file' || itemId === 'markdown') {
                            onDisplayMode(itemId);
                        }
                    }}
                    matchTriggerWidth={false}
                    maxWidthCap={220}
                    placement="bottom"
                    popoverAnchorAlign="start"
                    trigger={({ toggle }) => renderDropdownTrigger({
                        label: selectedDisplayLabel,
                        icon: <Octicons name={selectedDisplayIconName} size={commandIconSize} color={theme.colors.textSecondary} />,
                        selected: true,
                        testID: 'file-details-view-mode-menu',
                        toggle,
                    })}
                />
            ) : null}

            {showFileEditorActions && !isEditingFile && onStartEditingFile ? (
                <Pressable
                    onPress={() => {
                        onDisplayMode('file');
                        onStartEditingFile();
                    }}
                    testID="file-details-edit"
                    style={[chipStyle(false), { width: 32, height: 32, paddingHorizontal: 0, paddingVertical: 0 }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.edit')}
                >
                    <Octicons name="pencil" size={commandIconSize} color={theme.colors.text} />
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

            {diffAreaItems.length > 1 ? (
                <DropdownMenu
                    open={diffAreaMenuOpen}
                    onOpenChange={setDiffAreaMenuOpen}
                    items={diffAreaItems}
                    selectedId={diffMode}
                    onSelect={(itemId) => {
                        if (itemId === 'pending' || itemId === 'included' || itemId === 'both') {
                            onDiffMode(itemId);
                        }
                    }}
                    matchTriggerWidth={false}
                    maxWidthCap={240}
                    placement="bottom"
                    popoverAnchorAlign="start"
                    trigger={({ toggle }) => renderDropdownTrigger({
                        label: selectedDiffAreaLabel,
                        icon: <Octicons name="clock" size={commandIconSize} color={theme.colors.textSecondary} />,
                        selected: true,
                        testID: 'file-details-diff-area-menu',
                        toggle,
                    })}
                />
            ) : null}
        </View>
    );

    const changeActionsElement = (
        <View
            testID="file-details-change-actions"
            style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: useCompactLayout ? 'space-between' : 'flex-start',
                gap: 8,
                flex: useCompactLayout ? 1 : undefined,
            }}
        >
            {scmWriteEnabled && canUseSelectionActions && canIncludeFile && (
                <Pressable
                    disabled={actionBusy}
                    onPress={onStageFile}
                    testID="file-details-stage-file"
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        minHeight: 32,
                        borderRadius: 10,
                        backgroundColor: theme.colors.surface,
                        borderWidth: 1,
                        borderColor: theme.colors.success,
                        opacity: actionBusy ? 0.6 : 1,
                    }}
                >
                    <Text style={{ color: theme.colors.success, fontSize: 13, ...Typography.default('semiBold') }}>
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
                        paddingVertical: 6,
                        minHeight: 32,
                        borderRadius: 10,
                        backgroundColor: theme.colors.surface,
                        borderWidth: 1,
                        borderColor: theme.colors.warning,
                        opacity: actionBusy ? 0.6 : 1,
                    }}
                >
                    <Text style={{ color: theme.colors.warning, fontSize: 13, ...Typography.default('semiBold') }}>
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
                            paddingVertical: 6,
                            minHeight: 32,
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
            {rightElement ? (
                <View testID="file-details-right" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {rightElement}
                </View>
            ) : null}
        </View>
    );

    return (
        <View
            testID="file-action-toolbar"
            onLayout={onToolbarLayout}
            style={{
                flexDirection: useCompactLayout ? 'column' : 'row',
                flexWrap: 'nowrap',
                alignItems: useCompactLayout ? 'stretch' : 'center',
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
                backgroundColor: theme.colors.surface,
                gap: 8,
            }}
        >
            {pathElement}
            {useCompactLayout ? (
                <View
                    testID="file-details-compact-action-row"
                    style={{
                        flexDirection: 'row',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                    }}
                >
                    {viewActionsElement}
                    {changeActionsElement}
                </View>
            ) : (
                <>
                    {viewActionsElement}
                    {changeActionsElement}
                </>
            )}
        </View>
    );
}
