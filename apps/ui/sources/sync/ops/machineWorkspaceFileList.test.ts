import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const outgoing: SocketRpcRequestPayload[] = [];
let respond: (payload: SocketRpcRequestPayload) => Promise<unknown>;
installDisconnectedServerSocketBoundary((socket) => {
    socket.connected = true;
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (_event: string, payload: SocketRpcRequestPayload) => {
        outgoing.push(payload);
        return await respond(payload);
    });
});
let serverId: string;

describe('machineWorkspaceFileList', () => {
    beforeEach(async () => {
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Workspace', serverUrl: 'https://workspace-files.test', accountId: 'account-a' });
        homes.answer(serverId, '/v1/machines/m1', { body: { machine: {
            id: 'm1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } } });
        outgoing.length = 0;
        respond = async () => ({ ok: true, result: { ok: true, paths: ['src/a.ts'], truncated: false } });
    });
    afterEach(async () => {
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        await homes.reset();
        vi.restoreAllMocks();
    });

    it('sends only a typed exact-workspace request and forwards cancellation', async () => {
        const controller = new AbortController();
        const { machineWorkspaceFileList } = await import('./machineWorkspaceFileList');
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo', query: 'a', limit: 50 }, {
            serverId, accountId: 'account-a', signal: controller.signal,
        })).resolves.toEqual({ ok: true, paths: ['src/a.ts'], truncated: false });
        expect(outgoing).toMatchObject([{
            method: 'm1:daemon.workspaceFiles.list.v1', params: { rootPath: '/repo', query: 'a', limit: 50 },
        }]);
        expect(homes.requestsFor('/v1/machines/m1')[0]?.serverId).toBe(serverId);

        // Abort while the genuine network acknowledgement is outstanding. The
        // same scoped RPC owner must surface cancellation rather than an empty
        // successful inventory or the old-daemon unavailability projection.
        let release: (() => void) | undefined;
        respond = async () => await new Promise((resolve) => { release = () => resolve({ ok: true, result: { ok: true, paths: [], truncated: false } }); });
        const pending = machineWorkspaceFileList('m1', { rootPath: '/repo' }, { serverId, accountId: 'account-a', signal: controller.signal });
        await vi.waitFor(() => expect(outgoing).toHaveLength(2));
        const rejected = expect(pending).rejects.toBeInstanceOf(Error);
        controller.abort();
        await rejected;
        release?.();
    });

    it('distinguishes a successful empty result from an unavailable old daemon', async () => {
        const { machineWorkspaceFileList } = await import('./machineWorkspaceFileList');
        respond = async () => ({ ok: true, result: { ok: true, paths: [], truncated: false } });
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo' }, { serverId, accountId: 'account-a' }))
            .resolves.toEqual({ ok: true, paths: [], truncated: false });
        respond = async () => ({ ok: false, errorCode: 'METHOD_NOT_AVAILABLE', error: 'method unavailable' });
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo' }, { serverId, accountId: 'account-a' }))
            .resolves.toEqual({ ok: false, errorCode: 'method_unavailable' });
    });
});
