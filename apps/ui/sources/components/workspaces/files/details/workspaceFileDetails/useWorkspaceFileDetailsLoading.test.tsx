import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { FilesystemWriteFileInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { acknowledgeWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';
import { resolveWorkspaceFileViewerChoiceModel } from './resolveWorkspaceFileViewer';
import {
    cleanupWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsCommonModuleMocks,
    prepareWorkspaceFileDetailsActionBoundary,
    getWorkspaceFileDetailsActionBoundary,
} from './workspaceFileDetailsTestHelpers';
installWorkspaceFileDetailsCommonModuleMocks();
installWorkspaceFileDetailsActionBoundary();
const transport = vi.hoisted(() => ({ diff: vi.fn(), stat: vi.fn() }));
// Remote filesystem/SCM and platform digest boundaries; the loader stays real.
vi.mock('@/sync/ops/scm/machineScm', () => ({ machineScmDiffFile: transport.diff }));
vi.mock('@/sync/domains/transfers/runtime/transferRuntime', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/domains/transfers/runtime/transferRuntime')>(),
    callDaemonWorkspaceStatFileRpc: transport.stat,
}));
vi.mock('@/config', () => ({ config: { filesPreviewMaxBytes: 1000000 } }));
vi.mock('@/platform/digest', async () => {
    const { createHash } = await import('node:crypto');
    return { digest: async (_algorithm: string, bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()) };
});
const patch = (text: string) => `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+${text}\n`;
const input = { scope: { serverId: 'server', machineId: 'machine', rootPath: '/repo' }, filePath: 'file.txt', diffMode: 'pending' as const, fileEntryKind: 'modified' as const, isActive: true, refreshFingerprint: '1' };
const workspaceFileDetailsActionBoundary = getWorkspaceFileDetailsActionBoundary();
// Load the loader only after the socket boundary is installed.
const { useWorkspaceFileDetailsLoading } = await import('./useWorkspaceFileDetailsLoading');
const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');
const { machineWorkspaceFileReplaceApply } = await import('@/sync/ops/machineWorkspaceFileReplace');
let current: ReturnType<typeof useWorkspaceFileDetailsLoading>;
function Harness(props: Parameters<typeof useWorkspaceFileDetailsLoading>[0]) { current = useWorkspaceFileDetailsLoading(props); return null; }
beforeEach(async () => {
    input.scope.serverId = await prepareWorkspaceFileDetailsActionBoundary(input.scope.machineId);
    transport.diff.mockReset().mockResolvedValue({ success: true, diff: patch('new') });
    transport.stat.mockReset().mockResolvedValue({ success: true, exists: true, sizeBytes: 4 });
    workspaceFileDetailsActionBoundary.replace.mockReset();
    workspaceFileDetailsActionBoundary.read.mockReset().mockResolvedValue({ success: true, content: 'bmV3Cg==' });
});
afterEach(cleanupWorkspaceFileDetailsActionBoundary);
it.each(['matching bytes', 'changed bytes', 'failed read'] as const)('keeps a restored draft editable and admits Save only after its initial byte metadata: %s', async outcome => {
    const initialBytes = '\uFEFFbase\r\n';
    const originalHash = createHash('sha256').update(initialBytes).digest('hex');
    const pendingRead = createDeferred<{ success: true; content: string } | { success: false; error: string }>();
    let blocked = true;
    let diskBytes = initialBytes;
    const writes: ReturnType<typeof FilesystemWriteFileInputSchema.parse>[] = [];
    workspaceFileDetailsActionBoundary.read.mockImplementation(async (request: { payload: unknown }) => {
        const write = FilesystemWriteFileInputSchema.safeParse(request.payload);
        if (write.success) {
            writes.push(write.data);
            diskBytes = Buffer.from(write.data.content, 'base64').toString('utf8');
            return { success: true, hash: createHash('sha256').update(diskBytes).digest('hex') };
        }
        return blocked ? pendingRead.promise : { success: true, content: Buffer.from(diskBytes).toString('base64') };
    });
    let editor!: ReturnType<typeof useWorkspaceFileEditorState>;
    function RestoredDraft() {
        const loader = useWorkspaceFileDetailsLoading({ ...input, accountId: 'account-a', includeFile: true, includeDiff: false });
        editor = useWorkspaceFileEditorState({ scope: input.scope, accountId: 'account-a', filePath: input.filePath, displayMode: 'file',
            fileText: loader.fileContent?.content ?? null, fileHash: loader.fileContent?.contentHash ?? null, encoding: loader.fileContent?.encoding,
            fileWriteSupported: loader.fileWriteSupported, setFileWriteSupported: loader.setFileWriteSupported,
            fileEditorFeatureEnabled: true, filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
            filesEditorAutoSave: false, filesEditorChangeDebounceMs: 0, mountedRef: { current: true },
            refreshAll: loader.refreshAll, readFileForSave: loader.readFileForSave, publishSavedFile: loader.publishSavedFile,
            persistedDraft: { accountId: 'account-a', isEditingFile: true, editorOriginalHash: originalHash, editorText: 'edited\n' },
        });
        return null;
    }
    let tree!: renderer.ReactTestRenderer;
    let save: Promise<boolean> | undefined;
    try {
        await act(async () => { tree = renderer.create(<RestoredDraft />); });
        expect(editor.editorSurfaceEnabled).toBe(true);
        expect(editor.getEditorText()).toBe('edited\n');
        await waitForHomeGovernance(() => expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(1));
        await act(async () => { save = editor.saveFileEdits(); await Promise.resolve(); });
        // Hold both the initial read and Save's metadata refresh before choosing their outcome.
        await waitForHomeGovernance(() => expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(2));
        expect(writes).toEqual([]);
        expect(editor.isEditingFile).toBe(true);
        expect(editor.getEditorText()).toBe('edited\n');
        blocked = false;
        if (outcome === 'changed bytes') diskBytes = '\uFEFFanother writer\r\n';
        await act(async () => {
            pendingRead.resolve(outcome === 'failed read' ? { success: false, error: 'unreadable' }
                : { success: true, content: Buffer.from(diskBytes).toString('base64') });
            expect(await save).toBe(outcome === 'matching bytes');
        });
        if (outcome === 'matching bytes') {
            expect(writes).toHaveLength(1);
            expect(Buffer.from(writes[0]!.content, 'base64').toString('utf8')).toBe('\uFEFFedited\r\n');
            expect(writes[0]!.expectedHash).toBe(originalHash);
        } else {
            expect(writes).toEqual([]);
            expect(editor.getEditorText()).toBe('edited\n');
            expect(editor.editorDirty).toBe(true);
            if (outcome === 'changed bytes') expect(editor.conflict?.theirsHash).toBe(createHash('sha256').update(diskBytes).digest('hex'));
            else expect(editor.refusal?.kind).toBe('failed');
        }
    } finally {
        blocked = false;
        pendingRead.resolve({ success: true, content: Buffer.from(diskBytes).toString('base64') });
        await act(async () => { await save; tree?.unmount(); });
    }
});
it('retains the same full after-text across a cold Changes open and View/Changes transitions', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} includeDiff includeFile={false} />); });
    const afterText = current.fileContent;
    expect(afterText).toMatchObject({ content: 'new\n', isBinary: false });
    expect(current.diffContent).toBe(patch('new'));
    await act(async () => { tree.update(<Harness {...input} includeDiff={false} includeFile />); });
    expect(current.fileContent).toBe(afterText);
    await act(async () => { tree.update(<Harness {...input} includeDiff includeFile={false} />); });
    expect(current.fileContent).toBe(afterText);
    expect(current.diffContent).toBe(patch('new'));
    await act(async () => { tree.unmount(); });
});
it('retires retained controller bytes when the same path selects an attached workspace', async () => {
    const props = { ...input, accountId: 'account-a', includeDiff: false, includeFile: true };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...props} />); });
    try {
        await waitForHomeGovernance(() => expect(current.fileContent?.content).toBe('new\n'));
        const scope = { ...input.scope, workspace: { v: 2 as const, kind: 'managed' as const, workspaceId: 'attached-project', managedId: 'guest',
            serverId: input.scope.serverId, rootPath: input.scope.rootPath,
            controller: { machineId: input.scope.machineId, installationId: 'installation' } } };
        await act(async () => { tree.update(<Harness {...props} scope={scope} isActive={false} />); });
        expect(current.fileContent).toBeNull();
    } finally {
        await act(async () => { tree.unmount(); });
    }
});
it('publishes a stopped workspace from preview metadata without requesting bytes', async () => {
    const workspace = { v: 2 as const, kind: 'managed' as const, workspaceId: 'remote-project', managedId: 'guest',
        serverId: input.scope.serverId, rootPath: input.scope.rootPath,
        controller: { machineId: input.scope.machineId, installationId: 'installation' } };
    transport.stat.mockResolvedValue({ success: false, errorCode: 'managed_power_required', error: 'Guest is stopped' });
    let tree!: renderer.ReactTestRenderer;
    try {
        await act(async () => { tree = renderer.create(<Harness {...input} scope={{ ...input.scope, workspace }} includeDiff={false} includeFile />); });
        await waitForHomeGovernance(() => expect(current.error).toBe('Guest is stopped'));
        expect(current).toMatchObject({ errorCode: 'managed_power_required', fileContent: null });
        expect(transport.stat).toHaveBeenCalledWith(expect.objectContaining({ workspace }));
        expect(workspaceFileDetailsActionBoundary.read).not.toHaveBeenCalled();
    } finally {
        await act(async () => { tree?.unmount(); });
    }
});
it('switches the viewer read identity without reusing opaque binary bytes or publishing a late text read', async () => {
    const selection = resolveWorkspaceFileViewerChoiceModel({ metadata: { contentClass: 'binary' },
        preferences: { v: 1, selections: {} }, availablePluginViewers: [], builtinViewer: 'text' }).selected;
    const props = { ...input, filePath: 'opaque.bin', isBinaryContent: true, includeDiff: false, includeFile: true };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...props} />); });
    expect(current.fileContent?.isBinary).toBe(true);
    expect(workspaceFileDetailsActionBoundary.read).not.toHaveBeenCalled();
    let finish!: (value: { success: true; content: string }) => void;
    workspaceFileDetailsActionBoundary.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { tree.update(<Harness {...props} readAsText={selection.kind === 'text'} />); });
    await waitForHomeGovernance(() => expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(1));
    await act(async () => { tree.update(<Harness {...props} />); });
    await act(async () => { finish({ success: true, content: Buffer.from('late text').toString('base64') }); });
    expect(current.fileContent).toMatchObject({ isBinary: true, content: '' });
    await act(async () => { tree.update(<Harness {...props} readAsText />); });
    await waitForHomeGovernance(() => expect(current.fileContent?.content).toBe('new\n'));
    expect(current.fileContent).toMatchObject({ isBinary: false, content: 'new\n', encoding: { editable: false } });
    await act(async () => { tree.unmount(); });
});
it('rereads acknowledged saved bytes without a snapshot change and rejects pre-write publication', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} includeDiff={false} includeFile />); });
    let finishOld!: (value: { success: true; content: string }) => void;
    let oldSignal: AbortSignal | undefined;
    workspaceFileDetailsActionBoundary.read.mockImplementationOnce((request: { signal?: AbortSignal }) => {
        oldSignal = request.signal;
        return new Promise(resolve => { finishOld = resolve; });
    });
    let oldRefresh!: Promise<void>;
    await act(async () => { oldRefresh = current.refreshAll(); });
    await waitForHomeGovernance(() => expect(finishOld).toEqual(expect.any(Function)));
    let finishReplacement!: (value: { success: true; content: string }) => void;
    workspaceFileDetailsActionBoundary.read.mockImplementationOnce(() => new Promise(resolve => { finishReplacement = resolve; }));
    workspaceFileDetailsActionBoundary.replace.mockResolvedValueOnce({ ok: true, results: [{ path: '/repo/file.txt', status: 'replaced', hash: 'replace-ack' }] });
    await act(async () => {
        expect(await machineWorkspaceFileReplaceApply(input.scope.machineId, {
            rootPath: input.scope.rootPath, operation: { kind: 'replace', matcher: { query: 'new', replacement: 'replaced' },
                files: [{ path: input.filePath, expectedHash: 'a'.repeat(64) }] },
        }, { serverId: input.scope.serverId, accountId: 'account-a' })).toMatchObject({ ok: true });
    });
    // Acknowledgement identity is available while its reread is still pending.
    expect(current.lastOwnWriteHash).toBe('replace-ack');
    expect(oldSignal?.aborted).toBe(true);
    await waitForHomeGovernance(() => expect(finishReplacement).toEqual(expect.any(Function)));
    await act(async () => { finishReplacement({ success: true, content: Buffer.from('replaced').toString('base64') }); });
    await waitForHomeGovernance(() => expect(current.fileContent?.content).toBe('replaced'));
    await act(async () => { finishOld({ success: true, content: Buffer.from('obsolete').toString('base64') }); await oldRefresh; });
    expect(current.fileContent?.content).toBe('replaced');
    workspaceFileDetailsActionBoundary.read.mockResolvedValue({ success: false, error: 'unreadable' });
    const retained = current.fileContent;
    workspaceFileDetailsActionBoundary.replace.mockResolvedValueOnce({ ok: true, results: [{ path: input.filePath, status: 'restored', hash: 'undo-ack' }] });
    await act(async () => {
        expect(await machineWorkspaceFileReplaceApply(input.scope.machineId, {
            rootPath: input.scope.rootPath, operation: { kind: 'restore', files: [{ path: input.filePath,
                expectedHash: 'b'.repeat(64), edits: [{ startUtf16: 0, deleteLength: 8, insertText: 'new', originalText: 'replaced' }] }] },
        }, { serverId: input.scope.serverId, accountId: 'account-a' })).toMatchObject({ ok: true });
    });
    await waitForHomeGovernance(() => expect(current.error).not.toBe(null));
    expect(current.fileContent).toBe(retained);
    expect(current.staleSince).toEqual(expect.any(Number));
    expect(current.lastOwnWriteHash).toBe('undo-ack');
    expect(current.error).not.toBe(null);
    await act(async () => { tree.unmount(); });
});
it('invalidates hidden saved bytes only for the selected Account and path, then rereads on activation', async () => {
    let tree!: renderer.ReactTestRenderer;
    const props = { ...input, accountId: 'account-a', includeFile: true, includeDiff: false };
    await act(async () => { tree = renderer.create(<Harness {...props} />); });
    await waitForHomeGovernance(() => expect(current.fileContent?.content).toBe('new\n'));
    await act(async () => { tree.update(<Harness {...props} isActive={false} />); });
    await act(async () => {
        acknowledgeWorkspaceFileWrites({ ...input.scope, accountId: 'account-b' }, [{ path: input.filePath, hash: 'wrong-account' }]);
        acknowledgeWorkspaceFileWrites({ ...input.scope, accountId: 'account-a' }, [{ path: 'other.txt', hash: 'wrong-path' }]);
    });
    expect(current.lastOwnWriteHash).toBe(null);
    await act(async () => { tree.update(<Harness {...props} />); });
    expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(1);
    await act(async () => { tree.update(<Harness {...props} isActive={false} />); });
    workspaceFileDetailsActionBoundary.read.mockResolvedValue({ success: true, content: Buffer.from('undone').toString('base64') });
    await act(async () => { acknowledgeWorkspaceFileWrites({ ...input.scope, accountId: 'account-a' }, [{ path: input.filePath, hash: 'hidden-ack' }]); });
    expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(1);
    expect(current.lastOwnWriteHash).toBe('hidden-ack');
    await act(async () => { tree.update(<Harness {...props} />); });
    await waitForHomeGovernance(() => expect(current.fileContent?.content).toBe('undone'));
    expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(2);
    await act(async () => { tree.update(<Harness {...props} accountId={null} />); });
    expect(current.lastOwnWriteHash).toBe(null);
    // Changing the resource Account starts its own read; settle it before measuring acknowledgement work.
    await waitForHomeGovernance(() => expect(current.isLoading).toBe(false));
    const reads = workspaceFileDetailsActionBoundary.read.mock.calls.length;
    await act(async () => { acknowledgeWorkspaceFileWrites({ ...input.scope, accountId: 'account-a' }, [{ path: input.filePath, hash: 'must-not-capture' }]); });
    expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(reads);
    expect(current.lastOwnWriteHash).toBe(null);
    await act(async () => { tree.unmount(); });
});
it('shows progressive diff and ignores an obsolete mode result', async () => {
    let finishOld!: (value: { success: true; diff: string }) => void;
    transport.diff.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    let finishRead!: (value: { success: true; content: string }) => void;
    workspaceFileDetailsActionBoundary.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    await waitForHomeGovernance(() => expect(finishRead).toEqual(expect.any(Function)));
    await act(async () => { tree.update(<Harness {...input} diffMode="included" />); });
    await waitForHomeGovernance(() => expect(current.fileContent?.content).toBe('new\n'));
    expect(current.diffContent).toBe(patch('new'));
    expect(current.isLoading).toBe(false);
    await act(async () => { finishOld({ success: true, diff: patch('obsolete') }); finishRead({ success: true, content: 'b2xkCg==' }); });
    expect(current.diffContent).toBe(patch('new'));
    expect(current.fileContent?.content).toBe('new\n');
    await act(async () => { tree.unmount(); });
});
it('defers hidden refresh and preserves equal content references', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    const content = current.fileContent;
    await act(async () => { tree.update(<Harness {...input} isActive={false} refreshFingerprint="2" />); });
    expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(1);
    await act(async () => { tree.update(<Harness {...input} refreshFingerprint="2" />); });
    expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(2);
    expect(current.fileContent).toBe(content);
    expect(current.isLoading).toBe(false);
    await act(async () => { tree.unmount(); });
});
it('shows a useful patch while full content is pending', async () => {
    let finishRead!: (value: { success: true; content: string }) => void;
    workspaceFileDetailsActionBoundary.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    expect(current.diffContent).toBe(patch('new'));
    expect(current.isLoading).toBe(false);
    expect(current.fileContent).toBe(null);
    await act(async () => { finishRead({ success: true, content: 'bmV3Cg==' }); tree.unmount(); });
});
it('publishes the saved version and rejects a read that started before that write', async () => {
    let finishRead!: (value: { success: true; content: string }) => void;
    workspaceFileDetailsActionBoundary.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    await act(async () => { current.publishSavedFile({ text: 'saved', hash: 'saved-hash' }); });
    await act(async () => { finishRead({ success: true, content: 'b2xkCg==' }); });
    expect(current.fileContent).toMatchObject({ content: 'saved', contentHash: 'saved-hash' });
    await act(async () => { tree.unmount(); });
});
it('aborts a preview transfer on hide, superseding refresh, and unmount without publishing stale content', async () => {
    const signals: AbortSignal[] = [];
    const finishReads: Array<(value: { success: true; content: string }) => void> = [];
    workspaceFileDetailsActionBoundary.read.mockImplementation((request: { signal?: AbortSignal }) => {
        if (request.signal) signals.push(request.signal);
        return new Promise(resolve => { finishReads.push(resolve); });
    });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    await act(async () => { tree.update(<Harness {...input} isActive={false} />); });
    expect(signals[0].aborted).toBe(true);
    await act(async () => { finishReads[0]({ success: true, content: 'b2xkCg==' }); });
    expect(current.fileContent).toBe(null);
    await act(async () => { tree.update(<Harness {...input} />); });
    expect(signals).toHaveLength(2);
    let refresh!: Promise<void>;
    await act(async () => { refresh = current.refreshAll(); });
    expect(signals[1].aborted).toBe(true);
    expect(signals[2].aborted).toBe(false);
    await act(async () => { tree.unmount(); });
    expect(signals[2].aborted).toBe(true);
    await act(async () => {
        for (const finish of finishReads.slice(1)) finish({ success: true, content: 'bmV3Cg==' });
        await refresh;
    });
});
it('does not start a transfer when the preview hides during stat', async () => {
    let finishStat!: (value: { success: true; exists: true; sizeBytes: number }) => void;
    transport.stat.mockImplementationOnce(() => new Promise(resolve => { finishStat = resolve; }));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    await act(async () => { tree.update(<Harness {...input} isActive={false} />); });
    await act(async () => { finishStat({ success: true, exists: true, sizeBytes: 4 }); });
    expect(workspaceFileDetailsActionBoundary.read).not.toHaveBeenCalled();
    expect(current.fileContent).toBe(null);
    await act(async () => { tree.unmount(); });
});
it('reuses full content for a mode-only switch but rereads on explicit refresh', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    const content = current.fileContent;
    await act(async () => { tree.update(<Harness {...input} diffMode="included" />); });
    expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(1);
    expect(current.fileContent).toBe(content);
    await act(async () => { await current.refreshAll(); });
    expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(2);
    await act(async () => { tree.unmount(); });
});
it('uses the selected slice in read identity and never reuses head bytes for tail', async () => {
    transport.stat.mockResolvedValue({ success: true, exists: true, sizeBytes: 1000002 });
    workspaceFileDetailsActionBoundary.read.mockImplementation((request: { payload: { offset?: number; length?: number } }) => ({
        success: true, content: Buffer.alloc(request.payload.length ?? 0, request.payload.offset ? 't' : 'h').toString('base64'),
        sizeBytes: 1000002, eof: request.payload.offset === 2,
    }));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} includeDiff={false} includeFile />); });
    expect(current.tooLarge).toEqual({ sizeBytes: 1000002, maxPreviewBytes: 1000000 });
    expect(workspaceFileDetailsActionBoundary.read).not.toHaveBeenCalled();
    await act(async () => { tree.update(<Harness {...input} includeFile previewSlice="head" />); });
    await waitForHomeGovernance(() => expect(current.fileContent?.partial?.slice).toBe('head'));
    expect(current.fileContent?.partial).toEqual({ slice: 'head', offset: 0, length: 1000000, totalBytes: 1000002 });
    expect(current.fileWriteSupported).toBe(false);
    expect(current.tooLarge).toBe(null);
    expect(current.diffContent).toBe(null);
    expect(transport.diff).not.toHaveBeenCalled();
    await act(async () => { tree.update(<Harness {...input} includeDiff={false} includeFile previewSlice="tail" />); });
    await waitForHomeGovernance(() => expect(current.fileContent?.partial?.slice).toBe('tail'));
    expect(current.fileContent?.partial?.slice).toBe('tail');
    expect(current.fileContent?.content.startsWith('t')).toBe(true);
    expect(workspaceFileDetailsActionBoundary.read).toHaveBeenCalledTimes(2);
    await act(async () => { tree.unmount(); });
});
it('retains useful content on refresh failure but never carries it into another file', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    await waitForHomeGovernance(() => {
        expect(current.fileContent?.content).toBe('new\n');
        expect(current.diffContent).toBe(patch('new'));
    });
    const content = current.fileContent;
    transport.diff.mockRejectedValue(new Error('offline'));
    workspaceFileDetailsActionBoundary.read.mockResolvedValue({ success: false, error: 'offline' });
    await act(async () => { await current.refreshAll(); });
    expect(current.fileContent).toBe(content);
    expect(current.diffContent).toBe(patch('new'));
    expect(current.error).toBe('offline');
    expect(current.fileWriteSupported).toBe(true);
    expect(current.staleSince).toEqual(expect.any(Number));
    const staleSince = current.staleSince;
    await act(async () => { await current.refreshAll(); });
    expect(current.staleSince).toBe(staleSince);
    await act(async () => { tree.update(<Harness {...input} filePath="other.txt" />); });
    expect(current.fileContent).toBe(null);
    expect(current.diffContent).toBe(null);
    expect(current.staleSince).toBe(null);
    await act(async () => { tree.unmount(); });
});

