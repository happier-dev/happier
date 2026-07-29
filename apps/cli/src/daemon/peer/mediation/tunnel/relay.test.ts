import {
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    createSpeechTranscriptionApplicationAuthorityDigestV1,
    createAgentRealtimeApplicationAuthorityV1,
    createPeerTcpTunnelRelayAuthorizationSigningInputV2,
    decodePeerTcpTunnelBinaryFrameV2,
    encodeVoiceMediaAgentRealtimeFrameV1,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1,
    type PeerTcpTunnelRelayEnvelopeV1,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { voiceMediaPeerApplicationEncryptionRegistry } from '../../../voiceMedia/voiceMediaPeerApplicationEncryption';

type RelayModule = typeof import('./relay');

async function loadRelayModule(): Promise<RelayModule | null> {
    const modulePath = './relay.js';
    return import(modulePath).catch(() => null) as Promise<RelayModule | null>;
}

type ServerRelaySocket = Readonly<{
    id?: string;
    data?: Record<string, unknown>;
    on: (event: string, handler: (payload?: unknown) => void | Promise<void>) => unknown;
    emit: (event: string, payload: unknown) => unknown;
}>;

type ServerRelayHandler = (
    userId: string,
    socket: ServerRelaySocket,
    ctx: Readonly<{
        io: Readonly<{
            to: (room: string) => Readonly<{
                emit: (event: string, payload: unknown) => unknown;
            }>;
        }>;
        relayAuthorizationTrustRoots?: readonly Readonly<{
            keyId: string;
            publicKeyBase64Url: string;
        }>[];
        nowMs?: () => number;
        serverRoutedEnabled?: boolean;
        allowedPorts?: readonly number[];
    }>,
) => void;

async function loadServerRegisterRelayHandler(): Promise<ServerRelayHandler | null> {
    const modulePath =
        '../../../../../../server/sources/app/api/socket/peer/mediation/tunnel/registerRelay.js';
    const loaded: unknown = await import(modulePath).catch(() => null);
    if (
        typeof loaded !== 'object'
        || loaded === null
        || !('registerPeerTcpTunnelRelaySocketHandler' in loaded)
        || typeof loaded.registerPeerTcpTunnelRelaySocketHandler !== 'function'
    ) {
        return null;
    }
    return loaded.registerPeerTcpTunnelRelaySocketHandler as ServerRelayHandler;
}

function createSocket() {
    const handlers = new Map<string, (payload?: unknown) => void | Promise<void>>();
    return {
        on: vi.fn((event: string, handler: (payload?: unknown) => void | Promise<void>) => {
            handlers.set(event, handler);
        }),
        emit: vi.fn(),
        trigger: async (event: string, payload?: unknown) => {
            await handlers.get(event)?.(payload);
        },
    };
}

const relayKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
const relayAuthorizationTrustRoots = [{
    keyId: 'relay_key_1',
    publicKeyBase64Url: Buffer.from(relayKeyPair.publicKey).toString('base64url'),
}] as const;

function createRelayAuthorization(
    tunnelId: string,
    overrides?: Readonly<{
        destination?: Readonly<{ host: string; port: number }>;
        flowKind?: 'tcp_tunnel' | 'voice_media';
        maxFrameBytes?: number;
        maxDurationMs?: number;
        maxTotalBytes?: number;
        iat?: number;
        exp?: number;
        signatureBase64Url?: string;
        targetMachineId?: string;
        relaySocketId?: string;
        applicationKind?: 'speech_transcription' | 'agent_realtime';
        applicationAttemptId?: string;
        applicationAuthorityDigest?: string;
    }>,
) {
    const destination = overrides?.destination ?? { host: '127.0.0.1', port: 3000 };
    const flowKind = overrides?.flowKind ?? 'tcp_tunnel';
    const payload = {
        v: 2,
        grantId: `relay_grant_${tunnelId}`,
        accountId: 'user_1',
        targetMachineId: overrides?.targetMachineId ?? 'machine_1',
        flowKind,
        routeKind: 'server_relay',
        tunnelId,
        ...(flowKind === 'voice_media' ? {
            applicationKind: overrides?.applicationKind ?? 'speech_transcription',
            applicationAttemptId: overrides?.applicationAttemptId ?? 'request_1',
            applicationAuthorityDigest:
                overrides?.applicationAuthorityDigest
                ?? createSpeechTranscriptionApplicationAuthorityDigestV1('request_1'),
        } : {}),
        relaySocketId: overrides?.relaySocketId ?? 'relay_socket_a',
        destination,
        capProfileId: 'interactive',
        maxFrameBytes: overrides?.maxFrameBytes ?? 64 * 1024,
        maxIdleMs: 30_000,
        maxDurationMs: overrides?.maxDurationMs ?? 300_000,
        maxTotalBytes: overrides?.maxTotalBytes ?? 64 * 1024 * 1024,
        iat: overrides?.iat ?? 1_000,
        exp: overrides?.exp ?? 301_000,
        aud: 'happier-tcp-tunnel-relay-authorization',
    } as const;
    return {
        payload,
        signature: {
            keyId: 'relay_key_1',
            alg: 'Ed25519',
            valueBase64Url: overrides?.signatureBase64Url
                ?? Buffer.from(tweetnacl.sign.detached(
                    new TextEncoder().encode(createPeerTcpTunnelRelayAuthorizationSigningInputV2(payload)),
                    relayKeyPair.secretKey,
                )).toString('base64url'),
        },
    } as const;
}

function createOpenEnvelope(
    tunnelId: string,
    overrides?: Readonly<{
        destination?: Readonly<{ host: string; port: number }>;
        recipientMachineId?: string;
        targetMachineId?: string;
        relaySocketId?: string;
        relayAuthorization?: ReturnType<typeof createRelayAuthorization>;
    }>,
): PeerTcpTunnelRelayEnvelopeV1 {
    const targetMachineId = overrides?.targetMachineId ?? 'machine_1';
    const destination = overrides?.destination ?? { host: '127.0.0.1', port: 3000 };
    return {
        v: 1,
        scopeUserId: 'user_1',
        sender: { kind: 'user', socketId: overrides?.relaySocketId ?? 'relay_socket_a' },
        recipient: { kind: 'machine', machineId: overrides?.recipientMachineId ?? targetMachineId },
        frame: {
            v: 1,
            kind: 'open',
            open: {
                v: 1,
                kind: 'open',
                tunnelId,
                targetMachineId,
                routeKind: 'server_relay',
                destination,
                relayAuthorization: overrides?.relayAuthorization ?? createRelayAuthorization(tunnelId, {
                    destination,
                    targetMachineId,
                    relaySocketId: overrides?.relaySocketId,
                }),
            },
        },
    };
}

function createDataEnvelope(tunnelId: string, payload: string): PeerTcpTunnelRelayEnvelopeV1 {
    return {
        v: 1,
        scopeUserId: 'user_1',
        sender: { kind: 'user' },
        recipient: { kind: 'machine', machineId: 'machine_1' },
        frame: {
            v: 1,
            kind: 'data',
            tunnelId,
            direction: 'client_to_daemon',
            sequence: 0,
            payloadBase64: Buffer.from(payload).toString('base64'),
        },
    };
}

function createCloseEnvelope(tunnelId: string): PeerTcpTunnelRelayEnvelopeV1 {
    return {
        v: 1,
        scopeUserId: 'user_1',
        sender: { kind: 'user' },
        recipient: { kind: 'machine', machineId: 'machine_1' },
        frame: {
            v: 1,
            kind: 'close',
            tunnelId,
            direction: 'client_to_daemon',
            halfClose: false,
            reasonCode: 'client_closed',
        },
    };
}

function createBinaryEnvelope(tunnelId: string, payload: string) {
    return {
        v: 2,
        scopeUserId: 'user_1',
        sender: { kind: 'user' as const },
        recipient: { kind: 'machine' as const, machineId: 'machine_1' },
        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        frame: encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId,
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: Buffer.byteLength(payload),
            },
            payload: Buffer.from(payload),
        }),
    } as const;
}

