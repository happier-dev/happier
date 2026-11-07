import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { FilesystemWriteFileInputSchema, FilesystemWriteFileOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import {
    installWorkspaceFileDetailsCommonModuleMocks,
    installWorkspaceFileDetailsActionBoundary,
    prepareWorkspaceFileDetailsActionBoundary,
    cleanupWorkspaceFileDetailsActionBoundary,
    getWorkspaceFileDetailsActionBoundary,
} from './workspaceFileDetailsTestHelpers';
import type { WorkspaceFileEditorDraft } from './workspaceFileEditorDraft';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { Modal } from '@/modal';
import { buildApprovalRequestArtifactHeaderV1, type ApprovalRequestV2 } from '@happier-dev/protocol';
import type { ActionApprovalContinuation, ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

const editorPlatform = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' }));
installWorkspaceFileDetailsCommonModuleMocks({ reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: {
        get OS() { return editorPlatform.os; },
        select: <T,>(choices: { web?: T; ios?: T; native?: T; default?: T }) => editorPlatform.os === 'ios'
            ? choices.ios ?? choices.native ?? choices.default : choices.web ?? choices.default,
    } });
} });
installWorkspaceFileDetailsActionBoundary();

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Project Metro's actual native adapter; all editor and eligibility logic stays real.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => import('@/components/ui/code/editor/CodeEditor.native'));
const editorWebView = vi.hoisted(() => ({ onMessage: null as null | ((event: { nativeEvent: { data: string } }) => void) }));
vi.mock('react-native-webview', async () => {
    const React = await import('react');
    return { WebView: React.forwardRef((props: { onMessage: typeof editorWebView.onMessage }, ref) => {
        editorWebView.onMessage = props.onMessage;
        React.useImperativeHandle(ref, () => ({ postMessage() {}, requestFocus() {} }));
        return React.createElement('WebView');
    }) };
});

type WriteRpc = (request: Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc').callGuardedMachineRpcWithPolicy>[0]) => Promise<ReturnType<typeof FilesystemWriteFileOutputSchema.parse>>;
type WriteResponse = Awaited<ReturnType<WriteRpc>>;
const writeRpcSpy = vi.hoisted(() => vi.fn<WriteRpc>());

// Keep encoding, Action admission and editor state real beneath the Machine RPC boundary.
const actionBoundary = getWorkspaceFileDetailsActionBoundary();
const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');
const { workspaceWriteFile } = await import('@/sync/domains/workspaces/files/workspaceFileReadWrite');
const { storage, useActiveServerAccountScope } = await import('@/sync/domains/state/storage');

const scope = { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' };

async function createHarness(options: Readonly<{
    refreshAll?: () => Promise<void>;
    fileText?: string;
    fileHash?: string;
    encoding?: Parameters<typeof useWorkspaceFileEditorState>[0]['encoding'];
    startEditing?: boolean;
    accountId?: string | null;
    persistedDraft?: WorkspaceFileEditorDraft | null;
    deriveAccountFromSelectedHome?: boolean;
    autoSave?: boolean;
    unreachable?: boolean;
    persistDraft?: (draft: import('./workspaceFileEditorDraft').WorkspaceFileEditorDraft | null) => void;
    requestApproval?: (registration: ActionApprovalRegistration) => void;
}> = {}) {
    const refreshAll = options.refreshAll ?? vi.fn(async () => undefined);
    // This is the device-persistence boundary. Its Account slots replace the removed module cache.
    const persisted = new Map<string, WorkspaceFileEditorDraft | null>();
    if (options.persistedDraft) persisted.set(options.persistedDraft.accountId, options.persistedDraft);
    let activeAccount: string | null = options.accountId === undefined ? 'alice' : options.accountId;
    const persistDraft = vi.fn((draft: WorkspaceFileEditorDraft | null) => {
        options.persistDraft?.(draft);
        if (activeAccount) persisted.set(activeAccount, draft);
    });
    const disk = { text: options.fileText ?? 'hello', hash: options.fileHash ?? 'h1', unreachable: options.unreachable ?? false, encoding: options.encoding,
        displayMode: 'file' as 'file' | 'diff' | 'markdown' };
    const accountIdRef = { current: options.accountId === undefined ? 'alice' : options.accountId };
    const hook = await renderHook(() => {
        const selectedAccount = useActiveServerAccountScope(scope.serverId);
        activeAccount = options.deriveAccountFromSelectedHome ? selectedAccount?.accountId ?? null : accountIdRef.current;
        return useWorkspaceFileEditorState({
        scope,
        accountId: activeAccount,
        filePath: 'src/a.ts',
        displayMode: disk.displayMode,
        fileText: disk.text,
        fileHash: disk.hash,
        encoding: disk.encoding,
        unreachable: disk.unreachable,
        fileWriteSupported: true,
        setFileWriteSupported: vi.fn(),
        fileEditorFeatureEnabled: true,
        filesEditorWebMonacoEnabled: true,
        filesEditorNativeCodeMirrorEnabled: true,
        filesEditorAutoSave: options.autoSave ?? true,
        filesEditorChangeDebounceMs: 100,
        mountedRef: { current: true },
        refreshAll,
        persistedDraft: activeAccount ? persisted.get(activeAccount) ?? null : null,
        persistDraft,
        requestApproval: options.requestApproval,
        });
    });
    if (options.startEditing !== false) await act(async () => hook.getCurrent().startEditingFile());
    return { ...hook, persistDraft, accountIdRef, disk };
}

function writtenRequests() {
    return writeRpcSpy.mock.calls.map(([params]) => {
        const { rootPath: _rootPath, ...request } = FilesystemWriteFileInputSchema.parse(params.payload);
        return {
            ...request,
            path: request.path.slice(`${scope.rootPath}/`.length),
            content: Buffer.from(request.content, 'base64').toString('utf8'),
        };
    });
}

function executedWriteApproval(artifactId: string, input: unknown, hash: string) {
    const request: ApprovalRequestV2 = {
        v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2, createdBy: { surface: 'system' }, requestedSurface: 'ui',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
            serverId: scope.serverId, accountId: 'account-a', actionId: 'daemon.filesystem.writeFile', requestId: 'file-save' },
        actionId: 'daemon.filesystem.writeFile', actionArgs: FilesystemWriteFileInputSchema.parse(input),
        summary: 'Write the file', decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 2, ok: true, result: { success: true, hash } },
    };
    return { id: artifactId, title: null, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true as const };
}

