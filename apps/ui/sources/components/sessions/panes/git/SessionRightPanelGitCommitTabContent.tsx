import * as React from 'react';
import { View } from 'react-native';
import { computeExpandedPathsForReveal } from '@/components/sessions/files/repositoryTree/computeExpandedPathsForReveal';
import { SessionRightPanelGitCommitTab } from '@/components/sessions/panes/git/SessionRightPanelGitCommitTab';
import { ScmCommitSelectionToggleButton } from '@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton';
import { ScmChangeDiscardButton } from '@/components/sessions/sourceControl/changes/ScmChangeDiscardButton';
import { ScmChangeOverflowMenu } from '@/components/sessions/sourceControl/changes/ScmChangeOverflowMenu';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { getDefaultChangedFilesViewMode } from '@/scm/scmAttribution';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';
import type { ScmProjectInFlightOperation, ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
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
    onOpenFilesSidebar: () => void;
    onOpenReviewAllChanges: () => void;
    openFileInDetails: (fullPath: string) => void;
    openFileInDetailsPinned: (fullPath: string) => void;
}>;

export const SessionRightPanelGitCommitTabContent = React.memo((props: SessionRightPanelGitCommitTabContentProps) => {
    const commitSelectionUiEnabled = props.commitSelectionUiEnabled === true;

    const changedFilesViewMode = React.useMemo(() => getDefaultChangedFilesViewMode(), []);

    const changed = useChangedFilesData({
        sessionId: props.sessionId,
        scmSnapshot: props.scmSnapshot,
        touchedPaths: props.touchedPaths,
        operationLog: props.operationLog,
        projectSessionIds: props.projectSessionIds,
        searchQuery: '',
        showAllRepositoryFiles: false,
        // The sidebar commit surface defaults to repository-only. Skip attribution work unless we
        // actually need to render the session-attribution view (keeps initial open snappy on large repos).
        computeAttribution: changedFilesViewMode !== 'repository',
    });

    const {
        repositorySelectedCount,
        isSelectedForCommit,
        toggleCommitSelectionForFile,
        bulkSelectAll,
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
        changedFiles: changed.allRepositoryChangedFiles,
    });

    const renderCommitSelectionAction = React.useCallback((file: ScmFileStatus) => {
        const selectedForCommit = isSelectedForCommit(file);
        return (
            <ScmCommitSelectionToggleButton
                sessionId={props.sessionId}
                sessionPath={props.sessionPath}
                snapshot={props.scmSnapshot}
                scmWriteEnabled={props.scmWriteEnabled}
                commitStrategy={props.scmCommitStrategy}
                file={file}
                selectedForCommit={selectedForCommit}
                surface="files"
            />
        );
    }, [isSelectedForCommit, props.scmCommitStrategy, props.scmSnapshot, props.scmWriteEnabled, props.sessionId, props.sessionPath]);

    const noop = React.useCallback(() => {}, []);
    const noopFile = React.useCallback((_file: ScmFileStatus) => {}, []);
    const renderNull = React.useCallback((_file: ScmFileStatus) => null, []);

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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                {discardEnabled ? (
                    <ScmChangeDiscardButton
                        sessionId={props.sessionId}
                        sessionPath={props.sessionPath}
                        snapshot={props.scmSnapshot}
                        scmWriteEnabled={props.scmWriteEnabled}
                        commitStrategy={props.scmCommitStrategy}
                        file={file}
                        surface="files"
                    />
                ) : null}
                <ScmChangeOverflowMenu
                    title={file.fileName}
                    filePath={file.fullPath}
                    onRevealInTree={() => {
                        revealInTree(file.fullPath);
                    }}
                />
            </View>
        );
    }, [props.scmCommitStrategy, props.scmSnapshot, props.scmWriteEnabled, props.sessionId, props.sessionPath, revealInTree]);

    return (
        <SessionRightPanelGitCommitTab
            theme={props.theme}
            sessionId={props.sessionId}
            sessionPath={props.sessionPath}
            backendLabel={props.backendLabel}
            commitActionLabel={props.commitActionLabel}
            scmSnapshot={props.scmSnapshot}
            hasConflicts={props.hasConflicts}
            scmOperationBusy={props.scmOperationBusy}
            scmOperationStatus={props.scmOperationStatus}
            hasGlobalOperationInFlight={props.hasGlobalOperationInFlight}
            inFlightScmOperation={props.inFlightScmOperation}
            commitAllowed={props.commitAllowedForComposer}
            commitBlockedMessage={props.commitBlockedMessageForComposer}
            changedFilesViewMode={changedFilesViewMode}
            attributionReliability={changed.attributionReliability}
            allRepositoryChangedFiles={changed.allRepositoryChangedFiles}
            sessionAttributedFiles={changed.sessionAttributedFiles}
            repositoryOnlyFiles={changed.repositoryOnlyFiles}
            suppressedInferredCount={changed.suppressedInferredCount}
            repositorySelectedCount={repositorySelectedCount}
            onSelectAll={commitSelectionUiEnabled ? bulkSelectAll : noop}
            onSelectNone={commitSelectionUiEnabled ? bulkSelectNone : noop}
            disableSelectAll={commitSelectionUiEnabled ? disableSelectAll : true}
            disableSelectNone={commitSelectionUiEnabled ? disableSelectNone : true}
            onFilePress={(file) => props.openFileInDetails(file.fullPath)}
            onFilePressPinned={(file) => props.openFileInDetailsPinned(file.fullPath)}
            onToggleSelectionForFile={commitSelectionUiEnabled ? toggleCommitSelectionForFile : noopFile}
            renderFileActions={commitSelectionUiEnabled ? renderCommitSelectionAction : renderNull}
            renderFileTrailingActions={renderTrailingActions}
            commitDraftMessage={props.commitDraftMessage}
            onCommitDraftMessageChange={props.onCommitDraftMessageChange}
            onCommitFromMessage={props.onCommitFromMessage}
            commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
            onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
            onClearSelection={commitSelectionUiEnabled && repositorySelectedCount > 0 ? bulkSelectNone : undefined}
            scmStatusFiles={changed.scmStatusFiles}
            showCommitComposer={props.commitWriteEnabled}
            onOpenReviewAllChanges={props.onOpenReviewAllChanges}
        />
    );
});
