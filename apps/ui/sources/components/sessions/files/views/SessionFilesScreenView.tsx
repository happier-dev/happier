import * as React from 'react';
import { View, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScmFileStatus } from '@/scm/scmStatusFiles';
import { getDefaultChangedFilesViewMode } from '@/scm/scmAttribution';
import { normalizeFilePath } from '@/components/sessions/files/filesUtils';
import { FilesToolbar } from '@/components/sessions/files/FilesToolbar';
import {
    storage,
    useSession,
    useSessionProjectScmOperationLog,
    useSessionProjectScmInFlightOperation,
    useSessionProjectScmSnapshot,
    useSessionProjectScmSnapshotError,
    useSessionProjectScmCommitSelectionPaths,
    useSessionProjectScmCommitSelectionPatches,
    useSessionProjectScmTouchedPaths,
    useProjectForSession,
    useProjectSessions,
    useSetting,
} from '@/sync/domains/state/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { useScmCommitHistory } from '@/hooks/session/files/useScmCommitHistory';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
import { useFilesScmOperations } from '@/hooks/session/files/useFilesScmOperations';
import { shouldShowScmOperationsPanel } from '@/hooks/session/files/useScmOperationsVisibility';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { buildSnapshotSignature } from '@/scm/statusSync/projectState';
import type { ChangedFilesPresentation } from '@/scm/scmAttribution';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { computeExpandedPathsForReveal } from '@/components/sessions/files/repositoryTree/computeExpandedPathsForReveal';
import { SessionFilesScreenBody } from '@/components/sessions/files/views/sessionFilesScreen/SessionFilesScreenBody';
import { useSessionFilesCommitSelectionState } from '@/components/sessions/files/views/sessionFilesScreen/useSessionFilesCommitSelection';
import { useSessionFilesScmRefreshState } from '@/components/sessions/files/views/sessionFilesScreen/useSessionFilesScmRefresh';
import { useSessionFilesDeepLinkSync } from '@/components/sessions/files/views/sessionFilesScreen/useSessionFilesDeepLinkSync';
import { useSessionFilesRowRenderers } from '@/components/sessions/files/views/sessionFilesScreen/useSessionFilesRowRenderers';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';

export type SessionFilesScreenViewProps = Readonly<{
    sessionId: string;
}>;

