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
import { buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { projectApprovalReviewInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionApprovalContinuation, ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { publishPresentationNotice, readPresentationNotice, retirePresentationNotice, subscribePresentationNotices } from '@/components/sessions/presentation/presentationNotices';

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
    formatOnSave?: boolean;
    unreachable?: boolean;
    persistDraft?: (draft: import('./workspaceFileEditorDraft').WorkspaceFileEditorDraft | null) => void;
    requestApproval?: (registration: ActionApprovalRegistration) => void;
}> = {}) {
    const refreshAll = options.refreshAll ?? vi.fn(async () => undefined);
    // This is the device-persistence boundary. Its Account slots replace the removed module cache.
    const persisted = new Map<string, WorkspaceFileEditorDraft | null>();
    if (options.persistedDraft) persisted.set(options.persistedDraft.accountId, options.persistedDraft);
    let activeAccount: string | null = options.accountId === undefined ? 'account-a' : options.accountId;
    const persistDraft = vi.fn((draft: WorkspaceFileEditorDraft | null) => {
        options.persistDraft?.(draft);
        if (draft) persisted.set(draft.accountId, draft);
        else if (activeAccount) persisted.set(activeAccount, draft);
    });
    const disk = { text: options.fileText ?? 'hello', hash: options.fileHash ?? 'h1', unreachable: options.unreachable ?? false, encoding: options.encoding,
        displayMode: 'file' as 'file' | 'diff' | 'markdown' };
    const accountIdRef = { current: options.accountId === undefined ? 'account-a' : options.accountId };
    const mountedRef = { current: true };
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
        filesEditorFormatOnSave: options.formatOnSave,
        filesEditorChangeDebounceMs: 100,
        mountedRef,
        refreshAll,
        persistedDraft: activeAccount ? persisted.get(activeAccount) ?? null : null,
        persistDraft,
        requestApproval: options.requestApproval,
        });
    });
    if (options.startEditing !== false) await act(async () => hook.getCurrent().startEditingFile());
    return { ...hook, persistDraft, accountIdRef, mountedRef, disk };
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
    const actionArgs = FilesystemWriteFileInputSchema.parse(input);
    const request: ApprovalRequestV2 = {
        v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2, createdBy: { surface: 'system' }, requestedSurface: 'ui',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
            serverId: scope.serverId, accountId: 'account-a', actionId: 'daemon.filesystem.writeFile', requestId: 'file-save' },
        actionId: 'daemon.filesystem.writeFile', actionArgs,
        // The Action producer records its declared private review projection beside the raw operand.
        preview: { actionId: 'daemon.filesystem.writeFile',
            actionArgs: projectApprovalReviewInput(getActionSpec('daemon.filesystem.writeFile'), actionArgs) },
        summary: 'Write the file', decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 2, ok: true, result: { success: true, hash } },
    };
    return { id: artifactId, title: null, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true as const };
}

