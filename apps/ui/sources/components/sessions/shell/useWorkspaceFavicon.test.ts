import { createServer } from 'node:http';
import * as React from 'react';
import { Server } from 'socket.io';
import { afterEach, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { WorkspaceFaviconResolveRequestV1Schema } from '@happier-dev/protocol/workspace/favicon/v1';
import { socketRpcCodec } from '@happier-dev/sync-client';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { clearWorkspaceFaviconCacheForTests } from '@/sync/ops/workspaceFavicon';
import { useWorkspaceFavicon } from './useWorkspaceFavicon';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

const credentials = vi.hoisted(() => ({ token: '' }));
// Credential persistence is the device boundary; cache, hook, RPC and Socket.IO are real.
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
    clearWorkspaceFaviconCacheForTests();
});

it('keeps a shared favicon read for remaining views, cancels the last view, and retries without losing cached results', async () => {
    const http = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health' || request.url === '/v1/auth/ping') response.end('{}');
        else if (request.url === '/v1/machines/read-batch' && request.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            response.end(await createMachineReadBatchResponseFixture(Buffer.concat(chunks).toString('utf8'),
                id => id === 'favicon-machine' ? createPlainMachineRowFixture({ id, accountId: 'favicon-account' }) : null).text());
        }
        else if (request.url === '/v1/machines/favicon-machine') response.end(JSON.stringify({ machine: {
            id: 'favicon-machine', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
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
            const request = WorkspaceFaviconResolveRequestV1Schema.parse(decoded.params);
            if (calls.length !== 2 && calls.length !== 3 && request.workspacePath !== '/cached-repo') return;
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, {
                success: true, found: true, relativePath: 'public/favicon.svg', mimeType: 'image/svg+xml',
                contentBase64: request.workspacePath === '/cached-repo' ? 'c2Vjb25k' : 'PHN2Zy8+', sizeBytes: 6,
            }, decoded.callId) });
        });
    });
    try {
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing favicon Home address');
        credentials.token = `header.${Buffer.from(JSON.stringify({ sub: 'favicon-account' })).toString('base64url')}.signature`;
        const home = await upsertServerProfile({ serverUrl: `http://127.0.0.1:${address.port}`, name: 'Favicon cancellation' });
        const params = { enabled: true, reachable: true, serverId: home.id, machineId: 'favicon-machine', workspacePath: '/repo' };
        // Attention copies observe the same resource; they must not own a second demand.
        const mirror = await renderHook(useWorkspaceFavicon, { initialProps: { ...params, demand: false } });
        expect(mirror.getCurrent()).toBeNull();
        expect(calls).toHaveLength(0);
        const first = await renderHook(useWorkspaceFavicon, { initialProps: params });
        const second = await renderHook(useWorkspaceFavicon, { initialProps: params });
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        await first.unmount();
        expect(cancelled).toEqual([]);
        expect(second.getCurrent()).toBeNull();
        await second.unmount();
        await vi.waitFor(() => expect(cancelled).toEqual([expect.any(String)]));
        expect(cancelled[0]).toBe(calls[0]?.requestId);
        expect(mirror.getCurrent()).toBeNull();

        const changedSourceValues: Array<ReturnType<typeof useWorkspaceFavicon>> = [];
        const recovered = await renderHook((input: Parameters<typeof useWorkspaceFavicon>[0]) => {
            const value = useWorkspaceFavicon(input);
            React.useLayoutEffect(() => {
                if (input.workspacePath === '/other-repo') changedSourceValues.push(value);
            }, [input.workspacePath, value]);
            return value;
        }, { initialProps: params });
        const expected = { status: 'found', uri: 'data:image/svg+xml;base64,PHN2Zy8+', relativePath: 'public/favicon.svg' };
        await vi.waitFor(() => expect(recovered.getCurrent()).toEqual(expected));
        await vi.waitFor(() => expect(mirror.getCurrent()).toBe(recovered.getCurrent()));
        const cached = await renderHook(useWorkspaceFavicon, { initialProps: { ...params, demand: false } });
        expect(cached.getCurrent()).toEqual(expected);
        expect(cached.getCurrent()).toBe(recovered.getCurrent());
        expect(calls).toHaveLength(2);
        await cached.unmount();
        expect(cancelled).toHaveLength(1);

        await recovered.rerender({ ...params, reachable: false });
        await mirror.rerender({ ...params, reachable: false, demand: false });
        expect(recovered.getCurrent()).toBeNull();
        expect(mirror.getCurrent()).toBeNull();
        expect(calls).toHaveLength(2);
        await recovered.rerender(params);
        await mirror.rerender({ ...params, demand: false });
        await vi.waitFor(() => expect(recovered.getCurrent()).toEqual(expected));
        await vi.waitFor(() => expect(mirror.getCurrent()).toBe(recovered.getCurrent()));
        expect(calls).toHaveLength(3);

        await recovered.rerender({ ...params, workspacePath: '/other-repo' });
        await mirror.rerender({ ...params, workspacePath: '/other-repo', demand: false });
        expect(mirror.getCurrent()).toBeNull();
        expect(changedSourceValues).not.toContainEqual(expected);
        await vi.waitFor(() => expect(calls).toHaveLength(4));
        await recovered.rerender({ ...params, workspacePath: '/other-repo', enabled: false });
        await vi.waitFor(() => expect(cancelled).toHaveLength(2));
        expect(cancelled[1]).toBe(calls[3]?.requestId);
        expect(recovered.getCurrent()).toBeNull();
        await recovered.unmount();
        await mirror.unmount();

        // A passive mark can rebind after both demanding sources have already settled. Neither
        // source publishes again, so the keyed snapshot itself must supply the second result.
        const cachedFirst = await renderHook(useWorkspaceFavicon, { initialProps: params });
        const secondSource = { ...params, workspacePath: '/cached-repo' };
        const cachedSecond = await renderHook(useWorkspaceFavicon, { initialProps: secondSource });
        await vi.waitFor(() => expect(cachedSecond.getCurrent()?.uri).toBe('data:image/svg+xml;base64,c2Vjb25k'));
        expect(calls).toHaveLength(5);
        const rebound = await renderHook(useWorkspaceFavicon, { initialProps: { ...params, demand: false } });
        expect(rebound.getCurrent()).toBe(cachedFirst.getCurrent());
        await rebound.rerender({ ...secondSource, demand: false });
        await vi.waitFor(() => expect(rebound.getCurrent()).toBe(cachedSecond.getCurrent()));
        expect(calls).toHaveLength(5);
        await rebound.unmount();
        await cachedFirst.unmount();
        await cachedSecond.unmount();
    } finally {
        standardCleanup();
        await serverScopedRpcSocketPool.stopAll();
        http.closeAllConnections();
        await new Promise<void>(resolve => relay.close(() => resolve()));
    }
});
