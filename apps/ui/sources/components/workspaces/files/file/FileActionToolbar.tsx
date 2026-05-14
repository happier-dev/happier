import * as React from 'react';
import { Platform, Pressable, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';

export type FileDisplayMode = 'file' | 'diff' | 'markdown';
export type FileDiffMode = 'included' | 'pending' | 'both';

const FILE_ACTION_TOOLBAR_COMPACT_WIDTH = 520;
const FILE_ACTION_TOOLBAR_COMPACT_HORIZONTAL_PADDING = 12;
const FILE_ACTION_TOOLBAR_DEFAULT_HORIZONTAL_PADDING = 16;
const FILE_ACTION_TOOLBAR_COMPACT_GAP = 6;
const FILE_ACTION_TOOLBAR_DEFAULT_GAP = 8;

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
    lineSelectionCanStart?: boolean;
    lineSelectionActive?: boolean;
    rangeSelectionActive?: boolean;
    reviewCommentsEnabled?: boolean;
    commentModeActive?: boolean;
    selectedLineCount: number;
    appliedLineSelectionCount?: number;
    isApplyingStage: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    onStageFile: () => void;
    onUnstageFile: () => void;
    onApplySelectedLines: () => void | Promise<void>;
    onClearSelection: () => void;
    onStartLineSelection?: () => void;
    onStartRangeSelection?: () => void;
    onToggleCommentMode?: (active: boolean) => void;
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
        lineSelectionCanStart,
        lineSelectionActive,
        rangeSelectionActive,
        reviewCommentsEnabled,
        commentModeActive,
        selectedLineCount,
        appliedLineSelectionCount,
        isApplyingStage,
        inFlightScmOperation,
        onStageFile,
        onUnstageFile,
        onApplySelectedLines,
        onClearSelection,
        onStartLineSelection,
        onStartRangeSelection,
        onToggleCommentMode,
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
    const canIncludeFileInSelection = virtualSelectionEnabled ? canIncludeFile && !isSelectedForCommit : canIncludeFile;
    const canRemoveFromSelection = virtualSelectionEnabled ? isSelectedForCommit : hasIncludedDelta;
    const showFileEditorActions = fileEditorEnabled === true;
    const shouldShowDiffToggle = showDiffToggle !== false;
    const shouldShowFileToggle = showFileToggle !== false;
    const shouldShowMarkdownToggle = showMarkdownToggle === true;
    const displayToggleCount = (shouldShowDiffToggle ? 1 : 0)
        + (shouldShowFileToggle ? 1 : 0)
        + (shouldShowMarkdownToggle ? 1 : 0);
    const shouldShowDisplayToggles = displayToggleCount > 1;
    const [displayMenuOpen, setDisplayMenuOpen] = React.useState(false);
    const [diffAreaMenuOpen, setDiffAreaMenuOpen] = React.useState(false);
    const stageLabel = virtualSelectionEnabled ? t('files.fileActions.selectForCommit') : t('files.fileActions.stageFile');
    const unstageLabel = virtualSelectionEnabled ? t('files.fileActions.removeFromCommitSelection') : t('files.fileActions.unstageFile');
    const commandIconSize = 14;
    const isLineSelectionActive = lineSelectionActive === true;
    const canStartLineSelection = lineSelectionCanStart === true || lineSelectionEnabled;
    const isCommentModeActive = commentModeActive === true;
    const isRangeSelectionActive = rangeSelectionActive === true;
    const hasSelectedLines = isLineSelectionActive && lineSelectionEnabled && selectedLineCount > 0;
    const hasAppliedPartialLineSelection = !isLineSelectionActive
        && lineSelectionEnabled
        && virtualSelectionEnabled
        && (appliedLineSelectionCount ?? 0) > 0;
    const showEmptyLineSelectionActions = lineSelectionEnabled && isLineSelectionActive && !hasSelectedLines;
    const stageFileActionLabel = showEmptyLineSelectionActions && virtualSelectionEnabled
        ? t('files.fileActions.selectEntireFileForCommit')
        : stageLabel;
    const showCompactCommitSelectionEntry = virtualSelectionEnabled && !isLineSelectionActive;
    const selectedLineActionIsRemoval = !virtualSelectionEnabled && diffMode === 'included';
    const selectedLineActionColor = selectedLineActionIsRemoval ? theme.colors.state.neutral.foreground : theme.colors.state.success.foreground;
    const selectedLineActionLabel = virtualSelectionEnabled
        ? t('files.fileActions.selectedLines.selectLinesForCommit')
        : selectedLineActionIsRemoval
            ? t('files.fileActions.selectedLines.unstageSelectedLines')
            : t('files.fileActions.selectedLines.stageSelectedLines');
    const handleStageFilePress = React.useCallback(() => {
        if (canStartLineSelection && !isLineSelectionActive) {
            onStartLineSelection?.();
            return;
        }
        onStageFile();
    }, [canStartLineSelection, isLineSelectionActive, onStageFile, onStartLineSelection]);
    const stageFileButtonStyle = (showCompactCommitSelectionEntry
        ? {
            width: 32,
            height: 32,
            minHeight: 32,
            paddingHorizontal: 0,
            paddingVertical: 0,
            borderRadius: 10,
            backgroundColor: theme.colors.surface.base,
            borderWidth: 1,
            borderColor: theme.colors.border.default,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: actionBusy ? 0.6 : 1,
        }
        : {
            paddingHorizontal: 12,
            paddingVertical: 6,
            minHeight: 32,
            borderRadius: 10,
            backgroundColor: theme.colors.surface.base,
            borderWidth: 1,
            borderColor: theme.colors.state.success.foreground,
            opacity: actionBusy ? 0.6 : 1,
        }) satisfies ViewStyle;
    const stageFileButtonContent = showCompactCommitSelectionEntry ? (
        <Octicons name="plus" size={commandIconSize} color={theme.colors.text.secondary} />
    ) : (
        <Text
            pointerEvents="none"
            style={{ color: theme.colors.state.success.foreground, fontSize: 13, ...Typography.default('semiBold') }}
        >
            {stageFileActionLabel}
        </Text>
    );
    const pathDir = typeof filePathDir === 'string' ? filePathDir.trim().replace(/\/+$/, '') : '';
    const pathName = typeof fileName === 'string' ? fileName.trim() : '';
    const pathLabel = pathDir && pathName
        ? `${pathDir}/${pathName}`
        : pathName || pathDir || null;
    const [toolbarWidth, setToolbarWidth] = React.useState<number | null>(null);
    const useCompactLayout = toolbarWidth !== null && toolbarWidth < FILE_ACTION_TOOLBAR_COMPACT_WIDTH;
    const useCompactSelectedLineActions = useCompactLayout && hasSelectedLines;
    const toolbarHorizontalPadding = useCompactLayout
        ? FILE_ACTION_TOOLBAR_COMPACT_HORIZONTAL_PADDING
        : FILE_ACTION_TOOLBAR_DEFAULT_HORIZONTAL_PADDING;
    const actionGap = useCompactLayout ? FILE_ACTION_TOOLBAR_COMPACT_GAP : FILE_ACTION_TOOLBAR_DEFAULT_GAP;

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
        backgroundColor: active ? theme.colors.surface.inset : theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        alignItems: 'center',
        justifyContent: 'center',
    }) as const;

    const displayModeItems = React.useMemo<DropdownMenuItem[]>(() => {
        const items: DropdownMenuItem[] = [];
        if (shouldShowDiffToggle) {
            items.push({
                id: 'diff',
                title: t('files.diff'),
                icon: <Octicons name="diff" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (shouldShowFileToggle) {
            items.push({
                id: 'file',
                title: t('files.file'),
                icon: <Octicons name="file" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (shouldShowMarkdownToggle) {
            items.push({
                id: 'markdown',
                title: t('files.markdown'),
                icon: <Octicons name="markdown" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        return items;
    }, [commandIconSize, shouldShowDiffToggle, shouldShowFileToggle, shouldShowMarkdownToggle, theme.colors.text.secondary]);

    const diffAreaItems = React.useMemo<DropdownMenuItem[]>(() => {
        const items: DropdownMenuItem[] = [];
        if (hasPendingDelta) {
            items.push({
                id: 'pending',
                title: t('files.diffModes.pending'),
                icon: <Octicons name="clock" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (hasIncludedDelta) {
            items.push({
                id: 'included',
                title: t('files.diffModes.included'),
                icon: <Octicons name="checklist" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (hasIncludedDelta && hasPendingDelta) {
            items.push({
                id: 'both',
                title: t('files.diffModes.combined'),
                icon: <Octicons name="diff" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        return items;
    }, [commandIconSize, hasIncludedDelta, hasPendingDelta, theme.colors.text.secondary]);

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
                        color: theme.colors.text.primary,
                        ...Typography.default(),
                    }}
                    numberOfLines={1}
                >
                    {input.label}
                </Text>
                <Octicons name="chevron-down" size={12} color={theme.colors.text.secondary} />
            </View>
        </Pressable>
    ), [chipStyle, theme.colors.text.primary, theme.colors.text.secondary]);

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
                    color: theme.colors.text.secondary,
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
                flexWrap: useCompactSelectedLineActions ? 'nowrap' : 'wrap',
                alignItems: 'center',
                gap: actionGap,
                flexShrink: 0,
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
                        icon: <Octicons name={selectedDisplayIconName} size={commandIconSize} color={theme.colors.text.secondary} />,
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
                    <Octicons name="pencil" size={commandIconSize} color={theme.colors.text.primary} />
                </Pressable>
            ) : null}

            {reviewCommentsEnabled === true && onToggleCommentMode ? (
                <Pressable
                    onPress={() => onToggleCommentMode(!isCommentModeActive)}
                    testID="file-details-comment-mode"
                    style={[chipStyle(isCommentModeActive), { width: 32, height: 32, paddingHorizontal: 0, paddingVertical: 0 }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.reviewComments.addCommentA11y')}
                >
                    <Octicons
                        name="comment-discussion"
                        size={commandIconSize}
                        color={isCommentModeActive ? theme.colors.text.primary : theme.colors.text.secondary}
                    />
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
                            backgroundColor: theme.colors.text.link,
                            opacity: Boolean(fileEditorBusy) || !fileEditorDirty ? 0.6 : 1,
                        }}
                    >
                        <Text style={{ color: 'white', fontSize: 13, ...Typography.default('semiBold') }}>
                            {t('common.save')}
                        </Text>
                    </Pressable>
                    <Pressable onPress={onCancelEditingFile} testID="file-details-cancel" style={chipStyle(false)}>
                        <Text style={{ color: theme.colors.text.primary, fontSize: 13, ...Typography.default('semiBold') }}>
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
                        icon: <Octicons name="clock" size={commandIconSize} color={theme.colors.text.secondary} />,
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
                flexWrap: useCompactSelectedLineActions ? 'nowrap' : 'wrap',
                alignItems: 'center',
                justifyContent: useCompactSelectedLineActions ? 'flex-start' : useCompactLayout ? 'space-between' : 'flex-start',
                gap: actionGap,
                flex: useCompactLayout && !useCompactSelectedLineActions ? 1 : undefined,
                flexShrink: useCompactSelectedLineActions ? 0 : undefined,
            }}
        >
            {lineSelectionEnabled ? (
                <View
                    testID="file-details-line-selection-available"
                    style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                />
            ) : null}
            {isLineSelectionActive && lineSelectionEnabled ? (
                <View
                    testID="file-details-line-selection-active"
                    style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                />
            ) : null}
            {isLineSelectionActive && lineSelectionEnabled && onStartRangeSelection ? (
                <Pressable
                    onPress={onStartRangeSelection}
                    testID="file-details-range-selection"
                    style={chipStyle(isRangeSelectionActive)}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.fileActions.rangeSelection')}
                >
                    <Text style={{ color: theme.colors.text.primary, fontSize: 13, ...Typography.default('semiBold') }}>
                        {t('files.fileActions.rangeSelection')}
                    </Text>
                </Pressable>
            ) : null}
            {scmWriteEnabled && canUseSelectionActions && canIncludeFileInSelection && !hasSelectedLines && (
                <Pressable
                    disabled={actionBusy}
                    onPress={handleStageFilePress}
                    testID="file-details-stage-file"
                    accessibilityRole="button"
                    accessibilityLabel={stageFileActionLabel}
                    style={stageFileButtonStyle}
                >
                    {stageFileButtonContent}
                </Pressable>
            )}

            {showEmptyLineSelectionActions ? (
                <Pressable
                    onPress={onClearSelection}
                    testID="file-details-clear-selection"
                    style={chipStyle(false)}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                >
                    <Text style={{ color: theme.colors.text.primary, fontSize: 13, ...Typography.default('semiBold') }}>
                        {t('common.cancel')}
                    </Text>
                </Pressable>
            ) : null}

            {scmWriteEnabled && canUseSelectionActions && canRemoveFromSelection && !hasSelectedLines && (
                <Pressable
                    disabled={actionBusy}
                    onPress={onUnstageFile}
                    testID="file-details-unstage-file"
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        minHeight: 32,
                        borderRadius: 10,
                        backgroundColor: theme.colors.surface.base,
                        borderWidth: 1,
                        borderColor: theme.colors.state.neutral.foreground,
                        opacity: actionBusy ? 0.6 : 1,
                    }}
                >
                    <Text style={{ color: theme.colors.state.neutral.foreground, fontSize: 13, ...Typography.default('semiBold') }}>
                        {unstageLabel}
                    </Text>
                </Pressable>
            )}

            {scmWriteEnabled && canUseSelectionActions && hasAppliedPartialLineSelection && onStartLineSelection ? (
                <Pressable
                    disabled={actionBusy}
                    onPress={onStartLineSelection}
                    testID="file-details-edit-line-selection"
                    style={[chipStyle(false), { width: 32, height: 32, paddingHorizontal: 0, paddingVertical: 0 }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.edit')}
                >
                    <Octicons name="pencil" size={commandIconSize} color={theme.colors.text.primary} />
                </Pressable>
            ) : null}

            {scmWriteEnabled && canUseSelectionActions && diffMode === 'both' && !hasSelectedLines && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.text.secondary,
                        ...Typography.default(),
                    }}
                >
                    {t('files.fileActions.selectionHint')}
                </Text>
            )}

            {hasSelectedLines && (
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
                            backgroundColor: theme.colors.surface.base,
                            borderWidth: 1,
                            borderColor: selectedLineActionColor,
                            opacity: actionBusy ? 0.6 : 1,
                            flexShrink: useCompactSelectedLineActions ? 0 : undefined,
                        }}
                    >
                        <Text
                            numberOfLines={1}
                            style={{ color: selectedLineActionColor, fontSize: 13, ...Typography.default('semiBold') }}
                        >
                            {selectedLineActionLabel}
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={onClearSelection}
                        testID="file-details-clear-selection"
                        style={[chipStyle(false), { width: 32, height: 32, paddingHorizontal: 0, paddingVertical: 0, flexShrink: 0 }]}
                        accessibilityRole="button"
                        accessibilityLabel={t('files.fileActions.clearSelection')}
                    >
                        <Octicons name="x" size={commandIconSize} color={theme.colors.text.secondary} />
                    </Pressable>
                </>
            )}
            {rightElement ? (
                <View testID="file-details-right" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
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
                paddingHorizontal: toolbarHorizontalPadding,
                paddingVertical: 12,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.base,
                gap: actionGap,
            }}
        >
            {pathElement}
            {useCompactSelectedLineActions ? (
                <HorizontalScrollableRow
                    testID="file-details-compact-action-scroll"
                    contentTestID="file-details-compact-action-scroll-content"
                    fadeColor={theme.colors.surface.base}
                    indicatorColor={theme.colors.text.secondary}
                    containerStyle={{ marginHorizontal: -toolbarHorizontalPadding }}
                    contentStyle={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: actionGap,
                        paddingHorizontal: toolbarHorizontalPadding,
                        paddingRight: toolbarHorizontalPadding + 24,
                    }}
                >
                    {viewActionsElement}
                    {changeActionsElement}
                </HorizontalScrollableRow>
            ) : useCompactLayout ? (
                <View
                    testID="file-details-compact-action-row"
                    style={{
                        flexDirection: 'row',
                        flexWrap: useCompactSelectedLineActions ? 'nowrap' : 'wrap',
                        alignItems: 'center',
                        justifyContent: useCompactSelectedLineActions ? 'flex-start' : 'space-between',
                        gap: actionGap,
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
