import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.fn();

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (args: unknown) => machineRpcWithServerScopeMock(args),
}));

describe('machineWorkspaceFileList', () => {
    beforeEach(() => machineRpcWithServerScopeMock.mockReset());

    it('sends only a typed exact-workspace request and forwards cancellation', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({ ok: true, paths: ['src/a.ts'], truncated: false });
        const controller = new AbortController();
        const { machineWorkspaceFileList } = await import('./machineWorkspaceFileList');

        await expect(machineWorkspaceFileList('m1', {
            rootPath: '/repo',
            query: 'a',
            limit: 50,
        }, { serverId: 'server-a', accountId: 'selected-account', signal: controller.signal })).resolves.toEqual({
            ok: true,
            paths: ['src/a.ts'],
            truncated: false,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'm1',
            method: 'daemon.workspaceFiles.list.v1',
            payload: { rootPath: '/repo', query: 'a', limit: 50 },
            serverId: 'server-a',
            accountId: 'selected-account',
            timeoutMs: undefined,
            signal: controller.signal,
        });
    });

    it('distinguishes a successful empty result from an unavailable old daemon', async () => {
        const { machineWorkspaceFileList } = await import('./machineWorkspaceFileList');
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, paths: [], truncated: false });
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo' })).resolves.toEqual({
            ok: true,
            paths: [],
            truncated: false,
        });

        machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('method missing'));
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo' })).resolves.toEqual({
            ok: false,
            errorCode: 'method_unavailable',
        });
    });
});
