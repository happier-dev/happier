import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('workspaceFavicon ops', () => {
    beforeEach(async () => {
        machineRpcWithServerScopeMock.mockReset();
        const mod = await import('./workspaceFavicon');
        mod.clearWorkspaceFaviconCacheForTests();
    });

    it('resolves a workspace favicon over machine RPC and caches the data URI by workspace target', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            success: true,
            found: true,
            relativePath: 'public/favicon.svg',
            mimeType: 'image/svg+xml',
            contentBase64: 'PHN2Zy8+',
            sizeBytes: 6,
        });

        const { resolveWorkspaceFavicon } = await import('./workspaceFavicon');
        const first = await resolveWorkspaceFavicon({
            serverId: 'server-a',
            machineId: 'machine-a',
            workspacePath: '/repo',
            enabled: true,
        });
        const second = await resolveWorkspaceFavicon({
            serverId: 'server-a',
            machineId: 'machine-a',
            workspacePath: '/repo',
            enabled: true,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server-a',
            machineId: 'machine-a',
            method: RPC_METHODS.WORKSPACE_FAVICON_RESOLVE,
            payload: { workspacePath: '/repo' },
        }));
        expect(first).toEqual({
            status: 'found',
            uri: 'data:image/svg+xml;base64,PHN2Zy8+',
            relativePath: 'public/favicon.svg',
        });
        expect(second).toEqual(first);
    });

    it('caches missing favicons and skips RPC when disabled', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ success: true, found: false });

        const { resolveWorkspaceFavicon } = await import('./workspaceFavicon');
        await expect(resolveWorkspaceFavicon({
            serverId: 'server-a',
            machineId: 'machine-a',
            workspacePath: '/repo',
            enabled: true,
        })).resolves.toEqual({ status: 'missing' });
        await expect(resolveWorkspaceFavicon({
            serverId: 'server-a',
            machineId: 'machine-a',
            workspacePath: '/repo',
            enabled: true,
        })).resolves.toEqual({ status: 'missing' });
        await expect(resolveWorkspaceFavicon({
            serverId: 'server-a',
            machineId: 'machine-a',
            workspacePath: '/repo',
            enabled: false,
        })).resolves.toEqual({ status: 'disabled' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });
});
