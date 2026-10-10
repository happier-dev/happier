import { activeReviewFileKeyForSession, openChangedFileFromList } from '@/components/workspaces/scm/review/activeReviewFile';
import * as React from 'react';
import { SessionRightPanelGitCommitTab } from '@/components/sessions/panes/git/SessionRightPanelGitCommitTab';
import { ScmCommitSelectionToggleButton, ScmCommitSelectionCheckGlyph } from '@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton';
import { ScmChangeOverflowMenu } from '@/components/workspaces/scm/changes/ScmChangeOverflowMenu';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { applyFileDiscardAction } from '@/scm/operations/applyFileDiscardAction';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { filterDirectoryLikeScmFileStatuses } from '@/scm/isDirectoryLikeScmFileStatus';
import {
    filterPresentableSessionAttributedFiles,
    getDefaultChangedFilesViewMode,
    resolveChangedFilesViewMode,
    type ChangedFilesViewMode,
} from '@/scm/scmAttribution';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionRightPanelGitCommitSelection } from './useSessionRightPanelGitCommitSelection';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { useSessionCommitPlan } from '@/components/sessions/files/commits/useSessionCommitPlan';
import { reconcileScmCommitPlanGroupSelection, selectScmCommitPlanGroupIntent, type ScmCommitPlanGroupSelection } from '@/sync/domains/scm/diffSummary/commitPlanSelection';
import { View } from 'react-native';
import { t } from '@/text';
import { GitProposedCommitsCard } from './GitProposedCommitsCard';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { GitProposalHighlight } from './SessionRightPanelGitCommitTab';

export type SessionRightPanelGitCommitTabContentProps = Readonly<{
    theme: any;
    sessionId: string;
    serverId?: string;
    sessionPath: string | null;
    scmSnapshot: ScmWorkingSnapshot;
    workspaceTouchedPaths: string[];


    commitSelectionPaths: readonly string[];
    commitSelectionPatches: readonly ScmCommitSelectionPatch[];
    scmCommitStrategy: ScmCommitStrategy;
    scmWriteEnabled: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    hasGlobalOperationInFlight: boolean;
    scmOperationBusy: boolean;
    scmOperationStatus: string | null;
    backendLabel: string;
    commitActionLabel: string;
    hasConflicts: boolean;
    commitAllowedForComposer: boolean;
    commitBlockedMessageForComposer: string | null;
    commitWriteEnabled: boolean;
    commitSelectionUiEnabled: boolean;
    commitDraftMessage: string;
    onCommitDraftMessageChange: (value: string) => void;
    /** Resolves with the commit's outcome, so a landed commit can fold into its line (lab GC). */
    onCommitFromMessage: (message: string) => Promise<Readonly<{ ok: boolean; commitSha?: string | null }>> | undefined;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    onCancelCommitMessageSuggestion?: () => Promise<unknown>;
    suggestionContextKey?: string;
    /** The Changes view is the one showing (its sub-tab is active); leaving it retires a fold line. */
    active?: boolean;
    onOpenFilesSidebar: (revealPath?: string) => void;
    onOpenReviewAllChanges: () => void;
    /** Opens the Commits view of pending changes, at a proposed commit when one is named. */
    onOpenCommitPlan?: (groupId?: string) => void;
    /** Opens the Walkthrough of pending changes (the proposal's Review in walkthrough). */
    onOpenWalkthrough?: () => void;
    /** Phones draw the proposal as the pane's bottom bar (lab WT4-C2p). */
    phone?: boolean;
    agentId?: React.ComponentProps<typeof SessionRightPanelGitCommitTab>['agentId'];
    completedOperationId?: string | null;
    onOpenStashDetails: () => void;
    openFileInDetails: (fullPath: string) => void;
    openFileInDetailsPinned: (fullPath: string) => void;
    /** The Unified layout's timeline, under the changes in one scroll. */
    listFooter?: React.ReactElement | null;
    /** The finished state when nothing is left to commit. */
    emptyState?: React.ReactElement | null;
    scopeAccessory?: React.ReactNode;
    changesLayout?: 'list' | 'tree';
    machineId?: string | null;
}>;

