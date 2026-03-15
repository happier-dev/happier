import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { FileActionToolbar, type FileDiffMode } from '@/components/sessions/files/file/FileActionToolbar';
import { FileContentPanel } from '@/components/sessions/files/file/FileContentPanel';
import { FileHeader } from '@/components/sessions/files/file/FileHeader';
import { FileBinaryState, FileErrorState, FileLoadingState } from '@/components/sessions/files/file/FileScreenState';
import { FileEditorPanel } from '@/components/sessions/files/file/editor/FileEditorPanel';
import { ScmChangeDiscardButton } from '@/components/sessions/sourceControl/changes/ScmChangeDiscardButton';
import {
    useSession,
    useSessions,
    useProjectForSession,
    useSessionReviewCommentsDrafts,
    useSessionProjectScmCommitSelectionPaths,
    useSessionProjectScmCommitSelectionPatches,
    useSessionProjectScmInFlightOperation,
    useSessionProjectScmSnapshot,
    useSetting,
} from '@/sync/domains/state/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { buildFileLineSelectionFingerprint, canUseLineSelection } from '@/scm/scmLineSelection';
import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { allowsLiveStaging, isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import { resolveDefaultDiffModeForFile } from '@/scm/diff/defaultMode';
import { useFileScmStageActions } from '@/hooks/session/files/useFileScmStageActions';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import type { ScmDiffArea } from '@happier-dev/protocol';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { refreshSessionFileDetails, type SessionFileDetailsFileContent } from './sessionFileDetails/refreshSessionFileDetails';
import { useSessionFileEditorState } from './sessionFileDetails/useSessionFileEditorState';
import { useSessionReviewCommentDraftHandlers } from '@/components/sessions/reviews/comments/useSessionReviewCommentDraftHandlers';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { resolveShowDiffToggle } from './sessionFileDetails/resolveShowDiffToggle';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';
export type SessionFileDeepLinkAnchor = Readonly<{
    source: ReviewCommentSource;
    anchor: ReviewCommentAnchor;
}>;

export type SessionFileDetailsViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
    filePath: string;
    deepLinkAnchor?: SessionFileDeepLinkAnchor | null;
    presentation?: 'screen' | 'panel';
    /**
     * Optional hook for outer shells (like DetailsPanel) to preserve editor-like semantics.
     * For example: auto-pin a preview tab when the user begins editing.
     */
    onStartEditingFile?: () => void;
}>;

