import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { SourceControlBranchSummary } from '@/components/sessions/files/SourceControlBranchSummary';
import { SourceControlOperationsPanel } from '@/components/sessions/files/SourceControlOperationsPanel';
import { ChangedFilesList } from '@/components/sessions/files/content/ChangedFilesList';
import { ChangedFilesReview } from '@/components/sessions/files/content/ChangedFilesReview';
import { NotSourceControlRepositoryState, SourceControlSessionInactiveState, SourceControlUnavailableState } from '@/components/sessions/sourceControl/states';
import { SessionRepositoryTreeBrowserView } from '@/components/sessions/files/views/SessionRepositoryTreeBrowserView';

import type { ScmStatusFiles, ScmFileStatus } from '@/scm/scmStatusFiles';
import type {
    ChangedFilesPresentation,
    ChangedFilesViewMode,
    SessionAttributionReliability,
    SessionAttributedFile,
} from '@/scm/scmAttribution';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ProjectScmSnapshotError } from '@/sync/runtime/orchestration/projectManager';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { useScmDiffCacheLimits } from '@/scm/diffCache/useScmDiffCacheLimits';

type Theme = ReturnType<typeof useUnistyles>['theme'];
type OperationLog = React.ComponentProps<typeof SourceControlOperationsPanel>['operationLog'];
type HistoryEntries = React.ComponentProps<typeof SourceControlOperationsPanel>['historyEntries'];
type InFlightOperation = React.ComponentProps<typeof SourceControlOperationsPanel>['inFlightScmOperation'];
type ScmOperationStatus = React.ComponentProps<typeof SourceControlOperationsPanel>['scmOperationStatus'];

export type SessionFilesScreenBodyProps = Readonly<{
    theme: Theme;
    sessionId: string;

    isRefreshing: boolean;
    scmPanelExpanded: boolean;
    showScmOperationsPanel: boolean;

    scmStatusFiles: ScmStatusFiles | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmSnapshotError: ProjectScmSnapshotError | null;
    hasConflicts: boolean;
    hasGlobalOperationInFlight: boolean;
    inFlightScmOperation: InFlightOperation;
    isSessionInactive: boolean;
    machineReachable: boolean;
    machineRpcTargetAvailable: boolean;

    backendLabel: string;
    commitActionLabel: string;

    scmOperationBusy: boolean;
    scmOperationStatus: ScmOperationStatus;

    commitAllowed: boolean;
    commitBlockedMessage: string | null;
    pullAllowed: boolean;
    pullBlockedMessage: string | null;
    pushAllowed: boolean;
    pushBlockedMessage: string | null;

    commitMessageDraft: string;
    onCommitMessageDraftChange: (value: string) => void;
    onCommitFromMessage: (message: string) => void;
    onCreateCommit: () => void;
    onFetch: () => void;
    onPull: () => void;
    onPush: () => void;
    onLoadMoreHistory: () => void;
    onOpenCommit: (sha: string) => void;
    operationLog: OperationLog;
    commitSelectionCount: number;
    onClearCommitSelection: (() => void) | undefined;

    historyLoading: boolean;
    historyEntries: HistoryEntries;
    historyHasMore: boolean;

    shouldShowAllFiles: boolean;
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    onOpenRepositoryFile: (fullPath: string) => void;
    onFilePress: (file: ScmFileStatus) => void;

    changedFilesPresentation: ChangedFilesPresentation;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    reviewFocusPath: string | null;
    rowDensity: 'compact' | 'comfortable';
    reviewMaxFiles: number;
    reviewMaxChangedLines: number;
    diffAutoRefreshIntervalMs: number;
    diffRefreshToken: number;
    scmCommitStrategy: ScmCommitStrategy;
    disableSelectAll: boolean;
    disableSelectNone: boolean;
    selectedCount: number;
    onSelectAll: () => void;
    onSelectNone: () => void;
    onToggleSelectionForFile: (file: ScmFileStatus) => void;
    renderFileActions: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions: (file: ScmFileStatus) => React.ReactNode;

    onOpenSession: () => void;
    onRefresh: () => void;
}>;

