import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import {
    cleanupWorkspaceFileDetailsActionBoundary,
    getWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsCommonModuleMocks,
    prepareWorkspaceFileDetailsActionBoundary,
} from './workspaceFileDetailsTestHelpers';
import { readWorkspaceFileEditorDraft, type WorkspaceFileEditorDraft } from './workspaceFileEditorDraft';
import { applyMoveDetailsTabToGroup, applyOpenDetailsTab, applySetDetailsTabState, applySplitDetailsGroup, createEmptyPaneDetailsState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceReducer';
import { migrateLegacyDetailsWorkspaceState, serializeDetailsWorkspaceState } from '@/components/appShell/panes/details/workspace/migrateLegacyDetailsWorkspaceState';
import { ScmChangeDiscardResponseSchema } from '@happier-dev/protocol/scm';
import type { EditorDocumentHistory } from '@/components/ui/code/editor/codeEditorTypes';

const discardBoundary = vi.hoisted(() => vi.fn());
// Remote transport is the boundary; Action admission, the discard facade and dirty-editor owner stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: discardBoundary }));

installWorkspaceFileDetailsCommonModuleMocks();
installWorkspaceFileDetailsActionBoundary();
const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');
const { useFileChangesActions } = await import('@/components/workspaces/files/file/changes/useFileChangesActions');
const { Modal } = await import('@/modal');
const actionBoundary = getWorkspaceFileDetailsActionBoundary();

type Inputs = Readonly<{
    displayMode: 'file' | 'diff';
    fileText: string | null;
    fileHash: string | null;
    persistedDraft?: WorkspaceFileEditorDraft | null;
}>;
let serverId = 'srv1';
async function harness(initial: Inputs, onPersist?: (draft: WorkspaceFileEditorDraft | null) => void) {
    const persistDraft = vi.fn(onPersist);
    const refreshAll = vi.fn(async () => undefined);
    const mountedRef = { current: true };
    const setFileWriteSupported = vi.fn();
    return renderHook((props: Inputs) => useWorkspaceFileEditorState({
        accountId: 'alice', scope: { serverId, machineId: 'm1', rootPath: '/repo' }, filePath: 'src/a.ts',
        ...props, fileWriteSupported: true, setFileWriteSupported,
        fileEditorFeatureEnabled: true, filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
        filesEditorAutoSave: false, filesEditorChangeDebounceMs: 10,
        mountedRef, refreshAll, persistDraft,
    }), { initialProps: initial });
}

describe('file editor entry and persisted restoration', () => {
    beforeEach(async () => {
        serverId = await prepareWorkspaceFileDetailsActionBoundary();
        actionBoundary.read.mockReset().mockResolvedValue({ success: true, hash: 'saved' });
    });
    afterEach(async () => {
        await standardCleanup();
        await cleanupWorkspaceFileDetailsActionBoundary();
    });

    it('undoes the same document after leaving Edit for Changes and View, including successive engine edits', async () => {
        const original = '# Title\r\nhello 🌍\r\n';
        const raw = original.replace('hello', 'hello there');
        const rich = raw.replace('# Title', '## Title');
        const hook = await harness({ displayMode: 'file', fileText: original, fileHash: 'base-hash' });
        await act(async () => { hook.getCurrent().startEditingFile(); hook.getCurrent().onEditorChange(raw); });
        await hook.rerender({ displayMode: 'diff', fileText: original, fileHash: 'base-hash' });
        await hook.rerender({ displayMode: 'file', fileText: original, fileHash: 'base-hash' });
        await act(async () => { hook.getCurrent().startEditingFile(); hook.getCurrent().onEditorChange(rich); });
        // The File's owner must retain history when the outgoing engine has been destroyed.
        const history: EditorDocumentHistory | undefined = Reflect.get(hook.getCurrent(), 'history');
        expect(history?.undo(rich)).toBe(raw);
        await act(async () => { hook.getCurrent().onEditorChange(raw, { history: 'undo' }); });
        expect(hook.getCurrent().getEditorText()).toBe(raw);
        expect(history?.undo(raw)).toBe(original);
        await act(async () => { hook.getCurrent().onEditorChange(original, { history: 'undo' }); });
        expect(history?.redo(original)).toBe(raw);
        await act(async () => { hook.getCurrent().onEditorChange(raw, { history: 'redo' }); });
        expect(history?.redo(raw)).toBe(rich);
        await act(async () => { hook.getCurrent().onEditorChange(rich, { history: 'redo' }); });
        expect(hook.getCurrent().getEditorText()).toBe(rich);
    });

    it('records an owner-applied document replacement once when the engine publishes synchronously', async () => {
        const hook = await harness({ displayMode: 'file', fileText: 'base', fileHash: 'base-hash' });
        await act(async () => { hook.getCurrent().startEditingFile(); hook.getCurrent().onEditorChange('base edited'); });
        let pending = true;
        hook.getCurrent().editorHandleRef.current = {
            getValue: () => hook.getCurrent().getEditorText(),
            flushPendingChange: async () => { if (pending) { pending = false; hook.getCurrent().onEditorChange('base pending'); } },
            runCommand: (command) => {
                if (typeof command === 'object' && 'replaceDocument' in command) hook.getCurrent().onEditorChange(command.replaceDocument);
            },
        };
        await act(async () => { await hook.getCurrent().rebaseMergedDraft('merged', { baseText: 'disk', baseHash: 'disk-hash' }); });
        const history = hook.getCurrent().history;
        expect(history.undo('merged')).toBe('base pending');
        expect(history.undo('base pending')).toBe('base edited');
        expect(history.undo('base edited')).toBe('base');
        expect(history.getSnapshot().canUndo).toBe(false);
    });

    it('keeps the active draft and reports failure when the engine cannot confirm pending text', async () => {
        const hook = await harness({ displayMode: 'file', fileText: 'base', fileHash: 'base-hash' });
        await act(async () => { hook.getCurrent().startEditingFile(); hook.getCurrent().onEditorChange('draft'); });
        hook.getCurrent().editorHandleRef.current = { getValue: () => 'draft',
            flushPendingChange: async () => { throw new Error('snapshot_unavailable'); } };
        await act(async () => { await expect(hook.getCurrent().doneEditingFile()).resolves.toBeUndefined(); });
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().getEditorText()).toBe('draft');
        expect(hook.getCurrent().refusal?.kind).toBe('failed');
        await act(async () => { expect(await hook.getCurrent().saveFileEdits()).toBe(false); });
        expect(hook.getCurrent().getEditorText()).toBe('draft');
    });

    it('persists the final engine snapshot with its original base without saving the file during transfer', async () => {
        const drafts: Array<WorkspaceFileEditorDraft | null> = [];
        const hook = await harness({ displayMode: 'file', fileText: 'base', fileHash: 'base-hash' }, draft => drafts.push(draft));
        await act(async () => hook.getCurrent().startEditingFile());
        // The editor engine's imperative handle is the boundary: its last bytes have not reached onChange yet.
        const flushPendingChange = vi.fn(async () => {});
        hook.getCurrent().editorHandleRef.current = { getValue: () => 'pending engine bytes', flushPendingChange };
        await act(async () => { expect(await hook.getCurrent().prepareEditorTransition()).toBe(true); });
        expect(flushPendingChange).toHaveBeenCalledTimes(1);
        expect(drafts.at(-1)).toEqual({ accountId: 'alice', isEditingFile: true, editorText: 'pending engine bytes', editorOriginalHash: 'base-hash' });
        expect(hook.getCurrent().getEditorText()).toBe('pending engine bytes');
        expect(hook.getCurrent().editorDirty).toBe(true);
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(actionBoundary.calls).toEqual([]);
        await hook.unmount();
    });

    it.each([
        { displayMode: 'diff' as const, fileText: 'base', fileHash: 'base-hash' },
        { displayMode: 'file' as const, fileText: null, fileHash: null },
    ])('opens the requested editor once complete content is available ($displayMode)', async (initial) => {
        const hook = await harness(initial);
        await act(async () => hook.getCurrent().startEditingFile());
        expect(hook.getCurrent().isEditingFile).toBe(false);
        await hook.rerender({ displayMode: 'file', fileText: 'base', fileHash: 'base-hash' });
        expect(hook.getCurrent().isEditingFile).toBe(true);
    });

    it('opens on the reader\'s position: caret line plus the row kept at the top (Edit from View)', async () => {
        const hook = await harness({ displayMode: 'file', fileText: 'a\nb\nc\nd', fileHash: 'base-hash' });
        await act(async () => hook.getCurrent().startEditingFile({ line: 3, top: { line: 2, offset: -4 } }));
        expect(hook.getCurrent().initialLine).toBe(3);
        const revealLine = vi.fn();
        hook.getCurrent().editorHandleRef.current = { revealLine } as never;
        await act(async () => hook.getCurrent().onEditorReady());
        expect(revealLine).toHaveBeenCalledWith(3, { focus: true, top: { line: 2, offset: -4 } });
        // Already editing: the open engine moves to the requested line (centred when no top is given).
        await act(async () => hook.getCurrent().startEditingFile({ line: 4 }));
        expect(revealLine).toHaveBeenLastCalledWith(4, { focus: true });
    });

    it('keeps the save callback stable across equivalent disk rerenders', async () => {
        const inputs: Inputs = { displayMode: 'file', fileText: 'base', fileHash: 'hash' };
        const hook = await harness(inputs);
        const save = hook.getCurrent().saveFileEdits;
        await hook.rerender({ ...inputs });
        expect(hook.getCurrent().saveFileEdits).toBe(save);
    });

    it.each([
        { status: 'kept_edited', expectedText: 'unfinished draft', dirty: true },
        { status: 'restored', expectedText: 'saved edit', dirty: false },
    ] as const)('preserves the draft unless discard replaced saved bytes ($status)', async ({ status, expectedText, dirty }) => {
        vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        discardBoundary.mockResolvedValue(ScmChangeDiscardResponseSchema.parse({ success: true, entries: [{ path: 'src/a.ts', status,
            hashBefore: 'a'.repeat(64), hashAfter: 'a'.repeat(64) }] }));
        const hook = await renderHook(() => {
            const editor = useWorkspaceFileEditorState({
                accountId: 'alice', scope: { serverId, machineId: 'm1', rootPath: '/repo' }, filePath: 'src/a.ts',
                displayMode: 'file', fileText: 'saved edit', fileHash: 'a'.repeat(64),
                fileWriteSupported: true, setFileWriteSupported: () => {},
                fileEditorFeatureEnabled: true, filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false, filesEditorChangeDebounceMs: 10, mountedRef: { current: true },
                refreshAll: async () => {},
            });
            const actions = useFileChangesActions({
                target: { serverId, machineId: 'm1', rootPath: '/repo' }, filePath: 'src/a.ts',
                selector: { kind: 'workingTree' }, comparison: null, changed: true, expectedHash: 'a'.repeat(64),
                messages: { moved_on: '', update_required: '', unsupported: '', unavailable: '', unknown: '', discarded: '',
                    restored: '', kept_edited: '', undone: '', undo_conflict: '', undo: '', note_failed: '', undo_unavailable: '' },
                refresh: async () => {},
                hasUnsavedEdits: () => editor.readSnapshot().dirty, onReplacedUnsavedEdits: editor.cancelEditingFile,
                confirmUnsaved: { title: 'Replace edits' },
            });
            return { editor, actions };
        });
        await act(async () => { hook.getCurrent().editor.startEditingFile(); hook.getCurrent().editor.onEditorChange('unfinished draft'); });
        await act(async () => { await hook.getCurrent().actions.changes.discardAll?.(); });
        expect(hook.getCurrent().editor.getEditorText()).toBe(expectedText);
        expect(hook.getCurrent().editor.readSnapshot().dirty).toBe(dirty);
        expect(hook.getCurrent().actions.result).toMatchObject({ ok: true, entry: { status } });
    });

    it('reads current text before the existing debounced subscription publishes it', async () => {
        const hook = await harness({ displayMode: 'file', fileText: 'base', fileHash: 'base-hash' });
        await act(async () => hook.getCurrent().startEditingFile());
        vi.useFakeTimers();
        const notified = vi.fn();
        const unsubscribe = hook.getCurrent().liveValue.subscribe(notified);
        try {
            await act(async () => {
                hook.getCurrent().onEditorChange('first');
                hook.getCurrent().onEditorChange('second');
                hook.getCurrent().onEditorChange('third');
            });
            // A query flush must never read the previous debounce publication.
            expect(hook.getCurrent().liveValue.get()).toBe('third');
            expect(notified).toHaveBeenCalledTimes(2);
            await act(async () => { await vi.advanceTimersByTimeAsync(10); });
            expect(notified).toHaveBeenCalledTimes(3);
        } finally {
            unsubscribe();
            await hook.unmount();
            vi.useRealTimers();
        }
    });

    it('adopts external content while the editor is clean', async () => {
        const hook = await harness({ displayMode: 'file', fileText: 'base', fileHash: 'base-hash' });
        await act(async () => hook.getCurrent().startEditingFile());
        await hook.rerender({ displayMode: 'file', fileText: 'disk', fileHash: 'disk-hash' });
        expect(hook.getCurrent().getEditorText()).toBe('disk');
        expect(hook.getCurrent().conflict).toBeNull();
        expect(hook.getCurrent().editorDirty).toBe(false);
    });

    it('restores persisted draft bytes and derives a conflict against changed disk without original text', async () => {
        const draft: WorkspaceFileEditorDraft = {
            accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base-hash', editorText: 'unfinished draft',
        };
        const hook = await harness({ displayMode: 'file', fileText: 'disk', fileHash: 'disk-hash', persistedDraft: draft });
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().getEditorText()).toBe('unfinished draft');
        expect(hook.getCurrent().conflict).toEqual({ theirsText: 'disk', theirsHash: 'disk-hash' });
    });

    it('flushes the last edit through persisted tab state before a group move and editor remount', async () => {
        let details = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab: { key: 'file:src/a.ts', kind: 'file', title: 'a.ts', resource: { path: 'src/a.ts' } }, openAs: 'pinned',
        });
        const disk: Inputs = { displayMode: 'file', fileText: 'base', fileHash: 'base-hash' };
        const hook = await harness(disk, draft => { details = applySetDetailsTabState(details, 'file:src/a.ts', draft); });
        await act(async () => {
            hook.getCurrent().startEditingFile();
            hook.getCurrent().onEditorChange('last unsaved edit');
        });
        await hook.unmount();
        details = applySplitDetailsGroup(details, { axis: 'horizontal', groupId: 'group:1' });
        details = applyMoveDetailsTabToGroup(details, { tabKey: 'file:src/a.ts', targetGroupId: 'group:2' });
        const remounted = migrateLegacyDetailsWorkspaceState(JSON.parse(JSON.stringify(serializeDetailsWorkspaceState(details))));
        const persistedDraft = readWorkspaceFileEditorDraft(remounted.tabState['file:src/a.ts'], 'alice');
        expect(persistedDraft).toEqual({ accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base-hash', editorText: 'last unsaved edit' });
        const restored = await harness({ ...disk, persistedDraft });
        expect(restored.getCurrent().getEditorText()).toBe('last unsaved edit');
        expect(restored.getCurrent().editorDirty).toBe(true);
    });

    it('ignores a dev-intermediate draft without its original hash', async () => {
        const oldDraft = { accountId: 'alice', isEditingFile: true, editorOriginalText: 'old', editorText: 'draft' };
        const hook = await harness({
            displayMode: 'file', fileText: 'disk', fileHash: 'disk-hash',
            persistedDraft: readWorkspaceFileEditorDraft(oldDraft, 'alice'),
        });
        expect(hook.getCurrent().isEditingFile).toBe(false);
    });
});
