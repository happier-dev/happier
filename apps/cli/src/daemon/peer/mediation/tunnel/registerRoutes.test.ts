import { describe, expect, it, vi } from 'vitest';
import {
    createDirectRouteGrantSigningInputV1,
    createSpeechTranscriptionApplicationAuthorityDigestV1,
    createPeerRouteNonceSigningInputV1,
    decodeVoiceMediaAgentRealtimeFrameV1,
    decodePeerTcpTunnelBinaryFrameV2,
    encodeVoiceMediaAgentRealtimeFrameV1,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1,
    type DirectRouteGrantPayloadV1,
    type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';

import { createPeerMediationLoopbackApp } from '../loopback/server';

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
        accountPublicKey: Buffer.from(new Uint8Array(32)).toString('base64url'),
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
const routeAccountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
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
}>): PeerTcpTunnelOpenV1 {
    const endpointFingerprint = input.endpointFingerprint ?? 'endpoint_1';
    const flowKind = input.flowKind ?? 'tcp_tunnel';
    const payload: DirectRouteGrantPayloadV1 = {
        v: 1,
        grantId: input.grantId,
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind,
        routeKind: 'loopback_direct',
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
                allowedPorts: [3000],
                maxIdleMs: 30_000,
                maxDurationMs: 300_000,
                maxTotalBytes: 4096,
            },
        iat: 1_000,
        exp: input.exp ?? 601_000,
        aud: 'happier-daemon-route-grant',
        endpointFingerprint,
    };
    const nonceBase64Url = Buffer.from(new Uint8Array(32).fill(input.nonceByte ?? 3)).toString('base64url');
    return {
        v: 1,
        kind: 'open',
        tunnelId: input.tunnelId,
        targetMachineId: 'machine_1',
        routeKind: 'loopback_direct',
        destination: { host: '127.0.0.1', port: 3000 },
        grant: {
            payload,
            signature: {
                keyId: 'key_1',
                alg: 'Ed25519',
                valueBase64Url: Buffer.from(tweetnacl.sign.detached(
                    Buffer.from(createDirectRouteGrantSigningInputV1(payload), 'utf8'),
                    routeGrantKeyPair.secretKey,
                )).toString('base64url'),
            },
        },
        nonceProof: {
            v: 1,
            grantId: payload.grantId,
            routeKind: payload.routeKind,
            flowKind: payload.flowKind,
            endpointFingerprint,
            nonceBase64Url,
            signatureBase64Url: Buffer.from(tweetnacl.sign.detached(
                Buffer.from(createPeerRouteNonceSigningInputV1({
                    grantId: payload.grantId,
                    routeKind: payload.routeKind,
                    flowKind: payload.flowKind,
                    endpointFingerprint,
                    nonceBase64Url,
                }), 'utf8'),
                routeAccountKeyPair.secretKey,
            )).toString('base64url'),
        },
    };
}

