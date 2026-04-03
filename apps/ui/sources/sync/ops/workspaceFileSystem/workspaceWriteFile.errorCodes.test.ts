import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const callDaemonWorkspaceWriteFileRpcSpy = vi.fn();

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline', () => ({
    callDaemonWorkspaceWriteFileRpc: (...args: unknown[]) => callDaemonWorkspaceWriteFileRpcSpy(...args),
}));

describe('workspaceWriteFile (workspaceFileSystem)', () => {
    it('preserves METHOD_NOT_FOUND so callers can treat it as unsupported', async () => {
        const { workspaceWriteFile } = await import('./fileReadWrite');

        callDaemonWorkspaceWriteFileRpcSpy.mockResolvedValueOnce({
            success: false,
            error: 'Method not found',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });

        const res = await workspaceWriteFile(
            { machineId: 'm1', rootPath: '/repo', serverId: 'server-1' },
            'src/a.ts',
            'hello',
        );

        expect(res).toEqual({
            success: false,
            error: 'Method not found',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });
    });
});
