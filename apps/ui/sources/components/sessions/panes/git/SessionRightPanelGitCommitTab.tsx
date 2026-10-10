import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import {
    type CheckpointOverlapObservation,
    type SessionChangeAttribution,
} from '@happier-dev/protocol';
import { useChangedFileRowLayout } from '@/components/workspaces/scm/changes/useChangedFileRowLayout';
import { activeReviewFileKeyForSession, useActiveReviewFilePath } from '@/components/workspaces/scm/review/activeReviewFile';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import { measureRectInContainer, RectFlightLayer, unionFlightRects, useRectFlight } from '@/components/ui/motion/rectFlight';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
    createGitCommitFlightAnchors,
    GitCommitFlightAnchorsContext,
    registerGitCommitFlightRow,
    type GitCommitFlightAnchors,
} from '@/components/sessions/panes/git/gitCommitFlightAnchors';
import { GitChangesTree } from '@/components/sessions/panes/git/display/GitChangesTree';

import { ChangedFilesList } from '@/components/sessions/files/content/ChangedFilesList';
import { ChangedFilesViewModeMenu } from '@/components/sessions/files/ChangedFilesViewModeMenu';
import {
    ChangedFileEvidenceDisclosure,
    checkpointAttributionDescription,
    sessionAttributedFileAccessibilityQualification,
    sessionAttributionDescriptions,
} from '@/components/workspaces/scm/changes/ChangedFileEvidenceDisclosure';
import { ScmCommitComposerCard, type ScmCommitComposerCardProps } from '@/components/workspaces/scm/commitComposer/ScmCommitComposerCard';
import { ScmChangeRow, resolveScmChangeStatsColumnWidth } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { resolveScmChangePathTag } from '@/scm/scmChangePathTag';
import { ScmCommitSelectionCheckGlyph } from '@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton';
import { Text } from '@/components/ui/text/Text';
import type { ScmFileStatus, ScmStatusFiles } from '@/scm/scmStatusFiles';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    filterPresentableSessionAttributedFiles,
    partitionRepositoryChangesBySession,
    resolveChangedFilesEmptyStateTranslationKey,
    type ChangedFilesViewMode,
    type SessionAttributedFile,
} from '@/scm/scmAttribution';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { createAdvancedDebounce } from '@/utils/timing/debounce';
import { filterDirectoryLikeScmFileStatuses } from '@/scm/isDirectoryLikeScmFileStatus';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { AgentId } from '@/agents/catalog/catalog';

/** A selected commit proposal over the list (lab WT4-C2): its exact paths, split-file notes and number. */
export type GitProposalHighlight = Readonly<{
    paths: ReadonlySet<string>;
    notes: ReadonlyMap<string, string>;
    groupNumber: number;
}>;

export type SessionRightPanelGitCommitTabProps = Readonly<{
    theme: any;
    sessionId: string;
    serverId?: string;
    sessionPath: string | null;
    backendLabel: string;
    commitActionLabel: string;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled?: boolean;
    hasConflicts: boolean;
    scmOperationBusy: boolean;
    scmOperationStatus: string | null;
    hasGlobalOperationInFlight: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    commitAllowed: boolean;
    commitBlockedMessage: string | null;

    changedFilesViewMode: ChangedFilesViewMode;
    sessionAttribution: SessionChangeAttribution;
    sessionCheckpointOverlap: CheckpointOverlapObservation;

    allRepositoryChangedFiles: ScmFileStatus[];
    selectedRepositoryChangedFiles?: ScmFileStatus[];
    proposedGroupSelected?: boolean;
    proposalHighlight?: GitProposalHighlight | null;
    turnAttributedFiles?: SessionAttributedFile[];
    turnAgentReportedFiles?: SessionAttributedFile[];
    turnCheckpointFiles?: SessionAttributedFile[];
    turnCheckpointMetadata?: React.ComponentProps<typeof ChangedFilesList>['turnCheckpointMetadata'];
    turnRepositoryOnlyFiles?: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];

    showTurnViewToggle?: boolean;
    showTurnAgentReportedViewToggle?: boolean;
    showTurnCheckpointViewToggle?: boolean;
    showSessionViewToggle?: boolean;
    showSelectedViewToggle?: boolean;
    onChangedFilesViewMode?: (mode: ChangedFilesViewMode) => void;
    repositorySelectedCount: number;
    onSelectAll: () => void;
    onSelectNone: () => void;
    disableSelectAll: boolean;
    disableSelectNone: boolean;
    onFilePress: (file: ScmFileStatus) => void;
    onFilePressPinned: (file: ScmFileStatus) => void;
    onToggleSelectionForFile: (file: ScmFileStatus) => void;
    renderFileActions: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions: (file: ScmFileStatus) => React.ReactNode;

    commitDraftMessage: string;
    onCommitDraftMessageChange: (value: string) => void;
    /** Resolves with the commit's outcome when it is awaited (the success moment plays on `ok`). */
    onCommitFromMessage: (message: string) => Promise<Readonly<{ ok: boolean }>> | void | undefined;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    onCancelCommitMessageSuggestion?: () => Promise<unknown>;
    suggestionContextKey?: string;
    onClearSelection?: () => void;
    commitSelectionAvailable?: boolean;
    selectionModeActive?: boolean;
    onEnterSelectionMode?: () => void;
    onExitSelectionMode?: () => void;

    scmStatusFiles: ScmStatusFiles | null;
    showCommitComposer?: boolean;
    onOpenReviewAllChanges?: () => void;
    onOpenStashDetails?: () => void;
    /** Select (or clear) every file of a change group from its header checkbox. */
    onToggleGroupSelection?: (files: readonly ScmFileStatus[], select: boolean) => void;
    /** Drawn under the changes in the same scroll (the Unified layout's timeline). */
    listFooter?: React.ReactElement | null;
    /** What the pane shows when there is nothing to commit (a finished state, not an apology). */
    emptyState?: React.ReactElement | null;
    /** Beside the scope menu: the display control (layout, list or tree, density). */
    scopeAccessory?: React.ReactNode;
    /** Show the changes as a folder tree (Git lab TV) instead of the list. */
    changesLayout?: 'list' | 'tree';
    /** The machine the files live on (the tree's workspace identity). */
    machineId?: string | null;
    phone?: boolean;
    agentId?: AgentId | null;
    completedOperationId?: string | null;
}>;

const commitChangedFilesListContentContainerStyle: ViewStyle = { paddingBottom: 12 };
const COMMIT_CHANGED_FILES_INITIAL_RENDER_COUNT = 12;
const COMMIT_CHANGED_FILES_RENDER_BATCH_SIZE = 12;
const COMMIT_CHANGED_FILES_WINDOW_SIZE = 5;
const repositoryChangedFileKeyExtractor = (file: ScmFileStatus) => `repo-all-${file.fullPath}`;
const selectedChangedFileKeyExtractor = (file: ScmFileStatus) => `selected-${file.fullPath}`;
/** A name-first row is two lines; the estimate lets the list size its window before it measures. */
const STACKED_CHANGE_ROW_ESTIMATED_HEIGHT_PX = 44;

