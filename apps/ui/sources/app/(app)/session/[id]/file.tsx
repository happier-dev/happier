import * as React from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { FileActionToolbar, type FileDiffMode } from '@/components/sessions/files/file/FileActionToolbar';
import { FileContentPanel } from '@/components/sessions/files/file/FileContentPanel';
import { FileHeader } from '@/components/sessions/files/file/FileHeader';
import { FileBinaryState, FileErrorState, FileLoadingState } from '@/components/sessions/files/file/FileScreenState';
import { FileEditorPanel } from '@/components/sessions/files/file/editor/FileEditorPanel';
import {
    sessionScmDiffFile,
    sessionReadFile,
    sessionWriteFile,
} from '@/sync/ops';
import {
    storage,
    useSession,
    useSessions,
    useSessionReviewCommentsDrafts,
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
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { parseSessionFileDeepLinkAnchor } from '@/utils/url/sessionFileDeepLink';

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
    const deepLinkAnchor = React.useMemo(
        () => parseSessionFileDeepLinkAnchor(searchParams as any),
        [searchParams]
    );
    const deepLinkKey = React.useMemo(() => {
        if (!deepLinkAnchor) return '';
        const a = deepLinkAnchor.anchor;
        if (a.kind === 'fileLine') return `file:fileLine:${a.startLine}`;
        return `diff:diffLine:${a.startLine}:${a.side}:${a.oldLine ?? ''}:${a.newLine ?? ''}`;
    }, [deepLinkAnchor]);

    const scmCommitStrategy = useSetting('scmCommitStrategy');
    const scmDefaultDiffModeByBackend = useSetting('scmDefaultDiffModeByBackend');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments');
    const fileEditorFeatureEnabled = useFeatureEnabled('files.editor');
    const showLineNumbers = useSetting('showLineNumbers');
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    const filesEditorAutoSave = useSetting('filesEditorAutoSave');
    const filesEditorChangeDebounceMs = useSetting('filesEditorChangeDebounceMs');
    const filesEditorMaxFileBytes = useSetting('filesEditorMaxFileBytes');
    const filesEditorBridgeMaxChunkBytes = useSetting('filesEditorBridgeMaxChunkBytes');
    const filesEditorWebMonacoEnabled = useSetting('filesEditorWebMonacoEnabled');
    const filesEditorNativeCodeMirrorEnabled = useSetting('filesEditorNativeCodeMirrorEnabled');
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
    const [isEditingFile, setIsEditingFile] = React.useState(false);
    const [editorResetKey, setEditorResetKey] = React.useState(0);
    const [editorOriginalText, setEditorOriginalText] = React.useState('');
    const [editorText, setEditorText] = React.useState('');
    const [isSavingEdits, setIsSavingEdits] = React.useState(false);
    const [fileWriteSupported, setFileWriteSupported] = React.useState(true);
    type ParsedDeepLink = NonNullable<ReturnType<typeof parseSessionFileDeepLinkAnchor>>;
    const [jumpToAnchor, setJumpToAnchor] = React.useState<ParsedDeepLink['anchor'] | null>(deepLinkAnchor?.anchor ?? null);

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
        // Prefer explicit deep-link source when provided.
        if (deepLinkAnchor?.source === 'file') {
            if (fileContent) setDisplayMode('file');
            return;
        }
        if (deepLinkAnchor?.source === 'diff') {
            if (diffContent) setDisplayMode('diff');
            return;
        }

        if (diffContent) setDisplayMode('diff');
        else if (fileContent) setDisplayMode('file');
    }, [deepLinkAnchor?.source, diffContent, fileContent]);

    React.useEffect(() => {
        if (!deepLinkAnchor) {
            setJumpToAnchor(null);
            return;
        }

        setJumpToAnchor(deepLinkAnchor.anchor);

        const timer = setTimeout(() => {
            setJumpToAnchor(null);
        }, 8000);

        return () => clearTimeout(timer);
    }, [deepLinkKey]);

    React.useEffect(() => {
        if (displayMode !== 'file') {
            setIsEditingFile(false);
        }
    }, [displayMode]);

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
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(filePath);
    const reviewCommentDrafts = useSessionReviewCommentsDrafts(sessionId);

    const editorSurfaceEnabled = fileWriteSupported
        && fileEditorFeatureEnabled === true
        && (Platform.OS === 'web' ? filesEditorWebMonacoEnabled === true : filesEditorNativeCodeMirrorEnabled === true);

    const editorDirty = isEditingFile && editorText !== editorOriginalText;

    const startEditingFile = React.useCallback(() => {
        if (!editorSurfaceEnabled) return;
        if (!fileContent || fileContent.isBinary) return;
        const content = fileContent.content ?? '';
        if (content.length > filesEditorMaxFileBytes) {
            Modal.alert(t('common.error'), `File is too large to edit in-app (${content.length} bytes).`);
            return;
        }
        setEditorOriginalText(content);
        setEditorText(content);
        setEditorResetKey((k) => k + 1);
        setIsEditingFile(true);
    }, [editorSurfaceEnabled, fileContent, filesEditorMaxFileBytes]);

    const cancelEditingFile = React.useCallback(() => {
        setIsEditingFile(false);
        setEditorText('');
        setEditorOriginalText('');
        setEditorResetKey((k) => k + 1);
    }, []);

    const saveEditingFile = React.useCallback(async () => {
        if (!isEditingFile) return;
        if (!editorDirty) return;
        if (isSavingEdits) return;

        if (editorText.length > filesEditorMaxFileBytes) {
            Modal.alert(t('common.error'), `File is too large to edit in-app (${editorText.length} bytes).`);
            return;
        }

        try {
            setIsSavingEdits(true);
            // Best-effort conflict check: ensure the file didn't change since editing began.
            try {
                const latest = await sessionReadFile(sessionId, filePath);
                if (latest.success && latest.content) {
                    const latestDecoded = decodeUtf8Base64(latest.content);
                    if (latestDecoded !== editorOriginalText) {
                        const shouldOverwrite = await Modal.confirm(
                            t('common.unsavedChangesWarning'),
                            'This file changed since you started editing. Overwrite the latest version?',
                            { confirmText: t('common.continue'), cancelText: t('common.cancel'), destructive: true },
                        );
                        if (!shouldOverwrite) {
                            return;
                        }
                    }
                }
            } catch {
                // Ignore conflict check failures and proceed with a best-effort write.
            }

            const response = await sessionWriteFile(sessionId, filePath, editorText);
            if (!response.success) {
                if (response.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE || response.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
                    setFileWriteSupported(false);
                    setIsEditingFile(false);
                    Modal.alert(t('common.error'), 'File editing is not supported by this CLI/daemon. Update to a newer version to enable write operations.');
                    return;
                }
                Modal.alert(t('common.error'), response.error || 'Failed to write file');
                return;
            }
            setIsEditingFile(false);
            setEditorOriginalText(editorText);
            await refreshAll();
        } catch (err) {
            Modal.alert(t('common.error'), err instanceof Error ? err.message : 'Failed to write file');
        } finally {
            setIsSavingEdits(false);
        }
    }, [editorDirty, editorOriginalText, editorText, filePath, filesEditorMaxFileBytes, isEditingFile, isSavingEdits, refreshAll, sessionId]);

    React.useEffect(() => {
        if (!isEditingFile) return;
        if (!filesEditorAutoSave) return;
        if (!editorDirty) return;
        const handle = setTimeout(() => {
            void saveEditingFile();
        }, filesEditorChangeDebounceMs);
        return () => clearTimeout(handle);
    }, [editorDirty, filesEditorAutoSave, filesEditorChangeDebounceMs, isEditingFile, saveEditingFile]);

    const handleDisplayMode = React.useCallback((mode: 'file' | 'diff') => {
        setDisplayMode(mode);
        if (mode !== 'file') {
            setIsEditingFile(false);
        }
    }, []);

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
                    onDisplayMode={handleDisplayMode}
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
                    fileEditorEnabled={editorSurfaceEnabled}
                    isEditingFile={isEditingFile}
                    fileEditorDirty={editorDirty}
                    fileEditorBusy={isSavingEdits}
                    onStartEditingFile={startEditingFile}
                    onCancelEditingFile={cancelEditingFile}
                    onSaveEditingFile={() => {
                        void saveEditingFile();
                    }}
                />
            )}

            {displayMode === 'file' && isEditingFile && fileContent ? (
                <FileEditorPanel
                    theme={theme}
                    resetKey={`${editorResetKey}`}
                    value={editorText}
                    language={language}
                    onChange={setEditorText}
                    wrapLines={wrapLinesInDiffs}
                    showLineNumbers={showLineNumbers}
                    changeDebounceMs={filesEditorChangeDebounceMs}
                    bridgeMaxChunkBytes={filesEditorBridgeMaxChunkBytes}
                />
            ) : (
                <FileContentPanel
                    theme={theme}
                    displayMode={displayMode}
                    sessionId={sessionId}
                    filePath={filePath}
                    diffContent={diffContent}
                    fileContent={fileContent ? fileContent.content : null}
                    language={language}
                    syntaxHighlighting={syntaxHighlighting}
                    selectedLineIndexes={selectedLineIndexes}
                    lineSelectionEnabled={lineSelectionEnabled}
                    onToggleLine={toggleSelectedLine}
                    reviewCommentsEnabled={reviewCommentsEnabled}
                    reviewCommentDrafts={reviewCommentDrafts}
                    jumpToAnchor={jumpToAnchor}
                    onUpsertReviewCommentDraft={(draft) => {
                        storage.getState().upsertSessionReviewCommentDraft(sessionId, draft);
                    }}
                    onDeleteReviewCommentDraft={(commentId) => {
                        storage.getState().deleteSessionReviewCommentDraft(sessionId, commentId);
                    }}
                    onReviewCommentError={(message) => {
                        Modal.alert(t('common.error'), message);
                    }}
                />
            )}
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