export const SessionRightPanelGitCommitTabContent = React.memo((props: SessionRightPanelGitCommitTabContentProps) => {
    const copyFeedback = useTemporaryCopyFeedback();
    const commitSelectionUiEnabled = props.commitSelectionUiEnabled === true;
    const branch = props.scmSnapshot?.branch?.detached ? null : props.scmSnapshot?.branch?.head ?? null;
    const commitPlan = useSessionCommitPlan({ sessionId: props.sessionId, serverId: props.serverId, enabled: props.active !== false, branch });
    const analysis = commitPlan.binding.viewModel;
    const plan = analysis?.outputs?.commitPlan?.value;
    const proposal = React.useMemo(() => analysis?.resultId && analysis.comparison && plan
        ? { resultId: analysis.resultId, comparison: analysis.comparison, plan } : null,
    [analysis?.resultId, analysis?.comparison, plan]);
    // A finished run gives the commit card back; until then the proposal stands in its place (lab WT4-C2).
    const proposalShown = commitPlan.proposal && commitPlan.proposal.outcome?.kind !== 'complete' ? commitPlan.proposal : null;
    const [storedProposedSelection, setProposedSelection] = React.useState<ScmCommitPlanGroupSelection | null>(null);
    const selectedProposedGroup = proposal ? reconcileScmCommitPlanGroupSelection(storedProposedSelection, proposal) : null;
    React.useEffect(() => {
        if (props.active !== false && storedProposedSelection && !selectedProposedGroup) setProposedSelection(null);
    }, [props.active, storedProposedSelection, selectedProposedGroup]);
    const selectProposedGroup = React.useCallback((groupId: string) => {
        if (!proposal) return;
        const intent = selectScmCommitPlanGroupIntent(selectedProposedGroup, { ...proposal, groupId });
        if (intent.kind === 'open') props.onOpenCommitPlan?.(groupId);
        else if (intent.kind === 'select') setProposedSelection(intent.selection);
    }, [proposal, selectedProposedGroup, props.onOpenCommitPlan]);
    // The selected commit's exact changes light up in the list; a split file says which part belongs.
    const proposalHighlight = React.useMemo<GitProposalHighlight | null>(() => {
        const group = selectedProposedGroup ? commitPlan.proposal?.groups.find((candidate) => candidate.id === selectedProposedGroup.groupId) : null;
        if (!group) return null;
        return {
            paths: new Set(group.changes.map((change) => change.path)),
            notes: new Map(group.changes.flatMap((change) => change.part ? [[change.path, t('commitProposal.part', change.part)] as const] : [])),
            groupNumber: group.number,
        };
    }, [commitPlan.proposal, selectedProposedGroup]);
    const sessionAddress = React.useMemo(
        () => normalizeSessionAddress(props.serverId, props.sessionId),
        [props.serverId, props.sessionId],
    );
    const { latestTurnId, latestTurnChangeSet, latestTurnScopedChangeSet, sessionChangeSet } = useDerivedSessionChangeSet(sessionAddress, props.scmSnapshot?.repo.rootPath);

    const [requestedChangedFilesViewMode, setRequestedChangedFilesViewMode] = React.useState<ChangedFilesViewMode | null>(null);

    const changed = useChangedFilesData({
        sessionId: props.sessionId,
        scmSnapshot: props.scmSnapshot,
        workspaceTouchedPaths: props.workspaceTouchedPaths,


        searchQuery: '',
        showAllRepositoryFiles: false,
        latestTurnId,
        latestTurnChangeSet: latestTurnScopedChangeSet,
        latestTurnEvidence: latestTurnChangeSet,
        sessionChangeSet,
    });

    const visibleRepositoryChangedFiles = React.useMemo(
        () => filterDirectoryLikeScmFileStatuses(changed.allRepositoryChangedFiles),
        [changed.allRepositoryChangedFiles],
    );
    const currentRepositoryFileByPath = React.useMemo(
        () => new Map(visibleRepositoryChangedFiles.map((file) => [file.fullPath, file])),
        [visibleRepositoryChangedFiles],
    );
    const turnAgentReportedFiles = changed.turnAgentReportedFiles ?? [];
    const turnCheckpointFiles = changed.turnCheckpointFiles ?? [];
    const visibleTurnAttributedFiles = React.useMemo(
        () => filterPresentableSessionAttributedFiles(changed.turnAttributedFiles),
        [changed.turnAttributedFiles],
    );
    const visibleTurnAgentReportedFiles = React.useMemo(
        () => filterPresentableSessionAttributedFiles(turnAgentReportedFiles),
        [turnAgentReportedFiles],
    );
    const visibleTurnCheckpointFiles = React.useMemo(
        () => filterPresentableSessionAttributedFiles(turnCheckpointFiles),
        [turnCheckpointFiles],
    );
    const visibleSessionAttributedFiles = React.useMemo(
        () => filterPresentableSessionAttributedFiles(changed.sessionAttributedFiles),
        [changed.sessionAttributedFiles],
    );

    const {
        repositorySelectedCount,
        isSelectedForCommit,
        toggleCommitSelectionForFile,
        bulkSelectAll,
        bulkSelectFiles,
        bulkDeselectFiles,
        bulkSelectNone,
        disableSelectAll,
        disableSelectNone,
    } = useSessionRightPanelGitCommitSelection({
        sessionId: props.sessionId, serverId: props.serverId,
        sessionPath: props.sessionPath,
        scmSnapshot: props.scmSnapshot,
        scmWriteEnabled: props.scmWriteEnabled,
        scmCommitStrategy: props.scmCommitStrategy,
        commitSelectionPaths: props.commitSelectionPaths,
        commitSelectionPatches: props.commitSelectionPatches,
        changedFiles: visibleRepositoryChangedFiles,
        proposedGroupSelection: selectedProposedGroup,
    });

    // Lab G1: the checkbox column is part of every row whenever commit selection is available —
    // the name-first row has room for it, and the commit card sums what is checked.
    const selectionModeActive = commitSelectionUiEnabled && !selectedProposedGroup;

    const selectedRepositoryChangedFiles = React.useMemo(() => {
        return visibleRepositoryChangedFiles.filter((file) => isSelectedForCommit(file));
    }, [isSelectedForCommit, visibleRepositoryChangedFiles]);

    const showSelectedViewToggle = selectedRepositoryChangedFiles.length > 0;


    const changedFilesAvailability = React.useMemo(() => ({
        showTurnViewToggle: changed.showTurnViewToggle,
        showTurnAgentReportedViewToggle: changed.showTurnAgentReportedViewToggle,
        showTurnCheckpointViewToggle: changed.showTurnCheckpointViewToggle,
        showSessionViewToggle: changed.showSessionViewToggle,
        showSelectedViewToggle,
    }), [
        changed.showSessionViewToggle,
        changed.showTurnAgentReportedViewToggle,
        changed.showTurnCheckpointViewToggle,
        changed.showTurnViewToggle,
        showSelectedViewToggle,
    ]);

    const scopedChangedFilesViewMode = React.useMemo(() => {
        if (requestedChangedFilesViewMode) {
            return resolveChangedFilesViewMode({
                mode: requestedChangedFilesViewMode,
                ...changedFilesAvailability,
            });
        }
        // Lab G1: the pane opens on All changes, grouped with this session's changes first; the scoped
        // views (latest turn, this session, …) stay one choice away in the scope menu.
        return getDefaultChangedFilesViewMode();
    }, [
        changedFilesAvailability,
        requestedChangedFilesViewMode,
    ]);

    const currentScopeChangedFiles = React.useMemo<readonly ScmFileStatus[]>(() => {
        if (scopedChangedFilesViewMode === 'selected') return selectedRepositoryChangedFiles;
        const attributedFiles = scopedChangedFilesViewMode === 'turn'
            ? visibleTurnAttributedFiles
            : scopedChangedFilesViewMode === 'turn_agent_reported'
                ? visibleTurnAgentReportedFiles
                : scopedChangedFilesViewMode === 'turn_checkpoint'
                    ? visibleTurnCheckpointFiles
                    : scopedChangedFilesViewMode === 'session'
                        ? visibleSessionAttributedFiles
                        : null;
        if (!attributedFiles) return visibleRepositoryChangedFiles;
        return attributedFiles.flatMap((entry) => {
            const currentFile = currentRepositoryFileByPath.get(entry.file.fullPath);
            return currentFile ? [currentFile] : [];
        });
    }, [
        currentRepositoryFileByPath,
        scopedChangedFilesViewMode,
        selectedRepositoryChangedFiles,
        visibleRepositoryChangedFiles,
        visibleSessionAttributedFiles,
        visibleTurnAgentReportedFiles,
        visibleTurnAttributedFiles,
        visibleTurnCheckpointFiles,
    ]);

    const bulkSelectCurrentScope = React.useCallback(() => {
        if (scopedChangedFilesViewMode === 'repository') {
            bulkSelectAll();
            return;
        }
        bulkSelectFiles(currentScopeChangedFiles);
    }, [bulkSelectAll, bulkSelectFiles, currentScopeChangedFiles, scopedChangedFilesViewMode]);

    const noop = React.useCallback(() => {}, []);
    const toggleGroupSelection = React.useCallback((files: readonly ScmFileStatus[], select: boolean) => {
        if (select) bulkSelectFiles(files);
        else bulkDeselectFiles(files);
    }, [bulkDeselectFiles, bulkSelectFiles]);

    // Git lab C3/SX: a landed commit is said once, by the pane's outcome line, and lands on the timeline as the
    // newest node ("just now"); the list simply loses the committed rows.
    const onCommitFromMessage = React.useCallback((message: string) => {
        if (selectedProposedGroup) { props.onOpenCommitPlan?.(selectedProposedGroup.groupId); return undefined; }
        return props.onCommitFromMessage(message);
    }, [selectedProposedGroup, props.onOpenCommitPlan, props.onCommitFromMessage]);
    const noopFile = React.useCallback((_file: ScmFileStatus) => {}, []);

    const revealInTree = React.useCallback((fullPath: string) => {
        props.onOpenFilesSidebar(fullPath);
    }, [props.onOpenFilesSidebar]);

    const renderTrailingActions = React.useCallback((file: ScmFileStatus) => {
        const currentFile = currentRepositoryFileByPath.get(file.fullPath);
        const discardEnabled = currentFile !== undefined
            && props.scmWriteEnabled
            && props.scmSnapshot?.capabilities?.writeDiscard === true;
        return (
            <>
                <CopiedPill
                    visible={copyFeedback.isCopied(file.fullPath)}
                    testID={`scm-change-copy-feedback:${file.fullPath}`}
                />
                <ScmChangeOverflowMenu
                    title={file.fileName}
                    filePath={file.fullPath}
                    onCopyPathSuccess={() => copyFeedback.markCopied(file.fullPath)}
                    onRevealInTree={() => {
                        revealInTree(file.fullPath);
                    }}
                    onDiscard={discardEnabled ? () => {
                        fireAndForget(applyFileDiscardAction({
                            sessionId: props.sessionId, serverId: props.serverId,
                            sessionPath: props.sessionPath,
                            file: currentFile ?? file,
                            snapshot: props.scmSnapshot,
                            scmWriteEnabled: props.scmWriteEnabled,
                            commitStrategy: props.scmCommitStrategy,
                            surface: 'files',
                        }), { tag: 'SessionRightPanelGitCommitTab.discard' });
                    } : undefined}
                />
            </>
        );
    }, [copyFeedback, currentRepositoryFileByPath, props.scmCommitStrategy, props.scmSnapshot, props.scmWriteEnabled, props.sessionId, props.serverId, props.sessionPath, revealInTree]);

    const renderFileActions = React.useCallback((file: ScmFileStatus) => {
        if (file.status === 'conflicted') return null;
        const currentFile = currentRepositoryFileByPath.get(file.fullPath);
        if (currentFile && selectedProposedGroup) return <ScmCommitSelectionCheckGlyph state={isSelectedForCommit(currentFile) ? 'checked' : 'unchecked'} />;
        if (!currentFile || !selectionModeActive || !props.scmWriteEnabled) return null;
        return (
            <ScmCommitSelectionToggleButton
                sessionId={props.sessionId}
            serverId={props.serverId}
                sessionPath={props.sessionPath}
                snapshot={props.scmSnapshot}
                scmWriteEnabled={props.scmWriteEnabled}
                commitStrategy={props.scmCommitStrategy}
                file={currentFile}
                selectedForCommit={isSelectedForCommit(currentFile)}
                surface="files"
                appearance="checkbox"
            />
        );
    }, [
        currentRepositoryFileByPath,
        selectionModeActive,
        isSelectedForCommit,
        props.scmCommitStrategy,
        props.scmSnapshot,
        props.scmWriteEnabled,
        props.sessionId, props.serverId,
        props.sessionPath,
        selectedProposedGroup,
    ]);

    // With Review on screen a tap brings the file into Review; otherwise it opens the file.
    const activeReviewFileKey = activeReviewFileKeyForSession(props.sessionId, props.serverId);
    const onFilePress = React.useCallback((file: ScmFileStatus) => {
        openChangedFileFromList(activeReviewFileKey, file.fullPath, props.openFileInDetails);
    }, [activeReviewFileKey, props.openFileInDetails]);

    const onFilePressPinned = React.useCallback((file: ScmFileStatus) => {
        props.openFileInDetailsPinned(file.fullPath);
    }, [props.openFileInDetailsPinned]);

    const onOpenCommitPlan = props.onOpenCommitPlan;
    const clearProposedSelection = React.useCallback(() => setProposedSelection(null), []);
    const compactProposal = proposalShown && onOpenCommitPlan ? (
        <GitProposedCommitsCard
            proposal={proposalShown}
            selectedGroupId={selectedProposedGroup?.groupId ?? null}
            onSelectGroup={selectProposedGroup}
            onClearSelection={clearProposedSelection}
            onOpenGroup={onOpenCommitPlan}
            onReview={props.onOpenWalkthrough ?? (() => onOpenCommitPlan())}
            onCreate={commitPlan.actions.onCreate}
            createBusy={commitPlan.busy}
            onDiscard={commitPlan.actions.onDiscard}
            onRegenerate={commitPlan.actions.onRegenerate}
            phone={props.phone === true}
        />
    ) : null;
    return (
        <View style={{ flex: 1 }}>
        <SessionRightPanelGitCommitTab
            theme={props.theme}
            sessionId={props.sessionId}
            serverId={props.serverId}
            sessionPath={props.sessionPath}
            backendLabel={props.backendLabel}
            commitActionLabel={props.commitActionLabel}
            scmSnapshot={props.scmSnapshot}
            scmWriteEnabled={props.scmWriteEnabled}
            hasConflicts={props.hasConflicts}
            scmOperationBusy={props.scmOperationBusy}
            scmOperationStatus={props.scmOperationStatus}
            hasGlobalOperationInFlight={props.hasGlobalOperationInFlight}
            inFlightScmOperation={props.inFlightScmOperation}
            commitAllowed={props.commitAllowedForComposer && !selectedProposedGroup}
            commitBlockedMessage={props.commitBlockedMessageForComposer}
            changedFilesViewMode={scopedChangedFilesViewMode}
            sessionAttribution={changed.sessionAttribution}
            sessionCheckpointOverlap={changed.sessionCheckpointOverlap}

            allRepositoryChangedFiles={changed.allRepositoryChangedFiles}
            selectedRepositoryChangedFiles={selectedRepositoryChangedFiles}
            proposedGroupSelected={Boolean(selectedProposedGroup)}
            proposalHighlight={proposalHighlight}
            turnAttributedFiles={changed.turnAttributedFiles}
            turnAgentReportedFiles={changed.turnAgentReportedFiles}
            turnCheckpointFiles={changed.turnCheckpointFiles}
            turnCheckpointMetadata={changed.turnCheckpointMetadata}
            turnRepositoryOnlyFiles={changed.turnRepositoryOnlyFiles}
            sessionAttributedFiles={changed.sessionAttributedFiles}
            repositoryOnlyFiles={changed.repositoryOnlyFiles}

            showTurnViewToggle={changed.showTurnViewToggle}
            showTurnAgentReportedViewToggle={changed.showTurnAgentReportedViewToggle}
            showTurnCheckpointViewToggle={changed.showTurnCheckpointViewToggle}
            showSessionViewToggle={changed.showSessionViewToggle}
            showSelectedViewToggle={showSelectedViewToggle}
            onChangedFilesViewMode={setRequestedChangedFilesViewMode}
            repositorySelectedCount={repositorySelectedCount}
            onSelectAll={selectionModeActive ? bulkSelectCurrentScope : noop}
            onSelectNone={selectedProposedGroup ? () => setProposedSelection(null) : commitSelectionUiEnabled ? bulkSelectNone : noop}
            disableSelectAll={selectionModeActive ? disableSelectAll || currentScopeChangedFiles.length === 0 : true}
            disableSelectNone={selectedProposedGroup ? false : commitSelectionUiEnabled ? disableSelectNone : true}
            onFilePress={onFilePress}
            onFilePressPinned={onFilePressPinned}
            onToggleSelectionForFile={selectionModeActive ? toggleCommitSelectionForFile : noopFile}
            renderFileActions={renderFileActions}
            renderFileTrailingActions={renderTrailingActions}
            commitDraftMessage={props.commitDraftMessage}
            onCommitDraftMessageChange={props.onCommitDraftMessageChange}
            onCommitFromMessage={onCommitFromMessage}
            commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
            onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
            onCancelCommitMessageSuggestion={props.onCancelCommitMessageSuggestion}
            suggestionContextKey={props.suggestionContextKey}
            onClearSelection={commitSelectionUiEnabled && repositorySelectedCount > 0 ? bulkSelectNone : undefined}
            commitSelectionAvailable={false}
            selectionModeActive={selectionModeActive}
            scmStatusFiles={changed.scmStatusFiles}
            onToggleGroupSelection={selectionModeActive ? toggleGroupSelection : undefined}
            showCommitComposer={props.commitWriteEnabled && !compactProposal}
            onOpenReviewAllChanges={props.onOpenReviewAllChanges}
            onOpenStashDetails={props.onOpenStashDetails}
            listFooter={props.listFooter}
            phone={props.phone}
            agentId={props.agentId}
            completedOperationId={props.completedOperationId}
            emptyState={props.emptyState}
            scopeAccessory={props.scopeAccessory}
            changesLayout={props.changesLayout}
            machineId={props.machineId}
        />
        {compactProposal}
        {!compactProposal && commitPlan.undoDiscard ? (
            <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                <SurfaceStateCard testID="git-proposed-commits-discarded" size="line" kind="success" title={t('commitProposal.discarded')}
                    action={{ label: t('commitProposal.undo'), onPress: commitPlan.undoDiscard }} accessibilitySemantics="status" />
            </View>
        ) : null}
        </View>
    );
});