type CommitChangedFileItem = ScmFileStatus | SessionAttributedFile;
type CommitGroupItem = Readonly<{
    kind: 'group';
    id: 'conflicts' | 'session' | 'elsewhere';
    title: string;
    files: readonly ScmFileStatus[];
}>;
type CommitListItem = CommitChangedFileItem | CommitGroupItem;

function isCommitListMarker(item: CommitListItem | undefined): item is CommitGroupItem {
    return item !== undefined && 'kind' in item;
}

function isAttributedChangedFileItem(item: CommitListItem | undefined): item is SessionAttributedFile {
    return item !== undefined && !isCommitListMarker(item) && 'file' in item && 'attribution' in item;
}

function getCommitChangedFile(item: CommitChangedFileItem): ScmFileStatus {
    return isAttributedChangedFileItem(item) ? item.file : item;
}

function resolveRepositoryName(rootPath: string | null | undefined): string | null {
    if (!rootPath) return null;
    const segments = rootPath.split(/[\\/]+/).filter(Boolean);
    return segments[segments.length - 1] ?? null;
}

function sumChangedLines(files: readonly ScmFileStatus[]): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const file of files) {
        added += Number.isFinite(file.linesAdded) ? Math.max(0, file.linesAdded) : 0;
        removed += Number.isFinite(file.linesRemoved) ? Math.max(0, file.linesRemoved) : 0;
    }
    return { added, removed };
}

export const SessionRightPanelGitCommitTab = React.memo((props: SessionRightPanelGitCommitTabProps) => {
    const showCommitComposer = props.showCommitComposer !== false;
    const keyboardBottomInset = useKeyboardHeight();
    // Lab G1: the commit card names where it commits ("Commit to v0.3") and sums what is selected.
    const commitBranch = props.scmStatusFiles && !props.scmStatusFiles.detached ? props.scmStatusFiles.branch : null;
    const commitActionLabel = commitBranch
        ? t('sessionGitPane.commit.toBranch', { branch: commitBranch })
        : props.commitActionLabel;
    const selectedFiles = props.selectedRepositoryChangedFiles;
    const selectionSummary = React.useMemo(() => {
        if (!selectedFiles || selectedFiles.length === 0) return null;
        const lines = sumChangedLines(selectedFiles);
        return { fileCount: selectedFiles.length, linesAdded: lines.added, linesRemoved: lines.removed };
    }, [selectedFiles]);

    // Git lab SX "Commit": the selected rows gather into a chip, travel to the timeline and land as its newest
    // node. The rows' places are read when the commit starts (they are gone once it lands); the landing spot is
    // read when it lands.
    const anchorsRef = React.useRef<GitCommitFlightAnchors | null>(null);
    if (!anchorsRef.current) anchorsRef.current = createGitCommitFlightAnchors();
    const anchors = anchorsRef.current;
    const containerRef = React.useRef<View | null>(null);
    const composerRef = React.useRef<View | null>(null);
    const containerHeightRef = React.useRef(0);
    const flight = useRectFlight();
    const reducedMotion = useReducedMotionPreference();
    const [chip, setChip] = React.useState<Readonly<{ subject: string; fileCount: number; added: number; removed: number }> | null>(null);
    const onCommitSource = props.onCommitFromMessage;
    const selectedPathsRef = React.useRef<readonly ScmFileStatus[]>([]);
    selectedPathsRef.current = selectedFiles ?? [];
    const onCommitFromMessage = React.useCallback((message: string) => {
        const committed = selectedPathsRef.current;
        const lines = sumChangedLines(committed);
        const captured = reducedMotion
            ? Promise.resolve(null)
            : Promise.all(committed.map((file) => measureRectInContainer(anchors.rows.get(file.fullPath), containerRef.current)))
                .then((rects) => unionFlightRects(rects))
                .then((rows) => rows ?? measureRectInContainer(composerRef.current, containerRef.current));
        const pending = onCommitSource(message);
        if (!pending || typeof (pending as Promise<unknown>).then !== 'function') return pending;
        return (pending as Promise<Readonly<{ ok: boolean }>>).then(async (result) => {
            if (!result?.ok || reducedMotion) return result;
            const [source, landing] = await Promise.all([
                captured,
                measureRectInContainer(anchors.newestCommit.current, containerRef.current),
            ]);
            if (!source || !landing) return result;
            const height = containerHeightRef.current;
            const target = { ...landing, y: height > 0 ? Math.min(landing.y, height - 36) : landing.y };
            setChip({ subject: message.split('\n')[0]?.trim() ?? '', fileCount: committed.length, added: lines.added, removed: lines.removed });
            await flight.play({ ...source, h: Math.min(source.h, 36) }, target);
            setChip(null);
            return result;
        });
    }, [anchors, flight, onCommitSource, reducedMotion]);

    return (
        <GitCommitFlightAnchorsContext.Provider value={anchors}>
        <View
            ref={containerRef}
            collapsable={false}
            onLayout={(event) => { containerHeightRef.current = event.nativeEvent.layout.height; }}
            style={{ flex: 1, position: 'relative' }}
        >
            <CommitChangesSurface
                theme={props.theme}
                sessionId={props.sessionId}
                serverId={props.serverId}
                sessionPath={props.sessionPath}
                backendLabel={props.backendLabel}
                scmStatusFiles={props.scmStatusFiles}
                scmSnapshot={props.scmSnapshot}
                scmWriteEnabled={props.scmWriteEnabled}
                scmOperationBusy={props.scmOperationBusy}
                hasGlobalOperationInFlight={props.hasGlobalOperationInFlight}
                inFlightScmOperation={props.inFlightScmOperation}
                changedFilesViewMode={props.changedFilesViewMode}
                sessionAttribution={props.sessionAttribution}
                sessionCheckpointOverlap={props.sessionCheckpointOverlap}
                allRepositoryChangedFiles={props.allRepositoryChangedFiles}
                selectedRepositoryChangedFiles={props.selectedRepositoryChangedFiles}
                proposedGroupSelected={props.proposedGroupSelected}
                proposalHighlight={props.proposalHighlight ?? null}
                turnAttributedFiles={props.turnAttributedFiles}
                turnAgentReportedFiles={props.turnAgentReportedFiles}
                turnCheckpointFiles={props.turnCheckpointFiles}
                turnCheckpointMetadata={props.turnCheckpointMetadata}
                turnRepositoryOnlyFiles={props.turnRepositoryOnlyFiles}
                sessionAttributedFiles={props.sessionAttributedFiles}
                repositoryOnlyFiles={props.repositoryOnlyFiles}
                showTurnViewToggle={props.showTurnViewToggle}
                showTurnAgentReportedViewToggle={props.showTurnAgentReportedViewToggle}
                showTurnCheckpointViewToggle={props.showTurnCheckpointViewToggle}
                showSessionViewToggle={props.showSessionViewToggle}
                showSelectedViewToggle={props.showSelectedViewToggle}
                onChangedFilesViewMode={props.onChangedFilesViewMode}
                repositorySelectedCount={props.repositorySelectedCount}
                onSelectAll={props.onSelectAll}
                onSelectNone={props.onSelectNone}
                disableSelectAll={props.disableSelectAll}
                disableSelectNone={props.disableSelectNone}
                onFilePress={props.onFilePress}
                onFilePressPinned={props.onFilePressPinned}
                onToggleSelectionForFile={props.onToggleSelectionForFile}
                renderFileActions={props.renderFileActions}
                renderFileTrailingActions={props.renderFileTrailingActions}
                onOpenReviewAllChanges={props.onOpenReviewAllChanges}
                onOpenStashDetails={props.onOpenStashDetails}
                selectionActive={props.selectionModeActive === true}
                onToggleGroupSelection={props.onToggleGroupSelection}
                listFooter={props.listFooter ?? null}
                emptyState={props.emptyState ?? null}
                scopeAccessory={props.scopeAccessory}
                changesLayout={props.changesLayout ?? 'list'}
                machineId={props.machineId ?? null}
                phone={props.phone === true}
                agentId={props.agentId ?? null}
                completedOperationId={props.completedOperationId ?? null}
            />
            {showCommitComposer ? (
                <View
                    ref={composerRef}
                    collapsable={false}
                    style={{
                        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderTopColor: props.theme.colors.border.default,
                        backgroundColor: props.theme.colors.surface.base,
                        marginBottom: keyboardBottomInset > 0 ? keyboardBottomInset : undefined,
                    }}
                >
                    <CommitComposerFooter
                        theme={props.theme}
                        commitActionLabel={commitActionLabel}
                        selectionSummary={selectionSummary}
                        externalDraftMessage={props.commitDraftMessage}
                        onExternalDraftMessageChange={props.onCommitDraftMessageChange}
                        busy={props.scmOperationBusy || props.hasGlobalOperationInFlight}
                        status={props.scmOperationStatus}
                        commitAllowed={props.commitAllowed}
                        commitBlockedMessage={props.commitBlockedMessage}
                        onCommitFromMessage={onCommitFromMessage}
                        commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
                        onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
                        onCancelCommitMessageSuggestion={props.onCancelCommitMessageSuggestion}
                        suggestionContextKey={JSON.stringify([props.suggestionContextKey, props.serverId, props.sessionId, props.sessionPath,
                            props.scmSnapshot?.branch.headOid, props.selectedRepositoryChangedFiles?.map((file) => file.fullPath)])}
                        selectionCount={props.repositorySelectedCount}
                        onClearSelection={props.onClearSelection}
                        onSelectAllSelection={props.onSelectAll}
                        commitSelectionAvailable={props.commitSelectionAvailable}
                        selectionModeActive={props.selectionModeActive}
                        onEnterSelectionMode={props.onEnterSelectionMode}
                        onExitSelectionMode={props.onExitSelectionMode}
                    />
                </View>
            ) : null}
            {chip && flight.active ? (
                <RectFlightLayer style={flight.style}>
                    <CommitFlightChip theme={props.theme} chip={chip} />
                </RectFlightLayer>
            ) : null}
        </View>
        </GitCommitFlightAnchorsContext.Provider>
    );
});

