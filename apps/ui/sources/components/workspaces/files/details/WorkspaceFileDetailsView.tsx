import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { FileActionToolbar, type FileDiffMode } from '@/components/workspaces/files/file/FileActionToolbar';
import { FileBinaryState, FileErrorState, FileLoadingState } from '@/components/workspaces/files/file/FileScreenState';
import { FileContentPanel } from '@/components/workspaces/files/file/FileContentPanel';
import { FileEditorPanel } from '@/components/workspaces/files/file/editor/FileEditorPanel';
import { WorkspaceFileDownloadButton } from '@/components/workspaces/files/file/WorkspaceFileDownloadButton';
import { WorkspaceAugmentedScmChangeDiscardButton } from '@/components/workspaces/files/details/sessionAugmentation/WorkspaceAugmentedScmChangeDiscardButton';

import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { buildFileLineSelectionFingerprint, canUseLineSelection } from '@/scm/scmLineSelection';
import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { allowsLiveStaging, isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import { resolveDefaultDiffModeForFile } from '@/scm/diff/defaultMode';
import type { ScmDiffArea } from '@happier-dev/protocol';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { resolveShowDiffToggle } from '@/components/workspaces/files/details/workspaceFileDetails/resolveShowDiffToggle';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { refreshWorkspaceFileDetails, type WorkspaceFileDetailsFileContent } from '@/components/workspaces/files/details/workspaceFileDetails/refreshWorkspaceFileDetails';
import { useWorkspaceFileEditorState } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorState';
import {
    useProjectForSession,
    useSession,
    useSetting,
    useWorkspaceReviewCommentsDrafts,
    useWorkspaceScmCommitSelectionPatches,
    useWorkspaceScmCommitSelectionPaths,
    useWorkspaceScmInFlightOperation,
    useWorkspaceScmSnapshot,
} from '@/sync/domains/state/storage';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useFileScmStageActions } from '@/hooks/session/files/useFileScmStageActions';
import { useWorkspaceFileScmStageActions } from '@/hooks/workspaces/scm/useWorkspaceFileScmStageActions';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { resolveSessionWorkspacePath } from '@/sync/domains/session/resolveSessionWorkspacePath';

export type WorkspaceFileDeepLinkAnchor = Readonly<{
    source: ReviewCommentSource;
    anchor: ReviewCommentAnchor;
}>;

export type WorkspaceFileDetailsViewProps = Readonly<{
    scopeId: string;
    scope: WorkspaceScopeBase | null;
    filePath: string;
    deepLinkAnchor?: WorkspaceFileDeepLinkAnchor | null;
    sessionIdForAugmentation?: string | null;
    presentation?: 'screen' | 'panel';
    onStartEditingFile?: () => void;
}>;

type WorkspaceFileDetailsPersistedDraft = Readonly<{
    isEditingFile: boolean;
    editorOriginalText: string;
    editorText: string;
}>;

function readWorkspaceFileDetailsPersistedDraft(value: unknown): WorkspaceFileDetailsPersistedDraft | null {
    if (!value || typeof value !== 'object') return null;
    const maybe = value as { isEditingFile?: unknown; editorOriginalText?: unknown; editorText?: unknown };
    if (typeof maybe.isEditingFile !== 'boolean') return null;
    if (typeof maybe.editorOriginalText !== 'string') return null;
    if (typeof maybe.editorText !== 'string') return null;
    return {
        isEditingFile: maybe.isEditingFile,
        editorOriginalText: maybe.editorOriginalText,
        editorText: maybe.editorText,
    };
}

