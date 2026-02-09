import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { t } from '@/text';
import { useRoute } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Octicons } from '@expo/vector-icons';
import { Text } from '@/components/ui/text/StyledText';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Typography } from '@/constants/Typography';
import { GitFileStatus } from '@/sync/git/gitStatusFiles';
import { getDefaultChangedFilesViewMode } from '@/sync/git/gitAttribution';
import { normalizeFilePath } from './files/utils';
import { FilesToolbar } from './files/components/FilesToolbar';
import { GitBranchSummary } from './files/components/GitBranchSummary';
import { GitOperationsPanel } from './files/components/GitOperationsPanel';
import { searchFiles, FileItem } from '@/sync/domains/input/suggestionFile';
import { SearchResultsList } from './files/components/content/SearchResultsList';
import { ChangedFilesList } from './files/components/content/ChangedFilesList';
import {
    storage,
    useSessionProjectGitOperationLog,
    useSessionProjectGitInFlightOperation,
    useSessionProjectGitSnapshot,
    useSessionProjectGitTouchedPaths,
    useProjectForSession,
    useProjectSessions,
    useSetting,
} from '@/sync/domains/state/storage';
import { gitStatusSync } from '@/sync/git/gitStatusSync';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { useGitCommitHistory } from './files/hooks/useGitCommitHistory';
import { useChangedFilesData } from './files/hooks/useChangedFilesData';
import { useFilesGitOperations } from './files/hooks/useFilesGitOperations';
import { shouldShowGitOperationsPanel } from './files/hooks/useGitOperationsVisibility';
import { resolveGitWriteEnabled } from '@/sync/git/operations/featureFlags';

