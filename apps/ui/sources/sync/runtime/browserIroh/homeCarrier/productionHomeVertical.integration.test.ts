import { createServer, type Server as HttpServer } from 'node:http';
import { connect as connectLoopback, type AddressInfo } from 'node:net';

import { attach, type Server as EngineServer } from 'engine.io';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHappierSocket } from '@happier-dev/sync-client';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createServerFetchAtEndpoint } from '@/sync/http/client';

import type { BrowserIrohEndpointClient, BrowserIrohStream } from '../endpointClient';
import { createBrowserIrohHomeCarrierOwner } from './browserHomeCarrierRuntime';

const HOME_ENDPOINT_ID = 'k51endpointhomeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CANONICAL_HOME_URL = 'https://ingressless-home.example.test';

/**
 * The production composition, minus the Iroh hop itself: the real carrier owner,
 * the real HTTP/1.1 tunnel codec, the real RFC 6455 carrier, the real
 * `serverFetch` request pipeline, and the real Engine.IO client and server.
 *
 * The single substitution is the stream handle, which is exactly what Home's
 * acceptor produces on its side: it pumps an authenticated
 * `happier/home-tunnel/1` stream straight into its loopback HTTP listener, so a
 * loopback socket stands in front of the identical byte boundary. Nothing
 * internal is mocked, and the Home is genuinely ingress-less: its canonical URL
 * resolves nowhere, and every byte below is proof the carrier moved it.
 */
async function openLoopbackTunnelStream(
    port: number,
    remoteEndpointId: string,
): Promise<BrowserIrohStream> {
    const connection = connectLoopback({ port, host: '127.0.0.1' });
    connection.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
        connection.once('connect', () => { resolve(); });
        connection.once('error', reject);
    });

    const inbound: Uint8Array[] = [];
    let ended = false;
    let cancelled = false;
    let wake: (() => void) | null = null;
    const wakeReader = (): void => {
        const pending = wake;
        wake = null;
        pending?.();
    };
    connection.on('data', (chunk: Buffer) => { inbound.push(new Uint8Array(chunk)); wakeReader(); });
    connection.on('end', () => { ended = true; wakeReader(); });
    connection.on('close', () => { ended = true; wakeReader(); });

    return {
        streamId: `loopback-${port}`,
        remoteEndpointId,
        observedPath: 'relay',
        read: async (maxBytes) => {
            for (;;) {
                if (cancelled) throw new Error('cancelled');
                const head = inbound[0];
                if (head !== undefined) {
                    if (head.length <= maxBytes) {
                        inbound.shift();
                        return { bytes: head, done: false };
                    }
                    inbound[0] = head.subarray(maxBytes);
                    return { bytes: head.subarray(0, maxBytes), done: false };
                }
                if (ended) return { bytes: new Uint8Array(), done: true };
                await new Promise<void>((resolve) => { wake = resolve; });
            }
        },
        write: async (bytes) => {
            await new Promise<void>((resolve, reject) => {
                connection.write(Buffer.from(bytes), (error) => (error ? reject(error) : resolve()));
            });
        },
        finishWrite: async () => { connection.end(); },
        cancel: async () => { cancelled = true; connection.destroy(); wakeReader(); },
        close: async () => { connection.end(); connection.destroy(); },
    };
}

/**
 * The one system boundary: the SharedWorker endpoint. Leases are real objects
 * whose streams reach the real Home above.
 */
function createLoopbackEndpointClient(port: () => number, remoteEndpointId = HOME_ENDPOINT_ID): BrowserIrohEndpointClient {
    let leaseSequence = 0;
    return {
        acquireLease: async (relayUrls) => {
            leaseSequence += 1;
            return {
                leaseId: `lease-${leaseSequence}`,
                endpointId: 'local-browser-endpoint',
                appliedRelayUrls: [...relayUrls],
                openStream: async () => await openLoopbackTunnelStream(port(), remoteEndpointId),
                release: async () => {},
            };
        },
        status: async () => ({
            state: 'ready',
            endpointId: 'local-browser-endpoint',
            appliedRelayUrls: [],
            leaseCount: leaseSequence,
        }),
        releaseAll: async () => {},
        close: () => {},
    };
}

