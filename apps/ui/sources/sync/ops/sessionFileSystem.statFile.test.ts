import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { workspaceStatFile } from './workspaceFileSystem';
import * as fileReadWrite from './workspaceFileSystem/fileReadWrite';
import * as pathMetadataMutations from './workspaceFileSystem/pathMetadataMutations';

const io = vi.hoisted(() => vi.fn());
// Only Socket.IO, HTTP and credential persistence are replaced. The filesystem
// barrel, transfer owner, path normalization and guarded RPC route remain real.
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => io(...args) }));

describe('workspaceStatFile', () => {
    let boundary: ReturnType<typeof createSocketIoBoundaryStub>;
    let serverId: string;

    beforeEach(async () => {
        serverId = (await upsertServerProfile({ serverUrl: 'https://workspace-stat.test', name: 'Stat Home' })).id;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('account-stat') });
        boundary = createSocketIoBoundaryStub();
        io.mockReturnValue(boundary.socket);
        setRuntimeFetch(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/v1/machines/m1') return Response.json({ machine: { id: 'm1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
            throw new Error(`Unexpected stat HTTP request: ${path}`);
        });
    });

    afterEach(async () => {
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        resetServerFeaturesClientForTests();
        resetRuntimeFetch();
        io.mockReset();
        vi.restoreAllMocks();
    });

    it('keeps the barrel stat binding in the file read owner and removes the metadata-path export', () => {
        expect(workspaceStatFile).toBe(fileReadWrite.workspaceStatFile);
        expect(pathMetadataMutations).not.toHaveProperty('workspaceStatFile');
    });

    it('exports one file-details stat owner through the workspace filesystem barrel', async () => {
        boundary.socket.emitWithAck.mockResolvedValueOnce({ ok: true, result: { success: true, exists: false } });
        await expect(workspaceStatFile(
            { machineId: 'm1', rootPath: '~/repo', serverId }, 'src/a.ts',
        )).resolves.toEqual({ success: true, exists: false });
        expect(boundary.socket.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL,
            expect.objectContaining({ method: `m1:${RPC_METHODS.STAT_FILE}`, params: { path: '~/repo/src/a.ts' } }));
        expect(io).toHaveBeenCalledWith('https://workspace-stat.test', expect.anything());
    });

    it('preserves the transfer stat failure contract through the public barrel', async () => {
        const failure = { success: false, error: 'stat unavailable', errorCode: 'METHOD_NOT_AVAILABLE' };
        boundary.socket.emitWithAck.mockResolvedValueOnce({ ok: true, result: failure });
        await expect(workspaceStatFile(
            { machineId: 'm1', rootPath: '~/repo', serverId }, 'src/a.ts',
        )).resolves.toEqual(failure);
    });
});
