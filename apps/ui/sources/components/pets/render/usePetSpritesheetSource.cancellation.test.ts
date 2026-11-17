import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { DaemonPetReadPreviewAssetRequestV1Schema } from '@happier-dev/protocol/pets/daemonRpc';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';
import { usePetSpritesheetSourceResult } from './usePetSpritesheetSource';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

const credentials = vi.hoisted(() => ({ token: '' }));
// Only credential persistence is substituted; the hook, RPC owner, codec and sockets stay real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return createTokenStorageModuleMock({ importOriginal,
        subscribeHomeCredentialMutations: actual.subscribeHomeCredentialMutations,
        tokenStorage: { getCredentialsForServerUrl: async () => ({ token: credentials.token }) } });
});

afterEach(async () => {
    standardCleanup();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
});

it('shares cold previews across faces and equal sources, cancels only the last borrower, and permits retry', async () => {
    const http = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/machines/read-batch' && request.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            response.end(await createMachineReadBatchResponseFixture(Buffer.concat(chunks).toString('utf8'),
                id => id === 'pet-machine' || id === 'pet-machine-other' ? createPlainMachineRowFixture({ id, accountId: 'pet-preview-account' }) : null).text());
        }
        else if (request.url === '/v1/machines/pet-machine' || request.url === '/v1/machines/pet-machine-other') response.end(JSON.stringify({ machine: {
            id: request.url.slice('/v1/machines/'.length), dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } }));
        else if (request.url === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    const calls: SocketRpcRequestPayload[] = [];
    const cancelled: string[] = [];
    relay.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CANCEL, (payload: { requestId: string }) => cancelled.push(payload.requestId));
        socket.on(SOCKET_RPC_EVENTS.CALL, async (packet: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            calls.push(packet);
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            if (calls.length < 3) return; // Connected handler deliberately never answers the first two reads.
            const { sourceKey } = DaemonPetReadPreviewAssetRequestV1Schema.parse(decoded.params);
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, {
                sourceKey, mediaType: 'image/webp', digest: 'sha256:recovered-preview', dataBase64: calls.length === 3 ? 'AQID' : 'BAUG', sizeBytes: 3,
            }, decoded.callId) });
        });
    });
    try {
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing preview Home address');
        credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'pet-preview-account' })).toString('base64url')}.signature`;
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${address.port}`, name: 'Pet preview cancellation' });
        const source = (sourceKey: string): SelectedPetPackageSource => ({
            kind: 'happierManagedLocal', sourceKey, daemonTarget: { machineId: 'pet-machine', serverId: home.id },
        });
        const hook = await renderHook(usePetSpritesheetSourceResult, { initialProps: source('pet:first') });
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        const second = await renderHook(usePetSpritesheetSourceResult, { initialProps: source('pet:first') });
        const third = await renderHook(usePetSpritesheetSourceResult, { initialProps: source('pet:first') });
        await hook.rerender(source('pet:first'));
        expect(calls).toHaveLength(1);
        await second.unmount();
        await third.unmount();
        expect(cancelled).toHaveLength(0);
        expect(calls[0]?.requestId).toEqual(expect.any(String));
        expect(hook.getCurrent().status).toBe('loading');
        await hook.rerender(source('pet:second'));
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        await vi.waitFor(() => expect(cancelled).toContain(calls[0]?.requestId));
        await hook.unmount();
        await vi.waitFor(() => expect(cancelled).toContain(calls[1]?.requestId));

        const recovered = await renderHook(usePetSpritesheetSourceResult, { initialProps: source('pet:first') });
        await vi.waitFor(() => expect(recovered.getCurrent()).toEqual({ status: 'ready', source: 'data:image/webp;base64,AQID', spriteVersionNumber: 1 }));
        expect(calls).toHaveLength(3);
        await recovered.unmount();
        const cachedSource = { ...source('pet:first'), digest: 'sha256:recovered-preview' };
        const cached = await renderHook(usePetSpritesheetSourceResult, { initialProps: cachedSource });
        await vi.waitFor(() => expect(cached.getCurrent().source).toBe('data:image/webp;base64,AQID'));
        expect(calls).toHaveLength(3);
        const otherMachine = await renderHook(usePetSpritesheetSourceResult, { initialProps: {
            ...cachedSource, daemonTarget: { machineId: 'pet-machine-other', serverId: home.id },
        } });
        await vi.waitFor(() => expect(otherMachine.getCurrent().source).toBe('data:image/webp;base64,BAUG'));
        expect(calls).toHaveLength(4);
        await cached.unmount();
        await otherMachine.unmount();
    } finally {
        await serverScopedRpcSocketPool.stopAll();
        http.closeAllConnections();
        await new Promise<void>(resolve => relay.close(() => resolve()));
    }
});
