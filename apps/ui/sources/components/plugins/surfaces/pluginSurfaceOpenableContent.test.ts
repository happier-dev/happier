import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenableContentStatResultV1Schema } from '@happier-dev/protocol';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

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
const HELLO_HASH = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const WORLD_HASH = '486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7';
const BINARY_HASH = 'aa5cd9acfab25f643fb1cedb67f8770417ac9ce0b02cfe72a62fa1ec20e9f60a';

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
            changedMs: 100,
            contentHash: HELLO_HASH,
        });
        workspaceReadFileMock.mockResolvedValue({ ok: true, contentBase64: 'aGVsbG8=' });
    });

    it('changes the revision for an equal-size edit that preserved the modification time', async () => {
        // The failure this pins: a tool that rewrites a file in place and restores
        // its mtime — and any filesystem whose mtime granularity is coarser than
        // the edit — produced byte-identical size and mtime for different bytes.
        // The viewer then compared revisions, saw no change, and presented stale
        // content as current. The daemon's opt-in SHA-256 names the actual
        // bytes, so restoring all filesystem timestamps cannot hide the edit.
        const before = {
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 100,
            changedMs: 100,
            contentHash: HELLO_HASH,
        } as const;
        const afterEqualSizeEdit = { ...before, changedMs: 240, contentHash: WORLD_HASH };

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

    it('refuses a timestamp-colliding byte replacement when the content digest changes', async () => {
        const before = {
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 100,
            changedMs: 100,
            contentHash: HELLO_HASH,
        } as const;
        const after = { ...before, contentHash: WORLD_HASH };
        workspaceStatFileMock.mockResolvedValueOnce(before).mockResolvedValue(after);

        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/README.md',
        });
        const initial = await binding.stat();
        expect(initial).toMatchObject({ status: 'ready', revision: `workspace-file:5:${HELLO_HASH}` });

        await expect(binding.read({
            ref: binding.ref,
            expectedRevision: initial.status === 'ready' ? initial.revision : '',
            maxBytes: 1024,
        })).resolves.toEqual({ status: 'changed' });
    });

    it('refuses bytes from an ABA read even when the before and after stats return the old revision', async () => {
        const sameRevision = {
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 100,
            changedMs: 100,
            contentHash: HELLO_HASH,
        } as const;
        workspaceStatFileMock.mockResolvedValue(sameRevision);
        workspaceReadFileMock.mockResolvedValue({ ok: true, contentBase64: 'd29ybGQ=' });
        const binding = createWorkspaceFileOpenableContentBinding({ target: TARGET, filePath: 'notes/README.md' });

        await expect(binding.read({
            ref: binding.ref,
            expectedRevision: `workspace-file:5:${HELLO_HASH}`,
            maxBytes: 1024,
        })).resolves.toEqual({ status: 'changed' });
    });

    it('does not memoize unknown-extension classification for probe bytes that disagree with the stat digest', async () => {
        workspaceReadFileMock.mockResolvedValue({ ok: true, contentBase64: 'd29ybGQ=' });
        const binding = createWorkspaceFileOpenableContentBinding({ target: TARGET, filePath: 'notes/README.qtz' });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });

        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref })))
            .resolves.toEqual({ status: 'unsupported' });
    });

    it('refuses a weak old-daemon stat instead of treating size and mtime as byte identity', async () => {
        workspaceStatFileMock.mockResolvedValueOnce({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 100,
        });
        const binding = createWorkspaceFileOpenableContentBinding({
            target: TARGET,
            filePath: 'notes/README.md',
        });
        const handlers = createPluginSurfaceOpenableContentHandlers({ binding });

        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref })))
            .resolves.toEqual({ status: 'unsupported' });
        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: 'workspace-file:5:100',
            maxBytes: 5,
        }))).resolves.toEqual({ status: 'unsupported' });
        expect(workspaceReadFileMock).not.toHaveBeenCalled();
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
            revision: `workspace-file:5:${HELLO_HASH}`,
        });
        expect(workspaceStatFileMock).toHaveBeenCalledWith({
            machineId: TARGET.machineId,
            serverId: TARGET.serverId,
            rootPath: TARGET.rootPath,
            agentRootPath: undefined,
            request: { path: 'notes/README.MD' },
            includeContentHash: true,
        });

        // The stat above classified `.MD` from content, so count reads from here:
        // a foreign ref must still not reach a reader.
        const readsBeforeForeignRef = workspaceReadFileMock.mock.calls.length;
        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: { kind: 'workspaceFile', handle: 'workspaceFile_someone-else' },
            expectedRevision: `workspace-file:5:${HELLO_HASH}`,
        }))).resolves.toEqual({ status: 'unsupported' });
        expect(workspaceReadFileMock).toHaveBeenCalledTimes(readsBeforeForeignRef);

        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: `workspace-file:5:${HELLO_HASH}`,
            maxBytes: 5,
        }))).resolves.toEqual({
            status: 'ready',
            content: { kind: 'utf8', text: 'hello' },
            revision: `workspace-file:5:${HELLO_HASH}`,
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
            revision: `workspace-file:5:${HELLO_HASH}`,
        });
        expect(workspaceStatFileMock).toHaveBeenCalledWith(expect.objectContaining({
            request: { path: filePath },
        }));

        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: `workspace-file:5:${HELLO_HASH}`,
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
            changedMs: 100,
            contentHash: HELLO_HASH,
        });
        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: `workspace-file:6:${HELLO_HASH}`,
            maxBytes: 5,
        }))).resolves.toEqual({ status: 'tooLarge', sizeBytes: 6 });
        expect(workspaceReadFileMock).not.toHaveBeenCalled();

        workspaceStatFileMock.mockResolvedValueOnce({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 100,
            changedMs: 100,
            contentHash: HELLO_HASH,
        }).mockResolvedValueOnce({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 101,
            changedMs: 101,
            contentHash: WORLD_HASH,
        });
        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: `workspace-file:5:${HELLO_HASH}`,
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
                changedMs: 100.125,
                contentHash: HELLO_HASH,
            })
            .mockResolvedValueOnce({
                success: true,
                exists: true,
                kind: 'file',
                sizeBytes: 5,
                modifiedMs: 100.125,
                changedMs: 100.125,
                contentHash: HELLO_HASH,
            })
            .mockResolvedValueOnce({
                success: true,
                exists: true,
                kind: 'file',
                sizeBytes: 5,
                modifiedMs: 100.875,
                changedMs: 100.875,
                contentHash: WORLD_HASH,
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
        const largeContentHash = bytesToHex(sha256(new Uint8Array(sizeBytes)));
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
            changedMs: 100,
            contentHash: largeContentHash,
        };
        workspaceStatFileMock.mockResolvedValue(stat);

        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: `workspace-file:${sizeBytes}:${largeContentHash}`,
            maxBytes: 256 * 1024,
        }))).resolves.toEqual({ status: 'tooLarge', sizeBytes });
        expect(workspaceReadFileMock).not.toHaveBeenCalled();

        const contentBase64 = 'AAAA'.repeat(sizeBytes / 3);
        workspaceReadFileMock.mockResolvedValue({ ok: true, contentBase64 });
        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: `workspace-file:${sizeBytes}:${largeContentHash}`,
            maxBytes: sizeBytes,
        }))).resolves.toMatchObject({
            status: 'ready',
            revision: `workspace-file:${sizeBytes}:${largeContentHash}`,
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
        workspaceStatFileMock.mockResolvedValue({
            success: true,
            exists: true,
            kind: 'file',
            sizeBytes: 5,
            modifiedMs: 100,
            changedMs: 100,
            contentHash: BINARY_HASH,
        });
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
            revision: `workspace-file:5:${BINARY_HASH}`,
        });

        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: binding.ref,
            expectedRevision: `workspace-file:5:${BINARY_HASH}`,
            maxBytes: 5,
        }))).resolves.toEqual({
            status: 'ready',
            content: { kind: 'base64', base64: 'AAEC//4=' },
            revision: `workspace-file:5:${BINARY_HASH}`,
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
            revision: `workspace-file:5:${HELLO_HASH}`,
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
            changedMs: 101,
            contentHash: BINARY_HASH,
        });
        workspaceReadFileMock.mockResolvedValue({ ok: true, contentBase64: 'AAEC//4=' });
        await expect(handlers.statOpenableContent!(request('statOpenableContent', { ref: binding.ref }))).resolves.toMatchObject({
            contentClass: 'binary',
            revision: `workspace-file:5:${BINARY_HASH}`,
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
            changedMs: 100,
            contentHash: HELLO_HASH,
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
            changedMs: 100,
            contentHash: HELLO_HASH,
        });

        await expect(pending).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
    });
});