/** The commit on its way to the timeline: its message, how many files, and the lines it carries. */
const CommitFlightChip = React.memo(function CommitFlightChip(props: Readonly<{
    theme: any;
    chip: Readonly<{ subject: string; fileCount: number; added: number; removed: number }>;
}>) {
    const colors = props.theme.colors;
    return (
        <View
            testID="scm-commit-flight-chip"
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                maxWidth: 320,
                height: 36,
                paddingHorizontal: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.border.default,
                backgroundColor: colors.surface.elevated ?? colors.surface.base,
                shadowColor: colors.shadow?.color ?? '#000',
                shadowOpacity: 0.12,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 2 },
            }}
        >
            <Icon name="git-commit" size={14} color={colors.text.secondary} />
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: colors.text.primary, ...Typography.default('semiBold') }}>
                {props.chip.subject}
            </Text>
            <Text style={{ fontSize: 12, color: colors.text.secondary, ...Typography.default() }}>
                {t('sessionGitPane.commit.selection', { count: props.chip.fileCount })}
            </Text>
            <Text style={{ fontSize: 12, fontVariant: ['tabular-nums'], color: colors.state?.success?.foreground, ...Typography.default('semiBold') }}>
                {`+${formatExactCount(props.chip.added)}`}
            </Text>
            <Text style={{ fontSize: 12, fontVariant: ['tabular-nums'], color: colors.state?.danger?.foreground, ...Typography.default('semiBold') }}>
                {`\u2212${formatExactCount(props.chip.removed)}`}
            </Text>
        </View>
    );
});

const CommitComposerFooter = React.memo((props: Readonly<{
    theme: any;
    commitActionLabel: string;
    externalDraftMessage: string;
    onExternalDraftMessageChange: (value: string) => void;
    busy: boolean;
    status: string | null;
    commitAllowed: boolean;
    commitBlockedMessage: string | null;
    onCommitFromMessage: (message: string) => unknown;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    onCancelCommitMessageSuggestion?: () => Promise<unknown>;
    suggestionContextKey?: string;
    selectionSummary: ScmCommitComposerCardProps['selectionSummary'];
    selectionCount: number;
    onClearSelection?: () => void;
    onSelectAllSelection?: () => void;
    commitSelectionAvailable?: boolean;
    selectionModeActive?: boolean;
    onEnterSelectionMode?: () => void;
    onExitSelectionMode?: () => void;
}>) => {
    const [localDraftMessage, setLocalDraftMessage] = React.useState(() => String(props.externalDraftMessage ?? ''));
    const dirtyRef = React.useRef(false);

    const debouncedPersist = React.useMemo(() => {
        return createAdvancedDebounce((value: string) => {
            props.onExternalDraftMessageChange(value);
        }, { delay: 350, immediateCount: 0 });
    }, [props.onExternalDraftMessageChange]);

    React.useEffect(() => {
        return () => {
            debouncedPersist.flush();
        };
    }, [debouncedPersist]);

    React.useEffect(() => {
        if (dirtyRef.current) return;
        setLocalDraftMessage(String(props.externalDraftMessage ?? ''));
    }, [props.externalDraftMessage]);

    const onDraftMessageChange = React.useCallback((value: string) => {
        dirtyRef.current = true;
        setLocalDraftMessage(value);
        debouncedPersist.debounced(value);
    }, [debouncedPersist]);

    const onCommitFromMessage = React.useCallback((message: string) => {
        // Persist any pending draft immediately before committing.
        debouncedPersist.flush();
        dirtyRef.current = false;
        props.onCommitFromMessage(message);
    }, [debouncedPersist, props]);

    return (
        <ScmCommitComposerCard
            theme={props.theme}
            commitActionLabel={props.commitActionLabel}
            draftMessage={localDraftMessage}
            onDraftMessageChange={onDraftMessageChange}
            busy={props.busy}
            status={props.status}
            commitAllowed={props.commitAllowed}
            commitBlockedMessage={props.commitBlockedMessage}
            onCommitFromMessage={onCommitFromMessage}
            commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
            onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
            onCancelCommitMessageSuggestion={props.onCancelCommitMessageSuggestion}
            suggestionContextKey={props.suggestionContextKey}
            selectionSummary={props.selectionSummary}
            selectionCount={props.selectionCount}
            onClearSelection={props.onClearSelection}
            onSelectAllSelection={props.onSelectAllSelection}
            commitSelectionAvailable={props.commitSelectionAvailable}
            selectionModeActive={props.selectionModeActive}
            onEnterSelectionMode={props.onEnterSelectionMode}
            onExitSelectionMode={props.onExitSelectionMode}
            variant="railFooter"
            placeholder={props.selectionCount === 0 ? t('sessionGitPane.flow.commit.selectFirst') : undefined}
        />
    );
});