function createBinarySubstreamEnvelope(input: Readonly<{
    tunnelId: string;
    substreamId: string;
    kind: 'open' | 'data' | 'close' | 'abort';
    payload?: string | Uint8Array;
    sequence?: number;
    reasonCode?: string;
}>) {
    const payload = Buffer.from(input.payload ?? '');
    return {
        v: 2,
        scopeUserId: 'user_1',
        sender: { kind: 'user' as const },
        recipient: { kind: 'machine' as const, machineId: 'machine_1' },
        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        frame: encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: input.kind,
                tunnelId: input.tunnelId,
                substreamId: input.substreamId,
                ...(input.kind === 'data'
                    ? {
                        direction: 'client_to_daemon' as const,
                        sequence: input.sequence ?? 0,
                    }
                    : {}),
                ...(input.kind === 'close'
                    ? {
                        direction: 'client_to_daemon' as const,
                        reasonCode: input.reasonCode ?? 'client_closed',
                    }
                    : {}),
                ...(input.kind === 'abort'
                    ? { reasonCode: input.reasonCode ?? 'client_aborted' }
                    : {}),
                payloadLength: payload.byteLength,
            },
            payload,
        }),
    } as const;
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

describe('registerPeerTcpTunnelRelayTerminator', () => {
    it('settles the surviving daemon application exactly once when the user relay socket disconnects', async () => {
        const mod = await loadRelayModule();
        const registerServerRelay = await loadServerRegisterRelayHandler();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        expect(registerServerRelay).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator || !registerServerRelay) return;

        const pendingDeliveries: Promise<void>[] = [];
        const scheduleDelivery = (result: unknown): void => {
            if (result instanceof Promise) {
                pendingDeliveries.push(result.then(() => undefined));
            }
        };
        const flushDeliveries = async (): Promise<void> => {
            while (pendingDeliveries.length > 0) {
                await Promise.all(pendingDeliveries.splice(0));
            }
        };

        const machineServerHandlers = new Map<string, (payload?: unknown) => void | Promise<void>>();
        const daemonHandlers = new Map<string, (payload?: unknown) => void | Promise<void>>();
        const machineServerSocket: ServerRelaySocket = {
            id: 'machine_socket_1',
            data: { clientType: 'machine-scoped', machineId: 'machine_1' },
            on: (event, handler) => machineServerHandlers.set(event, handler),
            emit: vi.fn(),
        };
        const daemonSocket = {
            on: (event: string, handler: (payload?: unknown) => void | Promise<void>) => {
                daemonHandlers.set(event, handler);
            },
            emit: (event: string, payload: unknown) => {
                scheduleDelivery(machineServerHandlers.get(event)?.(payload));
            },
        };
        const userDeliveries: unknown[] = [];
        const io = {
            to: (room: string) => ({
                emit: (event: string, payload: unknown) => {
                    if (room === 'machine:machine_1:user_1') {
                        scheduleDelivery(daemonHandlers.get(event)?.(payload));
                    } else {
                        userDeliveries.push(payload);
                    }
                },
            }),
        };
        const registerServerSocket = (socket: ServerRelaySocket): void => {
            registerServerRelay('user_1', socket, {
                io,
                nowMs: () => 2_000,
                serverRoutedEnabled: true,
                allowedPorts: [3000],
                relayAuthorizationTrustRoots,
            });
        };
        registerServerSocket(machineServerSocket);

        const speechTerminal = vi.fn(async (_input: unknown) => ({ ok: true as const }));
        const agentRealtimeConsumer = {
            dispatchFrame: vi.fn(async () => null),
            close: vi.fn(async () => undefined),
        };
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket: daemonSocket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(),
            voiceBinaryAppendConsumer: vi.fn(async (input) => ({
                ok: true as const,
                streamId: input.streamId,
                generation: input.generation,
                ackSeq: input.seq,
                events: [],
            })),
            voiceBinaryTerminalConsumer: speechTerminal,
            voiceMediaAgentRealtimeConsumer: agentRealtimeConsumer,
        });

        const createUserServerSocket = (socketId: string) => {
            const handlers = new Map<string, (payload?: unknown) => void | Promise<void>>();
            const socket: ServerRelaySocket = {
                id: socketId,
                data: { clientType: 'user-scoped' },
                on: (event, handler) => handlers.set(event, handler),
                emit: vi.fn(),
            };
            registerServerSocket(socket);
            return {
                trigger: async (event: string, payload?: unknown) => {
                    await handlers.get(event)?.(payload);
                    await flushDeliveries();
                },
            };
        };

        const beforeFrameSocket = createUserServerSocket('relay_socket_before_frame');
        const beforeFrameTunnelId = 'voice-media:machine_1:relay-socket-loss-before-frame';
        const beforeFrameAuthorization = createRelayAuthorization(beforeFrameTunnelId, {
            flowKind: 'voice_media',
            relaySocketId: 'relay_socket_before_frame',
            applicationAttemptId: 'request-before-frame',
            applicationAuthorityDigest:
                createSpeechTranscriptionApplicationAuthorityDigestV1('request-before-frame'),
        });
        const beforeFrameOpen = createOpenEnvelope(beforeFrameTunnelId, {
            relaySocketId: 'relay_socket_before_frame',
            relayAuthorization: beforeFrameAuthorization,
        });
        if (beforeFrameOpen.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await beforeFrameSocket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...beforeFrameOpen,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...beforeFrameOpen.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await beforeFrameSocket.trigger('disconnect');
        await beforeFrameSocket.trigger('disconnect');

        expect(speechTerminal).toHaveBeenCalledOnce();
        expect(speechTerminal).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'tunnel_closed',
            voiceMediaApplicationAuthority: expect.objectContaining({
                applicationKind: 'speech_transcription',
                applicationAttemptId: 'request-before-frame',
                tunnelId: beforeFrameTunnelId,
            }),
        }));
        expect(speechTerminal.mock.calls[0]?.[0]).not.toHaveProperty('streamId');

        const speechSocket = createUserServerSocket('relay_socket_speech');
        const speechTunnelId = 'voice-media:machine_1:relay-socket-loss-speech';
        const speechAuthorization = createRelayAuthorization(speechTunnelId, {
            flowKind: 'voice_media',
            relaySocketId: 'relay_socket_speech',
            applicationAttemptId: 'request-socket-loss',
            applicationAuthorityDigest:
                createSpeechTranscriptionApplicationAuthorityDigestV1('request-socket-loss'),
        });
        const speechOpen = createOpenEnvelope(speechTunnelId, {
            relaySocketId: 'relay_socket_speech',
            relayAuthorization: speechAuthorization,
        });
        if (speechOpen.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await speechSocket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...speechOpen,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...speechOpen.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await speechSocket.trigger(
            PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
            createBinarySubstreamEnvelope({
                tunnelId: speechTunnelId,
                substreamId: 'daemon.voiceInference.stt.stream-socket-loss.7',
                kind: 'data',
                sequence: 0,
                payload: '\0\0\u0001\0',
            }),
        );

        await speechSocket.trigger('disconnect');
        await speechSocket.trigger('disconnect');
        await machineServerHandlers.get('disconnect')?.();
        await flushDeliveries();

        expect(speechTerminal).toHaveBeenCalledTimes(2);
        expect(speechTerminal).toHaveBeenCalledWith(expect.objectContaining({
            streamId: 'stream-socket-loss',
            generation: 7,
            substreamId: 'daemon.voiceInference.stt.stream-socket-loss.7',
            reasonCode: 'tunnel_closed',
            voiceMediaApplicationAuthority: expect.objectContaining({
                applicationKind: 'speech_transcription',
                applicationAttemptId: 'request-socket-loss',
                tunnelId: speechTunnelId,
            }),
        }));
        expect(agentRealtimeConsumer.close).not.toHaveBeenCalled();

        const agentAuthority = createAgentRealtimeApplicationAuthorityV1({
            v: 1,
            happierSessionId: 'session-socket-loss',
            agentRef: { pluginId: 'happier.agent.codex', localId: 'codex' },
            agentGeneration: 'generation-socket-loss',
            sessionBridgeId: 'bridge-socket-loss',
            applicationAttemptId: 'attempt-socket-loss',
        });
        expect(voiceMediaPeerApplicationEncryptionRegistry.admitAgentRealtimeAttempt({
            authority: agentAuthority,
        }).ok).toBe(true);
        const agentSocket = createUserServerSocket('relay_socket_agent');
        const agentTunnelId = 'voice-media:machine_1:relay-socket-loss-agent';
        const agentAuthorization = createRelayAuthorization(agentTunnelId, {
            flowKind: 'voice_media',
            relaySocketId: 'relay_socket_agent',
            applicationKind: 'agent_realtime',
            applicationAttemptId: agentAuthority.applicationAttemptId,
            applicationAuthorityDigest: agentAuthority.applicationAuthorityDigest,
        });
        const agentOpen = createOpenEnvelope(agentTunnelId, {
            relaySocketId: 'relay_socket_agent',
            relayAuthorization: agentAuthorization,
        });
        if (agentOpen.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await agentSocket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...agentOpen,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...agentOpen.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await agentSocket.trigger('disconnect');
        await agentSocket.trigger('disconnect');

        expect(agentRealtimeConsumer.close).toHaveBeenCalledTimes(1);
        expect(agentRealtimeConsumer.close).toHaveBeenCalledWith(expect.objectContaining({
            authority: expect.objectContaining({
                applicationKind: 'agent_realtime',
                applicationAttemptId: 'attempt-socket-loss',
                tunnelId: agentTunnelId,
            }),
            substreamId: 'agent.realtime.attempt-socket-loss',
            reasonCode: 'tunnel_closed',
        }));
        expect(speechTerminal).toHaveBeenCalledTimes(2);
        expect(userDeliveries.length).toBeGreaterThan(0);
        voiceMediaPeerApplicationEncryptionRegistry.closeAgentRealtimeAttempt(agentAuthority);
    });

    it('opens authorized relay tunnels and bridges client frames to loopback TCP', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const writes: string[] = [];
        const connection = {
            write: vi.fn((bytes: Uint8Array) => {
                writes.push(Buffer.from(bytes).toString('utf8'));
            }),
            close: vi.fn(),
        };
        const connectTcp = vi.fn(async () => connection);

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
        });

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope('tun_1'));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createDataEnvelope('tun_1', 'hello'));

        expect(connectTcp).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3000 });
        expect(writes).toEqual(['hello']);
    });

    it('aborts invalid relay authorizations without opening loopback TCP', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const connectTcp = vi.fn();
        const envelope = createOpenEnvelope('tun_bad_auth');
        expect(envelope.frame.kind).toBe('open');
        if (envelope.frame.kind !== 'open') return;
        const invalidEnvelope: PeerTcpTunnelRelayEnvelopeV1 = {
            ...envelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...envelope.frame.open,
                    relayAuthorization: createRelayAuthorization('tun_bad_auth', {
                        signatureBase64Url: Buffer.from(new Uint8Array(64).fill(1)).toString('base64url'),
                    }),
                },
            },
        };

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
        });

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, invalidEnvelope);

        expect(connectTcp).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_bad_auth',
                reasonCode: 'relay_authorization_invalid',
            }),
        }));
    });

    it.each([
        {
            name: 'tunnel id',
            openTunnelId: 'tun_unsigned',
            authorizedTunnelId: 'tun_signed',
            openDestination: { host: '127.0.0.1', port: 3000 },
            authorizedDestination: { host: '127.0.0.1', port: 3000 },
            openTargetMachineId: 'machine_1',
            authorizedTargetMachineId: 'machine_1',
        },
        {
            name: 'target machine',
            openTunnelId: 'tun_target_binding',
            authorizedTunnelId: 'tun_target_binding',
            openDestination: { host: '127.0.0.1', port: 3000 },
            authorizedDestination: { host: '127.0.0.1', port: 3000 },
            openTargetMachineId: 'machine_2',
            authorizedTargetMachineId: 'machine_1',
        },
        {
            name: 'destination host',
            openTunnelId: 'tun_host_binding',
            authorizedTunnelId: 'tun_host_binding',
            openDestination: { host: 'localhost', port: 3000 },
            authorizedDestination: { host: '127.0.0.1', port: 3000 },
            openTargetMachineId: 'machine_1',
            authorizedTargetMachineId: 'machine_1',
        },
        {
            name: 'destination port',
            openTunnelId: 'tun_port_binding',
            authorizedTunnelId: 'tun_port_binding',
            openDestination: { host: '127.0.0.1', port: 3001 },
            authorizedDestination: { host: '127.0.0.1', port: 3000 },
            openTargetMachineId: 'machine_1',
            authorizedTargetMachineId: 'machine_1',
        },
    ])('aborts relay authorization binding mismatches for $name before consuming the grant', async (testCase) => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const connection = { write: vi.fn(), close: vi.fn() };
        const connectTcp = vi.fn(async () => connection);
        const relayAuthorization = createRelayAuthorization(testCase.authorizedTunnelId, {
            destination: testCase.authorizedDestination,
            targetMachineId: testCase.authorizedTargetMachineId,
        });
        const recipientMachineId = testCase.name === 'target machine'
            ? testCase.authorizedTargetMachineId
            : testCase.openTargetMachineId;

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
        });

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope(testCase.openTunnelId, {
            destination: testCase.openDestination,
            targetMachineId: testCase.openTargetMachineId,
            recipientMachineId,
            relayAuthorization,
        }));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope(testCase.authorizedTunnelId, {
            destination: testCase.authorizedDestination,
            targetMachineId: testCase.authorizedTargetMachineId,
            recipientMachineId: testCase.authorizedTargetMachineId,
            relayAuthorization,
        }));

        expect(connectTcp).toHaveBeenCalledTimes(1);
        expect(connectTcp).toHaveBeenCalledWith({
            host: testCase.authorizedDestination.host,
            port: testCase.authorizedDestination.port,
        });
        expect(socket.emit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: testCase.openTunnelId,
                reasonCode: 'relay_authorization_invalid',
            }),
        }));
    });

    it('rejects replayed relay authorizations after the relay tunnel is closed', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const connection = { write: vi.fn(), close: vi.fn() };
        const connectTcp = vi.fn(async () => connection);

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
        });

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope('tun_replay'));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createCloseEnvelope('tun_replay'));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope('tun_replay'));

        expect(connectTcp).toHaveBeenCalledTimes(1);
        expect(socket.emit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_replay',
                reasonCode: 'relay_authorization_invalid',
            }),
        }));
    });

    it('keeps a server-consumed relay grant unavailable when daemon TCP activation fails', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const connectTcp = vi.fn().mockRejectedValue(new Error('refused'));
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
        });

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope('tun_activation_failed'));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope('tun_activation_failed'));

        expect(connectTcp).toHaveBeenCalledOnce();
        expect(socket.emit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_activation_failed',
                reasonCode: 'relay_authorization_invalid',
            }),
        }));
    });

    it('bridges negotiated binary_frame_v2 relay data without base64 on the socket event', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const writes: string[] = [];
        let dataHandler: ((bytes: Uint8Array) => Promise<void> | void) | undefined;
        const connection = {
            write: vi.fn((bytes: Uint8Array) => {
                writes.push(Buffer.from(bytes).toString('utf8'));
            }),
            onData: vi.fn((handler: (bytes: Uint8Array) => Promise<void> | void) => {
                dataHandler = handler;
            }),
            close: vi.fn(),
        };

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(async () => connection),
        });

        const openEnvelope = createOpenEnvelope('tun_binary');
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') {
            throw new Error('expected open frame fixture');
        }
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinaryEnvelope('tun_binary', 'hello'));

        expect(writes).toEqual(['hello']);
        expect(dataHandler).toBeTypeOf('function');
        await dataHandler?.(Buffer.from('world'));

        const binaryEmit = socket.emit.mock.calls.find(([, payload]) =>
            (payload as { v?: number; encoding?: string }).v === 2
            && (payload as { encoding?: string }).encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        );
        expect(binaryEmit).toBeTruthy();
        const [, payload] = binaryEmit ?? [];
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: (payload as { frame: Uint8Array }).frame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decoded).toMatchObject({
            ok: true,
            header: expect.objectContaining({
                version: 2,
                kind: 'data',
                tunnelId: 'tun_binary',
                direction: 'daemon_to_client',
                sequence: 0,
                payloadLength: 5,
            }),
        });
        expect(decoded.ok ? Buffer.from(decoded.payload).toString('utf8') : null).toBe('world');
    });

    it('uses binary raw-payload caps instead of the legacy frame cap for negotiated binary_frame_v2 data', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const writes: string[] = [];
        const connection = {
            write: vi.fn((bytes: Uint8Array) => {
                writes.push(Buffer.from(bytes).toString('utf8'));
            }),
            close: vi.fn(),
        };

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(async () => connection),
            maxFrameBytes: 8,
            maxBinaryHeaderBytes: 512,
            maxRawPayloadBytes: 32,
        });

        const openEnvelope = createOpenEnvelope('tun_binary_raw_cap');
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinaryEnvelope(
            'tun_binary_raw_cap',
            'twelve-bytes',
        ));

        expect(writes).toEqual(['twelve-bytes']);
    });

    it('opens separate loopback TCP connections for binary_frame_v2 substreams on one authorized relay tunnel', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const writesByConnection: string[][] = [];
        const dataHandlers: Array<(bytes: Uint8Array) => Promise<void> | void> = [];
        const connectTcp = vi.fn(async () => {
            const index = writesByConnection.length;
            writesByConnection.push([]);
            return {
                write: vi.fn((bytes: Uint8Array) => {
                    writesByConnection[index]?.push(Buffer.from(bytes).toString('utf8'));
                }),
                onData: vi.fn((handler: (bytes: Uint8Array) => Promise<void> | void) => {
                    dataHandlers[index] = handler;
                }),
                close: vi.fn(),
            };
        });

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
        });

        const openEnvelope = createOpenEnvelope('tun_mux');
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux',
            substreamId: 'sub_a',
            kind: 'open',
        }));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux',
            substreamId: 'sub_b',
            kind: 'open',
        }));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux',
            substreamId: 'sub_a',
            kind: 'data',
            payload: 'alpha',
        }));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux',
            substreamId: 'sub_b',
            kind: 'data',
            payload: 'beta',
        }));
        await dataHandlers[1]?.(Buffer.from('one'));

        expect(connectTcp).toHaveBeenCalledTimes(3);
        expect(writesByConnection.slice(1)).toEqual([['alpha'], ['beta']]);
        const binaryEmit = socket.emit.mock.calls.find(([, payload]) => {
            const envelope = payload as { v?: number; frame?: Uint8Array };
            if (envelope.v !== 2 || !(envelope.frame instanceof Uint8Array)) return false;
            const decoded = decodePeerTcpTunnelBinaryFrameV2({
                frame: envelope.frame,
                maxHeaderBytes: 1024,
                maxPayloadBytes: 1024,
            });
            return decoded.ok
                && decoded.header.kind === 'data'
                && decoded.header.substreamId === 'sub_a'
                && Buffer.from(decoded.payload).toString('utf8') === 'one';
        });
        expect(binaryEmit).toBeTruthy();
    });

    it('uses binary raw-payload caps instead of the legacy frame cap for substream data', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const writesByConnection: string[][] = [];
        const connectTcp = vi.fn(async () => {
            const index = writesByConnection.length;
            writesByConnection.push([]);
            return {
                write: vi.fn((bytes: Uint8Array) => {
                    writesByConnection[index]?.push(Buffer.from(bytes).toString('utf8'));
                }),
                onData: vi.fn(),
                close: vi.fn(),
            };
        });

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
            maxFrameBytes: 8,
            maxBinaryHeaderBytes: 512,
            maxRawPayloadBytes: 32,
        });

        const openEnvelope = createOpenEnvelope('tun_mux_raw_cap');
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux_raw_cap',
            substreamId: 'sub_raw',
            kind: 'open',
        }));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux_raw_cap',
            substreamId: 'sub_raw',
            kind: 'data',
            payload: 'twelve-bytes',
        }));

        expect(connectTcp).toHaveBeenCalledTimes(2);
        expect(writesByConnection[1]).toEqual(['twelve-bytes']);
    });

    it('routes prepared Agent realtime relay attempts through encrypted application dispatch and rejects plaintext', async () => {
        const mod = await loadRelayModule();
        if (!mod?.registerPeerTcpTunnelRelayTerminator) {
            throw new Error('expected relay terminator');
        }
        const authority = createAgentRealtimeApplicationAuthorityV1({
            v: 1,
            happierSessionId: 'session-1',
            agentRef: { pluginId: 'happier.agent.codex', localId: 'codex' },
            agentGeneration: 'generation-1',
            sessionBridgeId: 'bridge-1',
            applicationAttemptId: 'attempt-1',
        });
        expect(voiceMediaPeerApplicationEncryptionRegistry.admitAgentRealtimeAttempt({
            authority,
        }).ok).toBe(true);
        const socket = createSocket();
        const consumer = {
            dispatchFrame: vi.fn(async () => null),
            close: vi.fn(async () => {}),
        };
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(),
            voiceMediaAgentRealtimeConsumer: consumer,
        });
        const tunnelId = 'voice-media:machine_1:agent_realtime';
        const relayAuthorization = createRelayAuthorization(tunnelId, {
            flowKind: 'voice_media',
            applicationKind: 'agent_realtime',
            applicationAttemptId: authority.applicationAttemptId,
            applicationAuthorityDigest: authority.applicationAuthorityDigest,
        });
        const openEnvelope = createOpenEnvelope(tunnelId, { relayAuthorization });
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open envelope');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        const plaintext = encodeVoiceMediaAgentRealtimeFrameV1({
            v: 1,
            kind: 'input_audio',
            applicationSequence: 0,
            format: VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1,
            samplesPerChannel: 2,
            payload: new Uint8Array([1, 2, 3, 4]),
        });
        await expect(socket.trigger(
            PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
            createBinarySubstreamEnvelope({
                tunnelId,
                substreamId: 'agent.realtime.attempt-1',
                kind: 'data',
                sequence: 0,
                payload: plaintext,
            }),
        )).rejects.toThrow('Agent realtime relay frame was rejected');
        expect(consumer.dispatchFrame).not.toHaveBeenCalled();
        expect(consumer.close).toHaveBeenCalledOnce();
        voiceMediaPeerApplicationEncryptionRegistry.closeAgentRealtimeAttempt(authority);
    });

    it('dispatches voice-bound relay binary_frame_v2 substream data to the append consumer without opening a substream TCP socket', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const appended = deferred<Readonly<{
            streamId: string;
            generation: number;
            seq: number;
            pcm16Bytes: Uint8Array;
        }>>();
        const writesByConnection: string[][] = [];
        const connectTcp = vi.fn(async () => {
            const index = writesByConnection.length;
            writesByConnection.push([]);
            return {
                write: vi.fn((bytes: Uint8Array) => {
                    writesByConnection[index]?.push(Buffer.from(bytes).toString('utf8'));
                }),
                onData: vi.fn(),
                close: vi.fn(),
            };
        });
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

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
            voiceBinaryAppendConsumer,
        });

        const tunnelId = 'voice-media:machine_1:relay_voice';
        const openEnvelope = createOpenEnvelope(tunnelId, {
            relayAuthorization: createRelayAuthorization(tunnelId, { flowKind: 'voice_media' }),
        });
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            kind: 'data',
            sequence: 0,
            payload: '\0\0\u0001\0',
        }));

        await expect(appended.promise).resolves.toMatchObject({
            streamId: 'stream-1',
            generation: 3,
            seq: 0,
        });
        expect([...(await appended.promise).pcm16Bytes]).toEqual([0, 0, 1, 0]);
        expect(voiceBinaryAppendConsumer).toHaveBeenCalledOnce();
        expect(voiceBinaryAppendConsumer).toHaveBeenCalledWith(expect.objectContaining({
            peerApplicationEncryption: expect.objectContaining({
                v: 1,
                suite: 'aes-256-gcm',
                flowKind: 'voice_media',
                routeKind: 'server_relay',
                accountId: 'user_1',
                machineId: 'machine_1',
                tunnelId,
                authorityDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
            }),
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            carrierSequence: 0,
        }));
        expect(connectTcp).not.toHaveBeenCalled();
        expect(writesByConnection).toEqual([]);
    });

    it('settles the authority-bound relay speech stream when its tunnel is lost before the first frame', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const voiceBinaryTerminalConsumer = vi.fn(async (_input: unknown) => ({ ok: true as const }));
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(async () => ({ write: vi.fn(), onData: vi.fn(), close: vi.fn() })),
            voiceBinaryAppendConsumer: vi.fn(),
            voiceBinaryTerminalConsumer,
        });

        const tunnelId = 'voice-media:machine_1:relay_voice_loss_before_frame';
        const openEnvelope = createOpenEnvelope(tunnelId, {
            relayAuthorization: createRelayAuthorization(tunnelId, { flowKind: 'voice_media' }),
        });
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createCloseEnvelope(tunnelId));

        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledOnce();
        const terminalInput = voiceBinaryTerminalConsumer.mock.calls[0]?.[0];
        expect(terminalInput).toEqual(expect.objectContaining({
            reasonCode: 'tunnel_closed',
            peerApplicationEncryption: expect.objectContaining({
                applicationKind: 'speech_transcription',
                applicationAttemptId: 'request_1',
                tunnelId,
            }),
            voiceMediaApplicationAuthority: expect.objectContaining({
                applicationKind: 'speech_transcription',
                applicationAttemptId: 'request_1',
                tunnelId,
            }),
        }));
        expect(terminalInput).not.toHaveProperty('streamId');
        expect(terminalInput).not.toHaveProperty('generation');

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createCloseEnvelope(tunnelId));
        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledOnce();
    });

    it('settles the exact relay speech stream once when its tunnel substream is lost', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [],
        }));
        const voiceBinaryTerminalConsumer = vi.fn(async () => ({ ok: true as const }));
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(async () => ({ write: vi.fn(), onData: vi.fn(), close: vi.fn() })),
            voiceBinaryAppendConsumer,
            voiceBinaryTerminalConsumer,
        });

        const tunnelId = 'voice-media:machine_1:relay_voice_loss';
        const openEnvelope = createOpenEnvelope(tunnelId, {
            relayAuthorization: createRelayAuthorization(tunnelId, { flowKind: 'voice_media' }),
        });
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-relay-loss.5',
            kind: 'data',
            sequence: 0,
            payload: '\0\0\u0001\0',
        }));
        expect(voiceBinaryAppendConsumer).toHaveBeenCalledOnce();

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createCloseEnvelope(tunnelId));

        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledOnce();
        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledWith(expect.objectContaining({
            streamId: 'stream-relay-loss',
            generation: 5,
            substreamId: 'daemon.voiceInference.stt.stream-relay-loss.5',
            reasonCode: 'tunnel_closed',
            voiceMediaApplicationAuthority: expect.objectContaining({
                applicationKind: 'speech_transcription',
                applicationAttemptId: 'request_1',
                tunnelId,
            }),
        }));

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createCloseEnvelope(tunnelId));
        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledOnce();
    });

    it('reuses the exact Voice relay tunnel and application-substream capacity after terminal cleanup', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const emitted: unknown[] = [];
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [],
        }));
        const voiceBinaryTerminalConsumer = vi.fn(async () => ({ ok: true as const }));
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(async () => ({ write: vi.fn(), onData: vi.fn(), close: vi.fn() })),
            voiceBinaryAppendConsumer,
            voiceBinaryTerminalConsumer,
            maxActiveTunnels: 1,
            substreamCaps: {
                maxConcurrentSubstreams: 1,
                maxTotalSubstreams: 1,
                maxBytesPerSubstream: 64 * 1024,
                maxAggregateBytes: 64 * 1024,
                maxSubstreamIdleMs: 30_000,
                maxSessionIdleMs: 30_000,
            },
            observability: {
                emit: (event) => emitted.push(event),
            },
        });

        const firstTunnelId = 'voice-media:machine_1:capacity_first';
        const secondTunnelId = 'voice-media:machine_1:capacity_second';
        const openVoiceTunnel = async (tunnelId: string) => {
            const open = createOpenEnvelope(tunnelId, {
                relayAuthorization: createRelayAuthorization(tunnelId, { flowKind: 'voice_media' }),
            });
            expect(open.frame.kind).toBe('open');
            if (open.frame.kind !== 'open') throw new Error('expected open frame fixture');
            await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
                ...open,
                frame: {
                    v: 1,
                    kind: 'open',
                    open: {
                        ...open.frame.open,
                        selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                    },
                },
            });
        };

        await openVoiceTunnel(firstTunnelId);
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: firstTunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-first.1',
            kind: 'data',
            sequence: 0,
            payload: 'first',
        }));

        await openVoiceTunnel(secondTunnelId);
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'cap.exceeded',
                flow: expect.objectContaining({ flowId: secondTunnelId }),
                data: expect.objectContaining({ reasonCode: 'relay_cap_exceeded' }),
            }),
        ]));

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: firstTunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-first.1',
            kind: 'close',
        }));
        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledOnce();
        expect(voiceBinaryTerminalConsumer).toHaveBeenCalledWith(expect.objectContaining({
            streamId: 'stream-first',
            generation: 1,
            substreamId: 'daemon.voiceInference.stt.stream-first.1',
        }));
        await openVoiceTunnel(secondTunnelId);
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: secondTunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-second.1',
            kind: 'data',
            sequence: 0,
            payload: 'second',
        }));

        expect(voiceBinaryAppendConsumer).toHaveBeenCalledTimes(2);
        expect(voiceBinaryAppendConsumer.mock.calls.map(([input]) => input.streamId)).toEqual([
            'stream-first',
            'stream-second',
        ]);
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'flow.closed',
                flow: expect.objectContaining({
                    flowId: firstTunnelId,
                    flowKind: 'voice_media',
                }),
            }),
            expect.objectContaining({
                kind: 'flow.ready',
                flow: expect.objectContaining({
                    flowId: secondTunnelId,
                    flowKind: 'voice_media',
                }),
            }),
        ]));
    });

    it('keeps an admitted Voice tunnel usable after grant expiry until its resource lifetime or explicit close', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        let now = 2_000;
        const socket = createSocket();
        const connection = { write: vi.fn(), onData: vi.fn(), close: vi.fn() };
        const connectTcp = vi.fn(async () => connection);
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [],
        }));
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => now,
            relayAuthorizationTrustRoots,
            connectTcp,
            voiceBinaryAppendConsumer,
        });

        const tunnelId = 'voice-media:machine_1:lifetime';
        const authorization = createRelayAuthorization(tunnelId, {
            flowKind: 'voice_media',
            iat: 1_000,
            exp: 2_010,
            maxDurationMs: 100,
        });
        const openEnvelope = createOpenEnvelope(tunnelId, { relayAuthorization: authorization });
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: { ...openEnvelope.frame.open, selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 },
            },
        });

        now = 2_011;
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            kind: 'data',
            sequence: 0,
            payload: '\0\0\u0001\0',
        }));

        expect(voiceBinaryAppendConsumer).toHaveBeenCalledOnce();
        expect(connectTcp).not.toHaveBeenCalled();

        const expiredTunnelId = 'voice-media:machine_1:expired_new_admission';
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope(expiredTunnelId, {
            relayAuthorization: createRelayAuthorization(expiredTunnelId, {
                flowKind: 'voice_media',
                iat: 1_000,
                exp: 2_010,
                maxDurationMs: 100,
            }),
        }));
        expect(connectTcp).not.toHaveBeenCalled();

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createCloseEnvelope(tunnelId));
        expect(connection.close).not.toHaveBeenCalled();
    });

    it('rejects an exact relay authorization replay after the daemon terminator lifetime is recreated', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const tunnelId = 'tun_relay_cross_lifecycle';
        const authorization = createRelayAuthorization(tunnelId, {
            iat: 1_000,
            exp: 301_000,
        });
        const open = createOpenEnvelope(tunnelId, { relayAuthorization: authorization });

        const socketA = createSocket();
        const connectA = vi.fn(async () => ({ write: vi.fn(), onData: vi.fn(), close: vi.fn() }));
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket: socketA,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: connectA,
        });
        await socketA.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, open);
        expect(connectA).toHaveBeenCalledOnce();

        // A replacement daemon terminator has a fresh process-local consumption
        // store. The exact still-unexpired authorization must nevertheless be
        // unusable when it arrives from a replacement relay socket lifecycle.
        const socketB = createSocket();
        const connectB = vi.fn(async () => ({ write: vi.fn(), onData: vi.fn(), close: vi.fn() }));
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket: socketB,
            nowMs: () => 2_001,
            relayAuthorizationTrustRoots,
            connectTcp: connectB,
        });
        await socketB.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope(tunnelId, {
            relaySocketId: 'relay_socket_b',
            relayAuthorization: authorization,
        }));

        expect(connectB).not.toHaveBeenCalled();
        expect(socketB.emit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId,
                reasonCode: 'relay_authorization_invalid',
            }),
        }));

        const replacementTunnelId = 'tun_relay_replacement_grant';
        await socketB.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope(replacementTunnelId, {
            relaySocketId: 'relay_socket_b',
            relayAuthorization: createRelayAuthorization(replacementTunnelId, {
                relaySocketId: 'relay_socket_b',
                iat: 1_000,
                exp: 301_000,
            }),
        }));
        expect(connectB).toHaveBeenCalledOnce();
    });

    it('enforces signed voice relay maxFrameBytes before dispatching STT append frames', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const connection = { write: vi.fn(), onData: vi.fn(), close: vi.fn() };
        const voiceBinaryAppendConsumer = vi.fn();

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(async () => connection),
            maxRawPayloadBytes: 64 * 1024,
            voiceBinaryAppendConsumer,
        });

        const relayAuthorization = createRelayAuthorization('voice-media:machine_1:request_frame_cap', {
            flowKind: 'voice_media',
            maxFrameBytes: 2,
            maxTotalBytes: 64,
        });
        const openEnvelope = createOpenEnvelope('voice-media:machine_1:request_frame_cap', { relayAuthorization });
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'voice-media:machine_1:request_frame_cap',
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            kind: 'data',
            sequence: 0,
            payload: '\0\0\u0001\0',
        }));

        expect(voiceBinaryAppendConsumer).not.toHaveBeenCalled();
        const emittedAbort = socket.emit.mock.calls
            .map((call) => call[1])
            .filter((payload) => typeof payload === 'object' && payload !== null && (payload as { v?: unknown }).v === 2)
            .map((payload) => decodePeerTcpTunnelBinaryFrameV2({
                frame: (payload as { frame: Uint8Array }).frame,
                maxHeaderBytes: 1024,
                maxPayloadBytes: 1024,
            }))
            .find((decoded) => decoded.ok && decoded.header.kind === 'abort');
        expect(emittedAbort?.ok ? emittedAbort.header : null).toMatchObject({
            kind: 'abort',
            tunnelId: 'voice-media:machine_1:request_frame_cap',
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            reasonCode: 'decoded_payload_too_large',
        });
        expect(connection.close).not.toHaveBeenCalled();
    });

    it('terminates identifiable Voice substreams through the application owner before the relay framed-message cap', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const connection = { write: vi.fn(), onData: vi.fn(), close: vi.fn() };
        const voiceBinaryAppendConsumer = vi.fn();
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(async () => connection),
            maxFramedMessageBytes: 64,
            voiceBinaryAppendConsumer,
        });

        const tunnelId = 'voice-media:machine_1:outer_frame_cap';
        const openEnvelope = createOpenEnvelope(tunnelId, {
            relayAuthorization: createRelayAuthorization(tunnelId, { flowKind: 'voice_media' }),
        });
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: { ...openEnvelope.frame.open, selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 },
            },
        });
        socket.emit.mockClear();

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            kind: 'data',
            sequence: 0,
            payload: '\0',
        }));

        expect(voiceBinaryAppendConsumer).not.toHaveBeenCalled();
        const emittedAbort = socket.emit.mock.calls
            .map((call) => call[1])
            .filter((payload) => typeof payload === 'object' && payload !== null && (payload as { v?: unknown }).v === 2)
            .map((payload) => decodePeerTcpTunnelBinaryFrameV2({
                frame: (payload as { frame: Uint8Array }).frame,
                maxHeaderBytes: 1024,
                maxPayloadBytes: 1024,
            }))
            .find((decoded) => decoded.ok && decoded.header.kind === 'abort');
        expect(emittedAbort?.ok ? emittedAbort.header : null).toMatchObject({
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            reasonCode: 'encoded_frame_too_large',
        });
        expect(connection.close).not.toHaveBeenCalled();
    });

    it('keeps daemon voice relay authorizations from carrying generic TCP tunnel traffic', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const writes: string[] = [];
        const connection = {
            write: vi.fn((bytes: Uint8Array) => {
                writes.push(Buffer.from(bytes).toString('utf8'));
            }),
            onData: vi.fn(),
            close: vi.fn(),
        };
        const connectTcp = vi.fn(async () => connection);
        const voiceBinaryAppendConsumer = vi.fn();

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
            voiceBinaryAppendConsumer,
        });

        const relayAuthorization = createRelayAuthorization('voice-media:machine_1:request_voice_only', {
            flowKind: 'voice_media',
            maxTotalBytes: 128,
        });
        const openEnvelope = createOpenEnvelope('voice-media:machine_1:request_voice_only', { relayAuthorization });
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(
            PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
            createDataEnvelope('voice-media:machine_1:request_voice_only', 'generic-tcp-data'),
        );
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'voice-media:machine_1:request_voice_only',
            substreamId: 'not-voice',
            kind: 'data',
            sequence: 0,
            payload: 'generic-substream-data',
        }));

        expect(connectTcp).not.toHaveBeenCalled();
        expect(writes).toEqual([]);
        expect(voiceBinaryAppendConsumer).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'voice-media:machine_1:request_voice_only',
                reasonCode: 'voice_relay_frame_not_allowed',
            }),
        }));
    });

    it('keeps generic TCP relay authorizations from dispatching daemon Voice application substreams', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const connection = { write: vi.fn(), onData: vi.fn(), close: vi.fn() };
        const connectTcp = vi.fn(async () => connection);
        const voiceBinaryAppendConsumer = vi.fn(async () => ({ ok: true }));
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
            voiceBinaryAppendConsumer,
        });

        const tunnelId = 'ordinary-tunnel-with-voice-substream';
        const openEnvelope = createOpenEnvelope(tunnelId, {
            relayAuthorization: createRelayAuthorization(tunnelId, { flowKind: 'tcp_tunnel' }),
        });
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            kind: 'data',
            sequence: 0,
            payload: 'voice-bytes',
        }));

        expect(voiceBinaryAppendConsumer).not.toHaveBeenCalled();
        expect(connection.write).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId,
                reasonCode: 'voice_relay_frame_not_allowed',
            }),
        }));
    });

    it('returns voice binary append events on the same relay substream', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const connection = {
            write: vi.fn(),
            onData: vi.fn(),
            close: vi.fn(),
        };
        const connectTcp = vi.fn(async () => connection);
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [{ type: 'partial', seq: input.seq, text: 'hel', isEndpoint: false, confidence: null }],
        }));

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
            voiceBinaryAppendConsumer,
        });

        const tunnelId = 'voice-media:machine_1:relay_voice_response';
        const openEnvelope = createOpenEnvelope(tunnelId, {
            relayAuthorization: createRelayAuthorization(tunnelId, { flowKind: 'voice_media' }),
        });
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        socket.emit.mockClear();
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            kind: 'data',
            sequence: 0,
            payload: '\0\0\u0001\0',
        }));

        const responseEnvelope = socket.emit.mock.calls
            .map((call) => call[1])
            .find((payload) => {
                if (typeof payload !== 'object' || payload === null || (payload as { v?: unknown }).v !== 2) {
                    return false;
                }
                const decoded = decodePeerTcpTunnelBinaryFrameV2({
                    frame: (payload as { frame: Uint8Array }).frame,
                    maxHeaderBytes: 1024,
                    maxPayloadBytes: 1024,
                });
                return decoded.ok
                    && decoded.header.kind === 'data'
                    && decoded.header.direction === 'daemon_to_client';
            });
        expect(responseEnvelope).toMatchObject({
            v: 2,
            scopeUserId: 'user_1',
            sender: { kind: 'machine', machineId: 'machine_1' },
            recipient: { kind: 'user' },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        });
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: (responseEnvelope as { frame: Uint8Array }).frame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decoded.ok ? decoded.header : null).toMatchObject({
            kind: 'data',
            tunnelId,
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
    });

    it('meters voice-bound binary_frame_v2 substream bytes before dispatching PCM to STT', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const connection = {
            write: vi.fn(),
            onData: vi.fn(),
            close: vi.fn(),
        };
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [],
        }));

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(async () => connection),
            voiceBinaryAppendConsumer,
        });

        const tunnelId = 'voice-media:machine_1:relay_voice_cap';
        const openEnvelope = createOpenEnvelope(tunnelId, {
            relayAuthorization: createRelayAuthorization(tunnelId, {
                flowKind: 'voice_media',
                maxTotalBytes: 512,
            }),
        });
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            kind: 'data',
            sequence: 0,
            payload: '\0\0\0',
        }));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            kind: 'data',
            sequence: 1,
            payload: '\0'.repeat(512),
        }));

        expect(voiceBinaryAppendConsumer).toHaveBeenCalledTimes(1);
        const applicationAbort = socket.emit.mock.calls
            .map((call) => call[1])
            .filter((payload) => typeof payload === 'object' && payload !== null && (payload as { v?: unknown }).v === 2)
            .map((payload) => decodePeerTcpTunnelBinaryFrameV2({
                frame: (payload as { frame: Uint8Array }).frame,
                maxHeaderBytes: 1024,
                maxPayloadBytes: 1024,
            }))
            .find((decoded) => decoded.ok && decoded.header.kind === 'abort');
        expect(applicationAbort && applicationAbort.ok ? applicationAbort.header : null).toMatchObject({
            kind: 'abort',
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            reasonCode: 'substream_cap_exceeded',
        });
        expect(connection.write).not.toHaveBeenCalled();
    });

    it('meters voice relay response bytes through the same signed aggregate before emitting them', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const connection = { write: vi.fn(), onData: vi.fn(), close: vi.fn() };
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [],
        }));
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(async () => connection),
            voiceBinaryAppendConsumer,
        });

        const tunnelId = 'voice-media:machine_1:response_aggregate';
        const openEnvelope = createOpenEnvelope(tunnelId, {
            relayAuthorization: createRelayAuthorization(tunnelId, {
                flowKind: 'voice_media',
                maxTotalBytes: 4,
            }),
        });
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: { ...openEnvelope.frame.open, selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 },
            },
        });
        socket.emit.mockClear();
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            kind: 'data',
            sequence: 0,
            payload: '\0\0\u0001\0',
        }));

        const binaryFrames = socket.emit.mock.calls
            .map((call) => call[1])
            .filter((payload) => typeof payload === 'object' && payload !== null && (payload as { v?: unknown }).v === 2)
            .map((payload) => decodePeerTcpTunnelBinaryFrameV2({
                frame: (payload as { frame: Uint8Array }).frame,
                maxHeaderBytes: 1024,
                maxPayloadBytes: 1024,
            }));
        expect(binaryFrames.some((decoded) => decoded.ok && decoded.header.kind === 'data')).toBe(false);
        expect(binaryFrames.some((decoded) => decoded.ok
            && decoded.header.kind === 'abort'
            && decoded.header.reasonCode === 'substream_cap_exceeded')).toBe(true);
        expect(voiceBinaryAppendConsumer).toHaveBeenCalledOnce();
        expect(connection.close).not.toHaveBeenCalled();
    });

    it('leaves non-voice relay binary_frame_v2 substreams on the normal TCP tunnel path when a voice consumer is installed', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const writesByConnection: string[][] = [];
        const connectTcp = vi.fn(async () => {
            const index = writesByConnection.length;
            writesByConnection.push([]);
            return {
                write: vi.fn((bytes: Uint8Array) => {
                    writesByConnection[index]?.push(Buffer.from(bytes).toString('utf8'));
                }),
                onData: vi.fn(),
                close: vi.fn(),
            };
        });
        const voiceBinaryAppendConsumer = vi.fn(async (input) => ({
            ok: true as const,
            streamId: input.streamId,
            generation: input.generation,
            ackSeq: input.seq,
            events: [],
        }));

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
            voiceBinaryAppendConsumer,
        });

        const openEnvelope = createOpenEnvelope('tun_relay_non_voice');
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_relay_non_voice',
            substreamId: 'ordinary-substream',
            kind: 'open',
        }));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_relay_non_voice',
            substreamId: 'ordinary-substream',
            kind: 'data',
            payload: 'hello',
        }));

        expect(voiceBinaryAppendConsumer).not.toHaveBeenCalled();
        expect(connectTcp).toHaveBeenCalledTimes(2);
        expect(writesByConnection[1]).toEqual(['hello']);
    });

    it('queues binary_frame_v2 substream frames that arrive while the authorized relay tunnel is opening', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const baseConnection = { write: vi.fn(), close: vi.fn() };
        const substreamConnection = { write: vi.fn(), onData: vi.fn(), close: vi.fn() };
        const baseConnect = deferred<typeof baseConnection>();
        const connectTcp = vi.fn()
            .mockImplementationOnce(async () => await baseConnect.promise)
            .mockResolvedValueOnce(substreamConnection);

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
        });

        const openEnvelope = createOpenEnvelope('tun_mux_opening');
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        const openPromise = socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                    supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
                    allowV1Fallback: false,
                },
            },
        });
        await Promise.resolve();

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux_opening',
            substreamId: 'sub_early',
            kind: 'open',
        }));

        expect(socket.emit).not.toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                reasonCode: 'tunnel_not_open',
            }),
        }));

        baseConnect.resolve(baseConnection);
        await openPromise;

        expect(connectTcp).toHaveBeenCalledTimes(2);
        expect(connectTcp).toHaveBeenNthCalledWith(1, { host: '127.0.0.1', port: 3000 });
        expect(connectTcp).toHaveBeenNthCalledWith(2, { host: '127.0.0.1', port: 3000 });
    });

    it('does not echo terminal frames for unknown relay tunnels', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(),
        });

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            v: 1,
            scopeUserId: 'user_1',
            sender: { kind: 'user' },
            recipient: { kind: 'machine', machineId: 'machine_1' },
            frame: {
                v: 1,
                kind: 'abort',
                tunnelId: 'missing_tunnel',
                reasonCode: 'upstream_closed',
            },
        });

        expect(socket.emit).not.toHaveBeenCalled();
    });

    it('keeps sibling binary_frame_v2 substreams open after one substream aborts', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const writesByConnection: string[][] = [];
        const connectTcp = vi.fn(async () => {
            const index = writesByConnection.length;
            writesByConnection.push([]);
            return {
                write: vi.fn((bytes: Uint8Array) => {
                    writesByConnection[index]?.push(Buffer.from(bytes).toString('utf8'));
                }),
                onData: vi.fn(),
                close: vi.fn(),
            };
        });

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp,
        });

        const openEnvelope = createOpenEnvelope('tun_mux_abort');
        expect(openEnvelope.frame.kind).toBe('open');
        if (openEnvelope.frame.kind !== 'open') throw new Error('expected open frame fixture');
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
            ...openEnvelope,
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    ...openEnvelope.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux_abort',
            substreamId: 'sub_a',
            kind: 'open',
        }));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux_abort',
            substreamId: 'sub_b',
            kind: 'open',
        }));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux_abort',
            substreamId: 'sub_a',
            kind: 'abort',
        }));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createBinarySubstreamEnvelope({
            tunnelId: 'tun_mux_abort',
            substreamId: 'sub_b',
            kind: 'data',
            payload: 'beta-after',
        }));

        expect(connectTcp).toHaveBeenCalledTimes(3);
        expect(writesByConnection[2]).toEqual(['beta-after']);
    });

    it('emits daemon observability lifecycle events for accepted relay tunnels', async () => {
        const mod = await loadRelayModule();
        expect(mod?.registerPeerTcpTunnelRelayTerminator).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelayTerminator) return;

        const socket = createSocket();
        const emitted: unknown[] = [];
        const connection = {
            write: vi.fn(),
            close: vi.fn(),
        };

        mod.registerPeerTcpTunnelRelayTerminator({
            accountId: 'user_1',
            machineId: 'machine_1',
            socket,
            nowMs: () => 2_000,
            relayAuthorizationTrustRoots,
            connectTcp: vi.fn(async () => connection),
            observability: {
                emit: (event) => emitted.push(event),
            },
        });

        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope('tun_observable'));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createDataEnvelope('tun_observable', 'secret-payload'));
        await socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createCloseEnvelope('tun_observable'));

        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'flow.ready', flow: expect.objectContaining({ flowId: 'tun_observable' }) }),
            expect.objectContaining({ kind: 'flow.closed', flow: expect.objectContaining({ flowId: 'tun_observable' }) }),
        ]));
        const serialized = JSON.stringify(emitted);
        expect(serialized).not.toContain('secret-payload');
        expect(serialized).toContain('"machineId":"machine_1"');
    });
});
