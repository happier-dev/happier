import * as React from 'react';
import { Platform, StyleSheet as NativeStyleSheet, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DetailsTabHeader, type DetailsTabHeaderAction, type DetailsTabHeaderMetaFact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { DiffPresentationStyleToggleButton } from '@/components/ui/code/diff/DiffPresentationStyleToggleButton';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { FloatingTabBarSurface } from '@/components/ui/navigation/FloatingTabBarSurface';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { FileEditorStatusPill } from './editor/FileEditorStatusPill';
import { Text } from '@/components/ui/text/Text';
import type { WorkspaceFileEditorHeaderModel } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorHeaderModel';
import type { FilePageDetailsModel } from './useFilePageDetailsActions';
import { Typography } from '@/constants/Typography';
import { resolveScmDiffAreaLabel } from '@/scm/diff/diffAreaLabels';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';
import { t } from '@/text';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';

import { FilePageAttributionFact, FilePageDeletionFact } from './FilePageAttributionFact';
import { FilePageBreadcrumb } from './FilePageBreadcrumb';
import { resolveFileMenuItems, type FileMenuContext } from './fileMenus';
import { resolveFilePageEditControl, type FileDiffMode, type FileDisplayMode, type FilePageEditControl, type FilePageMode, type FilePageModeOption } from './filePageModel';

export { resolveFilePageEditControl, type FilePageEditControl } from './filePageModel';

/** The segment label of each page mode; the internal display enum stays behind it. */
export function resolveFilePageModeLabel(mode: FilePageMode): string {
    switch (mode) {
        case 'view': return t('files.pane.page.view');
        case 'preview': return t('files.pane.page.preview');
        case 'source': return t('files.pane.page.source');
        case 'changes': return t('files.pane.page.changes');
    }
}

const BACKGROUND_CHOICES = [
    { id: 'checkerboard', titleKey: 'files.viewer.backgroundCheckerboard' },
    { id: 'light', titleKey: 'files.viewer.backgroundLight' },
    { id: 'dark', titleKey: 'files.viewer.backgroundDark' },
] as const;

/**
 * The File page's `⋯` rows from the one item list (`fileMenus.ts`), for the built-in and plugin-viewer headers alike:
 * Background is a chooser (Checkerboard · Light · Dark, remembered per kind on the device, FV4s), Copy path
 * becomes Copy absolute path while Alt is held on desktop, and the phone lists the absolute path as its own row.
 */
export function buildFilePageMenuActions(context: FileMenuContext, surface: 'page' | 'phone', extras: Readonly<{
    details?: FilePageDetailsModel | null;
    wrapChecked?: boolean;
    downloadBusy?: boolean;
}> = {}): PageHeaderMenuAction[] {
    const background = extras.details?.background ?? null;
    return resolveFileMenuItems(context, surface).flatMap((item): PageHeaderMenuAction[] => {
        if (item.id === 'background' && !background) return [];
        return [{
            id: item.id,
            title: item.title ?? t(item.titleKey),
            testID: `file-menu-${item.id}`,
            category: item.group,
            ...(item.destructive ? { destructive: true } : {}),
            ...(item.id === 'wrap' && extras.wrapChecked !== undefined ? { checked: extras.wrapChecked } : {}),
            ...(typeof item.state === 'object' ? { disabled: true, subtitle: item.state.disabledReason } : {}),
            ...(item.id === 'download' && extras.downloadBusy ? { loading: true } : {}),
            ...(item.id === 'copyPath' && surface === 'page' && context.platform !== 'ios' && context.platform !== 'android'
                ? { alternateTitle: t('files.pane.menu.copyAbsolutePath') } : {}),
            ...(item.id === 'background' && background ? {
                children: BACKGROUND_CHOICES.map((choice) => ({
                    id: `background-${choice.id}`,
                    title: t(choice.titleKey),
                    testID: `file-menu-background-${choice.id}`,
                    checked: background.value === choice.id,
                    onSelect: () => background.onSelect(choice.id),
                })),
            } : {}),
            onSelect: (intent) => item.run(intent),
        }];
    });
}

export type FilePageHeaderProps = Readonly<{
    fileName?: string;
    /** The file's workspace-relative path: its folders become the breadcrumb. */
    filePath?: string;
    /** The host names the repository (the Code page): its root leads the breadcrumb and opens the root listing. */
    breadcrumbRoot?: string | null;
    onOpenFolder?: (folderPath: string) => void;
    /** How the file changed, in words ("Modified", "Added"); absent for an unchanged file. */
    statusLabel?: string | null;
    diffStat?: Readonly<{ added: number; removed: number }> | null;
    /** Facts about the file itself ("No changes", "34 lines", "2.5 of 38.4 MB"). */
    summaryFacts?: readonly string[] | null;
    /** Facts other owners supply for this file (P7's "3 problems"); the header owns where they sit. */
    providerFacts?: readonly DetailsTabHeaderMetaFact[] | null;
    /** Who last changed the file and when (the facts line's last fact). */
    attribution?: Readonly<{ agentName: string | null; requesterName: string | null; updatedAt: number | null }> | null;
    /** The lifecycle-admitted current write replaces settled attribution, independently of Track. */
    writing?: Readonly<{ agentName: string; line: number | null }> | null;
    /** A file deleted on disk: who and when, then Restore, in the attribution's place (lab FV2d). */
    deletion?: Readonly<{ agentName: string | null; at: number | null; onRestore?: () => void | Promise<void> }> | null;
    /** A state the page is in, in one word beside the actions ("Deleted"). Editing states come from `editor`. */
    statusPill?: Readonly<{ label: string; variant?: 'neutral' | 'warning' }> | null;
    /** One line each under the header (freshness, the editor's conflict / offline line, the review strip). */
    notice?: React.ReactNode;
    /** The views of this file (`View | Changes`, `Preview | Source | Changes`); none or one draws no choice. */
    modes?: readonly FilePageModeOption[];
    displayMode: FileDisplayMode;
    onDisplayMode: (mode: FileDisplayMode) => void;
    /** Find in this file (the bar is open while `active`). */
    find?: Readonly<{ onOpen: () => void; active?: boolean }> | null;
    /** Media kinds: "View full screen" opens the Media stage, for people who don't click the picture (lab FV4). */
    expand?: Readonly<{ onOpen: () => void }> | null;
    /** A body's own control in the band, before Find (a PDF's zoom menu, lab FV5). */
    accessory?: React.ReactNode;
    /** The `⋯` menu, already resolved from the page's one item list (`fileMenus.ts`). */
    menuActions?: readonly PageHeaderMenuAction[];
    /** The phone page carries its view controls in a bottom toolbar instead (`FilePageToolbar`). */
    toolbarBelow?: boolean;
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
    lineSelectionActive?: boolean;
    rangeSelectionActive?: boolean;
    reviewCommentsEnabled?: boolean;
    commentModeActive?: boolean;
    selectedLineCount: number;
    isApplyingStage: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    onStageFile: () => void;
    onUnstageFile: () => void;
    onApplySelectedLines: () => void | Promise<void>;
    onClearSelection: () => void;
    onStartRangeSelection?: () => void;
    onToggleCommentMode?: (active: boolean) => void;
    fileEditorEnabled?: boolean;
    /** The page's one Edit / Done / Save decision (`resolveFilePageEditControl`); without it the header resolves it. */
    edit?: FilePageEditControl | null;
    editor?: WorkspaceFileEditorHeaderModel;
    isEditingFile?: boolean;
    onStartEditingFile?: () => void;
    onCancelEditingFile?: () => void;
    onSaveEditingFile?: () => void;
}>;

/**
 * The File page header (lab FV1, P3 §3.2), on the one Details header (`DetailsTabHeader`):
 * row 1 names the file (mark, name) and carries what it is for (`View | Changes`, Find, Edit, `⋯`);
 * row 2 says where it lives and what happened to it (breadcrumb · Modified +4 −2 · by Claude 2m).
 * View, Changes and Edit swap in place and the header never moves.
 */
export function FilePageHeader(props: FilePageHeaderProps) {
    const { theme } = useUnistyles();
    const toolbarBelow = props.toolbarBelow === true;
    const {
        displayMode, onDisplayMode, diffMode, onDiffMode, hasPendingDelta, hasIncludedDelta, isUntrackedFile,
        scmWriteEnabled, includeExcludeEnabled, virtualSelectionEnabled, isSelectedForCommit, lineSelectionEnabled,
        lineSelectionActive, rangeSelectionActive, reviewCommentsEnabled, commentModeActive, selectedLineCount,
        isApplyingStage, inFlightScmOperation, onStageFile, onUnstageFile, onApplySelectedLines, onClearSelection,
        onStartRangeSelection, onToggleCommentMode, isEditingFile, editor,
    } = props;
    const editing = isEditingFile === true && props.fileEditorEnabled === true;
    const actionBusy = isApplyingStage || Boolean(inFlightScmOperation);
    const canIncludeFile = hasPendingDelta || isUntrackedFile === true;
    const canUseSelectionActions = includeExcludeEnabled || virtualSelectionEnabled;
    const canIncludeFileInSelection = virtualSelectionEnabled ? canIncludeFile && !isSelectedForCommit : canIncludeFile;
    const canRemoveFromSelection = virtualSelectionEnabled ? isSelectedForCommit : hasIncludedDelta;
    const isLineSelectionActive = lineSelectionActive === true;
    const hasSelectedLines = isLineSelectionActive && lineSelectionEnabled && selectedLineCount > 0;
    const showEmptyLineSelectionActions = isLineSelectionActive && !hasSelectedLines;
    const isDiffDisplay = displayMode === 'diff';
    const indexStaging = !virtualSelectionEnabled;
    const iconSize = 16;

    const editControl = props.edit !== undefined ? props.edit : resolveFilePageEditControl({
        fileEditorEnabled: props.fileEditorEnabled === true,
        isEditingFile: editing,
        editor,
        onStart: props.onStartEditingFile ?? (editor ? () => editor.onStart() : undefined),
        onSave: props.onSaveEditingFile,
        onCancel: props.onCancelEditingFile,
    });


    const modeSegments = React.useMemo(() => (props.modes ?? []).map((option) => ({
        id: option.displayMode, label: resolveFilePageModeLabel(option.id),
    })), [props.modes]);
    // Edit is not a reading view (P4 U2): while editing, the reading views stay reachable with none of them
    // current, so View (even alone) or Changes leaves the editor and keeps the draft (B1-PE-04).
    const showModeSegment = editing ? modeSegments.length > 0 : modeSegments.length > 1;
    const modeSegment = showModeSegment ? (
        <SegmentedTabBar<FileDisplayMode | 'edit'>
            testIDPrefix="file-details-view-mode"
            accessibilityLabel={t('detailsSurface.file.viewLabel')}
            tabs={modeSegments}
            activeTabId={editing ? 'edit' : displayMode}
            onSelectTab={(mode) => { if (mode !== 'edit') onDisplayMode(mode); }}
            segmentSizing="content"
            compact
        />
    ) : null;

    // P4's editing state, in one word where the segment stood (lab ED1): Editing · Unsaved · Saving.
    // The editor's one status owner (P4-R2): Editing · Unsaved · Saving · Saved (the 2 s moment), word cross-fade.
    // Reading while a draft is kept (B1-PE-04) still says so: the draft waits behind Edit, never silently.
    const draftKept = !editing && props.fileEditorEnabled === true && editor !== undefined
        && (editor.status === 'dirty' || editor.status === 'conflict' || editor.status === 'saving');
    const editorStatusPill = (editing || draftKept) && editor ? <FileEditorStatusPill editor={editor} /> : null;
    const pagePill = props.statusPill ? (
        <StatusPill testID="file-page-status" variant={props.statusPill.variant ?? 'neutral'} hideDot label={props.statusPill.label} />
    ) : null;
    const statusNode = editorStatusPill ?? pagePill;

    const findButton = props.find ? (
        <IconButton
            testID="file-header-find"
            variant="plain"
            size={30}
            iconSize={iconSize}
            iconName="magnifying-glass"
            selected={props.find.active === true}
            accessibilityRole="button"
            accessibilityLabel={t('find.open')}
            tooltip={t('find.open')}
            onPress={props.find.onOpen}
        />
    ) : null;

    const expandButton = props.expand && !toolbarBelow ? (
        <IconButton
            testID="file-header-expand"
            variant="plain"
            size={30}
            iconSize={iconSize}
            iconName="arrows-out"
            accessibilityRole="button"
            accessibilityLabel={t('files.viewer.viewFullScreen')}
            tooltip={t('files.viewer.viewFullScreen')}
            onPress={props.expand.onOpen}
        />
    ) : null;

    // Quiet controls in the identity band: the view choice, then Find (lab FV1); review tools in Changes.
    // A phone's band keeps only the view choice and Find (the review bar holds its bottom edge, rvp P1): its diff
    // has one column, and a comment starts from a selection (the selection toolbar) instead of a mode.
    const phoneBand = useSurfaceStateSize() === 'phone';
    const diffPresentationToggle = Platform.OS === 'web' && isDiffDisplay && !phoneBand;
    const commentToggle = reviewCommentsEnabled === true && Boolean(onToggleCommentMode) && !phoneBand;
    const accessory = !toolbarBelow && props.accessory ? props.accessory : null;
    const hasBandControls = Boolean((!toolbarBelow && (modeSegment || findButton)) || accessory || expandButton || statusNode || diffPresentationToggle || commentToggle);
    const bandControls = hasBandControls ? (
        <View testID="file-details-view-actions" style={styles.bandControls}>
            {!toolbarBelow ? modeSegment : null}
            {statusNode}
            {statusNode && (findButton || editControl) && !toolbarBelow ? <View style={styles.bandDivider} /> : null}
            {diffPresentationToggle ? <DiffPresentationStyleToggleButton size={iconSize} /> : null}
            {commentToggle && onToggleCommentMode ? (
                <IconButton
                    testID="file-details-comment-mode"
                    variant="plain"
                    size={30}
                    iconSize={iconSize}
                    iconName="chat-circle"
                    selected={commentModeActive === true}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.reviewComments.addCommentA11y')}
                    tooltip={t('files.reviewComments.addCommentA11y')}
                    onPress={() => onToggleCommentMode(!(commentModeActive === true))}
                />
            ) : null}
            {accessory}
            {!toolbarBelow ? findButton : null}
            {expandButton}
        </View>
    ) : undefined;

    const buttons: DetailsTabHeaderAction[] = [];
    if (scmWriteEnabled && canUseSelectionActions && !hasSelectedLines && !editing) {
        if (canIncludeFileInSelection) {
            buttons.push({
                label: indexStaging ? t('detailsSurface.file.stage') : t('detailsSurface.file.addToCommit'),
                accessibilityLabel: virtualSelectionEnabled ? t('files.fileActions.selectEntireFileForCommit') : t('files.fileActions.stageFile'),
                onPress: onStageFile,
                disabled: actionBusy,
                testID: 'file-details-stage-file',
            });
        }
        if (canRemoveFromSelection) {
            buttons.push({
                label: indexStaging ? t('detailsSurface.file.unstage') : t('detailsSurface.file.removeFromCommit'),
                accessibilityLabel: virtualSelectionEnabled ? t('files.fileActions.removeFromCommitSelection') : t('files.fileActions.unstageFile'),
                onPress: onUnstageFile,
                disabled: actionBusy,
                testID: 'file-details-unstage-file',
            });
        }
    }
    if (editControl && !toolbarBelow) {
        buttons.push({
            label: editControl.kind === 'edit' ? t('common.edit') : editControl.kind === 'done' ? t('common.done') : t('common.save'),
            onPress: editControl.onPress,
            busy: editControl.busy,
            disabled: editControl.disabled,
            tone: editControl.primary ? 'primary' : 'default',
            ...(editControl.kind === 'edit' ? { iconName: 'pencil-simple' as const } : {}),
            testID: editControl.kind === 'edit' ? 'file-details-edit' : editControl.kind === 'done' ? 'file-details-done' : 'file-details-save',
        });
    }

    const areaItems = React.useMemo(() => {
        const areaVocabulary = indexStaging ? 'index' : 'selection';
        const ids: FileDiffMode[] = [];
        if (hasPendingDelta) ids.push('pending');
        if (hasIncludedDelta) ids.push('included');
        if (hasIncludedDelta && hasPendingDelta) ids.push('both');
        return ids.map((id) => ({ id, label: resolveScmDiffAreaLabel(id, areaVocabulary) }));
    }, [hasIncludedDelta, hasPendingDelta, indexStaging]);
    // Which layer of the change to show is a choice only when there are two (a one-option field is noise).
    const controls = isDiffDisplay && areaItems.length > 1 && !editing ? (
        <View testID="file-details-view-controls" style={styles.controls}>
            <SelectionListFilterChip filter={{
                id: 'file-diff-area',
                testID: 'file-details-diff-area-menu',
                label: t('detailsSurface.file.areaLabel'),
                options: areaItems,
                selectedId: diffMode,
                onChange: (itemId) => { if (itemId === 'pending' || itemId === 'included' || itemId === 'both') onDiffMode(itemId); },
            }} />
        </View>
    ) : undefined;

    const selectedLineActionIsRemoval = !virtualSelectionEnabled && diffMode === 'included';
    const selectionHintShown = scmWriteEnabled && canUseSelectionActions && diffMode === 'both' && !hasSelectedLines && isDiffDisplay;
    const lineSelectionBar = isLineSelectionActive || hasSelectedLines || selectionHintShown ? (
        <View testID="file-details-change-actions" style={styles.selectionBar}>
            {isLineSelectionActive && lineSelectionEnabled && onStartRangeSelection ? (
                <ToolbarButton onPress={onStartRangeSelection} testID="file-details-range-selection"
                    label={t('files.fileActions.rangeSelection')} active={rangeSelectionActive === true} />
            ) : null}
            {showEmptyLineSelectionActions ? (
                <ToolbarButton onPress={onClearSelection} testID="file-details-clear-selection" label={t('common.cancel')}
                    size="md" />
            ) : null}
            {selectionHintShown ? <Text style={styles.selectionHint}>{t('files.fileActions.selectionHint')}</Text> : null}
            {hasSelectedLines ? (
                <>
                    <ToolbarButton
                        disabled={actionBusy}
                        onPress={() => { void onApplySelectedLines(); }}
                        testID="file-details-apply-selected-lines"
                        label={virtualSelectionEnabled ? t('files.fileActions.selectedLines.selectLinesForCommit')
                            : selectedLineActionIsRemoval ? t('files.fileActions.selectedLines.unstageSelectedLines')
                                : t('files.fileActions.selectedLines.stageSelectedLines')}
                        labelColor={selectedLineActionIsRemoval ? theme.colors.state.neutral.foreground : theme.colors.state.success.foreground}
                    />
                    <IconButton onPress={onClearSelection} testID="file-details-clear-selection" variant="plain" size={30}
                        iconSize={14} iconName="x" accessibilityLabel={t('files.fileActions.clearSelection')} />
                </>
            ) : null}
        </View>
    ) : null;

    const meta: DetailsTabHeaderMetaFact[] = [];
    if (props.statusLabel) meta.push({ key: 'status', text: props.statusLabel });
    if (props.diffStat && (props.diffStat.added > 0 || props.diffStat.removed > 0)) {
        meta.push({ key: 'stat', kind: 'diffStat', added: props.diffStat.added, removed: props.diffStat.removed });
    }
    for (const [index, fact] of (props.summaryFacts ?? []).entries()) meta.push({ key: `fact-${index}`, text: fact });
    for (const fact of props.providerFacts ?? []) meta.push(fact);
    const breadcrumb = props.filePath && (props.filePath.includes('/') || props.breadcrumbRoot) ? (
        <FilePageBreadcrumb filePath={props.filePath} rootLabel={props.breadcrumbRoot} onOpenFolder={props.onOpenFolder} testID="file-details-dir" />
    ) : null;
    const separated = meta.length > 0 || breadcrumb !== null;
    const attribution = props.deletion ? <FilePageDeletionFact {...props.deletion} separated={separated} />
        : props.writing ? <FilePageAttributionFact agentName={props.writing.agentName} requesterName={null} updatedAt={null}
            writing={props.writing} separated={separated} />
        : props.attribution ? <FilePageAttributionFact {...props.attribution} separated={separated} /> : null;

    return (
        <View testID="file-action-toolbar">
            {lineSelectionEnabled ? <View testID="file-details-line-selection-available" style={styles.marker} /> : null}
            {isLineSelectionActive && lineSelectionEnabled ? <View testID="file-details-line-selection-active" style={styles.marker} /> : null}
            <DetailsTabHeader
                testID="file-details-header"
                title={props.fileName ?? ''}
                leading={props.fileName ? <FileIcon fileName={props.fileName} size={18} appearance="line" /> : undefined}
                metaLeading={breadcrumb ?? undefined}
                meta={meta}
                metaTrailing={attribution}
                actions={bandControls}
                buttons={buttons}
                controls={controls}
                menuActions={props.menuActions}
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

/**
 * The phone File page's bottom toolbar (lab FV1p, delta 5), in thumb reach on the floating bar
 * material: the view choice, Find, Edit / Save. `⋯` stays in the header. It steps aside while the
 * Find bar or the keyboard is up.
 */
export function FilePageToolbar(props: Readonly<{
    modes: readonly FilePageModeOption[];
    displayMode: FileDisplayMode;
    onDisplayMode: (mode: FileDisplayMode) => void;
    find?: Readonly<{ onOpen: () => void; active?: boolean }> | null;
    edit?: FilePageEditControl | null;
    /** A body's own fact or control, leading the toolbar (a PDF's "3 of 14", lab FV5p). */
    accessory?: React.ReactNode;
    /** The body under the bar is a picture or document (a PDF's white pages): the bar keeps its ink legible over it. */
    overPicture?: boolean;
    bottomInset: number;
}>) {
    const showModes = props.modes.length > 1 && props.edit?.kind !== 'done' && props.edit?.kind !== 'save';
    // Under the phone's floating tab bar the toolbar floats just above it, never beneath it.
    const chromeClearance = useFloatingChromeClearance();
    if (!showModes && !props.find && !props.edit && !props.accessory) return null;
    return (
        <View pointerEvents="box-none" style={[styles.toolbarHost, chromeClearance > 0 ? { bottom: chromeClearance } : null]}>
            <FloatingTabBarSurface testID="file-page-toolbar" bottomInset={chromeClearance > 0 ? 0 : props.bottomInset} stretch overPicture={props.overPicture}>
                <View style={styles.toolbarRow}>
                    {showModes ? (
                        <SegmentedTabBar
                            testIDPrefix="file-page-toolbar-mode"
                            accessibilityLabel={t('detailsSurface.file.viewLabel')}
                            tabs={props.modes.map((option) => ({ id: option.displayMode, label: resolveFilePageModeLabel(option.id) }))}
                            activeTabId={props.displayMode}
                            onSelectTab={props.onDisplayMode}
                            segmentSizing="content"
                        />
                    ) : null}
                    {props.accessory}
                    <View style={styles.toolbarSpacer} />
                    {props.find ? (
                        <IconButton testID="file-page-toolbar-find" variant="plain" size={34} iconSize={20} iconName="magnifying-glass"
                            interactiveTargetGapPx={8} accessibilityRole="button" accessibilityLabel={t('find.open')} onPress={props.find.onOpen} />
                    ) : null}
                    {props.edit ? (
                        <ToolbarButton
                            testID="file-page-toolbar-edit"
                            label={props.edit.kind === 'edit' ? t('common.edit') : props.edit.kind === 'done' ? t('common.done') : t('common.save')}
                            onPress={props.edit.onPress}
                            busy={props.edit.busy}
                            disabled={props.edit.disabled}
                            tone={props.edit.primary ? 'primary' : 'default'}
                            size="md"
                        />
                    ) : null}
                </View>
            </FloatingTabBarSurface>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    bandControls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    bandDivider: {
        width: NativeStyleSheet.hairlineWidth,
        alignSelf: 'stretch',
        marginVertical: theme.space.s6,
        marginHorizontal: theme.space.s4,
        backgroundColor: theme.colors.border.default,
    },
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    selectionBar: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingLeft: theme.space.s20,
        paddingRight: theme.space.s12,
        paddingVertical: theme.space.s6,
        borderBottomWidth: NativeStyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    selectionHint: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    marker: {
        position: 'absolute',
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: 'none',
    },
    toolbarHost: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    toolbarSpacer: {
        flex: 1,
    },
    toolbarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s4,
        paddingVertical: theme.space.s4,
    },
}));