type CommitChangesSurfaceProps = Readonly<{
    theme: any;
    sessionId: string;
    serverId?: string;
    sessionPath: string | null;
    backendLabel: string;
    scmStatusFiles: ScmStatusFiles | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled?: boolean;
    scmOperationBusy: boolean;
    hasGlobalOperationInFlight: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    changedFilesViewMode: ChangedFilesViewMode;
    sessionAttribution: SessionChangeAttribution;
    sessionCheckpointOverlap: CheckpointOverlapObservation;

    allRepositoryChangedFiles: ScmFileStatus[];
    selectedRepositoryChangedFiles?: ScmFileStatus[];
    proposedGroupSelected?: boolean;
    proposalHighlight?: GitProposalHighlight | null;
    turnAttributedFiles?: SessionAttributedFile[];
    turnAgentReportedFiles?: SessionAttributedFile[];
    turnCheckpointFiles?: SessionAttributedFile[];
    turnCheckpointMetadata?: React.ComponentProps<typeof ChangedFilesList>['turnCheckpointMetadata'];
    turnRepositoryOnlyFiles?: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];

    showTurnViewToggle?: boolean;
    showTurnAgentReportedViewToggle?: boolean;
    showTurnCheckpointViewToggle?: boolean;
    showSessionViewToggle?: boolean;
    showSelectedViewToggle?: boolean;
    onChangedFilesViewMode?: (mode: ChangedFilesViewMode) => void;
    repositorySelectedCount: number;
    onSelectAll: () => void;
    onSelectNone: () => void;
    disableSelectAll: boolean;
    disableSelectNone: boolean;
    onFilePress: (file: ScmFileStatus) => void;
    onFilePressPinned: (file: ScmFileStatus) => void;
    onToggleSelectionForFile: (file: ScmFileStatus) => void;
    renderFileActions: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions: (file: ScmFileStatus) => React.ReactNode;
    onOpenReviewAllChanges?: () => void;
    onOpenStashDetails?: () => void;
    selectionActive: boolean;
    onToggleGroupSelection?: (files: readonly ScmFileStatus[], select: boolean) => void;
    listFooter: React.ReactElement | null;
    emptyState: React.ReactElement | null;
    scopeAccessory?: React.ReactNode;
    changesLayout: 'list' | 'tree';
    machineId: string | null;
    phone: boolean;
    agentId: AgentId | null;
    completedOperationId: string | null;
}>;

function resolveChangedFilesScopeTitle(params: Readonly<{
    changedFilesViewMode: ChangedFilesViewMode;
    repositoryCount: number;
    selectedCount: number;
    turnCount: number;
    sessionCount: number;
}>): string {
    if (params.changedFilesViewMode === 'selected') {
        return t('files.selectedForCommitChanges', { count: params.selectedCount });
    }
    if (params.changedFilesViewMode === 'turn') {
        return t('files.latestTurnChanges', { count: params.turnCount });
    }
    if (params.changedFilesViewMode === 'turn_agent_reported') {
        return t('files.agentReportedTurnChanges', { count: params.turnCount });
    }
    if (params.changedFilesViewMode === 'turn_checkpoint') {
        return t('files.checkpointTurnChanges', { count: params.turnCount });
    }
    if (params.changedFilesViewMode === 'session') {
        return t('files.sessionAttributedChanges', { count: params.sessionCount });
    }
    // The count lives once, on the Changes segment; the scope menu names the scope.
    return t('sessionGitPane.scope.allChanges');
}

function resolveChangedFilesScopeDescriptions(params: Readonly<{
    changedFilesViewMode: ChangedFilesViewMode;
    sessionAttribution: SessionChangeAttribution;
    sessionCheckpointOverlap: CheckpointOverlapObservation;
    turnCheckpointMetadata: React.ComponentProps<typeof ChangedFilesList>['turnCheckpointMetadata'];
}>): string[] {
    if (params.changedFilesViewMode === 'turn') {
        return [t('files.latestTurnDescription')];
    }
    if (params.changedFilesViewMode === 'turn_agent_reported') {
        return [t('files.agentReportedTurnDescription')];
    }
    if (params.changedFilesViewMode === 'turn_checkpoint') {
        const description = checkpointAttributionDescription(params.turnCheckpointMetadata);
        return description ? [description] : [];
    }
    if (params.changedFilesViewMode !== 'session') {
        return [];
    }
    // The Session scope is qualified by canonical Protocol attribution, not by how many other
    // Sessions a UI Project happens to group.
    return sessionAttributionDescriptions({
        attribution: params.sessionAttribution,
        checkpointOverlap: params.sessionCheckpointOverlap,
    });
}

