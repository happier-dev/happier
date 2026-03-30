import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machineFileBrowser ops', () => {
    it('routes root listing through server-scoped machine RPC', async () => {
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            roots: [{ id: '/', label: '/', path: '/' }],
        });

        const { machineFilesystemListRoots } = await import('./machineFileBrowser');
        const result = await machineFilesystemListRoots('machine-1', { serverId: 'server-1' });

        expect(result).toEqual({
            ok: true,
            roots: [{ id: '/', label: '/', path: '/' }],
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: 'daemon.filesystem.listRoots',
            payload: undefined,
        }));
    });

    it('routes directory listing through server-scoped machine RPC and validates the payload', async () => {
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            path: '/Users/leeroy',
            entries: [{ name: 'Documents', path: '/Users/leeroy/Documents', type: 'directory' }],
            truncated: false,
        });

        const { machineFilesystemListDirectory } = await import('./machineFileBrowser');
        const result = await machineFilesystemListDirectory('machine-1', {
            path: '/Users/leeroy',
            includeFiles: false,
        }, { serverId: 'server-1' });

        expect(result.ok).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: 'daemon.filesystem.listDirectory',
            payload: {
                path: '/Users/leeroy',
                includeFiles: false,
            },
        }));
    });

    it('returns an error result when root listing RPC is unavailable', async () => {
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            createRpcCallError({
                error: 'RPC method not available',
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { machineFilesystemListRoots } = await import('./machineFileBrowser');
        await expect(machineFilesystemListRoots('machine-1', { serverId: 'server-1' })).resolves.toEqual({
            ok: false,
            error: 'RPC method not available',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

    it('returns an error result when directory listing RPC is unavailable', async () => {
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            createRpcCallError({
                error: 'RPC method not available',
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { machineFilesystemListDirectory } = await import('./machineFileBrowser');
        await expect(machineFilesystemListDirectory('machine-1', {
            path: '/Users/leeroy',
            includeFiles: false,
        }, { serverId: 'server-1' })).resolves.toEqual({
            ok: false,
            error: 'RPC method not available',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });
});