export function SessionFilesScreenBody(props: SessionFilesScreenBodyProps) {
    useScmDiffCacheLimits(scmDiffCache);

    return (
        <ItemList style={{ flex: 1 }} scrollEnabled={props.changedFilesPresentation !== 'review'}>
            {props.scmPanelExpanded && !props.isRefreshing && props.scmStatusFiles && (
                <SourceControlBranchSummary theme={props.theme} scmStatusFiles={props.scmStatusFiles} />
            )}

            {props.scmPanelExpanded && props.showScmOperationsPanel ? (
                <SourceControlOperationsPanel
                    theme={props.theme}
                    backendLabel={props.backendLabel}
                    commitActionLabel={props.commitActionLabel}
                    capabilities={props.scmSnapshot?.capabilities ?? null}
                    currentSessionId={props.sessionId}
                    hasConflicts={props.hasConflicts}
                    scmOperationBusy={props.scmOperationBusy}
                    hasGlobalOperationInFlight={props.hasGlobalOperationInFlight}
                    inFlightScmOperation={props.inFlightScmOperation}
                    scmOperationStatus={props.scmOperationStatus}
                    commitAllowed={props.commitAllowed}
                    commitBlockedMessage={props.commitBlockedMessage}
                    pullAllowed={props.pullAllowed}
                    pullBlockedMessage={props.pullBlockedMessage}
                    pushAllowed={props.pushAllowed}
                    pushBlockedMessage={props.pushBlockedMessage}
                    onCreateCommit={props.onCreateCommit}
                    commitMessageDraft={props.commitMessageDraft}
                    onCommitMessageDraftChange={props.onCommitMessageDraftChange}
                    onCommitFromMessage={props.onCommitFromMessage}
                    onFetch={props.onFetch}
                    onPull={props.onPull}
                    onPush={props.onPush}
                    historyLoading={props.historyLoading}
                    historyEntries={props.historyEntries}
                    historyHasMore={props.historyHasMore}
                    onLoadMoreHistory={props.onLoadMoreHistory}
                    onOpenCommit={props.onOpenCommit}
                    operationLog={props.operationLog}
                    commitSelectionCount={props.commitSelectionCount}
                    onClearCommitSelection={props.onClearCommitSelection}
                />
            ) : null}

            {props.isRefreshing ? (
                <View
                    style={{
                        flex: 1,
                        justifyContent: 'center',
                        alignItems: 'center',
                        paddingTop: 40,
                    }}
                >
                    <ActivityIndicator size="small" color={props.theme.colors.textSecondary} />
                </View>
            ) : props.scmSnapshot && !props.scmSnapshot.repo.isRepo ? (
                <NotSourceControlRepositoryState />
            ) : !props.scmSnapshot && props.scmSnapshotError ? (
                props.isSessionInactive && !props.machineRpcTargetAvailable ? (
                    <SourceControlSessionInactiveState
                        machineReachable={props.machineReachable}
                        onOpenSession={props.onOpenSession}
                    />
                ) : (
                    <SourceControlUnavailableState
                        details={
                            (
                                typeof (props.scmSnapshotError as { errorCode?: unknown }).errorCode === 'string'
                                    ? (props.scmSnapshotError as { errorCode: string }).errorCode
                                    : undefined
                            ) === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED
                                ? t('deps.installNotSupported')
                                : props.scmSnapshotError.message
                        }
                        onRetry={props.onRefresh}
                    />
                )
            ) : props.shouldShowAllFiles ? (
                <SessionRepositoryTreeBrowserView
                    sessionId={props.sessionId}
                    searchQuery={props.searchQuery}
                    onSearchQueryChange={props.onSearchQueryChange}
                    showSearchBar={false}
                    onOpenFile={props.onOpenRepositoryFile}
                />
            ) : props.scmStatusFiles ? (
                props.changedFilesPresentation === 'review' && props.scmSnapshot?.capabilities?.readDiffFile !== false ? (
                    <ChangedFilesReview
                        theme={props.theme}
                        sessionId={props.sessionId}
                        snapshot={props.scmSnapshot}
                        changedFilesViewMode={props.changedFilesViewMode}
                        attributionReliability={props.attributionReliability}
                        allRepositoryChangedFiles={props.allRepositoryChangedFiles}
                        sessionAttributedFiles={props.sessionAttributedFiles}
                        repositoryOnlyFiles={props.repositoryOnlyFiles}
                        suppressedInferredCount={props.suppressedInferredCount}
                        maxFiles={props.reviewMaxFiles}
                        maxChangedLines={props.reviewMaxChangedLines}
                        onFilePress={props.onFilePress}
                        focusPath={props.reviewFocusPath}
                        rowDensity={props.rowDensity}
                        onToggleSelectionForFile={props.onToggleSelectionForFile}
                        renderFileActions={props.renderFileActions}
                        renderFileTrailingActions={props.renderFileTrailingActions}
                        diffAutoRefreshIntervalMs={props.diffAutoRefreshIntervalMs}
                        diffRefreshToken={props.diffRefreshToken}
                    />
                ) : (
                    <ChangedFilesList
                        theme={props.theme}
                        changedFilesViewMode={props.changedFilesViewMode}
                        attributionReliability={props.attributionReliability}
                        allRepositoryChangedFiles={props.allRepositoryChangedFiles}
                        sessionAttributedFiles={props.sessionAttributedFiles}
                        repositoryOnlyFiles={props.repositoryOnlyFiles}
                        suppressedInferredCount={props.suppressedInferredCount}
                        onFilePress={props.onFilePress}
                        onToggleSelectionForFile={props.onToggleSelectionForFile}
                        rowDensity={props.rowDensity}
                        renderFileActions={props.renderFileActions}
                        renderFileTrailingActions={props.renderFileTrailingActions}
                    />
                )
            ) : null}
        </ItemList>
    );
}
