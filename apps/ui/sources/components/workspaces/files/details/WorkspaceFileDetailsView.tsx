import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { FileActionToolbar, type FileDiffMode, type FileDisplayMode } from '@/components/workspaces/files/file/FileActionToolbar';
import { FileBinaryState, FileErrorState, FileLoadingState } from '@/components/workspaces/files/file/FileScreenState';
import { FileContentPanel } from '@/components/workspaces/files/file/FileContentPanel';
import { FileEditorPanel } from '@/components/workspaces/files/file/editor/FileEditorPanel';
import { RichMarkdownEditorPanel } from '@/components/ui/markdown/editor/RichMarkdownEditorPanel';
import { WorkspaceFileDownloadButton } from '@/components/workspaces/files/file/WorkspaceFileDownloadButton';
import { WorkspaceAugmentedScmChangeDiscardButton } from '@/components/workspaces/files/details/sessionAugmentation/WorkspaceAugmentedScmChangeDiscardButton';

import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { buildFileLineSelectionFingerprint, canStartLineSelection, canUseLineSelection } from '@/scm/scmLineSelection';
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
import { useMarkdownFileEditMode } from '@/components/workspaces/files/details/workspaceFileDetails/useMarkdownFileEditMode';
import { SlideTransitionSwitch } from '@/components/ui/motion/SlideTransitionSwitch';
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
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveFileDetailsDisplayMode } from './workspaceFileDetails/resolveFileDetailsDisplayMode';
import { resolveFileDetailsRenderableDiff } from './workspaceFileDetails/resolveFileDetailsRenderableDiff';
import { useSessionImagePreview } from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';
import { buildWorkspaceFileReferenceAnchorKey } from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';
import { extractSelectedDiffLineKeysFromPatch } from '@/scm/scmPatchSelection';

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
    editorOriginalHash?: string | null;
    editorText: string;
}>;

