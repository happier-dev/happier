import { beforeEach, describe, expect, it, vi } from 'vitest';

const downloadDaemonWorkspaceFileToBase64Spy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceWriteFileRpc: vi.fn(),
    downloadDaemonWorkspaceFileToBase64: (...args: unknown[]) => downloadDaemonWorkspaceFileToBase64Spy(...args),
    uploadDaemonWorkspaceFileFromReader: vi.fn(),
}));

describe('workspaceReadFile', () => {
    beforeEach(() => {
        downloadDaemonWorkspaceFileToBase64Spy.mockReset();
        downloadDaemonWorkspaceFileToBase64Spy.mockResolvedValue({
            ok: true,
            contentBase64: 'YWJj',
        });
    });

    it('forwards an explicit maxBytes bound to the daemon download helper', async () => {
        const { workspaceReadFile } = await import('./fileReadWrite');

        const result = await workspaceReadFile({
            machineId: 'machine-1',
            rootPath: '/repo',
            serverId: 'server-1',
        }, 'image.png', { maxBytes: 42 });

        expect(result).toEqual({
            success: true,
            content: 'YWJj',
        });
        expect(downloadDaemonWorkspaceFileToBase64Spy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            rootPath: '/repo',
            path: 'image.png',
            maxBytes: 42,
        });
    });

    it('uses the inline maxBytes limit when no explicit bound is provided', async () => {
        const { workspaceReadFile } = await import('./fileReadWrite');

        const result = await workspaceReadFile({
            machineId: 'machine-1',
            rootPath: '/repo',
            serverId: 'server-1',
        }, 'image.png');

        expect(result).toEqual({
            success: true,
            content: 'YWJj',
        });
        expect(downloadDaemonWorkspaceFileToBase64Spy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            rootPath: '/repo',
            path: 'image.png',
            maxBytes: 256 * 1024,
        });
    });
});
