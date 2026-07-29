import { beforeEach, describe, expect, it, vi } from 'vitest';

const downloadDaemonWorkspaceFileToBase64Spy = vi.hoisted(() => vi.fn());
const uploadDaemonWorkspaceFileFromReaderSpy = vi.hoisted(() => vi.fn());
const runTransferFinalizeRecoveryMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceWriteFileRpc: vi.fn(),
    downloadDaemonWorkspaceFileToBase64: (...args: unknown[]) => downloadDaemonWorkspaceFileToBase64Spy(...args),
    uploadDaemonWorkspaceFileFromReader: (...args: unknown[]) => uploadDaemonWorkspaceFileFromReaderSpy(...args),
}));

vi.mock('@/components/transfers/recovery/runTransferFinalizeRecovery', () => ({
    runTransferFinalizeRecovery: (...args: unknown[]) => runTransferFinalizeRecoveryMock(...args),
}));

describe('workspaceReadFile', () => {
    beforeEach(() => {
        downloadDaemonWorkspaceFileToBase64Spy.mockReset();
        uploadDaemonWorkspaceFileFromReaderSpy.mockReset();
        runTransferFinalizeRecoveryMock.mockReset();
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

    it('finalizes a retained large write without starting a second upload', async () => {
        const recovery = {
            kind: 'transfer_finalize_recovery' as const,
            expiresAt: Date.now() + 60_000,
            actions: ['retry_finalize', 'discard_staged'] as const,
            invoke: vi.fn(),
        };
        uploadDaemonWorkspaceFileFromReaderSpy.mockResolvedValueOnce({
            success: false,
            error: 'Finalize recovery is required',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery,
        });
        runTransferFinalizeRecoveryMock.mockResolvedValueOnce({
            status: 'finalized',
            response: {
                success: true,
                path: '/repo/large.txt',
                sizeBytes: 256 * 1024 + 1,
                sha256: 'sha256',
            },
        });
        const { workspaceWriteFile } = await import('./fileReadWrite');

        const result = await workspaceWriteFile(
            { machineId: 'machine-1', rootPath: '/repo', serverId: 'server-1' },
            'large.txt',
            'x'.repeat(256 * 1024 + 1),
        );

        expect(result).toEqual({ success: true, hash: 'sha256' });
        expect(uploadDaemonWorkspaceFileFromReaderSpy).toHaveBeenCalledTimes(1);
        expect(runTransferFinalizeRecoveryMock).toHaveBeenCalledWith(expect.objectContaining({ recovery }));
    });
});
