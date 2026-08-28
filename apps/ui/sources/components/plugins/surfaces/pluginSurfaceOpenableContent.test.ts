import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenableContentStatResultV1Schema } from '@happier-dev/protocol';

const workspaceStatFileMock = vi.hoisted(() => vi.fn());
const workspaceReadFileMock = vi.hoisted(() => vi.fn());
const randomUUIDMock = vi.hoisted(() => vi.fn(() => 'a4a01e88-0000-4000-8000-000000000001'));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceStatFileRpc: (...args: unknown[]) => workspaceStatFileMock(...args),
    downloadDaemonWorkspaceFileToBase64: (...args: unknown[]) => workspaceReadFileMock(...args),
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => randomUUIDMock(),
}));

import {
    createPluginSurfaceOpenableContentHandlers,
    createWorkspaceFileOpenableContentBinding,
} from './pluginSurfaceOpenableContent';

const TARGET = {
    machineId: 'machine-1',
    serverId: 'server-1',
    rootPath: '/private/repository',
} as const;

function request(method: string, payload: unknown) {
    return {
        version: 1,
        requestId: `request:${method}`,
        surface: {
            pluginId: 'acme.viewer',
            contributionId: 'markdown-viewer',
            surfaceId: 'surface:viewer',
            placement: 'sessionPane',
            platform: 'web',
            channel: 'internal',
            resourceScope: [],
            diagnostics: [],
        },
        method,
        payload,
    } as never;
}

