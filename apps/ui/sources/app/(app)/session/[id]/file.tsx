import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { FileActionToolbar, type FileDiffMode } from '@/components/sessions/files/file/FileActionToolbar';
import { FileContentPanel } from '@/components/sessions/files/file/FileContentPanel';
import { FileHeader } from '@/components/sessions/files/file/FileHeader';
import { FileBinaryState, FileErrorState, FileLoadingState } from '@/components/sessions/files/file/FileScreenState';
import {
    sessionScmDiffFile,
    sessionReadFile,
} from '@/sync/ops';
import {
    storage,
    useSession,
    useSessions,
    useSessionProjectScmCommitSelectionPaths,
    useSessionProjectScmInFlightOperation,
    useSessionProjectScmSnapshot,
    useSetting,
} from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { decodeBase64 } from '@/encryption/base64';
import { buildFileLineSelectionFingerprint, canUseLineSelection } from '@/scm/scmLineSelection';
import { getFileLanguageFromPath, isBinaryContent, isKnownBinaryPath } from '@/scm/utils/filePresentation';
import { decodeSessionFilePathParam } from '@/scm/utils/filePathParam';
import { allowsLiveStaging, isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import { resolveDefaultDiffModeForFile } from '@/scm/diff/defaultMode';
import { useFileScmStageActions } from '@/hooks/session/files/useFileScmStageActions';
import { resolveSessionPathState } from '@/hooks/session/files/sessionPathState';
import type { ScmDiffArea } from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

interface FileContent {
    content: string;
    isBinary: boolean;
}

function decodeUtf8Base64(base64: string): string {
    const bytes = decodeBase64(base64);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function toScmDiffArea(mode: FileDiffMode): ScmDiffArea {
    if (mode === 'included') return 'included';
    if (mode === 'pending') return 'pending';
    return 'both';
}

export default function FileScreen() {
    const { theme } = useUnistyles();
    const { id: sessionIdParam } = useLocalSearchParams<{ id: string }>();
    const sessionId = sessionIdParam || '';
    const searchParams = useLocalSearchParams();

    const scmCommitStrategy = useSetting('scmCommitStrategy');
    const scmDefaultDiffModeByBackend = useSetting('scmDefaultDiffModeByBackend');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const session = useSession(sessionId);
    const sessionsReady = useSessions() !== null;
    const sessionPath = session?.metadata?.path ?? null;

    const encodedPath = searchParams.path as string;
    const filePath = decodeSessionFilePathParam(encodedPath);

    const scmSnapshot = useSessionProjectScmSnapshot(sessionId);
    const commitSelectionPaths = useSessionProjectScmCommitSelectionPaths(sessionId);
    const inFlightScmOperation = useSessionProjectScmInFlightOperation(sessionId);
    const fileEntry = React.useMemo(
        () => scmSnapshot?.entries.find((entry) => entry.path === filePath) ?? null,
        [filePath, scmSnapshot]
    );
    const hasConflicts = scmSnapshot?.hasConflicts === true;

    const [fileContent, setFileContent] = React.useState<FileContent | null>(null);
    const [diffContent, setDiffContent] = React.useState<string | null>(null);
    const [displayMode, setDisplayMode] = React.useState<'file' | 'diff'>('diff');
    const [diffMode, setDiffMode] = React.useState<FileDiffMode>('pending');
    const [isLoading, setIsLoading] = React.useState(true);
    const [selectedLineIndexes, setSelectedLineIndexes] = React.useState<Set<number>>(new Set());
    const [error, setError] = React.useState<string | null>(null);

    const hasIncludedDelta = fileEntry?.hasIncludedDelta === true;
    const hasPendingDelta = fileEntry?.hasPendingDelta === true;
    const includeExcludeEnabled = allowsLiveStaging({
        strategy: scmCommitStrategy,
        snapshot: scmSnapshot,
    });
    const virtualSelectionEnabled = isAtomicCommitStrategy(scmCommitStrategy)
        && scmSnapshot?.capabilities?.writeCommitPathSelection === true;
    const virtualLineSelectionEnabled = isAtomicCommitStrategy(scmCommitStrategy)
        && scmSnapshot?.capabilities?.writeCommitLineSelection === true;
    const isSelectedForCommit = commitSelectionPaths.includes(filePath);
    const lineSelectionFingerprint = React.useMemo(
        () => buildFileLineSelectionFingerprint(fileEntry),
        [fileEntry]
    );
    const lineSelectionEnabled = canUseLineSelection({
        scmWriteEnabled,
        includeExcludeEnabled,
        virtualLineSelectionEnabled,
        hasConflicts,
        isBinary: fileEntry?.stats.isBinary === true,
        diffMode,
        diffContent,
    });

    React.useEffect(() => {
        const resolved = resolveDefaultDiffModeForFile({
            snapshot: scmSnapshot,
            backendOverrides: scmDefaultDiffModeByBackend as Record<string, ScmDiffArea> | undefined,
            hasIncludedDelta,
            hasPendingDelta,
        });
        setDiffMode(resolved);
    }, [hasIncludedDelta, hasPendingDelta, scmDefaultDiffModeByBackend, scmSnapshot]);

    React.useEffect(() => {
        setSelectedLineIndexes(new Set());
    }, [diffMode, diffContent, lineSelectionFingerprint]);

    React.useEffect(() => {
        if (!lineSelectionEnabled) {
            setSelectedLineIndexes(new Set());
        }
    }, [lineSelectionEnabled]);

    const refreshAll = React.useCallback(async () => {
        let failedReadError: string | null = null;
        let latestDiff: string | null = null;
        let sessionState: ReturnType<typeof resolveSessionPathState> | null = null;

        try {
            setIsLoading(true);
            setError(null);

            sessionState = resolveSessionPathState({
                sessionId,
                sessionPath,
                sessionsReady,
            });
            if (sessionState.status === 'waiting') {
                return;
            }
            if (sessionState.status === 'error') {
                setError(sessionState.error);
                return;
            }

            const diffResponse = await sessionScmDiffFile(sessionId, {
                path: filePath,
                area: toScmDiffArea(diffMode),
            });

            latestDiff = diffResponse.success ? (diffResponse.diff ?? '') : null;
            setDiffContent(latestDiff);

            if (isKnownBinaryPath(filePath)) {
                setFileContent({ content: '', isBinary: true });
                return;
            }

            const readResponse = await sessionReadFile(sessionId, filePath);
            if (readResponse.success && readResponse.content) {
                const decodedContent = decodeUtf8Base64(readResponse.content);
                const binary = isBinaryContent(decodedContent);

                setFileContent({
                    content: binary ? '' : decodedContent,
                    isBinary: binary,
                });
            } else {
                setFileContent(null);
                failedReadError = readResponse.error || 'Failed to read file';
            }
        } catch (err) {
            setFileContent(null);
            failedReadError = (err as any)?.message || 'Failed to load file';
        } finally {
            if (failedReadError) {
                const canStillRenderDiff = Boolean(latestDiff && latestDiff.length > 0) || fileEntry?.kind === 'deleted';
                if (!canStillRenderDiff) {
                    setError(failedReadError);
                }
            }
            if (sessionState?.status !== 'waiting') {
                setIsLoading(false);
            }
        }
    }, [diffMode, fileEntry?.kind, filePath, sessionId, sessionPath, sessionsReady]);

    React.useEffect(() => {
        refreshAll();
    }, [refreshAll]);

    React.useEffect(() => {
        if (error) {
            Modal.alert(t('common.error'), error);
        }
    }, [error]);

    React.useEffect(() => {
        if (diffContent) {
            setDisplayMode('diff');
        } else if (fileContent) {
            setDisplayMode('file');
        }
    }, [diffContent, fileContent]);

    const {
        isApplyingStage,
        handleStage,
        applySelectedLines,
    } = useFileScmStageActions({
        sessionId,
        sessionPath,
        filePath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        diffMode,
        diffContent,
        lineSelectionEnabled,
        includeExcludeEnabled,
        selectedLineIndexes,
        refreshAll,
        setSelectedLineIndexes,
    });

    const toggleSelectedLine = React.useCallback((index: number) => {
        if (!lineSelectionEnabled) return;
        setSelectedLineIndexes((previous) => {
            const next = new Set(previous);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    }, [lineSelectionEnabled]);

    const fileName = filePath.split('/').pop() || filePath;
    const filePathDir = filePath.split('/').slice(0, -1).join('/');
    const language = getFileLanguageFromPath(filePath);

    if (isLoading) {
        return <FileLoadingState theme={theme} fileName={fileName} />;
    }

    if (error) {
        return <FileErrorState theme={theme} message={error} />;
    }

    if (fileContent?.isBinary) {
        return <FileBinaryState theme={theme} fileName={fileName} />;
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <FileHeader theme={theme} fileName={fileName} filePathDir={filePathDir} />

            {diffContent !== null && (
                <FileActionToolbar
                    theme={theme}
                    displayMode={displayMode}
                    onDisplayMode={setDisplayMode}
                    diffMode={diffMode}
                    onDiffMode={setDiffMode}
                    hasPendingDelta={hasPendingDelta}
                    hasIncludedDelta={hasIncludedDelta}
                    isUntrackedFile={fileEntry?.kind === 'untracked'}
                    scmWriteEnabled={scmWriteEnabled}
                    includeExcludeEnabled={includeExcludeEnabled}
                    virtualSelectionEnabled={virtualSelectionEnabled}
                    isSelectedForCommit={isSelectedForCommit}
                    lineSelectionEnabled={lineSelectionEnabled}
                    selectedLineCount={selectedLineIndexes.size}
                    isApplyingStage={isApplyingStage}
                    inFlightScmOperation={inFlightScmOperation}
                    onStageFile={() => {
                        void handleStage(true);
                    }}
                    onUnstageFile={() => {
                        void handleStage(false);
                    }}
                    onApplySelectedLines={() => {
                        void applySelectedLines();
                    }}
                    onClearSelection={() => setSelectedLineIndexes(new Set())}
                />
            )}

            <FileContentPanel
                theme={theme}
                displayMode={displayMode}
                diffContent={diffContent}
                fileContent={fileContent?.content ?? ''}
                language={language}
                selectedLineIndexes={selectedLineIndexes}
                lineSelectionEnabled={lineSelectionEnabled}
                onToggleLine={toggleSelectedLine}
            />
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