it('drops the old comparison as soon as a slice is selected, including when that read fails', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    expect(current.diffContent).toBe(patch('new'));
    transport.stat.mockResolvedValue({ success: true, exists: true, sizeBytes: 1000002 });
    let failRead!: (value: { success: false; error: string }) => void;
    workspaceFileDetailsActionBoundary.read.mockImplementationOnce(() => new Promise(resolve => { failRead = resolve; }));
    await act(async () => { tree.update(<Harness {...input} previewSlice="head" />); });
    expect(current.diffContent).toBe(null);
    expect(current.isDiffLoading).toBe(false);
    await waitForHomeGovernance(() => expect(failRead).toEqual(expect.any(Function)));
    await act(async () => { failRead({ success: false, error: 'offline' }); });
    await waitForHomeGovernance(() => expect(current.error).toBe('offline'));
    expect(current.diffContent).toBe(null);
    await act(async () => { tree.unmount(); });
});

it('clears stale freshness after a successful reread', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    workspaceFileDetailsActionBoundary.read.mockResolvedValueOnce({ success: false, error: 'offline' });
    await act(async () => { await current.refreshAll(); });
    expect(current.staleSince).toEqual(expect.any(Number));
    await act(async () => { await current.refreshAll(); });
    expect(current.staleSince).toBe(null);
    expect(current.error).toBe(null);
    await act(async () => { tree.unmount(); });
});

it('remembers only acknowledged own-write hashes and resets them for another resource', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    expect(current.lastOwnWriteHash).toBe(null);
    await act(async () => { current.publishSavedFile({ text: 'mine', hash: 'own-ack' }); });
    expect(current.lastOwnWriteHash).toBe('own-ack');
    await act(async () => { await current.refreshAll(); });
    expect(current.lastOwnWriteHash).toBe('own-ack');
    await act(async () => { tree.update(<Harness {...input} filePath="other.txt" />); });
    expect(current.lastOwnWriteHash).toBe(null);
    await act(async () => { tree.unmount(); });
});


it('never presents another diff area while the new area loads or fails', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    expect(current.diffContent).toBe(patch('new'));
    let failDiff!: (reason: Error) => void;
    transport.diff.mockImplementationOnce(() => new Promise((_resolve, reject) => { failDiff = reject; }));
    await act(async () => { tree.update(<Harness {...input} diffMode="included" />); });
    expect(current.diffContent).toBe(null);
    await act(async () => { failDiff(new Error('included unavailable')); });
    expect(current.diffContent).toBe(null);
    expect(current.error).toBe('included unavailable');
    await act(async () => { tree.unmount(); });
});