describe('plugin surface openable content', () => {
    beforeEach(() => {
        workspaceStatFileMock.mockReset();
        workspaceReadFileMock.mockReset();
        randomUUIDMock.mockClear();
        workspaceStatFileMock.mockResolvedValue({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 100,
        });
        workspaceReadFileMock.mockResolvedValue({ ok: true, contentBase64: 'aGVsbG8=' });
    });

    it('changes the revision for an equal-size edit that preserved the modification time', async () => {
        // The failure this pins: a tool that rewrites a file in place and restores
        // its mtime — and any filesystem whose mtime granularity is coarser than
        // the edit — produced byte-identical size and mtime for different bytes.
        // The viewer then compared revisions, saw no change, and presented stale
        // content as current. A write always advances the file's status-change
        // time, and no utimes call can put that back, so it is the fact that
        // makes this revision answer for bytes.
        const before = {
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 100,
            changedMs: 100,
        } as const;
        const afterEqualSizeEdit = { ...before, changedMs: 240 };

        workspaceStatFileMock.mockResolvedValueOnce(before);
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/README.md',
        });
        const first = await binding.stat();

        workspaceStatFileMock.mockResolvedValue(afterEqualSizeEdit);
        const second = await binding.stat();

        expect(first.status).toBe('ready');
        expect(second.status).toBe('ready');
        expect(second.status === 'ready' && first.status === 'ready'
            ? second.revision === first.revision
            : true).toBe(false);

        // And the read guard must refuse the superseded revision rather than
        // handing back the new bytes under the old identity.
        await expect(binding.read({
            ref: binding.ref,
            expectedRevision: first.status === 'ready' ? first.revision : '',
            maxBytes: 1024,
        })).resolves.toEqual({ status: 'changed' });
    });

    it('keeps the workspace path in host custody and reads only the exact opaque reference', async () => {
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/README.MD',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });

        expect(binding.ref).toEqual({
            kind: 'workspaceFile',
            handle: 'workspaceFile_a4a01e88-0000-4000-8000-000000000001',
        });
        expect(JSON.stringify(binding.ref)).not.toContain('README');
        expect(JSON.stringify(binding.ref)).not.toContain('/private/repository');

        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref }))).resolves.toEqual({
            status: 'ready',
            contentClass: 'text',
            mimeType: 'text/plain',
            extension: '.md',
            sizeBytes: 5,
            revision: 'workspace-file:5:100',
        });
        expect(workspaceStatFileMock).toHaveBeenCalledWith({
            machineId: TARGET.machineId,
            serverId: TARGET.serverId,
            rootPath: TARGET.rootPath,
            agentRootPath: undefined,
            request: { path: 'notes/README.MD' },
        });

        // The stat above classified `.MD` from content, so count reads from here:
        // a foreign ref must still not reach a reader.
        const readsBeforeForeignRef = workspaceReadFileMock.mock.calls.length;
        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: { kind: 'workspaceFile', handle: 'workspaceFile_someone-else' },
            expectedRevision: 'workspace-file:5:100',
        }))).resolves.toEqual({ status: 'unsupported' });
        expect(workspaceReadFileMock).toHaveBeenCalledTimes(readsBeforeForeignRef);

        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: 'workspace-file:5:100',
            maxBytes: 5,
        }))).resolves.toEqual({
            status: 'ready',
            content: { kind: 'utf8', text: 'hello' },
            revision: 'workspace-file:5:100',
        });
        expect(workspaceReadFileMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: TARGET.machineId,
            serverId: TARGET.serverId,
            rootPath: TARGET.rootPath,
            path: 'notes/README.MD',
            maxBytes: 5,
        }));
    });

    it('preserves whitespace in the exact selected workspace path', async () => {
        const filePath = ' notes/README.md';
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath,
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });

        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref }))).resolves.toMatchObject({
            status: 'ready',
            revision: 'workspace-file:5:100',
        });
        expect(workspaceStatFileMock).toHaveBeenCalledWith(expect.objectContaining({
            request: { path: filePath },
        }));

        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: 'workspace-file:5:100',
            maxBytes: 5,
        }))).resolves.toMatchObject({ status: 'ready' });
        expect(workspaceReadFileMock).toHaveBeenCalledWith(expect.objectContaining({ path: filePath }));
    });

    it('does not disclose a read that is too large or changed while the host reads it', async () => {
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/README.md',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });

        workspaceStatFileMock.mockResolvedValueOnce({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 6,
            modifiedMs: 100,
        });
        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: 'workspace-file:6:100',
            maxBytes: 5,
        }))).resolves.toEqual({ status: 'tooLarge', sizeBytes: 6 });
        expect(workspaceReadFileMock).not.toHaveBeenCalled();

        workspaceStatFileMock.mockResolvedValueOnce({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 100,
        }).mockResolvedValueOnce({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 101,
        });
        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: 'workspace-file:5:100',
            maxBytes: 5,
        }))).resolves.toEqual({ status: 'changed' });
    });

    it('detects a same-sized edit when high-precision mtime changes within one millisecond', async () => {
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/README.md',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });
        workspaceStatFileMock
            .mockResolvedValueOnce({
                success: true,
                exists: true,
                kind: 'file',
                sizeBytes: 5,
                modifiedMs: 100.125,
            })
            .mockResolvedValueOnce({
                success: true,
                exists: true,
                kind: 'file',
                sizeBytes: 5,
                modifiedMs: 100.125,
            })
            .mockResolvedValueOnce({
                success: true,
                exists: true,
                kind: 'file',
                sizeBytes: 5,
                modifiedMs: 100.875,
            });

        const parsedInitial = OpenableContentStatResultV1Schema.safeParse(
            await handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref })),
        );
        if (!parsedInitial.success || parsedInitial.data.status !== 'ready') {
            throw new Error('expected the initial workspace stat to be ready');
        }
        const initial = parsedInitial.data;

        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: initial.revision,
            maxBytes: 5,
        }))).resolves.toEqual({ status: 'changed' });
    });

    it('keeps filesystem failures typed unavailable', async () => {
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/README.md',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });
        workspaceStatFileMock.mockResolvedValueOnce({
            success: false,
            error: 'workspace stat unavailable',
        });

        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref })))
            .resolves.toEqual({ status: 'unavailable' });
    });

    it('uses the caller ceiling above the private inline default and keeps a lower caller ceiling typed', async () => {
        const sizeBytes = 300 * 1024;
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/preview.png',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });
        const stat = {
            success: true as const,
            exists: true,
            kind: 'file' as const,
            sizeBytes,
            modifiedMs: 100,
        };
        workspaceStatFileMock.mockResolvedValue(stat);

        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: `workspace-file:${sizeBytes}:100`,
            maxBytes: 256 * 1024,
        }))).resolves.toEqual({ status: 'tooLarge', sizeBytes });
        expect(workspaceReadFileMock).not.toHaveBeenCalled();

        const contentBase64 = 'AAAA'.repeat(sizeBytes / 3);
        workspaceReadFileMock.mockResolvedValue({ ok: true, contentBase64 });
        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: `workspace-file:${sizeBytes}:100`,
            maxBytes: sizeBytes,
        }))).resolves.toMatchObject({
            status: 'ready',
            revision: `workspace-file:${sizeBytes}:100`,
            content: { kind: 'base64', base64: contentBase64 },
        });
        expect(workspaceReadFileMock).toHaveBeenCalledWith(expect.objectContaining({
            path: 'notes/preview.png',
            maxBytes: sizeBytes,
        }));
    });

    it('settles a cancelled stat without waiting for a stale workspace response', async () => {
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/README.md',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });
        workspaceStatFileMock.mockImplementationOnce(() => new Promise(() => {}));
        const controller = new AbortController();

        const pending = handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref }), {
            signal: controller.signal,
        });
        controller.abort();

        await expect(pending).resolves.toEqual({ status: 'cancelled' });
    });

    it('forwards an openable stat cancellation into the guarded workspace RPC', async () => {
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/README.md',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });
        const controller = new AbortController();

        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref }), {
            signal: controller.signal,
        })).resolves.toMatchObject({ status: 'ready' });

        expect(workspaceStatFileMock).toHaveBeenCalledWith(expect.objectContaining({
            signal: controller.signal,
        }));
    });

    it('classifies an unknown-extension file from its content, not its filename', async () => {
        // [0x00, 0x01, 0x02, 0xff, 0xfe] -> not decodable as UTF-8.
        workspaceReadFileMock.mockResolvedValue({ ok: true, contentBase64: 'AAEC//4=' });
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'artifacts/model.qtz',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });

        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref }))).resolves.toEqual({
            status: 'ready',
            contentClass: 'binary',
            mimeType: 'application/octet-stream',
            extension: '.qtz',
            sizeBytes: 5,
            revision: 'workspace-file:5:100',
        });

        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: 'workspace-file:5:100',
            maxBytes: 5,
        }))).resolves.toEqual({
            status: 'ready',
            content: { kind: 'base64', base64: 'AAEC//4=' },
            revision: 'workspace-file:5:100',
        });
    });

    it('keeps an unknown-extension UTF-8 file text and probes each revision once', async () => {
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'artifacts/notes.qtz',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });

        const ready = {
            status: 'ready',
            contentClass: 'text',
            mimeType: 'text/plain',
            extension: '.qtz',
            sizeBytes: 5,
            revision: 'workspace-file:5:100',
        };
        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref }))).resolves.toEqual(ready);
        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref }))).resolves.toEqual(ready);
        expect(workspaceReadFileMock).toHaveBeenCalledTimes(1);

        // A new host revision is not described by the previous revision's bytes.
        workspaceStatFileMock.mockResolvedValue({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 101,
        });
        workspaceReadFileMock.mockResolvedValue({ ok: true, contentBase64: 'AAEC//4=' });
        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref }))).resolves.toMatchObject({
            contentClass: 'binary',
            revision: 'workspace-file:5:101',
        });
        expect(workspaceReadFileMock).toHaveBeenCalledTimes(2);
    });

    it('keeps filename-decided classes ready and refuses undecidable content above the probe ceiling', async () => {
        const imageBinding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/preview.png',
        });
        await expect(createPluginSurfaceOpenableContentHandlers({ binding: imageBinding })
            .statOpenableContent!(request('statOpenableContent', { ref: imageBinding.ref })))
            .resolves.toMatchObject({ contentClass: 'image', mimeType: 'image/png' });

        const archiveBinding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/bundle.zip',
        });
        await expect(createPluginSurfaceOpenableContentHandlers({ binding: archiveBinding })
            .statOpenableContent!(request('statOpenableContent', { ref: archiveBinding.ref })))
            .resolves.toMatchObject({ contentClass: 'binary' });

        const sizeBytes = 300 * 1024;
        workspaceStatFileMock.mockResolvedValue({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes,
            modifiedMs: 100,
        });
        const largeUnknownBinding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'artifacts/large.qtz',
        });
        await expect(createPluginSurfaceOpenableContentHandlers({ binding: largeUnknownBinding })
            .statOpenableContent!(request('statOpenableContent', { ref: largeUnknownBinding.ref })))
            .resolves.toEqual({ status: 'unsupported' });

        // A familiar text extension is still undecided by path: the filename
        // cannot prove that the bytes are UTF-8, and this file is too large for
        // the bounded classifier to inspect.
        const largeTextNamedBinding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/large.md',
        });
        await expect(createPluginSurfaceOpenableContentHandlers({ binding: largeTextNamedBinding })
            .statOpenableContent!(request('statOpenableContent', { ref: largeTextNamedBinding.ref })))
            .resolves.toEqual({ status: 'unsupported' });

        expect(workspaceReadFileMock).not.toHaveBeenCalled();
    });

    it('does not disclose a completed stat after its selected mount retires', async () => {
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/README.md',
        });
        let current = true;
        let resolveStat: ((value: unknown) => void) | undefined;
        workspaceStatFileMock.mockImplementationOnce(() => new Promise((resolve) => {
            resolveStat = resolve;
        }));
        const handlers = createPluginSurfaceOpenableContentHandlers({
            binding,
            isCurrent: () => current,
        });

        const pending = handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref }));
        current = false;
        resolveStat?.({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 100,
        });

        await expect(pending).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
    });
});