function acquireCarrier(client: BrowserIrohEndpointClient) {
    return createBrowserIrohHomeCarrierOwner({
        resolveEndpointClient: () => client,
        hostDecision: () => ({ eligible: true }),
    }).acquire({
        homeServerIdentityId: 'srv_home_ingressless',
        endpoint: { endpointId: HOME_ENDPOINT_ID, relayUrls: ['https://relay.happier.test/'] },
        canonicalServerUrl: CANONICAL_HOME_URL,
        credentials: { token: 'home-token' },
    });
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('browser Iroh production Home vertical', () => {
    let httpServer: HttpServer;
    let engine: EngineServer;
    let port = 0;
    let authorizationHeaders: Array<string | undefined> = [];
    let handshakePackets: string[] = [];

    beforeEach(async () => {
        authorizationHeaders = [];
        handshakePackets = [];
        httpServer = createServer((request, response) => {
            authorizationHeaders.push(request.headers.authorization);
            if (request.url === '/v1/auth/ping') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ ok: true }));
                return;
            }
            if (request.url === '/v1/sessions') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ sessions: [{ id: 'session-1' }] }));
                return;
            }
            if (request.url === '/v1/delayed') {
                setTimeout(() => {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ delayed: true }));
                }, 25);
                return;
            }
            response.writeHead(404);
            response.end();
        });
        engine = attach(httpServer, { path: '/v1/updates/' });
        engine.on('connection', (connected) => {
            connected.on('message', (raw: string | Buffer) => {
                const packet = typeof raw === 'string' ? raw : raw.toString('utf8');
                handshakePackets.push(packet);
                if (packet.startsWith('0')) connected.send('0{"sid":"home-side-sid"}');
                // Engine.IO has already removed its MESSAGE packet prefix here,
                // so Socket.IO EVENT packets arrive as `2[...]`, not `42[...]`.
                if (packet.startsWith('2')) connected.send('2["update",{"seq":1}]');
            });
        });
        await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', resolve); });
        port = (httpServer.address() as AddressInfo).port;
    });

    afterEach(async () => {
        engine.close();
        await new Promise<void>((resolve) => { httpServer.close(() => { resolve(); }); });
    });

    it('serves authenticated HTTP for an ingress-less Home through the acquired carrier', async () => {
        const carrier = await acquireCarrier(createLoopbackEndpointClient(() => port));
        const request = createServerFetchAtEndpoint({
            endpointUrl: CANONICAL_HOME_URL,
            homeCarrier: carrier,
            credentials: { token: 'home-token' },
            serverId: 'srv_home_ingressless',
        });

        const response = await request('/v1/sessions', undefined, { retry: 'none' });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ sessions: [{ id: 'session-1' }] });
        // The canonical URL is what the request was addressed to, and the
        // Home-scoped bearer is what reached the Home.
        expect(authorizationHeaders).toEqual(['Bearer home-token']);
        expect(carrier.readObservedPath()).toBe('relay');
    }, 30_000);

    it('keeps the request stream open while an ordinary Home route responds asynchronously', async () => {
        const carrier = await acquireCarrier(createLoopbackEndpointClient(() => port));
        const request = createServerFetchAtEndpoint({
            endpointUrl: CANONICAL_HOME_URL,
            homeCarrier: carrier,
            credentials: { token: 'home-token' },
            serverId: 'srv_home_ingressless',
        });

        const response = await request('/v1/delayed', undefined, { retry: 'none' });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ delayed: true });
        expect(authorizationHeaders).toEqual(['Bearer home-token']);
    }, 30_000);

    it('carries a live Socket.IO session through the same carrier without duplicating events', async () => {
        const carrier = await acquireCarrier(createLoopbackEndpointClient(() => port));
        const requestedUris: string[] = [];
        const { socket, transport } = createHappierSocket({
            clientType: 'user-scoped',
            clientPurpose: 'sync',
            authExtras: buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            endpoint: CANONICAL_HOME_URL,
            token: 'home-token',
            websocketFactory: (uri, protocols, options) => {
                requestedUris.push(uri);
                return carrier.createWebSocket(uri, protocols, options);
            },
        });

        const updates: unknown[] = [];
        socket.on('update', (payload: unknown) => { updates.push(payload); });
        const connects: number[] = [];
        transport.onConnected(() => { connects.push(1); });

        await transport.connect();
        await waitFor(() => connects.length > 0, 'the connection owner to report connected');
        socket.emit('ping-me', {});
        await waitFor(() => updates.length > 0, 'a live update');

        expect(requestedUris).toEqual([`${CANONICAL_HOME_URL.replace('https:', 'wss:')}/v1/updates/?EIO=4&transport=websocket`]);
        expect(updates).toEqual([{ seq: 1 }]);
        expect(JSON.parse(handshakePackets[0]!.slice(1))).toMatchObject({
            token: 'home-token',
            clientType: 'user-scoped',
            clientPurpose: 'sync',
        });

        await transport.disconnect({ intentional: true });
        await transport.destroy();
    }, 30_000);

    it('opens a fresh carrier stream for a second connection owner after an intentional disconnect', async () => {
        const carrier = await acquireCarrier(createLoopbackEndpointClient(() => port));
        const build = () => createHappierSocket({
            clientType: 'user-scoped',
            clientPurpose: 'sync',
            authExtras: buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            endpoint: CANONICAL_HOME_URL,
            token: 'home-token',
            websocketFactory: (uri, protocols, options) => carrier.createWebSocket(uri, protocols, options),
        });

        const first = build();
        await first.transport.connect();
        await waitFor(() => first.transport.isConnected(), 'the first connection');
        await first.transport.disconnect({ intentional: true });
        await first.transport.destroy();

        const second = build();
        const updates: unknown[] = [];
        second.socket.on('update', (payload: unknown) => { updates.push(payload); });
        await second.transport.connect();
        await waitFor(() => second.transport.isConnected(), 'the reconnected connection');
        second.socket.emit('ping-me', {});
        await waitFor(() => updates.length > 0, 'a live update after reconnect');

        // Each connection is one handshake and one delivery: the carrier adds no
        // second event path and replays nothing across the reconnect.
        expect(handshakePackets.filter((packet) => packet.startsWith('0'))).toHaveLength(2);
        expect(updates).toEqual([{ seq: 1 }]);

        await second.transport.destroy();
    }, 30_000);

    it('refuses a Socket.IO connection when the stream authenticates a different EndpointId', async () => {
        const carrier = await acquireCarrier(
            createLoopbackEndpointClient(() => port, 'k51endpointimposteraaaaaaaaaaaaaaaaaaaaaaaaaa'),
        );
        const { transport } = createHappierSocket({
            clientType: 'user-scoped',
            clientPurpose: 'sync',
            authExtras: buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            endpoint: CANONICAL_HOME_URL,
            token: 'home-token',
            websocketFactory: (uri, protocols, options) => carrier.createWebSocket(uri, protocols, options),
        });
        // The identity refusal surfaces as the connection owner's rejected connect.
        await expect(transport.connect()).rejects.toThrow();

        expect(transport.isConnected()).toBe(false);
        expect(handshakePackets).toEqual([]);

        await transport.destroy();
    }, 30_000);

    it('sends zero application bytes to a Home that proves a different EndpointId', async () => {
        const carrier = await acquireCarrier(
            createLoopbackEndpointClient(() => port, 'k51endpointimposteraaaaaaaaaaaaaaaaaaaaaaaaaa'),
        );
        const request = createServerFetchAtEndpoint({
            endpointUrl: CANONICAL_HOME_URL,
            homeCarrier: carrier,
            credentials: { token: 'home-token' },
            serverId: 'srv_home_ingressless',
        });

        await expect(request('/v1/sessions', undefined, { retry: 'none' })).rejects.toThrow(/EndpointId/iu);
        expect(authorizationHeaders).toEqual([]);
    }, 30_000);
});
