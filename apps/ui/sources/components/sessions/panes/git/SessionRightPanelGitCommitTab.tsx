import * as React from 'react';
import { FlatList, Platform, Pressable, ScrollView, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { SourceControlBranchSummary } from '@/components/workspaces/scm/SourceControlBranchSummary';
import { ChangedFilesList } from '@/components/sessions/files/content/ChangedFilesList';
import { SourceControlBranchMenu } from '@/components/sessions/sourceControl/branches/SourceControlBranchMenu';
import { ChangedFilesViewModeMenu } from '@/components/sessions/files/ChangedFilesViewModeMenu';
import { ScmCommitComposerCard, type ScmCommitComposerCardProps } from '@/components/workspaces/scm/commitComposer/ScmCommitComposerCard';
import { ScmChangeRow, resolveScmChangeStatsColumnWidth } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { Text } from '@/components/ui/text/Text';
import type { ScmFileStatus, ScmStatusFiles } from '@/scm/scmStatusFiles';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ChangedFilesViewMode, SessionAttributedFile, SessionAttributionReliability } from '@/scm/scmAttribution';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { createAdvancedDebounce } from '@/utils/timing/debounce';
import { filterDirectoryLikeScmFileStatuses, isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import { sessionScmStashList } from '@/sync/ops';
import { resolveSnapshotScmStashCount, useScmStashSummaryCount } from '@/scm/stash/useScmStashSummaryCount';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';

export type SessionRightPanelGitCommitTabProps = Readonly<{
    theme: any;
    sessionId: string;
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
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    selectedRepositoryChangedFiles?: ScmFileStatus[];
    turnAttributedFiles?: SessionAttributedFile[];
    turnAgentReportedFiles?: SessionAttributedFile[];
    turnCheckpointFiles?: SessionAttributedFile[];
    turnCheckpointMetadata?: React.ComponentProps<typeof ChangedFilesList>['turnCheckpointMetadata'];
    turnRepositoryOnlyFiles?: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
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
    onCommitFromMessage: (message: string) => void;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    commitAdjacentPushAction?: ScmCommitComposerCardProps['pushShortcut'];
    onClearSelection?: () => void;

    scmStatusFiles: ScmStatusFiles | null;
    showBranchSummary?: boolean;
    showCommitComposer?: boolean;
    onOpenReviewAllChanges?: () => void;
    onOpenStashDetails?: () => void;
}>;

export const SessionRightPanelGitCommitTab = React.memo((props: SessionRightPanelGitCommitTabProps) => {
    const showCommitComposer = props.showCommitComposer !== false;
    const keyboardBottomInset = useKeyboardHeight();

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            <CommitChangesSurface
                theme={props.theme}
                sessionId={props.sessionId}
                sessionPath={props.sessionPath}
                scmStatusFiles={props.scmStatusFiles}
                scmSnapshot={props.scmSnapshot}
                scmWriteEnabled={props.scmWriteEnabled}
                scmOperationBusy={props.scmOperationBusy}
                hasGlobalOperationInFlight={props.hasGlobalOperationInFlight}
                inFlightScmOperation={props.inFlightScmOperation}
                changedFilesViewMode={props.changedFilesViewMode}
                attributionReliability={props.attributionReliability}
                allRepositoryChangedFiles={props.allRepositoryChangedFiles}
                selectedRepositoryChangedFiles={props.selectedRepositoryChangedFiles}
                turnAttributedFiles={props.turnAttributedFiles}
                turnAgentReportedFiles={props.turnAgentReportedFiles}
                turnCheckpointFiles={props.turnCheckpointFiles}
                turnCheckpointMetadata={props.turnCheckpointMetadata}
                turnRepositoryOnlyFiles={props.turnRepositoryOnlyFiles}
                sessionAttributedFiles={props.sessionAttributedFiles}
                repositoryOnlyFiles={props.repositoryOnlyFiles}
                suppressedInferredCount={props.suppressedInferredCount}
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
                showBranchSummary={props.showBranchSummary}
                onOpenReviewAllChanges={props.onOpenReviewAllChanges}
                onOpenStashDetails={props.onOpenStashDetails}
            />
            {showCommitComposer ? (
                <View
                    style={{
                        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderTopColor: props.theme.colors.border.default,
                        backgroundColor: props.theme.colors.surface.base,
                        marginBottom: keyboardBottomInset > 0 ? keyboardBottomInset : undefined,
                    }}
                >
                    <CommitComposerFooter
                        theme={props.theme}
                        commitActionLabel={props.commitActionLabel}
                        externalDraftMessage={props.commitDraftMessage}
                        onExternalDraftMessageChange={props.onCommitDraftMessageChange}
                        busy={props.scmOperationBusy || props.hasGlobalOperationInFlight}
                        status={props.scmOperationStatus}
                        commitAllowed={props.commitAllowed}
                        commitBlockedMessage={props.commitBlockedMessage}
                        onCommitFromMessage={props.onCommitFromMessage}
                        commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
                        onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
                        commitAdjacentPushAction={props.commitAdjacentPushAction}
                        selectionCount={props.repositorySelectedCount}
                        onClearSelection={props.onClearSelection}
                        onSelectAllSelection={props.onSelectAll}
                    />
                </View>
            ) : null}
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
    onCommitFromMessage: (message: string) => void;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    commitAdjacentPushAction?: ScmCommitComposerCardProps['pushShortcut'];
    selectionCount: number;
    onClearSelection?: () => void;
    onSelectAllSelection?: () => void;
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
            pushShortcut={props.commitAdjacentPushAction}
            selectionCount={props.selectionCount}
            onClearSelection={props.onClearSelection}
            onSelectAllSelection={props.onSelectAllSelection}
            variant="railFooter"
        />
    );
});