const CommitChangesSurface = React.memo((props: CommitChangesSurfaceProps) => {
    const themeBorderDefault = props.theme.colors.border?.default ?? props.theme.colors.divider;
    const themeSurfaceBase = props.theme.colors.surface?.base ?? props.theme.colors.surface;
    const themeTextPrimary = props.theme.colors.text?.primary ?? props.theme.colors.text;
    const themeTextSecondary = props.theme.colors.text?.secondary ?? props.theme.colors.textSecondary;
    const themeSuccess = props.theme.colors.state?.success?.foreground ?? themeTextSecondary;
    const themeDanger = props.theme.colors.state?.danger?.foreground ?? themeTextSecondary;
    const selectedMode = props.changedFilesViewMode === 'selected';
    const [collapsedGroups, setCollapsedGroups] = React.useState<ReadonlySet<CommitGroupItem['id']>>(() => new Set(props.completedOperationId ? ['session', 'elsewhere'] : props.phone ? ['elsewhere'] : []));
    React.useEffect(() => {
        if (props.completedOperationId) setCollapsedGroups(new Set(['session', 'elsewhere']));
    }, [props.completedOperationId]);
    const toggleGroup = React.useCallback((id: CommitGroupItem['id']) => {
        setCollapsedGroups((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);
    const repositoryChangedFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(props.allRepositoryChangedFiles);
    }, [props.allRepositoryChangedFiles]);
    const selectedChangedFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(props.selectedRepositoryChangedFiles ?? []);
    }, [props.selectedRepositoryChangedFiles]);
    const turnChangedFiles = React.useMemo(() => filterPresentableSessionAttributedFiles(props.turnAttributedFiles ?? []), [props.turnAttributedFiles]);
    const turnAgentReportedChangedFiles = React.useMemo(
        () => filterPresentableSessionAttributedFiles(props.turnAgentReportedFiles ?? []),
        [props.turnAgentReportedFiles],
    );
    const turnCheckpointChangedFiles = React.useMemo(
        () => filterPresentableSessionAttributedFiles(props.turnCheckpointFiles ?? []),
        [props.turnCheckpointFiles],
    );
    const sessionChangedFiles = React.useMemo(() => filterPresentableSessionAttributedFiles(props.sessionAttributedFiles), [props.sessionAttributedFiles]);
    const preferredTreePaths = React.useMemo(() => new Set(sessionChangedFiles.map((entry) => entry.file.fullPath)), [sessionChangedFiles]);
    const currentRepositoryFileByPath = React.useMemo(
        () => new Map(repositoryChangedFiles.map((file) => [file.fullPath, file])),
        [repositoryChangedFiles],
    );
    const repositoryName = resolveRepositoryName(props.scmSnapshot?.repo.rootPath ?? props.sessionPath);
    // Lab G1: All changes reads this session's changes first, then the rest of the repository.
    // Git lab CF: files that need a decision (changed on both sides) come first, as "Needs you".
    const repositoryGroups = React.useMemo(() => {
        if (props.changedFilesViewMode !== 'repository') return null;
        const conflicts = repositoryChangedFiles.filter((file) => file.status === 'conflicted');
        if (conflicts.length > 0) {
            return { conflicts, session: [] as ScmFileStatus[], elsewhere: repositoryChangedFiles.filter((file) => file.status !== 'conflicted') };
        }
        const partition = partitionRepositoryChangesBySession(repositoryChangedFiles, sessionChangedFiles);
        return partition.session.length > 0 ? { conflicts, ...partition } : null;
    }, [props.changedFilesViewMode, repositoryChangedFiles, sessionChangedFiles]);
    const scopedChangedFiles = React.useMemo<CommitChangedFileItem[]>(() => {
        if (selectedMode) return selectedChangedFiles;
        if (props.changedFilesViewMode === 'turn') return turnChangedFiles;
        if (props.changedFilesViewMode === 'turn_agent_reported') return turnAgentReportedChangedFiles;
        if (props.changedFilesViewMode === 'turn_checkpoint') return turnCheckpointChangedFiles;
        if (props.changedFilesViewMode === 'session') return sessionChangedFiles;
        return repositoryChangedFiles;
    }, [
        props.changedFilesViewMode,
        repositoryChangedFiles,
        selectedChangedFiles,
        selectedMode,
        sessionChangedFiles,
        turnAgentReportedChangedFiles,
        turnChangedFiles,
        turnCheckpointChangedFiles,
    ]);
    const virtualizedChangedFiles = React.useMemo<CommitListItem[]>(() => {
        if (!repositoryGroups) return scopedChangedFiles;
        const items: CommitListItem[] = [];
        const pushGroup = (id: CommitGroupItem['id'], title: string, files: readonly ScmFileStatus[]) => {
            if (files.length === 0) return;
            items.push({ kind: 'group', id, title, files });
            if (!collapsedGroups.has(id)) items.push(...files);
        };
        pushGroup('conflicts', t('sessionGitPane.flow.conflicts.needsYou'), repositoryGroups.conflicts);
        pushGroup('session', t('sessionGitPane.groups.session'), repositoryGroups.session);
        pushGroup(
            'elsewhere',
            repositoryGroups.conflicts.length > 0
                ? t('sessionGitPane.flow.conflicts.mergedCleanly')
                : repositoryName ? t('sessionGitPane.groups.elsewhere', { repo: repositoryName }) : t('sessionGitPane.groups.elsewhereUnnamed'),
            repositoryGroups.elsewhere,
        );
        return items;
    }, [repositoryGroups, repositoryName, scopedChangedFiles, collapsedGroups]);
    const listedFiles = React.useMemo(
        () => scopedChangedFiles.map(getCommitChangedFile),
        [scopedChangedFiles],
    );
    // Duplicate names get their nearest distinguishing folder (lab G1): each row is handed only the
    // paths that share its name, so the work stays linear in the list.
    const pathsByFileName = React.useMemo(() => {
        const byName = new Map<string, string[]>();
        for (const file of listedFiles) {
            const paths = byName.get(file.fileName);
            if (paths) paths.push(file.fullPath);
            else byName.set(file.fileName, [file.fullPath]);
        }
        return byName;
    }, [listedFiles]);
    const scopedLineTotals = React.useMemo(() => sumChangedLines(listedFiles), [listedFiles]);
    const virtualizedStatsColumnWidth = React.useMemo(
        () => resolveScmChangeStatsColumnWidth(listedFiles),
        [listedFiles],
    );
    const selectedPathSet = React.useMemo(
        () => new Set(selectedChangedFiles.map((file) => file.fullPath)),
        [selectedChangedFiles],
    );
    const virtualizedKeyExtractor = React.useCallback((item: CommitListItem) => {
        if (isCommitListMarker(item)) return `group-${item.id}`;
        const file = getCommitChangedFile(item);
        if (selectedMode) return selectedChangedFileKeyExtractor(file);
        if (props.changedFilesViewMode === 'turn') return `turn-${file.fullPath}`;
        if (props.changedFilesViewMode === 'turn_agent_reported') return `turn-agent-${file.fullPath}`;
        if (props.changedFilesViewMode === 'turn_checkpoint') return `turn-checkpoint-${file.fullPath}`;
        if (props.changedFilesViewMode === 'session') return `session-${file.fullPath}`;
        return repositoryChangedFileKeyExtractor(file);
    }, [props.changedFilesViewMode, selectedMode]);
    const showSelectedViewToggle = props.showSelectedViewToggle === true || selectedChangedFiles.length > 0;
    const hasChangedFilesViewSelector = props.showTurnViewToggle === true
        || props.showTurnAgentReportedViewToggle === true
        || props.showTurnCheckpointViewToggle === true
        || props.showSessionViewToggle === true
        || showSelectedViewToggle;
    const turnChangedFilesCount = props.changedFilesViewMode === 'turn_agent_reported'
        ? turnAgentReportedChangedFiles.length
        : props.changedFilesViewMode === 'turn_checkpoint'
            ? turnCheckpointChangedFiles.length
            : turnChangedFiles.length;
    const sessionChangedFilesCount = sessionChangedFiles.length;
    const scopedChangedFilesTitle = React.useMemo(() => {
        return resolveChangedFilesScopeTitle({
            changedFilesViewMode: props.changedFilesViewMode,
            repositoryCount: repositoryChangedFiles.length,
            selectedCount: selectedChangedFiles.length,
            turnCount: turnChangedFilesCount,
            sessionCount: sessionChangedFilesCount,
        });
    }, [
        props.changedFilesViewMode,
        repositoryChangedFiles.length,
        selectedChangedFiles.length,
        sessionChangedFilesCount,
        turnChangedFilesCount,
    ]);
    const scopedChangedFilesDescriptions = React.useMemo(() => {
        return resolveChangedFilesScopeDescriptions({
            changedFilesViewMode: props.changedFilesViewMode,
            sessionAttribution: props.sessionAttribution,
            sessionCheckpointOverlap: props.sessionCheckpointOverlap,
            turnCheckpointMetadata: props.turnCheckpointMetadata ?? null,
        });
    }, [
        props.changedFilesViewMode,
        props.sessionAttribution,
        props.sessionCheckpointOverlap,
        props.turnCheckpointMetadata,
    ]);

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    // The pane header carries the branch, the count and the next step (lab H1); the body starts with
    // the scope row — no second header strip here.
    const showsFinishedState = Boolean(props.emptyState) && props.changedFilesViewMode === 'repository' && repositoryChangedFiles.length === 0;
    const headerContent = React.useMemo(() => {
        if (showsFinishedState) return null;
        return (
            <>
                <View
                    style={{
                        paddingHorizontal: 12,
                        paddingTop: 4,
                        paddingBottom: 6,
                        backgroundColor: themeSurfaceBase,
                    }}
                >
                    <View
                        testID="session-rightpanel-git-scope-actions-row"
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                        }}
                    >
                        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            {hasChangedFilesViewSelector ? (
                                <ChangedFilesViewModeMenu
                                    presentation="text"
                                    theme={props.theme}
                                    changedFilesViewMode={props.changedFilesViewMode}
                                    showSelectedViewToggle={showSelectedViewToggle}
                                    showTurnViewToggle={props.showTurnViewToggle}
                                    showTurnAgentReportedViewToggle={props.showTurnAgentReportedViewToggle}
                                    showTurnCheckpointViewToggle={props.showTurnCheckpointViewToggle}
                                    showSessionViewToggle={props.showSessionViewToggle}
                                    onChangedFilesViewMode={props.onChangedFilesViewMode}
                                    testID="session-rightpanel-git-view-mode-menu"
                                    triggerLabel={scopedChangedFilesTitle}
                                    triggerLabelColor={themeTextSecondary}
                                    triggerStyle={{ alignSelf: 'flex-start', maxWidth: '100%' }}
                                    popoverAnchorAlign="start"
                                />
                            ) : (
                                <Text style={{ fontSize: 12, color: themeTextSecondary, ...Typography.default('semiBold') }}>
                                    {t('sessionGitPane.scope.allChanges')}
                                </Text>
                            )}
                            {props.scopeAccessory ?? null}
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            {scopedLineTotals.added > 0 || scopedLineTotals.removed > 0 ? (
                                <View testID="session-rightpanel-git-scope-lines" style={{ flexDirection: 'row', gap: 6 }}>
                                    <Text style={{ fontSize: 12, fontVariant: ['tabular-nums'], color: themeSuccess, ...Typography.default('semiBold') }}>
                                        {`+${formatExactCount(scopedLineTotals.added)}`}
                                    </Text>
                                    <Text style={{ fontSize: 12, fontVariant: ['tabular-nums'], color: themeDanger, ...Typography.default('semiBold') }}>
                                        {`\u2212${formatExactCount(scopedLineTotals.removed)}`}
                                    </Text>
                                </View>
                            ) : null}
                            {props.onOpenReviewAllChanges ? (
                                <IconButton
                                    testID="session-rightpanel-git-open-review"
                                    variant="plain"
                                    size={28}
                                    accessibilityLabel={t('files.toolbar.review')}
                                    tooltip={t('files.toolbar.review')}
                                    icon={<Icon name="git-diff" size={14} color={themeTextSecondary} />}
                                    onPress={props.onOpenReviewAllChanges}
                                />
                            ) : null}
                        </View>
                    </View>
                    {hasChangedFilesViewSelector && scopedChangedFilesDescriptions.length > 0 ? (
                        <View testID="session-rightpanel-git-scope-description" style={{ marginTop: 6 }}>
                            {scopedChangedFilesDescriptions.map((description, index) => (
                                <Text
                                    key={`${index}:${description}`}
                                    numberOfLines={2}
                                    style={{
                                        marginTop: index === 0 ? 0 : 2,
                                        fontSize: index === 0 ? 12 : 11,
                                        color: themeTextSecondary,
                                        ...Typography.default(),
                                    }}
                                >
                                    {description}
                                </Text>
                            ))}
                        </View>
                    ) : null}
                </View>
            </>
        );
    }, [
        showsFinishedState,
        props.scopeAccessory,
        hasChangedFilesViewSelector,
        scopedLineTotals,
        props.onOpenReviewAllChanges,
        props.changedFilesViewMode,
        props.onChangedFilesViewMode,
        props.showSessionViewToggle,
        themeDanger,
        themeSuccess,
        showSelectedViewToggle,
        props.showTurnAgentReportedViewToggle,
        props.showTurnCheckpointViewToggle,
        props.showTurnViewToggle,
        themeBorderDefault,
        themeSurfaceBase,
        themeTextPrimary,
        themeTextSecondary,
        scopedChangedFilesDescriptions,
        scopedChangedFilesTitle,
    ]);

    // The name-first row reads one user setting; Review's active file highlights and reveals here.
    const changedFileRowLayout = useChangedFileRowLayout();
    const flightAnchors = React.useContext(GitCommitFlightAnchorsContext);
    const activeReviewFileKey = activeReviewFileKeyForSession(props.sessionId, props.serverId);
    const listRef = React.useRef<{ scrollToIndex?: (params: { index: number; animated?: boolean; viewPosition?: number }) => void } | null>(null);
    const activeReviewPath = useActiveReviewFilePath(activeReviewFileKey);
    React.useEffect(() => {
        if (!activeReviewPath) return;
        if (repositoryGroups) {
            const group = (Object.keys(repositoryGroups) as CommitGroupItem['id'][]).find((id) => repositoryGroups[id].some((file) => file.fullPath === activeReviewPath));
            if (group && collapsedGroups.has(group)) {
                toggleGroup(group);
                return;
            }
        }
        const index = virtualizedChangedFiles.findIndex((item) => !isCommitListMarker(item) && getCommitChangedFile(item).fullPath === activeReviewPath);
        if (index < 0) return;
        listRef.current?.scrollToIndex?.({ index, animated: true, viewPosition: 0.5 });
    }, [activeReviewPath, virtualizedChangedFiles, repositoryGroups, collapsedGroups, toggleGroup]);

    const virtualizedRowStateRef = React.useRef({
        onFilePress: props.onFilePress,
        onFilePressPinned: props.onFilePressPinned,
        onToggleSelectionForFile: props.onToggleSelectionForFile,
        renderFileActions: props.renderFileActions,
        renderFileTrailingActions: props.renderFileTrailingActions,
        theme: props.theme,
        virtualizedChangedFilesLength: virtualizedChangedFiles.length,
        virtualizedStatsColumnWidth,
        pathsByFileName,
        repositoryName,
        selectedPathSet,
        selectionActive: props.selectionActive,
        proposedGroupSelected: props.proposedGroupSelected,
        proposalHighlight: props.proposalHighlight ?? null,
        onToggleGroupSelection: props.onToggleGroupSelection,
        changedFileRowLayout,
        activeReviewFileKey,
        flightAnchors,
        collapsedGroups,
        toggleGroup,
        agentId: props.agentId,
        phone: props.phone,
    });
    virtualizedRowStateRef.current = {
        onFilePress: props.onFilePress,
        onFilePressPinned: props.onFilePressPinned,
        onToggleSelectionForFile: props.onToggleSelectionForFile,
        renderFileActions: props.renderFileActions,
        renderFileTrailingActions: props.renderFileTrailingActions,
        theme: props.theme,
        virtualizedChangedFilesLength: virtualizedChangedFiles.length,
        virtualizedStatsColumnWidth,
        pathsByFileName,
        repositoryName,
        selectedPathSet,
        selectionActive: props.selectionActive,
        proposedGroupSelected: props.proposedGroupSelected,
        proposalHighlight: props.proposalHighlight ?? null,
        onToggleGroupSelection: props.onToggleGroupSelection,
        changedFileRowLayout,
        activeReviewFileKey,
        flightAnchors,
        collapsedGroups,
        toggleGroup,
        agentId: props.agentId,
        phone: props.phone,
    };
    // RN's FlatList only re-renders cells when `data` or `extraData` change —
    // NOT when `renderItem` (or a ref it reads) changes. So `extraData` MUST
    // carry every dynamic value that affects a row's rendered output, including
    // the per-row render callbacks. Omitting `renderFileActions` is what made the
    // commit-selection "+" appear only after an unrelated data change flushed the
    // cached cells. `renderFileActions` / `renderFileTrailingActions` change
    // identity on selection-mode entry/exit AND on every per-file selection
    // toggle, so including them keeps the "+" and its checked state in sync
    // immediately.
    const virtualizedRowExtraData = React.useMemo(() => ({
        currentRepositoryFileByPath,
        statsColumnWidth: virtualizedStatsColumnWidth,
        textPrimary: themeTextPrimary,
        textSecondary: themeTextSecondary,
        virtualizedChangedFilesLength: virtualizedChangedFiles.length,
        renderFileActions: props.renderFileActions,
        renderFileTrailingActions: props.renderFileTrailingActions,
        pathsByFileName,
        selectedPathSet,
        selectionActive: props.selectionActive,
        proposalHighlight: props.proposalHighlight ?? null,
        changedFileRowLayout,
        activeReviewFileKey,
        collapsedGroups,
        agentId: props.agentId,
        phone: props.phone,
    }), [
        changedFileRowLayout,
        activeReviewFileKey,
        collapsedGroups,
        props.agentId,
        props.phone,
        currentRepositoryFileByPath,
        pathsByFileName,
        selectedPathSet,
        props.selectionActive,
        props.proposedGroupSelected,
        props.proposalHighlight,
        themeTextPrimary,
        themeTextSecondary,
        virtualizedChangedFiles.length,
        virtualizedStatsColumnWidth,
        props.renderFileActions,
        props.renderFileTrailingActions,
    ]);

    const renderVirtualizedRow = React.useCallback(({ item, index }: { item: CommitListItem; index: number }) => {
        if (isCommitListMarker(item)) {
            const state = virtualizedRowStateRef.current;
            return (
                <ChangeGroupHeaderRow
                    theme={state.theme}
                    group={item}
                    selectedPathSet={state.selectedPathSet}
                    selectionActive={state.selectionActive}
                    onToggleGroupSelection={state.onToggleGroupSelection}
                    proposalHighlight={state.proposalHighlight}
                    collapsed={state.collapsedGroups.has(item.id)}
                    onToggleCollapsed={() => state.toggleGroup(item.id)}
                    agentId={state.agentId}
                />
            );
        }
        const file = getCommitChangedFile(item);
        const attributedEntry = isAttributedChangedFileItem(item) ? item : null;
        const actionableFile = attributedEntry ? currentRepositoryFileByPath.get(file.fullPath) : file;
        const {
            onFilePress,
            onFilePressPinned,
            onToggleSelectionForFile,
            renderFileActions,
            renderFileTrailingActions,
            theme,
            virtualizedStatsColumnWidth,
            pathsByFileName,
            repositoryName,
            changedFileRowLayout: rowLayout,
            activeReviewFileKey: rowActiveReviewFileKey,
        } = virtualizedRowStateRef.current;
        const sameNamePaths = pathsByFileName.get(file.fileName);
        const row = (
            <ScmChangeRow
                theme={theme}
                file={file}
                proposalEmphasis={virtualizedRowStateRef.current.proposalHighlight ? (virtualizedRowStateRef.current.proposalHighlight.paths.has(file.fullPath) ? 'in' : 'out') : null}
                proposalNote={virtualizedRowStateRef.current.proposalHighlight?.notes.get(file.fullPath) ?? null}
                tag={resolveScmChangePathTag(file.fullPath)}
                layout={rowLayout}
                phone={virtualizedRowStateRef.current.phone}
                activeReviewFileKey={rowActiveReviewFileKey}
                siblingPaths={sameNamePaths && sameNamePaths.length > 1 ? sameNamePaths : undefined}
                rootLabel={repositoryName}
                leadingElement={file.status !== 'conflicted' && actionableFile && renderFileActions ? renderFileActions(actionableFile) : null}
                trailingElement={file.status === 'conflicted'
                    ? <ToolbarButton testID={`scm-conflict-open:${file.fullPath}`} label={t('common.open')} accessibilityLabel={t('common.open')} style={{ borderWidth: 0, backgroundColor: 'transparent' }} onPress={() => onFilePress(file)} />
                    : renderFileTrailingActions ? renderFileTrailingActions(file) : null}
                onPress={() => onFilePress(file)}
                onPressPinned={() => onFilePressPinned(file)}
                onToggleSelection={file.status !== 'conflicted' && actionableFile && onToggleSelectionForFile ? () => onToggleSelectionForFile(actionableFile) : undefined}
                statsColumnWidth={virtualizedStatsColumnWidth}
                showDivider={false}
                accessibilityQualification={attributedEntry
                    ? sessionAttributedFileAccessibilityQualification(attributedEntry)
                    : undefined}
            />
        );
        return (
            <View ref={registerGitCommitFlightRow(virtualizedRowStateRef.current.flightAnchors, file.fullPath)} collapsable={false}>
                {row}
                {attributedEntry ? <ChangedFileEvidenceDisclosure entry={attributedEntry} /> : null}
            </View>
        );
    }, [currentRepositoryFileByPath]);

    const emptyChangedFilesContent = React.useMemo(() => {
        if (props.emptyState && props.changedFilesViewMode === 'repository') return props.emptyState;
        if (props.changedFilesViewMode === 'turn_checkpoint'
            && props.turnCheckpointMetadata?.contentConfidence === 'unavailable') return null;
        const label = t(resolveChangedFilesEmptyStateTranslationKey(props.changedFilesViewMode));
        return (
            <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                <Text style={{ color: themeTextSecondary, fontSize: 12, ...Typography.default() }}>
                    {label}
                </Text>
            </View>
        );
    }, [props.changedFilesViewMode, props.emptyState, props.turnCheckpointMetadata?.contentConfidence, themeTextSecondary]);

    const onToggleFolderPaths = React.useCallback((paths: readonly string[], select: boolean) => {
        const files = paths.flatMap((path) => {
            const found = currentRepositoryFileByPath.get(path);
            return found ? [found] : [];
        });
        virtualizedRowStateRef.current.onToggleGroupSelection?.(files, select);
    }, [currentRepositoryFileByPath]);
    const onOpenTreeFile = React.useCallback((path: string) => {
        const found = currentRepositoryFileByPath.get(path);
        if (found) virtualizedRowStateRef.current.onFilePress(found);
    }, [currentRepositoryFileByPath]);
    const onOpenTreeFilePinned = React.useCallback((path: string) => {
        const found = currentRepositoryFileByPath.get(path);
        if (found) virtualizedRowStateRef.current.onFilePressPinned(found);
    }, [currentRepositoryFileByPath]);
    const renderTreeTrailingActions = React.useCallback(
        (entry: ScmFileStatus) => virtualizedRowStateRef.current.renderFileTrailingActions(entry),
        [],
    );
    const onToggleTreeFile = React.useCallback(
        (entry: ScmFileStatus) => virtualizedRowStateRef.current.onToggleSelectionForFile(entry),
        [],
    );
    // Git lab TV: the tree is the Files tree primitive; the scope row stays above it and the timeline below it.
    if (props.changesLayout === 'tree' && props.scmSnapshot && listedFiles.length > 0) {
        return (
            <View style={{ flex: 1, position: 'relative' }}>
                {headerContent}
                <GitChangesTree
                    theme={props.theme}
                    sessionId={props.sessionId}
                    serverId={props.serverId}
                    machineId={props.machineId}
                    snapshot={props.scmSnapshot}
                    files={listedFiles}
                    preferredPaths={preferredTreePaths}
                    selectedPaths={selectedPathSet}
                    selectionEnabled={props.selectionActive || props.proposedGroupSelected === true}
                    selectionReadOnly={props.proposedGroupSelected}
                    proposal={props.proposalHighlight ?? null}
                    onToggleFile={onToggleTreeFile}
                    onToggleFolder={onToggleFolderPaths}
                    onOpenFile={onOpenTreeFile}
                    onOpenFilePinned={onOpenTreeFilePinned}
                    renderTrailingActions={renderTreeTrailingActions}
                    listFooter={props.listFooter}
                />
            </View>
        );
    }

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            <VirtualizedList
                ref={listRef as never}
                data={virtualizedChangedFiles}
                keyExtractor={virtualizedKeyExtractor}
                ListHeaderComponent={headerContent}
                ListEmptyComponent={emptyChangedFilesContent}
                ListFooterComponent={props.listFooter}
                contentContainerStyle={commitChangedFilesListContentContainerStyle}
                renderItem={renderVirtualizedRow}
                extraData={virtualizedRowExtraData}
                initialNumToRender={Math.min(COMMIT_CHANGED_FILES_INITIAL_RENDER_COUNT, virtualizedChangedFiles.length)}
                maxToRenderPerBatch={COMMIT_CHANGED_FILES_RENDER_BATCH_SIZE}
                windowSize={COMMIT_CHANGED_FILES_WINDOW_SIZE}
                removeClippedSubviews={Platform.OS !== 'web'}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={scrollFades.onContentSizeChange}
                onScroll={scrollFades.onScroll}
                scrollEventThrottle={16}
                estimatedItemSize={STACKED_CHANGE_ROW_ESTIMATED_HEIGHT_PX}
            />

            <ScrollEdgeFades
                color={themeSurfaceBase}
                size={18}
                edges={scrollFades.visibility}
            />
            <ScrollEdgeIndicators
                edges={scrollFades.visibility}
                color={themeTextSecondary}
                size={14}
                opacity={0.35}
            />
        </View>
    );
});

