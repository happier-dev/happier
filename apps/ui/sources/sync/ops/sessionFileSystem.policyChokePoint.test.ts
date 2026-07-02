import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const callGuardedMachineRpcWithPolicyMock = vi.fn();

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (params: unknown) => callGuardedMachineRpcWithPolicyMock(params),
}));

describe('workspaceFileSystem policy choke point', () => {
    it('workspaceRenamePath routes through the guarded machine RPC boundary', async () => {
        const { workspaceRenamePath } = await import('./workspaceFileSystem');
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({ success: true });

        await expect(
            workspaceRenamePath(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                { from: 'README.md', to: 'README2.md' },
            ),
        ).resolves.toEqual({ success: true });

        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            method: RPC_METHODS.RENAME_PATH,
            payload: {
                from: '~/repo/README.md',
                to: '~/repo/README2.md',
                overwrite: undefined,
            },
        });
    });

    it('workspaceDeletePath routes through the guarded machine RPC boundary', async () => {
        const { workspaceDeletePath } = await import('./workspaceFileSystem');
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({ success: true });

        await expect(
            workspaceDeletePath(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                { path: 'tmp/a.txt', recursive: true },
            ),
        ).resolves.toEqual({ success: true });

        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            method: RPC_METHODS.DELETE_PATH,
            payload: {
                path: '~/repo/tmp/a.txt',
                recursive: true,
            },
        });
    });

    it('workspaceGetDirectoryTree routes through the guarded machine RPC boundary', async () => {
        const { workspaceGetDirectoryTree } = await import('./workspaceFileSystem');
        const response = { success: true, tree: { name: 'repo', path: '~/repo', type: 'directory' } };
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce(response);

        await expect(
            workspaceGetDirectoryTree(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                'src',
                3,
            ),
        ).resolves.toEqual(response);

        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            method: RPC_METHODS.GET_DIRECTORY_TREE,
            payload: {
                path: '~/repo/src',
                maxDepth: 3,
            },
        });
    });
});