type CommitChangesSurfaceProps = Readonly<{
    theme: any;
    sessionId: string;
    sessionPath: string | null;
    scmStatusFiles: ScmStatusFiles | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled?: boolean;
    scmOperationBusy: boolean;
    hasGlobalOperationInFlight: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    selectedRepositoryChangedFiles?: ScmFileStatus[];
    turnAttributedFiles?: SessionAttributedFile[];
    turnAgentReportedFiles?: SessionAttributedFile[];
    turnCheckpointFiles?: SessionAttributedFile[];
    turnCheckpointMetadata?: React.ComponentProps<typeof ChangedFilesList>['turnCheckpointMetadata'];
    turnRepositoryOnlyFiles?: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
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
    showBranchSummary?: boolean;
    onOpenReviewAllChanges?: () => void;
    onOpenStashDetails?: () => void;
}>;

function countVisibleAttributedFiles(files: readonly SessionAttributedFile[] | undefined): number {
    if (!files) return 0;
    return files.filter((entry) => entry?.file && !isDirectoryLikeScmFileStatus(entry.file)).length;
}

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
    return t('files.repositoryChangedFiles', { count: params.repositoryCount });
}

function resolveChangedFilesScopeDescriptions(params: Readonly<{
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    suppressedInferredCount: number;
    turnCheckpointMetadata: React.ComponentProps<typeof ChangedFilesList>['turnCheckpointMetadata'];
}>): string[] {
    if (params.changedFilesViewMode === 'turn') {
        return [t('files.latestTurnDescription')];
    }
    if (params.changedFilesViewMode === 'turn_agent_reported') {
        return [t('files.agentReportedTurnDescription')];
    }
    if (params.changedFilesViewMode === 'turn_checkpoint') {
        if (params.turnCheckpointMetadata?.contentConfidence === 'unavailable') {
            return [t('files.checkpointUnavailable')];
        }
        if (params.turnCheckpointMetadata?.attributionScope === 'shared_worktree') {
            return [t('files.checkpointAttributionShared')];
        }
        return [t('files.checkpointAttributionUnknown')];
    }
    if (params.changedFilesViewMode !== 'session') {
        return [];
    }

    const descriptions = [
        params.attributionReliability === 'high'
            ? t('files.attributionReliabilityHigh')
            : t('files.attributionReliabilityLimited'),
        params.attributionReliability === 'high'
            ? t('files.attributionLegendFull')
            : t('files.attributionLegendDirectOnly'),
    ];

    if (params.suppressedInferredCount > 0) {
        descriptions.push(t('files.inferredSuppressed', { count: params.suppressedInferredCount }));
    }

    return descriptions;
}