export default function FilesScreen() {
    const route = useRoute();
    const router = useRouter();
    const sessionId = (route.params! as any).id as string;

    const gitSnapshot = useSessionProjectGitSnapshot(sessionId);
    const touchedPaths = useSessionProjectGitTouchedPaths(sessionId);
    const operationLog = useSessionProjectGitOperationLog(sessionId);
    const inFlightGitOperation = useSessionProjectGitInFlightOperation(sessionId);
    const project = useProjectForSession(sessionId);
    const projectSessionIds = useProjectSessions(project?.id ?? null);

    const [isRefreshing, setIsRefreshing] = React.useState(true);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchResults, setSearchResults] = React.useState<FileItem[]>([]);
    const [isSearching, setIsSearching] = React.useState(false);
    const [showAllRepositoryFiles, setShowAllRepositoryFiles] = React.useState(false);
    const [changedFilesViewMode, setChangedFilesViewMode] = React.useState(getDefaultChangedFilesViewMode);

    const { theme } = useUnistyles();
    const experiments = useSetting('experiments');
    const expGitOperations = useSetting('expGitOperations');
    const gitWriteEnabled = resolveGitWriteEnabled({
        experiments,
        expGitOperations,
    });
    const sessionPath = storage.getState().sessions[sessionId]?.metadata?.path ?? null;
    const hasConflicts = gitSnapshot?.hasConflicts === true;
    const hasGlobalOperationInFlight = Boolean(inFlightGitOperation);
    const showGitOperationsPanel = shouldShowGitOperationsPanel({
        isRefreshing,
        isGitRepo: gitSnapshot?.repo.isGitRepo === true,
        gitWriteEnabled,
    });

    const {
        attributionReliability,
        showSessionViewToggle,
        gitStatusFiles,
        changedFilesCount,
        shouldShowAllFiles,
        allRepositoryChangedFiles,
        sessionAttributedFiles,
        repositoryOnlyFiles,
        suppressedInferredCount,
    } = useChangedFilesData({
        sessionId,
        gitSnapshot,
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

    const {
        historyEntries,
        historyLoading,
        historyHasMore,
        loadCommitHistory,
    } = useGitCommitHistory({
        sessionId,
        gitWriteEnabled,
        sessionPath,
    });

    const refreshGitData = React.useCallback(async () => {
        setIsRefreshing(true);
        try {
            await gitStatusSync.getSync(sessionId).invalidateAndAwait();
            await loadCommitHistory({ reset: true });
        } finally {
            setIsRefreshing(false);
        }
    }, [loadCommitHistory, sessionId]);

    useFocusEffect(
        React.useCallback(() => {
            const refresh = async () => {
                await refreshGitData();
            };

            refresh();

            return () => {};
        }, [refreshGitData])
    );

    const {
        gitOperationBusy,
        gitOperationStatus,
        commitPreflight,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
        createCommit,
    } = useFilesGitOperations({
        sessionId,
        sessionPath,
        gitSnapshot,
        gitWriteEnabled,
        refreshGitData,
        loadCommitHistory,
    });
    const commitAllowed = commitPreflight.allowed;
    const pullAllowed = pullPreflight.allowed;
    const pushAllowed = pushPreflight.allowed;

    React.useEffect(() => {
        let cancelled = false;

        const loadFiles = async () => {
            if (!sessionId || !shouldShowAllFiles || isRefreshing) {
                return;
            }

            try {
                setIsSearching(true);
                const results = await searchFiles(sessionId, searchQuery, { limit: 100 });
                if (!cancelled) {
                    setSearchResults(results);
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

    const handleFilePress = React.useCallback((file: GitFileStatus | FileItem) => {
        if ('fileType' in file && file.fileType === 'folder') {
            return;
        }

        const safePath = normalizeFilePath(file.fullPath);
        const encodedPath = encodeURIComponent(safePath);
        router.push({
            pathname: '/session/[id]/file',
            params: {
                id: sessionId,
                path: encodedPath,
            },
        } as any);
    }, [router, sessionId]);

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <FilesToolbar
                theme={theme}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                showAllRepositoryFiles={showAllRepositoryFiles}
                onShowChangedFiles={() => setShowAllRepositoryFiles(false)}
                onShowAllRepositoryFiles={() => setShowAllRepositoryFiles(true)}
                changedFilesCount={changedFilesCount}
                changedFilesViewMode={changedFilesViewMode}
                showSessionViewToggle={showSessionViewToggle}
                onChangedFilesViewMode={setChangedFilesViewMode}
            />

            {!isRefreshing && gitStatusFiles && <GitBranchSummary theme={theme} gitStatusFiles={gitStatusFiles} />}

            {showGitOperationsPanel && (
                <GitOperationsPanel
                    theme={theme}
                    currentSessionId={sessionId}
                    hasConflicts={hasConflicts}
                    gitOperationBusy={gitOperationBusy}
                    hasGlobalOperationInFlight={hasGlobalOperationInFlight}
                    inFlightGitOperation={inFlightGitOperation}
                    gitOperationStatus={gitOperationStatus}
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
                        router.push({
                            pathname: '/session/[id]/commit',
                            params: {
                                id: sessionId,
                                sha: encodeURIComponent(sha),
                            },
                        } as any);
                    }}
                    operationLog={operationLog}
                />
            )}

            <ItemList style={{ flex: 1 }}>
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
                ) : gitSnapshot && !gitSnapshot.repo.isGitRepo ? (
                    <View
                        style={{
                            flex: 1,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingTop: 40,
                            paddingHorizontal: 20,
                        }}
                    >
                        <Octicons name="git-branch" size={48} color={theme.colors.textSecondary} />
                        <Text
                            style={{
                                fontSize: 16,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 16,
                                ...Typography.default(),
                            }}
                        >
                            {t('files.notRepo')}
                        </Text>
                        <Text
                            style={{
                                fontSize: 14,
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                marginTop: 8,
                                ...Typography.default(),
                            }}
                        >
                            {t('files.notUnderGit')}
                        </Text>
                    </View>
                ) : shouldShowAllFiles ? (
                    <SearchResultsList
                        theme={theme}
                        isSearching={isSearching}
                        searchQuery={searchQuery}
                        searchResults={searchResults}
                        onFilePress={handleFilePress}
                    />
                ) : gitStatusFiles ? (
                    <ChangedFilesList
                        theme={theme}
                        changedFilesViewMode={changedFilesViewMode}
                        attributionReliability={attributionReliability}
                        allRepositoryChangedFiles={allRepositoryChangedFiles}
                        sessionAttributedFiles={sessionAttributedFiles}
                        repositoryOnlyFiles={repositoryOnlyFiles}
                        suppressedInferredCount={suppressedInferredCount}
                        onFilePress={handleFilePress}
                    />
                ) : null}
            </ItemList>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    container: {
        flex: 1,
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
}));
