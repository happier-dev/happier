import * as React from 'react';
import { Platform } from 'react-native';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { WORKSPACE_WRITE_FILE_TOO_LARGE_ERROR, workspaceWriteFile } from '@/sync/domains/workspaces/files/workspaceFileReadWrite';
import { t } from '@/text';
import { Modal } from '@/modal';
import { showDaemonUnavailableAlert, tryShowDaemonUnavailableAlertForRpcError } from '@/utils/errors/daemonUnavailableAlert';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { createAdvancedDebounce } from '@/utils/timing/debounce';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { workspaceFileEditorDraftCache } from './workspaceFileEditorDraftCache';
import type { FileDisplayMode } from '@/components/workspaces/files/file/FileActionToolbar';
import { showWorkspaceFileEditorComparison } from './WorkspaceFileEditorComparison';

function isGuardedWriteConflictError(error: string | undefined): boolean {
    if (!error) return false;
    return error.startsWith('File hash mismatch.')
        || error === 'File does not exist but hash was provided'
        || error === 'File already exists but was expected to be new';
}

export type WorkspaceFileEditorState = Readonly<{
    editorSurfaceEnabled: boolean;
    isEditingFile: boolean;
    editorResetKey: number;
    editorOriginalText: string;
    editorOriginalHash: string | null;
    editorSeedText: string;
    editorHandleRef: Readonly<React.MutableRefObject<CodeEditorHandle | null>>;
    onEditorChange: (value: string) => void;
    getEditorText: () => string;
    isSavingEdits: boolean;
    editorDirty: boolean;
    fileChangedExternally: boolean;
    editorTooLarge: boolean;
    editorChunkTooLarge: boolean;
    startEditingFile: () => void;
    cancelEditingFile: () => void;
    saveFileEdits: () => void;
    compareFileEdits: () => void;
}>;

