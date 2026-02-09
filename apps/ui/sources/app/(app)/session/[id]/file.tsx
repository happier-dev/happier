import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { FileActionToolbar } from './file/components/FileActionToolbar';
import { FileContentPanel } from './file/components/FileContentPanel';
import { FileHeader } from './file/components/FileHeader';
import { FileBinaryState, FileErrorState, FileLoadingState } from './file/components/FileScreenState';
import {
    sessionGitDiffFile,
    sessionReadFile,
} from '@/sync/ops';
import { storage, useSessionProjectGitInFlightOperation, useSessionProjectGitSnapshot, useSetting } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { decodeBase64 } from '@/encryption/base64';
import { buildFileLineSelectionFingerprint, canUseLineSelection } from '@/sync/git/gitLineSelection';
import { resolveGitWriteEnabled } from '@/sync/git/operations/featureFlags';
import { getFileLanguageFromPath, isBinaryContent, isKnownBinaryPath } from '@/sync/git/utils/filePresentation';
import { decodeSessionFilePathParam } from '@/sync/git/utils/filePathParam';
import { useFileGitStageActions } from './file/hooks/useFileGitStageActions';

interface FileContent {
    content: string;
    isBinary: boolean;
}

function decodeUtf8Base64(base64: string): string {
    const bytes = decodeBase64(base64);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export default function FileScreen() {
    const { theme } = useUnistyles();
    const { id: sessionIdParam } = useLocalSearchParams<{ id: string }>();
    const sessionId = sessionIdParam || '';
    const searchParams = useLocalSearchParams();

    const experiments = useSetting('experiments');
    const expGitOperations = useSetting('expGitOperations');
    const gitWriteEnabled = resolveGitWriteEnabled({
        experiments,
        expGitOperations,
    });
    const sessionPath = storage.getState().sessions[sessionId]?.metadata?.path ?? null;

    const encodedPath = searchParams.path as string;
    const filePath = decodeSessionFilePathParam(encodedPath);

    const gitSnapshot = useSessionProjectGitSnapshot(sessionId);
    const inFlightGitOperation = useSessionProjectGitInFlightOperation(sessionId);
    const fileEntry = React.useMemo(
        () => gitSnapshot?.entries.find((entry) => entry.path === filePath) ?? null,
        [filePath, gitSnapshot]
    );
    const hasConflicts = gitSnapshot?.hasConflicts === true;

    const [fileContent, setFileContent] = React.useState<FileContent | null>(null);
    const [diffContent, setDiffContent] = React.useState<string | null>(null);
    const [displayMode, setDisplayMode] = React.useState<'file' | 'diff'>('diff');
    const [diffMode, setDiffMode] = React.useState<'staged' | 'unstaged' | 'both'>('unstaged');
    const [isLoading, setIsLoading] = React.useState(true);
    const [selectedLineIndexes, setSelectedLineIndexes] = React.useState<Set<number>>(new Set());
    const [error, setError] = React.useState<string | null>(null);

    const hasStagedDelta = fileEntry?.hasStagedDelta === true;
    const hasUnstagedDelta = fileEntry?.hasUnstagedDelta === true;
    const lineSelectionFingerprint = React.useMemo(
        () => buildFileLineSelectionFingerprint(fileEntry),
        [fileEntry]
    );
    const lineSelectionEnabled = canUseLineSelection({
        gitWriteEnabled,
        hasConflicts,
        isBinary: fileEntry?.stats.isBinary === true,
        diffMode,
        diffContent,
    });

    React.useEffect(() => {
        if (hasStagedDelta && hasUnstagedDelta) {
            setDiffMode('both');
            return;
        }
        if (hasStagedDelta) {
            setDiffMode('staged');
            return;
        }
        setDiffMode('unstaged');
    }, [hasStagedDelta, hasUnstagedDelta]);

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

        try {
            setIsLoading(true);
            setError(null);

            const session = storage.getState().sessions[sessionId];
            const sessionPath = session?.metadata?.path;

            if (!sessionPath || !sessionId) {
                setError('Session path is unavailable');
                return;
            }

            const diffResponse = await sessionGitDiffFile(sessionId, {
                cwd: sessionPath,
                path: filePath,
                mode: diffMode,
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
            setIsLoading(false);
        }
    }, [diffMode, fileEntry?.kind, filePath, sessionId]);

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
    } = useFileGitStageActions({
        sessionId,
        sessionPath,
        filePath,
        gitSnapshot,
        gitWriteEnabled,
        diffMode,
        diffContent,
        lineSelectionEnabled,
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
                    hasUnstagedDelta={hasUnstagedDelta}
                    hasStagedDelta={hasStagedDelta}
                    gitWriteEnabled={gitWriteEnabled}
                    lineSelectionEnabled={lineSelectionEnabled}
                    selectedLineCount={selectedLineIndexes.size}
                    isApplyingStage={isApplyingStage}
                    hasConflicts={hasConflicts}
                    inFlightGitOperation={inFlightGitOperation}
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