function readWorkspaceFileDetailsPersistedDraft(value: unknown): WorkspaceFileDetailsPersistedDraft | null {
    if (!value || typeof value !== 'object') return null;
    const maybe = value as { isEditingFile?: unknown; editorOriginalText?: unknown; editorOriginalHash?: unknown; editorText?: unknown };
    if (typeof maybe.isEditingFile !== 'boolean') return null;
    if (typeof maybe.editorOriginalText !== 'string') return null;
    if (typeof maybe.editorText !== 'string') return null;
    return {
        isEditingFile: maybe.isEditingFile,
        editorOriginalText: maybe.editorOriginalText,
        editorOriginalHash: typeof maybe.editorOriginalHash === 'string' ? maybe.editorOriginalHash : null,
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
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const project = useProjectForSession(sessionId);
    const sessionPath = resolveSessionWorkspacePath({
        sessionPath: ownerMetadata?.path ?? null,
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
        return buildWorkspaceFileReferenceAnchorKey({
            filePath,
            source: deepLinkAnchor.source,
            anchor: deepLinkAnchor.anchor,
        });
    }, [deepLinkAnchor, filePath]);

    const scmCommitStrategy = useSetting('scmCommitStrategy');
    const scmDefaultDiffModeByBackend = useSetting('scmDefaultDiffModeByBackend');
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments');
    const fileEditorFeatureEnabled = useFeatureEnabled('files.editor');
    const markdownRichEditorFeatureEnabled = useFeatureEnabled('files.markdownRichEditor');
    const showLineNumbers = useSetting('showLineNumbers');
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    const filesEditorAutoSave = useSetting('filesEditorAutoSave');
    const filesEditorChangeDebounceMs = useSetting('filesEditorChangeDebounceMs');
    const filesEditorMaxFileBytes = useSetting('filesEditorMaxFileBytes');
    const filesEditorBridgeMaxChunkBytes = useSetting('filesEditorBridgeMaxChunkBytes');
    const filesEditorWebMonacoEnabled = useSetting('filesEditorWebMonacoEnabled');
    const filesEditorNativeCodeMirrorEnabled = useSetting('filesEditorNativeCodeMirrorEnabled');
    const filesImagePreviewMaxBytes = useSetting('filesImagePreviewMaxBytes');

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
    const [displayMode, setDisplayMode] = React.useState<FileDisplayMode>(() => (
        persistedDraft?.isEditingFile ? 'file' : 'diff'
    ));
    const [diffMode, setDiffMode] = React.useState<FileDiffMode>('pending');
    const [isLoading, setIsLoading] = React.useState(true);
    const [selectedLineKeys, setSelectedLineKeys] = React.useState<Set<string>>(new Set());
    const [commitSelectionModeActive, setCommitSelectionModeActive] = React.useState(false);
    const [rangeSelectionActive, setRangeSelectionActive] = React.useState(false);
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
    const appliedSelectedLineKeys = React.useMemo(() => {
        const keys = new Set<string>();
        for (const patchSelection of commitSelectionPatches) {
            if (patchSelection.path !== filePath) continue;
            for (const key of extractSelectedDiffLineKeysFromPatch(patchSelection.patch)) {
                keys.add(key);
            }
        }
        return keys;
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
    const displayedSelectedLineKeys = commitSelectionModeActive ? selectedLineKeys : appliedSelectedLineKeys;

    React.useEffect(() => {
        const resolved = resolveDefaultDiffModeForFile({
            snapshot: scmSnapshot,
            backendOverrides: scmDefaultDiffModeByBackend as Record<string, ScmDiffArea> | undefined,
            hasIncludedDelta,
            hasPendingDelta,
        });
        setDiffMode(resolved);
    }, [hasIncludedDelta, hasPendingDelta, scmDefaultDiffModeByBackend, scmSnapshot]);

    const selectionResetKey = React.useMemo(
        () => [
            diffMode,
            diffContent ?? '',
            lineSelectionFingerprint ?? '',
        ].join('\n'),
        [diffContent, diffMode, lineSelectionFingerprint],
    );
    const previousSelectionResetRef = React.useRef<{
        key: string;
        diffContent: string | null;
    } | null>(null);
    React.useEffect(() => {
        const previous = previousSelectionResetRef.current;
        if (previous === null) {
            previousSelectionResetRef.current = { key: selectionResetKey, diffContent };
            return;
        }
        if (previous.key === selectionResetKey) return;
        previousSelectionResetRef.current = { key: selectionResetKey, diffContent };
        if (previous.diffContent === null && diffContent !== null) {
            return;
        }
        setSelectedLineKeys(new Set());
        setCommitSelectionModeActive(false);
        setRangeSelectionActive(false);
        setReviewCommentModeActive(false);
    }, [diffContent, selectionResetKey]);

    React.useEffect(() => {
        if (!lineSelectionCanStart) {
            setSelectedLineKeys(new Set());
            setCommitSelectionModeActive(false);
            setRangeSelectionActive(false);
            setReviewCommentModeActive(false);
        }
    }, [lineSelectionCanStart]);

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
                maxImagePreviewBytes: typeof filesImagePreviewMaxBytes === 'number' ? filesImagePreviewMaxBytes : null,
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
    }, [diffMode, fileEntry?.kind, filePath, filesImagePreviewMaxBytes, scope]);

    React.useEffect(() => {
        void refreshAll();
    }, [refreshAll]);

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

    const language = getFileLanguageFromPath(filePath);
    const markdownPreviewAvailable = fileContent?.isBinary !== true
        && (language === 'markdown' || language === 'mdx')
        && typeof fileContent?.content === 'string';
    const hasRenderableDiff = React.useMemo(
        () => resolveFileDetailsRenderableDiff({ diffContent }),
        [diffContent],
    );

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
        lineSelectionEnabled: effectiveLineSelectionEnabled,
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
        lineSelectionEnabled: effectiveLineSelectionEnabled,
        includeExcludeEnabled,
        selectedLineKeys,
        refreshAll,
        setSelectedLineKeys,
    });

    const { isApplyingStage, handleStage, applySelectedLines } = sessionId ? sessionStageActions : workspaceStageActions;
    const applySelectedLinesRef = React.useRef(applySelectedLines);
    applySelectedLinesRef.current = applySelectedLines;

    const toggleSelectedLine = React.useCallback((key: string) => {
        if (!effectiveLineSelectionEnabled) return;
        setRangeSelectionActive(false);
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

    const fileName = filePath.split('/').pop() || filePath;
    const filePathDir = filePath.split('/').slice(0, -1).join('/');
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
        getEditorText,
        isSavingEdits,
        editorDirty,
        fileChangedExternally,
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
        setDisplayMode(resolveFileDetailsDisplayMode({
            persistedEditing: isEditingFile || persistedDraft?.isEditingFile === true,
            deepLinkSource: deepLinkAnchor?.source ?? null,
            hasRenderableDiff,
            hasFileContent: Boolean(fileContent),
            markdownPreviewAvailable,
        }));
    }, [deepLinkAnchor?.source, fileContent, hasRenderableDiff, isEditingFile, markdownPreviewAvailable, persistedDraft?.isEditingFile]);

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

    const onApplySelectedLines = React.useCallback(async () => {
        setRangeSelectionActive(false);
        const applied = await applySelectedLinesRef.current();
        if (applied === true) {
            setCommitSelectionModeActive(false);
        }
    }, []);

    const onClearSelection = React.useCallback(() => {
        setSelectedLineKeys(new Set());
        setCommitSelectionModeActive(false);
        setRangeSelectionActive(false);
    }, []);

    const onStartLineSelection = React.useCallback(() => {
        if (!lineSelectionCanStart) return;
        setReviewCommentModeActive(false);
        setDisplayMode('diff');
        if (!lineSelectionEnabled) {
            setDiffContent(null);
            setDiffMode(hasPendingDelta ? 'pending' : 'included');
        }
        setSelectedLineKeys(new Set(appliedSelectedLineKeys));
        setCommitSelectionModeActive(true);
        setRangeSelectionActive(false);
    }, [appliedSelectedLineKeys, hasPendingDelta, lineSelectionCanStart, lineSelectionEnabled]);

    const onStartRangeSelection = React.useCallback(() => {
        if (!lineSelectionEnabled || !commitSelectionModeActive) return;
        setRangeSelectionActive(true);
    }, [commitSelectionModeActive, lineSelectionEnabled]);

    const onToggleReviewCommentMode = React.useCallback((active: boolean) => {
        setReviewCommentModeActive(active);
        if (!active) return;
        setCommitSelectionModeActive(false);
        setRangeSelectionActive(false);
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
        if (displayMode !== 'file' && displayMode !== 'markdown') return;
        setDisplayMode('diff');
    }, [displayMode, previewTooLarge]);

    const imagePreviewMime = fileContent?.binaryMime ?? null;
    const imagePreviewCacheKey = React.useMemo(() => {
        if (!imagePreviewMime) return null;
        return [
            scope?.serverId ?? '',
            scope?.machineId ?? '',
            scope?.rootPath ?? '',
            filePath,
            fileContent?.binarySizeBytes ?? '',
            lineSelectionFingerprint ?? '',
        ].join(':');
    }, [fileContent?.binarySizeBytes, filePath, imagePreviewMime, lineSelectionFingerprint, scope?.machineId, scope?.rootPath, scope?.serverId]);
    const imagePreview = useSessionImagePreview({
        sessionId: sessionId || props.scopeId,
        filePath,
        enabled: Boolean(scope && imagePreviewMime),
        cacheKey: imagePreviewCacheKey,
        mimeType: imagePreviewMime,
        sizeBytes: fileContent?.binarySizeBytes ?? null,
        workspaceScope: scope,
        cacheScopeId: scope ? `${scope.serverId}:${scope.machineId}:${scope.rootPath}` : null,
    });
    const imagePreviewUri = imagePreview.status === 'loaded' ? imagePreview.uri : null;

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
                    lineSelectionCanStart={lineSelectionCanStart && Boolean(scope)}
                    lineSelectionActive={commitSelectionModeActive}
                    rangeSelectionActive={rangeSelectionActive}
                    reviewCommentsEnabled={reviewCommentsEnabled}
                    commentModeActive={reviewCommentModeActive}
                    selectedLineCount={commitSelectionModeActive ? selectedLineKeys.size : 0}
                    appliedLineSelectionCount={appliedSelectedLineKeys.size}
                    isApplyingStage={isApplyingStage}
                    inFlightScmOperation={inFlightScmOperation}
                    onStageFile={onStageFile}
                    onUnstageFile={onUnstageFile}
                    onApplySelectedLines={onApplySelectedLines}
                    onClearSelection={onClearSelection}
                    onStartLineSelection={onStartLineSelection}
                    onStartRangeSelection={onStartRangeSelection}
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
                        selectedLineKeys={displayedSelectedLineKeys}
                        lineSelectionEnabled={effectiveLineSelectionEnabled && Boolean(scope)}
                        onToggleLine={toggleSelectedLine}
                        rangeSelectionActive={rangeSelectionActive}
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