export function SessionFilesScreenView(props: SessionFilesScreenViewProps) {
    const router = useRouter();
    const sessionId = props.sessionId;
    const localSearchParams = useLocalSearchParams();

    const session = useSession(sessionId);
    const scmSnapshot = useSessionProjectScmSnapshot(sessionId);
    const scmSnapshotError = useSessionProjectScmSnapshotError(sessionId);
    const commitSelectionPaths = useSessionProjectScmCommitSelectionPaths(sessionId);
    const commitSelectionPatches = useSessionProjectScmCommitSelectionPatches(sessionId);
    const touchedPaths = useSessionProjectScmTouchedPaths(sessionId);
    const operationLog = useSessionProjectScmOperationLog(sessionId);
    const inFlightScmOperation = useSessionProjectScmInFlightOperation(sessionId);
    const project = useProjectForSession(sessionId);
    const projectSessionIds = useProjectSessions(project?.id ?? null);

    const [searchQuery, setSearchQuery] = React.useState('');
    const [showAllRepositoryFiles, setShowAllRepositoryFiles] = React.useState(false);
    const [changedFilesViewMode, setChangedFilesViewMode] = React.useState(getDefaultChangedFilesViewMode);
    const [changedFilesPresentation, setChangedFilesPresentation] = React.useState<ChangedFilesPresentation>('review');
    const [reviewFocusPath, setReviewFocusPath] = React.useState<string | null>(null);
    const [scmPanelExpanded, setScmPanelExpanded] = React.useState(false);
    const [commitMessageDraft, setCommitMessageDraft] = React.useState('');

    useSessionFilesDeepLinkSync({
        localSearchParams,
        setChangedFilesPresentation,
        setShowAllRepositoryFiles,
        setReviewFocusPath,
    });

    const { theme } = useUnistyles();
    const scmCommitStrategy = useSetting('scmCommitStrategy');
    const scmRemoteConfirmPolicy = useSetting('scmRemoteConfirmPolicy');
    const scmPushRejectPolicy = useSetting('scmPushRejectPolicy');
    const scmReviewMaxFiles = useSetting('scmReviewMaxFiles');
    const scmReviewMaxChangedLines = useSetting('scmReviewMaxChangedLines');
    const scmFilesAutoRefreshIntervalMsSetting = useSetting('scmFilesAutoRefreshIntervalMs' as any);
    const scmFilesAutoRefreshIntervalMs =
        typeof scmFilesAutoRefreshIntervalMsSetting === 'number' && Number.isFinite(scmFilesAutoRefreshIntervalMsSetting) && scmFilesAutoRefreshIntervalMsSetting >= 5_000
            ? scmFilesAutoRefreshIntervalMsSetting
            : 60_000;
    const filesChangedFilesRowDensity = useSetting('filesChangedFilesRowDensity');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: session?.metadata?.path ?? null,
        projectPath: project?.key?.path ?? null,
    });
    const changedFilesRowDensity = filesChangedFilesRowDensity === 'compact' ? 'compact' : 'comfortable';
    const { machineReachable, machineRpcTargetAvailable } = useSessionMachineReachability(sessionId);
    const isSessionInactive = session?.active === false;
    const hasConflicts = scmSnapshot?.hasConflicts === true;
    const hasGlobalOperationInFlight = Boolean(inFlightScmOperation);

    const {
        attributionReliability,
        showSessionViewToggle,
        scmStatusFiles,
        changedFilesCount,
        shouldShowAllFiles,
        allRepositoryChangedFiles,
        sessionAttributedFiles,
        repositoryOnlyFiles,
        suppressedInferredCount,
    } = useChangedFilesData({
        sessionId,
        scmSnapshot,
        touchedPaths,
        operationLog,
        projectSessionIds,
        searchQuery,
        showAllRepositoryFiles,
    });

    React.useEffect(() => {
        if (!showSessionViewToggle && changedFilesViewMode === 'session') {
            setChangedFilesViewMode('repository');
        }
    }, [changedFilesViewMode, showSessionViewToggle]);

    React.useEffect(() => {
        if (searchQuery.trim()) {
            setScmPanelExpanded(false);
        }
    }, [searchQuery]);

    const {
        historyEntries,
        historyLoading,
        historyHasMore,
        loadCommitHistory,
    } = useScmCommitHistory({
        sessionId,
        readLogEnabled: scmSnapshot?.repo.isRepo === true && (scmSnapshot?.capabilities?.readLog ?? true),
        sessionPath,
    });

    const snapshotSignature = React.useMemo(() => {
        if (!scmSnapshot) return null;
        return buildSnapshotSignature(scmSnapshot);
    }, [scmSnapshot]);
    const getSnapshotSignature = React.useCallback(() => snapshotSignature, [snapshotSignature]);

    const {
        isRefreshing,
        diffRefreshToken,
        refreshScmData,
    } = useSessionFilesScmRefreshState({
        sessionId,
        sessionPath,
        autoRefreshIntervalMs: scmFilesAutoRefreshIntervalMs,
        loadCommitHistory,
        getSnapshotSignature,
    });

    const showScmOperationsPanel = shouldShowScmOperationsPanel({
        isRefreshing,
        isRepo: scmSnapshot?.repo.isRepo === true,
        capabilities: scmSnapshot?.capabilities ?? null,
        scmWriteEnabled,
    });

    const {
        scmOperationBusy,
        scmOperationStatus,
        commitPreflight,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
        createCommit,
        createCommitFromMessage,
    } = useFilesScmOperations({
        sessionId,
        sessionPath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        scmRemoteConfirmPolicy,
        scmPushRejectPolicy,
        refreshScmData,
        loadCommitHistory,
    });
    const commitAllowed = commitPreflight.allowed;
    const pullAllowed = pullPreflight.allowed;
    const pushAllowed = pushPreflight.allowed;
    const scmUiPlugin = scmUiBackendRegistry.getPluginForSnapshot(scmSnapshot);
    const backendLabel = scmUiPlugin.displayName;
    const commitActionLabel = scmUiPlugin.commitActionConfig(scmSnapshot).label;
    const {
        commitSelectionCount,
        repositorySelectedCount,
        disableSelectAll,
        disableSelectNone,
        bulkSelectAll,
        bulkSelectNone,
        toggleCommitSelectionForFile,
        isSelectedForCommit,
    } = useSessionFilesCommitSelectionState({
        sessionId,
        sessionPath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        allRepositoryChangedFiles,
        commitSelectionPaths,
        commitSelectionPatches,
    });

    const openFileByFullPath = React.useCallback((fullPath: string) => {
        const safePath = normalizeFilePath(fullPath);
        router.push({
            pathname: '/session/[id]/file',
            params: {
                id: sessionId,
                // expo-router will encode query params; pre-encoding here can lead to double-encoding.
                path: safePath,
            },
        } as any);
    }, [router, sessionId]);

    const onRevealInTree = React.useCallback((fullPath: string) => {
        setSearchQuery('');
        setShowAllRepositoryFiles(true);
        const sessionExpandedPaths = storage.getState().getSessionRepositoryTreeExpandedPaths(sessionId);
        const revealExpandedPaths = computeExpandedPathsForReveal({
            expandedPaths: sessionExpandedPaths,
            fullPath,
        });
        storage.getState().setSessionRepositoryTreeExpandedPaths(sessionId, revealExpandedPaths);
    }, [sessionId]);

    const { renderFileActions, renderFileTrailingActions } = useSessionFilesRowRenderers({
        sessionId,
        sessionPath,
        snapshot: scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        isSelectedForCommit,
        onRevealInTree,
    });

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <FilesToolbar
                theme={theme}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                showAllRepositoryFiles={showAllRepositoryFiles}
                onShowChangedFiles={() => {
                    setShowAllRepositoryFiles(false);
                }}
                onShowAllRepositoryFiles={() => setShowAllRepositoryFiles(true)}
                changedFilesCount={changedFilesCount}
                changedFilesViewMode={changedFilesViewMode}
                changedFilesPresentation={changedFilesPresentation}
                showSessionViewToggle={showSessionViewToggle}
                onChangedFilesViewMode={setChangedFilesViewMode}
                onChangedFilesPresentationChange={setChangedFilesPresentation}
                scmPanelExpanded={scmPanelExpanded}
                onToggleScmPanel={() => setScmPanelExpanded((prev) => !prev)}
                onRefresh={() => {
                    void refreshScmData();
                }}
            />

            <SessionFilesScreenBody
                theme={theme}
                sessionId={sessionId}
                isRefreshing={isRefreshing}
                scmPanelExpanded={scmPanelExpanded}
                showScmOperationsPanel={showScmOperationsPanel}
                scmStatusFiles={scmStatusFiles}
                scmSnapshot={scmSnapshot}
                scmSnapshotError={scmSnapshotError}
                hasConflicts={hasConflicts}
                hasGlobalOperationInFlight={hasGlobalOperationInFlight}
                inFlightScmOperation={inFlightScmOperation}
                isSessionInactive={isSessionInactive}
                machineReachable={machineReachable}
                machineRpcTargetAvailable={machineRpcTargetAvailable}
                backendLabel={backendLabel}
                commitActionLabel={commitActionLabel}
                scmOperationBusy={scmOperationBusy}
                scmOperationStatus={scmOperationStatus}
                commitAllowed={commitAllowed}
                commitBlockedMessage={commitAllowed ? null : commitPreflight.message}
                pullAllowed={pullAllowed}
                pullBlockedMessage={pullAllowed ? null : pullPreflight.message}
                pushAllowed={pushAllowed}
                pushBlockedMessage={pushAllowed ? null : pushPreflight.message}
                commitMessageDraft={commitMessageDraft}
                onCommitMessageDraftChange={setCommitMessageDraft}
                onCommitFromMessage={(message) => {
                    void (async () => {
                        const result = await createCommitFromMessage(message);
                        if (result.ok) {
                            setCommitMessageDraft('');
                        }
                    })();
                }}
                onCreateCommit={createCommit}
                onFetch={() => {
                    void runRemoteOperation('fetch');
                }}
                onPull={() => {
                    void runRemoteOperation('pull');
                }}
                onPush={() => {
                    void runRemoteOperation('push');
                }}
                historyLoading={historyLoading}
                historyEntries={historyEntries}
                historyHasMore={historyHasMore}
                onLoadMoreHistory={() => {
                    void loadCommitHistory();
                }}
                onOpenCommit={(sha) => {
                    const safeSha = sha.trim().split(/\s+/)[0] ?? '';
                    router.push({
                        pathname: '/session/[id]/commit',
                        params: {
                            id: sessionId,
                            // expo-router will encode query params; pre-encoding here can lead to double-encoding.
                            sha: safeSha,
                        },
                    } as any);
                }}
                operationLog={operationLog}
                commitSelectionCount={commitSelectionCount}
                onClearCommitSelection={
                    commitSelectionCount > 0
                        ? () => {
                            storage.getState().clearSessionProjectScmCommitSelectionPaths(sessionId);
                            storage.getState().clearSessionProjectScmCommitSelectionPatches(sessionId);
                        }
                        : undefined
                }
                shouldShowAllFiles={shouldShowAllFiles}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                onOpenRepositoryFile={openFileByFullPath}
                onFilePress={(file) => openFileByFullPath(file.fullPath)}
                changedFilesPresentation={changedFilesPresentation}
                changedFilesViewMode={changedFilesViewMode}
                attributionReliability={attributionReliability}
                allRepositoryChangedFiles={allRepositoryChangedFiles}
                sessionAttributedFiles={sessionAttributedFiles}
                repositoryOnlyFiles={repositoryOnlyFiles}
                suppressedInferredCount={suppressedInferredCount}
                reviewFocusPath={reviewFocusPath}
                rowDensity={changedFilesRowDensity}
                reviewMaxFiles={typeof scmReviewMaxFiles === 'number' ? scmReviewMaxFiles : 25}
                reviewMaxChangedLines={typeof scmReviewMaxChangedLines === 'number' ? scmReviewMaxChangedLines : 2000}
                diffAutoRefreshIntervalMs={scmFilesAutoRefreshIntervalMs}
                diffRefreshToken={diffRefreshToken}
                scmCommitStrategy={scmCommitStrategy}
                disableSelectAll={disableSelectAll}
                disableSelectNone={disableSelectNone}
                selectedCount={repositorySelectedCount}
                onSelectAll={bulkSelectAll}
                onSelectNone={bulkSelectNone}
                onToggleSelectionForFile={toggleCommitSelectionForFile}
                renderFileActions={renderFileActions}
                renderFileTrailingActions={renderFileTrailingActions}
                onOpenSession={() => {
                    router.push({ pathname: '/session/[id]', params: { id: sessionId } } as any);
                }}
                onRefresh={() => {
                    void refreshScmData();
                }}
            />
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    container: {
        flex: 1,
        ...(Platform.select({
            web: { minHeight: 0 },
            default: {},
        }) as any),
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
}));
