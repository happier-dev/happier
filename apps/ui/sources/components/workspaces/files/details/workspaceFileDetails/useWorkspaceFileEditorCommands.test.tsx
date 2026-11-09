import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesystemWriteFileInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { ScopeActionOutputSchemas } from '@happier-dev/protocol/actions/scopeActionFamily';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    answerWorkspaceFileDetailsAccountActions,
    cleanupWorkspaceFileDetailsActionBoundary,
    getWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsCommonModuleMocks,
    prepareWorkspaceFileDetailsActionBoundary,
} from './workspaceFileDetailsTestHelpers';
import type { WorkspaceFileEditorState } from './useWorkspaceFileEditorState';
import type { WorkspaceFileEditorHeaderModel } from './workspaceFileEditorHeaderModel';
import type { WorkspaceWriteFileResponse } from '@/sync/ops/workspaceFileSystem/fileReadWrite';

installWorkspaceFileDetailsCommonModuleMocks();
installWorkspaceFileDetailsActionBoundary();

const { storage, useActiveServerAccountScope } = await import('@/sync/domains/state/storage');
const { publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { invokeScopeAction, readWorkspaceFileEditorHolder } = await import('@/sync/ops/actions/scopeActionFamily');
const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');
const { useWorkspaceFileEditorCommands } = await import('./useWorkspaceFileEditorCommands');
const { Platform } = await import('react-native');
const { Modal } = await import('@/modal');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');

type FileId = 'a' | 'b';
const scope = { serverId: '', machineId: 'm1', rootPath: '/repo' };
const editors = new Map<FileId, WorkspaceFileEditorState>();
const headers = new Map<FileId, WorkspaceFileEditorHeaderModel>();
const refreshAll = async () => {};
const actionBoundary = getWorkspaceFileDetailsActionBoundary();
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let accountReplacement: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>;

function editorFor(id: FileId): WorkspaceFileEditorState {
    const editor = editors.get(id);
    if (!editor) throw new Error(`Editor ${id} is not mounted`);
    return editor;
}

function RetainedEditor({ id, focused }: Readonly<{ id: FileId; focused: boolean }>) {
    const account = useActiveServerAccountScope(scope.serverId);
    const mountedRef = React.useRef(true);
    React.useEffect(() => () => { mountedRef.current = false; }, []);
    const [fileWriteSupported, setFileWriteSupported] = React.useState(true);
    const editor = useWorkspaceFileEditorState({
        scope, accountId: account?.accountId ?? null, filePath: `src/${id}.ts`, displayMode: 'file',
        fileText: `base ${id}`, fileHash: `base-${id}`, fileWriteSupported, setFileWriteSupported,
        fileEditorFeatureEnabled: true, filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
        filesEditorAutoSave: false, filesEditorChangeDebounceMs: 100, mountedRef, refreshAll,
    });
    const header = useWorkspaceFileEditorCommands({ editor, tabKey: `file:src/${id}.ts`,
        file: { scope, path: `src/${id}.ts` },
        serverId: scope.serverId, accountId: account?.accountId ?? null, focused, onStart: editor.startEditingFile });
    editors.set(id, editor);
    headers.set(id, header);
    return null;
}

function RetainedEditors({ focused }: Readonly<{ focused: FileId }>) {
    return <KeyboardShortcutProvider handlers={{}}>
        <RetainedEditor id="a" focused={focused === 'a'} />
        <RetainedEditor id="b" focused={focused === 'b'} />
    </KeyboardShortcutProvider>;
}

function writtenRequests() {
    return actionBoundary.calls.map(request => {
        const candidate = request as Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc').callGuardedMachineRpcWithPolicy>[0];
        const parsed = FilesystemWriteFileInputSchema.parse(candidate.payload);
        return { path: parsed.path, content: Buffer.from(parsed.content, 'base64').toString('utf8'), expectedHash: parsed.expectedHash };
    });
}

describe('mounted file editor commands through the real editor, keyboard and Action owners', () => {
    beforeEach(async () => {
        // The DOM and credentials must share one browser-origin storage port.
        browser = await installBrowserRuntimeForTests({ url: 'https://editor.test' });
        browser.document.body.appendChild(browser.document.createElement('textarea'));
        scope.serverId = await prepareWorkspaceFileDetailsActionBoundary();
        accountReplacement = null;
        editors.clear(); headers.clear();
        actionBoundary.read.mockReset().mockImplementation(async () => { throw new Error('Unexpected Machine write'); });
        vi.mocked(Modal.confirm).mockResolvedValue(true);
    });

    afterEach(async () => {
        await standardCleanup();
        browser.activate();
        await accountReplacement?.rollback();
        await act(async () => {
            storage.getState().clearProfileScope();
            publishAppliedActiveServerRuntimeAvailability(false);
        });
        await cleanupWorkspaceFileDetailsActionBoundary();
        browser.restore();
    });

    it('refuses an Action save without writing or losing the draft when its engine snapshot is unconfirmed', async () => {
        const screen = await renderScreen(<RetainedEditors focused="a" />);
        try {
            await act(async () => { editorFor('a').startEditingFile(); editorFor('a').onEditorChange('pending draft'); });
            editorFor('a').editorHandleRef.current = { getValue: () => 'pending draft',
                flushPendingChange: async () => { throw new Error('editor_document_snapshot_unconfirmed'); } };
            await act(async () => {
                await expect(invokeScopeAction('file.editor.save', { tabId: 'file:src/a.ts' },
                    { serverId: scope.serverId, runtimeAccountId: 'account-a' })).resolves.toEqual({ status: 'unavailable' });
            });
            expect(writtenRequests()).toEqual([]);
            expect(editorFor('a').getEditorText()).toBe('pending draft');
            expect(editorFor('a').refusal?.kind).toBe('failed');
            expect(editorFor('a').isEditingFile).toBe(true);
        } finally { await screen.unmount(); }
    });

    it('saves only the focused retained editor by keyboard, saves an addressed background tab with its current hash, and retires Account custody', async () => {
        const screen = await renderScreen(<RetainedEditors focused="a" />);
        expect(storage.getState().profileScope).toEqual({ serverId: scope.serverId, accountId: 'account-a' });
        expect(readWorkspaceFileEditorHolder(scope, 'account-a', 'src/a.ts')?.file?.read()).toEqual({ savedText: 'base a', text: 'base a', unsaved: false });
        expect(readWorkspaceFileEditorHolder(scope, 'account-b', 'src/a.ts')).toBeNull();
        expect(readWorkspaceFileEditorHolder({ ...scope, rootPath: '/repo2' }, 'account-a', 'src/a.ts')).toBeNull();
        expect(readWorkspaceFileEditorHolder({ ...scope, machineId: 'another-machine' }, 'account-a', 'src/a.ts')).toBeNull();
        await act(async () => { editorFor('a').startEditingFile(); editorFor('b').startEditingFile(); });
        await act(async () => { editorFor('a').onEditorChange('Alice a'); editorFor('b').onEditorChange('Alice b'); });
        // Seed through the settings owner so Account hydration retains this preference.
        await act(async () => {
            storage.getState().applySettingsLocal({ keyboardShortcutsV2Enabled: true,
                keyboardSingleKeyShortcutsEnabled: false, keyboardShortcutOverridesV1: {}, keyboardShortcutDisabledCommandIdsV1: [] });
        });
        expect(Platform.OS).toBe('web');
        expect(editorFor('a').readSnapshot()).toMatchObject({ isEditingFile: true, dirty: true });
        expect(editorFor('b').readSnapshot()).toMatchObject({ isEditingFile: true, dirty: true });
        expect(readWorkspaceFileEditorHolder(scope, 'account-a', 'src/b.ts')?.file?.read()).toEqual({ savedText: 'base b', text: 'Alice b', unsaved: true });
        expect({ enabled: storage.getState().settings.keyboardShortcutsV2Enabled,
            disabled: storage.getState().settings.keyboardShortcutDisabledCommandIdsV1,
            overrides: storage.getState().settings.keyboardShortcutOverridesV1 }).toEqual({ enabled: true, disabled: [], overrides: {} });

        const keyboardSave = async (id: FileId, hash: string) => {
            const expectedWrites = actionBoundary.calls.length + 1;
            const response = createDeferred<WorkspaceWriteFileResponse>();
            actionBoundary.read.mockImplementationOnce(async () => response.promise);
            const event = new browser.window.KeyboardEvent('keydown', { key: 's', code: 'KeyS', altKey: true, bubbles: true, cancelable: true });
            await act(async () => {
                browser.window.document.querySelector('textarea')!.dispatchEvent(event);
                expect(event.defaultPrevented).toBe(true);
            });
            await waitForHomeGovernance(() => expect({ writes: actionBoundary.calls.length, refusal: editorFor(id).refusal },
                `Keyboard Save for ${id} reaches the Machine without a refusal`).toEqual({ writes: expectedWrites, refusal: null }));
            await act(async () => { response.resolve({ success: true, hash }); });
            await waitForHomeGovernance(async () => {
                // The HTTP result updates refs first, then effects restore keyboard availability.
                await flushHookEffects();
                expect(editorFor(id).readSnapshot()).toMatchObject({ hash, dirty: false });
            });
            await flushHookEffects();
            expect(editorFor(id).isSavingEdits).toBe(false);
            expect(headers.get(id)?.shortcutLabel).toMatch(/S$/);
        };
        await keyboardSave('a', 'saved-a');
        expect(headers.get('a')?.shortcutLabel).toMatch(/S$/);
        expect(writtenRequests()).toEqual([{ path: '/repo/src/a.ts', content: 'Alice a', expectedHash: 'base-a' }]);
        expect(editorFor('a').readSnapshot()).toMatchObject({ dirty: false, hash: 'saved-a' });
        expect(editorFor('b').readSnapshot()).toMatchObject({ dirty: true, hash: 'base-b' });

        await screen.update(<RetainedEditors focused="b" />);
        await act(async () => { editorFor('a').onEditorChange('Alice a again'); });
        await keyboardSave('b', 'saved-b');
        expect(writtenRequests()).toEqual([
            { path: '/repo/src/a.ts', content: 'Alice a', expectedHash: 'base-a' },
            { path: '/repo/src/b.ts', content: 'Alice b', expectedHash: 'base-b' },
        ]);

        actionBoundary.read.mockResolvedValueOnce({ success: true, hash: 'saved-background-a' });
        let saved: unknown;
        await act(async () => {
            saved = await invokeScopeAction('file.editor.save', { tabId: 'file:src/a.ts' },
                { serverId: scope.serverId, runtimeAccountId: 'account-a' });
            // This assertion runs before React commits the new header snapshot.
            expect(ScopeActionOutputSchemas['file.editor.save'].parse(saved)).toEqual({ status: 'saved', hash: 'saved-background-a' });
            expect(readWorkspaceFileEditorHolder(scope, 'account-a', 'src/a.ts')?.file?.read()).toEqual({ savedText: 'Alice a again', text: 'Alice a again', unsaved: false });
        });
        expect(writtenRequests()[2]).toEqual({ path: '/repo/src/a.ts', content: 'Alice a again', expectedHash: 'saved-a' });

        await act(async () => { editorFor('a').onEditorChange('Alice pending'); });
        const previousSaveControl = headers.get('a')!.onSave;
        const pendingResponse = createDeferred<WorkspaceWriteFileResponse>();
        actionBoundary.read.mockImplementationOnce(async () => pendingResponse.promise);
        let pendingAction: Promise<unknown> | undefined;
        await act(async () => {
            pendingAction = invokeScopeAction('file.editor.save', { tabId: 'file:src/a.ts' },
                { serverId: scope.serverId, runtimeAccountId: 'account-a' });
        });
        await waitForHomeGovernance(() => expect(actionBoundary.calls).toHaveLength(4));
        await act(async () => { storage.setState({ profileScope: { serverId: scope.serverId, accountId: 'account-b' } }); });
        await act(async () => {
            pendingResponse.resolve({ success: true, hash: 'late-alice-result' });
            expect(await pendingAction).toEqual({ status: 'unavailable' });
        });
        expect(editorFor('a').readSnapshot()).toMatchObject({ isEditingFile: false, dirty: false, hash: 'base-a' });
        expect(readWorkspaceFileEditorHolder(scope, 'account-a', 'src/a.ts')).toBeNull();
        expect(readWorkspaceFileEditorHolder(scope, 'account-b', 'src/a.ts')?.file?.read()).toEqual({ savedText: 'base a', text: 'base a', unsaved: false });
        await act(async () => { editorFor('a').startEditingFile(); });
        await act(async () => { editorFor('a').onEditorChange('Bob private draft'); });
        const writesBeforeStaleCalls = writtenRequests();
        await act(async () => {
            previousSaveControl();
            expect(await invokeScopeAction('file.editor.save', { tabId: 'file:src/a.ts' },
                { serverId: scope.serverId, runtimeAccountId: 'account-a' })).toEqual({ status: 'unavailable' });
        });
        expect(writtenRequests()).toEqual(writesBeforeStaleCalls);
        expect(editorFor('a').getEditorText()).toBe('Bob private draft');
        expect(editorFor('a').readSnapshot()).toMatchObject({ dirty: true, hash: 'base-a' });

        await act(async () => { storage.setState({ profileScope: { serverId: scope.serverId, accountId: 'account-a' } }); });
        await act(async () => { editorFor('a').startEditingFile(); });
        await act(async () => { editorFor('a').onEditorChange('Alice before the Account switch'); });
        // The header calls this canonical async Save; hold its completion across the pre-commit switch.
        const beforeCommitSaveControl = editorFor('a').saveFileEdits;
        const writesBeforeAccountPublication = writtenRequests();
        accountReplacement = await TokenStorage.setCredentialsForServerUrlWithRollback('https://workspace-file-details.test',
            { serverId: scope.serverId }, { token: createAccountTokenForTests('account-b', { currentAccount: true }) });
        expect(accountReplacement).not.toBeNull();
        actionBoundary.read.mockResolvedValueOnce({ success: true, hash: 'must-not-retarget' });
        await act(async () => {
            storage.setState({ profileScope: { serverId: scope.serverId, accountId: 'account-b' } });
            // The previous owner is invoked after Account publication, before React commits its replacement.
            expect(await beforeCommitSaveControl()).toBe(false);
        });
        expect(writtenRequests()).toEqual(writesBeforeAccountPublication);
        expect(editorFor('a').getEditorText()).toBe('base a');
        await answerWorkspaceFileDetailsAccountActions(scope.serverId, 'account-b', scope.machineId);
        await act(async () => { await restoreConnectionToActiveServer({ token: createAccountTokenForTests('account-b', { currentAccount: true }) }); });
        actionBoundary.read.mockReset().mockResolvedValueOnce({ success: true, hash: 'saved-bob' });
        await act(async () => { editorFor('a').startEditingFile(); });
        await act(async () => { editorFor('a').onEditorChange('Bob after credential replacement'); });
        let replacementSave: unknown;
        await act(async () => {
            replacementSave = await invokeScopeAction('file.editor.save', { tabId: 'file:src/a.ts' },
                { serverId: scope.serverId, runtimeAccountId: 'account-b' });
        });
        expect({ result: replacementSave, refusal: editorFor('a').refusal, account: storage.getState().profileScope }).toEqual({
            result: { status: 'saved', hash: 'saved-bob' }, refusal: null,
            account: { serverId: scope.serverId, accountId: 'account-b' },
        });
        expect(writtenRequests().slice(writesBeforeAccountPublication.length)).toEqual([
            { path: '/repo/src/a.ts', content: 'Bob after credential replacement', expectedHash: 'base-a' },
        ]);
    });
});
