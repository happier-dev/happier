import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const callGuardedMachineRpcWithPolicyMock = vi.fn();

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (params: unknown) => callGuardedMachineRpcWithPolicyMock(params),
}));

describe('workspaceStatFile', () => {
    it('resolves relative paths against the workspace root and uses guarded machine RPC', async () => {
        const { workspaceStatFile } = await import('./workspaceFileSystem');
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce({ success: true, exists: false });

        await expect(
            workspaceStatFile(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                'src/a.ts',
            ),
        ).resolves.toEqual({ success: true, exists: false });

        expect(callGuardedMachineRpcWithPolicyMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server-1',
            method: RPC_METHODS.STAT_FILE,
            payload: { path: '~/repo/src/a.ts' },
        });
    });

    it('returns a stable failure response for unsupported RPC shapes', async () => {
        const { workspaceStatFile } = await import('./workspaceFileSystem');
        callGuardedMachineRpcWithPolicyMock.mockResolvedValueOnce(null);

        const result = await workspaceStatFile(
            { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
            'src/a.ts',
        );
        expect(result.success).toBe(false);
        if (result.success) {
            throw new Error('Expected workspaceStatFile to fail');
        }
        expect(typeof result.error).toBe('string');
    });

    it('returns METHOD_NOT_AVAILABLE when guarded RPC throws without explicit code', async () => {
        const { workspaceStatFile } = await import('./workspaceFileSystem');
        callGuardedMachineRpcWithPolicyMock.mockRejectedValueOnce(new Error('boom'));

        await expect(
            workspaceStatFile(
                { machineId: 'm1', rootPath: '~/repo', serverId: 'server-1' },
                'src/a.ts',
            ),
        ).resolves.toMatchObject({ success: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    });
});
