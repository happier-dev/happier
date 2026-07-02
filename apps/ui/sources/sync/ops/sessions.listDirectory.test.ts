import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const callGuardedMachineRpcWithPolicyMock = vi.fn();

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (params: unknown) => callGuardedMachineRpcWithPolicyMock(params),
}));

describe('workspaceListDirectory', () => {
    it('resolves relative paths against the workspace root', async () => {
        const { workspaceListDirectory } = await import('./workspaceFileSystem');
        const response = { success: true, entries: [{ name: 'a.ts', type: 'file' as const }] };
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce(response);

        await expect(
            workspaceListDirectory(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                'src',
            ),
        ).resolves.toEqual(response);

        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            method: RPC_METHODS.LIST_DIRECTORY,
            payload: { path: '~/repo/src' },
        });
    });

    it('returns rpc error codes from thrown guarded RPC errors', async () => {
        const { workspaceListDirectory } = await import('./workspaceFileSystem');
        const error = new Error('Method not found') as Error & { rpcErrorCode: string };
        error.rpcErrorCode = RPC_ERROR_CODES.METHOD_NOT_FOUND;
        callGuardedMachineRpcWithPolicyMock.mockRejectedValueOnce(error);

        await expect(
            workspaceListDirectory(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                'src',
            ),
        ).resolves.toMatchObject({
            success: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });
    });

    it('returns METHOD_NOT_AVAILABLE for unsupported response shapes', async () => {
        const { workspaceListDirectory } = await import('./workspaceFileSystem');
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce(null);

        const result = await workspaceListDirectory(
            { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
            'src',
        );
        expect(result.success).toBe(false);
        if (result.success) {
            throw new Error('Expected workspaceListDirectory to fail');
        }
        expect(result.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(typeof result.error).toBe('string');
    });
});
