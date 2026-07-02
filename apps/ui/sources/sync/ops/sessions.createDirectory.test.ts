import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const callGuardedMachineRpcWithPolicyMock = vi.fn();

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (params: unknown) => callGuardedMachineRpcWithPolicyMock(params),
}));

describe('workspaceCreateDirectory', () => {
    it('calls guarded machine RPC with the resolved absolute path', async () => {
        const { workspaceCreateDirectory } = await import('./workspaceFileSystem');
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({ success: true });

        await expect(
            workspaceCreateDirectory(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                'tmp/new-folder',
            ),
        ).resolves.toEqual({ success: true });

        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            method: RPC_METHODS.CREATE_DIRECTORY,
            payload: { path: '~/repo/tmp/new-folder' },
        });
    });

    it('returns a stable errorCode when the RPC method is not found', async () => {
        const { workspaceCreateDirectory } = await import('./workspaceFileSystem');
        const error = new Error('Method not found') as Error & { rpcErrorCode: string };
        error.rpcErrorCode = RPC_ERROR_CODES.METHOD_NOT_FOUND;
        callGuardedMachineRpcWithPolicyMock.mockRejectedValueOnce(error);

        await expect(
            workspaceCreateDirectory(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                'tmp/new-folder',
            ),
        ).resolves.toMatchObject({
            success: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });
    });

    it('returns a stable failure response when the RPC returns an unsupported shape', async () => {
        const { workspaceCreateDirectory } = await import('./workspaceFileSystem');
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce(null);

        const result = await workspaceCreateDirectory(
            { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
            'tmp/new-folder',
        );
        expect(result.success).toBe(false);
        if (result.success) {
            throw new Error('Expected workspaceCreateDirectory to fail');
        }
        expect(result.errorCode).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(typeof result.error).toBe('string');
    });
});
