import * as React from 'react';
import { computeExpandedPathsForReveal } from '@/components/workspaces/files/repositoryTree/computeExpandedPathsForReveal';
import { SessionRightPanelGitCommitTab } from '@/components/sessions/panes/git/SessionRightPanelGitCommitTab';
import { ScmCommitSelectionToggleButton } from '@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton';
import { ScmChangeOverflowMenu } from '@/components/workspaces/scm/changes/ScmChangeOverflowMenu';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { applyFileDiscardAction } from '@/scm/operations/applyFileDiscardAction';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { filterDirectoryLikeScmFileStatuses, isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import {
    getPreferredChangedFilesViewMode,
    resolveChangedFilesViewMode,
    type ChangedFilesViewMode,
} from '@/scm/scmAttribution';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';
import type { ScmProjectInFlightOperation, ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import { useSessionRightPanelGitCommitSelection } from './useSessionRightPanelGitCommitSelection';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';

export type SessionRightPanelGitCommitTabContentProps = Readonly<{
    theme: any;
    sessionId: string;
    sessionPath: string | null;
    scmSnapshot: ScmWorkingSnapshot;
    touchedPaths: string[];
    operationLog: readonly ScmProjectOperationLogEntry[];
    projectSessionIds: string[];
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
    onCommitFromMessage: (message: string) => void;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    commitAdjacentPushAction?: React.ComponentProps<typeof SessionRightPanelGitCommitTab>['commitAdjacentPushAction'];
    showBranchSummary?: boolean;
    onOpenFilesSidebar: () => void;
    onOpenReviewAllChanges: () => void;
    onOpenStashDetails: () => void;
    openFileInDetails: (fullPath: string) => void;
    openFileInDetailsPinned: (fullPath: string) => void;
}>;

export const SessionRightPanelGitCommitTabContent = React.memo((props: SessionRightPanelGitCommitTabContentProps) => {
    const copyFeedback = useTemporaryCopyFeedback();
    const commitSelectionUiEnabled = props.commitSelectionUiEnabled === true;
    const { latestTurnChangeSet, latestTurnScopedChangeSet, sessionChangeSet } = useDerivedSessionChangeSet(props.sessionId);

    const [requestedChangedFilesViewMode, setRequestedChangedFilesViewMode] = React.useState<ChangedFilesViewMode | null>(null);

    const changed = useChangedFilesData({
        sessionId: props.sessionId,
        scmSnapshot: props.scmSnapshot,
        touchedPaths: props.touchedPaths,
        operationLog: props.operationLog,
        projectSessionIds: props.projectSessionIds,
        searchQuery: '',
        showAllRepositoryFiles: false,
        latestTurnChangeSet: latestTurnScopedChangeSet,
        latestTurnEvidence: latestTurnChangeSet,
        sessionChangeSet,
    });

    const visibleRepositoryChangedFiles = React.useMemo(
        () => filterDirectoryLikeScmFileStatuses(changed.allRepositoryChangedFiles),
        [changed.allRepositoryChangedFiles],
    );
    const turnAgentReportedFiles = changed.turnAgentReportedFiles ?? [];
    const turnCheckpointFiles = changed.turnCheckpointFiles ?? [];
    const visibleTurnAttributedFiles = React.useMemo(
        () => changed.turnAttributedFiles.filter((entry) => !isDirectoryLikeScmFileStatus(entry.file)),
        [changed.turnAttributedFiles],
    );
    const visibleTurnAgentReportedFiles = React.useMemo(
        () => turnAgentReportedFiles.filter((entry) => !isDirectoryLikeScmFileStatus(entry.file)),
        [turnAgentReportedFiles],
    );
    const visibleTurnCheckpointFiles = React.useMemo(
        () => turnCheckpointFiles.filter((entry) => !isDirectoryLikeScmFileStatus(entry.file)),
        [turnCheckpointFiles],
    );
    const visibleSessionAttributedFiles = React.useMemo(
        () => changed.sessionAttributedFiles.filter((entry) => !isDirectoryLikeScmFileStatus(entry.file)),
        [changed.sessionAttributedFiles],
    );

    const {
        repositorySelectedCount,
        isSelectedForCommit,
        toggleCommitSelectionForFile,
        bulkSelectAll,
        bulkSelectFiles,
        bulkSelectNone,
        disableSelectAll,
        disableSelectNone,
    } = useSessionRightPanelGitCommitSelection({
        sessionId: props.sessionId,
        sessionPath: props.sessionPath,
        scmSnapshot: props.scmSnapshot,
        scmWriteEnabled: props.scmWriteEnabled,
        scmCommitStrategy: props.scmCommitStrategy,
        commitSelectionPaths: props.commitSelectionPaths,
        commitSelectionPatches: props.commitSelectionPatches,
        changedFiles: visibleRepositoryChangedFiles,
    });

    const [selectionModeUserOn, setSelectionModeUserOn] = React.useState(false);
    // Selection mode is an explicit opt-in: rows stay free of the per-file "+" until the
    // user taps "Select files to commit". A non-empty selection always forces it on so a
    // pending selection can never be silently hidden.
    const selectionModeActive = commitSelectionUiEnabled && (selectionModeUserOn || repositorySelectedCount > 0);
    const enterSelectionMode = React.useCallback(() => setSelectionModeUserOn(true), []);
    const exitSelectionMode = React.useCallback(() => setSelectionModeUserOn(false), []);

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
        return getPreferredChangedFilesViewMode(changedFilesAvailability);
    }, [
        changedFilesAvailability,
        requestedChangedFilesViewMode,
    ]);

    const currentScopeChangedFiles = React.useMemo<readonly ScmFileStatus[]>(() => {
        if (scopedChangedFilesViewMode === 'selected') return selectedRepositoryChangedFiles;
        if (scopedChangedFilesViewMode === 'turn') {
            return visibleTurnAttributedFiles.map((entry) => entry.file);
        }
        if (scopedChangedFilesViewMode === 'turn_agent_reported') {
            return visibleTurnAgentReportedFiles.map((entry) => entry.file);
        }
        if (scopedChangedFilesViewMode === 'turn_checkpoint') {
            return visibleTurnCheckpointFiles.map((entry) => entry.file);
        }
        if (scopedChangedFilesViewMode === 'session') {
            return visibleSessionAttributedFiles.map((entry) => entry.file);
        }
        return visibleRepositoryChangedFiles;
    }, [
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
    const noopFile = React.useCallback((_file: ScmFileStatus) => {}, []);

    const revealInTree = React.useCallback((fullPath: string) => {
        props.onOpenFilesSidebar();
        const sessionExpandedPaths = storage.getState().getSessionRepositoryTreeExpandedPaths(props.sessionId);
        const revealExpandedPaths = computeExpandedPathsForReveal({
            expandedPaths: sessionExpandedPaths,
            fullPath,
        });
        storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, revealExpandedPaths);
    }, [props.onOpenFilesSidebar, props.sessionId]);

    const renderTrailingActions = React.useCallback((file: ScmFileStatus) => {
        const discardEnabled = props.scmWriteEnabled && props.scmSnapshot?.capabilities?.writeDiscard === true;
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
                            sessionId: props.sessionId,
                            sessionPath: props.sessionPath,
                            file,
                            snapshot: props.scmSnapshot,
                            scmWriteEnabled: props.scmWriteEnabled,
                            commitStrategy: props.scmCommitStrategy,
                            surface: 'files',
                        }), { tag: 'SessionRightPanelGitCommitTab.discard' });
                    } : undefined}
                />
            </>
        );
    }, [copyFeedback, props.scmCommitStrategy, props.scmSnapshot, props.scmWriteEnabled, props.sessionId, props.sessionPath, revealInTree]);

    const renderFileActions = React.useCallback((file: ScmFileStatus) => {
        if (!selectionModeActive || !props.scmWriteEnabled) return null;
        return (
            <ScmCommitSelectionToggleButton
                sessionId={props.sessionId}
                sessionPath={props.sessionPath}
                snapshot={props.scmSnapshot}
                scmWriteEnabled={props.scmWriteEnabled}
                commitStrategy={props.scmCommitStrategy}
                file={file}
                selectedForCommit={isSelectedForCommit(file)}
                surface="files"
            />
        );
    }, [
        selectionModeActive,
        isSelectedForCommit,
        props.scmCommitStrategy,
        props.scmSnapshot,
        props.scmWriteEnabled,
        props.sessionId,
        props.sessionPath,
    ]);

    const onFilePress = React.useCallback((file: ScmFileStatus) => {
        props.openFileInDetails(file.fullPath);
    }, [props.openFileInDetails]);

    const onFilePressPinned = React.useCallback((file: ScmFileStatus) => {
        props.openFileInDetailsPinned(file.fullPath);
    }, [props.openFileInDetailsPinned]);

    return (
        <SessionRightPanelGitCommitTab
            theme={props.theme}
            sessionId={props.sessionId}
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
            commitAllowed={props.commitAllowedForComposer}
            commitBlockedMessage={props.commitBlockedMessageForComposer}
            changedFilesViewMode={scopedChangedFilesViewMode}
            attributionReliability={changed.attributionReliability}
            allRepositoryChangedFiles={changed.allRepositoryChangedFiles}
            selectedRepositoryChangedFiles={selectedRepositoryChangedFiles}
            turnAttributedFiles={changed.turnAttributedFiles}
            turnAgentReportedFiles={changed.turnAgentReportedFiles}
            turnCheckpointFiles={changed.turnCheckpointFiles}
            turnCheckpointMetadata={changed.turnCheckpointMetadata}
            turnRepositoryOnlyFiles={changed.turnRepositoryOnlyFiles}
            sessionAttributedFiles={changed.sessionAttributedFiles}
            repositoryOnlyFiles={changed.repositoryOnlyFiles}
            suppressedInferredCount={changed.suppressedInferredCount}
            showTurnViewToggle={changed.showTurnViewToggle}
            showTurnAgentReportedViewToggle={changed.showTurnAgentReportedViewToggle}
            showTurnCheckpointViewToggle={changed.showTurnCheckpointViewToggle}
            showSessionViewToggle={changed.showSessionViewToggle}
            showSelectedViewToggle={showSelectedViewToggle}
            onChangedFilesViewMode={setRequestedChangedFilesViewMode}
            repositorySelectedCount={repositorySelectedCount}
            onSelectAll={commitSelectionUiEnabled ? bulkSelectCurrentScope : noop}
            onSelectNone={commitSelectionUiEnabled ? bulkSelectNone : noop}
            disableSelectAll={commitSelectionUiEnabled ? disableSelectAll || currentScopeChangedFiles.length === 0 : true}
            disableSelectNone={commitSelectionUiEnabled ? disableSelectNone : true}
            onFilePress={onFilePress}
            onFilePressPinned={onFilePressPinned}
            onToggleSelectionForFile={commitSelectionUiEnabled ? toggleCommitSelectionForFile : noopFile}
            renderFileActions={renderFileActions}
            renderFileTrailingActions={renderTrailingActions}
            commitDraftMessage={props.commitDraftMessage}
            onCommitDraftMessageChange={props.onCommitDraftMessageChange}
            onCommitFromMessage={props.onCommitFromMessage}
            commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
            onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
            commitAdjacentPushAction={props.commitAdjacentPushAction}
            onClearSelection={commitSelectionUiEnabled && repositorySelectedCount > 0 ? bulkSelectNone : undefined}
            commitSelectionAvailable={commitSelectionUiEnabled}
            selectionModeActive={selectionModeActive}
            onEnterSelectionMode={enterSelectionMode}
            onExitSelectionMode={exitSelectionMode}
            scmStatusFiles={changed.scmStatusFiles}
            showBranchSummary={props.showBranchSummary}
            showCommitComposer={props.commitWriteEnabled}
            onOpenReviewAllChanges={props.onOpenReviewAllChanges}
            onOpenStashDetails={props.onOpenStashDetails}
        />
    );
});
