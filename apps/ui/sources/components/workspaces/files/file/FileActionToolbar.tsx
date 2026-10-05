import * as React from 'react';
import { Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { DetailsTabHeader, type DetailsTabHeaderAction, type DetailsTabHeaderMetaFact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { ToolbarSelect } from '@/components/ui/forms/ToolbarSelect';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { Text } from '@/components/ui/text/Text';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { resolveScmDiffAreaLabel } from '@/scm/diff/diffAreaLabels';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';
import type { MarkdownEditMode } from '@/components/ui/markdown/editor/markdownEditorTypes';
import type { MarkdownRichIneligibleReason } from '@/components/ui/markdown/editor/core/eligibility/markdownRichEligibility';
import { resolveMarkdownRichDisabledReasonCopy } from '@/components/ui/markdown/editor/core/eligibility/markdownRichDisabledReasonCopy';
import { Icon } from '@/components/ui/icons/Icon';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { WrapLinesToggleButton } from '@/components/ui/code/WrapLinesToggleButton';
import { FileIcon } from '@/components/ui/media/FileIcon';

export type FileDisplayMode = 'file' | 'diff' | 'markdown';
export type FileDiffMode = 'included' | 'pending' | 'both';

const selectionActionStyle = { minHeight: Platform.select({ ios: 44, android: 48, default: 34 }) };

const FILE_ACTION_TOOLBAR_COMPACT_WIDTH = 520;
const FILE_ACTION_TOOLBAR_COMPACT_GAP = 6;
const FILE_ACTION_TOOLBAR_DEFAULT_GAP = 8;

type FileActionToolbarProps = {
    theme: any;
    /** How the file changed, in words ("Modified", "Added"); absent for an unchanged file. */
    statusLabel?: string | null;
    /** The lines this file adds and removes in the diff shown. */
    diffStat?: Readonly<{ added: number; removed: number }> | null;
    /** Facts about an unchanged file ("No changes", "34 lines", "TypeScript"). */
    summaryFacts?: readonly string[] | null;
    /** One line under the header (the file changed while you were editing it). */
    notice?: React.ReactNode;
    fileName?: string;
    filePathDir?: string;
    rightElement?: React.ReactNode;
    displayMode: FileDisplayMode;
    onDisplayMode: (mode: FileDisplayMode) => void;
    showDiffToggle?: boolean;
    showFileToggle?: boolean;
    showMarkdownToggle?: boolean;
    showWrapLinesToggle?: boolean;
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
    /** Raw<->Rich toggle (Lane I / I3): only shown for an editable markdown file. */
    showMarkdownEditToggle?: boolean;
    markdownEditMode?: MarkdownEditMode;
    onMarkdownEditMode?: (mode: MarkdownEditMode) => void;
    /**
     * Authoritative rich-eligibility from the edit-mode hook (N2). Passed through
     * explicitly rather than inferred from `markdownRichDisabledReason`, so the
     * toggle never has to second-guess the single source of truth.
     */
    markdownRichEligible?: boolean;
    /** When set, rich is unavailable; the reason is surfaced inline by the toggle. */
    markdownRichDisabledReason?: MarkdownRichIneligibleReason;
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
        showWrapLinesToggle,
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
        showMarkdownEditToggle,
        markdownEditMode,
        onMarkdownEditMode,
        markdownRichEligible,
        markdownRichDisabledReason,
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
    // While editing a markdown file, the view-mode dropdown is REPURPOSED to pick
    // the editing mode (Raw source vs Rich WYSIWYG): you cannot change the view
    // (file/diff/markdown) mid-edit, so one context-dependent control replaces the
    // old separate segmented Raw/Rich toggle. Editing always happens in the 'file'
    // display, so this is the single condition that flips the dropdown's purpose.
    const isMarkdownEditModeMenu = showFileEditorActions
        && isEditingFile === true
        && displayMode === 'file'
        && showMarkdownEditToggle === true
        && onMarkdownEditMode != null;
    const [displayMenuOpen, setDisplayMenuOpen] = React.useState(false);
    const stageLabel = virtualSelectionEnabled ? t('files.fileActions.selectEntireFileForCommit') : t('files.fileActions.stageFile');
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
    const showEmptyLineSelectionActions = isLineSelectionActive && !hasSelectedLines;
    const selectedLineActionIsRemoval = !virtualSelectionEnabled && diffMode === 'included';
    const selectedLineActionColor = selectedLineActionIsRemoval ? theme.colors.state.neutral.foreground : theme.colors.state.success.foreground;
    const selectedLineActionLabel = virtualSelectionEnabled
        ? t('files.fileActions.selectedLines.selectLinesForCommit')
        : selectedLineActionIsRemoval
            ? t('files.fileActions.selectedLines.unstageSelectedLines')
            : t('files.fileActions.selectedLines.stageSelectedLines');
    const pathDir = typeof filePathDir === 'string' ? filePathDir.trim().replace(/\/+$/, '') : '';
    const pathName = typeof fileName === 'string' ? fileName.trim() : '';
    const [toolbarWidth, setToolbarWidth] = React.useState<number | null>(null);
    const useCompactLayout = toolbarWidth !== null && toolbarWidth < FILE_ACTION_TOOLBAR_COMPACT_WIDTH;
    const useCompactSelectedLineActions = useCompactLayout && hasSelectedLines;
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
                icon: <Icon name="git-diff" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (shouldShowFileToggle) {
            items.push({
                id: 'file',
                title: t('files.file'),
                icon: <Icon name="file" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (shouldShowMarkdownToggle) {
            items.push({
                id: 'markdown',
                title: t('files.markdown'),
                icon: <Icon name="markdown-logo" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        return items;
    }, [commandIconSize, shouldShowDiffToggle, shouldShowFileToggle, shouldShowMarkdownToggle, theme.colors.text.secondary]);

    // Edit-mode options shown in the repurposed dropdown while editing markdown.
    // Rich is disabled (with the reason as a subtitle) when the file is ineligible.
    const markdownEditModeItems = React.useMemo<DropdownMenuItem[]>(() => {
        const richDisabled = markdownRichEligible !== true;
        return [
            {
                id: 'raw',
                title: t('settingsSourceControl.markdownEditMode.options.raw.title'),
                icon: <Icon name="code" size={commandIconSize} color={theme.colors.text.secondary} />,
            },
            {
                id: 'rich',
                title: t('settingsSourceControl.markdownEditMode.options.rich.title'),
                icon: <Icon name="markdown-logo" size={commandIconSize} color={theme.colors.text.secondary} />,
                disabled: richDisabled,
                subtitle: richDisabled ? resolveMarkdownRichDisabledReasonCopy(markdownRichDisabledReason) : undefined,
            },
        ];
    }, [commandIconSize, markdownRichEligible, markdownRichDisabledReason, theme.colors.text.secondary]);

    const diffAreaItems = React.useMemo<DropdownMenuItem[]>(() => {
        const items: DropdownMenuItem[] = [];
        if (hasPendingDelta) {
            items.push({
                id: 'pending',
                title: t('files.diffModes.pending'),
                icon: <Icon name="clock" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (hasIncludedDelta) {
            items.push({
                id: 'included',
                title: t('files.diffModes.included'),
                icon: <Icon name="list-checks" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (hasIncludedDelta && hasPendingDelta) {
            items.push({
                id: 'both',
                title: t('files.diffModes.combined'),
                icon: <Icon name="git-diff" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        return items;
    }, [commandIconSize, hasIncludedDelta, hasPendingDelta, theme.colors.text.secondary]);

    // Reflect the EFFECTIVE mode (what's actually rendered), not the stored
    // preference: a 'rich' preference on an INELIGIBLE file renders Raw, so the
    // dropdown trigger + selection must read "Raw" (the disabled Rich option + its
    // reason explain why). Showing "Rich" while raw is rendered is misleading.
    const effectiveMarkdownEditMode = markdownEditMode === 'rich' && markdownRichEligible === true ? 'rich' : 'raw';
    const selectedMarkdownEditModeLabel = effectiveMarkdownEditMode === 'rich'
        ? t('settingsSourceControl.markdownEditMode.options.rich.title')
        : t('settingsSourceControl.markdownEditMode.options.raw.title');
    const selectedMarkdownEditModeIconName = effectiveMarkdownEditMode === 'rich' ? 'markdown-logo' : 'code';
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
                <Icon name="caret-down" size={14} color={theme.colors.text.secondary} />
            </View>
        </Pressable>
    ), [chipStyle, theme.colors.text.primary, theme.colors.text.secondary]);

    const indexStaging = !virtualSelectionEnabled;
    // The one diff-area vocabulary owner (index vs Happier's commit selection).
    const areaVocabulary = indexStaging ? 'index' : 'selection';
    const areaItems = diffAreaItems.map((item) => ({ id: item.id, title: resolveScmDiffAreaLabel(item.id as FileDiffMode, areaVocabulary) }));

    const displaySegments = displayModeItems.map((item) => ({
        id: item.id as FileDisplayMode,
        label: item.id === 'markdown' ? t('detailsSurface.file.preview') : item.title,
    }));

    const iconSize = 16;
    const isDiffDisplay = displayMode === 'diff';

    const viewActionsElement = (
        <View testID="file-details-view-actions" style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            {Platform.OS === 'web' && isDiffDisplay ? <DiffPresentationStyleToggleButton size={iconSize} /> : null}
            {reviewCommentsEnabled === true && onToggleCommentMode ? (
                <IconButton
                    testID="file-details-comment-mode"
                    variant="plain"
                    size={30}
                    iconSize={iconSize}
                    iconName="chat-circle"
                    selected={isCommentModeActive}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.reviewComments.addCommentA11y')}
                    tooltip={t('files.reviewComments.addCommentA11y')}
                    onPress={() => onToggleCommentMode(!isCommentModeActive)}
                />
            ) : null}
            {showWrapLinesToggle === true ? <WrapLinesToggleButton /> : null}
            {rightElement ? (
                <View testID="file-details-right" style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                    {rightElement}
                </View>
            ) : null}
        </View>
    );

    const buttons: DetailsTabHeaderAction[] = [];
    if (showFileEditorActions && displayMode === 'file' && isEditingFile) {
        buttons.push({
            label: t('common.cancel'),
            onPress: () => onCancelEditingFile?.(),
            testID: 'file-details-cancel',
        });
        buttons.push({
            label: t('common.save'),
            tone: 'primary',
            onPress: () => onSaveEditingFile?.(),
            disabled: !fileEditorDirty,
            busy: Boolean(fileEditorBusy),
            testID: 'file-details-save',
        });
    } else if (scmWriteEnabled && canUseSelectionActions && !hasSelectedLines) {
        if (canIncludeFileInSelection) {
            buttons.push({
                label: indexStaging ? t('detailsSurface.file.stage') : t('detailsSurface.file.addToCommit'),
                accessibilityLabel: stageLabel,
                onPress: onStageFile,
                disabled: actionBusy,
                testID: 'file-details-stage-file',
            });
        }
        if (canRemoveFromSelection) {
            buttons.push({
                label: indexStaging ? t('detailsSurface.file.unstage') : t('detailsSurface.file.removeFromCommit'),
                accessibilityLabel: unstageLabel,
                onPress: onUnstageFile,
                disabled: actionBusy,
                testID: 'file-details-unstage-file',
            });
        }
    }

    const controlsElement = (
        <View testID="file-details-view-controls" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {isDiffDisplay && areaItems.length > 0 ? (
                <ToolbarSelect
                    testID="file-details-diff-area-menu"
                    label={t('detailsSurface.file.areaLabel')}
                    items={areaItems}
                    selectedId={diffMode}
                    disabled={areaItems.length === 1}
                    onSelect={(itemId) => {
                        if (itemId === 'pending' || itemId === 'included' || itemId === 'both') onDiffMode(itemId);
                    }}
                />
            ) : null}
            {isMarkdownEditModeMenu ? (
                <DropdownMenu
                    open={displayMenuOpen}
                    onOpenChange={setDisplayMenuOpen}
                    items={markdownEditModeItems}
                    selectedId={effectiveMarkdownEditMode}
                    onSelect={(itemId) => {
                        if (itemId === 'raw' || itemId === 'rich') {
                            onMarkdownEditMode?.(itemId);
                        }
                    }}
                    matchTriggerWidth={false}
                    maxWidthCap={260}
                    placement="bottom"
                    popoverAnchorAlign="start"
                    trigger={({ toggle }) => renderDropdownTrigger({
                        label: selectedMarkdownEditModeLabel,
                        icon: <Icon name={selectedMarkdownEditModeIconName} size={commandIconSize} color={theme.colors.text.secondary} />,
                        selected: true,
                        testID: 'markdown-edit-mode-menu',
                        toggle,
                    })}
                />
            ) : shouldShowDisplayToggles && !(showFileEditorActions && isEditingFile) ? (
                <SegmentedTabBar
                    testIDPrefix="file-details-view-mode"
                    accessibilityLabel={t('detailsSurface.file.viewLabel')}
                    tabs={displaySegments}
                    activeTabId={displayMode}
                    onSelectTab={(mode) => onDisplayMode(mode)}
                    segmentSizing="content"
                    compact
                />
            ) : null}
        </View>
    );

    const lineSelectionBar = isLineSelectionActive || hasSelectedLines || showEmptyLineSelectionActions || hasAppliedPartialLineSelection
        || (scmWriteEnabled && canUseSelectionActions && canStartLineSelection && onStartLineSelection) ? (
        <View
            testID="file-details-change-actions"
            style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: actionGap,
                paddingLeft: 20,
                paddingRight: 14,
                paddingVertical: 6,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: theme.colors.border.subtle,
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
                <ToolbarButton
                    onPress={onStartRangeSelection}
                    testID="file-details-range-selection"
                    label={t('files.fileActions.rangeSelection')}
                    active={isRangeSelectionActive}
                />
            ) : null}
            {scmWriteEnabled && canUseSelectionActions && canStartLineSelection && onStartLineSelection && !isLineSelectionActive ? (
                <ToolbarButton
                    disabled={actionBusy}
                    onPress={onStartLineSelection}
                    testID={hasAppliedPartialLineSelection ? 'file-details-edit-line-selection' : 'file-details-select-lines'}
                    label={t('files.fileActions.selectLines')}
                    size="md"
                    style={selectionActionStyle}
                />
            ) : null}
            {showEmptyLineSelectionActions ? (
                <ToolbarButton
                    onPress={onClearSelection}
                    testID="file-details-clear-selection"
                    label={t('common.cancel')}
                    size="md"
                    style={selectionActionStyle}
                />
            ) : null}
            {scmWriteEnabled && canUseSelectionActions && diffMode === 'both' && !hasSelectedLines ? (
                <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                    {t('files.fileActions.selectionHint')}
                </Text>
            ) : null}
            {hasSelectedLines ? (
                <>
                    <ToolbarButton
                        disabled={actionBusy}
                        onPress={() => { void onApplySelectedLines(); }}
                        testID="file-details-apply-selected-lines"
                        label={selectedLineActionLabel}
                        labelColor={selectedLineActionColor}
                        style={useCompactSelectedLineActions ? { flexShrink: 0 } : undefined}
                    />
                    <IconButton
                        onPress={onClearSelection}
                        testID="file-details-clear-selection"
                        variant="plain"
                        size={30}
                        iconSize={commandIconSize}
                        iconName="x"
                        accessibilityLabel={t('files.fileActions.clearSelection')}
                    />
                </>
            ) : null}
        </View>
    ) : null;

    const meta: DetailsTabHeaderMetaFact[] = [];
    if (pathDir) meta.push({ key: 'dir', text: `${pathDir}/`, tone: 'muted', shrink: true, testID: 'file-details-dir' });
    if (showFileEditorActions && isEditingFile) {
        meta.push({ key: 'editing', text: fileEditorDirty ? t('detailsSurface.file.editingUnsaved') : t('detailsSurface.file.editing') });
    } else {
        if (props.statusLabel) meta.push({ key: 'status', text: props.statusLabel });
        if (props.diffStat && (props.diffStat.added > 0 || props.diffStat.removed > 0)) {
            meta.push({ key: 'stat', kind: 'diffStat', added: props.diffStat.added, removed: props.diffStat.removed });
        }
        for (const [index, fact] of (props.summaryFacts ?? []).entries()) meta.push({ key: `fact-${index}`, text: fact });
    }

    return (
        <View testID="file-action-toolbar" onLayout={onToolbarLayout}>
            <DetailsTabHeader
                testID="file-details-header"
                title={pathName || pathDir || ''}
                leading={<FileIcon fileName={pathName} size={18} appearance="line" />}
                meta={meta}
                actions={viewActionsElement}
                buttons={buttons}
                controls={controlsElement}
                menuActions={showFileEditorActions && !isEditingFile && onStartEditingFile ? [{
                    id: 'edit', title: t('common.edit'), testID: 'file-details-edit',
                    onSelect: () => { onDisplayMode('file'); onStartEditingFile(); },
                }] : undefined}
                notice={(
                    <>
                        {lineSelectionBar}
                        {props.notice ?? null}
                    </>
                )}
            />
        </View>
    );
}
