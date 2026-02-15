import * as React from 'react';
import { View, ActivityIndicator, Platform, Pressable } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ScmFileStatus } from '@/scm/scmStatusFiles';
import { getDefaultChangedFilesViewMode } from '@/scm/scmAttribution';
import { normalizeFilePath } from '@/components/sessions/files/filesUtils';
import { FilesToolbar } from '@/components/sessions/files/FilesToolbar';
import { SourceControlBranchSummary } from '@/components/sessions/files/SourceControlBranchSummary';
import { SourceControlOperationsPanel } from '@/components/sessions/files/SourceControlOperationsPanel';
import { searchFiles, FileItem } from '@/sync/domains/input/suggestionFile';
import { SearchResultsList } from '@/components/sessions/files/content/SearchResultsList';
import { ChangedFilesList } from '@/components/sessions/files/content/ChangedFilesList';
import { ChangedFilesReview } from '@/components/sessions/files/content/ChangedFilesReview';
import { RepositoryTreeList } from '@/components/sessions/files/content/RepositoryTreeList';
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
    useSessionRepositoryTreeExpandedPaths,
    useProjectForSession,
    useProjectSessions,
    useSetting,
    useMachine,
} from '@/sync/domains/state/storage';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { useScmCommitHistory } from '@/hooks/session/files/useScmCommitHistory';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
import { useFilesScmOperations } from '@/hooks/session/files/useFilesScmOperations';
import { shouldShowScmOperationsPanel } from '@/hooks/session/files/useScmOperationsVisibility';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import { NotSourceControlRepositoryState, SourceControlSessionInactiveState, SourceControlUnavailableState } from '@/components/sessions/sourceControl/states';
import type { ChangedFilesPresentation } from '@/scm/scmAttribution';
import { resolveSessionMachineReachability } from '@/components/sessions/model/resolveSessionMachineReachability';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { Octicons } from '@expo/vector-icons';
import { applyFileStageAction } from '@/scm/operations/applyFileStageAction';
import { isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';

export default function FilesScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;
    const localSearchParams = useLocalSearchParams();

    const session = useSession(sessionId);
    const scmSnapshot = useSessionProjectScmSnapshot(sessionId);
    const scmSnapshotError = useSessionProjectScmSnapshotError(sessionId);
    const commitSelectionPaths = useSessionProjectScmCommitSelectionPaths(sessionId);
    const commitSelectionPatches = useSessionProjectScmCommitSelectionPatches(sessionId);
    const touchedPaths = useSessionProjectScmTouchedPaths(sessionId);
    const operationLog = useSessionProjectScmOperationLog(sessionId);
    const inFlightScmOperation = useSessionProjectScmInFlightOperation(sessionId);
    const repositoryTreeExpandedPaths = useSessionRepositoryTreeExpandedPaths(sessionId);
    const project = useProjectForSession(sessionId);
    const projectSessionIds = useProjectSessions(project?.id ?? null);

    const [isRefreshing, setIsRefreshing] = React.useState(true);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const [showAllRepositoryFiles, setShowAllRepositoryFiles] = React.useState(false);
    const [changedFilesViewMode, setChangedFilesViewMode] = React.useState(getDefaultChangedFilesViewMode);
    const [changedFilesPresentation, setChangedFilesPresentation] = React.useState<ChangedFilesPresentation>('review');
    const [reviewFocusPath, setReviewFocusPath] = React.useState<string | null>(null);
    const [scmPanelExpanded, setScmPanelExpanded] = React.useState(false);
    const [stageBusyPath, setStageBusyPath] = React.useState<string | null>(null);

    const deepLinkPresentation = React.useMemo(() => {
        const raw = (localSearchParams as any)?.presentation;
        if (raw === 'review') return 'review';
        if (raw === 'list') return 'list';
        return null;
    }, [localSearchParams]);
    const deepLinkFocusPath = React.useMemo(() => {
        const raw = (localSearchParams as any)?.focusPath;
        return typeof raw === 'string' && raw.trim() ? raw : null;
    }, [localSearchParams]);

    const deepLinkAppliedRef = React.useRef(false);
    React.useEffect(() => {
        if (deepLinkAppliedRef.current) return;
        if (!deepLinkPresentation && !deepLinkFocusPath) return;
        deepLinkAppliedRef.current = true;

        if (deepLinkPresentation) {
            setChangedFilesPresentation(deepLinkPresentation);
            // Focus paths only make sense in changed-files mode.
            setShowAllRepositoryFiles(false);
        }
        if (deepLinkFocusPath) {
            setReviewFocusPath(deepLinkFocusPath);
            setShowAllRepositoryFiles(false);
        }
    }, [deepLinkFocusPath, deepLinkPresentation]);

    const { theme } = useUnistyles();
    const scmCommitStrategy = useSetting('scmCommitStrategy');
    const scmRemoteConfirmPolicy = useSetting('scmRemoteConfirmPolicy');
    const scmPushRejectPolicy = useSetting('scmPushRejectPolicy');
    const scmReviewMaxFiles = useSetting('scmReviewMaxFiles');
    const scmReviewMaxChangedLines = useSetting('scmReviewMaxChangedLines');
    const filesChangedFilesRowDensity = useSetting('filesChangedFilesRowDensity');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const sessionPath = session?.metadata?.path ?? null;
    const machineId = typeof session?.metadata?.machineId === 'string' ? session.metadata.machineId : '';
    const changedFilesRowDensity = filesChangedFilesRowDensity === 'compact' ? 'compact' : 'comfortable';
    const machine = useMachine(machineId);
    const isSessionInactive = session?.active === false;
    const machineReachable = resolveSessionMachineReachability({
        machineIsKnown: Boolean(machine),
        machineIsOnline: machine ? isMachineOnline(machine) : false,
    });
    const hasConflicts = scmSnapshot?.hasConflicts === true;
    const hasGlobalOperationInFlight = Boolean(inFlightScmOperation);
    const showScmOperationsPanel = shouldShowScmOperationsPanel({
        isRefreshing,
        isRepo: scmSnapshot?.repo.isRepo === true,
        capabilities: scmSnapshot?.capabilities ?? null,
        scmWriteEnabled,
    });

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

    const loadCommitHistoryRef = React.useRef(loadCommitHistory);
    React.useEffect(() => {
        loadCommitHistoryRef.current = loadCommitHistory;
    }, [loadCommitHistory]);

    const pendingRefreshAfterSessionPathHydrationRef = React.useRef(false);

    const refreshScmData = React.useCallback(async () => {
        if (!sessionPath) {
            return;
        }
        setIsRefreshing(true);
        try {
            await scmStatusSync.getSync(sessionId).invalidateAndAwait();
            await loadCommitHistoryRef.current({ reset: true });
        } finally {
            setIsRefreshing(false);
        }
    }, [sessionId, sessionPath]);

    useFocusEffect(
        React.useCallback(() => {
            const refresh = async () => {
                await refreshScmData();
            };

            if (!sessionPath) {
                pendingRefreshAfterSessionPathHydrationRef.current = true;
                return;
            }

            refresh();

            return () => {};
        }, [refreshScmData, sessionPath])
    );

    React.useEffect(() => {
        if (!sessionPath) {
            return;
        }
        if (!pendingRefreshAfterSessionPathHydrationRef.current) {
            return;
        }
        pendingRefreshAfterSessionPathHydrationRef.current = false;
        void refreshScmData();
    }, [refreshScmData, sessionPath]);

    const {
        scmOperationBusy,
        scmOperationStatus,
        commitPreflight,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
        createCommit,
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
    const commitSelectionCount = React.useMemo(() => {
        const uniquePaths = new Set<string>();
        for (const path of commitSelectionPaths) {
            const normalized = path.trim();
            if (normalized) uniquePaths.add(normalized);
        }
        for (const patchSelection of commitSelectionPatches) {
            const normalized = patchSelection.path.trim();
            if (normalized) uniquePaths.add(normalized);
        }
        return uniquePaths.size;
    }, [commitSelectionPatches, commitSelectionPaths]);
    const commitSelectionSet = React.useMemo(() => {
        const out = new Set<string>();
        for (const path of commitSelectionPaths) {
            const normalized = path.trim();
            if (normalized) out.add(normalized);
        }
        for (const patchSelection of commitSelectionPatches) {
            const normalized = patchSelection.path.trim();
            if (normalized) out.add(normalized);
        }
        return out;
    }, [commitSelectionPatches, commitSelectionPaths]);

    React.useEffect(() => {
        let cancelled = false;

        const loadFiles = async () => {
            if (!sessionId || !shouldShowAllFiles || isRefreshing) {
                return;
            }

            try {
                setIsSearching(true);
                if (!searchQuery.trim()) {
                    setSearchResults([]);
                    return;
                }
                const results = await searchFiles(sessionId, searchQuery, { limit: 250 });
                if (!cancelled) {
                    setSearchResults(results.filter((entry) => entry.fileType === 'file'));
                }
            } catch {
                if (!cancelled) {
                    setSearchResults([]);
                }
            } finally {
                if (!cancelled) {
                    setIsSearching(false);
                }
            }
        };

        loadFiles();

        return () => {
            cancelled = true;
        };
    }, [isRefreshing, searchQuery, sessionId, shouldShowAllFiles]);

    const handleFilePress = React.useCallback((file: ScmFileStatus | FileItem) => {
        if ('fileType' in file && file.fileType === 'folder') {
            return;
        }

        const safePath = normalizeFilePath(file.fullPath);
        router.push({
            pathname: '/session/[id]/file',
            params: {
                id: sessionId,
                // expo-router will encode query params; pre-encoding here can lead to double-encoding.
                path: safePath,
            },
        } as any);
    }, [router, sessionId]);

    const setRepositoryTreeExpandedPaths = React.useCallback((paths: string[]) => {
        storage.getState().setSessionRepositoryTreeExpandedPaths(sessionId, paths);
    }, [sessionId]);

    const renderFileActions = React.useCallback((file: ScmFileStatus) => {
        const busy = stageBusyPath === file.fullPath;
        const atomic = isAtomicCommitStrategy(scmCommitStrategy);
        const selectedForCommit = atomic ? commitSelectionSet.has(file.fullPath) : file.isIncluded === true;

        const iconName = selectedForCommit ? 'check' : 'plus';
        const iconColor = selectedForCommit ? theme.colors.success : theme.colors.textSecondary;

        return (
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={selectedForCommit ? 'Remove from commit' : 'Add to commit'}
                disabled={busy || !scmWriteEnabled}
                onPress={(e: any) => {
                    e?.stopPropagation?.();
                    void (async () => {
                        setStageBusyPath(file.fullPath);
                        try {
                            await applyFileStageAction({
                                sessionId,
                                sessionPath,
                                filePath: file.fullPath,
                                snapshot: scmSnapshot,
                                scmWriteEnabled,
                                commitStrategy: scmCommitStrategy,
                                stage: !selectedForCommit,
                                surface: 'files',
                            });
                        } finally {
                            setStageBusyPath((prev) => (prev === file.fullPath ? null : prev));
                        }
                    })();
                }}
                style={{
                    width: 28,
                    height: 28,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    backgroundColor: theme.colors.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: (!scmWriteEnabled || busy) ? 0.55 : 1,
                }}
            >
                {busy ? (
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                ) : (
                    <Octicons name={iconName as any} size={14} color={iconColor} />
                )}
            </Pressable>
        );
    }, [
        commitSelectionSet,
        scmCommitStrategy,
        scmSnapshot,
        scmWriteEnabled,
        sessionId,
        sessionPath,
        stageBusyPath,
        theme.colors,
    ]);

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
            />

            <ItemList style={{ flex: 1 }}>
                {scmPanelExpanded && !isRefreshing && scmStatusFiles && (
                    <SourceControlBranchSummary theme={theme} scmStatusFiles={scmStatusFiles} />
                )}

                {scmPanelExpanded && showScmOperationsPanel && (
                    <SourceControlOperationsPanel
                        theme={theme}
                        backendLabel={backendLabel}
                        commitActionLabel={commitActionLabel}
                        capabilities={scmSnapshot?.capabilities ?? null}
                        currentSessionId={sessionId}
                        hasConflicts={hasConflicts}
                        scmOperationBusy={scmOperationBusy}
                        hasGlobalOperationInFlight={hasGlobalOperationInFlight}
                        inFlightScmOperation={inFlightScmOperation}
                        scmOperationStatus={scmOperationStatus}
                        commitAllowed={commitAllowed}
                        commitBlockedMessage={commitAllowed ? null : commitPreflight.message}
                        pullAllowed={pullAllowed}
                        pullBlockedMessage={pullAllowed ? null : pullPreflight.message}
                        pushAllowed={pushAllowed}
                        pushBlockedMessage={pushAllowed ? null : pushPreflight.message}
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
                    />
                )}
                {isRefreshing ? (
                    <View
                        style={{
                            flex: 1,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingTop: 40,
                        }}
                    >
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : scmSnapshot && !scmSnapshot.repo.isRepo ? (
                    <NotSourceControlRepositoryState />
                ) : !scmSnapshot && scmSnapshotError ? (
                    isSessionInactive ? (
                        <SourceControlSessionInactiveState
                            machineReachable={machineReachable}
                            onOpenSession={() => {
                                router.push({ pathname: '/session/[id]', params: { id: sessionId } } as any);
                            }}
                        />
                    ) : (
                        <SourceControlUnavailableState
                            details={
                                (
                                    typeof (scmSnapshotError as { errorCode?: unknown }).errorCode === 'string'
                                        ? (scmSnapshotError as { errorCode: string }).errorCode
                                        : undefined
                                ) === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED
                                    ? t('deps.installNotSupported')
                                    : scmSnapshotError.message
                            }
                            onRetry={() => {
                                void refreshScmData();
                            }}
                        />
                    )
                ) : shouldShowAllFiles && !searchQuery.trim() ? (
                    <RepositoryTreeList
                        theme={theme}
                        sessionId={sessionId}
                        expandedPaths={repositoryTreeExpandedPaths}
                        onExpandedPathsChange={setRepositoryTreeExpandedPaths}
                        onOpenFile={(fullPath) => {
                            const parts = fullPath.split('/');
                            handleFilePress({
                                fileName: parts.length > 0 ? (parts[parts.length - 1] || fullPath) : fullPath,
                                filePath: '',
                                fullPath,
                                fileType: 'file',
                            });
                        }}
                    />
                ) : shouldShowAllFiles ? (
                    <SearchResultsList
                        theme={theme}
                        isSearching={isSearching}
                        searchQuery={searchQuery}
                        searchResults={searchResults}
                        onFilePress={handleFilePress}
                    />
                ) : scmStatusFiles ? (
                    changedFilesPresentation === 'review' && scmSnapshot?.capabilities?.readDiffFile !== false ? (
                        <ChangedFilesReview
                            theme={theme}
                            sessionId={sessionId}
                            snapshot={scmSnapshot}
                            changedFilesViewMode={changedFilesViewMode}
                            attributionReliability={attributionReliability}
                            allRepositoryChangedFiles={allRepositoryChangedFiles}
                            sessionAttributedFiles={sessionAttributedFiles}
                            repositoryOnlyFiles={repositoryOnlyFiles}
                            suppressedInferredCount={suppressedInferredCount}
                            maxFiles={typeof scmReviewMaxFiles === 'number' ? scmReviewMaxFiles : 25}
                            maxChangedLines={typeof scmReviewMaxChangedLines === 'number' ? scmReviewMaxChangedLines : 2000}
                            onFilePress={handleFilePress}
                            focusPath={reviewFocusPath}
                            rowDensity={changedFilesRowDensity}
                            renderFileActions={renderFileActions}
                        />
                    ) : (
                        <ChangedFilesList
                            theme={theme}
                            changedFilesViewMode={changedFilesViewMode}
                            attributionReliability={attributionReliability}
                            allRepositoryChangedFiles={allRepositoryChangedFiles}
                            sessionAttributedFiles={sessionAttributedFiles}
                            repositoryOnlyFiles={repositoryOnlyFiles}
                            suppressedInferredCount={suppressedInferredCount}
                            onFilePress={handleFilePress}
                            rowDensity={changedFilesRowDensity}
                            renderFileActions={renderFileActions}
                        />
                    )
                ) : null}
            </ItemList>
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
