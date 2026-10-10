import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook } from '@/dev/testkit';
import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetailsTestHelpers';
import { workspaceFileEditorDraftCache } from './workspaceFileEditorDraftCache';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { useWorkspaceFileEditorState } from './useWorkspaceFileEditorState';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { Modal } from '@/modal';

installWorkspaceFileDetailsCommonModuleMocks();

type WriteRpc = typeof import('@/sync/domains/transfers/runtime/transferRuntime').callDaemonWorkspaceWriteFileRpc;
type WriteResponse = Awaited<ReturnType<WriteRpc>>;
const writeRpcSpy = vi.hoisted(() => vi.fn<WriteRpc>());

// Keep file encoding, guarded-write handling and editor state real beneath the daemon RPC boundary.
vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceWriteFileRpc: writeRpcSpy,
}));

const scope = { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' };

async function createHarness(options: Readonly<{
    refreshAll?: () => Promise<void>;
    fileText?: string;
    fileHash?: string;
    startEditing?: boolean;
    accountId?: string | null;
    persistedDraft?: Parameters<typeof workspaceFileEditorDraftCache.setDraft>[0]['draft'];
    deriveAccountFromSelectedHome?: boolean;
}> = {}) {
    const refreshAll = options.refreshAll ?? vi.fn(async () => undefined);
    const persistDraft = vi.fn();
    const accountIdRef = { current: options.accountId === undefined ? 'alice' : options.accountId };
    const hook = await renderHook(() => {
        const selectedAccount = useActiveServerAccountScope(scope.serverId);
        return useWorkspaceFileEditorState({
        scope,
        accountId: options.deriveAccountFromSelectedHome ? selectedAccount?.accountId ?? null : accountIdRef.current,
        filePath: 'src/a.ts',
        displayMode: 'file',
        fileText: options.fileText ?? 'hello',
        fileHash: options.fileHash ?? 'h1',
        fileWriteSupported: true,
        setFileWriteSupported: vi.fn(),
        fileEditorFeatureEnabled: true,
        filesEditorWebMonacoEnabled: true,
        filesEditorNativeCodeMirrorEnabled: true,
        filesEditorAutoSave: true,
        filesEditorChangeDebounceMs: 100,
        filesEditorMaxFileBytes: 1_000_000,
        filesEditorBridgeMaxChunkBytes: 1_000_000,
        mountedRef: { current: true },
        refreshAll,
        persistedDraft: options.persistedDraft ?? null,
        persistDraft,
        });
    });
    if (options.startEditing !== false) await act(async () => hook.getCurrent().startEditingFile());
    return { ...hook, persistDraft, accountIdRef };
}

function writtenRequests() {
    return writeRpcSpy.mock.calls.map(([params]) => ({
        ...params.request,
        content: Buffer.from(params.request.content, 'base64').toString('utf8'),
    }));
}

describe('useWorkspaceFileEditorState autosave', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        writeRpcSpy.mockReset();
        vi.mocked(Modal.show).mockClear();
        for (const accountId of ['alice', 'bob']) workspaceFileEditorDraftCache.setDraft({ accountId, workspaceCacheKey: buildWorkspaceCacheKey(scope), filePath: 'src/a.ts', draft: null });
    });

    afterEach(async () => {
        await act(async () => {
            storage.getState().clearProfileScope();
            publishAppliedActiveServerRuntimeAvailability(false);
        });
        vi.useRealTimers();
    });

    it('does not restore or persist a private draft without captured Account authority', async () => {
        const hook = await createHarness({ accountId: null, startEditing: false,
            persistedDraft: { accountId: 'alice', isEditingFile: true, editorOriginalText: 'hello', editorOriginalHash: 'h1', editorText: 'private draft' } });
        expect(hook.getCurrent().isEditingFile).toBe(false);
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        await act(async () => hook.getCurrent().startEditingFile());
        await act(async () => hook.getCurrent().onEditorChange('new private draft'));
        await act(async () => vi.advanceTimersByTime(100));
        expect(hook.persistDraft).not.toHaveBeenCalled();
    });

    it('resets local editing state on Account changes without losing the first Account’s cached draft', async () => {
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('Alice draft'));
        hook.accountIdRef.current = 'bob';
        await hook.rerender();
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: false, editorDirty: false });
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        hook.accountIdRef.current = 'alice';
        await hook.rerender();
        expect(hook.getCurrent().getEditorText()).toBe('Alice draft');
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: true, editorDirty: true });
    });

    it('does not restore another Account’s persisted pane draft', async () => {
        const hook = await createHarness({ accountId: 'bob', startEditing: false,
            persistedDraft: { accountId: 'alice', isEditingFile: true, editorOriginalText: 'hello', editorOriginalHash: 'h1', editorText: 'Alice pane draft' } });
        expect(hook.getCurrent().isEditingFile).toBe(false);
        expect(hook.getCurrent().getEditorText()).toBe('hello');
    });

    it('reacts to the selected Home’s actual Account publication and fails closed for another Home', async () => {
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://draft.test', generation: 1 });
        storage.setState({ profileScope: { serverId: scope.serverId, accountId: 'alice' } });
        const hook = await createHarness({ deriveAccountFromSelectedHome: true });
        await act(async () => hook.getCurrent().onEditorChange('Alice draft'));
        await act(async () => storage.setState({ profileScope: { serverId: scope.serverId, accountId: 'bob' } }));
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: false, editorDirty: false });
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        await act(async () => storage.setState({ profileScope: { serverId: scope.serverId, accountId: 'alice' } }));
        expect(hook.getCurrent().getEditorText()).toBe('Alice draft');
        await act(async () => publishAppliedActiveServerSnapshot({ serverId: 'another-home', serverUrl: 'https://another.test', generation: 2 }));
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: false, editorDirty: false });
        expect(hook.getCurrent().getEditorText()).toBe('hello');
    });

    it('discards an old editor callback and delayed autosave after changing Account', async () => {
        const hook = await createHarness();
        const oldEditorChange = hook.getCurrent().onEditorChange;
        await act(async () => oldEditorChange('Alice pending write'));
        hook.accountIdRef.current = 'bob';
        await hook.rerender();
        await act(async () => oldEditorChange('Alice delayed callback'));
        await act(async () => vi.advanceTimersByTime(100));
        expect(writeRpcSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        expect(workspaceFileEditorDraftCache.getDraft({ accountId: 'bob', workspaceCacheKey: buildWorkspaceCacheKey(scope), filePath: 'src/a.ts' })).toBeNull();
    });

    it('does not apply an old Account’s completed write to the new editor owner', async () => {
        const pending = createDeferred<WriteResponse>();
        const bobPending = createDeferred<WriteResponse>();
        writeRpcSpy.mockReturnValueOnce(pending.promise).mockReturnValueOnce(bobPending.promise);
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('Alice writing'));
        await act(async () => vi.advanceTimersByTime(100));
        expect(writeRpcSpy).toHaveBeenCalled();
        hook.accountIdRef.current = 'bob';
        await hook.rerender();
        expect(hook.getCurrent().isSavingEdits).toBe(false);
        await act(async () => hook.getCurrent().startEditingFile());
        await act(async () => hook.getCurrent().onEditorChange('Bob writing'));
        await act(async () => vi.advanceTimersByTime(100));
        expect(writtenRequests().map(request => request.content)).toEqual(['Alice writing', 'Bob writing']);
        await act(async () => pending.resolve({ success: true, hash: 'Alice saved basis' }));
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: true, editorDirty: true, isSavingEdits: true, editorOriginalHash: 'h1' });
        expect(hook.getCurrent().getEditorText()).toBe('Bob writing');
        await act(async () => bobPending.resolve({ success: true, hash: 'Bob saved basis' }));
        expect(hook.getCurrent()).toMatchObject({ editorDirty: false, isSavingEdits: false, editorOriginalHash: 'Bob saved basis' });
    });

    it('does not disclose the current Account’s draft through a previous Account’s comparison callback', async () => {
        const hook = await createHarness();
        const oldCompare = hook.getCurrent().compareFileEdits;
        const oldGetText = hook.getCurrent().getEditorText;
        hook.accountIdRef.current = 'bob';
        await hook.rerender();
        await act(async () => hook.getCurrent().startEditingFile());
        await act(async () => hook.getCurrent().onEditorChange('Bob private draft'));
        expect(oldGetText()).toBe('');
        expect(hook.getCurrent().getEditorText()).toBe('Bob private draft');
        oldCompare();
        expect(Modal.show).not.toHaveBeenCalled();
        hook.getCurrent().compareFileEdits();
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: { oldText: 'hello', newText: 'Bob private draft', filePath: 'src/a.ts' },
        }));
    });

    it('keeps the new invocation busy when an earlier save finishes after an Account round trip', async () => {
        const first = createDeferred<WriteResponse>();
        const returned = createDeferred<WriteResponse>();
        writeRpcSpy.mockReturnValueOnce(first.promise).mockReturnValueOnce(returned.promise);
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('Alice first invocation'));
        await act(async () => vi.advanceTimersByTime(100));
        hook.accountIdRef.current = 'bob';
        await hook.rerender();
        hook.accountIdRef.current = 'alice';
        await hook.rerender();
        await act(async () => hook.getCurrent().onEditorChange('Alice returned invocation'));
        await act(async () => vi.advanceTimersByTime(100));
        expect(writtenRequests().map(request => request.content)).toEqual(['Alice first invocation', 'Alice returned invocation']);
        await act(async () => first.resolve({ success: true, hash: 'first' }));
        expect(hook.getCurrent()).toMatchObject({ isSavingEdits: true, editorDirty: true });
        expect(hook.getCurrent().getEditorText()).toBe('Alice returned invocation');
        await act(async () => returned.resolve({ success: true, hash: 'returned' }));
        expect(hook.getCurrent()).toMatchObject({ isSavingEdits: false, editorDirty: false, editorOriginalHash: 'returned' });
    });

    it('saves newer text after an in-flight write using the saved hash and keeps editing', async () => {
        const firstWrite = createDeferred<WriteResponse>();
        const secondWrite = createDeferred<WriteResponse>();
        writeRpcSpy.mockReturnValueOnce(firstWrite.promise).mockReturnValueOnce(secondWrite.promise);
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('hello changed'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(hook.getCurrent().isSavingEdits).toBe(true);
        await act(async () => hook.getCurrent().onEditorChange('hello changed more'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(writtenRequests()).toEqual([{ path: 'src/a.ts', content: 'hello changed', expectedHash: 'h1' }]);

        await act(async () => firstWrite.resolve({ success: true, hash: 'h2' }));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(writtenRequests()).toEqual([
            { path: 'src/a.ts', content: 'hello changed', expectedHash: 'h1' },
            { path: 'src/a.ts', content: 'hello changed more', expectedHash: 'h2' },
        ]);
        await act(async () => secondWrite.resolve({ success: true, hash: 'h3' }));
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().editorDirty).toBe(false);
        expect(hook.getCurrent().getEditorText()).toBe('hello changed more');
        expect(hook.getCurrent().editorOriginalHash).toBe('h3');
    });

    it('keeps editing and debounces the latest text after a successful autosave', async () => {
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h2' });
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('hello changed'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().editorDirty).toBe(false);
        expect(hook.getCurrent().getEditorText()).toBe('hello changed');

        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h3' });
        await act(async () => hook.getCurrent().onEditorChange('hello again'));
        await act(async () => { vi.advanceTimersByTime(90); });
        await act(async () => hook.getCurrent().onEditorChange('hello again!'));
        await act(async () => { vi.advanceTimersByTime(90); });
        expect(writtenRequests()).toHaveLength(1);
        await act(async () => { vi.advanceTimersByTime(10); });
        expect(writtenRequests()[1]).toEqual({ path: 'src/a.ts', content: 'hello again!', expectedHash: 'h2' });
        expect(hook.getCurrent().isEditingFile).toBe(true);
    });

    it('saves text entered while the successful write is refreshing the file', async () => {
        const refresh = createDeferred<void>();
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h2' });
        const hook = await createHarness({ refreshAll: () => refresh.promise });
        await act(async () => hook.getCurrent().onEditorChange('hello changed'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(hook.getCurrent().isSavingEdits).toBe(true);
        expect(hook.getCurrent().editorOriginalHash).toBe('h2');
        await act(async () => hook.getCurrent().onEditorChange('hello changed during refresh'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(writtenRequests()).toHaveLength(1);

        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h3' });
        await act(async () => refresh.resolve());
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(writtenRequests()[1]).toEqual({ path: 'src/a.ts', content: 'hello changed during refresh', expectedHash: 'h2' });
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().editorDirty).toBe(false);
    });

    it('restores newer unsaved text against the successful write baseline after remounting', async () => {
        const firstWrite = createDeferred<WriteResponse>();
        writeRpcSpy.mockReturnValueOnce(firstWrite.promise);
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('hello changed'));
        await act(async () => { vi.advanceTimersByTime(100); });
        await act(async () => hook.getCurrent().onEditorChange('hello changed more'));
        await act(async () => firstWrite.resolve({ success: true, hash: 'h2' }));
        expect(hook.persistDraft).toHaveBeenLastCalledWith({
            accountId: 'alice',
            isEditingFile: true,
            editorOriginalText: 'hello changed',
            editorOriginalHash: 'h2',
            editorText: 'hello changed more',
        });
        await hook.unmount();

        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h3' });
        const restored = await createHarness({ fileText: 'hello changed', fileHash: 'h2', startEditing: false });
        expect(restored.getCurrent().isEditingFile).toBe(true);
        expect(restored.getCurrent().getEditorText()).toBe('hello changed more');
        expect(restored.getCurrent().fileChangedExternally).toBe(false);
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(writtenRequests()[1]).toEqual({ path: 'src/a.ts', content: 'hello changed more', expectedHash: 'h2' });
    });

    it('retains failed edits without repeated writes and retries after the next edit', async () => {
        writeRpcSpy.mockResolvedValueOnce({ success: false, error: 'Disk unavailable', errorCode: 'FILE_WRITE_FAILED' });
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('hello changed'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().editorDirty).toBe(true);
        expect(hook.getCurrent().getEditorText()).toBe('hello changed');
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(writtenRequests()).toHaveLength(1);

        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h2' });
        await act(async () => hook.getCurrent().onEditorChange('hello recovered'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(writtenRequests()[1]).toEqual({ path: 'src/a.ts', content: 'hello recovered', expectedHash: 'h1' });
        expect(hook.getCurrent().editorDirty).toBe(false);
    });
});