export function SessionFileDetailsView(props: SessionFileDetailsViewProps) {
    const { theme } = useUnistyles();
    const mountedRef = useMountedRef();
    const presentation = props.presentation ?? 'screen';
    const constrainWidth = presentation === 'screen';
    const sessionId = props.sessionId;
    const pane = useAppPaneScope(props.scopeId);
    const setDetailsTabState = pane.setDetailsTabState;
    const filePath = props.filePath;
    const deepLinkAnchor = props.deepLinkAnchor ?? null;
    const tabKey = React.useMemo(() => `file:${filePath}`, [filePath]);
    const persistedDraft = pane.scopeState?.details?.tabState?.[tabKey] as any as
        | Readonly<{ isEditingFile: boolean; editorOriginalText: string; editorText: string }>
        | null
        | undefined;
    const persistDraft = React.useCallback((draft: Readonly<{ isEditingFile: boolean; editorOriginalText: string; editorText: string }> | null) => {
        setDetailsTabState(tabKey, draft);
    }, [setDetailsTabState, tabKey]);

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
    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });
    const filesEditorWebMonacoEnabled = useSetting('filesEditorWebMonacoEnabled');
    const filesEditorNativeCodeMirrorEnabled = useSetting('filesEditorNativeCodeMirrorEnabled');
    const session = useSession(sessionId);
    const project = useProjectForSession(sessionId);
    const sessionsReady = useSessions() !== null;
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: session?.metadata?.path ?? null,
        projectPath: project?.key?.path ?? null,
    });

    const scmSnapshot = useSessionProjectScmSnapshot(sessionId);
    const commitSelectionPaths = useSessionProjectScmCommitSelectionPaths(sessionId);
    const commitSelectionPatches = useSessionProjectScmCommitSelectionPatches(sessionId);
    const inFlightScmOperation = useSessionProjectScmInFlightOperation(sessionId);
    const fileEntry = React.useMemo(
        () => scmSnapshot?.entries.find((entry) => entry.path === filePath) ?? null,
        [filePath, scmSnapshot]
    );
    const hasConflicts = scmSnapshot?.hasConflicts === true;

    const [fileContent, setFileContent] = React.useState<SessionFileDetailsFileContent | null>(null);
    const [diffContent, setDiffContent] = React.useState<string | null>(null);
    const [displayMode, setDisplayMode] = React.useState<'file' | 'diff'>(() => (
        persistedDraft?.isEditingFile ? 'file' : 'diff'
    ));
    const [diffMode, setDiffMode] = React.useState<FileDiffMode>('pending');
    const [isLoading, setIsLoading] = React.useState(true);
    const [selectedLineKeys, setSelectedLineKeys] = React.useState<Set<string>>(new Set());
    const [error, setError] = React.useState<string | null>(null);
    const [fileWriteSupported, setFileWriteSupported] = React.useState(true);
    const [jumpToAnchor, setJumpToAnchor] = React.useState<ReviewCommentAnchor | null>(deepLinkAnchor?.anchor ?? null);

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
    const isSelectedForCommit = commitSelectionPaths.includes(filePath)
        || commitSelectionPatches.some((p) => p.path === filePath);
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
        setSelectedLineKeys(new Set());
    }, [diffMode, diffContent, lineSelectionFingerprint]);

    React.useEffect(() => {
        if (!lineSelectionEnabled) {
            setSelectedLineKeys(new Set());
        }
    }, [lineSelectionEnabled]);

    const hasLoadedOnceRef = React.useRef(false);
    const refreshAll = React.useCallback(async (options?: Readonly<{ background?: boolean }>) => {
        const background = options?.background === true && hasLoadedOnceRef.current === true;
        let keepLoading = false;
        try {
            if (!background) {
                setIsLoading(true);
                setError(null);
            }

            const result = await refreshSessionFileDetails({
                sessionId,
                filePath,
                diffMode,
                sessionsReady,
                sessionPath,
                fileEntryKind: fileEntry?.kind ?? null,
            });

            if (result.status === 'waiting') {
                // Keep the loading state while session metadata is still hydrating.
                keepLoading = true;
                return;
            }

            setDiffContent(result.diffContent);
            setFileContent(result.fileContent);
            setFileWriteSupported(result.fileWriteSupported);
            hasLoadedOnceRef.current = true;
            if (result.error) {
                setError(result.error);
                return;
            }

            // Editor state (if enabled) syncs to the latest file content in a dedicated hook.
        } catch (err) {
            const message = err instanceof Error ? err.message : t('files.fileReadFailed');
            setError(message);
        } finally {
            if (!keepLoading) {
                if (!background) {
                    setIsLoading(false);
                }
            }
        }
    }, [diffMode, filePath, sessionId, sessionPath, sessionsReady]);

    React.useEffect(() => {
        void refreshAll();
    }, [refreshAll]);

    const lastFingerprintRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const fingerprint = lineSelectionFingerprint ?? null;
        if (lastFingerprintRef.current === null) {
            lastFingerprintRef.current = fingerprint;
            return;
        }
        if (!hasLoadedOnceRef.current) {
            lastFingerprintRef.current = fingerprint;
            return;
        }
        if (lastFingerprintRef.current === fingerprint) return;
        lastFingerprintRef.current = fingerprint;
        void refreshAll({ background: true });
    }, [lineSelectionFingerprint, refreshAll]);

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

        // Preserve editor-like semantics: if a draft indicates the user was editing, keep the tab in file mode.
        if (persistedDraft?.isEditingFile) {
            setDisplayMode('file');
            return;
        }

        if (diffContent) setDisplayMode('diff');
        else if (fileContent) setDisplayMode('file');
    }, [deepLinkAnchor?.source, diffContent, fileContent, persistedDraft?.isEditingFile]);

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
        selectedLineKeys,
        refreshAll,
        setSelectedLineKeys,
    });

    const toggleSelectedLine = React.useCallback((key: string) => {
        if (!lineSelectionEnabled) return;
        setSelectedLineKeys((previous) => {
            const next = new Set(previous);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, [lineSelectionEnabled]);

    const fileName = filePath.split('/').pop() || filePath;
    const filePathDir = filePath.split('/').slice(0, -1).join('/');
    const language = getFileLanguageFromPath(filePath);
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(filePath);
    const reviewCommentDrafts = useSessionReviewCommentsDrafts(sessionId);
    const reviewDraftHandlers = useSessionReviewCommentDraftHandlers(sessionId);

    const {
        editorSurfaceEnabled,
        isEditingFile,
        editorResetKey,
        editorText,
        setEditorText,
        isSavingEdits,
        editorDirty,
        editorTooLarge,
        editorChunkTooLarge,
        startEditingFile,
        cancelEditingFile,
        saveFileEdits,
    } = useSessionFileEditorState({
        sessionId,
        sessionPath,
        filePath,
        displayMode,
        fileText: fileContent?.isBinary ? null : (fileContent?.content ?? null),
        fileWriteSupported,
        setFileWriteSupported,
        fileEditorFeatureEnabled: fileEditorFeatureEnabled === true,
        filesEditorWebMonacoEnabled: filesEditorWebMonacoEnabled === true,
        filesEditorNativeCodeMirrorEnabled: filesEditorNativeCodeMirrorEnabled === true,
        filesEditorAutoSave: filesEditorAutoSave === true,
        filesEditorChangeDebounceMs: typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : 0,
        filesEditorMaxFileBytes: typeof filesEditorMaxFileBytes === 'number' ? filesEditorMaxFileBytes : 0,
        filesEditorBridgeMaxChunkBytes: typeof filesEditorBridgeMaxChunkBytes === 'number' ? filesEditorBridgeMaxChunkBytes : 0,
        mountedRef,
        refreshAll,
        persistedDraft: persistedDraft ?? null,
        persistDraft,
    });

    const onStageFile = React.useCallback(() => {
        void handleStage(true);
    }, [handleStage]);

    const onUnstageFile = React.useCallback(() => {
        void handleStage(false);
    }, [handleStage]);

    const onApplySelectedLines = React.useCallback(() => {
        void applySelectedLines();
    }, [applySelectedLines]);

    const onClearSelection = React.useCallback(() => {
        setSelectedLineKeys(new Set());
    }, []);

    const onRefresh = React.useCallback(() => {
        void refreshAll();
    }, [refreshAll]);

    const fileStatusForHeaderActions = React.useMemo<ScmFileStatus | null>(() => {
        if (!fileEntry) return null;
        const segments = fileEntry.path.split('/');
        const statusFileName = segments[segments.length - 1] || fileEntry.path;
        const statusFilePath = segments.slice(0, -1).join('/');
        const useIncludedStats = fileEntry.hasIncludedDelta && !fileEntry.hasPendingDelta;
        return {
            fileName: statusFileName,
            filePath: statusFilePath,
            fullPath: fileEntry.path,
            status: fileEntry.kind,
            isIncluded: useIncludedStats,
            linesAdded: useIncludedStats ? fileEntry.stats.includedAdded : fileEntry.stats.pendingAdded,
            linesRemoved: useIncludedStats ? fileEntry.stats.includedRemoved : fileEntry.stats.pendingRemoved,
            oldPath: fileEntry.previousPath ?? undefined,
            isBinary: fileEntry.stats.isBinary,
        };
    }, [fileEntry]);

    if (isLoading) {
        return <FileLoadingState theme={theme} filePath={filePath} />;
    }

    if (error) {
        return <FileErrorState theme={theme} filePath={filePath} error={error} onRetry={onRefresh} />;
    }
    const isBinaryFile = fileContent?.isBinary === true;
    const imagePreviewUri = (() => {
        const base64 = fileContent?.binaryBase64 ?? null;
        const mime = fileContent?.binaryMime ?? null;
        if (typeof base64 !== 'string' || base64.trim().length === 0) return null;
        if (typeof mime !== 'string' || mime.trim().length === 0) return null;
        return `data:${mime};base64,${base64}`;
    })();

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <View
                style={{
                    width: '100%',
                    ...(constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center' } : { maxWidth: '100%' }),
                }}
            >
                <FileHeader
                    theme={theme}
                    fileName={fileName}
                    filePathDir={filePathDir}
                    rightElement={
                        fileStatusForHeaderActions && scmWriteEnabled && (scmSnapshot?.capabilities?.writeDiscard === true) ? (
                            <ScmChangeDiscardButton
                                sessionId={sessionId}
                                sessionPath={sessionPath}
                                snapshot={scmSnapshot ?? null}
                                scmWriteEnabled={scmWriteEnabled}
                                commitStrategy={scmCommitStrategy}
                                file={fileStatusForHeaderActions}
                                surface="file"
                                onAfterDiscard={refreshAll}
                            />
                        ) : null
                    }
                />
                <FileActionToolbar
                    theme={theme}
                    displayMode={displayMode}
                    onDisplayMode={setDisplayMode}
                    showDiffToggle={resolveShowDiffToggle({ diffContent, hasPendingDelta, hasIncludedDelta, fileIsBinary: isBinaryFile })}
                    showFileToggle={Boolean(fileContent)}
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
                    selectedLineCount={selectedLineKeys.size}
                    isApplyingStage={isApplyingStage}
                    inFlightScmOperation={inFlightScmOperation}
                    onStageFile={onStageFile}
                    onUnstageFile={onUnstageFile}
                    onApplySelectedLines={onApplySelectedLines}
                    onClearSelection={onClearSelection}
                    fileEditorEnabled={editorSurfaceEnabled && !editorTooLarge && !editorChunkTooLarge && !isBinaryFile}
                    isEditingFile={isEditingFile}
                    fileEditorDirty={editorDirty}
                    fileEditorBusy={isSavingEdits}
                    onStartEditingFile={() => {
                        props.onStartEditingFile?.();
                        startEditingFile();
                    }}
                    onCancelEditingFile={cancelEditingFile}
                    onSaveEditingFile={saveFileEdits}
                />
            </View>

            <View
                style={{
                    flex: 1,
                    position: 'relative',
                    width: '100%',
                    ...(constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center' } : { maxWidth: '100%' }),
                }}
            >
                {displayMode === 'file' && isEditingFile ? (
                    <FileEditorPanel
                        theme={theme}
                        resetKey={String(editorResetKey)}
                        value={editorText}
                        language={language}
                        onChange={setEditorText}
                        wrapLines={wrapLinesInDiffs}
                        showLineNumbers={showLineNumbers}
                        changeDebounceMs={typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : undefined}
                        bridgeMaxChunkBytes={typeof filesEditorBridgeMaxChunkBytes === 'number' ? filesEditorBridgeMaxChunkBytes : undefined}
                    />
                ) : (displayMode === 'file' && isBinaryFile) ? (
                    <ScrollView
                        style={{ flex: 1, minHeight: 0 }}
                        testID="file-details-scroll"
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                        scrollEventThrottle={16}
                    >
                        <FileBinaryState theme={theme} filePath={filePath} imagePreviewUri={imagePreviewUri} />
                    </ScrollView>
                ) : (
                    <FileContentPanel
                        theme={theme}
                        displayMode={displayMode}
                        sessionId={sessionId}
                        filePath={filePath}
                        diffContent={diffContent}
                        fileContent={fileContent?.isBinary ? null : (fileContent?.content ?? null)}
                        language={language}
                        syntaxHighlighting={syntaxHighlighting}
                        selectedLineKeys={selectedLineKeys}
                        lineSelectionEnabled={lineSelectionEnabled}
                        onToggleLine={toggleSelectedLine}
                        wrapLines={wrapLinesInDiffs}
                        showLineNumbers={showLineNumbers}
                        showPrefix={showLineNumbers}
                        reviewCommentsEnabled={reviewCommentsEnabled}
                        reviewCommentDrafts={reviewCommentDrafts}
                        onUpsertReviewCommentDraft={reviewDraftHandlers.onUpsertReviewCommentDraft}
                        onDeleteReviewCommentDraft={reviewDraftHandlers.onDeleteReviewCommentDraft}
                        onReviewCommentError={reviewDraftHandlers.onReviewCommentError}
                        jumpToAnchor={jumpToAnchor}
                        scrollTestID="file-details-scroll"
                        onLayout={scrollFades.onViewportLayout}
                        onContentSizeChange={scrollFades.onContentSizeChange}
                        onScroll={scrollFades.onScroll}
                    />
                )}

                {displayMode === 'file' && isEditingFile ? null : (
                    <>
                        <ScrollEdgeFades color={theme.colors.surface} size={18} edges={scrollFades.visibility} />
                        <ScrollEdgeIndicators
                            edges={scrollFades.visibility}
                            color={theme.colors.textSecondary}
                            size={14}
                            opacity={0.35}
                        />
                    </>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
}));
