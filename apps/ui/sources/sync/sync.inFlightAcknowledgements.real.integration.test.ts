import 'fake-indexeddb/auto';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const native = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios',
    listeners: new Set<(state: string) => void>(),
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { get OS() { return native.platform; } },
        AppState: { currentState: 'active', addEventListener: (_event: string, handler: (state: string) => void) => {
            native.listeners.add(handler);
            return { remove: () => { native.listeners.delete(handler); } };
        } },
    });
});

describe('Sync routine teardown with real ApiSocket acknowledgement wiring', () => {
    let dispose: (() => void) | undefined;
    let retire: (() => void) | undefined;
    let server: Server | undefined;
    beforeEach(() => { vi.resetModules(); native.listeners.clear(); });
    afterEach(async () => {
        retire?.(); dispose?.();
        if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); });
        server = undefined;
        vi.unstubAllGlobals();
    });

    async function boot(platform: 'web' | 'ios', accountScoped = false) {
        native.platform = platform;
        const handlers = new Map<string, Set<() => void>>();
        const document = {
            visibilityState: 'visible', getElementById: () => null, dispatchEvent: () => {},
            addEventListener: (event: string, handler: () => void) => {
                const listeners = handlers.get(event) ?? new Set<() => void>();
                listeners.add(handler); handlers.set(event, listeners);
            },
            removeEventListener: (event: string, handler: () => void) => { handlers.get(event)?.delete(handler); },
        };
        vi.stubGlobal('document', document);
        let readinessRequests = 0;
        const http = createServer((request, response) => {
            if (request.url === '/v1/auth/ping') readinessRequests += 1;
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ ok: true, cursor: 0 }));
        });
        server = new Server(http, { path: '/v1/updates/' });
        await new Promise<void>(resolve => { http.listen(0, '127.0.0.1', resolve); });
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback address');
        const bridge = await loadSyncSingletonForTests();
        dispose = bridge.dispose;
        const { sync } = await import('./sync');
        retire = () => { sync.disconnectServer(); };
        const { apiSocket } = await import('./api/session/apiSocket');
        const endpoint = `http://127.0.0.1:${address.port}`;
        apiSocket.initialize({ endpoint, token: 'fixture-token', runtimeOrigin: endpoint,
            serverId: endpoint, generation: 1, carrier: 'https', homeCarrier: null,
            ...(!accountScoped ? {
                socketRole: { clientType: 'session-scoped' as const, sessionId: 'lead' },
                request: async () => Response.json({ cursor: 0 }), isCurrent: () => true,
            } : {}),
        }, null);
        await vi.waitFor(() => expect(apiSocket.getSocketId()).not.toBe(''));
        const { storage } = await import('./domains/state/storage');
        storage.setState({ sessions: { lead: createSessionFixture({ id: 'lead', encryptionMode: 'plain' }) } });
        const background = () => {
            if (platform === 'ios') for (const handler of native.listeners) handler('background');
            else { document.visibilityState = 'hidden'; for (const handler of handlers.get('visibilitychange') ?? []) handler(); }
        };
        const foreground = () => {
            if (platform === 'ios') for (const handler of native.listeners) handler('active');
            else { document.visibilityState = 'visible'; for (const handler of handlers.get('visibilitychange') ?? []) handler(); }
        };
        const socket = [...server.sockets.sockets.values()][0];
        if (!socket) throw new Error('Missing server socket');
        return { apiSocket, socket, background, foreground, endpoint, readReadinessRequests: () => readinessRequests };
    }

    it.each(['web', 'ios'] as const)('settles a pending Role Apply response before %s routine disconnect', async platform => {
        const { apiSocket, socket, background } = await boot(platform);
        let acknowledge!: (response: unknown) => void;
        let issued!: () => void;
        const started = new Promise<void>(resolve => { issued = resolve; });
        // Real Socket.IO ACK teardown, Sync, ApiSocket and codecs compose here;
        // only the remote endpoint handler is supplied by this fixture.
        socket.on(SOCKET_RPC_EVENTS.CALL, async (payload: { method: string; params: unknown }, ack: (value: unknown) => void) => {
            expect(payload.method).toBe('lead:session.roles.apply_to_reports');
            const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
            RoleActionInputSchemasV1['session.roles.apply_to_reports'].parse(request.params);
            acknowledge = ack;
            issued();
        });
        const pending = apiSocket.sessionRPC<unknown, { sessionId: string }>(
            'lead', 'session.roles.apply_to_reports', { sessionId: 'lead' },
        );
        const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }));
        await started;
        background();
        expect(apiSocket.getSocketId()).not.toBe('');
        const result = RoleActionOutputSchemasV1['session.roles.apply_to_reports'].parse({ updatedSessionIds: ['child'] });
        acknowledge({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, null) });
        const settled = await outcome;
        expect(settled).toEqual({ value: result });
        if (!('value' in settled)) throw settled.error;
        expect(RoleActionOutputSchemasV1['session.roles.apply_to_reports'].parse(settled.value)).toEqual(result);
        expect(apiSocket.getSocketId()).toBe('');
    });

    it('releases an aborted acknowledgement so routine teardown can finish', async () => {
        const { apiSocket, socket, background } = await boot('web');
        let issued!: () => void;
        const started = new Promise<void>(resolve => { issued = resolve; });
        socket.on('test-write', () => { issued(); });
        const controller = new AbortController();
        const pending = apiSocket.emitWithAck('test-write', {}, { signal: controller.signal }).catch(error => error);
        await started;
        background();
        expect(apiSocket.getSocketId()).not.toBe('');
        controller.abort();
        expect(await pending).toBeInstanceOf(Error);
        expect(apiSocket.getSocketId()).toBe('');
    });

    it('settles a Role Apply on the Account socket while foreground return revalidates readiness', async () => {
        const { apiSocket, socket, background, foreground, readReadinessRequests } = await boot('web', true);
        let acknowledge!: (response: unknown) => void;
        let issued!: () => void;
        const started = new Promise<void>(resolve => { issued = resolve; });
        socket.on(SOCKET_RPC_EVENTS.CALL, async (payload: { method: string; params: unknown }, ack: (value: unknown) => void) => {
            const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
            RoleActionInputSchemasV1['session.roles.apply_to_reports'].parse(request.params);
            acknowledge = ack; issued();
        });
        const pending = apiSocket.sessionRPC<unknown, { sessionId: string }>('lead', 'session.roles.apply_to_reports', { sessionId: 'lead' });
        const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }));
        await started;
        const socketId = apiSocket.getSocketId();
        const probesBefore = readReadinessRequests();
        background();
        expect(apiSocket.getSocketId()).toBe(socketId);
        foreground();
        // The real Sync resume pipeline must revalidate Account reachability.
        // The frame-only fixture above deliberately bypasses that subscription.
        await vi.waitFor(() => expect(readReadinessRequests()).toBeGreaterThan(probesBefore));
        expect(apiSocket.getSocketId()).toBe(socketId);
        const result = RoleActionOutputSchemasV1['session.roles.apply_to_reports'].parse({ updatedSessionIds: ['child'] });
        acknowledge({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, null) });
        expect(await outcome).toEqual({ value: result });
    });
});