function registerRealDirectOpenRoute(
    mod: RegisterRoutesModule,
    app: ReturnType<typeof createPeerMediationLoopbackApp>,
    input: Readonly<{
        nowMs?: () => number;
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
            accountPublicKey: Buffer.from(routeAccountKeyPair.publicKey).toString('base64url'),
        },
        trustRoots: routeTrustRoots,
        connectTcp: input.connectTcp,
        ...(input.openStreamTimeoutMs !== undefined ? { openStreamTimeoutMs: input.openStreamTimeoutMs } : {}),
        ...(input.voiceBinaryAppendConsumer ? { voiceBinaryAppendConsumer: input.voiceBinaryAppendConsumer } : {}),
        ...(input.voiceBinaryTerminalConsumer ? { voiceBinaryTerminalConsumer: input.voiceBinaryTerminalConsumer } : {}),
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function waitForBinaryFrameKind(
    ws: Readonly<{
        on(event: 'message', handler: (payload: Buffer) => void): void;
        off(event: 'message', handler: (payload: Buffer) => void): void;
    }>,
    kind: 'data' | 'abort',
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
                url: '/peer-mediation/v1/tunnel/open',
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
                url: '/peer-mediation/v1/tunnel/open',
                payload,
            });
            expect(first.statusCode).toBe(200);
            await new Promise((resolve) => setTimeout(resolve, 15));

            const replay = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v1/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: 'grant_replay',
                    tunnelId: 'tun_replay',
                    nonceByte: 4,
                }),
            });

            expect(replay.statusCode).toBe(400);
            expect(replay.json()).toMatchObject({ ok: false, reasonCode: 'grant_already_consumed' });
            expect(connectTcp).toHaveBeenCalledOnce();
        } finally {
            await app.close();
        }
    });

    it('atomically reserves a verified direct grant so only one concurrent TCP activation wins', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const activation = deferred<Readonly<{ close: () => Promise<void> }>>();
        const connectTcp = vi.fn(() => activation.promise);
        registerRealDirectOpenRoute(mod, app, { connectTcp });
        const payload = createSignedDirectOpen({ grantId: 'grant_concurrent', tunnelId: 'tun_concurrent' });

        try {
            const firstRequest = app.inject({
                method: 'POST',
                url: '/peer-mediation/v1/tunnel/open',
                payload,
            });
            await vi.waitFor(() => expect(connectTcp).toHaveBeenCalledOnce());
            const secondRequest = app.inject({
                method: 'POST',
                url: '/peer-mediation/v1/tunnel/open',
                payload,
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            activation.resolve({ close: async () => undefined });

            const responses = await Promise.all([firstRequest, secondRequest]);
            expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
            expect(responses.map((response) => response.json())).toContainEqual(expect.objectContaining({
                ok: false,
                reasonCode: 'grant_already_consumed',
            }));
            expect(connectTcp).toHaveBeenCalledOnce();
        } finally {
            await app.close();
        }
    });

    it('keeps a direct grant consumed when TCP activation fails before a connection is returned', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connectTcp = vi.fn()
            .mockRejectedValueOnce(new Error('refused'))
            .mockResolvedValueOnce({ close: vi.fn(async () => undefined) });
        registerRealDirectOpenRoute(mod, app, { connectTcp });
        const payload = createSignedDirectOpen({ grantId: 'grant_retry', tunnelId: 'tun_retry' });

        try {
            const failed = await app.inject({ method: 'POST', url: '/peer-mediation/v1/tunnel/open', payload });
            const retry = await app.inject({ method: 'POST', url: '/peer-mediation/v1/tunnel/open', payload });

            expect(failed.json()).toMatchObject({ ok: false, reasonCode: 'tcp_connect_failed' });
            expect(retry.statusCode).toBe(400);
            expect(retry.json()).toMatchObject({ ok: false, reasonCode: 'grant_already_consumed' });
            expect(connectTcp).toHaveBeenCalledOnce();
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
                url: '/peer-mediation/v1/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: 'grant_scope',
                    tunnelId: 'tun_other',
                    signedTunnelId: 'tun_scope',
                }),
            });
            const scoped = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v1/tunnel/open',
                payload: createSignedDirectOpen({ grantId: 'grant_scope', tunnelId: 'tun_scope' }),
            });

            expect(mismatch.json()).toMatchObject({ ok: false, reasonCode: 'grant_scope_mismatch' });
            expect(scoped.statusCode).toBe(200);
            expect(connectTcp).toHaveBeenCalledOnce();
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
                url: '/peer-mediation/v1/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: 'grant_endpoint_replacement',
                    tunnelId: 'tun_endpoint_replacement',
                    endpointFingerprint: 'endpoint_old',
                }),
            });
            const replacementGrant = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v1/tunnel/open',
                payload: createSignedDirectOpen({
                    grantId: 'grant_endpoint_replacement',
                    tunnelId: 'tun_endpoint_replacement',
                    endpointFingerprint: 'endpoint_1',
                }),
            });

            expect(oldEndpointGrant.json()).toMatchObject({ ok: false, reasonCode: 'grant_endpoint_mismatch' });
            expect(replacementGrant.statusCode).toBe(200);
            expect(connectTcp).toHaveBeenCalledOnce();
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
                url: '/peer-mediation/v1/tunnel/open',
                payload: createSignedDirectOpen({ grantId: 'grant_first', tunnelId: 'tun_reconnect' }),
            });
            expect(first.statusCode).toBe(200);
            await new Promise((resolve) => setTimeout(resolve, 15));

            const reconnect = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v1/tunnel/open',
                payload: createSignedDirectOpen({ grantId: 'grant_second', tunnelId: 'tun_reconnect' }),
            });

            expect(reconnect.statusCode).toBe(200);
            expect(connectTcp).toHaveBeenCalledTimes(2);
        } finally {
            await app.close();
        }
    });

    it('does not consume a grant during loopback probe before the direct open', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const signedOpen = createSignedDirectOpen({ grantId: 'grant_probe', tunnelId: 'tun_probe' });
        const app = createPeerMediationLoopbackApp({
            nowMs: loopbackOptions.nowMs,
            expected: {
                ...loopbackOptions.expected,
                accountPublicKey: Buffer.from(routeAccountKeyPair.publicKey).toString('base64url'),
            },
            trustRoots: routeTrustRoots,
        });
        const connectTcp = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
        registerRealDirectOpenRoute(mod, app, { connectTcp });

        try {
            const probe = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v1/probe',
                payload: { v: 1, grant: signedOpen.grant, nonceProof: signedOpen.nonceProof },
            });
            const opened = await app.inject({
                method: 'POST',
                url: '/peer-mediation/v1/tunnel/open',
                payload: signedOpen,
            });

            expect(probe.json()).toMatchObject({ ok: true, endpointFingerprint: 'endpoint_1' });
            expect(opened.statusCode).toBe(200);
            expect(connectTcp).toHaveBeenCalledOnce();
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
            supportedEncodings: ['json_base64_v1', PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
        } as const;

        try {
            const opened = await app.inject({ method: 'POST', url: '/peer-mediation/v1/tunnel/open', payload: admitted });
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
                url: '/peer-mediation/v1/tunnel/open',
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

    it('returns only the open response from the control route and retains the TCP connection for the stream path', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connection = { close: vi.fn(async () => undefined) };
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: 'tun_1',
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: 'json_base64_v1' as const,
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
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
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
            encoding: 'json_base64_v1',
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
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: (input.open as { tunnelId: string }).tunnelId,
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: 'json_base64_v1' as const,
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
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
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

    it('bridges binary_frame_v2 loopback websocket frames without JSON/base64 socket payloads', async () => {
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

        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
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
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_binary',
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
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
                kind: 'open',
                tunnelId: 'tun_mux',
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
        const appended = deferred<Readonly<{
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
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
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
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
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
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
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

    it('dispatches exact Agent realtime Voice frames and emits application output on the daemon carrier window', async () => {
        const mod = await loadRegisterRoutesModule();
        if (!mod) throw new Error('expected direct tunnel route module');
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const authority = {
            v: 1 as const,
            applicationKind: 'agent_realtime' as const,
            applicationAttemptId: 'attempt-1',
            applicationAuthorityDigest: `sha256:${'cd'.repeat(32)}`,
        };
        const dispatchFrame = vi.fn(async (input) => ({
            v: 1 as const,
            kind: 'input_accepted' as const,
            applicationSequence: input.frame.applicationSequence,
            acceptedBytes: input.frame.kind === 'input_audio'
                ? input.frame.payload.byteLength
                : 0,
        }));
        const agentConsumer: NonNullable<
            Parameters<typeof mod.registerPeerTcpTunnelLoopbackRoutes>[1]['voiceMediaAgentRealtimeConsumer']
        > = {
            dispatchFrame,
            close: vi.fn(async () => {}),
        };
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
                flowKind: 'voice_media' as const,
                voiceMediaApplicationAuthority: authority,
                response: {
                    v: 1 as const,
                    tunnelId: 'tun_agent_realtime',
                    streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                    encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                    initialWindowBytes: 1024 * 1024,
                    maxFrameBytes: 64 * 1024,
                },
                receipt: 'peer.tunnel.opened' as const,
                limits: testTunnelLimits,
            })),
            voiceMediaAgentRealtimeConsumer: agentConsumer,
            voiceBinaryTerminalConsumer,
        });
        await app.inject({
            method: 'POST',
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
                kind: 'open',
                tunnelId: 'tun_agent_realtime',
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
                on: (event: 'message', handler: (payload: Buffer) => void) => void;
                off: (event: 'message', handler: (payload: Buffer) => void) => void;
            }>;
        }).injectWS('/peer-mediation/v1/tunnel/stream');
        const responseFrame = waitForBinaryFrameKind(ws, 'data');
        const payload = encodeVoiceMediaAgentRealtimeFrameV1({
            v: 1,
            kind: 'input_audio',
            applicationSequence: 7,
            format: VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1,
            samplesPerChannel: 2,
            payload: new Uint8Array([1, 2, 3, 4]),
        });
        ws.send(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_agent_realtime',
                substreamId: 'agent.realtime.attempt-1',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: payload.byteLength,
            },
            payload,
        }));

        await vi.waitFor(() => expect(dispatchFrame).toHaveBeenCalledOnce());
        const decodedCarrier = decodePeerTcpTunnelBinaryFrameV2({
            frame: await responseFrame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decodedCarrier.ok ? decodeVoiceMediaAgentRealtimeFrameV1(decodedCarrier.payload) : null)
            .toEqual({
                v: 1,
                kind: 'input_accepted',
                applicationSequence: 7,
                acceptedBytes: 4,
            });
        expect(dispatchFrame).toHaveBeenCalledOnce();
        ws.terminate();
        await vi.waitFor(() => expect(agentConsumer.close).toHaveBeenCalledOnce());
        expect(voiceBinaryTerminalConsumer).not.toHaveBeenCalled();
        await app.close();
    });

    it('terminates a recoverably identified Voice substream when its direct binary payload is malformed', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const connection = { write: vi.fn(), onData: vi.fn(), close: vi.fn(async () => undefined) };
        const voiceBinaryAppendConsumer = vi.fn();
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
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
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
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
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
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
            v: 1,
            kind: 'open',
            tunnelId: 'tun_voice_aggregate',
            targetMachineId: 'machine_1',
            routeKind: 'loopback_direct',
            destination: { host: '127.0.0.1', port: 3000 },
            selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        } as const;
        await app.inject({ method: 'POST', url: '/peer-mediation/v1/tunnel/open', payload: openPayload });
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
            url: '/peer-mediation/v1/tunnel/open',
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
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
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
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: 'tun_1',
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: 'json_base64_v1' as const,
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
            v: 1,
            kind: 'open',
            tunnelId: 'tun_1',
            targetMachineId: 'machine_1',
            routeKind: 'loopback_direct',
            destination: { host: '127.0.0.1', port: 3000 },
        };

        expect((await app.inject({ method: 'POST', url: '/peer-mediation/v1/tunnel/open', payload })).statusCode).toBe(200);
        const duplicate = await app.inject({ method: 'POST', url: '/peer-mediation/v1/tunnel/open', payload });

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
            flowKind: 'tcp_tunnel' as const,
            response: {
                v: 1 as const,
                tunnelId: (input.open as { tunnelId: string }).tunnelId,
                streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                encoding: 'json_base64_v1' as const,
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
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
                kind: 'open',
                tunnelId: 'tun_1',
                targetMachineId: 'machine_1',
                routeKind: 'loopback_direct',
                destination: { host: '127.0.0.1', port: 3000 },
            },
        });
        const second = await app.inject({
            method: 'POST',
            url: '/peer-mediation/v1/tunnel/open',
            payload: {
                v: 1,
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

    it('cleans up an opened TCP reservation when no websocket stream claims it before the timeout', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const firstConnection = { close: vi.fn(async () => undefined) };
        const secondConnection = { close: vi.fn(async () => undefined) };
        const connections = [firstConnection, secondConnection];
        const openTunnel = vi.fn(async (input) => {
            const connection = connections.shift() ?? { close: vi.fn(async () => undefined) };
            return {
                ok: true as const,
                flowKind: 'tcp_tunnel' as const,
                response: {
                    v: 1 as const,
                    tunnelId: (input.open as { tunnelId: string }).tunnelId,
                    streamPath: '/peer-mediation/v1/tunnel/stream' as const,
                    encoding: 'json_base64_v1' as const,
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
                url: '/peer-mediation/v1/tunnel/open',
                payload: {
                    v: 1,
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
                url: '/peer-mediation/v1/tunnel/open',
                payload: {
                    v: 1,
                    kind: 'open',
                    tunnelId: 'tun_2',
                    targetMachineId: 'machine_1',
                    routeKind: 'loopback_direct',
                    destination: { host: '127.0.0.1', port: 3001 },
                },
            });

            expect(firstConnection.close).toHaveBeenCalledOnce();
            expect(second.statusCode).toBe(200);
            expect(openTunnel).toHaveBeenCalledTimes(2);
        } finally {
            await app.close();
        }
    });
});