export function WorkspaceFileDetailsView(props: WorkspaceFileDetailsViewProps) {
    const { theme } = useUnistyles();
    const mountedRef = useMountedRef();
    const presentation = props.presentation ?? 'screen';
    const constrainWidth = presentation === 'screen';
    const pane = useAppPaneScope(props.scopeId);
    const setDetailsTabState = pane.setDetailsTabState;
    const filePath = props.filePath;
    const scope = props.scope;

    const sessionId = (props.sessionIdForAugmentation ?? '').trim();
    const session = useSession(sessionId);
    const project = useProjectForSession(sessionId);
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: session?.metadata?.path ?? null,
        projectPath: project?.key?.rootPath ?? (scope?.rootPath ?? null),
    });
    const downloadActionsAvailable = Boolean(scope);

    const tabKey = React.useMemo(() => `file:${filePath}`, [filePath]);
    const persistedDraft = readWorkspaceFileDetailsPersistedDraft(pane.scopeState?.details?.tabState?.[tabKey]);
    const persistDraft = React.useCallback((draft: WorkspaceFileDetailsPersistedDraft | null) => {
        setDetailsTabState(tabKey, draft);
    }, [setDetailsTabState, tabKey]);

    const deepLinkAnchor = props.deepLinkAnchor ?? null;
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

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const scmSnapshot = useWorkspaceScmSnapshot(scope);
    const commitSelectionPaths = useWorkspaceScmCommitSelectionPaths(scope);
    const commitSelectionPatches = useWorkspaceScmCommitSelectionPatches(scope);
    const inFlightScmOperation = useWorkspaceScmInFlightOperation(scope);
    const fileEntry = React.useMemo(
        () => scmSnapshot?.entries.find((entry) => entry.path === filePath) ?? null,
        [filePath, scmSnapshot]
    );
    const hasConflicts = scmSnapshot?.hasConflicts === true;

    const [fileContent, setFileContent] = React.useState<WorkspaceFileDetailsFileContent | null>(null);
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
            if (!scope) {
                keepLoading = true;
                return;
            }

            if (!background) {
                setIsLoading(true);
                setError(null);
            }

            const result = await refreshWorkspaceFileDetails({
                scope,
                filePath,
                diffMode,
                fileEntryKind: fileEntry?.kind ?? null,
            });

            setDiffContent(result.diffContent);
            setFileContent(result.fileContent);
            setFileWriteSupported(result.fileWriteSupported);
            hasLoadedOnceRef.current = true;
            if (result.error) {
                setError(result.error);
                return;
            }
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
    }, [diffMode, fileEntry?.kind, filePath, scope]);

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

    const sessionStageActions = useFileScmStageActions({
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

    const workspaceStageActions = useWorkspaceFileScmStageActions({
        scope,
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

    const { isApplyingStage, handleStage, applySelectedLines } = sessionId ? sessionStageActions : workspaceStageActions;

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
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(scope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(scope);

    const {
        editorSurfaceEnabled,
        isEditingFile,
        editorResetKey,
        editorSeedText,
        editorHandleRef,
        onEditorChange,
        isSavingEdits,
        editorDirty,
        editorTooLarge,
        editorChunkTooLarge,
        startEditingFile,
        cancelEditingFile,
        saveFileEdits,
    } = useWorkspaceFileEditorState({
        scope: scope ?? { serverId: 'unknown', machineId: 'unknown', rootPath: '/' },
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

    const previewTooLarge = error === t('files.fileTooLargeToPreview');
    const fatalError = Boolean(error) && !previewTooLarge;

    React.useEffect(() => {
        if (!previewTooLarge) return;
        if (displayMode !== 'file') return;
        setDisplayMode('diff');
    }, [displayMode, previewTooLarge]);

    if (!scope) {
        return <FileLoadingState theme={theme} filePath={filePath} />;
    }

    if (isLoading) {
        return <FileLoadingState theme={theme} filePath={filePath} />;
    }

    if (fatalError) {
        return <FileErrorState theme={theme} filePath={filePath} error={error ?? t('common.error')} onRetry={onRefresh} />;
    }

    const isBinaryFile = fileContent?.isBinary === true;
    const showDownloadAction = downloadActionsAvailable && (previewTooLarge || isBinaryFile);
    const imagePreviewUri = (() => {
        const base64 = fileContent?.binaryBase64 ?? null;
        const mime = fileContent?.binaryMime ?? null;
        if (typeof base64 !== 'string' || base64.trim().length === 0) return null;
        if (typeof mime !== 'string' || mime.trim().length === 0) return null;
        return `data:${mime};base64,${base64}`;
    })();
    const showDiscardAction = Boolean(
        sessionId
        && fileStatusForHeaderActions
        && scmWriteEnabled
        && (scmSnapshot?.capabilities?.writeDiscard === true),
    );
    const fileHeaderRightElement = showDownloadAction || showDiscardAction ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {showDownloadAction ? (
                <WorkspaceFileDownloadButton
                    testID="file-header-download"
                    workspaceScope={scope}
                    path={filePath}
                    asZip={false}
                />
            ) : null}
            {sessionId && fileStatusForHeaderActions && showDiscardAction ? (
                <WorkspaceAugmentedScmChangeDiscardButton
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
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
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
                    diffMode={diffMode}
                    onDiffMode={setDiffMode}
                    hasPendingDelta={hasPendingDelta}
                    hasIncludedDelta={hasIncludedDelta}
                    isUntrackedFile={fileEntry?.kind === 'untracked'}
                    scmWriteEnabled={scmWriteEnabled && Boolean(scope)}
                    includeExcludeEnabled={includeExcludeEnabled && Boolean(scope)}
                    virtualSelectionEnabled={virtualSelectionEnabled && Boolean(scope)}
                    isSelectedForCommit={isSelectedForCommit}
                    lineSelectionEnabled={lineSelectionEnabled && Boolean(scope)}
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
                {previewTooLarge && error ? (
                    <View
                        testID="file-preview-unavailable-banner"
                        style={{
                            marginHorizontal: 16,
                            marginBottom: 12,
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: theme.colors.divider,
                            backgroundColor: theme.colors.surfaceHigh,
                        }}
                    >
                        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                            {error}
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
                {displayMode === 'file' && isEditingFile ? (
                    <FileEditorPanel
                        theme={theme}
                        resetKey={String(editorResetKey)}
                        editorRef={editorHandleRef}
                        value={editorSeedText}
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
                        lineSelectionEnabled={lineSelectionEnabled && Boolean(scope)}
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