describe('useWorkspaceFileEditorState autosave', () => {
    it('awaits opt-in formatting before the guarded save reads the buffer', async () => {
        const hook = await createHarness({ autoSave: false, formatOnSave: true });
        let value = 'const x={a:1};';
        await act(async () => hook.getCurrent().onEditorChange(value));
        const formatted = createDeferred<void>();
        const formatDocument = vi.fn(async () => { await formatted.promise; value = 'const x = { a: 1 };'; });
        hook.getCurrent().editorHandleRef.current = { getValue: () => value, flushPendingChange: async () => {}, formatDocument };
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'formatted' });
        let saving: Promise<boolean> | undefined;
        await act(async () => { saving = hook.getCurrent().saveFileEdits(); await Promise.resolve(); });
        expect(formatDocument).toHaveBeenCalledOnce();
        expect(writtenRequests()).toEqual([]);
        await act(async () => { formatted.resolve(); expect(await saving).toBe(true); });
        expect(writtenRequests()[0].content).toBe('const x = { a: 1 };');
    });
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
        expect(hook.persistDraft).toHaveBeenLastCalledWith(expect.objectContaining({ editorText: 'matching external write' }), { persist: false });
        hook.disk.text = 'matching external write'; hook.disk.hash = 'external';
        await hook.rerender();
        expect(hook.getCurrent().editorDirty).toBe(false);
        expect(hook.persistDraft).toHaveBeenLastCalledWith(null, { persist: true });
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
        retirePresentationNotice();
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

    it('admits a newer explicit Save while only the previous receipt’s display refresh is pending', async () => {
        const refreshed = createDeferred<void>();
        const refreshing = createDeferred<void>();
        const secondReceipt = createDeferred<WriteResponse>();
        const hook = await createHarness({ autoSave: false, refreshAll: async () => {
            refreshing.resolve(); await refreshed.promise;
        } });
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h2' }).mockReturnValueOnce(secondReceipt.promise);
        let first: Promise<boolean> | undefined;
        let second: Promise<boolean> | undefined;
        try {
            await act(async () => hook.getCurrent().onEditorChange('first saved bytes'));
            await act(async () => { first = hook.getCurrent().saveFileEdits(); await refreshing.promise; });
            expect(hook.getCurrent().isSavingEdits).toBe(false);
            await act(async () => hook.getCurrent().onEditorChange('newer saved bytes'));
            await act(async () => { second = hook.getCurrent().saveFileEdits(); });
            await vi.waitFor(() => expect(writtenRequests()).toHaveLength(2));
            expect(writtenRequests()[1]).toMatchObject({ content: 'newer saved bytes', expectedHash: 'h2' });
            // The pending write, unlike its display refresh, still owns the single-flight slot.
            await act(async () => { expect(await hook.getCurrent().saveFileEdits()).toBe(false); });
            expect(writtenRequests()).toHaveLength(2);
            await act(async () => { secondReceipt.resolve({ success: true, hash: 'h3' }); });
            expect(await first).toBe(true);
            expect(await second).toBe(true);
            expect(hook.getCurrent()).toMatchObject({ editorDirty: false, editorOriginalHash: 'h3' });
        } finally {
            refreshed.resolve(); secondReceipt.resolve({ success: true, hash: 'h3' });
            await act(async () => { await first; await second; });
        }
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
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: true, editorDirty: true, refusal: { kind: 'unreachable' } });
        await act(async () => { await hook.getCurrent().prepareEditorTransition(); });
        expect(hook.persistDraft).toHaveBeenLastCalledWith(expect.objectContaining({ editorText: 'offline draft', editorOriginalHash: 'h1' }), { persist: true });
        expect(writtenRequests()).toHaveLength(0);
        hook.disk.unreachable = false;
        await hook.rerender();
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(writtenRequests()).toHaveLength(0);
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'back' });
        await act(async () => { await hook.getCurrent().saveFileEdits(); });
        expect(writtenRequests()[0]).toMatchObject({ content: 'offline draft', expectedHash: 'h1' });
        expect(hook.getCurrent().refusal).toBeNull();
    });

    it('holds explicit offline Save until reachability returns, then writes the latest buffer once', async () => {
        const hook = await createHarness({ autoSave: false, unreachable: true });
        await act(async () => hook.getCurrent().onEditorChange('first offline edit'));
        writeRpcSpy.mockResolvedValue({ success: true, hash: 'reconnected' });
        let pending!: Promise<boolean>;
        await act(async () => { pending = hook.getCurrent().saveFileEdits(); });
        expect(writtenRequests()).toEqual([]);
        expect(hook.getCurrent()).toMatchObject({ isSavingEdits: true, editorDirty: true, refusal: { kind: 'unreachable' } });
        await act(async () => hook.getCurrent().onEditorChange('latest offline edit'));
        // Re-renders and elapsed time while offline cannot deliver a write.
        await hook.rerender();
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(writtenRequests()).toEqual([]);
        await act(async () => { expect(await hook.getCurrent().saveFileEdits()).toBe(false); });
        hook.disk.unreachable = false;
        await hook.rerender();
        await act(async () => { expect(await pending).toBe(true); });
        expect(writtenRequests()).toEqual([expect.objectContaining({ content: 'latest offline edit', expectedHash: 'h1' })]);
        expect(hook.getCurrent()).toMatchObject({ isSavingEdits: false, editorDirty: false, refusal: null, editorOriginalHash: 'reconnected' });
        expect(hook.getCurrent().savedAtMs).not.toBeNull();
        await hook.rerender();
        expect(writtenRequests()).toHaveLength(1);
    });

    it('settles a real write refusal after offline Save resumes without retrying or dropping edits', async () => {
        const hook = await createHarness({ autoSave: false, unreachable: true });
        await act(async () => hook.getCurrent().onEditorChange('kept draft'));
        writeRpcSpy.mockResolvedValue({ success: false, error: 'Permission denied', errorCode: 'EACCES' });
        let pending!: Promise<boolean>;
        await act(async () => { pending = hook.getCurrent().saveFileEdits(); });
        expect(writtenRequests()).toEqual([]);
        hook.disk.unreachable = false;
        await hook.rerender();
        await act(async () => { expect(await pending).toBe(false); });
        expect(hook.getCurrent()).toMatchObject({ isSavingEdits: false, editorDirty: true, refusal: { kind: 'failed' } });
        expect(hook.getCurrent().getEditorText()).toBe('kept draft');
        await hook.rerender();
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(writtenRequests()).toHaveLength(1);
    });

    it('cancels the offline Save when its Account owner changes before reachability returns', async () => {
        const hook = await createHarness({ autoSave: false, unreachable: true });
        await act(async () => hook.getCurrent().onEditorChange('Account A draft'));
        let pending!: Promise<boolean>;
        await act(async () => { pending = hook.getCurrent().saveFileEdits(); });
        expect(writtenRequests()).toEqual([]);
        hook.accountIdRef.current = 'account-b';
        await hook.rerender();
        await act(async () => { expect(await pending).toBe(false); });
        hook.disk.unreachable = false;
        await hook.rerender();
        expect(writtenRequests()).toEqual([]);
        expect(hook.getCurrent().getEditorText()).toBe('hello');
    });

    it.each(['cancel', 'unmount'] as const)('settles the waiting Save on %s without reaching the write boundary', async retirement => {
        const hook = await createHarness({ autoSave: false, unreachable: true });
        await act(async () => hook.getCurrent().onEditorChange('offline draft'));
        let pending!: Promise<boolean>;
        await act(async () => { pending = hook.getCurrent().saveFileEdits(); });
        if (retirement === 'unmount') await hook.unmount();
        else await act(async () => hook.getCurrent().cancelEditingFile());
        await act(async () => { expect(await pending).toBe(false); });
        if (retirement === 'cancel') {
            hook.disk.unreachable = false;
            await hook.rerender();
            expect(hook.getCurrent()).toMatchObject({ isSavingEdits: false, isEditingFile: false });
        }
        expect(writtenRequests()).toEqual([]);
    });

    it('keeps editing in memory when device draft persistence throws', async () => {
        const hook = await createHarness({ autoSave: false, persistDraft: () => { throw new Error('quota'); } });
        await act(async () => hook.getCurrent().onEditorChange('kept in memory'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(hook.getCurrent().getEditorText()).toBe('kept in memory');
        expect(hook.getCurrent()).toMatchObject({ editorDirty: true, draftPersistenceFailed: true });
    });

    it('uses the shown disk hash for Use mine and restores that disk version with a guarded Undo', async () => {
        const refreshed = createDeferred<void>();
        let refreshCount = 0;
        const hook = await createHarness({ autoSave: false, refreshAll: async () => {
            if (++refreshCount === 2) await refreshed.promise;
        } });
        await act(async () => hook.getCurrent().onEditorChange('mine'));
        hook.disk.text = 'theirs'; hook.disk.hash = 'theirs-hash';
        await hook.rerender();
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'mine-hash' });
        await act(async () => { await hook.getCurrent().resolveConflict('useMine'); });
        expect(writtenRequests()[0]).toMatchObject({ content: 'mine', expectedHash: 'theirs-hash' });
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'restored-hash' });
        const undo = readPresentationNotice()?.undo;
        expect(undo).toBeDefined();
        await act(async () => {
            undo?.run();
            await vi.waitFor(() => expect(hook.getCurrent().readSnapshot().hash).toBe('restored-hash'));
        });
        expect(writtenRequests()[1]).toMatchObject({ content: 'theirs', expectedHash: 'mine-hash' });
        try {
            await act(async () => hook.getCurrent().onEditorChange('edited after Undo'));
            writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'after-undo-hash' });
            await act(async () => { expect(await hook.getCurrent().saveFileEdits()).toBe(true); });
            expect(writtenRequests()[2]).toMatchObject({ content: 'edited after Undo', expectedHash: 'restored-hash' });
        } finally { await act(async () => refreshed.resolve()); }
    });

    it('guards Use mine Undo with its write receipt after a later version arrives during refresh', async () => {
        const refreshing = createDeferred<void>();
        const refreshed = createDeferred<void>();
        let firstRefresh = true;
        const hook = await createHarness({ autoSave: false, refreshAll: async () => {
            if (!firstRefresh) return;
            firstRefresh = false; refreshing.resolve(); await refreshed.promise;
        } });
        await act(async () => hook.getCurrent().onEditorChange('mine'));
        hook.disk.text = 'theirs'; hook.disk.hash = 'theirs-hash';
        await hook.rerender();
        // Model the Machine's guarded filesystem boundary; Action admission and the editor remain real.
        const remote = { text: 'theirs', hash: 'theirs-hash' };
        writeRpcSpy.mockImplementation(async request => {
            const write = FilesystemWriteFileInputSchema.parse(request.payload);
            if (write.expectedHash !== remote.hash) return { success: false, error: 'changed', errorCode: 'hash_mismatch' };
            remote.text = Buffer.from(write.content, 'base64').toString('utf8');
            remote.hash = remote.text === 'mine' ? 'mine-hash' : 'restored-hash';
            return { success: true, hash: remote.hash };
        });
        let resolving!: Promise<void>;
        await act(async () => { resolving = hook.getCurrent().resolveConflict('useMine'); await refreshing.promise; });
        remote.text = 'later external version'; remote.hash = 'later-hash';
        hook.disk.text = remote.text; hook.disk.hash = remote.hash;
        await hook.rerender();
        expect(hook.getCurrent().editorOriginalHash).toBe('later-hash');
        await act(async () => { refreshed.resolve(); await resolving; });
        await act(async () => hook.getCurrent().undoSetAside());
        expect(remote).toEqual({ text: 'later external version', hash: 'later-hash' });
        expect(writtenRequests()[1]).toMatchObject({ content: 'theirs', expectedHash: 'mine-hash' });
        expect(hook.getCurrent().getEditorText()).toBe('later external version');
    });

    it.each(['unmount', 'mounted-ref', 'edit', 'notice'] as const)('does not revive Use mine Undo after %s retires it before the write receipt', async retirement => {
        const dispatched = createDeferred<void>();
        const receipt = createDeferred<WriteResponse>();
        const hook = await createHarness({ autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('mine'));
        hook.disk.text = 'theirs'; hook.disk.hash = 'theirs-hash';
        await hook.rerender();
        writeRpcSpy.mockImplementationOnce(async () => { dispatched.resolve(); return receipt.promise; });
        let resolving!: Promise<void>;
        await act(async () => { resolving = hook.getCurrent().resolveConflict('useMine'); await dispatched.promise; });
        const undoPublications: string[] = [];
        const unsubscribe = subscribePresentationNotices(() => {
            const notice = readPresentationNotice();
            if (notice?.undo) undoPublications.push(notice.key);
        });
        try {
            if (retirement === 'unmount') await hook.unmount();
            else if (retirement === 'mounted-ref') hook.mountedRef.current = false;
            else if (retirement === 'edit') await act(async () => hook.getCurrent().onEditorChange('new draft'));
            else publishPresentationNotice({ key: 'newer-review-action', severity: 'info', message: 'newer review action' });
            await act(async () => { receipt.resolve({ success: true, hash: 'mine-hash' }); await resolving; });
            expect(undoPublications).toEqual([]);
            expect(readPresentationNotice()?.key).toBe(retirement === 'notice' ? 'newer-review-action' : undefined);
            expect(writtenRequests()).toHaveLength(1);
            if (retirement === 'edit') expect(hook.getCurrent().getEditorText()).toBe('new draft');
        } finally { unsubscribe(); }
    });

    it.each(['unmount', 'mounted-ref'] as const)('does not dispatch a retained Undo callback after %s retires its tab', async retirement => {
        const hook = await createHarness({ autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('mine'));
        hook.disk.text = 'theirs'; hook.disk.hash = 'theirs-hash';
        await hook.rerender();
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'mine-hash' });
        await act(async () => hook.getCurrent().resolveConflict('useMine'));
        const undo = readPresentationNotice()?.undo;
        const retainedUndo = hook.getCurrent().undoSetAside;
        expect(undo).toBeDefined();
        if (retirement === 'unmount') await hook.unmount();
        else hook.mountedRef.current = false;
        await act(async () => { await retainedUndo(); undo?.run(); });
        expect(writtenRequests()).toHaveLength(1);
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
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
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
            persistedDraft: { accountId: 'account-a', isEditingFile: true, editorOriginalHash: 'h1', editorText: 'private draft' } });
        expect(hook.getCurrent().isEditingFile).toBe(false);
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        await act(async () => hook.getCurrent().startEditingFile());
        await act(async () => hook.getCurrent().onEditorChange('new private draft'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(hook.persistDraft).not.toHaveBeenCalled();
    });

    it('resets local editing state on Account changes without losing the first Account’s cached draft', async () => {
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('Alice draft'));
        hook.accountIdRef.current = 'account-b';
        await hook.rerender();
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: false, editorDirty: false });
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        hook.accountIdRef.current = 'account-a';
        await hook.rerender();
        expect(hook.getCurrent().getEditorText()).toBe('Alice draft');
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: true, editorDirty: true });
    });

    it('checkpoints the latest unpublished text to its previous Account before replacing the editor owner', async () => {
        const hook = await createHarness({ autoSave: false });
        await act(async () => hook.getCurrent().onEditorChange('Alice first edit'));
        await act(async () => hook.getCurrent().onEditorChange('Alice second edit'));
        await act(async () => hook.getCurrent().onEditorChange('Alice latest pending edit'));
        hook.accountIdRef.current = 'account-b';
        await hook.rerender();
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        hook.accountIdRef.current = 'account-a';
        await hook.rerender();
        expect(hook.getCurrent().getEditorText()).toBe('Alice latest pending edit');
        expect(hook.getCurrent().editorDirty).toBe(true);
    });

    it('does not restore another Account’s persisted pane draft', async () => {
        const hook = await createHarness({ accountId: 'account-b', startEditing: false,
            persistedDraft: { accountId: 'account-a', isEditingFile: true, editorOriginalHash: 'h1', editorText: 'Alice pane draft' } });
        expect(hook.getCurrent().isEditingFile).toBe(false);
        expect(hook.getCurrent().getEditorText()).toBe('hello');
    });

    it('reacts to the selected Home’s actual Account publication and fails closed for another Home', async () => {
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://draft.test', generation: 1 });
        storage.setState({ profileScope: { serverId: scope.serverId, accountId: 'account-a' } });
        const hook = await createHarness({ deriveAccountFromSelectedHome: true });
        await act(async () => hook.getCurrent().onEditorChange('Alice draft'));
        await act(async () => storage.setState({ profileScope: { serverId: scope.serverId, accountId: 'account-b' } }));
        expect(hook.getCurrent()).toMatchObject({ isEditingFile: false, editorDirty: false });
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        await act(async () => storage.setState({ profileScope: { serverId: scope.serverId, accountId: 'account-a' } }));
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
        hook.accountIdRef.current = 'account-b';
        await hook.rerender();
        await act(async () => oldEditorChange('Alice delayed callback'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(writeRpcSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().getEditorText()).toBe('hello');
        expect(oldLiveValue.get()).toBe('');
        expect(hook.getCurrent().liveValue.get()).toBe('hello');
        expect(hook.persistDraft).not.toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-b' }));
    });

    it('does not apply an old Account’s completed write to the new editor owner', async () => {
        const pending = createDeferred<WriteResponse>();
        const bobPending = createDeferred<WriteResponse>();
        writeRpcSpy.mockReturnValueOnce(pending.promise).mockReturnValueOnce(bobPending.promise);
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('Alice writing'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(writeRpcSpy, JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toHaveBeenCalled();
        // A positive write for the replacement owner needs that Account's real credentials too.
        scope.serverId = await prepareWorkspaceFileDetailsActionBoundary(scope.machineId, 'account-b');
        hook.accountIdRef.current = 'account-b';
        await hook.rerender();
        expect(hook.getCurrent().isSavingEdits).toBe(false);
        await act(async () => hook.getCurrent().startEditingFile());
        await act(async () => hook.getCurrent().onEditorChange('Bob writing'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
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
        hook.accountIdRef.current = 'account-b';
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
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        hook.accountIdRef.current = 'account-b';
        await hook.rerender();
        hook.accountIdRef.current = 'account-a';
        await hook.rerender();
        await act(async () => hook.getCurrent().onEditorChange('Alice returned invocation'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
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
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(hook.getCurrent().isSavingEdits).toBe(true);
        await act(async () => hook.getCurrent().onEditorChange('hello changed more'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(writtenRequests()).toEqual([{ path: 'src/a.ts', content: 'hello changed', expectedHash: 'h1' }]);

        await act(async () => firstWrite.resolve({ success: true, hash: 'h2' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
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
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().editorDirty).toBe(false);
        expect(hook.getCurrent().getEditorText()).toBe('hello changed');

        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h3' });
        await act(async () => hook.getCurrent().onEditorChange('hello again'));
        await act(async () => { await vi.advanceTimersByTimeAsync(90); });
        await act(async () => hook.getCurrent().onEditorChange('hello again!'));
        await act(async () => { await vi.advanceTimersByTimeAsync(90); });
        expect(writtenRequests()).toHaveLength(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(10); });
        expect(writtenRequests()[1]).toEqual({ path: 'src/a.ts', content: 'hello again!', expectedHash: 'h2' });
        expect(hook.getCurrent().isEditingFile).toBe(true);
    });

    it('saves text entered while the successful write is refreshing the file', async () => {
        const refresh = createDeferred<void>();
        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h2' }).mockResolvedValueOnce({ success: true, hash: 'h3' });
        const hook = await createHarness({ refreshAll: () => refresh.promise });
        await act(async () => hook.getCurrent().onEditorChange('hello changed'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        // A display refresh does not delay the next opt-in autosave.
        expect(hook.getCurrent().editorStatus).toBe('clean');
        expect(hook.getCurrent().editorOriginalHash).toBe('h2');
        await act(async () => hook.getCurrent().onEditorChange('hello changed during refresh'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(writtenRequests()).toHaveLength(2);
        await act(async () => refresh.resolve());
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(writtenRequests()[1]).toEqual({ path: 'src/a.ts', content: 'hello changed during refresh', expectedHash: 'h2' });
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().editorDirty).toBe(false);
    });

    it('restores newer unsaved text against the successful write baseline after remounting', async () => {
        const firstWrite = createDeferred<WriteResponse>();
        writeRpcSpy.mockReturnValueOnce(firstWrite.promise);
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('hello changed'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        await act(async () => hook.getCurrent().onEditorChange('hello changed more'));
        await act(async () => firstWrite.resolve({ success: true, hash: 'h2' }));
        expect(hook.persistDraft).toHaveBeenLastCalledWith({
            accountId: 'account-a',
            isEditingFile: true,
            editorOriginalHash: 'h2',
            editorText: 'hello changed more',
        }, { persist: true });
        await hook.unmount();

        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h3' });
        const restored = await createHarness({ fileText: 'hello changed', fileHash: 'h2', startEditing: false,
            persistedDraft: hook.persistDraft.mock.calls.at(-1)?.[0] ?? null });
        expect(restored.getCurrent().isEditingFile).toBe(true);
        expect(restored.getCurrent().getEditorText()).toBe('hello changed more');
        expect(restored.getCurrent().conflict).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(writtenRequests()[1]).toEqual({ path: 'src/a.ts', content: 'hello changed more', expectedHash: 'h2' });
    });

    it('retains failed edits without repeated writes and retries only after explicit Save', async () => {
        writeRpcSpy.mockResolvedValueOnce({ success: false, error: 'Disk unavailable', errorCode: 'FILE_WRITE_FAILED' });
        const hook = await createHarness();
        await act(async () => hook.getCurrent().onEditorChange('hello changed'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(hook.getCurrent().isEditingFile).toBe(true);
        expect(hook.getCurrent().editorDirty).toBe(true);
        expect(hook.getCurrent().getEditorText()).toBe('hello changed');
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(writtenRequests()).toHaveLength(1);

        writeRpcSpy.mockResolvedValueOnce({ success: true, hash: 'h2' });
        await act(async () => hook.getCurrent().onEditorChange('hello recovered'));
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(writtenRequests()).toHaveLength(1);
        await act(async () => { await hook.getCurrent().saveFileEdits(); });
        expect(writtenRequests()[1]).toEqual({ path: 'src/a.ts', content: 'hello recovered', expectedHash: 'h1' });
        expect(hook.getCurrent().editorDirty).toBe(false);
    });

    it('keeps dirty typing local to the Markdown leaf across the real document publication cadence', async () => {
        const { MarkdownCodeEditorField } = await import('@/components/ui/markdown/editor/MarkdownCodeEditorField');
        const { MarkdownEditModeMenu } = await import('@/components/ui/markdown/editorChrome/MarkdownEditModeMenu');
        const { loadAccountSettings, saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const originalSettings = storage.getState().settings;
        editorPlatform.os = 'ios';
        // The connected Account's settings owner re-applies its persisted envelope after
        // activation; enable the rich-editor controls there, not only in the live store.
        const settingsScope = { serverId: scope.serverId, accountId: 'account-a' };
        const persistedSettings = loadAccountSettings(settingsScope);
        const enabledSettings = { ...settingsParse(persistedSettings.settings), experiments: true,
            featureToggles: { ...settingsParse(persistedSettings.settings).featureToggles, 'files.editor': true, 'files.markdownRichEditor': true },
            markdownDefaultEditMode: 'raw' as const,
        };
        saveAccountSettings(settingsScope, enabledSettings, persistedSettings.version ?? 0);
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
            editor = useWorkspaceFileEditorState({ scope, accountId: 'account-a', filePath: 'README.md', displayMode: 'file',
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
            // immediately, then debounces later leaf publications only.
            await act(async () => { emit('docChanged', { doc: '# Second dirty edit' }); });
            expect(editor.liveValue.get()).toBe('# Second dirty edit');
            expect(headerRenders).toBe(afterDirty.headerRenders);
            expect(leafCommits).toBeGreaterThan(afterDirty.leafCommits);
            expect(persistDraft.mock.calls).toHaveLength(afterDirty.persisted);
            const afterImmediate = { headerRenders, leafCommits, persisted: persistDraft.mock.calls.length };
            const next = 'A note[^1]\n\n[^1]: newly unsupported\n';
            await act(async () => { emit('docChanged', { doc: next }); await vi.advanceTimersByTimeAsync(99); });
            // The native surface and subscribed Markdown leaf see current text
            // while recovery remains at lifecycle checkpoints.
            expect(editor.editorHandleRef.current?.getValue()).toBe(next);
            expect(editor.liveValue.get()).toBe(next);
            expect(headerRenders).toBe(afterImmediate.headerRenders);
            expect(persistDraft.mock.calls).toHaveLength(afterImmediate.persisted);
            await act(async () => { await vi.advanceTimersByTimeAsync(1); });
            expect(editor.liveValue.get()).toBe(next);
            expect(screen.findByType(MarkdownEditModeMenu).props.richDisabledReason).toBe('footnotes');
            expect(leafCommits).toBeGreaterThan(afterImmediate.leafCommits);
            expect(headerRenders).toBe(afterImmediate.headerRenders);
            expect(persistDraft.mock.calls).toHaveLength(afterImmediate.persisted);
            await screen.unmount();
            screen = undefined;
            expect(persistDraft).toHaveBeenLastCalledWith(expect.objectContaining({ editorText: next }), { persist: true });
            expect(writtenRequests()).toHaveLength(0);
        } finally {
            await screen?.unmount();
            editorPlatform.os = 'web';
            storage.setState({ settings: originalSettings });
        }
    });
});
