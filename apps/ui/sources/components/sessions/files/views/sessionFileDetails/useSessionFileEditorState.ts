import * as React from 'react';
import { Platform } from 'react-native';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { sessionWriteFile } from '@/sync/ops';
import { t } from '@/text';
import { Modal } from '@/modal';
import { showDaemonUnavailableAlert, tryShowDaemonUnavailableAlertForRpcError } from '@/utils/errors/daemonUnavailableAlert';

export type SessionFileEditorState = Readonly<{
    editorSurfaceEnabled: boolean;
    isEditingFile: boolean;
    editorResetKey: number;
    editorOriginalText: string;
    editorText: string;
    setEditorText: (value: string) => void;
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
    const [editorText, setEditorText] = React.useState('');
    const [isSavingEdits, setIsSavingEdits] = React.useState(false);
    const hydratedFromPersistedRef = React.useRef(false);

    const editorDirty = isEditingFile && editorText !== editorOriginalText;

    React.useEffect(() => {
        if (hydratedFromPersistedRef.current) return;
        hydratedFromPersistedRef.current = true;
        const draft = input.persistedDraft;
        if (!draft) return;
        if (typeof draft.editorText !== 'string' || typeof draft.editorOriginalText !== 'string') return;
        setIsEditingFile(Boolean(draft.isEditingFile));
        setEditorOriginalText(draft.editorOriginalText);
        setEditorText(draft.editorText);
        setEditorResetKey((key) => key + 1);
    }, [input.persistedDraft]);

    React.useEffect(() => {
        return () => {
            const persist = input.persistDraft;
            if (!persist) return;
            if (!isEditingFile && !editorDirty) return;
            persist({ isEditingFile, editorOriginalText, editorText });
        };
    }, [editorDirty, editorOriginalText, editorText, input.persistDraft, isEditingFile]);

    React.useEffect(() => {
        if (input.displayMode !== 'file') {
            setIsEditingFile(false);
        }
    }, [input.displayMode]);

    React.useEffect(() => {
        if (typeof input.fileText !== 'string') return;
        if (editorDirty) return;
        setEditorOriginalText(input.fileText);
        setEditorText(input.fileText);
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

        setIsEditingFile(true);
        setEditorOriginalText(input.fileText);
        setEditorText(input.fileText);
        setEditorResetKey((key) => key + 1);
        setPendingStartEditing(false);
    }, [editorSurfaceEnabled, input.displayMode, input.fileText, pendingStartEditing]);

    const startEditingFile = React.useCallback(() => {
        if (!editorSurfaceEnabled) return;
        if (input.displayMode !== 'file') {
            setPendingStartEditing(true);
            return;
        }
        if (typeof input.fileText !== 'string') return;
        setIsEditingFile(true);
        setEditorOriginalText(input.fileText);
        setEditorText(input.fileText);
        setEditorResetKey((key) => key + 1);
    }, [editorSurfaceEnabled, input.displayMode, input.fileText]);

    const cancelEditingFile = React.useCallback(() => {
        setPendingStartEditing(false);
        setIsEditingFile(false);
        setEditorText(editorOriginalText);
        setEditorResetKey((key) => key + 1);
        input.persistDraft?.(null);
    }, [editorOriginalText]);

    const saveFileEdits = React.useCallback(() => {
        void (async () => {
            if (!editorDirty) return;
            if (!editorSurfaceEnabled) return;
            if (!input.sessionPath) return;
            if (!input.sessionId) return;
            if (!input.filePath) return;

            setIsSavingEdits(true);
            try {
                const response = await sessionWriteFile(input.sessionId, input.filePath, editorText);

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

                setEditorOriginalText(editorText);
                setIsEditingFile(false);
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
    }, [editorDirty, editorSurfaceEnabled, editorText, input, input.filePath, input.refreshAll, input.sessionId, input.sessionPath]);

    React.useEffect(() => {
        if (!input.filesEditorAutoSave) return;
        if (!editorDirty) return;
        if (!isEditingFile) return;
        const timeout = setTimeout(() => {
            saveFileEdits();
        }, input.filesEditorChangeDebounceMs);
        return () => clearTimeout(timeout);
    }, [editorDirty, input.filesEditorAutoSave, input.filesEditorChangeDebounceMs, isEditingFile, saveFileEdits]);

    const editorByteSize = React.useMemo(() => new Blob([editorText]).size, [editorText]);
    const editorTooLarge = editorByteSize > input.filesEditorMaxFileBytes;
    const editorChunkTooLarge = editorByteSize > input.filesEditorBridgeMaxChunkBytes;

    return {
        editorSurfaceEnabled,
        isEditingFile,
        editorResetKey,
        editorOriginalText,
        editorText,
        setEditorText,
        isSavingEdits,
        editorDirty,
        editorTooLarge,
        editorChunkTooLarge,
        startEditingFile,
        cancelEditingFile,
        saveFileEdits,
    };
}