export function useWorkspaceFileEditorState(input: Readonly<{
    scope: WorkspaceScopeBase;
    filePath: string;
    displayMode: FileDisplayMode;
    fileText: string | null;
    fileHash: string | null;
    fileWriteSupported: boolean;
    setFileWriteSupported: (value: boolean) => void;
    fileEditorFeatureEnabled: boolean;
    filesEditorWebMonacoEnabled: boolean;
    filesEditorNativeCodeMirrorEnabled: boolean;
    filesEditorAutoSave: boolean;
    filesEditorChangeDebounceMs: number;
    filesEditorMaxFileBytes: number;
    filesEditorBridgeMaxChunkBytes: number;
    mountedRef: Readonly<{ current: boolean }>;
    refreshAll: () => Promise<void>;
    persistedDraft?: Readonly<{
        isEditingFile: boolean;
        editorOriginalText: string;
        editorOriginalHash?: string | null;
        editorText: string;
    }> | null;
    persistDraft?: (draft: Readonly<{
        isEditingFile: boolean;
        editorOriginalText: string;
        editorOriginalHash?: string | null;
        editorText: string;
    }> | null) => void;
}>): WorkspaceFileEditorState {
    const [isEditingFile, setIsEditingFile] = React.useState(false);
    const [pendingStartEditing, setPendingStartEditing] = React.useState(false);
    const [editorResetKey, setEditorResetKey] = React.useState(0);
    const [editorOriginalText, setEditorOriginalText] = React.useState('');
    const [editorOriginalHash, setEditorOriginalHash] = React.useState<string | null>(null);
    const [editorSeedText, setEditorSeedText] = React.useState('');
    const [isSavingEdits, setIsSavingEdits] = React.useState(false);
    const [editorDirty, setEditorDirty] = React.useState(false);
    const [fileChangedExternally, setFileChangedExternally] = React.useState(false);
    const [editorByteSize, setEditorByteSize] = React.useState(0);
    const hydratedFromPersistedRef = React.useRef(false);
    const workspaceCacheKey = React.useMemo(() => buildWorkspaceCacheKey(input.scope), [input.scope]);
    const draftKey = React.useMemo(() => `${workspaceCacheKey}:${input.filePath}`, [input.filePath, workspaceCacheKey]);

    const editorHandleRef = React.useRef<CodeEditorHandle | null>(null);
    const editorTextRef = React.useRef('');
    const editorOriginalTextRef = React.useRef('');
    const editorOriginalHashRef = React.useRef<string | null>(null);
    const isEditingFileRef = React.useRef(false);
    const fileChangedExternallyRef = React.useRef(false);
    const savingRef = React.useRef(false);
    const saveEditsRef = React.useRef<((autoSave: boolean) => void) | null>(null);
    const persistDraftRef = React.useRef(input.persistDraft);
    const latestInputRef = React.useRef(input);
    latestInputRef.current = input;

    const autoSaveDebounce = React.useMemo(() => createAdvancedDebounce<boolean>(() => {
        const latestInput = latestInputRef.current;
        if (!latestInput.filesEditorAutoSave || !latestInput.mountedRef.current) return;
        if (!isEditingFileRef.current || fileChangedExternallyRef.current) return;
        saveEditsRef.current?.(true);
    }, { delay: input.filesEditorChangeDebounceMs, immediateCount: 0 }), [input.filesEditorChangeDebounceMs]);

    React.useEffect(() => {
        hydratedFromPersistedRef.current = false;
    }, [draftKey]);

    React.useEffect(() => {
        editorOriginalTextRef.current = editorOriginalText;
    }, [editorOriginalText]);

    React.useEffect(() => {
        editorOriginalHashRef.current = editorOriginalHash;
    }, [editorOriginalHash]);

    React.useEffect(() => {
        isEditingFileRef.current = isEditingFile;
    }, [isEditingFile]);

    React.useEffect(() => {
        fileChangedExternallyRef.current = fileChangedExternally;
    }, [fileChangedExternally]);

    React.useEffect(() => {
        persistDraftRef.current = input.persistDraft;
    }, [input.persistDraft]);

    const sizeAndPersistDebounce = React.useMemo(
        () =>
            createAdvancedDebounce<string>(
                (value) => {
                    setEditorByteSize(() => {
                        try {
                            return new Blob([value]).size;
                        } catch {
                            return value.length;
                        }
                    });
                    const persist = persistDraftRef.current;
                    if (!persist) return;
                    if (!isEditingFileRef.current) return;
                    persist({
                        isEditingFile: true,
                        editorOriginalText: editorOriginalTextRef.current,
                        editorOriginalHash: editorOriginalHashRef.current,
                        editorText: value,
                    });
                },
                { delay: input.filesEditorChangeDebounceMs },
            ),
        [input.filesEditorChangeDebounceMs],
    );

    React.useEffect(() => {
        if (input.displayMode !== 'file') {
            setIsEditingFile(false);
            setEditorDirty(false);
            setFileChangedExternally(false);
        }
    }, [input.displayMode]);

    React.useEffect(() => {
        if (typeof input.fileText !== 'string') return;
        const fileText = input.fileText;
        if (isEditingFileRef.current || editorTextRef.current !== editorOriginalTextRef.current) {
            const originalHash = editorOriginalHashRef.current;
            const nextHash = input.fileHash;
            if (typeof originalHash === 'string' && typeof nextHash === 'string') {
                setFileChangedExternally(originalHash !== nextHash);
            } else if (fileText !== editorOriginalTextRef.current) {
                setFileChangedExternally(true);
            }
            return;
        }
        setEditorOriginalText(fileText);
        setEditorOriginalHash(input.fileHash);
        setEditorSeedText(fileText);
        editorTextRef.current = fileText;
        setEditorByteSize(new Blob([fileText]).size);
        setFileChangedExternally(false);
        setEditorResetKey((key) => key + 1);
    }, [input.fileHash, input.fileText]);

    React.useEffect(() => {
        if (hydratedFromPersistedRef.current) return;
        hydratedFromPersistedRef.current = true;
        const draft = workspaceFileEditorDraftCache.getDraft({ workspaceCacheKey, filePath: input.filePath })
            ?? input.persistedDraft;
        if (!draft) return;
        if (typeof draft.editorText !== 'string' || typeof draft.editorOriginalText !== 'string') return;
        const draftOriginalHash = typeof draft.editorOriginalHash === 'string' ? draft.editorOriginalHash : null;
        const isEditingDraft = Boolean(draft.isEditingFile);
        const externallyChanged = isEditingDraft
            && typeof input.fileText === 'string'
            && (
                typeof draftOriginalHash === 'string' && typeof input.fileHash === 'string'
                    ? draftOriginalHash !== input.fileHash
                    : input.fileText !== draft.editorOriginalText
            );
        isEditingFileRef.current = isEditingDraft;
        editorOriginalTextRef.current = draft.editorOriginalText;
        editorOriginalHashRef.current = draftOriginalHash;
        fileChangedExternallyRef.current = externallyChanged;
        setIsEditingFile(isEditingDraft);
        setEditorOriginalText(draft.editorOriginalText);
        setEditorOriginalHash(draftOriginalHash);
        setEditorSeedText(draft.editorText);
        editorTextRef.current = draft.editorText;
        setEditorDirty(isEditingDraft && draft.editorText !== draft.editorOriginalText);
        setFileChangedExternally(externallyChanged);
        setEditorResetKey((key) => key + 1);
    }, [draftKey, input.fileHash, input.filePath, input.fileText, input.persistedDraft, workspaceCacheKey]);

    React.useEffect(() => {
        return () => {
            const persist = input.persistDraft;
            if (!persist) return;
            if (!isEditingFile && !editorDirty) return;
            sizeAndPersistDebounce.flush();
            persist({
                isEditingFile,
                editorOriginalText: editorOriginalTextRef.current,
                editorOriginalHash: editorOriginalHashRef.current,
                editorText: editorTextRef.current,
            });
        };
    }, [editorDirty, editorOriginalHash, editorOriginalText, input.persistDraft, isEditingFile, sizeAndPersistDebounce]);

    const editorSurfaceEnabled = input.fileWriteSupported
        && input.fileEditorFeatureEnabled === true
        && (Platform.OS === 'web' ? input.filesEditorWebMonacoEnabled === true : input.filesEditorNativeCodeMirrorEnabled === true);

    React.useEffect(() => {
        if (!pendingStartEditing) return;
        if (!editorSurfaceEnabled) return;
        if (input.displayMode !== 'file') return;
        if (typeof input.fileText !== 'string') return;
        const fileText = input.fileText;

        setIsEditingFile(true);
        setEditorOriginalText(fileText);
        setEditorOriginalHash(input.fileHash);
        setEditorSeedText(fileText);
        editorTextRef.current = fileText;
        workspaceFileEditorDraftCache.setDraft({
            workspaceCacheKey,
            filePath: input.filePath,
            draft: {
                isEditingFile: true,
                editorOriginalText: fileText,
                editorOriginalHash: input.fileHash,
                editorText: fileText,
            },
        });
        setEditorByteSize(new Blob([fileText]).size);
        setEditorDirty(false);
        setFileChangedExternally(false);
        setEditorResetKey((key) => key + 1);
        setPendingStartEditing(false);
    }, [editorSurfaceEnabled, input.displayMode, input.fileHash, input.filePath, input.fileText, pendingStartEditing, workspaceCacheKey]);

    const startEditingFile = React.useCallback(() => {
        if (!editorSurfaceEnabled) return;
        if (input.displayMode !== 'file' || typeof input.fileText !== 'string') {
            setPendingStartEditing(true);
            return;
        }
        const fileText = input.fileText;
        setIsEditingFile(true);
        setEditorOriginalText(fileText);
        setEditorOriginalHash(input.fileHash);
        setEditorSeedText(fileText);
        editorTextRef.current = fileText;
        workspaceFileEditorDraftCache.setDraft({
            workspaceCacheKey,
            filePath: input.filePath,
            draft: {
                isEditingFile: true,
                editorOriginalText: fileText,
                editorOriginalHash: input.fileHash,
                editorText: fileText,
            },
        });
        setEditorByteSize(new Blob([fileText]).size);
        setEditorDirty(false);
        setFileChangedExternally(false);
        setEditorResetKey((key) => key + 1);
    }, [editorSurfaceEnabled, input.displayMode, input.fileHash, input.filePath, input.fileText, workspaceCacheKey]);

    const cancelEditingFile = React.useCallback(() => {
        setPendingStartEditing(false);
        setIsEditingFile(false);
        setEditorSeedText(editorOriginalText);
        editorTextRef.current = editorOriginalText;
        setFileChangedExternally(false);
        workspaceFileEditorDraftCache.setDraft({
            workspaceCacheKey,
            filePath: input.filePath,
            draft: null,
        });
        setEditorByteSize(() => new Blob([editorOriginalText]).size);
        setEditorDirty(false);
        setEditorResetKey((key) => key + 1);
        input.persistDraft?.(null);
    }, [editorOriginalText, input.filePath, input.persistDraft, workspaceCacheKey]);

    const onEditorChange = React.useCallback((value: string) => {
        editorTextRef.current = value;
        const nextDirty = isEditingFile && value !== editorOriginalTextRef.current;
        setEditorDirty((previous) => (previous === nextDirty ? previous : nextDirty));
        workspaceFileEditorDraftCache.setDraft({
            workspaceCacheKey,
            filePath: input.filePath,
            draft: {
                isEditingFile: true,
                editorOriginalText: editorOriginalTextRef.current,
                editorOriginalHash: editorOriginalHashRef.current,
                editorText: value,
            },
        });
        sizeAndPersistDebounce.debounced(value);
        if (latestInputRef.current.filesEditorAutoSave && isEditingFile && value !== editorOriginalTextRef.current) {
            autoSaveDebounce.debounced(true);
        }
    }, [autoSaveDebounce, input.filePath, isEditingFile, sizeAndPersistDebounce, workspaceCacheKey]);

    const getEditorText = React.useCallback(() => {
        return editorTextRef.current;
    }, []);

    const saveEdits = React.useCallback((autoSave: boolean) => {
        void (async () => {
            const latestInput = latestInputRef.current;
            if (!editorSurfaceEnabled) return;
            if (!latestInput.filePath) return;
            if (editorTextRef.current === editorOriginalTextRef.current) return;
            if (savingRef.current) return;

            savingRef.current = true;
            setIsSavingEdits(true);
            let writeSucceeded = false;
            try {
                await editorHandleRef.current?.flushPendingChange?.();
                const latestText = editorHandleRef.current?.getValue?.() ?? editorTextRef.current;
                editorTextRef.current = latestText;
                sizeAndPersistDebounce.flush();
                if (latestText === editorOriginalTextRef.current) return;
                if (fileChangedExternallyRef.current) {
                    Modal.alert(t('common.error'), t('files.fileChangedExternally'));
                    return;
                }

                const expectedHash = editorOriginalHashRef.current ?? undefined;
                const response = await workspaceWriteFile({
                    scope: latestInput.scope,
                    path: latestInput.filePath,
                    content: latestText,
                    expectedHash,
                });

                if (!response.success) {
                    if (expectedHash !== undefined && isGuardedWriteConflictError(response.error)) {
                        setFileChangedExternally(true);
                        Modal.alert(t('common.error'), t('files.fileChangedExternally'));
                        return;
                    }
                    const code = response.errorCode;
                    if (code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE && response.error !== WORKSPACE_WRITE_FILE_TOO_LARGE_ERROR) {
                        showDaemonUnavailableAlert({
                            titleKey: 'errors.daemonUnavailableTitle',
                            bodyKey: 'errors.daemonUnavailableBody',
                            machine: null,
                            onRetry: () => {
                                saveEdits(autoSave);
                            },
                            shouldContinue: () => latestInputRef.current.mountedRef.current,
                        });
                        return;
                    }
                    if (code === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
                        latestInput.setFileWriteSupported(false);
                        setIsEditingFile(false);
                        Modal.alert(t('common.error'), t('files.fileEditingUnsupported'));
                        return;
                    }
                    Modal.alert(t('common.error'), response.error || t('files.fileWriteFailed'));
                    return;
                }

                writeSucceeded = true;
                editorOriginalTextRef.current = latestText;
                editorOriginalHashRef.current = response.hash;
                setEditorOriginalText(latestText);
                setEditorOriginalHash(response.hash);
                setFileChangedExternally(false);
                const liveTextAfterWrite = editorHandleRef.current?.getValue?.() ?? editorTextRef.current;
                editorTextRef.current = liveTextAfterWrite;
                const draft = isEditingFileRef.current && (autoSave || liveTextAfterWrite !== latestText) ? {
                    isEditingFile: true,
                    editorOriginalText: latestText,
                    editorOriginalHash: response.hash,
                    editorText: liveTextAfterWrite,
                } : null;
                workspaceFileEditorDraftCache.setDraft({
                    workspaceCacheKey,
                    filePath: latestInput.filePath,
                    draft,
                });
                latestInput.persistDraft?.(draft);
                if (liveTextAfterWrite !== latestText) {
                    // The user kept typing while the write was in flight. Seeding the editor
                    // with the saved snapshot would replace the live document and reset the
                    // cursor. Keep editing dirty; the newer text saves on the next pass.
                    setEditorDirty(true);
                    return;
                }
                setEditorSeedText(latestText);
                setEditorByteSize(() => new Blob([latestText]).size);
                if (!autoSave) setIsEditingFile(false);
                setEditorDirty(false);
                await latestInput.refreshAll();
            } catch (err) {
                const shown = tryShowDaemonUnavailableAlertForRpcError({
                    error: err,
                    machine: null,
                    onRetry: () => {
                        saveEdits(autoSave);
                    },
                    shouldContinue: () => latestInputRef.current.mountedRef.current,
                });
                if (!shown) {
                    const message = err instanceof Error ? err.message : t('files.fileWriteFailed');
                    Modal.alert(t('common.error'), message);
                }
            } finally {
                savingRef.current = false;
                setIsSavingEdits(false);
                if (writeSucceeded && isEditingFileRef.current) {
                    const liveText = editorHandleRef.current?.getValue?.() ?? editorTextRef.current;
                    editorTextRef.current = liveText;
                    if (liveText !== editorOriginalTextRef.current) {
                        setEditorDirty(true);
                        if (latestInputRef.current.filesEditorAutoSave) autoSaveDebounce.debounced(true);
                    }
                }
            }
        })();
    }, [autoSaveDebounce, editorSurfaceEnabled, sizeAndPersistDebounce, workspaceCacheKey]);
    saveEditsRef.current = saveEdits;

    const saveFileEdits = React.useCallback(() => saveEdits(false), [saveEdits]);
    const compareFileEdits = React.useCallback(() => {
        const latestInput = latestInputRef.current;
        if (!isEditingFileRef.current || typeof latestInput.fileText !== 'string') return;
        showWorkspaceFileEditorComparison({
            oldText: latestInput.fileText,
            newText: editorHandleRef.current?.getValue?.() ?? editorTextRef.current,
            filePath: latestInput.filePath,
        });
    }, []);

    React.useEffect(() => {
        if (input.filesEditorAutoSave && editorDirty && isEditingFile && !fileChangedExternally) {
            autoSaveDebounce.debounced(true);
        } else {
            autoSaveDebounce.cancel();
        }
        return () => autoSaveDebounce.cancel();
    }, [autoSaveDebounce, editorDirty, fileChangedExternally, input.filesEditorAutoSave, isEditingFile]);

    const editorTooLarge = editorByteSize > input.filesEditorMaxFileBytes;
    const editorChunkTooLarge = editorByteSize > input.filesEditorBridgeMaxChunkBytes;

    return {
        editorSurfaceEnabled,
        isEditingFile,
        editorResetKey,
        editorOriginalText,
        editorOriginalHash,
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
        compareFileEdits,
    };
}
