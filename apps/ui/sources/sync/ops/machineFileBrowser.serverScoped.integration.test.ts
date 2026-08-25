import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';

const getReadyServerFeaturesMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (params: unknown) => getReadyServerFeaturesMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machineFileBrowser ops', () => {
    it('routes root listing through server-scoped machine RPC', async () => {
        getReadyServerFeaturesMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        getReadyServerFeaturesMock.mockResolvedValueOnce({
            features: { machines: { transfer: { enabled: true } } },
            capabilities: {},
        });
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
        getReadyServerFeaturesMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        getReadyServerFeaturesMock.mockResolvedValueOnce({
            features: { machines: { transfer: { enabled: true } } },
            capabilities: {},
        });
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

    it('fails closed and forces scoped route when server features are unavailable', async () => {
        getReadyServerFeaturesMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        getReadyServerFeaturesMock.mockResolvedValueOnce(null);
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            roots: [{ id: '/', label: '/', path: '/' }],
        });

        const { machineFilesystemListRoots } = await import('./machineFileBrowser');
        const result = await machineFilesystemListRoots('machine-1', { serverId: 'server-1' });

        expect(result.ok).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: 'daemon.filesystem.listRoots',
            payload: undefined,
            skipTransferPolicyEvaluation: false,
        }));
    });

    it('returns an error result when root listing RPC is unavailable', async () => {
        getReadyServerFeaturesMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        getReadyServerFeaturesMock.mockResolvedValueOnce({
            features: { machines: { transfer: { enabled: true } } },
            capabilities: {},
        });
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
        getReadyServerFeaturesMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        getReadyServerFeaturesMock.mockResolvedValueOnce({
            features: { machines: { transfer: { enabled: true } } },
            capabilities: {},
        });
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
    it('never surfaces an internal exception message when the machine RPC throws', async () => {
        // `F-UI-2`: the folder picker renders this `error` string verbatim
        // (`FilesystemBrowser.tsx:70`), and the adapter passed `error.message` straight through — so
        // an internal transport exception was displayed to the user. The local-services inventory
        // adapter, one pane over, turns the very same throw into a typed reason and never lets the
        // message out (`sync/domains/local/services/inventory/machineRpc.ts:50-52`).
        for (const thrown of [
            new TypeError("Cannot read properties of undefined (reading 'emit')"),
            new Error('Socket not connected'),
            'not even an error',
        ]) {
            getReadyServerFeaturesMock.mockReset();
            machineRpcWithServerScopeMock.mockReset();
            getReadyServerFeaturesMock.mockResolvedValue({
                features: { machines: { transfer: { enabled: true } } },
                capabilities: {},
            });
            machineRpcWithServerScopeMock.mockRejectedValue(thrown);

            const { machineFilesystemListRoots, machineFilesystemListDirectory } = await import('./machineFileBrowser');

            await expect(machineFilesystemListRoots('machine-1', { serverId: 'server-1' })).resolves.toEqual({
                ok: false,
                error: 'RPC method not available',
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            });
            await expect(machineFilesystemListDirectory('machine-1', {
                path: '/Users/leeroy',
                includeFiles: false,
            }, { serverId: 'server-1' })).resolves.toEqual({
                ok: false,
                error: 'RPC method not available',
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            });
        }
    });
});
