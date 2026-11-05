import * as React from 'react';
import { Platform } from 'react-native';
import { FilesystemWriteFileOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { workspaceWriteFile, classifyWorkspaceWriteFileFailure, type WorkspaceWriteFileResponse } from '@/sync/domains/workspaces/files/workspaceFileReadWrite';
import { restoreWorkspaceFileTextBom } from '@/sync/ops/workspaceFileSystem/workspaceFileTextDecoding';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { createAdvancedDebounce } from '@/utils/timing/debounce';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { readWorkspaceFileEditorDraft, type WorkspaceFileEditorDraft } from './workspaceFileEditorDraft';
import type { FileDisplayMode } from '@/components/workspaces/files/file/filePageModel';
import { deriveWorkspaceFileEditorConflict, type WorkspaceFileEditorConflict } from './workspaceFileEditorConflict';
import { publishPresentationNotice, readPresentationNotice, retirePresentationNotice, subscribePresentationNotices } from '@/components/sessions/presentation/presentationNotices';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { encodeBase64 } from '@/encryption/base64';
import { t } from '@/text';
import { hapticsError, hapticsSuccess } from '@/components/ui/theme/haptics';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { useWorkspaceFileEditorComparison, type EditorComparisonResolution, type WorkspaceFileEditorComparisonController } from './useWorkspaceFileEditorComparison';
import type { WorkspaceFileDetailsFileContent } from './refreshWorkspaceFileDetails';

/** Where Edit starts: the caret line and, from View, the row to keep at the top of the editor. */
export type WorkspaceFileEditStart = Readonly<{ line: number; top?: Readonly<{ line: number; offset: number }> }>;

export type WorkspaceFileEditorLiveValue = Readonly<{ get(): string; subscribe(listener: () => void): () => void }>;
export type WorkspaceFileEditorRefusal = Readonly<{ kind: 'unreachable' | 'unsupported' | 'awaitingApproval' | 'failed'; message?: string }>;
type Encoding = NonNullable<WorkspaceFileDetailsFileContent['encoding']>;
type Base = Readonly<{ text: string | null; hash: string | null; encoding?: Encoding }>;
type SetAside = Readonly<{ kind: 'draft'; text: string; base: Base }> | Readonly<{ kind: 'disk'; text: string; hash: string; encoding?: Encoding }>;
type Input = Readonly<{
    scope: WorkspaceScopeBase; accountId: string | null; filePath: string; displayMode: FileDisplayMode;
    fileText: string | null; fileHash: string | null; encoding?: Encoding; unreachable?: boolean;
    fileWriteSupported: boolean; setFileWriteSupported(value: boolean): void;
    fileEditorFeatureEnabled: boolean; filesEditorWebMonacoEnabled: boolean; filesEditorNativeCodeMirrorEnabled: boolean;
    filesEditorAutoSave: boolean; filesEditorChangeDebounceMs: number; mountedRef: Readonly<{ current: boolean }>;
    refreshAll(): Promise<void>; readFileForSave?(): Promise<WorkspaceFileDetailsFileContent | null>;
    publishSavedFile?(value: { text: string; hash: string }): void;
    persistedDraft?: WorkspaceFileEditorDraft | null; persistDraft?(draft: WorkspaceFileEditorDraft | null): void;
    /** Restore the selected mode without persisting a clean buffer as a dirty draft. */
    initialEditing?: boolean;
    onStopEditing?(): void;
    panePersistenceFailed?: boolean;
    /** The writing agent's display name, for the Undo notice's words only. */
    agentName?: string | null;
    requestApproval?(registration: ActionApprovalRegistration): void;
}>;

export type WorkspaceFileEditorState = Readonly<{
    editorSurfaceEnabled: boolean; isEditingFile: boolean; editorResetKey: number;
    editorOriginalText: string | null; editorOriginalHash: string | null; editorSeedText: string;
    editorHandleRef: React.MutableRefObject<TextEditorHandle | null>; onEditorChange(value: string): void; getEditorText(): string;
    liveValue: WorkspaceFileEditorLiveValue; isSavingEdits: boolean; editorDirty: boolean;
    editorStatus: 'clean' | 'dirty' | 'saving' | 'conflict'; conflict: WorkspaceFileEditorConflict | null;
    refusal: WorkspaceFileEditorRefusal | null; draftPersistenceFailed: boolean; savedAtMs: number | null;
    lineEndingNormalization: 'lf' | 'crlf' | null;
    initialLine: number | undefined; onEditorReady(): void; startEditingFile(at?: WorkspaceFileEditStart): void;
    cancelEditingFile(): void; doneEditingFile(): Promise<void>; saveFileEdits(): Promise<boolean>;
    prepareEditorTransition(): Promise<boolean>;
    resolveConflict(choice: 'useMine' | 'useTheirs'): Promise<void>; undoSetAside(): Promise<void>;
    isComparing: boolean; startComparison(): void; backToEditing(): void;
    rebaseMergedDraft(text: string, shown?: Omit<EditorComparisonResolution, 'text'>): void;
    readSnapshot(): Readonly<{ isEditingFile: boolean; savedText: string | null; hash: string | null; encoding?: Encoding; dirty: boolean; conflict: WorkspaceFileEditorConflict | null }>;
}> & Pick<WorkspaceFileEditorComparisonController, 'comparison' | 'usePlaceMine' | 'usePlaceTheirs' | 'useAllMine' | 'useAllTheirs'>;

export function useWorkspaceFileEditorState(input: Input): WorkspaceFileEditorState {
    const ownerKey = JSON.stringify([input.accountId, buildWorkspaceCacheKey(input.scope), input.filePath]);
    const latest = React.useRef(input); latest.current = input;
    const currentOwner = React.useRef(ownerKey); currentOwner.current = ownerKey;
    const isCurrentOwner = React.useCallback(() => currentOwner.current === ownerKey, [ownerKey]);
    const [stateOwner, setStateOwner] = React.useState(ownerKey);
    const draft = readWorkspaceFileEditorDraft(input.persistedDraft, input.accountId);
    const [isEditingFile, setIsEditingFile] = React.useState(draft?.isEditingFile === true);
    const editing = React.useRef(isEditingFile);
    const initialBase: Base = { text: draft && draft.editorOriginalHash !== input.fileHash ? null : input.fileText,
        hash: draft ? draft.editorOriginalHash : input.fileHash,
        encoding: draft && draft.editorOriginalHash !== input.fileHash ? undefined : input.encoding };
    const [base, setBase] = React.useState<Base>(initialBase);
    const baseRef = React.useRef(base);
    const text = React.useRef(draft?.editorText ?? input.fileText ?? '');
    const [editorSeedText, setEditorSeedText] = React.useState(text.current);
    const [editorResetKey, setEditorResetKey] = React.useState(0);
    const [editorDirty, setEditorDirty] = React.useState(Boolean(draft && text.current !== initialBase.text));
    const [isSavingEdits, setIsSavingEdits] = React.useState(false);
    const [refusal, setRefusal] = React.useState<WorkspaceFileEditorRefusal | null>(draft && input.unreachable ? { kind: 'unreachable' } : null);
    const refusalRef = React.useRef(refusal);
    const [draftPersistenceFailed, setDraftPersistenceFailed] = React.useState(false);
    const [savedAtMs, setSavedAtMs] = React.useState<number | null>(null);
    const [initialLine, setInitialLine] = React.useState<number>();
    // The reader's top row when Edit started from View, so the editor opens on the same view (P4-R10).
    const initialTop = React.useRef<WorkspaceFileEditStart['top']>(undefined);
    const [pendingStart, setPendingStart] = React.useState(input.initialEditing === true && draft?.isEditingFile !== true);
    const editorHandleRef = React.useRef<TextEditorHandle | null>(null);
    const saving = React.useRef<AbortController | null>(null);
    const rereadAfterSave = React.useRef<Promise<void> | null>(null);
    const setAside = React.useRef<SetAside | null>(null);
    // An exact pre-write observation is superseded by the returned write version. No TTL.
    const supersededDisk = React.useRef<{ text: string | null; hash: string | null } | null>(null);
    const noticeKey = 'file-editor:' + ownerKey;
    const retireUndo = React.useCallback(() => {
        if (!isCurrentOwner()) return;
        setAside.current = null; retirePresentationNotice(noticeKey);
    }, [isCurrentOwner, noticeKey]);
    const liveValue = React.useMemo(() => {
        let value = draft?.editorText ?? input.fileText ?? '';
        const listeners = new Set<() => void>();
        return { get: () => isCurrentOwner() ? text.current : '',
            subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
            publish(next: string) { if (value === next) return; value = next; for (const listener of listeners) listener(); } };
    }, [ownerKey, isCurrentOwner]);
    const updateBase = React.useCallback((next: Base) => { baseRef.current = next; setBase(next); }, []);
    const updateRefusal = React.useCallback((next: WorkspaceFileEditorRefusal | null) => { refusalRef.current = next; setRefusal(next); }, []);
    const persist = React.useCallback(() => {
        if (!isCurrentOwner() || !latest.current.accountId) return false;
        try {
            latest.current.persistDraft?.(editing.current && text.current !== baseRef.current.text
                ? { accountId: latest.current.accountId, isEditingFile: true, editorOriginalHash: baseRef.current.hash, editorText: text.current } : null);
            setDraftPersistenceFailed(false);
            return true;
        } catch { setDraftPersistenceFailed(true); return false; }
    }, [isCurrentOwner]);
    const prepareEditorTransition = React.useCallback(async () => {
        if (!isCurrentOwner()) return false;
        const handle = editorHandleRef.current;
        try {
            await handle?.flushPendingChange();
            if (!isCurrentOwner() || editorHandleRef.current !== handle) return false;
            text.current = handle?.getValue() ?? text.current;
            liveValue.publish(text.current);
            setEditorDirty(editing.current && text.current !== baseRef.current.text);
            return persist();
        } catch {
            if (isCurrentOwner() && editorHandleRef.current === handle) {
                updateRefusal({ kind: 'failed', message: t('errors.operationFailed') });
            }
            return false;
        }
    }, [isCurrentOwner, liveValue, persist, updateRefusal]);
    const publishDebounce = React.useMemo(() => createAdvancedDebounce<string>(value => {
        if (!isCurrentOwner()) return;
        liveValue.publish(value); persist();
    }, { delay: input.filesEditorChangeDebounceMs }), [input.filesEditorChangeDebounceMs, isCurrentOwner, liveValue, persist]);
    const conflictNow = React.useCallback(() => {
        const disk = latest.current;
        if (supersededDisk.current?.text === disk.fileText && supersededDisk.current.hash === disk.fileHash) return null;
        return deriveWorkspaceFileEditorConflict({ isEditingFile: editing.current, baseHash: baseRef.current.hash,
            diskHash: disk.fileHash, diskText: disk.fileText, draftText: text.current });
    }, []);
    const conflict = conflictNow();
    const saveRef = React.useRef<((automatic: boolean, shown?: Readonly<{ hash: string; encoding?: Encoding }>) => Promise<boolean>) | null>(null);
    const autoSave = React.useMemo(() => createAdvancedDebounce<void>(() => {
        if (!isCurrentOwner() || !latest.current.filesEditorAutoSave || latest.current.unreachable || refusalRef.current || conflictNow()) return;
        void saveRef.current?.(true);
    }, { delay: input.filesEditorChangeDebounceMs, immediateCount: 0 }), [input.filesEditorChangeDebounceMs, isCurrentOwner, conflictNow]);

    if (stateOwner !== ownerKey) {
        saving.current?.abort(); saving.current = null; autoSave.cancel(); publishDebounce.cancel(); setStateOwner(ownerKey);
        const nextBase: Base = { text: draft && draft.editorOriginalHash !== input.fileHash ? null : input.fileText,
            hash: draft ? draft.editorOriginalHash : input.fileHash,
            encoding: draft && draft.editorOriginalHash !== input.fileHash ? undefined : input.encoding };
        baseRef.current = nextBase; setBase(nextBase); text.current = draft?.editorText ?? input.fileText ?? '';
        editing.current = draft?.isEditingFile === true; setIsEditingFile(editing.current); setEditorSeedText(text.current);
        setEditorDirty(editing.current && text.current !== nextBase.text);
        editorHandleRef.current = null; supersededDisk.current = null; setAside.current = null;
        refusalRef.current = draft && input.unreachable ? { kind: 'unreachable' } : null; setRefusal(refusalRef.current);
        setIsSavingEdits(false); setSavedAtMs(null); setDraftPersistenceFailed(false);
        setPendingStart(input.initialEditing === true && draft?.isEditingFile !== true);
        setInitialLine(undefined); initialTop.current = undefined; setEditorResetKey(key => key + 1);
    }
    React.useEffect(() => { liveValue.publish(text.current); }, [liveValue, ownerKey]);
    React.useEffect(() => () => {
        saving.current?.abort(); saving.current = null; autoSave.cancel(); publishDebounce.flush(); publishDebounce.cancel();
        persist(); retirePresentationNotice(noticeKey);
    }, [autoSave, noticeKey, persist, publishDebounce]);
    React.useEffect(() => subscribePresentationNotices(() => {
        if (readPresentationNotice()?.key !== noticeKey) setAside.current = null;
    }), [noticeKey]);
    React.useEffect(() => {
        if (savedAtMs === null) return;
        const timer = setTimeout(() => setSavedAtMs(null), 2000); return () => clearTimeout(timer);
    }, [savedAtMs]);
    React.useEffect(() => {
        if (input.unreachable && editing.current) { updateRefusal({ kind: 'unreachable' }); autoSave.cancel(); }
    }, [autoSave, input.unreachable, isEditingFile, updateRefusal]);
    const reseed = React.useCallback((value: string) => {
        text.current = value; setEditorSeedText(value); liveValue.publish(value); setEditorResetKey(key => key + 1);
        setEditorDirty(editing.current && value !== baseRef.current.text);
    }, [liveValue]);
    const rebaseMergedDraft = React.useCallback((value: string, shown?: Omit<EditorComparisonResolution, 'text'>) => {
        if (!isCurrentOwner()) return; const disk = latest.current;
        if (!shown && (disk.fileText === null || disk.fileHash === null)) return;
        updateBase({ text: shown?.baseText ?? disk.fileText, hash: shown?.baseHash ?? disk.fileHash,
            encoding: shown ? shown.baseEncoding : disk.encoding });
        if (editorHandleRef.current?.runCommand) { editorHandleRef.current.runCommand({ replaceDocument: value }); text.current = value; liveValue.publish(value); setEditorDirty(value !== baseRef.current.text); }
        else reseed(value);
        persist();
    }, [isCurrentOwner, liveValue, persist, reseed, updateBase]);
    const acceptComparison = React.useCallback((resolution: EditorComparisonResolution) => {
        rebaseMergedDraft(resolution.text, resolution);
    }, [rebaseMergedDraft]);
    const comparisonController = useWorkspaceFileEditorComparison({ ownerKey, onAccept: acceptComparison });
    const { comparison, usePlaceMine, usePlaceTheirs, useAllMine, useAllTheirs, backToEditing } = comparisonController;
    React.useEffect(() => {
        if (typeof input.fileText !== 'string') return;
        // A save can normalize disk line endings without changing the editor's
        // admitted document or its undo stack. The returned raw-byte hash owns
        // that version; its later decoded read is not an external replacement.
        if (editing.current && input.fileHash !== null && input.fileHash === baseRef.current.hash) {
            if (baseRef.current.text === null) {
                // The first matching read completes a restored base, never the
                // live draft or the engine's undo stack.
                updateBase({ text: input.fileText, hash: input.fileHash, encoding: input.encoding });
                setEditorDirty(text.current !== input.fileText);
                persist();
            }
            return;
        }
        if (supersededDisk.current?.text === input.fileText && supersededDisk.current.hash === input.fileHash) return;
        supersededDisk.current = null;
        if (!editing.current || text.current === baseRef.current.text || text.current === input.fileText) {
            backToEditing();
            const retain = editing.current && text.current !== baseRef.current.text;
            updateBase({ text: input.fileText, hash: input.fileHash, encoding: input.encoding });
            if (!retain) reseed(input.fileText);
            setEditorDirty(false);
            if (retain) persist();
        }
    }, [backToEditing, input.fileText, input.fileHash, input.encoding, updateBase, persist, reseed]);
    React.useEffect(() => {
        if (input.filesEditorAutoSave && isEditingFile && editorDirty && !conflict && !refusal && !input.unreachable) autoSave.debounced();
        else autoSave.cancel();
        return () => autoSave.cancel();
    }, [autoSave, editorDirty, isEditingFile, input.filesEditorAutoSave, input.unreachable, conflict?.theirsHash, refusal]);
    const editorSurfaceEnabled = input.fileEditorFeatureEnabled && input.encoding?.editable !== false
        && (input.fileWriteSupported || input.unreachable === true)
        && (Platform.OS === 'web' ? input.filesEditorWebMonacoEnabled : input.filesEditorNativeCodeMirrorEnabled);
    const startEditingFile = React.useCallback((at?: WorkspaceFileEditStart) => {
        if (!isCurrentOwner() || !editorSurfaceEnabled) return;
        const line = at && Number.isFinite(at.line) ? Math.max(1, Math.trunc(at.line)) : undefined;
        const top = line !== undefined && at?.top && Number.isFinite(at.top.line) && Number.isFinite(at.top.offset) ? at.top : undefined;
        retireUndo(); if (line !== undefined) { setInitialLine(line); initialTop.current = top; }
        if (editing.current) {
            // View and Changes may unmount the engine while the draft stays open.
            // A returning engine must start from that retained draft, not the old seed.
            setEditorSeedText(text.current);
            if (line !== undefined) editorHandleRef.current?.revealLine?.(line, { focus: true, ...(top ? { top } : {}) });
            return;
        }
        if (latest.current.fileText === null || latest.current.displayMode !== 'file') { setPendingStart(true); return; }
        updateBase({ text: latest.current.fileText, hash: latest.current.fileHash, encoding: latest.current.encoding });
        editing.current = true; setIsEditingFile(true); reseed(latest.current.fileText); setEditorDirty(false); setPendingStart(false);
        if (latest.current.unreachable) updateRefusal({ kind: 'unreachable' });
    }, [editorSurfaceEnabled, isCurrentOwner, reseed, retireUndo, updateBase, updateRefusal]);
    React.useEffect(() => { if (pendingStart && input.displayMode === 'file' && input.fileText !== null) startEditingFile(); }, [pendingStart, input.displayMode, input.fileText, startEditingFile]);
    const onEditorReady = React.useCallback(() => {
        const top = initialTop.current;
        if (isCurrentOwner() && initialLine !== undefined) editorHandleRef.current?.revealLine?.(initialLine, { focus: true, ...(top ? { top } : {}) });
    }, [initialLine, isCurrentOwner]);
    const onEditorChange = React.useCallback((value: string) => {
        if (!isCurrentOwner()) return;
        const wasDirty = editing.current && text.current !== baseRef.current.text;
        backToEditing(); retireUndo(); text.current = value;
        if (latest.current.fileText === value && latest.current.fileHash !== null && latest.current.fileHash !== baseRef.current.hash) {
            updateBase({ text: value, hash: latest.current.fileHash, encoding: latest.current.encoding });
        }
        const dirty = editing.current && value !== baseRef.current.text;
        // Cross-tab writes consume the persisted draft as the dirty fact. Keep
        // that transition synchronous even when subsequent text is debounced.
        if (dirty !== wasDirty) persist();
        setEditorDirty(previous => previous === dirty ? previous : dirty); publishDebounce.debounced(value);
        if (dirty && latest.current.filesEditorAutoSave && !latest.current.unreachable && !refusalRef.current && !conflictNow()) autoSave.debounced();
        else autoSave.cancel();
    }, [autoSave, backToEditing, conflictNow, isCurrentOwner, persist, publishDebounce, retireUndo, updateBase]);
    const getEditorText = React.useCallback(() => isCurrentOwner() ? text.current : '', [isCurrentOwner]);

    // Mounted result custody is shared by Save and its guarded inverse. The
    // filesystem Action remains the sole admission and write owner.
    const writeWithApproval = React.useCallback(async (target: Input, content: string, expectedHash: string | null, signal: AbortSignal) => {
        const response = await workspaceWriteFile({ scope: target.scope, path: target.filePath, content, expectedHash, signal });
        if (signal.aborted || response.success || response.kind !== 'approval_required'
            || !response.approvalArtifactId || !target.accountId || !target.requestApproval) return response;
        updateRefusal({ kind: 'awaitingApproval' });
        const artifactId = response.approvalArtifactId;
        const accountId = target.accountId;
        return await awaitActionApprovalResult<unknown, WorkspaceWriteFileResponse>({
            signal,
            execute: async callbacks => {
                target.requestApproval?.(createActionApprovalContinuation({ artifactId, actionId: 'daemon.filesystem.writeFile',
                    scope: { serverId: target.scope.serverId, accountId }, signal,
                    expectedInput: { rootPath: target.scope.rootPath,
                        path: resolveMachineAbsolutePath({ rootPath: target.scope.rootPath, requestPath: target.filePath, pathKind: 'workspace_entry' }),
                        content: encodeBase64(new TextEncoder().encode(content), 'base64'), expectedHash },
                    onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
                }));
                return { approvalPending: true };
            },
            succeeded: value => {
                const parsed = FilesystemWriteFileOutputSchema.safeParse(value);
                if (!parsed.success) return classifyWorkspaceWriteFileFailure({ success: false, error: 'invalid_action_output' });
                return parsed.data.success ? parsed.data : classifyWorkspaceWriteFileFailure(parsed.data);
            },
            failed: (code, failure) => classifyWorkspaceWriteFileFailure({ success: false, error: failure?.error ?? code, errorCode: code }),
            aborted: () => classifyWorkspaceWriteFileFailure({ success: false, error: 'aborted' }),
        });
    }, [updateRefusal]);

    const saveEdits = React.useCallback(async (automatic: boolean, shown?: Readonly<{ hash: string; encoding?: Encoding }>): Promise<boolean> => {
        if (!isCurrentOwner() || !editing.current || !editorSurfaceEnabled) return false;
        if (saving.current && rereadAfterSave.current && !automatic) await rereadAfterSave.current.catch(() => undefined);
        if (!isCurrentOwner() || !editing.current || saving.current) return false;
        if (automatic && (latest.current.unreachable || refusalRef.current || conflictNow())) return false;
        backToEditing(); retireUndo(); const identity = new AbortController(); saving.current = identity;
        const isCurrentSave = () => saving.current === identity && !identity.signal.aborted && isCurrentOwner() && latest.current.mountedRef.current;
        setIsSavingEdits(true); let succeeded = false;
        try {
            await editorHandleRef.current?.flushPendingChange(); if (!isCurrentSave()) return false;
            const sent = editorHandleRef.current?.getValue() ?? text.current; text.current = sent; publishDebounce.flush();
            if (!shown && (conflictNow() || sent === baseRef.current.text)) return false;
            if (!shown && baseRef.current.text === null && baseRef.current.hash !== null && !baseRef.current.encoding) {
                const expectedHash = baseRef.current.hash;
                const observed = await latest.current.readFileForSave?.();
                if (!isCurrentSave()) return false;
                if (!observed || observed.isBinary || observed.partial || !observed.encoding?.editable || !observed.contentHash) {
                    updateRefusal({ kind: 'failed', message: t('files.fileReadFailed') });
                    return false;
                }
                // A different disk version belongs to the existing conflict
                // owner. Never serialize the old draft with its metadata.
                if (observed.contentHash !== expectedHash) return false;
                updateBase({ text: observed.content, hash: observed.contentHash, encoding: observed.encoding });
                setEditorDirty(text.current !== observed.content);
                persist();
                if (sent === observed.content) return false;
            }
            const encoding = shown ? shown.encoding : baseRef.current.encoding
                ?? (latest.current.fileHash === baseRef.current.hash ? latest.current.encoding : undefined);
            const normalized = encoding ? sent.replace(/\r\n|\r|\n/g, encoding.eol === 'crlf' ? '\r\n' : '\n') : sent;
            const content = restoreWorkspaceFileTextBom(normalized, encoding);
            const expectedHash = shown?.hash ?? baseRef.current.hash;
            const target = latest.current;
            const response = await writeWithApproval(target, content, expectedHash, identity.signal);
            if (!isCurrentSave()) return false;
            if (!response.success) {
                if (Platform.OS !== 'web') void hapticsError();
                if (response.kind === 'conflict') { await target.refreshAll(); return false; }
                if (response.kind === 'unsupported') target.setFileWriteSupported(false);
                updateRefusal({ kind: response.kind === 'approval_required' ? 'awaitingApproval' : response.kind, message: response.error }); return false;
            }
            supersededDisk.current = { text: latest.current.fileText, hash: latest.current.fileHash };
            updateBase({ text: sent, hash: response.hash, encoding });
            const live = editorHandleRef.current?.getValue() ?? text.current;
            text.current = live; setEditorDirty(live !== sent); liveValue.publish(live);
            updateRefusal(null); setSavedAtMs(Date.now()); target.publishSavedFile?.({ text: normalized, hash: response.hash });
            if (Platform.OS !== 'web') void hapticsSuccess();
            // The write landed: Saving ends here and Saved shows now. The re-read that follows (page facts, change
            // marks) can take seconds on a slow machine; it still holds the save lock so no second write races it,
            // and a Save pressed meanwhile waits for it instead of being dropped.
            persist(); succeeded = true; setIsSavingEdits(false);
            const reread = target.refreshAll(); rereadAfterSave.current = reread;
            try { await reread; } finally { if (rereadAfterSave.current === reread) rereadAfterSave.current = null; }
            return true;
        } catch (error) {
            if (succeeded) return true;
            if (isCurrentSave()) {
                const failure = classifyWorkspaceWriteFileFailure({ success: false,
                    error: error instanceof Error ? error.message : String(error), errorCode: readRpcErrorCode(error) });
                updateRefusal({ kind: failure.kind === 'unreachable' ? 'unreachable' : 'failed', message: failure.error });
                if (Platform.OS !== 'web') void hapticsError();
            }
            return false;
        } finally {
            const current = isCurrentSave(); if (saving.current === identity) saving.current = null;
            if (current) { setIsSavingEdits(false); if (succeeded && text.current !== baseRef.current.text && latest.current.filesEditorAutoSave) autoSave.debounced(); }
        }
    }, [autoSave, backToEditing, conflictNow, editorSurfaceEnabled, isCurrentOwner, liveValue, persist, publishDebounce, retireUndo, updateBase, updateRefusal, writeWithApproval]);
    saveRef.current = saveEdits;
    const saveFileEdits = React.useCallback(() => saveEdits(false), [saveEdits]);
    const undoSetAside = React.useCallback(async () => {
        if (!isCurrentOwner() || saving.current || readPresentationNotice()?.key !== noticeKey) return;
        const snapshot = setAside.current; if (!snapshot) return; retireUndo();
        if (snapshot.kind === 'draft') { updateBase(snapshot.base); reseed(snapshot.text); persist(); return; }
        const target = latest.current;
        const identity = new AbortController(); saving.current = identity; setIsSavingEdits(true);
        const isCurrentWrite = () => saving.current === identity && !identity.signal.aborted && isCurrentOwner() && target.mountedRef.current;
        try {
            const response = await writeWithApproval(target, restoreWorkspaceFileTextBom(snapshot.text, snapshot.encoding), snapshot.hash, identity.signal);
            if (!isCurrentWrite()) return;
            if (!response.success) {
                if (response.kind !== 'conflict') updateRefusal({ kind: response.kind === 'approval_required' ? 'awaitingApproval' : response.kind, message: response.error });
                if (response.kind === 'unsupported') target.setFileWriteSupported(false);
                if (Platform.OS !== 'web') void hapticsError();
                await target.refreshAll(); return;
            }
            supersededDisk.current = { text: target.fileText, hash: target.fileHash };
            updateBase({ text: snapshot.text, hash: response.hash, encoding: snapshot.encoding }); reseed(snapshot.text);
            updateRefusal(null);
            target.publishSavedFile?.({ text: snapshot.text, hash: response.hash }); persist(); await target.refreshAll();
        } catch (error) {
            if (isCurrentWrite()) {
                const failure = classifyWorkspaceWriteFileFailure({ success: false,
                    error: error instanceof Error ? error.message : String(error), errorCode: readRpcErrorCode(error) });
                updateRefusal({ kind: failure.kind === 'unreachable' ? 'unreachable' : 'failed', message: failure.error });
                if (Platform.OS !== 'web') void hapticsError();
            }
        } finally {
            const current = isCurrentWrite(); if (saving.current === identity) saving.current = null;
            if (current) setIsSavingEdits(false);
        }
    }, [isCurrentOwner, noticeKey, persist, reseed, retireUndo, updateBase, updateRefusal, writeWithApproval]);
    const resolveConflict = React.useCallback(async (choice: 'useMine' | 'useTheirs') => {
        if (!isCurrentOwner()) return; await editorHandleRef.current?.flushPendingChange(); if (!isCurrentOwner()) return;
        const shown = conflictNow(); if (!shown) return;
        backToEditing();
        const displaced: SetAside = { kind: 'draft', text: editorHandleRef.current?.getValue() ?? text.current, base: baseRef.current };
        retireUndo();
        if (choice === 'useTheirs') {
            updateBase({ text: shown.theirsText, hash: shown.theirsHash, encoding: latest.current.encoding }); reseed(shown.theirsText); setAside.current = displaced; persist();
        } else {
            const encoding = latest.current.encoding; if (!await saveEdits(false, { hash: shown.theirsHash, encoding })) return;
            setAside.current = { kind: 'disk', text: shown.theirsText, hash: baseRef.current.hash!, encoding };
        }
        const agentName = latest.current.agentName;
        publishPresentationNotice({ key: noticeKey, severity: 'info', sticky: true,
            message: choice === 'useTheirs' ? t('files.editing.editsSetAside')
                : agentName ? t('files.editing.agentVersionReplaced', { agent: agentName }) : t('files.editing.diskVersionReplaced'),
            undo: { label: t('common.undo'), run: () => { void undoSetAside(); } } });
    }, [backToEditing, conflictNow, isCurrentOwner, noticeKey, persist, reseed, retireUndo, saveEdits, undoSetAside, updateBase]);
    const cancelEditingFile = React.useCallback(() => {
        if (!isCurrentOwner()) return; retireUndo(); autoSave.cancel(); publishDebounce.cancel();
        editing.current = false; setIsEditingFile(false); setPendingStart(false); backToEditing();
        reseed(latest.current.fileText ?? baseRef.current.text ?? ''); setEditorDirty(false); updateRefusal(null); persist();
        latest.current.onStopEditing?.();
    }, [autoSave, backToEditing, isCurrentOwner, persist, publishDebounce, reseed, retireUndo, updateRefusal]);
    const doneEditingFile = React.useCallback(async () => {
        if (!isCurrentOwner() || !editing.current || saving.current) return;
        await editorHandleRef.current?.flushPendingChange();
        if (!isCurrentOwner() || !editing.current || saving.current) return;
        onEditorChange(editorHandleRef.current?.getValue() ?? text.current);
        if (text.current !== baseRef.current.text) return;
        retireUndo(); editing.current = false; setIsEditingFile(false); persist();
        latest.current.onStopEditing?.();
    }, [isCurrentOwner, onEditorChange, persist, retireUndo]);
    const startComparison = React.useCallback(() => {
        void (async () => {
            if (!isCurrentOwner() || !editing.current) return;
            await editorHandleRef.current?.flushPendingChange();
            const disk = latest.current;
            if (!isCurrentOwner() || !editing.current || disk.fileText === null || disk.fileHash === null) return;
            retireUndo(); autoSave.cancel();
            const mineText = editorHandleRef.current?.getValue() ?? text.current;
            text.current = mineText;
            comparisonController.startComparison({ baseText: baseRef.current.text, mineText, theirsText: disk.fileText,
                theirsHash: disk.fileHash, theirsEncoding: disk.encoding });
        })();
    }, [autoSave, comparisonController.startComparison, isCurrentOwner, retireUndo]);
    const readSnapshot = React.useCallback(() => ({ isEditingFile: isCurrentOwner() && editing.current,
        savedText: isCurrentOwner() ? baseRef.current.text : null,
        hash: isCurrentOwner() ? baseRef.current.hash : null, encoding: isCurrentOwner() ? baseRef.current.encoding : undefined,
        dirty: isCurrentOwner() && editing.current && text.current !== baseRef.current.text,
        conflict: isCurrentOwner() ? conflictNow() : null }), [conflictNow, isCurrentOwner]);
    return { editorSurfaceEnabled, isEditingFile, editorResetKey, editorOriginalText: base.text, editorOriginalHash: base.hash,
        editorSeedText, editorHandleRef, onEditorChange, getEditorText, liveValue, isSavingEdits, editorDirty,
        editorStatus: conflict ? 'conflict' : isSavingEdits ? 'saving' : editorDirty ? 'dirty' : 'clean', conflict, refusal,
        draftPersistenceFailed: editorDirty && (draftPersistenceFailed || input.panePersistenceFailed === true),
        savedAtMs, initialLine, onEditorReady, startEditingFile, cancelEditingFile, doneEditingFile, prepareEditorTransition,
        lineEndingNormalization: editorDirty && base.encoding?.mixedEol ? base.encoding.eol : null,
        saveFileEdits, resolveConflict, undoSetAside, isComparing: comparison !== null, comparison, startComparison,
        usePlaceMine, usePlaceTheirs, useAllMine, useAllTheirs, backToEditing, rebaseMergedDraft, readSnapshot };
}
