import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import Fastify from 'fastify';
import { Server } from 'socket.io';
import { io as createClient } from 'socket.io-client';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { FeaturesResponseSchema, PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, PeerTcpTunnelRelayEnvelopeSchema, decodePeerTcpTunnelBinaryFrameV2, type LocalServicePreviewResourceV1 } from '@happier-dev/protocol';
import { LocalServicePreviewResourceV1Schema, localServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { TEST_MACHINE_INSTALLATION_ID } from '@/app/api/testkit/machineAdmissionPersistenceBoundary';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { createPeerTcpTunnelRelayBridge } from '@/app/api/socket/peer/mediation/tunnel/relayBridge';
import { createPeerTcpTunnelRelayCoordinator } from '@/app/api/socket/peer/mediation/tunnel/relayCoordinator';
import { registerPeerTcpTunnelRelaySocketHandler } from '@/app/api/socket/peer/mediation/tunnel/registerRelay';
import { registerLocalServiceRoutes } from '@/app/api/routes/local/services/registerRoutes';
import { createLocalServicePublicRuntime } from '../public/runtime';
import { createLocalServicePublicRateLimitChecker } from '../public/rateLimits';
import { registerMachinePeerTcpTunnelRelayRuntime } from '../../../../../../cli/src/daemon/machine/registerMachinePeerTcpTunnelRelayRuntime';
import { createLocalServicePreviewRuntime } from './runtime';
import { createLocalServicePreviewTunnelOpener } from './tunnel';
import { createLocalServicePreviewRegistry, registerLocalServicePreview, resolveLocalServicePreviewApplication } from '../../../../../../cli/src/daemon/local/services/preview/registry';
import { createLocalServicePreviewRoutes } from '../../../../../../cli/src/daemon/local/services/preview/routes';
import { createDeferred } from '../../../../../../cli/src/testkit/async/deferred';

// Persistence is the system boundary; the real Machine admission owner evaluates its rows.
vi.mock('@/storage/db', async () => {
    const { createMachineAdmissionPersistenceBoundary } = await import('@/app/api/testkit/machineAdmissionPersistenceBoundary');
    return { db: createMachineAdmissionPersistenceBoundary('user_1').db };
});

describe('preview HTTP and public WebSocket through the server relay and daemon TCP terminator', () => {
    it.each([
        { publicBaseUrl: 'https://home.example.test:8443', hostOriginBaseDomain: 'example.test' },
        { publicBaseUrl: 'http://home.localhost:8181', hostOriginBaseDomain: 'localhost' },
    ])('serves private/public HTTP and revokes a real public websocket ($publicBaseUrl)', async ({ publicBaseUrl, hostOriginBaseDomain }) => {
        const paths: string[] = [];
        const wireTrace: string[] = [];
        const closeTransports: (() => void)[] = [];
        function recordFrame(direction: string, payload: unknown): void {
            const parsed = PeerTcpTunnelRelayEnvelopeSchema.safeParse(payload);
            if (!parsed.success) { wireTrace.push(`${direction}:invalid`); return; }
            const envelope = parsed.data;
            if (envelope.v === 1) {
                wireTrace.push(`${direction}:${envelope.frame.kind}${envelope.frame.kind === 'abort' ? `:${envelope.frame.reasonCode}` : ''}`);
            } else {
                const decoded = decodePeerTcpTunnelBinaryFrameV2({ frame: envelope.frame, maxHeaderBytes: 64 * 1024, maxPayloadBytes: 256 * 1024 });
                wireTrace.push(`${direction}:${decoded.ok ? decoded.header.kind : 'invalid-binary'}`);
            }
        }
        const fixture = createServer((request, response) => {
            paths.push(request.url ?? '');
            response.setHeader('content-type', 'text/plain');
            response.end(`fixture:${request.url}`);
        });
        const fixtureUpgradeSockets = new Set<Duplex>();
        const fixtureUpgradeSocketsByPath = new Map<string, Duplex>();
        fixture.on('upgrade', (request, socket) => {
            fixtureUpgradeSockets.add(socket);
            fixtureUpgradeSocketsByPath.set(request.url ?? '', socket);
            socket.on('close', () => fixtureUpgradeSockets.delete(socket));
            // Raw HTTP upgrade sockets are half-open; acknowledge the peer's EOF like a WS endpoint.
            socket.once('end', () => socket.end());
            const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
            const message = Buffer.from('public fixture message');
            socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
            socket.on('data', () => {
                const reply = Buffer.from('fixture input received');
                socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
            });
        });
        let publicClient: Socket | undefined;
        let retainedUpgradeClient: Socket | undefined;
        const privateClients: Socket[] = [];
        let replacement: ReturnType<typeof createServer> | undefined;
        let phase = 'setup';
        let completed = false;
        const markPhase = (next: string) => { phase = next; };
        fixture.listen(0, '127.0.0.1');
        await once(fixture, 'listening');
        const address = fixture.address();
        if (!address || typeof address === 'string') throw new Error('missing fixture address');
        const relayHttp = createServer();
        const io = new Server(relayHttp, { transports: ['websocket'] });
        relayHttp.listen(0, '127.0.0.1');
        await once(relayHttp, 'listening');
        const relayAddress = relayHttp.address();
        if (!relayAddress || typeof relayAddress === 'string') throw new Error('missing relay address');
        const bridge = createPeerTcpTunnelRelayBridge(io);
        const coordinator = createPeerTcpTunnelRelayCoordinator({ io, config: { mode: 'memory' } });
        const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
        const roots = [{ keyId: 'fixture-key', publicKeyBase64Url: Buffer.from(key.publicKey).toString('base64url') }];
        const handlerOptions = { io: bridge.io, coordinator, serverRoutedEnabled: true, allowedPorts: [address.port], relayAuthorizationTrustRoots: roots };
        io.on('connection', socket => {
            socket.data = { userId: 'user_1', clientType: 'machine-scoped', machineId: 'machine_1', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID };
            void socket.join('machine:machine_1:user_1');
            registerPeerTcpTunnelRelaySocketHandler('user_1', socket, handlerOptions);
        });
        const client = createClient(`http://127.0.0.1:${relayAddress.port}`, { transports: ['websocket'], autoConnect: false });
        client.onAny((event, payload: unknown) => { if (event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) recordFrame('server-to-daemon', payload); });
        client.onAnyOutgoing((event, payload: unknown) => { if (event === PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT) recordFrame('daemon-to-server', payload); });
        const preview: LocalServicePreviewResourceV1 = {
            previewId: 'preview_fixture', sessionId: 'session_fixture', machineId: 'machine_1',
            owner: { kind: 'session', id: 'session_fixture' },
            target: { scheme: 'http', host: '127.0.0.1', port: address.port },
            initialPath: { pathname: '/body', search: '' }, display: { title: 'fixture', addressLabel: 'fixture' }, originMode: 'host',
        };
        const previewRegistry = createLocalServicePreviewRegistry();
        expect(registerLocalServicePreview(previewRegistry, preview, { isCurrent: () => fixture.listening }).ok).toBe(true);
        const daemon = registerMachinePeerTcpTunnelRelayRuntime({
            accountId: 'user_1', machineId: 'machine_1', nowMs: Date.now,
            resolvePreviewApplication: binding => resolveLocalServicePreviewApplication(previewRegistry, binding),
            serverFeatures: FeaturesResponseSchema.parse({
                features: { machines: { enabled: true, tunnel: { enabled: true, serverRouted: { enabled: true } } } },
                capabilities: { machines: { peerMediation: { grantSigningKeys: roots.map(root => ({ keyId: root.keyId, publicKey: root.publicKeyBase64Url })) } } },
            }),
            eventPort: {
                subscribe: listener => { client.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, listener); return () => { client.off(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, listener); }; },
                emit: envelope => { client.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope); },
            },
            onHandlerError: error => { wireTrace.push(`daemon-handler-error:${String(error)}`); },
        });
        if (!daemon) throw new Error('enabled daemon relay was not registered');
        client.connect();
        await once(client, 'connect');
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'fixture-secret', publicBaseUrl, hostOriginBaseDomain });
        const registered = runtime.registerPreview({ resource: preview, accountId: 'user_1' });
        if (!registered.ok || !registered.accessUrl) throw new Error('fixture registration failed');
        const tunnelEnv = { HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: 'true', HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: String(address.port), HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'fixture-key', HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(key.secretKey).toString('base64url') };
        const openTunnel = createLocalServicePreviewTunnelOpener({
            env: tunnelEnv,
            resolvePreviewAccountId: id => runtime.resolvePreviewContext(id)?.accountId,
            createRelayTransport: ({ accountId }) => {
                const transport = bridge.createTransport({ accountId });
                const handlers = new Map<string, (payload?: unknown) => void | Promise<void>>();
                registerPeerTcpTunnelRelaySocketHandler(accountId, {
                    id: transport.relaySocketId, data: { clientType: 'user-scoped' },
                    on: (event, handler) => handlers.set(event, handler), emit: (_event, payload) => { wireTrace.push(`server-error:${JSON.stringify(payload)}`); },
                }, handlerOptions);
                const close = () => { void handlers.get('disconnect')?.(); transport.close(); };
                closeTransports.push(close);
                return { ...transport, send: (event, payload) => { recordFrame('preview-to-server', payload); void handlers.get(event)?.(payload); }, close };
            },
        });
        const app = Fastify();
        app.decorate('authenticate', async () => {});
        const publicRuntime = createLocalServicePublicRuntime({
            publicBaseUrl, hostOriginBaseDomain,
            tokenSecret: 'public-fixture-secret', resolvePreview: runtime.resolvePreview,
            policy: { enabled: true, allowedModes: ['secret_link'], maxTtlMs: 60_000, auditRequired: false, rateLimitProfileIds: ['default'] },
            // Three application reads and one admitted WebSocket in this journey.
            checkRateLimit: createLocalServicePublicRateLimitChecker({ kind: 'fixed_window', maxRequests: 4, windowMs: 60_000 }),
        });
        registerLocalServiceRoutes(app as never, {
            env: {
                PUBLIC_URL: publicBaseUrl,
                HAPPIER_FEATURE_LOCAL_SERVICES__ENABLED: 'true',
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: hostOriginBaseDomain,
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: 'true',
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'secret_link',
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '60000',
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: 'true',
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: 'default',
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: 'true',
                HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: 'true',
                HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: String(address.port),
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'fixture-key',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(key.secretKey).toString('base64url'),
            },
            runtimes: { preview: runtime, public: publicRuntime },
            openTunnel,
        });
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = () => cleanupPromise ??= (async () => {
            publicClient?.destroy();
            retainedUpgradeClient?.destroy();
            for (const socket of privateClients) socket.destroy();
            for (const socket of fixtureUpgradeSockets) socket.destroy();
            for (const close of closeTransports) close();
            markPhase('cleanup.daemon');
            await daemon.dispose();
            client.disconnect();
            markPhase('cleanup.coordinator');
            await coordinator.close();
            markPhase('cleanup.socketio');
            await new Promise<void>(resolve => io.close(() => resolve()));
            markPhase('cleanup.app');
            await app.close();
            replacement?.closeAllConnections();
            if (replacement) await new Promise<void>(resolve => replacement!.close(() => resolve()));
            fixture.closeAllConnections();
            markPhase('cleanup.fixture');
            await new Promise<void>(resolve => fixture.close(() => resolve()));
            markPhase('cleanup.complete');
        })();
        onTestFinished(async () => {
            if (!completed) console.error('Preview composed incomplete', { phase, origin: new URL(publicBaseUrl).protocol });
            await cleanup();
        });
        try {
            markPhase('session.exchange');
            const url = new URL(registered.accessUrl);
            const exchange = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: url.host } });
            expect(exchange.statusCode).toBe(303);
            expect(url.protocol).toBe(new URL(publicBaseUrl).protocol);
            expect(url.port).toBe(new URL(publicBaseUrl).port);
            expect(exchange.headers['set-cookie']).toContain('Secure; Partitioned');
            const cookie = String(exchange.headers['set-cookie']).split(';')[0];
            const bodyRequest = app.inject({ method: 'GET', url: '/body', headers: { host: url.host, cookie } });
            void bodyRequest.catch(() => undefined);
            await expect.poll(() => paths, { timeout: 5000, message: 'the admitted preview reaches the HTTP fixture' }).toEqual(['/body']);
            const body = await bodyRequest;
            expect(body.statusCode).toBe(200);
            expect(body.body).toBe('fixture:/body');
            const asset = await app.inject({ method: 'GET', url: '/asset.js', headers: { host: url.host, cookie } });
            expect(asset.statusCode).toBe(200);
            expect(asset.body).toBe('fixture:/asset.js');
            expect(paths).toEqual(['/body', '/asset.js']);

            markPhase('public.exchange');
            const created = publicRuntime.createExposure({
                preview, requestedMode: 'secret_link', requestedTtlMs: 60_000,
                actorId: 'user_1', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default',
            });
            if (!created.ok) throw new Error(created.reasonCode);
            const publicUrl = new URL(created.exposure.publicUrl);
            const publicExchange = await app.inject({ method: 'GET', url: publicUrl.pathname + publicUrl.search, headers: { host: publicUrl.host } });
            expect(publicExchange.statusCode).toBe(303);
            const publicCookie = String(publicExchange.headers['set-cookie']).split(';')[0];
            expect(publicExchange.headers['set-cookie']).toContain('Path=/;');
            for (const path of ['/asset.css', '/asset.js?revision=2', '/other']) {
                const asset = await app.inject({ method: 'GET', url: path, headers: { host: publicUrl.host, cookie: publicCookie } });
                expect(asset.statusCode, `public absolute application path ${path}`).toBe(200);
                expect(asset.body).toBe(`fixture:${path}`);
            }
            const isolated = await app.inject({ method: 'GET', url: '/asset.js', headers: { host: url.host, cookie: publicCookie } });
            expect(isolated.statusCode).toBe(401);
            const wrongOrigin = await app.inject({ method: 'GET', url: publicUrl.pathname, headers: { host: new URL(publicBaseUrl).host, cookie: publicCookie } });
            expect(wrongOrigin.statusCode, 'public content must stay off the API origin').toBe(403);
            const listener = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));
            publicClient = connect(Number(listener.port), '127.0.0.1');
            const publicBytes: Buffer[] = [];
            publicClient.on('data', bytes => publicBytes.push(bytes));
            await once(publicClient, 'connect');
            publicClient.write(`GET /socket HTTP/1.1\r\nHost: ${publicUrl.host}\r\nCookie: ${publicCookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
            markPhase('public.upgrade');
            await expect.poll(() => Buffer.concat(publicBytes).toString(), { timeout: 5000, message: 'the admitted public websocket reaches the real fixture' }).toContain('public fixture message');
            expect(Buffer.concat(publicBytes).toString()).toContain('101 Switching Protocols');
            const closed = once(publicClient, 'close');
            expect(publicRuntime.revokeExposure(created.exposure.exposureId, { actorId: 'user_1' })).toEqual({ ok: true });
            markPhase('public.revoke.close');
            await closed;
            const denied = await app.inject({ method: 'GET', url: publicUrl.pathname, headers: { host: publicUrl.host, cookie: publicCookie } });
            expect(denied.statusCode).toBe(403);
            const revokedAsset = await app.inject({ method: 'GET', url: '/asset.js', headers: { host: publicUrl.host, cookie: publicCookie } });
            expect(revokedAsset.statusCode).toBe(403);

            // Exercise the canonical afterTx Machine-loss event, not a public-link revoke.
            // Grant mutation is covered by the Machine-access owner; these viewer registrations
            // begin at its published loss-event boundary and retain the real relay/daemon sockets.
            // A product-managed occurrence uses its OS-assigned port even when arbitrary ports are denied.
            tunnelEnv.HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS = '';
            handlerOptions.allowedPorts = [];
            const machineService = LocalServicePreviewResourceV1Schema.parse({
                ...preview, previewId: 'preview_machine_service', sessionId: undefined,
                owner: { kind: 'user', id: 'user_1' },
                serviceTarget: { kind: 'managed_service', machineId: preview.machineId,
                    managedServiceId: 'instance_fixture', cwd: '/workspace/app',
                    declaration: { workspaceRefId: 'workspace_fixture', selection: { kind: 'manifest', name: 'web' } } },
            });
            const nativeService = registerLocalServicePreview(previewRegistry, machineService, { isCurrent: () => fixture.listening });
            if (!nativeService.ok) throw new Error(nativeService.reasonCode);
            const exchangeViewer = async (viewerAccountId: string) => {
                markPhase(`private.exchange.${viewerAccountId}`);
                const registration = runtime.registerPreview({ resource: nativeService.resource, accountId: 'user_1', viewerAccountId });
                if (!registration.ok || !registration.accessUrl) throw new Error('Machine viewer registration failed');
                const accessUrl = new URL(registration.accessUrl);
                const exchanged = await app.inject({ method: 'GET', url: accessUrl.pathname + accessUrl.search, headers: { host: accessUrl.host } });
                expect(exchanged.statusCode).toBe(303);
                const viewerCookie = String(exchanged.headers['set-cookie']).split(';')[0];
                return { host: accessUrl.host, cookie: viewerCookie, rawToken: decodeURIComponent(viewerCookie.slice(viewerCookie.indexOf('=') + 1)) };
            };
            const memberViewer = await exchangeViewer('member_1');
            const ownerViewer = await exchangeViewer('user_1');
            expect(memberViewer.cookie === ownerViewer.cookie).toBe(false);
            const connectPrivate = async (viewer: typeof ownerViewer, path: string, expected: string) => {
                const socket = connect(Number(listener.port), '127.0.0.1');
                privateClients.push(socket);
                const bytes: Buffer[] = [];
                const ready = createDeferred();
                const replied = createDeferred();
                const socketClosed = once(socket, 'close');
                // Preserve each rejection for its deciding await without orphaning unused observations.
                void ready.promise.catch(() => undefined);
                void replied.promise.catch(() => undefined);
                void socketClosed.catch(() => undefined);
                socket.on('data', chunk => {
                    bytes.push(chunk);
                    const received = Buffer.concat(bytes).toString();
                    if (received.includes(expected)) ready.resolve();
                    if (received.includes('fixture input received')) replied.resolve();
                });
                socket.once('error', error => { ready.reject(error); replied.reject(error); });
                socket.once('close', () => {
                    const error = new Error('Private preview closed before its expected response');
                    ready.reject(error);
                    replied.reject(error);
                });
                markPhase(`private.connect.${path}`);
                await once(socket, 'connect');
                socket.write(`GET ${path} HTTP/1.1\r\nHost: ${viewer.host}\r\nCookie: ${viewer.cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
                markPhase(`private.response.${path}`);
                await ready.promise;
                return { socket, bytes, closed: socketClosed, replied: replied.promise };
            };
            const memberSocket = await connectPrivate(memberViewer, '/member-socket', 'public fixture message');
            const ownerSocket = await connectPrivate(ownerViewer, '/owner-socket', 'public fixture message');
            expect(Buffer.concat(memberSocket.bytes).toString()).toContain('101 Switching Protocols');
            expect(Buffer.concat(ownerSocket.bytes).toString()).toContain('101 Switching Protocols');
            const memberUpstream = fixtureUpgradeSocketsByPath.get('/member-socket');
            const ownerUpstream = fixtureUpgradeSocketsByPath.get('/owner-socket');
            if (!memberUpstream || !ownerUpstream) throw new Error('Missing real private preview upstream');
            const memberUpstreamClosed = once(memberUpstream, 'close');
            void memberUpstreamClosed.catch(() => undefined);
            void memberSocket.closed.then(() => markPhase('private.member.downstream.closed'), () => undefined);
            void memberUpstreamClosed.then(() => markPhase('private.member.upstream.closed'), () => undefined);
            eventRouter.disconnectMachineAndSessionSockets({ accountId: 'member_1', machineId: machineService.machineId, sessionBindings: [] });
            const binding = localServicePreviewDirectBindingV1(nativeService.resource);
            expect(runtime.validateAccess({ ...binding, sessionId: nativeService.resource.sessionId, rawToken: memberViewer.rawToken })).toEqual({ ok: false, reasonCode: 'token_mismatch' });
            expect(runtime.validateAccess({ ...binding, sessionId: nativeService.resource.sessionId, rawToken: ownerViewer.rawToken })).toEqual({ ok: true });
            markPhase('private.member.close.wait');
            await Promise.all([memberSocket.closed, memberUpstreamClosed]);
            expect(ownerSocket.socket.destroyed).toBe(false);
            expect(fixtureUpgradeSockets.has(ownerUpstream)).toBe(true);
            // A masked browser frame must still reach the same native application after loss.
            ownerSocket.socket.write(Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0x6f, 0x6b]));
            markPhase('private.owner.roundtrip');
            await ownerSocket.replied;
            const withdrawnReconnect = await connectPrivate(memberViewer, '/member-reconnect', '401 Unauthorized');
            markPhase('private.member.reconnect.close');
            await withdrawnReconnect.closed;
            expect(Buffer.concat(withdrawnReconnect.bytes).toString()).not.toContain('101 Switching Protocols');
            markPhase('private.member.next.http');
            const memberRead = await app.inject({ method: 'GET', url: '/member-next-read', headers: { host: memberViewer.host, cookie: memberViewer.cookie } });
            expect(memberRead.statusCode).toBe(401);
            const ownerReconnect = await connectPrivate(ownerViewer, '/owner-reconnect', 'public fixture message');
            expect(Buffer.concat(ownerReconnect.bytes).toString()).toContain('101 Switching Protocols');
            markPhase('private.owner.next.http');
            const ownerRead = await app.inject({ method: 'GET', url: '/owner-still-running', headers: { host: ownerViewer.host, cookie: ownerViewer.cookie } });
            expect(ownerRead.statusCode).toBe(200);
            expect(ownerRead.body).toBe('fixture:/owner-still-running');
            expect(fixture.listening).toBe(true);
            expect(client.connected).toBe(true);
            expect(runtime.resolvePreview(machineService.previewId)).toEqual(nativeService.resource);
            markPhase('private.native.retained.resolve');
            expect(await resolveLocalServicePreviewApplication(previewRegistry, localServicePreviewDirectBindingV1(nativeService.resource))).toEqual(nativeService.resource);
            for (const socket of privateClients) socket.destroy();
            markPhase('private.complete');
            // The remaining Session-preview retirement control uses arbitrary-port admission.
            tunnelEnv.HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS = String(address.port);
            handlerOptions.allowedPorts = [address.port];

            // Hold the genuine publication HTTP boundary while the real daemon owner revokes.
            // Keep the server-issued route/cookie so refusal must reach the daemon gate;
            // deleting that outer route here would hide a resurrected daemon registration.
            const registrationStarted = createDeferred();
            const registrationReply = createDeferred<Readonly<{ data: unknown }>>();
            const previewRoutes = createLocalServicePreviewRoutes({ machineId: preview.machineId, accountId: 'user_1', registry: previewRegistry,
                server: { token: 'fixture-token', serverBaseUrl: publicBaseUrl, http: {
                    async post() { registrationStarted.resolve(); return registrationReply.promise; },
                    async delete() { return { data: { ok: true } }; },
                } },
            });
            const publication = previewRoutes.openOrCreate({ machineId: preview.machineId,
                launchTargetId: preview.previewId, sessionId: preview.sessionId });
            markPhase('session.publication.started');
            await registrationStarted.promise;
            markPhase('session.publication.revoke');
            expect(await previewRoutes.revoke({ machineId: preview.machineId, previewId: preview.previewId }))
                .toMatchObject({ ok: true, response: { revoked: true } });
            // End A and put B on its port before releasing the late publication response.
            for (const socket of fixtureUpgradeSockets) socket.destroy();
            fixture.closeAllConnections();
            markPhase('session.fixture.close');
            await new Promise<void>(resolve => fixture.close(() => resolve()));
            let replacementReads = 0;
            replacement = createServer((_request, response) => { replacementReads += 1; response.end('EXACT_B_BYTES'); });
            replacement.on('upgrade', (_request, socket) => { replacementReads += 1; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\nEXACT_B_BYTES'); });
            await new Promise<void>(resolve => replacement!.listen(address.port, '127.0.0.1', resolve));
            // The two existing origin configurations cover both late response outcomes.
            if (publicBaseUrl.startsWith('https:')) registrationReply.resolve({ data: {
                resource: preview, accessUrl: 'https://preview.example.test/', expiresAt: 61_000,
            } });
            else registrationReply.reject(new Error('registration failed after revoke'));
            markPhase('session.publication.reply');
            expect.soft(await publication).toEqual({ ok: false, reasonCode: 'preview_target_unresolved' });
            expect.soft(previewRegistry.previewsById.has(preview.previewId)).toBe(false);
            markPhase('session.retained.http');
            const retained = await app.inject({ method: 'GET', url: '/body', headers: { host: url.host, cookie } });
            expect(retained.body).not.toContain('EXACT_B_BYTES');
            expect(retained.statusCode).toBe(404);
            expect(retained.json()).toMatchObject({ error: 'preview_not_found', reasonCode: 'preview_not_found' });
            expect(replacementReads).toBe(0);
            retainedUpgradeClient = connect(Number(listener.port), '127.0.0.1');
            const upgradeBytes: Buffer[] = [];
            retainedUpgradeClient.on('data', bytes => upgradeBytes.push(bytes));
            const upgradeClosed = once(retainedUpgradeClient, 'close');
            await once(retainedUpgradeClient, 'connect');
            retainedUpgradeClient.write(`GET /socket HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
            markPhase('session.retained.upgrade.close');
            await upgradeClosed;
            expect(Buffer.concat(upgradeBytes).toString()).toContain('404 Not Found');
            expect(Buffer.concat(upgradeBytes).toString()).toContain('preview_not_found');
            expect(Buffer.concat(upgradeBytes).toString()).not.toContain('EXACT_B_BYTES');
            expect(replacementReads).toBe(0);
            completed = true;
        } catch (error) {
            throw new Error(`Preview transport phase: ${phase}; trace: ${JSON.stringify(wireTrace)}`, { cause: error });
        } finally {
            await cleanup();
        }
    });
});
