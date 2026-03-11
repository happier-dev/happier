import * as React from 'react';
import { Platform } from 'react-native';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { sessionWriteFile } from '@/sync/ops';
import { t } from '@/text';
import { Modal } from '@/modal';
import { showDaemonUnavailableAlert, tryShowDaemonUnavailableAlertForRpcError } from '@/utils/errors/daemonUnavailableAlert';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { createAdvancedDebounce } from '@/utils/timing/debounce';
import { sessionFileEditorDraftCache } from './sessionFileEditorDraftCache';

export type SessionFileEditorState = Readonly<{
    editorSurfaceEnabled: boolean;
    isEditingFile: boolean;
    editorResetKey: number;
    editorOriginalText: string;
    editorSeedText: string;
    editorHandleRef: Readonly<React.MutableRefObject<CodeEditorHandle | null>>;
    onEditorChange: (value: string) => void;
    getEditorText: () => string;
    isSavingEdits: boolean;
    editorDirty: boolean;
    editorTooLarge: boolean;
    editorChunkTooLarge: boolean;
    startEditingFile: () => void;
    cancelEditingFile: () => void;
    saveFileEdits: () => void;
}>;

export function useSessionFileEditorState(input: Readonly<{
    sessionId: string;
    sessionPath: string | null;
    filePath: string;
    displayMode: 'file' | 'diff';
    fileText: string | null;
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
        editorText: string;
    }> | null;
    persistDraft?: (draft: Readonly<{
        isEditingFile: boolean;
        editorOriginalText: string;
        editorText: string;
    }> | null) => void;
}>): SessionFileEditorState {
    const [isEditingFile, setIsEditingFile] = React.useState(false);
    const [pendingStartEditing, setPendingStartEditing] = React.useState(false);
    const [editorResetKey, setEditorResetKey] = React.useState(0);
    const [editorOriginalText, setEditorOriginalText] = React.useState('');
    const [editorSeedText, setEditorSeedText] = React.useState('');
    const [isSavingEdits, setIsSavingEdits] = React.useState(false);
    const [editorDirty, setEditorDirty] = React.useState(false);
    const [editorByteSize, setEditorByteSize] = React.useState(0);
    const hydratedFromPersistedRef = React.useRef(false);
    const draftKey = React.useMemo(() => `${input.sessionId}:${input.filePath}`, [input.filePath, input.sessionId]);

    const editorHandleRef = React.useRef<CodeEditorHandle | null>(null);
    const editorTextRef = React.useRef('');
    const editorOriginalTextRef = React.useRef('');
    const isEditingFileRef = React.useRef(false);
    const persistDraftRef = React.useRef(input.persistDraft);

    React.useEffect(() => {
        hydratedFromPersistedRef.current = false;
    }, [draftKey]);

    React.useEffect(() => {
        editorOriginalTextRef.current = editorOriginalText;
    }, [editorOriginalText]);

    React.useEffect(() => {
        isEditingFileRef.current = isEditingFile;
    }, [isEditingFile]);

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
                        editorText: value,
                    });
                },
                { delay: input.filesEditorChangeDebounceMs },
            ),
        [input.filesEditorChangeDebounceMs],
    );

    React.useEffect(() => {
        if (hydratedFromPersistedRef.current) return;
        hydratedFromPersistedRef.current = true;
        const draft = sessionFileEditorDraftCache.getDraft({ sessionId: input.sessionId, filePath: input.filePath })
            ?? input.persistedDraft;
        if (!draft) return;
        if (typeof draft.editorText !== 'string' || typeof draft.editorOriginalText !== 'string') return;
        setIsEditingFile(Boolean(draft.isEditingFile));
        setEditorOriginalText(draft.editorOriginalText);
        setEditorSeedText(draft.editorText);
        editorTextRef.current = draft.editorText;
        setEditorDirty(Boolean(draft.isEditingFile) && draft.editorText !== draft.editorOriginalText);
        setEditorResetKey((key) => key + 1);
    }, [draftKey, input.filePath, input.persistedDraft, input.sessionId]);

    React.useEffect(() => {
        return () => {
            const persist = input.persistDraft;
            if (!persist) return;
            if (!isEditingFile && !editorDirty) return;
            sizeAndPersistDebounce.flush();
            persist({
                isEditingFile,
                editorOriginalText,
                editorText: editorTextRef.current,
            });
        };
    }, [editorDirty, editorOriginalText, input.persistDraft, isEditingFile, sizeAndPersistDebounce]);

    React.useEffect(() => {
        if (input.displayMode !== 'file') {
            setIsEditingFile(false);
            setEditorDirty(false);
        }
    }, [input.displayMode]);

    React.useEffect(() => {
        if (typeof input.fileText !== 'string') return;
        const fileText = input.fileText;
        if (editorDirty) return;
        setEditorOriginalText(fileText);
        setEditorSeedText(fileText);
        editorTextRef.current = fileText;
        setEditorByteSize(new Blob([fileText]).size);
        setEditorResetKey((key) => key + 1);
    }, [editorDirty, input.fileText]);

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
        setEditorSeedText(fileText);
        editorTextRef.current = fileText;
        sessionFileEditorDraftCache.setDraft({
            sessionId: input.sessionId,
            filePath: input.filePath,
            draft: {
                isEditingFile: true,
                editorOriginalText: fileText,
                editorText: fileText,
            },
        });
        setEditorByteSize(new Blob([fileText]).size);
        setEditorDirty(false);
        setEditorResetKey((key) => key + 1);
        setPendingStartEditing(false);
    }, [editorSurfaceEnabled, input.displayMode, input.filePath, input.fileText, input.sessionId, pendingStartEditing]);

    const startEditingFile = React.useCallback(() => {
        if (!editorSurfaceEnabled) return;
        if (input.displayMode !== 'file') {
            setPendingStartEditing(true);
            return;
        }
        if (typeof input.fileText !== 'string') return;
        const fileText = input.fileText;
        setIsEditingFile(true);
        setEditorOriginalText(fileText);
        setEditorSeedText(fileText);
        editorTextRef.current = fileText;
        sessionFileEditorDraftCache.setDraft({
            sessionId: input.sessionId,
            filePath: input.filePath,
            draft: {
                isEditingFile: true,
                editorOriginalText: fileText,
                editorText: fileText,
            },
        });
        setEditorByteSize(new Blob([fileText]).size);
        setEditorDirty(false);
        setEditorResetKey((key) => key + 1);
    }, [editorSurfaceEnabled, input.displayMode, input.filePath, input.fileText, input.sessionId]);

    const cancelEditingFile = React.useCallback(() => {
        setPendingStartEditing(false);
        setIsEditingFile(false);
        setEditorSeedText(editorOriginalText);
        editorTextRef.current = editorOriginalText;
        sessionFileEditorDraftCache.setDraft({
            sessionId: input.sessionId,
            filePath: input.filePath,
            draft: null,
        });
        setEditorByteSize(() => new Blob([editorOriginalText]).size);
        setEditorDirty(false);
        setEditorResetKey((key) => key + 1);
        input.persistDraft?.(null);
    }, [editorOriginalText, input.filePath, input.persistDraft, input.sessionId]);

    const onEditorChange = React.useCallback((value: string) => {
        editorTextRef.current = value;
        const nextDirty = isEditingFile && value !== editorOriginalTextRef.current;
        setEditorDirty((previous) => (previous === nextDirty ? previous : nextDirty));
        sessionFileEditorDraftCache.setDraft({
            sessionId: input.sessionId,
            filePath: input.filePath,
            draft: {
                isEditingFile: true,
                editorOriginalText: editorOriginalTextRef.current,
                editorText: value,
            },
        });
        sizeAndPersistDebounce.debounced(value);
    }, [input.filePath, input.sessionId, isEditingFile, sizeAndPersistDebounce]);

    const getEditorText = React.useCallback(() => {
        return editorTextRef.current;
    }, []);

    const saveFileEdits = React.useCallback(() => {
        void (async () => {
            if (!editorSurfaceEnabled) return;
            if (!input.sessionPath) return;
            if (!input.sessionId) return;
            if (!input.filePath) return;
            if (editorTextRef.current === editorOriginalTextRef.current) return;

            setIsSavingEdits(true);
            try {
                await editorHandleRef.current?.flushPendingChange?.();
                const latestText = editorHandleRef.current?.getValue?.() ?? editorTextRef.current;
                editorTextRef.current = latestText;
                sizeAndPersistDebounce.flush();
                if (latestText === editorOriginalTextRef.current) return;

                const response = await sessionWriteFile(input.sessionId, input.filePath, latestText);

                if (!response.success) {
                    const code = response.errorCode;
                    if (code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
                        showDaemonUnavailableAlert({
                            titleKey: 'errors.daemonUnavailableTitle',
                            bodyKey: 'errors.daemonUnavailableBody',
                            machine: null,
                            onRetry: () => {
                                saveFileEdits();
                            },
                            shouldContinue: () => input.mountedRef.current,
                        });
                        return;
                    }
                    if (code === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
                        input.setFileWriteSupported(false);
                        setIsEditingFile(false);
                        Modal.alert(t('common.error'), t('files.fileEditingUnsupported'));
                        return;
                    }
                    Modal.alert(t('common.error'), response.error || t('files.fileWriteFailed'));
                    return;
                }

                setEditorOriginalText(latestText);
                setEditorSeedText(latestText);
                setEditorByteSize(() => new Blob([latestText]).size);
                setIsEditingFile(false);
                setEditorDirty(false);
                sessionFileEditorDraftCache.setDraft({
                    sessionId: input.sessionId,
                    filePath: input.filePath,
                    draft: null,
                });
                input.persistDraft?.(null);
                await input.refreshAll();
            } catch (err) {
                const shown = tryShowDaemonUnavailableAlertForRpcError({
                    error: err,
                    machine: null,
                    onRetry: () => {
                        saveFileEdits();
                    },
                    shouldContinue: () => input.mountedRef.current,
                });
                if (!shown) {
                    const message = err instanceof Error ? err.message : t('files.fileWriteFailed');
                    Modal.alert(t('common.error'), message);
                }
            } finally {
                setIsSavingEdits(false);
            }
        })();
    }, [editorDirty, editorSurfaceEnabled, input, input.filePath, input.refreshAll, input.sessionId, input.sessionPath, sizeAndPersistDebounce]);

    React.useEffect(() => {
        if (!input.filesEditorAutoSave) return;
        if (!editorDirty) return;
        if (!isEditingFile) return;
        const timeout = setTimeout(() => {
            saveFileEdits();
        }, input.filesEditorChangeDebounceMs);
        return () => clearTimeout(timeout);
    }, [editorDirty, input.filesEditorAutoSave, input.filesEditorChangeDebounceMs, isEditingFile, saveFileEdits]);

    const editorTooLarge = editorByteSize > input.filesEditorMaxFileBytes;
    const editorChunkTooLarge = editorByteSize > input.filesEditorBridgeMaxChunkBytes;

    return {
        editorSurfaceEnabled,
        isEditingFile,
        editorResetKey,
        editorOriginalText,
        editorSeedText,
        editorHandleRef,
        onEditorChange,
        getEditorText,
        isSavingEdits,
        editorDirty,
        editorTooLarge,
        editorChunkTooLarge,
        startEditingFile,
        cancelEditingFile,
        saveFileEdits,
    };
}