const CommitChangesSurface = React.memo((props: CommitChangesSurfaceProps) => {
    const repositoryMode = props.changedFilesViewMode === 'repository';
    const selectedMode = props.changedFilesViewMode === 'selected';
    const repositoryChangedFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(props.allRepositoryChangedFiles);
    }, [props.allRepositoryChangedFiles]);
    const selectedChangedFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(props.selectedRepositoryChangedFiles ?? []);
    }, [props.selectedRepositoryChangedFiles]);
    const virtualizedChangedFiles = selectedMode ? selectedChangedFiles : repositoryChangedFiles;
    const virtualizedStatsColumnWidth = React.useMemo(
        () => resolveScmChangeStatsColumnWidth(virtualizedChangedFiles),
        [virtualizedChangedFiles],
    );
    const showSelectedViewToggle = props.showSelectedViewToggle === true || selectedChangedFiles.length > 0;
    const hasChangedFilesViewSelector = props.showTurnViewToggle === true
        || props.showTurnAgentReportedViewToggle === true
        || props.showTurnCheckpointViewToggle === true
        || props.showSessionViewToggle === true
        || showSelectedViewToggle;
    const turnChangedFilesCount = React.useMemo(() => {
        if (props.changedFilesViewMode === 'turn_agent_reported') {
            return countVisibleAttributedFiles(props.turnAgentReportedFiles);
        }
        if (props.changedFilesViewMode === 'turn_checkpoint') {
            return countVisibleAttributedFiles(props.turnCheckpointFiles);
        }
        return countVisibleAttributedFiles(props.turnAttributedFiles);
    }, [
        props.changedFilesViewMode,
        props.turnAgentReportedFiles,
        props.turnAttributedFiles,
        props.turnCheckpointFiles,
    ]);
    const sessionChangedFilesCount = React.useMemo(() => {
        return countVisibleAttributedFiles(props.sessionAttributedFiles);
    }, [props.sessionAttributedFiles]);
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
            attributionReliability: props.attributionReliability,
            suppressedInferredCount: props.suppressedInferredCount,
            turnCheckpointMetadata: props.turnCheckpointMetadata ?? null,
        });
    }, [
        props.attributionReliability,
        props.changedFilesViewMode,
        props.suppressedInferredCount,
        props.turnCheckpointMetadata,
    ]);

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const canReadStashes = props.scmSnapshot?.capabilities?.readStash === true;
    const snapshotStashCount = React.useMemo(
        () => resolveSnapshotScmStashCount(props.scmSnapshot),
        [props.scmSnapshot],
    );
    const stashCount = useScmStashSummaryCount({
        enabled: canReadStashes,
        snapshotCount: snapshotStashCount,
        refreshKey: `${props.sessionId}:${props.scmSnapshot?.fetchedAt ?? 0}`,
        load: React.useCallback(async () => await sessionScmStashList(props.sessionId, {}), [props.sessionId]),
    });
    const headerContent = React.useMemo(() => {
        const lockedByOtherSession = Boolean(
            props.inFlightScmOperation && props.inFlightScmOperation.sessionId !== props.sessionId,
        );
        const branchActionsDisabled = props.scmOperationBusy || props.hasGlobalOperationInFlight || lockedByOtherSession;
        const branchTrigger = props.scmStatusFiles ? (
            <SourceControlBranchMenu
                sessionId={props.sessionId}
                currentBranch={props.scmStatusFiles.branch ?? null}
                snapshot={props.scmSnapshot}
                writeEnabled={props.scmWriteEnabled}
                disabled={branchActionsDisabled}
                testID="scm-branch-menu-trigger"
            />
        ) : null;

        return (
            <>
                {stashCount > 0 && props.onOpenStashDetails ? (
                    <Pressable
                        testID="scm-stash-summary-row"
                        accessibilityRole="button"
                        accessibilityLabel={t('files.stash.summaryA11y')}
                        onPress={props.onOpenStashDetails}
                        style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: props.theme.colors.border.default,
                            backgroundColor: props.theme.colors.surface.base,
                            opacity: pressed ? 0.85 : 1,
                        })}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                            <Octicons name="archive" size={14} color={props.theme.colors.text.secondary} />
                            <Text
                                numberOfLines={1}
                                style={{ fontSize: 12, color: props.theme.colors.text.primary, ...Typography.default('semiBold') }}
                            >
                                {t('files.stash.summaryTitle')}
                            </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.mono('semiBold') }}>
                                {String(stashCount)}
                            </Text>
                            <Octicons name="chevron-right" size={14} color={props.theme.colors.text.secondary} />
                        </View>
                    </Pressable>
                ) : null}
                {props.showBranchSummary !== false && props.scmStatusFiles ? (
                    <SourceControlBranchSummary
                        theme={props.theme}
                        scmStatusFiles={props.scmStatusFiles}
                        variant="rail"
                        branchTrigger={branchTrigger}
                    />
                ) : null}
                <View
                    style={{
                        paddingHorizontal: 12,
                        paddingTop: 10,
                        paddingBottom: 8,
                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderBottomColor: props.theme.colors.border.default,
                        backgroundColor: props.theme.colors.surface.inset,
                    }}
                >
                    <View
                        testID="session-rightpanel-git-scope-actions-row"
                        style={{
                            flexDirection: 'row',
                            alignItems: hasChangedFilesViewSelector ? 'flex-start' : 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                        }}
                    >
                        <View style={{ flex: 1, minWidth: 0, justifyContent: hasChangedFilesViewSelector ? 'flex-start' : 'center' }}>
                            {hasChangedFilesViewSelector ? (
                                <ChangedFilesViewModeMenu
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
                                    triggerLabelColor={props.theme.colors.text.primary}
                                    triggerStyle={{ alignSelf: 'flex-start', maxWidth: '100%' }}
                                    popoverAnchorAlign="start"
                                />
                            ) : (
                                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                                    <Text style={{ fontSize: 12, color: props.theme.colors.text.primary, ...Typography.default('semiBold') }}>
                                        {t('files.toolbar.changedFiles')}
                                    </Text>
                                    <Text style={{ fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.mono('semiBold') }}>
                                        {String(repositoryChangedFiles.length)}
                                    </Text>
                                </View>
                            )}
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: hasChangedFilesViewSelector ? 'flex-start' : 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {props.onOpenReviewAllChanges ? (
                                <Pressable
                                    testID="session-rightpanel-git-open-review"
                                    accessibilityRole="button"
                                    accessibilityLabel={t('files.toolbar.review')}
                                    onPress={props.onOpenReviewAllChanges}
                                    style={({ pressed }) => ({
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        paddingHorizontal: 10,
                                        height: 30,
                                        borderRadius: 10,
                                        borderWidth: 1,
                                        borderColor: props.theme.colors.border.default,
                                        backgroundColor: props.theme.colors.surface.base,
                                        opacity: pressed ? 0.78 : 1,
                                        gap: 6,
                                    })}
                                >
                                    <Octicons name="diff" size={14} color={props.theme.colors.text.secondary} />
                                    <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                                        {t('files.toolbar.review')}
                                    </Text>
                                </Pressable>
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
                                        color: props.theme.colors.text.secondary,
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
        repositoryChangedFiles.length,
        hasChangedFilesViewSelector,
        stashCount,
        props.onOpenStashDetails,
        props.onOpenReviewAllChanges,
        props.changedFilesViewMode,
        props.onChangedFilesViewMode,
        props.scmStatusFiles,
        props.scmSnapshot,
        props.scmWriteEnabled,
        props.hasGlobalOperationInFlight,
        props.inFlightScmOperation,
        props.scmOperationBusy,
        props.sessionId,
        props.showSessionViewToggle,
        showSelectedViewToggle,
        props.showTurnAgentReportedViewToggle,
        props.showTurnCheckpointViewToggle,
        props.showTurnViewToggle,
        props.theme,
        scopedChangedFilesDescriptions,
        scopedChangedFilesTitle,
    ]);

    const renderVirtualizedRow = React.useCallback(({ item: file, index }: { item: ScmFileStatus; index: number }) => {
        return (
            <ScmChangeRow
                theme={props.theme}
                file={file}
                density="compact"
                leadingElement={props.renderFileActions ? props.renderFileActions(file) : null}
                trailingElement={props.renderFileTrailingActions ? props.renderFileTrailingActions(file) : null}
                onPress={() => props.onFilePress(file)}
                onPressPinned={() => props.onFilePressPinned(file)}
                onToggleSelection={props.onToggleSelectionForFile ? () => props.onToggleSelectionForFile(file) : undefined}
                statsColumnWidth={virtualizedStatsColumnWidth}
                showDivider={index < virtualizedChangedFiles.length - 1}
            />
        );
    }, [
        props.onFilePress,
        props.onFilePressPinned,
        props.onToggleSelectionForFile,
        props.renderFileActions,
        props.renderFileTrailingActions,
        props.theme,
        virtualizedStatsColumnWidth,
        virtualizedChangedFiles.length,
    ]);

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            {repositoryMode || selectedMode ? (
                <FlatList
                    data={virtualizedChangedFiles}
                    keyExtractor={(file) => `${selectedMode ? 'selected' : 'repo-all'}-${file.fullPath}`}
                    ListHeaderComponent={headerContent}
                    contentContainerStyle={{ paddingBottom: 12 }}
                    renderItem={renderVirtualizedRow}
                    initialNumToRender={Math.min(24, virtualizedChangedFiles.length)}
                    maxToRenderPerBatch={24}
                    windowSize={7}
                    removeClippedSubviews={Platform.OS !== 'web'}
                    onLayout={scrollFades.onViewportLayout}
                    onContentSizeChange={scrollFades.onContentSizeChange}
                    onScroll={scrollFades.onScroll}
                    scrollEventThrottle={16}
                    getItemLayout={
                        Platform.OS === 'web'
                            ? (_, index) => {
                                // ScmChangeRow in compact density is effectively fixed-height on web.
                                // Providing a layout hint improves RN-web VirtualizedList performance with large diffs.
                                const length = 38;
                                return { length, offset: length * index, index };
                            }
                            : undefined
                    }
                />
            ) : (
                <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={{ paddingBottom: 12 }}
                    onLayout={scrollFades.onViewportLayout}
                    onContentSizeChange={scrollFades.onContentSizeChange}
                    onScroll={scrollFades.onScroll}
                    scrollEventThrottle={16}
                >
                    {headerContent}
                    <ChangedFilesList
                        theme={props.theme}
                        changedFilesViewMode={props.changedFilesViewMode}
                        attributionReliability={props.attributionReliability}
                        allRepositoryChangedFiles={props.allRepositoryChangedFiles}
                        turnAttributedFiles={props.turnAttributedFiles}
                        turnAgentReportedFiles={props.turnAgentReportedFiles}
                        turnCheckpointFiles={props.turnCheckpointFiles}
                        turnCheckpointMetadata={props.turnCheckpointMetadata}
                        turnRepositoryOnlyFiles={props.turnRepositoryOnlyFiles}
                        sessionAttributedFiles={props.sessionAttributedFiles}
                        repositoryOnlyFiles={props.repositoryOnlyFiles}
                        suppressedInferredCount={props.suppressedInferredCount}
                        onFilePress={(file) => props.onFilePress(file)}
                        onFilePressPinned={(file) => props.onFilePressPinned(file)}
                        onToggleSelectionForFile={props.onToggleSelectionForFile}
                        renderFileActions={props.renderFileActions}
                        renderFileTrailingActions={props.renderFileTrailingActions}
                        rowDensity="compact"
                        showSectionHeader={!hasChangedFilesViewSelector}
                    />
                </ScrollView>
            )}

            <ScrollEdgeFades
                color={props.theme.colors.surface.base}
                size={18}
                edges={scrollFades.visibility}
            />
            <ScrollEdgeIndicators
                edges={scrollFades.visibility}
                color={props.theme.colors.text.secondary}
                size={14}
                opacity={0.35}
            />
        </View>
    );
});
