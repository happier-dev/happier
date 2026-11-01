import { describe, expect, it, vi } from 'vitest';
import {
    createDirectRouteGrantSigningInputV2,
    createEphemeralPeerRouteProofHandleV2,
    createSpeechTranscriptionApplicationAuthorityDigestV1,
    createPeerMediationObservabilityFlowStore,
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    type DirectRouteGrantPayloadV2,
    type PeerTcpTunnelOpenV2,
} from '@happier-dev/protocol';
import { createServer, type Socket } from 'node:net';
import { Agent, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import tweetnacl from 'tweetnacl';
import type { LocalServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { createLocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import { createLocalServicePreviewRegistry, registerLocalServicePreview } from '@/daemon/local/services/preview/registry';

import { createPeerMediationLoopbackApp } from '../loopback/server';
import { createDeferred } from '@/testkit/async/deferred';
import { createDaemonPeerMediationDirectFlowObserver } from '../observability/events';

const tunnelFlowScope = { kind: 'machine', accountId: 'account_1', machineId: 'machine_1' } as const;

type RegisterRoutesModule = typeof import('./registerRoutes');

async function loadRegisterRoutesModule(): Promise<RegisterRoutesModule | null> {
    const modulePath = './registerRoutes.js';
    return import(modulePath).catch(() => null) as Promise<RegisterRoutesModule | null>;
}

const loopbackOptions = {
    nowMs: () => 2_000,
    expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'tcp_tunnel' as const,
        routeKind: 'loopback_direct' as const,
        endpointFingerprint: 'endpoint_1',
    },
    trustRoots: [],
};

const testTunnelLimits = {
    maxIdleMs: 30_000,
    maxDurationMs: 120_000,
} as const;
const testVoiceMediaApplicationAuthority = {
    v: 1 as const,
    applicationKind: 'speech_transcription' as const,
    applicationAttemptId: 'request_1',
    applicationAuthorityDigest:
        createSpeechTranscriptionApplicationAuthorityDigestV1('request_1'),
};

const routeGrantKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const routeTrustRoots = [{
    keyId: 'key_1',
    publicKey: Buffer.from(routeGrantKeyPair.publicKey).toString('base64url'),
}] as const;

function createSignedDirectOpen(input: Readonly<{
    grantId: string;
    tunnelId: string;
    nonceByte?: number;
    endpointFingerprint?: string;
    signedTunnelId?: string;
    exp?: number;
    flowKind?: 'tcp_tunnel' | 'voice_media';
    destinationPort?: number;
    preview?: LocalServicePreviewDirectBindingV1;
}>): PeerTcpTunnelOpenV2 {
    const proofHandle = createEphemeralPeerRouteProofHandleV2({
        randomBytes: (length) => new Uint8Array(length).fill(length === 32 ? 9 : input.nonceByte ?? 3),
    });
    const endpointFingerprint = input.endpointFingerprint ?? (input.preview ? 'b'.repeat(64) : 'endpoint_1');
    const flowKind = input.flowKind ?? 'tcp_tunnel';
    const destinationPort = input.destinationPort ?? 3000;
    const payload: DirectRouteGrantPayloadV2 = {
        v: 2,
        grantId: input.grantId,
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind,
        routeKind: input.preview ? 'iroh_peer' : 'loopback_direct',
        scope: flowKind === 'voice_media'
            ? {
                kind: 'voice_media',
                tunnelId: input.signedTunnelId ?? input.tunnelId,
                applicationKind: 'speech_transcription',
                applicationAttemptId: 'request_1',
                applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
                maxIdleMs: 30_000,
                maxDurationMs: 300_000,
                maxTotalBytes: 4096,
            }
            : {
                kind: 'tcp_tunnel',
                tunnelId: input.signedTunnelId ?? input.tunnelId,
                allowedPorts: [destinationPort],
                ...(input.preview ? { preview: input.preview } : {}),
            },
        iat: 1_000,
        exp: input.preview ? null : input.exp ?? 601_000,
        aud: 'happier-daemon-route-grant',
        endpointFingerprint,
        proofKind: 'ephemeral_ed25519',
        ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url,
        ...(input.preview ? { iroh: {
            initiator: { kind: 'account_client' as const, endpointId: 'a'.repeat(64) },
            target: { machineId: 'machine_1', endpointId: endpointFingerprint }, operationKind: 'tcp_tunnel' as const,
        } } : {}),
    };
    const grant = {
        payload,
        signature: {
            keyId: 'key_1',
            alg: 'Ed25519' as const,
            valueBase64Url: Buffer.from(tweetnacl.sign.detached(
                Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
                routeGrantKeyPair.secretKey,
            )).toString('base64url'),
        },
    };
    try {
        return {
            v: 2, kind: 'open', tunnelId: input.tunnelId, targetMachineId: 'machine_1',
            routeKind: input.preview ? 'iroh_peer' : 'loopback_direct', destination: { host: '127.0.0.1', port: destinationPort },
            grant, proof: proofHandle.sign(grant),
        };
    } finally {
        proofHandle.dispose();
    }
}

function registerRealDirectOpenRoute(
    mod: RegisterRoutesModule,
    app: ReturnType<typeof createPeerMediationLoopbackApp>,
    input: Readonly<{
        nowMs?: () => number;
        resolveTrustRoots?: () => readonly { keyId: string; publicKey: string }[];
        connectTcp: NonNullable<Parameters<typeof mod.registerPeerTcpTunnelLoopbackRoutes>[1]['connectTcp']>;
        openStreamTimeoutMs?: number;
        voiceBinaryAppendConsumer?: NonNullable<Parameters<typeof mod.registerPeerTcpTunnelLoopbackRoutes>[1]['voiceBinaryAppendConsumer']>;
        voiceBinaryTerminalConsumer?: NonNullable<Parameters<typeof mod.registerPeerTcpTunnelLoopbackRoutes>[1]['voiceBinaryTerminalConsumer']>;
    }>,
): void {
    mod.registerPeerTcpTunnelLoopbackRoutes(app, {
        nowMs: input.nowMs ?? loopbackOptions.nowMs,
        expected: {
            accountId: 'account_1',
            machineId: 'machine_1',
            endpointFingerprint: 'endpoint_1',
        },
        trustRoots: routeTrustRoots,
        ...(input.resolveTrustRoots ? { resolveTrustRoots: input.resolveTrustRoots } : {}),
        connectTcp: input.connectTcp,
        ...(input.openStreamTimeoutMs !== undefined ? { openStreamTimeoutMs: input.openStreamTimeoutMs } : {}),
        ...(input.voiceBinaryAppendConsumer ? { voiceBinaryAppendConsumer: input.voiceBinaryAppendConsumer } : {}),
        ...(input.voiceBinaryTerminalConsumer ? { voiceBinaryTerminalConsumer: input.voiceBinaryTerminalConsumer } : {}),
    });
}

function waitForBinaryFrameKind(
    ws: Readonly<{
        on(event: 'message', handler: (payload: Buffer) => void): void;
        off(event: 'message', handler: (payload: Buffer) => void): void;
    }>,
    kind: 'data' | 'abort' | 'close',
): Promise<Buffer> {
    return new Promise((resolve) => {
        const handler = (payload: Buffer) => {
            const decoded = decodePeerTcpTunnelBinaryFrameV2({
                frame: payload,
                maxHeaderBytes: 1024,
                maxPayloadBytes: 1024,
            });
            if (!decoded.ok || decoded.header.kind !== kind) return;
            ws.off('message', handler);
            resolve(payload);
        };
        ws.on('message', handler);
    });
}

describe('registerPeerTcpTunnelLoopbackRoutes', () => {
    it('transfers pending preview custody from the POST socket to an idle signed-id WebSocket', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const binding: LocalServicePreviewDirectBindingV1 = {
            previewId: 'preview_1', machineId: 'machine_1', owner: { kind: 'user', id: 'account_1' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        };
        const registry = createLocalServicePreviewRegistry();
        expect(registerLocalServicePreview(registry, { ...binding, initialPath: { pathname: '/', search: '' },
            display: { title: 'Preview', addressLabel: 'loopback' }, originMode: 'host' }).ok).toBe(true);
        const registrations: PassThrough[] = [];
        const previewRoutes = createLocalServicePreviewRoutes({ machineId: 'machine_1', registry,
            server: { token: 'account-token', serverBaseUrl: 'https://home.test', http: {
                // Home HTTP is the genuine network boundary. Its strict registration
                // readiness bytes and disconnect are consumed by the real daemon owner.
                async post() {
                    const stream = new PassThrough();
                    registrations.push(stream);
                    queueMicrotask(() => stream.write(JSON.stringify({ v: 1, kind: 'preview_registration_admitted', previewId: 'preview_1' }) + '\n'));
                    return { data: stream };
                },
                async delete() { return { data: { ok: true } }; },
            } } });
        const flows = createPeerMediationObservabilityFlowStore({ nowMs: loopbackOptions.nowMs });
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        mod.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs, trustRoots: routeTrustRoots, maxActiveTunnels: 1,
            observability: createDaemonPeerMediationDirectFlowObserver({
                ...loopbackOptions.expected, nowMs: loopbackOptions.nowMs, observability: { emit: event => { flows.publish(event); } },
            }),
            expected: { accountId: 'account_1', machineId: 'machine_1', endpointFingerprint: 'endpoint_1', irohEndpointId: 'b'.repeat(64) },
            acquirePreviewApplication: previewRoutes.acquireNativeApplication,
        });
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        const agents: Agent[] = [];
        let ws: WebSocket | undefined;
        const open = async (id: string) => {
            const agent = new Agent({ keepAlive: true });
            agents.push(agent);
            let request: ReturnType<typeof httpRequest>;
            const response = new Promise<Readonly<{ status: number; body: unknown }>>((resolve, reject) => {
                request = httpRequest(`${origin}/peer-mediation/v2/tunnel/open`, { agent, method: 'POST',
                    headers: { connection: 'keep-alive', 'content-type': 'application/json' } }, (reply) => {
                    const chunks: Buffer[] = [];
                    reply.on('data', (bytes: Buffer) => chunks.push(bytes));
                    reply.on('end', () => resolve({ status: reply.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
                    reply.on('error', reject);
                });
                request.on('error', reject);
                request.end(JSON.stringify(createSignedDirectOpen({ grantId: id, tunnelId: id, destinationPort: 5173, preview: binding })));
            });
            return { ...(await response), socket: request!.socket! };
        };
        try {
            const pending = await open('pending_preview');
            expect(pending.status).toBe(200);
            // Native WS rejection/cancellation drops this held control socket before attachment.
            pending.socket.destroy();
            await vi.waitFor(() => expect(registrations[0]?.destroyed).toBe(true));
            expect(flows.snapshot(tunnelFlowScope).flows.find(flow => flow.flow.flowId === 'pending_preview')?.lifecycleState).toBe('closed');
            const attached = await open('attached_preview');
            expect(attached.status).toBe(200); // No abandoned adapter may occupy the sole admission slot.
            ws = new WebSocket(origin.replace('http:', 'ws:') + '/peer-mediation/v1/tunnel/stream?tunnelId=attached_preview');
            await once(ws, 'open');
            attached.socket.destroy();
            await once(attached.socket, 'close');
            expect(registrations[1]?.destroyed).toBe(false);
            registrations[1]!.destroy();
            await vi.waitFor(() => expect(ws?.readyState).toBe(WebSocket.CLOSED));
            expect(flows.snapshot(tunnelFlowScope).flows.find(flow => flow.flow.flowId === 'attached_preview')?.lifecycleState).toBe('aborted');
            for (const flowId of ['pending_preview', 'attached_preview']) {
                expect(flows.delta(tunnelFlowScope).events.filter(event => event.flow.flowId === flowId
                    && (event.kind === 'flow.closed' || event.kind === 'flow.aborted'))).toHaveLength(1);
            }
            // No application substream/frame or guest request was sent before revoke.
        } finally {
            ws?.terminate();
            for (const agent of agents) agent.destroy();
            for (const stream of registrations) stream.destroy();
            await app.close();
        }
    });

    it('drains the real signed child response and forwards TCP EOF after a request half-close', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const sockets: Socket[] = [];
        const received: Buffer[] = [];
        const destination = createServer({ allowHalfOpen: true }, (socket) => {
            sockets.push(socket);
            socket.on('data', (bytes) => received.push(Buffer.from(bytes)));
            socket.on('end', () => socket.end(Buffer.from([0, 255, 128, 1])));
        });
        await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
        const address = destination.address();
        if (!address || typeof address === 'string') throw new Error('expected TCP address');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        mod.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1', machineId: 'machine_1', endpointFingerprint: 'endpoint_1',
            },
            trustRoots: routeTrustRoots,
        });
        try {
            const opened = await app.inject({
                method: 'POST', url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({ grantId: 'grant_eof', tunnelId: 'tun_eof', destinationPort: address.port }),
            });
            expect(opened.statusCode).toBe(200);
            await app.ready();
            const ws = await (app as unknown as {
                injectWS: (path: string) => Promise<{
                    send: (payload: Uint8Array) => void;
                    on(event: 'message', handler: (payload: Buffer) => void): void;
                    off(event: 'message', handler: (payload: Buffer) => void): void;
                    terminate: () => void;
                }>;
            }).injectWS('/peer-mediation/v1/tunnel/stream');
            const response = waitForBinaryFrameKind(ws, 'data');
            const eof = waitForBinaryFrameKind(ws, 'close');
            ws.send(encodePeerTcpTunnelBinaryFrameV2({
                header: { version: 2, kind: 'open', tunnelId: 'tun_eof', substreamId: 'request', payloadLength: 0 },
            }));
            ws.send(encodePeerTcpTunnelBinaryFrameV2({
                header: { version: 2, kind: 'data', tunnelId: 'tun_eof', substreamId: 'request', direction: 'client_to_daemon', sequence: 0, payloadLength: 3 },
                payload: new Uint8Array([1, 0, 254]),
            }));
            ws.send(encodePeerTcpTunnelBinaryFrameV2({
                header: { version: 2, kind: 'close', tunnelId: 'tun_eof', substreamId: 'request', direction: 'client_to_daemon', halfClose: true, reasonCode: 'request_finished', payloadLength: 0 },
            }));
            const data = decodePeerTcpTunnelBinaryFrameV2({ frame: await response, maxHeaderBytes: 1024, maxPayloadBytes: 1024 });
            expect(data.ok ? [...data.payload] : null).toEqual([0, 255, 128, 1]);
            const close = decodePeerTcpTunnelBinaryFrameV2({ frame: await eof, maxHeaderBytes: 1024, maxPayloadBytes: 1024 });
            expect(close.ok ? close.header : null).toMatchObject({ substreamId: 'request', direction: 'daemon_to_client', halfClose: true });
            expect(Buffer.concat(received)).toEqual(Buffer.from([1, 0, 254]));
            await vi.waitFor(() => expect(sockets).toHaveLength(1));
            await vi.waitFor(() => expect(sockets[0]?.destroyed).toBe(true));
            ws.terminate();
        } finally {
            await app.close();
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => destination.close(() => resolve()));
        }
    });

    it.each(['close', 'abort', 'socket_loss'] as const)(
        'releases every real signed mux child and tunnel admission on %s',
        async (terminal) => {
            const sockets: Socket[] = [];
            const destination = createServer((socket) => {
                sockets.push(socket);
                socket.on('data', (bytes) => socket.write(bytes));
            });
            await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
            const address = destination.address();
            if (!address || typeof address === 'string') throw new Error('expected TCP address');
            const flows = createPeerMediationObservabilityFlowStore({ nowMs: loopbackOptions.nowMs });
            const app = createPeerMediationLoopbackApp({ ...loopbackOptions, trustRoots: routeTrustRoots,
                tunnel: {}, observability: { emit: event => { flows.publish(event); } } });
            const signedOpen = createSignedDirectOpen({
                grantId: `grant_${terminal}`, tunnelId: 'tun_real', destinationPort: address.port,
            });
            try {
                expect((await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload: signedOpen })).statusCode).toBe(200);
                expect(sockets).toHaveLength(0);
                await app.ready();
                const ws = await (app as unknown as {
                    injectWS: (path: string) => Promise<{
                        send: (payload: Uint8Array) => void;
                        on(event: 'message', handler: (payload: Buffer) => void): void;
                        off(event: 'message', handler: (payload: Buffer) => void): void;
                        terminate: () => void;
                    }>;
                }).injectWS('/peer-mediation/v1/tunnel/stream');
                for (const substreamId of ['first', 'second']) {
                    ws.send(encodePeerTcpTunnelBinaryFrameV2({
                        header: { version: 2, kind: 'open', tunnelId: 'tun_real', substreamId, payloadLength: 0 },
                    }));
                }
                const echoed = waitForBinaryFrameKind(ws, 'data');
                const bytes = new Uint8Array([0, 255, 1, 128]);
                ws.send(encodePeerTcpTunnelBinaryFrameV2({
                    header: { version: 2, kind: 'data', tunnelId: 'tun_real', substreamId: 'first', direction: 'client_to_daemon', sequence: 0, payloadLength: bytes.length },
                    payload: bytes,
                }));
                const decoded = decodePeerTcpTunnelBinaryFrameV2({ frame: await echoed, maxHeaderBytes: 1024, maxPayloadBytes: 1024 });
                expect(decoded.ok ? [...decoded.payload] : null).toEqual([...bytes]);
                await vi.waitFor(() => expect(sockets).toHaveLength(2));
                if (terminal === 'socket_loss') ws.terminate();
                else ws.send(encodePeerTcpTunnelBinaryFrameV2({
                    header: { version: 2, kind: terminal, tunnelId: 'tun_real', payloadLength: 0, reasonCode: 'consumer_closed', ...(terminal === 'close' ? { halfClose: false } : {}) },
                }));
                await vi.waitFor(() => expect(sockets.every((socket) => socket.destroyed)).toBe(true));
                const terminalKind = terminal === 'abort' ? 'flow.aborted' : 'flow.closed';
                await vi.waitFor(() => expect(flows.snapshot(tunnelFlowScope).flows[0]?.lifecycleState)
                    .toBe(terminal === 'abort' ? 'aborted' : 'closed'));
                expect(flows.delta(tunnelFlowScope).events.filter(event => event.kind === 'flow.closed' || event.kind === 'flow.aborted'))
                    .toMatchObject([{ kind: terminalKind }]);
                await vi.waitFor(async () => {
                    const next = await app.inject({
                        method: 'POST', url: '/peer-mediation/v2/tunnel/open',
                        payload: createSignedDirectOpen({ grantId: `replacement_${terminal}`, tunnelId: 'tun_real', destinationPort: address.port }),
                    });
                    expect(next.statusCode).toBe(200);
                });
                ws.terminate();
            } finally {
                await app.close();
                for (const socket of sockets) socket.destroy();
                await new Promise<void>((resolve) => destination.close(() => resolve()));
            }
        },
    );

    it.each(['timeout', 'shutdown'] as const)('settles a direct reservation once through the real flow fold on %s', async terminal => {
        const flows = createPeerMediationObservabilityFlowStore({ nowMs: loopbackOptions.nowMs });
        const app = createPeerMediationLoopbackApp({ ...loopbackOptions, trustRoots: routeTrustRoots,
            tunnel: { openStreamTimeoutMs: terminal === 'timeout' ? 10 : undefined },
            observability: { emit: event => { flows.publish(event); } } });
        try {
            expect((await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({ grantId: `grant_${terminal}`, tunnelId: `tun_${terminal}` }) })).statusCode).toBe(200);
            expect(flows.snapshot(tunnelFlowScope).flows[0]?.lifecycleState).toBe('ready');
            if (terminal === 'shutdown') await app.close();
            await vi.waitFor(() => expect(flows.snapshot(tunnelFlowScope).flows[0]?.lifecycleState).toBe(terminal === 'timeout' ? 'aborted' : 'closed'));
        } finally {
            await app.close();
        }
        expect(flows.delta(tunnelFlowScope).events.filter(event => event.kind === 'flow.closed' || event.kind === 'flow.aborted')).toHaveLength(1);
    });

    it('uses current Home signing roots for each tunnel open and fails closed when authority is unavailable', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connectTcp = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
        let currentTrustRoots: readonly { keyId: string; publicKey: string }[] = routeTrustRoots;
        registerRealDirectOpenRoute(mod, app, {
            connectTcp,
            resolveTrustRoots: () => currentTrustRoots,
        });

        try {
            currentTrustRoots = [];
            const unavailable = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({ grantId: 'grant_unavailable', tunnelId: 'tun_unavailable' }),
            });
            expect(unavailable.statusCode).toBe(400);
            expect(unavailable.json()).toMatchObject({ ok: false, reasonCode: 'grant_unknown_key' });
            expect(connectTcp).not.toHaveBeenCalled();

            currentTrustRoots = routeTrustRoots;
            const accepted = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({ grantId: 'grant_current', tunnelId: 'tun_current' }),
            });
            expect(accepted.statusCode).toBe(200);
            expect(connectTcp).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('admits typed direct Voice application readiness without opening a base TCP connection', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connectTcp = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
        registerRealDirectOpenRoute(mod, app, {
            connectTcp,
            voiceBinaryAppendConsumer: vi.fn(async () => ({ ok: true, ackSeq: 0, events: [] })),
        });

        try {
            const response = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: 'grant_voice_ready',
                    tunnelId: 'tun_voice_ready',
                    flowKind: 'voice_media',
                }),
            });

            expect(response.statusCode).toBe(200);
            expect(connectTcp).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('keeps a successfully activated direct grant consumed after the tunnel reservation closes', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connectTcp = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
        registerRealDirectOpenRoute(mod, app, { connectTcp, openStreamTimeoutMs: 5 });
        const payload = createSignedDirectOpen({ grantId: 'grant_replay', tunnelId: 'tun_replay' });

        try {
            const first = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload,
            });
            expect(first.statusCode).toBe(200);
            await new Promise((resolve) => setTimeout(resolve, 15));

            const replay = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: 'grant_replay',
                    tunnelId: 'tun_replay',
                    nonceByte: 4,
                }),
            });

            expect(replay.statusCode).toBe(400);
            expect(replay.json()).toMatchObject({ ok: false, reasonCode: 'grant_already_consumed' });
            expect(connectTcp).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('atomically consumes a verified direct grant so only one concurrent admission wins', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connectTcp = vi.fn(async () => ({ close: async () => undefined }));
        registerRealDirectOpenRoute(mod, app, { connectTcp });
        const payload = createSignedDirectOpen({ grantId: 'grant_concurrent', tunnelId: 'tun_concurrent' });

        try {
            const responses = await Promise.all([1, 2].map(() => app.inject({
                method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload,
            })));
            expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
            expect(responses.find((response) => response.statusCode !== 200)?.json()).toMatchObject({
                ok: false,
                reasonCode: expect.stringMatching(/grant_already_consumed|tunnel_id_already_open/),
            });
            expect(connectTcp).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('keeps a child TCP failure scoped to that child and retains consumed admission', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connectTcp = vi.fn()
            .mockRejectedValueOnce(new Error('refused'))
            .mockResolvedValueOnce({ close: vi.fn(async () => undefined) });
        registerRealDirectOpenRoute(mod, app, { connectTcp });
        const payload = createSignedDirectOpen({ grantId: 'grant_retry', tunnelId: 'tun_retry' });

        try {
            const admitted = await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload });
            expect(admitted.statusCode).toBe(200);
            expect(connectTcp).not.toHaveBeenCalled();
            await app.ready();
            const ws = await (app as unknown as {
                injectWS: (path: string) => Promise<{
                    send: (payload: Uint8Array) => void;
                    on(event: 'message', handler: (payload: Buffer) => void): void;
                    off(event: 'message', handler: (payload: Buffer) => void): void;
                    terminate: () => void;
                }>;
            }).injectWS('/peer-mediation/v1/tunnel/stream');
            const abort = waitForBinaryFrameKind(ws, 'abort');
            ws.send(encodePeerTcpTunnelBinaryFrameV2({
                header: { version: 2, kind: 'open', tunnelId: 'tun_retry', substreamId: 'failed', payloadLength: 0 },
            }));
            const failed = decodePeerTcpTunnelBinaryFrameV2({ frame: await abort, maxHeaderBytes: 1024, maxPayloadBytes: 1024 });
            expect(failed.ok ? failed.header : null).toMatchObject({ substreamId: 'failed', reasonCode: 'tcp_connect_failed' });
            expect(connectTcp).toHaveBeenCalledOnce();
            ws.send(encodePeerTcpTunnelBinaryFrameV2({
                header: { version: 2, kind: 'open', tunnelId: 'tun_retry', substreamId: 'healthy', payloadLength: 0 },
            }));
            await vi.waitFor(() => expect(connectTcp).toHaveBeenCalledTimes(2));
            ws.terminate();
            await vi.waitFor(async () => {
                const replay = await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload });
                expect(replay.json()).toMatchObject({ ok: false, reasonCode: 'grant_already_consumed' });
            });
        } finally {
            await app.close();
        }
    });

    it('checks signed tunnel scope before reservation and accepts the scoped retry', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connectTcp = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
        registerRealDirectOpenRoute(mod, app, { connectTcp });

        try {
            const mismatch = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: 'grant_scope',
                    tunnelId: 'tun_other',
                    signedTunnelId: 'tun_scope',
                }),
            });
            const scoped = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({ grantId: 'grant_scope', tunnelId: 'tun_scope' }),
            });

            expect(mismatch.json()).toMatchObject({ ok: false, reasonCode: 'grant_scope_mismatch' });
            expect(scoped.statusCode).toBe(200);
            expect(connectTcp).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('rejects a grant minted for a replaced endpoint before reservation and accepts a replacement grant', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connectTcp = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
        registerRealDirectOpenRoute(mod, app, { connectTcp });

        try {
            const oldEndpointGrant = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: 'grant_endpoint_replacement',
                    tunnelId: 'tun_endpoint_replacement',
                    endpointFingerprint: 'endpoint_old',
                }),
            });
            const replacementGrant = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: 'grant_endpoint_replacement',
                    tunnelId: 'tun_endpoint_replacement',
                    endpointFingerprint: 'endpoint_1',
                }),
            });

            expect(oldEndpointGrant.json()).toMatchObject({ ok: false, reasonCode: 'grant_endpoint_mismatch' });
            expect(replacementGrant.statusCode).toBe(200);
            expect(connectTcp).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('allows reconnect only with a newly minted grant after the prior tunnel closes', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connectTcp = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
        registerRealDirectOpenRoute(mod, app, { connectTcp, openStreamTimeoutMs: 5 });

        try {
            const first = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({ grantId: 'grant_first', tunnelId: 'tun_reconnect' }),
            });
            expect(first.statusCode).toBe(200);
            await new Promise((resolve) => setTimeout(resolve, 15));

            const reconnect = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({ grantId: 'grant_second', tunnelId: 'tun_reconnect' }),
            });

            expect(reconnect.statusCode).toBe(200);
            expect(connectTcp).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it('keeps an admitted direct Voice tunnel usable after grant expiry while rejecting a new admission', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        let nowMs = 2_000;
        const app = createPeerMediationLoopbackApp({ ...loopbackOptions, nowMs: () => nowMs });
        const connection = { close: vi.fn(async () => undefined) };
        const connectTcp = vi.fn(async () => connection);
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [],
        }));
        registerRealDirectOpenRoute(mod, app, { nowMs: () => nowMs, connectTcp, voiceBinaryAppendConsumer });
        const admitted = {
            ...createSignedDirectOpen({
                grantId: 'grant_lifetime',
                tunnelId: 'tun_lifetime',
                exp: 2_500,
                flowKind: 'voice_media',
            }),
            selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
        } as const;

        try {
            const opened = await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload: admitted });
            expect(opened.statusCode).toBe(200);
            expect(connectTcp).not.toHaveBeenCalled();
            await app.ready();
            const ws = await (app as unknown as {
                injectWS: (path: string) => Promise<{ send: (payload: Uint8Array) => void; terminate: () => void }>;
            }).injectWS('/peer-mediation/v1/tunnel/stream');

            nowMs = 3_000;
            ws.send(encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: 'data',
                    tunnelId: 'tun_lifetime',
                    substreamId: 'daemon.voiceInference.stt.stream-1.3',
                    direction: 'client_to_daemon',
                    sequence: 0,
                    payloadLength: 4,
                },
                payload: new Uint8Array([0, 0, 1, 0]),
            }));
            await vi.waitFor(() => expect(voiceBinaryAppendConsumer).toHaveBeenCalledOnce());

            const expiredAdmission = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: 'grant_expired_new',
                    tunnelId: 'tun_expired_new',
                    exp: 2_500,
                }),
            });
            expect(expiredAdmission.statusCode).toBe(400);
            expect(expiredAdmission.json()).toMatchObject({ ok: false, reasonCode: 'grant_expired' });
            ws.terminate();
        } finally {
            await app.close();
        }
    });

    it('fails duplicate tunnel route registration on one loopback Fastify app', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);

        expect(mod?.registerPeerTcpTunnelLoopbackRoutes).toBeTypeOf('function');
        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp: async () => ({ close: async () => undefined }),
        });

        expect(() => mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp: async () => ({ close: async () => undefined }),
        })).toThrow(/tunnel.*already registered/i);

        await app.close();
    });

    it('returns only the admitted open response from the control route', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connection = { close: vi.fn(async () => undefined) };
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: 'tun_1',
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            connection,
            limits: testTunnelLimits,
        }));

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp: async () => connection,
            openTunnel,
        });

        const response = await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_32890', tunnelId: 'tun_1' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_1',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            v: 1,
            tunnelId: 'tun_1',
            streamPath: '/peer-mediation/v1/tunnel/stream',
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            initialWindowBytes: 1024 * 1024,
            maxFrameBytes: 64 * 1024,
        });
        expect(openTunnel).toHaveBeenCalledOnce();

        await app.close();
    });

    it('evaluates nowMs for each tunnel open request instead of freezing route registration time', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        let nowMs = 2_000;
        const openTunnel = vi.fn(async (input) => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: (input.open as { tunnelId: string }).tunnelId,
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            connection: { close: async () => undefined },
            limits: testTunnelLimits,
        }));

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: () => nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp: async () => ({ close: async () => undefined }),
            openTunnel,
        });

        nowMs = 2_500;
        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_35082', tunnelId: 'tun_now' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_now',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
            },
        });

        expect(openTunnel).toHaveBeenCalledWith(expect.objectContaining({
            nowMs: 2_500,
        }));

        await app.close();
    });

    it('uses Fastify-owned websocket routing instead of attaching a raw upgrade listener', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const listenerCountBefore = app.server.listenerCount('upgrade');

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp: async () => ({ close: async () => undefined }),
        });

        expect(app.server.listenerCount('upgrade')).toBe(listenerCountBefore);

        await app.close();
    });

    it('bridges binary_frame_v2 loopback child frames without JSON/base64 socket payloads', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const writes: string[] = [];
        let resolveFirstWrite: (() => void) | undefined;
        const firstWrite = new Promise<void>((resolve) => {
            resolveFirstWrite = resolve;
        });
        let dataHandler: ((bytes: Uint8Array) => Promise<void> | void) | undefined;
        const connection = {
            write: vi.fn((bytes: Uint8Array) => {
                writes.push(Buffer.from(bytes).toString('utf8'));
                resolveFirstWrite?.();
            }),
            onData: vi.fn((handler: (bytes: Uint8Array) => Promise<void> | void) => {
                dataHandler = handler;
            }),
            close: vi.fn(async () => undefined),
        };
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: 'tun_binary',
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            destination: { host: '127.0.0.1', port: 3000 },
            limits: testTunnelLimits,
        }));

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp: async () => connection,
            openTunnel,
        });

        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_38365', tunnelId: 'tun_binary' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_binary',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
        });
        await app.ready();

        const ws = await (app as unknown as {
            injectWS: (path: string) => Promise<{
                send: (payload: Uint8Array) => void;
                once: (event: 'message', handler: (payload: Buffer) => void) => void;
                terminate: () => void;
            }>;
        }).injectWS('/peer-mediation/v1/tunnel/stream');
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: { version: 2, kind: 'open', tunnelId: 'tun_binary', substreamId: 'child', payloadLength: 0 },
        }));
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_binary',
                substreamId: 'child',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 5,
            },
            payload: Buffer.from('hello'),
        }));

        await firstWrite;
        expect(writes).toEqual(['hello']);
        expect(dataHandler).toBeTypeOf('function');
        const responseFrame = new Promise<Buffer>((resolve) => {
            ws.once('message', resolve);
        });
        await dataHandler?.(Buffer.from('world'));
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: await responseFrame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decoded.ok ? Buffer.from(decoded.payload).toString('utf8') : null).toBe('world');

        ws.terminate();
        await app.close();
    });

    it('bridges binary_frame_v2 loopback substreams over separate TCP connections', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const writesByConnection: string[][] = [];
        const dataHandlers: Array<(bytes: Uint8Array) => Promise<void> | void> = [];
        let resolveFirstWrite: (() => void) | undefined;
        const firstWrite = new Promise<void>((resolve) => {
            resolveFirstWrite = resolve;
        });
        const baseConnection = {
            close: vi.fn(async () => undefined),
        };
        const connectTcp = vi.fn(async () => {
            const index = writesByConnection.length;
            writesByConnection.push([]);
            return {
                write: vi.fn((bytes: Uint8Array) => {
                    writesByConnection[index]?.push(Buffer.from(bytes).toString('utf8'));
                    resolveFirstWrite?.();
                }),
                onData: vi.fn((handler: (bytes: Uint8Array) => Promise<void> | void) => {
                    dataHandlers[index] = handler;
                }),
                close: vi.fn(async () => undefined),
            };
        });
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: 'tun_mux',
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            // The open owner already normalized the bracketed loopback literal below; the mux
            // must dial that canonical destination instead of re-deriving one from the frame.
            destination: { host: '::1', port: 3000 },
            connection: baseConnection,
            limits: testTunnelLimits,
        }));

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp,
            openTunnel,
        });

        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_42855', tunnelId: 'tun_mux' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_mux',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '[::1]', port: 3000 },
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
        });
        await app.ready();

        const ws = await (app as unknown as {
            injectWS: (path: string) => Promise<{
                send: (payload: Uint8Array) => void;
                once: (event: 'message', handler: (payload: Buffer) => void) => void;
                terminate: () => void;
            }>;
        }).injectWS('/peer-mediation/v1/tunnel/stream');
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: { version: 2, kind: 'open', tunnelId: 'tun_mux', substreamId: 'sub_a', payloadLength: 0 },
        }));
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_mux',
                substreamId: 'sub_a',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 5,
            },
            payload: Buffer.from('hello'),
        }));

        await firstWrite;
        expect(connectTcp).toHaveBeenCalledOnce();
        expect(connectTcp).toHaveBeenCalledWith({ host: '::1', port: 3000 });
        expect(writesByConnection).toEqual([['hello']]);

        const responseFrame = new Promise<Buffer>((resolve) => {
            ws.once('message', resolve);
        });
        await dataHandlers[0]?.(Buffer.from('world'));
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: await responseFrame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decoded.ok ? decoded.header.substreamId : null).toBe('sub_a');
        expect(decoded.ok ? Buffer.from(decoded.payload).toString('utf8') : null).toBe('world');

        ws.terminate();
        await app.close();
    });

    it('dispatches voice-bound binary_frame_v2 substream data to the append consumer without opening a substream TCP socket', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const appended = createDeferred<Readonly<{
            streamId: string;
            generation: number;
            seq: number;
            pcm16Bytes: Uint8Array;
        }>>();
        const connection = {
            write: vi.fn(),
            close: vi.fn(async () => undefined),
        };
        const connectTcp = vi.fn(async () => ({
            write: vi.fn(),
            onData: vi.fn(),
            close: vi.fn(async () => undefined),
        }));
        const voiceBinaryAppendConsumer = vi.fn(async (input) => {
            appended.resolve(input);
            return {
                ok: true as const,
                streamId: input.streamId,
                generation: input.generation,
                ackSeq: input.seq,
                events: [],
            };
        });
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'voice_media' as const,
            voiceMediaApplicationAuthority: testVoiceMediaApplicationAuthority,
            response: {
                v: 1 as const,
                tunnelId: 'tun_voice',
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            connection,
            limits: testTunnelLimits,
        }));

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp,
            openTunnel,
            voiceBinaryAppendConsumer,
        });

        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_47212', tunnelId: 'tun_voice' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_voice',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
        });
        await app.ready();

        const ws = await (app as unknown as {
            injectWS: (path: string) => Promise<{
                send: (payload: Uint8Array) => void;
                terminate: () => void;
            }>;
        }).injectWS('/peer-mediation/v1/tunnel/stream');
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_voice',
                substreamId: 'daemon.voiceInference.stt.stream-1.3',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 4,
            },
            payload: new Uint8Array([0, 0, 1, 0]),
        }));

        await expect(appended.promise).resolves.toMatchObject({
            streamId: 'stream-1',
            generation: 3,
            seq: 0,
        });
        expect([...(await appended.promise).pcm16Bytes]).toEqual([0, 0, 1, 0]);
        expect(voiceBinaryAppendConsumer).toHaveBeenCalledOnce();
        expect(connectTcp).not.toHaveBeenCalled();
        expect(connection.write).not.toHaveBeenCalled();

        ws.terminate();
        await app.close();
    });

    it('settles the exact direct speech stream once when its websocket is lost', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [],
        }));
        const voiceBinaryTerminalConsumer = vi.fn(async () => ({ ok: true as const }));
        mod.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            openTunnel: vi.fn(async () => ({
                ok: true as const,
                routeKind: 'loopback_direct' as const,
                flowKind: 'voice_media' as const,
                voiceMediaApplicationAuthority: testVoiceMediaApplicationAuthority,
                response: {
                    v: 1 as const,
                    tunnelId: 'tun_voice_loss',
                    streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                    encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                    initialWindowBytes: 1024 * 1024,
                    maxFrameBytes: 64 * 1024,
                },
                receipt: 'peer.tunnel.opened' as const,
                limits: testTunnelLimits,
            })),
            voiceBinaryAppendConsumer,
            voiceBinaryTerminalConsumer,
        });
        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_50602', tunnelId: 'tun_voice_loss' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_voice_loss',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
        });
        await app.ready();
        const ws = await (app as unknown as {
            injectWS: (path: string) => Promise<{
                send: (payload: Uint8Array) => void;
                terminate: () => void;
            }>;
        }).injectWS('/peer-mediation/v1/tunnel/stream');
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_voice_loss',
                substreamId: 'daemon.voiceInference.stt.stream-loss.4',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 4,
            },
            payload: new Uint8Array([0, 0, 1, 0]),
        }));
        await vi.waitFor(() => expect(voiceBinaryAppendConsumer).toHaveBeenCalledOnce());

        ws.terminate();

        await vi.waitFor(() => expect(voiceBinaryTerminalConsumer).toHaveBeenCalledOnce());
        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledWith({
            streamId: 'stream-loss',
            generation: 4,
            substreamId: 'daemon.voiceInference.stt.stream-loss.4',
            reasonCode: 'tunnel_closed',
            voiceMediaApplicationAuthority: testVoiceMediaApplicationAuthority,
        });
        await app.close();
        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledOnce();
    });

    it('settles the authority-bound direct speech stream when a lost websocket expires before its first frame', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const voiceBinaryTerminalConsumer = vi.fn(async () => ({ ok: true as const }));
        mod.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            openStreamTimeoutMs: 10,
            openTunnel: vi.fn(async () => ({
                ok: true as const,
                routeKind: 'loopback_direct' as const,
                flowKind: 'voice_media' as const,
                voiceMediaApplicationAuthority: testVoiceMediaApplicationAuthority,
                response: {
                    v: 1 as const,
                    tunnelId: 'tun_voice_loss_before_frame',
                    streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                    encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                    initialWindowBytes: 1024 * 1024,
                    maxFrameBytes: 64 * 1024,
                },
                receipt: 'peer.tunnel.opened' as const,
                limits: testTunnelLimits,
            })),
            voiceBinaryAppendConsumer: vi.fn(),
            voiceBinaryTerminalConsumer,
        });
        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_54018', tunnelId: 'tun_voice_loss_before_frame' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_voice_loss_before_frame',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
        });
        await app.ready();
        const ws = await (app as unknown as {
            injectWS: (path: string) => Promise<{ terminate: () => void }>;
        }).injectWS('/peer-mediation/v1/tunnel/stream');

        ws.terminate();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledOnce();
        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledWith({
            reasonCode: 'tunnel_open_timeout',
            voiceMediaApplicationAuthority: testVoiceMediaApplicationAuthority,
        });
        await app.close();
        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledOnce();
    });

    it('terminates a recoverably identified Voice substream when its direct binary payload is malformed', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connection = { write: vi.fn(), onData: vi.fn(), close: vi.fn(async () => undefined) };
        const voiceBinaryAppendConsumer = vi.fn();
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'voice_media' as const,
            voiceMediaApplicationAuthority: testVoiceMediaApplicationAuthority,
            response: {
                v: 1 as const,
                tunnelId: 'tun_voice_malformed',
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            connection,
            limits: testTunnelLimits,
        }));
        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: loopbackOptions.expected,
            trustRoots: [],
            connectTcp: vi.fn(async () => connection),
            openTunnel,
            voiceBinaryAppendConsumer,
        });
        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_56572', tunnelId: 'tun_voice_malformed' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_voice_malformed',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
        });
        await app.ready();

        const ws = await (app as unknown as {
            injectWS: (path: string) => Promise<{
                send: (payload: Uint8Array) => void;
                once: (event: 'message', handler: (payload: Buffer) => void) => void;
                terminate: () => void;
            }>;
        }).injectWS('/peer-mediation/v1/tunnel/stream');
        const terminalFrame = new Promise<Buffer>((resolve) => ws.once('message', resolve));
        const validFrame = encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_voice_malformed',
                substreamId: 'daemon.voiceInference.stt.stream-1.3',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 4,
            },
            payload: new Uint8Array([0, 0, 1, 0]),
        });
        ws.send(validFrame.subarray(0, validFrame.byteLength - 1));

        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: await terminalFrame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decoded.ok ? decoded.header : null).toMatchObject({
            kind: 'abort',
            tunnelId: 'tun_voice_malformed',
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            reasonCode: 'frame_invalid',
        });
        expect(voiceBinaryAppendConsumer).not.toHaveBeenCalled();
        expect(connection.close).not.toHaveBeenCalled();

        ws.terminate();
        await app.close();
    });

    it('returns voice binary append events on the same loopback substream without touching TCP', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connection = {
            write: vi.fn(),
            onData: vi.fn(),
            close: vi.fn(async () => undefined),
        };
        const connectTcp = vi.fn(async () => connection);
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [{ type: 'partial', seq: input.seq, text: 'hel', isEndpoint: false, confidence: null }],
        }));
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'voice_media' as const,
            voiceMediaApplicationAuthority: testVoiceMediaApplicationAuthority,
            response: {
                v: 1 as const,
                tunnelId: 'tun_voice_response',
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            connection,
            limits: testTunnelLimits,
        }));

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp,
            openTunnel,
            voiceBinaryAppendConsumer,
        });

        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_60516', tunnelId: 'tun_voice_response' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_voice_response',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
        });
        await app.ready();

        const ws = await (app as unknown as {
            injectWS: (path: string) => Promise<{
                send: (payload: Uint8Array) => void;
                on: (event: 'message', handler: (payload: Buffer) => void) => void;
                off: (event: 'message', handler: (payload: Buffer) => void) => void;
                terminate: () => void;
            }>;
        }).injectWS('/peer-mediation/v1/tunnel/stream');
        const responseFrame = waitForBinaryFrameKind(ws, 'data');
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_voice_response',
                substreamId: 'daemon.voiceInference.stt.stream-1.3',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 4,
            },
            payload: new Uint8Array([0, 0, 1, 0]),
        }));

        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: await responseFrame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decoded.ok ? decoded.header : null).toMatchObject({
            kind: 'data',
            tunnelId: 'tun_voice_response',
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            direction: 'daemon_to_client',
            sequence: 0,
        });
        expect(decoded.ok ? JSON.parse(Buffer.from(decoded.payload).toString('utf8')) : null).toEqual({
            ok: true,
            streamId: 'stream-1',
            generation: 3,
            ackSeq: 0,
            events: [{ type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null }],
        });
        expect(voiceBinaryAppendConsumer).toHaveBeenCalledOnce();
        expect(connectTcp).not.toHaveBeenCalled();
        expect(connection.write).not.toHaveBeenCalled();

        ws.terminate();
        await app.close();
    });

    it('meters loopback voice request and response bytes before emitting the response and removes the terminal route', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connection = {
            write: vi.fn(),
            onData: vi.fn(),
            close: vi.fn(async () => undefined),
        };
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [],
        }));
        const openTunnel = vi.fn(async (input) => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'voice_media' as const,
            voiceMediaApplicationAuthority: testVoiceMediaApplicationAuthority,
            response: {
                v: 1 as const,
                tunnelId: (input.open as { tunnelId: string }).tunnelId,
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            connection,
            limits: { ...testTunnelLimits, maxTotalBytes: 4 },
        }));

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp: vi.fn(async () => connection),
            openTunnel,
            voiceBinaryAppendConsumer,
        });

        const openPayload = {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_64701', tunnelId: 'tun_voice_aggregate' }),
            v: 2,
            kind: 'open',
            tunnelId: 'tun_voice_aggregate',
            targetMachineId: 'machine_1',
            routeKind: 'loopback_direct',
            destination: { host: '127.0.0.1', port: 3000 },
            selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        } as const;
        await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload: openPayload });
        await app.ready();

        const ws = await (app as unknown as {
            injectWS: (path: string) => Promise<{
                send: (payload: Uint8Array) => void;
                on: (event: 'message', handler: (payload: Buffer) => void) => void;
                off: (event: 'message', handler: (payload: Buffer) => void) => void;
                terminate: () => void;
            }>;
        }).injectWS('/peer-mediation/v1/tunnel/stream');
        const terminalFrame = waitForBinaryFrameKind(ws, 'abort');
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_voice_aggregate',
                substreamId: 'daemon.voiceInference.stt.stream-1.3',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 4,
            },
            payload: new Uint8Array([0, 0, 1, 0]),
        }));

        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: await terminalFrame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decoded.ok ? decoded.header : null).toMatchObject({
            kind: 'abort',
            tunnelId: 'tun_voice_aggregate',
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            reasonCode: 'substream_cap_exceeded',
        });
        expect(voiceBinaryAppendConsumer).toHaveBeenCalledOnce();
        expect(connection.close).not.toHaveBeenCalled();

        const reopened = await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: openPayload,
        });
        expect(reopened.statusCode).toBe(200);

        ws.terminate();
        await app.close();
    });

    it('leaves non-voice binary_frame_v2 substreams on the normal TCP tunnel path when a voice consumer is installed', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const writesByConnection: string[][] = [];
        let resolveFirstWrite: (() => void) | undefined;
        const firstWrite = new Promise<void>((resolve) => {
            resolveFirstWrite = resolve;
        });
        const connectTcp = vi.fn(async () => {
            const index = writesByConnection.length;
            writesByConnection.push([]);
            return {
                write: vi.fn((bytes: Uint8Array) => {
                    writesByConnection[index]?.push(Buffer.from(bytes).toString('utf8'));
                    resolveFirstWrite?.();
                }),
                onData: vi.fn(),
                close: vi.fn(async () => undefined),
            };
        });
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [],
        }));
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: 'tun_non_voice',
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            destination: { host: '127.0.0.1', port: 3000 },
            connection: { close: vi.fn(async () => undefined) },
            limits: testTunnelLimits,
        }));

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp,
            openTunnel,
            voiceBinaryAppendConsumer,
        });

        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_69373', tunnelId: 'tun_non_voice' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_non_voice',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
        });
        await app.ready();

        const ws = await (app as unknown as {
            injectWS: (path: string) => Promise<{
                send: (payload: Uint8Array) => void;
                terminate: () => void;
            }>;
        }).injectWS('/peer-mediation/v1/tunnel/stream');
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: { version: 2, kind: 'open', tunnelId: 'tun_non_voice', substreamId: 'ordinary-substream', payloadLength: 0 },
        }));
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_non_voice',
                substreamId: 'ordinary-substream',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 5,
            },
            payload: Buffer.from('hello'),
        }));

        await firstWrite;
        expect(voiceBinaryAppendConsumer).not.toHaveBeenCalled();
        expect(connectTcp).toHaveBeenCalledOnce();
        expect(writesByConnection).toEqual([['hello']]);

        ws.terminate();
        await app.close();
    });

    it('rejects duplicate active tunnel ids before opening another TCP connection', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: 'tun_1',
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            connection: { close: async () => undefined },
            limits: testTunnelLimits,
        }));

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp: async () => ({ close: async () => undefined }),
            openTunnel,
        });

        const payload = {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_72153', tunnelId: 'tun_1' }),
            v: 2,
            kind: 'open',
            tunnelId: 'tun_1',
            targetMachineId: 'machine_1',
            routeKind: 'loopback_direct',
            destination: { host: '127.0.0.1', port: 3000 },
        };

        expect((await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload })).statusCode).toBe(200);
        const duplicate = await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload });

        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.json()).toMatchObject({
            ok: false,
            reasonCode: 'tunnel_id_already_open',
        });
        expect(openTunnel).toHaveBeenCalledOnce();

        await app.close();
    });

    it('enforces a direct active tunnel cap before opening TCP connections', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const openTunnel = vi.fn(async (input) => ({
            ok: true as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: (input.open as { tunnelId: string }).tunnelId,
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                initialWindowBytes: 1024 * 1024,
                maxFrameBytes: 64 * 1024,
            },
            receipt: 'peer.tunnel.opened' as const,
            connection: { close: async () => undefined },
            limits: testTunnelLimits,
        }));
        const options = {
            nowMs: loopbackOptions.nowMs,
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp: async () => ({ close: async () => undefined }),
            openTunnel,
            maxActiveTunnels: 1,
        } satisfies Parameters<NonNullable<typeof mod>['registerPeerTcpTunnelLoopbackRoutes']>[1] & { maxActiveTunnels: number };

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, options);

        const first = await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_74505', tunnelId: 'tun_1' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_1',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
            },
        });
        const second = await app.inject({
            method: 'POST',
            url: '/peer-mediation/v2/tunnel/open',
            payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_74919', tunnelId: 'tun_2' }),
                v: 2,
                kind: 'open',
                tunnelId: 'tun_2',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3001 },
            },
        });

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(429);
        expect(second.json()).toMatchObject({
            ok: false,
            reasonCode: 'direct_tunnel_cap_exceeded',
        });
        expect(openTunnel).toHaveBeenCalledOnce();

        await app.close();
    });

    it('frees an admitted tunnel when no websocket stream claims it before the admission timeout', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const firstConnection = { close: vi.fn(async () => undefined) };
        const secondConnection = { close: vi.fn(async () => undefined) };
        const connections = [firstConnection, secondConnection];
        const openTunnel = vi.fn(async (input) => {
            const connection = connections.shift() ?? { close: vi.fn(async () => undefined) };
            return {
                ok: true as const,
                routeKind: 'loopback_direct' as const,
                flowKind: 'tcp_tunnel' as const,
                response: {
                    v: 1 as const,
                    tunnelId: (input.open as { tunnelId: string }).tunnelId,
                    streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                    encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                    initialWindowBytes: 1024 * 1024,
                    maxFrameBytes: 64 * 1024,
                },
                receipt: 'peer.tunnel.opened' as const,
                connection,
                limits: testTunnelLimits,
            };
        });

        try {
            mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
                nowMs: loopbackOptions.nowMs,
                expected: {
                    accountId: 'account_1',
                    machineId: 'machine_1',
                    endpointFingerprint: 'endpoint_1',
                },
                trustRoots: [],
                connectTcp: async () => ({ close: async () => undefined }),
                openTunnel,
                maxActiveTunnels: 1,
                openStreamTimeoutMs: 10,
            } satisfies Parameters<NonNullable<typeof mod>['registerPeerTcpTunnelLoopbackRoutes']>[1] & {
                openStreamTimeoutMs: number;
            });

            const first = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_77614', tunnelId: 'tun_1' }),
                    v: 2,
                    kind: 'open',
                    tunnelId: 'tun_1',
                    targetMachineId: 'machine_1',
                    routeKind: 'loopback_direct',
                    destination: { host: '127.0.0.1', port: 3000 },
                },
            });
            expect(first.statusCode).toBe(200);

            await new Promise((resolve) => setTimeout(resolve, 20));

            const second = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: {
            ...createSignedDirectOpen({ grantId: 'grant_fixture_78195', tunnelId: 'tun_2' }),
                    v: 2,
                    kind: 'open',
                    tunnelId: 'tun_2',
                    targetMachineId: 'machine_1',
                    routeKind: 'loopback_direct',
                    destination: { host: '127.0.0.1', port: 3001 },
                },
            });

            expect(firstConnection.close).not.toHaveBeenCalled();
            expect(second.statusCode).toBe(200);
            expect(openTunnel).toHaveBeenCalledTimes(2);
        } finally {
            await app.close();
        }
    });

    // Exercise the production dialer at the signed route: only real mux children connect.
    it('opens no TCP socket for voice tunnels and leaks none for TCP tunnels across repeated open/close cycles', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');

        const acceptedSockets: Socket[] = [];
        const destination = createServer((socket) => {
            acceptedSockets.push(socket);
        });
        await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
        const address = destination.address();
        if (typeof address === 'string' || address === null) throw new Error('expected a TCP address');
        const destinationPort = address.port;

        const cycles = 6;
        /**
         * One full open -> WS-connect -> terminate -> close cycle against a fresh app, using the
         * PRODUCTION dialer (no injected `connectTcp`).
         */
        const runCycle = async (params: Readonly<{
            label: string;
            flowKind?: 'tcp_tunnel' | 'voice_media';
        }>) => {
            const app = createPeerMediationLoopbackApp(loopbackOptions);
            mod.registerPeerTcpTunnelLoopbackRoutes(app, {
                nowMs: loopbackOptions.nowMs,
                expected: {
                    accountId: 'account_1',
                    machineId: 'machine_1',
                    endpointFingerprint: 'endpoint_1',
                },
                trustRoots: routeTrustRoots,
                ...(params.flowKind === 'voice_media'
                    ? { voiceBinaryAppendConsumer: vi.fn(async () => ({ ok: true, ackSeq: 0, events: [] })) }
                    : {}),
            });
            const response = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v2/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: `grant_${params.label}`,
                    tunnelId: `tun_${params.label}`,
                    ...(params.flowKind ? { flowKind: params.flowKind } : {}),
                    destinationPort,
                }),
            });
            expect(response.statusCode).toBe(200);
            await app.ready();
            const ws = await (app as unknown as {
                injectWS: (path: string) => Promise<{ send: (payload: Uint8Array) => void; terminate: () => void }>;
            }).injectWS('/peer-mediation/v1/tunnel/stream');
            if (params.flowKind !== 'voice_media') {
                const before = acceptedSockets.length;
                ws.send(encodePeerTcpTunnelBinaryFrameV2({
                    header: { version: 2, kind: 'open', tunnelId: `tun_${params.label}`, substreamId: 'child', payloadLength: 0 },
                }));
                await vi.waitFor(() => expect(acceptedSockets).toHaveLength(before + 1));
            }
            ws.terminate();
            await app.close();
        };
        /**
         * The listener's `connection` event is delivered on a later tick than the dialer's resolve,
         * so every count is read through `waitFor`. Asserting the raw length immediately is what
         * makes this measurement flaky under host load rather than wrong.
         */
        const awaitAcceptedCount = async (expected: number) => {
            await vi.waitFor(() => {
                expect(acceptedSockets).toHaveLength(expected);
            }, { timeout: 10_000 });
        };

        try {
            // Positive control first: N `tcp_tunnel` cycles must open exactly N real sockets. If
            // this half ever reads 0, the harness is not measuring anything and the voice half
            // below would pass vacuously.
            for (let cycle = 0; cycle < cycles; cycle += 1) {
                await runCycle({ label: `tcp_cycle_${cycle}` });
            }
            await awaitAcceptedCount(cycles);

            // Voice: N full cycles must add nothing.
            for (let cycle = 0; cycle < cycles; cycle += 1) {
                await runCycle({ label: `voice_cycle_${cycle}`, flowKind: 'voice_media' });
            }

            // Barrier: one more `tcp_tunnel` cycle. Once ITS connection has been observed, every
            // connection the voice cycles could have opened earlier has also been observed — so
            // "exactly one more" is a real zero for voice, not a race that has not landed yet.
            await runCycle({ label: 'tcp_barrier' });
            await awaitAcceptedCount(cycles + 1);
            expect(acceptedSockets).toHaveLength(cycles + 1);

            // Nothing the tunnel opened stays open after its cycle closed.
            await vi.waitFor(() => {
                expect(acceptedSockets.filter((socket) => !socket.destroyed && socket.writable)).toHaveLength(0);
            }, { timeout: 10_000 });
        } finally {
            for (const socket of acceptedSockets) socket.destroy();
            await new Promise<void>((resolve) => destination.close(() => resolve()));
        }
    });
});
