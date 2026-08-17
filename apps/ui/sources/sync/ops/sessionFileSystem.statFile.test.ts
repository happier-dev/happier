import { describe, expect, it, vi } from 'vitest';

const callDaemonWorkspaceStatFileRpcMock = vi.fn();

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceStatFileRpc: (params: unknown) => callDaemonWorkspaceStatFileRpcMock(params),
}));

describe('workspaceStatFile', () => {
    it('keeps the barrel stat binding in the file read owner and removes the metadata-path export', async () => {
        const [barrel, fileReadWrite, pathMetadataMutations] = await Promise.all([
            import('./workspaceFileSystem'),
            import('./workspaceFileSystem/fileReadWrite'),
            import('./workspaceFileSystem/pathMetadataMutations'),
        ]);

        expect(barrel.workspaceStatFile).toBe(fileReadWrite.workspaceStatFile);
        expect(pathMetadataMutations).not.toHaveProperty('workspaceStatFile');
    });

    it('exports one file-details stat owner through the workspace filesystem barrel', async () => {
        const { workspaceStatFile } = await import('./workspaceFileSystem');
        callDaemonWorkspaceStatFileRpcMock.mockResolvedValueOnce({ success: true, exists: false });

        await expect(
            workspaceStatFile(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                'src/a.ts',
            ),
        ).resolves.toEqual({ success: true, exists: false });

        expect(callDaemonWorkspaceStatFileRpcMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            rootPath: '~/repo',
            agentRootPath: undefined,
            request: { path: 'src/a.ts' },
        });
    });

    it('preserves the transfer stat failure contract through the public barrel', async () => {
        const { workspaceStatFile } = await import('./workspaceFileSystem');
        callDaemonWorkspaceStatFileRpcMock.mockResolvedValueOnce({
            success: false,
            error: 'stat unavailable',
            errorCode: 'METHOD_NOT_AVAILABLE',
        });

        await expect(workspaceStatFile(
            { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
            'src/a.ts',
        )).resolves.toEqual({
            success: false,
            error: 'stat unavailable',
            errorCode: 'METHOD_NOT_AVAILABLE',
        });
    });
});