/**
 * A change group's heading (lab G1): its checkbox selects or clears every file in it, then the group's
 * name and how many files it holds.
 */
const ChangeGroupHeaderRow = React.memo((props: Readonly<{
    theme: any;
    group: CommitGroupItem;
    selectedPathSet: ReadonlySet<string>;
    selectionActive: boolean;
    onToggleGroupSelection?: (files: readonly ScmFileStatus[], select: boolean) => void;
    proposalHighlight?: GitProposalHighlight | null;
    collapsed: boolean;
    onToggleCollapsed: () => void;
    agentId: AgentId | null;
}>) => {
    const { group, onToggleGroupSelection } = props;
    let selected = 0;
    for (const file of group.files) {
        if (props.selectedPathSet.has(file.fullPath)) selected += 1;
    }
    const state = selected === 0 ? 'unchecked' : selected === group.files.length ? 'checked' : 'mixed';
    const proposalCount = props.proposalHighlight ? group.files.filter((file) => props.proposalHighlight!.paths.has(file.fullPath)).length : 0;
    const canToggle = group.id !== 'conflicts' && props.selectionActive && Boolean(onToggleGroupSelection) && group.files.length > 0;
    const onPress = React.useCallback(() => {
        onToggleGroupSelection?.(group.files, state !== 'checked');
    }, [group.files, onToggleGroupSelection, state]);
    const textSecondary = props.theme.colors.text?.secondary ?? props.theme.colors.textSecondary;
    const textTertiary = props.theme.colors.text?.tertiary ?? textSecondary;
    return (
        <View
            testID={`scm-change-group:${group.id}`}
            accessibilityRole="header"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: canToggle ? 8 : 12, paddingRight: 12, paddingTop: 10, paddingBottom: 4 }}
        >
            <IconButton
                testID={`scm-change-group-collapse:${group.id}`}
                variant="plain"
                size={24}
                accessibilityLabel={group.title}
                expanded={!props.collapsed}
                icon={<Icon name={props.collapsed ? 'caret-right' : 'caret-down'} size={12} color={textSecondary} />}
                onPress={props.onToggleCollapsed}
            />
            {canToggle ? (
                <IconButton
                    testID={`scm-change-group-select:${group.id}`}
                    variant="plain"
                    size={28}
                    accessibilityRole="checkbox"
                    checked={state === 'checked'}
                    selectedBackground={false}
                    accessibilityLabel={t('sessionGitPane.groups.selectGroup', { group: group.title })}
                    icon={<ScmCommitSelectionCheckGlyph state={state} />}
                    onPress={onPress}
                />
            ) : null}
            {group.id === 'session' && props.agentId ? <AgentIcon agentId={props.agentId} size={14} /> : null}
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, color: textSecondary, ...Typography.default('semiBold') }}>
                {group.title}
            </Text>
            <Text style={{ fontSize: 12, color: textTertiary, fontVariant: ['tabular-nums'], ...Typography.default() }}>
                {formatExactCount(group.files.length)}
            </Text>
            {proposalCount > 0 && props.proposalHighlight ? (
                <Text testID={`scm-change-group-proposal:${group.id}`} style={{ marginLeft: 'auto', fontSize: 12, color: props.theme.colors.state.active.foreground, fontVariant: ['tabular-nums'], ...Typography.default('semiBold') }}>
                    {t('commitProposal.gitPane.inCommit', { count: proposalCount, number: props.proposalHighlight.groupNumber })}
                </Text>
            ) : null}
        </View>
    );
});
