import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { FileActionToolbar, type FileDiffMode, type FileDisplayMode } from '@/components/sessions/files/file/FileActionToolbar';
import { FileContentPanel } from '@/components/sessions/files/file/FileContentPanel';
import { FileDownloadButton } from '@/components/sessions/files/file/FileDownloadButton';
import { FileBinaryState, FileErrorState, FileLoadingState } from '@/components/sessions/files/file/FileScreenState';
import { FileEditorPanel } from '@/components/sessions/files/file/editor/FileEditorPanel';
import { RichMarkdownEditorPanel } from '@/components/ui/markdown/editor/RichMarkdownEditorPanel';
import { ScmChangeDiscardButton } from '@/components/sessions/sourceControl/changes/ScmChangeDiscardButton';
import {
    useSessionsReady,
    useSessionWorkspacePath,
    useWorkspaceReviewCommentsDrafts,
    useSessionProjectScmCommitSelectionPaths,
    useSessionProjectScmCommitSelectionPatches,
    useSessionProjectScmInFlightOperation,
    useSessionProjectScmSnapshot,
    useSetting,
} from '@/sync/domains/state/storage';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { buildFileLineSelectionFingerprint, canStartLineSelection, canUseLineSelection } from '@/scm/scmLineSelection';
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
import { useMarkdownFileEditMode } from './sessionFileDetails/useMarkdownFileEditMode';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/sessions/reviews/comments/useWorkspaceReviewCommentDraftHandlers';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { resolveShowDiffToggle } from './sessionFileDetails/resolveShowDiffToggle';
import { resolveFileDetailsDisplayMode } from './sessionFileDetails/resolveFileDetailsDisplayMode';
import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useSessionFileDownloadAvailability } from '@/components/sessions/files/useSessionFileDownloadAvailability';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { useSessionImagePreview } from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';
import { extractSelectedDiffLineKeysFromPatch } from '@/scm/scmPatchSelection';
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
        | Readonly<{ isEditingFile: boolean; editorOriginalText: string; editorOriginalHash?: string | null; editorText: string }>
        | null
        | undefined;
    const persistDraft = React.useCallback((draft: Readonly<{ isEditingFile: boolean; editorOriginalText: string; editorOriginalHash?: string | null; editorText: string }> | null) => {
        setDetailsTabState(tabKey, draft);
    }, [setDetailsTabState, tabKey]);

    const deepLinkKey = React.useMemo(() => {
        if (!deepLinkAnchor) return '';
        const a = deepLinkAnchor.anchor;
        if (a.kind === 'fileLine') return `file:fileLine:${a.startLine}`;
        if (a.kind === 'diffLine') return `diff:diffLine:${a.startLine}:${a.side}:${a.oldLine ?? ''}:${a.newLine ?? ''}`;
        if (a.kind === 'line') return `${deepLinkAnchor.source}:line:${a.line}:${a.side ?? ''}:${a.lineHash ?? ''}`;
        return `${deepLinkAnchor.source}:range:${a.startLine}:${a.endLine}:${a.side ?? ''}:${a.startLineHash ?? ''}:${a.endLineHash ?? ''}`;
    }, [deepLinkAnchor]);

    const scmCommitStrategy = useSetting('scmCommitStrategy');
    const scmDefaultDiffModeByBackend = useSetting('scmDefaultDiffModeByBackend');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const reviewCommentsFeatureEnabled = useFeatureEnabled('files.reviewComments');
    const fileEditorFeatureEnabled = useFeatureEnabled('files.editor');
    const markdownRichEditorFeatureEnabled = useFeatureEnabled('files.markdownRichEditor');
    const showLineNumbers = useSetting('showLineNumbers');
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    const filesEditorAutoSave = useSetting('filesEditorAutoSave');
    const filesEditorChangeDebounceMs = useSetting('filesEditorChangeDebounceMs');
    const filesEditorMaxFileBytes = useSetting('filesEditorMaxFileBytes');
    const filesEditorBridgeMaxChunkBytes = useSetting('filesEditorBridgeMaxChunkBytes');
    const filesImagePreviewMaxBytes = useSetting('filesImagePreviewMaxBytes');
    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });
    const filesEditorWebMonacoEnabled = useSetting('filesEditorWebMonacoEnabled');
    const filesEditorNativeCodeMirrorEnabled = useSetting('filesEditorNativeCodeMirrorEnabled');
    const sessionsReady = useSessionsReady();
    const sessionPath = useSessionWorkspacePath(sessionId);
    const downloadActionsAvailable = useSessionFileDownloadAvailability(sessionId);

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
    const [displayMode, setDisplayMode] = React.useState<FileDisplayMode>(() => (
        persistedDraft?.isEditingFile ? 'file' : 'diff'
    ));
    const [diffMode, setDiffMode] = React.useState<FileDiffMode>('pending');
    const [isLoading, setIsLoading] = React.useState(true);
    const [selectedLineKeys, setSelectedLineKeys] = React.useState<Set<string>>(new Set());
    const [commitSelectionModeActive, setCommitSelectionModeActive] = React.useState(false);
    const [reviewCommentModeActive, setReviewCommentModeActive] = React.useState(false);
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
    const appliedLineSelectionKeys = React.useMemo(() => {
        const patch = commitSelectionPatches.find((entry) => entry.path === filePath)?.patch ?? null;
        return patch ? extractSelectedDiffLineKeysFromPatch(patch) : new Set<string>();
    }, [commitSelectionPatches, filePath]);
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
    const lineSelectionCanStart = canStartLineSelection({
        scmWriteEnabled,
        includeExcludeEnabled,
        virtualLineSelectionEnabled,
        hasConflicts,
        isBinary: fileEntry?.stats.isBinary === true,
        hasPendingDelta,
        hasIncludedDelta,
        diffContent,
    });
    const effectiveLineSelectionEnabled = lineSelectionEnabled && commitSelectionModeActive;

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
        setCommitSelectionModeActive(false);
    }, [diffMode, diffContent, lineSelectionFingerprint]);

    React.useEffect(() => {
        if (!lineSelectionCanStart) {
            setSelectedLineKeys(new Set());
            setCommitSelectionModeActive(false);
        }
    }, [lineSelectionCanStart]);

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
                imagePreviewMaxBytes: filesImagePreviewMaxBytes,
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
    }, [diffMode, fileEntry?.kind, filePath, filesImagePreviewMaxBytes, sessionId, sessionPath, sessionsReady]);

    React.useEffect(() => {
        void refreshAll();
    }, [refreshAll]);

    const isBinaryFile = fileContent?.isBinary === true;
    const snapshotRefreshKey = scmSnapshot?.fetchedAt ?? null;
    const fileRefreshFingerprint = React.useMemo(
        () => `${lineSelectionFingerprint ?? 'none'}:${snapshotRefreshKey ?? 'none'}`,
        [lineSelectionFingerprint, snapshotRefreshKey],
    );
    const lastFingerprintRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const fingerprint = fileRefreshFingerprint;
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
    }, [fileRefreshFingerprint, refreshAll]);

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
        lineSelectionEnabled: effectiveLineSelectionEnabled,
        includeExcludeEnabled,
        selectedLineKeys,
        refreshAll,
        setSelectedLineKeys,
    });
    const applySelectedLinesRef = React.useRef(applySelectedLines);
    applySelectedLinesRef.current = applySelectedLines;

    const toggleSelectedLine = React.useCallback((key: string) => {
        if (!effectiveLineSelectionEnabled) return;
        setSelectedLineKeys((previous) => {
            const next = new Set(previous);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }, [effectiveLineSelectionEnabled]);

    const selectLineRange = React.useCallback((keys: readonly string[]) => {
        if (!effectiveLineSelectionEnabled) return;
        setSelectedLineKeys((previous) => {
            const next = new Set(previous);
            for (const key of keys) next.add(key);
            return next;
        });
    }, [effectiveLineSelectionEnabled]);

    const fileName = filePath.split('/').pop() || filePath;
    const filePathDir = filePath.split('/').slice(0, -1).join('/');
    const language = getFileLanguageFromPath(filePath);
    const markdownPreviewAvailable = (language === 'markdown' || language === 'mdx')
        && fileContent?.isBinary !== true
        && typeof fileContent?.content === 'string';
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(filePath);
    const reviewScope = useWorkspaceScopeForSession(sessionId);
    const reviewCommentsEnabled = reviewCommentsFeatureEnabled === true && Boolean(reviewScope);
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(reviewScope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(reviewScope);

    const {
        editorSurfaceEnabled,
        isEditingFile,
        editorResetKey,
        editorSeedText,
        editorHandleRef,
        onEditorChange,
        getEditorText,
        isSavingEdits,
        editorDirty,
        fileChangedExternally,
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
        fileHash: fileContent?.isBinary ? null : (fileContent?.contentHash ?? null),
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

    // Raw <-> Rich edit-mode state for markdown files (Lane I / R-A20). Owns the
    // flush-then-reseed dance + eligibility so this view stays thin; the rich
    // editor mounts only under `displayMode === 'file' && isEditingFile` (D5).
    const {
        markdownEditMode,
        richEligible: markdownRichEligible,
        richDisabledReason: markdownRichDisabledReason,
        seedText: markdownSeedText,
        resetKey: markdownResetKey,
        onToggle: onMarkdownEditMode,
        onUnavailable: onMarkdownEditorUnavailable,
    } = useMarkdownFileEditMode({
        filePath,
        editorSeedText,
        editorResetKey,
        editorHandleRef,
        onEditorChange,
        getEditorText,
    });

    // `.md` and `.mdx` both flow through the markdown seed machinery (so the raw
    // editor reseeds consistently), but rich editing — and therefore the Raw<->Rich
    // toggle — is offered ONLY for plain `.md` (R-A1: `.mdx` stays raw/preview-only).
    const isMarkdownFile = language === 'markdown' || language === 'mdx';
    const showMarkdownEditToggle = markdownRichEditorFeatureEnabled === true && language === 'markdown';
    const useRichMarkdownEditor = showMarkdownEditToggle && markdownEditMode === 'rich' && markdownRichEligible;

    React.useEffect(() => {
        const language = getFileLanguageFromPath(filePath);
        const markdownPreviewAvailable = (language === 'markdown' || language === 'mdx')
            && fileContent?.isBinary !== true
            && typeof fileContent?.content === 'string';
        const hasRenderableDiff = resolveShowDiffToggle({
            diffContent,
            hasPendingDelta,
            hasIncludedDelta,
            fileIsBinary: isBinaryFile,
        });
        setDisplayMode(resolveFileDetailsDisplayMode({
            persistedEditing: isEditingFile || persistedDraft?.isEditingFile === true,
            deepLinkSource: deepLinkAnchor?.source ?? null,
            hasRenderableDiff,
            hasFileContent: Boolean(fileContent),
            markdownPreviewAvailable,
        }));
    }, [deepLinkAnchor?.source, diffContent, fileContent, filePath, hasIncludedDelta, hasPendingDelta, isBinaryFile, isEditingFile, persistedDraft?.isEditingFile]);

    const handleStartEditingFile = React.useCallback(() => {
        props.onStartEditingFile?.();
        startEditingFile();
    }, [props.onStartEditingFile, startEditingFile]);

    const onStageFile = React.useCallback(() => {
        void handleStage(true);
    }, [handleStage]);

    const onUnstageFile = React.useCallback(() => {
        void handleStage(false);
    }, [handleStage]);

    const onApplySelectedLines = React.useCallback(() => {
        void applySelectedLinesRef.current();
        setCommitSelectionModeActive(false);
    }, []);

    const onClearSelection = React.useCallback(() => {
        setSelectedLineKeys(new Set());
        setCommitSelectionModeActive(false);
    }, []);

    const onStartLineSelection = React.useCallback(() => {
        if (!lineSelectionCanStart) return;
        setReviewCommentModeActive(false);
        setDisplayMode('diff');
        if (!lineSelectionEnabled) {
            setDiffContent(null);
            setDiffMode(hasPendingDelta ? 'pending' : 'included');
        }
        setSelectedLineKeys(new Set(appliedLineSelectionKeys));
        setCommitSelectionModeActive(true);
    }, [appliedLineSelectionKeys, hasPendingDelta, lineSelectionCanStart, lineSelectionEnabled]);

    const onToggleReviewCommentMode = React.useCallback((active: boolean) => {
        setReviewCommentModeActive(active);
        if (active) {
            setCommitSelectionModeActive(false);
            setSelectedLineKeys(new Set());
        }
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

    const previewTooLarge = error === t('files.fileTooLargeToPreview');
    const fatalError = Boolean(error) && !previewTooLarge;
    const binaryImagePreview = useSessionImagePreview({
        sessionId,
        filePath,
        enabled: fileContent?.isBinary === true && typeof fileContent.binaryMime === 'string' && fileContent.binaryMime.startsWith('image/'),
        cacheKey: lineSelectionFingerprint,
        mimeType: fileContent?.binaryMime ?? null,
        sizeBytes: fileContent?.binarySizeBytes ?? null,
    });

    React.useEffect(() => {
        if (!previewTooLarge) return;
        if (displayMode !== 'file' && displayMode !== 'markdown') return;
        setDisplayMode('diff');
    }, [displayMode, previewTooLarge]);

    if (isLoading) {
        return <FileLoadingState theme={theme} filePath={filePath} />;
    }

    if (fatalError) {
        return <FileErrorState theme={theme} filePath={filePath} error={error ?? t('common.error')} onRetry={onRefresh} />;
    }
    const showDownloadAction = downloadActionsAvailable && (previewTooLarge || isBinaryFile);
    const imagePreviewUri = binaryImagePreview.status === 'loaded' ? binaryImagePreview.uri : null;
    const imagePreviewSvgXml = binaryImagePreview.status === 'loaded' ? binaryImagePreview.svgXml : null;
    const fileHeaderRightElement =
        showDownloadAction || (fileStatusForHeaderActions && scmWriteEnabled && (scmSnapshot?.capabilities?.writeDiscard === true)) ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {showDownloadAction ? (
                    <FileDownloadButton
                        testID="file-header-download"
                        sessionId={sessionId}
                        path={filePath}
                        asZip={false}
                    />
                ) : null}
                {fileStatusForHeaderActions && scmWriteEnabled && (scmSnapshot?.capabilities?.writeDiscard === true) ? (
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
                ) : null}
            </View>
        ) : null;

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface.base }]}>
            <View
                style={{
                    width: '100%',
                    ...(constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center' } : { maxWidth: '100%' }),
                }}
            >
                <FileActionToolbar
                    theme={theme}
                    fileName={fileName}
                    filePathDir={filePathDir}
                    rightElement={fileHeaderRightElement}
                    displayMode={displayMode}
                    onDisplayMode={setDisplayMode}
                    showDiffToggle={resolveShowDiffToggle({ diffContent, hasPendingDelta, hasIncludedDelta, fileIsBinary: isBinaryFile })}
                    showFileToggle={Boolean(fileContent)}
                    showMarkdownToggle={markdownPreviewAvailable}
                    showWrapLinesToggle={!isBinaryFile && !previewTooLarge && displayMode !== 'markdown'}
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
                    lineSelectionCanStart={lineSelectionCanStart}
                    lineSelectionActive={commitSelectionModeActive}
                    reviewCommentsEnabled={reviewCommentsEnabled}
                    commentModeActive={reviewCommentModeActive}
                    selectedLineCount={selectedLineKeys.size}
                    isApplyingStage={isApplyingStage}
                    inFlightScmOperation={inFlightScmOperation}
                    onStageFile={onStageFile}
                    onUnstageFile={onUnstageFile}
                    onApplySelectedLines={onApplySelectedLines}
                    onClearSelection={onClearSelection}
                    onStartLineSelection={onStartLineSelection}
                    onToggleCommentMode={onToggleReviewCommentMode}
                    fileEditorEnabled={editorSurfaceEnabled && !editorTooLarge && !editorChunkTooLarge && !isBinaryFile}
                    isEditingFile={isEditingFile}
                    fileEditorDirty={editorDirty}
                    fileEditorBusy={isSavingEdits}
                    onStartEditingFile={handleStartEditingFile}
                    onCancelEditingFile={cancelEditingFile}
                    onSaveEditingFile={saveFileEdits}
                    showMarkdownEditToggle={showMarkdownEditToggle}
                    markdownEditMode={markdownEditMode}
                    onMarkdownEditMode={onMarkdownEditMode}
                    markdownRichEligible={markdownRichEligible}
                    markdownRichDisabledReason={markdownRichDisabledReason}
                />
                {previewTooLarge && error ? (
                    <View
                        testID="file-preview-unavailable-banner"
                        style={styles.noticeBanner}
                    >
                        <Text style={styles.noticeBannerText}>
                            {error}
                        </Text>
                    </View>
                ) : null}
                {fileChangedExternally ? (
                    <View
                        testID="file-editor-external-change-banner"
                        style={styles.noticeBanner}
                    >
                        <Text style={styles.noticeBannerText}>
                            {t('files.fileChangedExternally')}
                        </Text>
                    </View>
                ) : null}
            </View>

            <View
                style={{
                    flex: 1,
                    position: 'relative',
                    width: '100%',
                    ...(constrainWidth ? { maxWidth: layout.maxWidth, alignSelf: 'center' } : { maxWidth: '100%' }),
                }}
            >
                {displayMode === 'file' && isEditingFile && showMarkdownEditToggle ? (
                    // Plain `.md` editing: Raw<->Rich can swap, so crossfade the body
                    // switch keyed on `markdownEditMode` (R-A20 / §4.5). Only the active
                    // child mounts while not transitioning, so the surface tree stays
                    // single-mounted (preserving the existing editor testIDs/behavior).
                    <SlideTransitionSwitch
                        contentKey={markdownEditMode}
                        direction={markdownEditMode === 'rich' ? 'forward' : 'backward'}
                    >
                        {useRichMarkdownEditor ? (
                            <RichMarkdownEditorPanel
                                resetKey={markdownResetKey}
                                editorRef={editorHandleRef}
                                value={markdownSeedText}
                                onChange={onEditorChange}
                                onUnavailable={onMarkdownEditorUnavailable}
                                changeDebounceMs={typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : undefined}
                                bridgeMaxChunkBytes={typeof filesEditorBridgeMaxChunkBytes === 'number' ? filesEditorBridgeMaxChunkBytes : undefined}
                            />
                        ) : (
                            <FileEditorPanel
                                theme={theme}
                                resetKey={markdownResetKey}
                                editorRef={editorHandleRef}
                                value={markdownSeedText}
                                language={language}
                                onChange={onEditorChange}
                                wrapLines={wrapLinesInDiffs}
                                showLineNumbers={showLineNumbers}
                                changeDebounceMs={typeof filesEditorChangeDebounceMs === 'number' ? filesEditorChangeDebounceMs : undefined}
                                bridgeMaxChunkBytes={typeof filesEditorBridgeMaxChunkBytes === 'number' ? filesEditorBridgeMaxChunkBytes : undefined}
                            />
                        )}
                    </SlideTransitionSwitch>
                ) : displayMode === 'file' && isEditingFile ? (
                    <FileEditorPanel
                        theme={theme}
                        resetKey={isMarkdownFile ? markdownResetKey : String(editorResetKey)}
                        editorRef={editorHandleRef}
                        value={isMarkdownFile ? markdownSeedText : editorSeedText}
                        language={language}
                        onChange={onEditorChange}
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
                        <FileBinaryState
                            theme={theme}
                            filePath={filePath}
                            imagePreviewUri={imagePreviewUri}
                            imagePreviewSvgXml={imagePreviewSvgXml}
                        />
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
                        selectedLineKeys={commitSelectionModeActive ? selectedLineKeys : appliedLineSelectionKeys}
                        lineSelectionEnabled={effectiveLineSelectionEnabled}
                        onToggleLine={toggleSelectedLine}
                        onSelectLineRange={selectLineRange}
                        wrapLines={wrapLinesInDiffs}
                        showLineNumbers={showLineNumbers}
                        showPrefix={showLineNumbers}
                        reviewCommentsEnabled={reviewCommentsEnabled}
                        reviewCommentModeActive={reviewCommentModeActive}
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
                        <ScrollEdgeFades color={theme.colors.surface.base} size={18} edges={scrollFades.visibility} />
                        <ScrollEdgeIndicators
                            edges={scrollFades.visibility}
                            color={theme.colors.text.secondary}
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
        backgroundColor: theme.colors.surface.base,
    },
    noticeBanner: {
        marginHorizontal: 16,
        marginBottom: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    noticeBannerText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
}));