describe('useWorkspaceFileEditorState autosave', () => {
    it('retains a dirty draft across View and Changes and seeds the editor from it on return', async () => {
        const hook = await createHarness({ autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('my unsaved draft'));
        for (const mode of ['file', 'diff', 'file'] as const) {
            hook.disk.displayMode = mode;
            await hook.rerender();
            expect(hook.getCurrent().isEditingFile).toBe(true);
            expect(hook.getCurrent().getEditorText()).toBe('my unsaved draft');
            expect(hook.getCurrent().editorDirty).toBe(true);
        }
        await act(async () => hook.getCurrent().startEditingFile());
        expect(hook.getCurrent().editorSeedText).toBe('my unsaved draft');
        expect(writeRpcSpy).not.toHaveBeenCalled();
    });

    beforeEach(async () => {
        scope.serverId = await prepareWorkspaceFileDetailsActionBoundary();
        writeRpcSpy.mockReset();
        actionBoundary.read.mockReset().mockImplementation(writeRpcSpy);
        vi.mocked(Modal.show).mockClear();
        vi.mocked(Modal.alert).mockClear();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        vi.useFakeTimers();
    });

    it('keeps Save pending through approval and adopts only the exact approved write result', async () => {
        const registered = createDeferred<ActionApprovalContinuation>();
        const hook = await createHarness({ accountId: 'account-a', autoSave: false, requestApproval: registration => {
            if (typeof registration === 'string') throw new Error('Save requires result custody');
            registered.resolve(registration);
        } });
        await act(async () => hook.getCurrent().onEditorChange('approved text'));
        // The transport boundary returns the canonical deferred Action receipt.
        actionBoundary.read.mockResolvedValueOnce({ kind: 'approval_request_created', artifactId: 'approval-file', actionId: 'daemon.filesystem.writeFile' });
        let pending!: Promise<boolean>;
        await act(async () => { pending = hook.getCurrent().saveFileEdits(); await registered.promise; });
        expect(hook.getCurrent().refusal?.kind).toBe('awaitingApproval');
        expect(hook.getCurrent().isSavingEdits).toBe(true);
        expect(hook.getCurrent().editorOriginalHash).toBe('h1');
        await act(async () => { expect(await hook.getCurrent().saveFileEdits()).toBe(false); });
        const transport = actionBoundary.calls.at(-1) as Parameters<WriteRpc>[0];
        await act(async () => {
            expect(await (await registered.promise).onExecuted(executedWriteApproval('approval-file', transport.payload, 'approved-hash'))).toBe('consumed');
            expect(await pending).toBe(true);
        });
        expect(hook.getCurrent().isSavingEdits).toBe(false);
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().editorOriginalHash).toBe('approved-hash');
        expect(hook.getCurrent().editorDirty).toBe(false);
        expect(hook.getCurrent().refusal).toBeNull();
        expect(actionBoundary.calls).toHaveLength(1);
    });

    it.each(['current', 'last-known'] as const)('returns clean after an approved Save executed while the editor was away (%s disk first)', async firstRead => {
        const drafts: Array<WorkspaceFileEditorDraft | null> = [];
        const registered = createDeferred<ActionApprovalContinuation>();
        const away = await createHarness({ accountId: 'account-a', autoSave: false, persistDraft: draft => { drafts.push(draft); },
            requestApproval: registration => { if (typeof registration !== 'string') registered.resolve(registration); } });
        await act(async () => away.getCurrent().onEditorChange('approved text'));
        actionBoundary.read.mockResolvedValueOnce({ kind: 'approval_request_created', artifactId: 'approval-away', actionId: 'daemon.filesystem.writeFile' });
        await act(async () => { void away.getCurrent().saveFileEdits(); await registered.promise; });
        // The person leaves the Session; the approval then executes elsewhere and the disk has the save.
        await away.unmount();
        const persistedDraft = drafts.at(-1) ?? null;
        expect(persistedDraft).toMatchObject({ editorText: 'approved text' });
        const back = await createHarness({ accountId: 'account-a', autoSave: false, persistedDraft, startEditing: false,
            ...(firstRead === 'current' ? { fileText: 'approved text', fileHash: 'approved-hash' } : {}) });
        if (firstRead === 'last-known') {
            back.disk.text = 'approved text'; back.disk.hash = 'approved-hash';
            await back.rerender();
        }
        expect(back.getCurrent().conflict).toBeNull();
        expect(back.getCurrent().editorDirty).toBe(false);
        expect(back.getCurrent().readSnapshot().dirty).toBe(false);
        expect(back.getCurrent().editorOriginalHash).toBe('approved-hash');
        expect(back.persistDraft).toHaveBeenLastCalledWith(null, expect.anything());
    });

    it('retains result custody when Undo of Use mine requires approval', async () => {
        const registrations: ActionApprovalContinuation[] = [];
        const hook = await createHarness({ accountId: 'account-a', autoSave: false, requestApproval: registration => {
            if (typeof registration === 'string') throw new Error('Undo requires result custody');
            registrations.push(registration);
        } });
        await act(async () => hook.getCurrent().onEditorChange('mine'));
        hook.disk.text = 'theirs'; hook.disk.hash = 'theirs-hash';
        await hook.rerender();
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'mine-hash' });
        await act(async () => hook.getCurrent().resolveConflict('useMine'));
        actionBoundary.read.mockResolvedValueOnce({ kind: 'approval_request_created', artifactId: 'approval-undo', actionId: 'daemon.filesystem.writeFile' });
        let pending!: Promise<void>;
        await act(async () => { pending = hook.getCurrent().undoSetAside(); });
        await vi.waitFor(() => expect(registrations).toHaveLength(1));
        expect(hook.getCurrent().refusal?.kind).toBe('awaitingApproval');
        const transport = actionBoundary.calls.at(-1) as Parameters<WriteRpc>[0];
        expect(FilesystemWriteFileInputSchema.parse(transport.payload)).toMatchObject({ expectedHash: 'mine-hash' });
        await act(async () => {
            expect(await registrations[0]!.onExecuted(executedWriteApproval('approval-undo', transport.payload, 'undo-hash'))).toBe('consumed');
            await pending;
        });
        expect(hook.getCurrent().getEditorText()).toBe('theirs');
        expect(hook.getCurrent().editorOriginalHash).toBe('undo-hash');
        expect(hook.getCurrent().refusal).toBeNull();
        expect(actionBoundary.calls).toHaveLength(2);
    });

    it('uses the shown disk encoding when explicitly replacing its conflicting bytes', async () => {
        const hook = await createHarness({ fileText: 'base\n', fileHash: 'base', autoSave: false,
            encoding: { hasBom: false, editable: true, eol: 'lf', mixedEol: false } });
        await act(async () => hook.getCurrent().onEditorChange('mine\n'));
        hook.disk.text = 'disk\r\n'; hook.disk.hash = 'shown';
        hook.disk.encoding = { hasBom: true, editable: true, eol: 'crlf', mixedEol: false };
        await hook.rerender();
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'saved-mine' });
        await act(async () => hook.getCurrent().resolveConflict('useMine'));
        expect(writtenRequests()).toEqual([{ path: 'src/a.ts', content: '\uFEFFmine\r\n', expectedHash: 'shown' }]);
    });

    it('flushes the engine before Done so a pending edit cannot close a clean-looking editor', async () => {
        const hook = await createHarness({ autoSave: false });
        hook.getCurrent().editorHandleRef.current = { getValue: () => 'pending engine edit', flushPendingChange: async () => {} };
        await act(async () => { await hook.getCurrent().doneEditingFile(); });
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().getEditorText()).toBe('pending engine edit');
        expect(hook.getCurrent().editorDirty).toBe(true);
        hook.getCurrent().editorHandleRef.current = { getValue: () => 'hello', flushPendingChange: async () => {} };
        await act(async () => { await hook.getCurrent().doneEditingFile(); });
        expect(hook.getCurrent().isEditingFile).toBe(false);
    });

    it('ends Saving when the write lands, so Saved shows while the slow re-read still runs', async () => {
        const reread = createDeferred<void>();
        const hook = await createHarness({ autoSave: false, refreshAll: () => reread.promise });
        await act(async () => hook.getCurrent().onEditorChange('edited'));
        hook.getCurrent().editorHandleRef.current = { getValue: () => 'edited', flushPendingChange: async () => {} };
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h2' });
        let saved: Promise<boolean> | undefined;
        await act(async () => { saved = hook.getCurrent().saveFileEdits(); await Promise.resolve(); });
        await act(async () => { for (let i = 0; i < 20 && hook.getCurrent().savedAtMs === null; i += 1) await Promise.resolve(); });
        expect(hook.getCurrent()).toMatchObject({ editorStatus: 'clean', editorDirty: false });
        expect(hook.getCurrent().savedAtMs).not.toBeNull();
        // A Save pressed during the re-read waits for it rather than being dropped.
        await act(async () => hook.getCurrent().onEditorChange('edited again'));
        hook.getCurrent().editorHandleRef.current = { getValue: () => 'edited again', flushPendingChange: async () => {} };
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h3' });
        let second: Promise<boolean> | undefined;
        await act(async () => { second = hook.getCurrent().saveFileEdits(); await Promise.resolve(); });
        expect(writtenRequests()).toHaveLength(1);
        await act(async () => { reread.resolve(); expect(await saved).toBe(true); expect(await second).toBe(true); });
        expect(writtenRequests().map(request => request.content)).toEqual(['edited', 'edited again']);
    });

    it('normalizes saved bytes without replacing the admitted editor text or undo seed', async () => {
        const hook = await createHarness({ autoSave: false, fileText: 'base\r\n',
            encoding: { hasBom: true, editable: true, eol: 'crlf', mixedEol: true } });
        const sent = 'first\nsecond\r\n';
        await act(async () => hook.getCurrent().onEditorChange(sent));
        const resetKey = hook.getCurrent().editorResetKey;
        hook.getCurrent().editorHandleRef.current = { getValue: () => sent, flushPendingChange: async () => {} };
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'normalized' });
        await act(async () => { expect(await hook.getCurrent().saveFileEdits()).toBe(true); });
        expect(writtenRequests()).toEqual([{ path: 'src/a.ts', content: '\uFEFFfirst\r\nsecond\r\n', expectedHash: 'h1' }]);
        expect(hook.getCurrent().editorOriginalText).toBe(sent);
        expect(hook.getCurrent().getEditorText()).toBe(sent);
        expect(hook.getCurrent().editorDirty).toBe(false);
        hook.disk.text = 'first\r\nsecond\r\n'; hook.disk.hash = 'normalized';
        await hook.rerender();
        expect(hook.getCurrent().getEditorText()).toBe(sent);
        expect(hook.getCurrent().editorResetKey).toBe(resetKey);
        expect(hook.getCurrent().readSnapshot().dirty).toBe(false);
    });

    it('clears a persisted dirty draft when the refreshed disk adopts that exact text', async () => {
        const hook = await createHarness({ autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('matching external write'));
        expect(hook.persistDraft).toHaveBeenLastCalledWith(expect.objectContaining({ editorText: 'matching external write' }));
        hook.disk.text = 'matching external write'; hook.disk.hash = 'external';
        await hook.rerender();
        expect(hook.getCurrent().editorDirty).toBe(false);
        expect(hook.persistDraft).toHaveBeenLastCalledWith(null);
    });

    it('saves per-place Compare choices through the guarded write against the disk version shown', async () => {
        const base = 'one\nbase A\nmiddle\nbase B\nend\n';
        const mine = 'one\nmine A\nmiddle\nmine B\nend\n';
        const disk = 'one\ndisk A\nmiddle\ndisk B\nend\n';
        const hook = await createHarness({ fileText: base, fileHash: 'base', autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange(mine));
        hook.disk.text = disk; hook.disk.hash = 'shown-disk';
        await hook.rerender();
        await act(async () => hook.getCurrent().startComparison());
        expect(hook.getCurrent().comparison?.places).toHaveLength(2);
        await act(async () => hook.getCurrent().usePlaceTheirs(0));
        await act(async () => hook.getCurrent().usePlaceMine(1));
        expect(hook.getCurrent().isComparing).toBe(false);
        expect(hook.getCurrent().editorOriginalHash).toBe('shown-disk');
        expect(hook.getCurrent().editorDirty).toBe(true);
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'saved-merge' });
        await act(async () => { expect(await hook.getCurrent().saveFileEdits()).toBe(true); });
        expect(writtenRequests()).toEqual([{ path: 'src/a.ts', content: 'one\ndisk A\nmiddle\nmine B\nend\n', expectedHash: 'shown-disk' }]);
    });

    it('keeps a newer disk write in conflict after deciding the comparison snapshot', async () => {
        const hook = await createHarness({ fileText: 'base\n', fileHash: 'base', autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('mine\n'));
        hook.disk.text = 'shown disk\n'; hook.disk.hash = 'shown';
        await hook.rerender();
        await act(async () => hook.getCurrent().startComparison());
        hook.disk.text = 'newer disk\n'; hook.disk.hash = 'newer';
        await hook.rerender();
        await act(async () => hook.getCurrent().useAllMine());
        expect(hook.getCurrent().editorOriginalHash).toBe('shown');
        expect(hook.getCurrent().conflict?.theirsHash).toBe('newer');
        await act(async () => { expect(await hook.getCurrent().saveFileEdits()).toBe(false); });
        expect(writtenRequests()).toEqual([]);
    });

    it('dismisses the comparison when a newer draft edit replaces its input', async () => {
        const hook = await createHarness({ fileText: 'base\n', fileHash: 'base', autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('mine\n'));
        hook.disk.text = 'disk\n'; hook.disk.hash = 'disk';
        await hook.rerender();
        await act(async () => hook.getCurrent().startComparison());
        expect(hook.getCurrent().isComparing).toBe(true);
        await act(async () => hook.getCurrent().onEditorChange('newer draft\n'));
        expect(hook.getCurrent().isComparing).toBe(false);
        await act(async () => hook.getCurrent().useAllTheirs());
        expect(hook.getCurrent().getEditorText()).toBe('newer draft\n');
        expect(hook.getCurrent().editorOriginalHash).toBe('base');
    });

    it('saves Compare choices with the shown BOM and EOL after a newer encoded disk version reverts', async () => {
        const shownEncoding = { hasBom: true, editable: true, eol: 'crlf' as const, mixedEol: false };
        const hook = await createHarness({ fileText: 'base\r\n', fileHash: 'base', encoding: shownEncoding, autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('mine\r\n'));
        hook.disk.text = 'shown disk\r\n'; hook.disk.hash = 'shown';
        await hook.rerender();
        await act(async () => hook.getCurrent().startComparison());
        hook.disk.text = 'newer disk\n'; hook.disk.hash = 'newer';
        hook.disk.encoding = { hasBom: false, editable: true, eol: 'lf', mixedEol: false };
        await hook.rerender();
        await act(async () => hook.getCurrent().useAllMine());
        expect(hook.getCurrent().readSnapshot().encoding).toEqual(shownEncoding);
        hook.disk.text = 'shown disk\r\n'; hook.disk.hash = 'shown'; hook.disk.encoding = shownEncoding;
        await hook.rerender();
        expect(hook.getCurrent().conflict).toBeNull();
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'saved' });
        await act(async () => { expect(await hook.getCurrent().saveFileEdits()).toBe(true); });
        expect(writtenRequests()).toEqual([{ path: 'src/a.ts', content: '\uFEFFmine\r\n', expectedHash: 'shown' }]);
    });

    afterEach(async () => {
        await act(async () => {
            storage.getState().clearProfileScope();
            publishAppliedActiveServerRuntimeAvailability(false);
        });
        vi.useRealTimers();
        await standardCleanup();
        await cleanupWorkspaceFileDetailsActionBoundary();
    });

    it('keeps an explicit save in the editor and adopts its new hash before a stale read can conflict', async () => {
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h2' });
        const hook = await createHarness({ autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('saved text'));
        let saved = false;
        await act(async () => { saved = await hook.getCurrent().saveFileEdits(); });
        expect(saved).toBe(true);
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: true, editorDirty: false, editorStatus: 'clean', conflict: null, editorOriginalHash: 'h2' });
        await act(async () => hook.getCurrent().onEditorChange('newer draft'));
        await hook.rerender();
        expect(hook.getCurrent().conflict).toBeNull();
        expect(hook.getCurrent().getEditorText()).toBe('newer draft');
    });

    it('derives conflict, clears when disk reverts, and adopts a disk echo of the draft', async () => {
        const hook = await createHarness({ autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('mine'));
        hook.disk.text = 'theirs'; hook.disk.hash = 'other';
        await hook.rerender();
        expect(hook.getCurrent().conflict).toEqual({ theirsText: 'theirs', theirsHash: 'other' });
        hook.disk.text = 'hello'; hook.disk.hash = 'h1';
        await hook.rerender();
        expect(hook.getCurrent().conflict).toBeNull();
        hook.disk.text = 'mine'; hook.disk.hash = 'echo';
        await hook.rerender();
        expect(hook.getCurrent()).toMatchObject({ editorDirty: false, conflict: null, editorOriginalHash: 'echo' });
        expect(writtenRequests()).toHaveLength(0);
    });

    it('starts and persists offline editing, never autosaves on reconnect, and saves against the start hash', async () => {
        const hook = await createHarness({ unreachable: true });
        await act(async () => hook.getCurrent().onEditorChange('offline draft'));
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: true, editorDirty: true, refusal: { kind: 'unreachable' } });
        expect(hook.persistDraft).toHaveBeenLastCalledWith(expect.objectContaining({ editorText: 'offline draft', editorOriginalHash: 'h1' }));
        expect(writtenRequests()).toHaveLength(0);
        hook.disk.unreachable = false;
        await hook.rerender();
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(writtenRequests()).toHaveLength(0);
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'back' });
        await act(async () => { await hook.getCurrent().saveFileEdits(); });
        expect(writtenRequests()[0]).toMatchObject({ content: 'offline draft', expectedHash: 'h1' });
        expect(hook.getCurrent().refusal).toBeNull();
    });

    it('keeps editing in memory when device draft persistence throws', async () => {
        const hook = await createHarness({ autoSave: false, persistDraft: () => { throw new Error('quota'); } });
        await act(async () => hook.getCurrent().onEditorChange('kept in memory'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(hook.getCurrent().getEditorText()).toBe('kept in memory');
        expect(hook.getCurrent()).toMatchObject({ editorDirty: true, draftPersistenceFailed: true });
    });

    it('uses the shown disk hash for Use mine and restores that disk version with a guarded Undo', async () => {
        const hook = await createHarness({ autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('mine'));
        hook.disk.text = 'theirs'; hook.disk.hash = 'theirs-hash';
        await hook.rerender();
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'mine-hash' });
        await act(async () => { await hook.getCurrent().resolveConflict('useMine'); });
        expect(writtenRequests()[0]).toMatchObject({ content: 'mine', expectedHash: 'theirs-hash' });
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'restored-hash' });
        await act(async () => { await hook.getCurrent().undoSetAside(); });
        expect(writtenRequests()[1]).toMatchObject({ content: 'theirs', expectedHash: 'mine-hash' });
    });

    it('Use theirs keeps the displaced draft recoverable and Undo restores its conflict', async () => {
        const hook = await createHarness({ autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('mine'));
        hook.disk.text = 'theirs'; hook.disk.hash = 'theirs-hash';
        await hook.rerender();
        await act(async () => { await hook.getCurrent().resolveConflict('useTheirs'); });
        expect(hook.getCurrent().getEditorText()).toBe('theirs');
        expect(hook.getCurrent().editorDirty).toBe(false);
        await act(async () => { await hook.getCurrent().undoSetAside(); });
        expect(hook.getCurrent().getEditorText()).toBe('mine');
        expect(hook.getCurrent().conflict?.theirsHash).toBe('theirs-hash');
        expect(writtenRequests()).toHaveLength(0);
    });

    it('publishes liveValue for every editor kind without rendering the page on every edit', async () => {
        const hook = await createHarness({ autoSave: false });
        const seen: string[] = [];
        const store = hook.getCurrent().liveValue;
        const unsubscribe = store.subscribe(() => seen.push(store.get()));
        await act(async () => hook.getCurrent().onEditorChange('one'));
        await act(async () => hook.getCurrent().onEditorChange('two'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(store.get()).toBe('two');
        expect(seen.at(-1)).toBe('two');
        expect(hook.getCurrent().liveValue).toBe(store);
        unsubscribe();
    });

    it('retires only the write observer on navigation while the admitted write retains its Account custody', async () => {
        const issued = createDeferred<void>();
        const remoteResult = createDeferred<WriteResponse>();
        writeRpcSpy.mockImplementationOnce(async () => { issued.resolve(); return await remoteResult.promise; })
            .mockResolvedValueOnce({ success: true, hash: 'h2' });
        const observer = new AbortController();
        let observationEnded = false;
        const pending = workspaceWriteFile({ scope, path: 'src/a.ts', content: 'saved draft', expectedHash: 'h1', signal: observer.signal });
        const outcome = pending.then(value => value, error => { observationEnded = true; return error as unknown; });
        await issued.promise;
        observer.abort();
        await vi.waitFor(() => expect(observationEnded).toBe(true));
        await expect(outcome).resolves.toMatchObject({ name: 'AbortError', code: 'TRANSFER_OBSERVATION_ABORTED' });
        expect(writeRpcSpy).toHaveBeenCalledTimes(1);
        expect(writeRpcSpy.mock.calls[0]?.[0].signal?.aborted).not.toBe(true);
        remoteResult.resolve({ success: true, hash: 'h2' });
        await act(async () => { await Promise.resolve(); });
        expect(writeRpcSpy).toHaveBeenCalledTimes(1);
        await expect(workspaceWriteFile({ scope, path: 'src/a.ts', content: 'fresh draft', expectedHash: 'h2',
            signal: new AbortController().signal })).resolves.toEqual({ success: true, hash: 'h2' });
        expect(writeRpcSpy).toHaveBeenCalledTimes(2);
    });

    it('does not restore or persist a private draft without captured Account authority', async () => {
        const hook = await createHarness({ accountId: null, startEditing: false,
            persistedDraft: { accountId: 'alice', isEditingFile: true, editorOriginalHash: 'h1', editorText: 'private draft' } });
        expect(hook.getCurrent().isEditingFile).toBe(false);
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        await act(async () => hook.getCurrent().startEditingFile());
        await act(async () => hook.getCurrent().onEditorChange('new private draft'));
        await act(async () => { vi.advanceTimersByTime(100); });
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
            persistedDraft: { accountId: 'alice', isEditingFile: true, editorOriginalHash: 'h1', editorText: 'Alice pane draft' } });
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
        const oldLiveValue = hook.getCurrent().liveValue;
        await act(async () => oldEditorChange('Alice pending write'));
        hook.accountIdRef.current = 'bob';
        await hook.rerender();
        await act(async () => oldEditorChange('Alice delayed callback'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(writeRpcSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        expect(oldLiveValue.get()).toBe('');
        expect(hook.getCurrent().liveValue.get()).toBe('hello');
        expect(hook.persistDraft).not.toHaveBeenCalledWith(expect.objectContaining({ accountId: 'bob' }));
    });

    it('does not apply an old Account’s completed write to the new editor owner', async () => {
        const pending = createDeferred<WriteResponse>();
        const bobPending = createDeferred<WriteResponse>();
        writeRpcSpy.mockReturnValueOnce(pending.promise).mockReturnValueOnce(bobPending.promise);
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('Alice writing'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(writeRpcSpy, JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toHaveBeenCalled();
        hook.accountIdRef.current = 'bob';
        await hook.rerender();
        expect(hook.getCurrent().isSavingEdits).toBe(false);
        await act(async () => hook.getCurrent().startEditingFile());
        await act(async () => hook.getCurrent().onEditorChange('Bob writing'));
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(writtenRequests().map(request => request.content)).toEqual(['Alice writing', 'Bob writing']);
        await act(async () => pending.resolve({ success: true, hash: 'Alice saved basis' }));
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: true, editorDirty: true, isSavingEdits: true, editorOriginalHash: 'h1' });
        expect(hook.getCurrent().getEditorText()).toBe('Bob writing');
        await act(async () => bobPending.resolve({ success: true, hash: 'Bob saved basis' }));
        expect(hook.getCurrent()).toMatchObject({ editorDirty: false, isSavingEdits: false, editorOriginalHash: 'Bob saved basis' });
    });

    it('does not disclose the current Account’s draft through a previous Account’s comparison callback', async () => {
        const hook = await createHarness();
        const oldCompare = hook.getCurrent().startComparison;
        const oldGetText = hook.getCurrent().getEditorText;
        hook.accountIdRef.current = 'bob';
        await hook.rerender();
        await act(async () => hook.getCurrent().startEditingFile());
        await act(async () => hook.getCurrent().onEditorChange('Bob private draft'));
        expect(oldGetText()).toBe('');
        expect(hook.getCurrent().getEditorText()).toBe('Bob private draft');
        await act(async () => oldCompare());
        expect(Modal.show).not.toHaveBeenCalled();
        expect(hook.getCurrent().comparison).toBeNull();
        await act(async () => hook.getCurrent().startComparison());
        expect(hook.getCurrent().comparison).toMatchObject({ theirsText: 'hello', mineText: 'Bob private draft' });
    });

    it('keeps the new invocation busy when an earlier save finishes after an Account round trip', async () => {
        const first = createDeferred<WriteResponse>();
        const returned = createDeferred<WriteResponse>();
        writeRpcSpy.mockReturnValueOnce(first.promise).mockReturnValueOnce(returned.promise);
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('Alice first invocation'));
        await act(async () => { vi.advanceTimersByTime(100); });
        hook.accountIdRef.current = 'bob';
        await hook.rerender();
        hook.accountIdRef.current = 'alice';
        await hook.rerender();
        await act(async () => hook.getCurrent().onEditorChange('Alice returned invocation'));
        await act(async () => { vi.advanceTimersByTime(100); });
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

    it('keeps the live document and its cursor seed when typing diverges during explicit Save', async () => {
        const write = createDeferred<WriteResponse>();
        writeRpcSpy.mockReturnValueOnce(write.promise);
        const hook = await createHarness({ autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('sent snapshot'));
        let save!: Promise<boolean>;
        await act(async () => { save = hook.getCurrent().saveFileEdits(); });
        await act(async () => hook.getCurrent().onEditorChange('typed while saving'));
        await act(async () => { write.resolve({ success: true, hash: 'sent-hash' }); await save; });
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: true, editorDirty: true, editorOriginalHash: 'sent-hash' });
        expect(hook.getCurrent().getEditorText()).toBe('typed while saving');
        expect(hook.getCurrent().editorSeedText).not.toBe('sent snapshot');
        expect(writtenRequests()).toHaveLength(1);
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
        // The write landed: Saved shows while the re-read runs, which still holds the one-write-at-a-time lock.
        expect(hook.getCurrent().editorStatus).toBe('clean');
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
            editorOriginalHash: 'h2',
            editorText: 'hello changed more',
        });
        await hook.unmount();

        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h3' });
        const restored = await createHarness({ fileText: 'hello changed', fileHash: 'h2', startEditing: false,
            persistedDraft: hook.persistDraft.mock.calls.at(-1)?.[0] ?? null });
        expect(restored.getCurrent().isEditingFile).toBe(true);
        expect(restored.getCurrent().getEditorText()).toBe('hello changed more');
        expect(restored.getCurrent().conflict).toBeNull();
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(writtenRequests()[1]).toEqual({ path: 'src/a.ts', content: 'hello changed more', expectedHash: 'h2' });
    });

    it('retains failed edits without repeated writes and retries only after explicit Save', async () => {
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
        expect(writtenRequests()).toHaveLength(1);
        await act(async () => { await hook.getCurrent().saveFileEdits(); });
        expect(writtenRequests()[1]).toEqual({ path: 'src/a.ts', content: 'hello recovered', expectedHash: 'h1' });
        expect(hook.getCurrent().editorDirty).toBe(false);
    });

    it('keeps dirty typing local to the Markdown leaf across the real document publication cadence', async () => {
        const { MarkdownCodeEditorField } = await import('@/components/ui/markdown/editor/MarkdownCodeEditorField');
        const { MarkdownEditModeMenu } = await import('@/components/ui/markdown/editorChrome/MarkdownEditModeMenu');
        const originalSettings = storage.getState().settings;
        editorPlatform.os = 'ios';
        storage.setState({ settings: { ...originalSettings, experiments: true,
            featureToggles: { ...originalSettings.featureToggles, 'files.editor': true, 'files.markdownRichEditor': true },
            markdownDefaultEditMode: 'raw',
        } });
        let headerRenders = 0;
        let leafCommits = 0;
        let editor!: ReturnType<typeof useWorkspaceFileEditorState>;
        const persistDraft = vi.fn<(draft: WorkspaceFileEditorDraft | null) => void>();
        const refreshAll = async () => {};
        // Deliberately not memoized: this models a sibling header reached by an
        // owner render, distinguishing it from React's no-op render attempts.
        function OwnerHeader() { headerRenders += 1; return null; }
        function EditorPageOwner() {
            editor = useWorkspaceFileEditorState({ scope, accountId: 'alice', filePath: 'README.md', displayMode: 'file',
                fileText: '# Original', fileHash: 'h1', fileWriteSupported: true, setFileWriteSupported() {},
                fileEditorFeatureEnabled: true, filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false, filesEditorChangeDebounceMs: 100, mountedRef: { current: true },
                refreshAll, persistDraft,
            });
            return <><OwnerHeader />{editor.isEditingFile ? <React.Profiler id="markdown-leaf" onRender={() => { leafCommits += 1; }}>
                <MarkdownCodeEditorField value={editor.editorSeedText} resetKey={String(editor.editorResetKey)} filePath="README.md"
                    editorRef={editor.editorHandleRef} liveValue={editor.liveValue} onChange={editor.onEditorChange} changeDebounceMs={100} />
            </React.Profiler> : null}</>;
        }
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const emit = (type: string, payload: object) => editorWebView.onMessage!({ nativeEvent: { data: JSON.stringify({ v: 1, type, payload }) } });
        try {
            screen = await renderScreen(<EditorPageOwner />);
            await act(async () => { editor.startEditingFile(); });
            await act(async () => { emit('ready', { ok: true }); emit('docChanged', { doc: '# First dirty edit' }); await vi.advanceTimersByTimeAsync(100); });
            expect(editor.editorDirty).toBe(true);
            expect(editor.liveValue.get()).toBe('# First dirty edit');
            expect(screen.findByType(MarkdownEditModeMenu).props.richEligible).toBe(true);
            const afterDirty = { headerRenders, leafCommits, persisted: persistDraft.mock.calls.length };
            // docChanged is already debounced inside the native WebView. The
            // state owner's established cadence admits its first two events
            // immediately, then debounces later publications and persistence.
            await act(async () => { emit('docChanged', { doc: '# Second dirty edit' }); });
            expect(editor.liveValue.get()).toBe('# Second dirty edit');
            expect(headerRenders).toBe(afterDirty.headerRenders);
            expect(leafCommits).toBeGreaterThan(afterDirty.leafCommits);
            expect(persistDraft.mock.calls).toHaveLength(afterDirty.persisted + 1);
            const afterImmediate = { headerRenders, leafCommits, persisted: persistDraft.mock.calls.length };
            const next = 'A note[^1]\n\n[^1]: newly unsupported\n';
            await act(async () => { emit('docChanged', { doc: next }); await vi.advanceTimersByTimeAsync(99); });
            // The native surface and subscribed Markdown leaf see current text
            // while persistence remains on the state owner's publication cadence.
            expect(editor.editorHandleRef.current?.getValue()).toBe(next);
            expect(editor.liveValue.get()).toBe(next);
            expect(headerRenders).toBe(afterImmediate.headerRenders);
            expect(persistDraft.mock.calls).toHaveLength(afterImmediate.persisted);
            await act(async () => { await vi.advanceTimersByTimeAsync(1); });
            expect(editor.liveValue.get()).toBe(next);
            expect(screen.findByType(MarkdownEditModeMenu).props.richDisabledReason).toBe('footnotes');
            expect(leafCommits).toBeGreaterThan(afterImmediate.leafCommits);
            expect(headerRenders).toBe(afterImmediate.headerRenders);
            expect(persistDraft).toHaveBeenLastCalledWith(expect.objectContaining({ editorText: next }));
            expect(writtenRequests()).toHaveLength(0);
        } finally {
            await screen?.unmount();
            editorPlatform.os = 'web';
            storage.setState({ settings: originalSettings });
        }
    });
});
