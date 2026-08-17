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

        await expect(handlers.readOpenableContent!(request('readOpenableContent', {
            ref: { kind: 'workspaceFile', handle: 'workspaceFile_someone-else' },
            expectedRevision: 'workspace-file:5:100',
        }))).resolves.toEqual({ status: 'unsupported' });
        expect(workspaceReadFileMock).not.toHaveBeenCalled();

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
