import {
    createPeerTcpTunnelRelayAuthorizationSigningInputV2,
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerApplicationEncryptedFrameV1,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import type {
    PeerTcpTunnelRelayAdmissionResult,
    PeerTcpTunnelRelayCoordinator,
} from './relayCoordinator';

type RegisterRelayModule = typeof import('./registerRelay');

async function loadRegisterRelayModule(): Promise<RegisterRelayModule | null> {
    const modulePath = './registerRelay.js';
    return import(modulePath).catch(() => null) as Promise<RegisterRelayModule | null>;
}

function createSocket(overrides?: Readonly<{ id?: string; clientType?: string; machineId?: string }>) {
    const handlers = new Map<string, (payload?: unknown) => void>();
    return {
        id: overrides?.id ?? 'socket_1',
        data: {
            clientType: overrides?.clientType ?? 'user-scoped',
            ...(overrides?.machineId ? { machineId: overrides.machineId } : {}),
        },
        on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
            if (handlers.has(event)) throw new Error(`duplicate event ${event}`);
            handlers.set(event, handler);
        }),
        emit: vi.fn(),
        trigger: (event: string, payload?: unknown) => handlers.get(event)?.(payload),
    };
}

function createIo() {
    const roomEmit = vi.fn();
    const localRoomEmit = vi.fn((event: string, payload: unknown) => roomEmit(event, payload));
    return {
        roomEmit,
        localRoomEmit,
        to: vi.fn((_room: string) => ({ emit: roomEmit })),
        local: {
            to: vi.fn((_room: string) => ({ emit: localRoomEmit })),
        },
    };
}

function createIsolatedReplicaCoordinator(
    onOwnerEnvelope?: (envelope: Parameters<PeerTcpTunnelRelayCoordinator['routeOwnerEnvelope']>[0]['envelope']) => void,
): Readonly<{
    coordinator: PeerTcpTunnelRelayCoordinator;
    disconnectMachine(): void;
}> {
    let attachment: Readonly<{
        tunnelKey: string;
        machineSocketId: string;
        onMachineEnvelope: Parameters<PeerTcpTunnelRelayCoordinator['admit']>[0]['onMachineEnvelope'];
        onMachineDisconnect: Parameters<PeerTcpTunnelRelayCoordinator['admit']>[0]['onMachineDisconnect'];
    }> | null = null;
    return {
        coordinator: {
            admit: async (input) => {
                attachment = {
                    tunnelKey: input.tunnelKey,
                    machineSocketId: 'socket_machine_remote_replica',
                    onMachineEnvelope: input.onMachineEnvelope,
                    onMachineDisconnect: input.onMachineDisconnect,
                };
                return { status: 'attached' };
            },
            routeMachineEnvelope: (input) => {
                if (
                    !attachment
                    || attachment.tunnelKey !== input.tunnelKey
                    || attachment.machineSocketId !== input.machineSocketId
                ) {
                    return 'rejected';
                }
                void attachment.onMachineEnvelope(input.envelope, input.machineSocketId);
                return 'remote_forwarded';
            },
            routeOwnerEnvelope: (input) => {
                if (!attachment || attachment.tunnelKey !== input.tunnelKey) return false;
                onOwnerEnvelope?.(input.envelope);
                return true;
            },
            release: (tunnelKey) => {
                if (attachment?.tunnelKey === tunnelKey) attachment = null;
            },
            close: async () => {
                attachment = null;
            },
        },
        disconnectMachine: () => {
            void attachment?.onMachineDisconnect();
        },
    };
}

const relayKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6));
const relayAuthorizationTrustRoots = [{
    keyId: 'relay_key_1',
    publicKeyBase64Url: Buffer.from(relayKeyPair.publicKey).toString('base64url'),
}] as const;

function createRelayAuthorization(
    tunnelId: string,
    destination: Readonly<{ host: string; port: number }>,
    overrides?: Readonly<{
        accountId?: string;
        targetMachineId?: string;
        relaySocketId?: string;
        signatureBase64Url?: string;
        flowKind?: 'tcp_tunnel' | 'voice_media';
    }>,
) {
    const issuedAt = Date.now();
    const payload = {
        v: 2,
        grantId: `relay_grant_${tunnelId}`,
        accountId: overrides?.accountId ?? 'user_1',
        targetMachineId: overrides?.targetMachineId ?? 'machine_1',
        flowKind: overrides?.flowKind ?? 'tcp_tunnel',
        ...((overrides?.flowKind ?? 'tcp_tunnel') === 'voice_media' ? {
            applicationKind: 'speech_transcription' as const,
            applicationAttemptId: `attempt_${tunnelId}`,
            applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
        } : {}),
        routeKind: 'server_relay',
        tunnelId,
        relaySocketId: overrides?.relaySocketId ?? 'socket_1',
        destination,
        capProfileId: 'interactive',
        maxFrameBytes: 64 * 1024,
        maxIdleMs: 30_000,
        maxDurationMs: 300_000,
        maxTotalBytes: 64 * 1024 * 1024,
        iat: issuedAt,
        exp: issuedAt + 300_000,
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
    destinationInput: number | Readonly<{ host: string; port: number }> = 3000,
    overrides?: Readonly<{
        recipientMachineId?: string;
        routeKind?: 'loopback_direct' | 'server_relay';
        targetMachineId?: string;
        relaySocketId?: string;
        relayAuthorization?: ReturnType<typeof createRelayAuthorization>;
    }>,
) {
    const destination = typeof destinationInput === 'number'
        ? { host: '127.0.0.1', port: destinationInput } as const
        : destinationInput;
    const targetMachineId = overrides?.targetMachineId ?? 'machine_1';
    return {
        v: 1,
        scopeUserId: 'user_1',
        sender: { kind: 'user', socketId: overrides?.relaySocketId ?? 'socket_1' },
        recipient: { kind: 'machine', machineId: overrides?.recipientMachineId ?? targetMachineId },
        frame: {
            v: 1,
            kind: 'open',
            open: {
                v: 1,
                kind: 'open',
                tunnelId,
                targetMachineId,
                routeKind: overrides?.routeKind ?? 'server_relay',
                destination,
                relayAuthorization: overrides?.relayAuthorization ?? createRelayAuthorization(tunnelId, destination, {
                    targetMachineId,
                    relaySocketId: overrides?.relaySocketId,
                }),
            },
        },
    } as const;
}

function createDataEnvelope(tunnelId: string, payload: string, sequence = 0) {
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
            sequence,
            payloadBase64: Buffer.from(payload).toString('base64'),
        },
    } as const;
}

function createMachineDataEnvelope(
    tunnelId: string,
    payload: string,
    sequence = 0,
    overrides?: Readonly<{
        senderMachineId?: string;
        recipient?: { kind: 'user'; socketId?: string };
    }>,
) {
    return {
        v: 1,
        scopeUserId: 'user_1',
        sender: { kind: 'machine', machineId: overrides?.senderMachineId ?? 'machine_1' },
        recipient: overrides?.recipient ?? { kind: 'user' },
        frame: {
            v: 1,
            kind: 'data',
            tunnelId,
            direction: 'daemon_to_client',
            sequence,
            payloadBase64: Buffer.from(payload).toString('base64'),
        },
    } as const;
}

function createCloseEnvelope(tunnelId: string) {
    return {
        v: 1,
        scopeUserId: 'user_1',
        sender: { kind: 'user' },
        recipient: { kind: 'machine', machineId: 'machine_1' },
        frame: {
            v: 1,
            kind: 'close',
            tunnelId,
            halfClose: false,
            reasonCode: 'client_closed',
        },
    } as const;
}

function createBinaryEnvelope(input: Readonly<{
    tunnelId: string;
    sender?: { kind: 'user' } | { kind: 'machine'; machineId: string };
    recipient?: { kind: 'user' } | { kind: 'machine'; machineId: string };
    direction?: 'client_to_daemon' | 'daemon_to_client';
    payload?: Uint8Array;
    kind?: 'open' | 'data' | 'ack' | 'close' | 'abort';
    substreamId?: string;
    halfClose?: boolean;
    reasonCode?: string;
}>) {
    const sender = input.sender ?? { kind: 'user' as const };
    return {
        v: 2,
        scopeUserId: 'user_1',
        sender,
        recipient: input.recipient ?? { kind: 'machine' as const, machineId: 'machine_1' },
        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        frame: encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: input.kind ?? 'data',
                tunnelId: input.tunnelId,
                ...(input.substreamId ? { substreamId: input.substreamId } : {}),
                ...(input.kind === 'open'
                    ? {}
                    : { direction: input.direction ?? (sender.kind === 'user' ? 'client_to_daemon' as const : 'daemon_to_client' as const) }),
                ...((input.kind ?? 'data') === 'data' ? { sequence: 0 } : {}),
                ...(input.halfClose !== undefined ? { halfClose: input.halfClose } : {}),
                ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
                payloadLength: input.payload?.byteLength ?? 0,
            },
            payload: input.payload,
        }),
    } as const;
}

function findBinaryAbortForSubstream(io: ReturnType<typeof createIo>, substreamId: string): boolean {
    return io.roomEmit.mock.calls.some(([, payload]) => {
        const envelope = payload as { v?: number; frame?: Uint8Array };
        if (envelope.v !== 2 || !(envelope.frame instanceof Uint8Array)) return false;
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: envelope.frame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        return decoded.ok
            && decoded.header.kind === 'abort'
            && decoded.header.substreamId === substreamId
            && decoded.header.reasonCode === 'relay_cap_exceeded';
    });
}

describe('registerPeerTcpTunnelRelaySocketHandler', () => {
    it('fails duplicate tunnel handler registration on one socket', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();

        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');
        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io: createIo(),
            serverRoutedEnabled: false,
        });

        expect(() => mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io: createIo(),
            serverRoutedEnabled: false,
        })).toThrow(/tunnel.*already registered/i);
    });

    it('emits structured aborts instead of relaying when server-routed tunnels are disabled', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: false,
        });

        socket.trigger('peer:tunnel:v1', {
            v: 1,
            scopeUserId: 'user_1',
            sender: { kind: 'user', socketId: 'socket_1' },
            recipient: { kind: 'machine', machineId: 'machine_1' },
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    v: 1,
                    kind: 'open',
                    tunnelId: 'tun_1',
                    targetMachineId: 'machine_1',
                    routeKind: 'server_relay',
                    destination: { host: '127.0.0.1', port: 3000 },
                    relayAuthorization: createRelayAuthorization('tun_1', { host: '127.0.0.1', port: 3000 }),
                },
            },
        });

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_1',
                reasonCode: 'relay_disabled_by_server_policy',
            }),
        }));
        expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
            type: 'peer-tunnel',
        }));
    });

    it('rejects non-loopback server-routed tunnel destinations before relaying', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        socket.trigger('peer:tunnel:v1', {
            v: 1,
            scopeUserId: 'user_1',
            sender: { kind: 'user', socketId: 'socket_1' },
            recipient: { kind: 'machine', machineId: 'machine_1' },
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    v: 1,
                    kind: 'open',
                    tunnelId: 'tun_1',
                    targetMachineId: 'machine_1',
                    routeKind: 'server_relay',
                    destination: { host: '192.168.1.10', port: 3000 },
                    relayAuthorization: createRelayAuthorization('tun_1', { host: '192.168.1.10', port: 3000 }),
                },
            },
        });

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_1',
                reasonCode: 'destination_host_not_allowed',
            }),
        }));
    });

    it('rejects data frames before a server-authorized tunnel open succeeds', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        socket.trigger('peer:tunnel:v1', {
            v: 1,
            scopeUserId: 'user_1',
            sender: { kind: 'user' },
            recipient: { kind: 'machine', machineId: 'machine_1' },
            frame: {
                v: 1,
                kind: 'data',
                tunnelId: 'tun_1',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadBase64: Buffer.from('hello').toString('base64'),
            },
        });

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_1',
                reasonCode: 'tunnel_not_open',
            }),
        }));
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({ kind: 'data' }),
        }));
    });

    it('rejects user-sent relay data frames that spoof the daemon-to-client direction', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_direction'));
        socket.trigger('peer:tunnel:v1', {
            ...createDataEnvelope('tun_direction', 'spoof'),
            frame: {
                ...createDataEnvelope('tun_direction', 'spoof').frame,
                direction: 'daemon_to_client',
            },
        });

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_direction',
                reasonCode: 'direction_not_allowed',
            }),
        }));
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'data',
                direction: 'daemon_to_client',
            }),
        }));

        socket.trigger('disconnect');
    });

    it('rejects machine-sent relay data frames that spoof the client-to-daemon direction', async () => {
        const mod = await loadRegisterRelayModule();
        const userSocket = createSocket();
        const machineSocket = createSocket({ clientType: 'machine-scoped', machineId: 'machine_1' });
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', userSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });
        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', machineSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        userSocket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_machine_direction'));
        machineSocket.trigger('peer:tunnel:v1', {
            ...createMachineDataEnvelope('tun_machine_direction', 'spoof'),
            frame: {
                ...createMachineDataEnvelope('tun_machine_direction', 'spoof').frame,
                direction: 'client_to_daemon',
            },
        });

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_machine_direction',
                reasonCode: 'direction_not_allowed',
            }),
        }));
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'data',
                direction: 'client_to_daemon',
            }),
        }));

        userSocket.trigger('disconnect');
        machineSocket.trigger('disconnect');
    });

    it('rejects tunnel opens when the declared sender is not bound to the authenticated socket', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket({ clientType: 'user-scoped' });
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        socket.trigger('peer:tunnel:v1', {
            v: 1,
            scopeUserId: 'user_1',
            sender: { kind: 'machine', machineId: 'machine_1' },
            recipient: { kind: 'user' },
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    v: 1,
                    kind: 'open',
                    tunnelId: 'tun_1',
                    targetMachineId: 'machine_1',
                    routeKind: 'server_relay',
                    destination: { host: '127.0.0.1', port: 3000 },
                    relayAuthorization: createRelayAuthorization('tun_1', { host: '127.0.0.1', port: 3000 }),
                },
            },
        });

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_1',
                reasonCode: 'socket_binding_mismatch',
            }),
        }));
        expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
            type: 'peer-tunnel',
        }));
    });

    it('authorizes server relay opens through socket binding and destination policy without direct-route grants', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        socket.trigger('peer:tunnel:v1', {
            v: 1,
            scopeUserId: 'user_1',
            sender: { kind: 'user', socketId: 'socket_1' },
            recipient: { kind: 'machine', machineId: 'machine_1' },
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    v: 1,
                    kind: 'open',
                    tunnelId: 'tun_1',
                    targetMachineId: 'machine_1',
                    routeKind: 'server_relay',
                    destination: { host: '127.0.0.1', port: 3000 },
                    relayAuthorization: createRelayAuthorization('tun_1', { host: '127.0.0.1', port: 3000 }),
                },
            },
        });

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'open',
            }),
        }));
        expect(io.to).toHaveBeenCalledWith('machine:machine_1:user_1');
        expect(io.to).not.toHaveBeenCalledWith('user-machines:user_1');
        expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    });

    it('delivers machine-recipient relay frames only to the exact machine room', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_machine_exact'));

        expect(io.to).toHaveBeenCalledWith('machine:machine_1:user_1');
        expect(io.to).not.toHaveBeenCalledWith('user-machines:user_1');
    });

    it('delivers user-recipient relay frames only to the targeted socket id when present', async () => {
        const mod = await loadRegisterRelayModule();
        const userSocket = createSocket({ id: 'socket_user_tab_1' });
        const machineSocket = createSocket({
            id: 'socket_machine_1',
            clientType: 'machine-scoped',
            machineId: 'machine_1',
        });
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', userSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });
        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', machineSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        userSocket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_user_exact', 3000, {
            relaySocketId: 'socket_user_tab_1',
        }));
        machineSocket.trigger('peer:tunnel:v1', createMachineDataEnvelope(
            'tun_user_exact',
            'pong',
            0,
            { recipient: { kind: 'user', socketId: 'socket_user_tab_1' } },
        ));

        expect(io.to).toHaveBeenCalledWith('socket_user_tab_1');
        expect(io.to).not.toHaveBeenCalledWith('user:user_1');

        userSocket.trigger('disconnect');
        machineSocket.trigger('disconnect');
    });

    it('rejects machine frames that redirect an open tunnel to another same-account user socket', async () => {
        const mod = await loadRegisterRelayModule();
        const userSocket = createSocket({ id: 'socket_user_tab_1' });
        const machineSocket = createSocket({
            id: 'socket_machine_1',
            clientType: 'machine-scoped',
            machineId: 'machine_1',
        });
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', userSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });
        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', machineSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        userSocket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_user_redirect', 3000, {
            relaySocketId: 'socket_user_tab_1',
        }));
        const redirectedFrame = createMachineDataEnvelope(
            'tun_user_redirect',
            'must-not-leak',
            0,
            { recipient: { kind: 'user', socketId: 'socket_user_tab_2' } },
        );
        machineSocket.trigger('peer:tunnel:v1', redirectedFrame);

        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', redirectedFrame);
        expect(machineSocket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
            type: 'peer-tunnel',
        }));

        userSocket.trigger('disconnect');
        machineSocket.trigger('disconnect');
    });

    it('rejects server relay opens with invalid relay authorization signatures before relaying', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        const coordinator: PeerTcpTunnelRelayCoordinator = {
            admit: vi.fn(async (): Promise<PeerTcpTunnelRelayAdmissionResult> => ({ status: 'attached' })),
            routeMachineEnvelope: () => 'rejected',
            routeOwnerEnvelope: vi.fn(() => false),
            release: () => undefined,
            close: async () => undefined,
        };
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            coordinator,
        });

        const destination = { host: '127.0.0.1', port: 3000 } as const;
        socket.trigger('peer:tunnel:v1', {
            ...createOpenEnvelope('tun_bad_signature'),
            frame: {
                ...createOpenEnvelope('tun_bad_signature').frame,
                open: {
                    ...createOpenEnvelope('tun_bad_signature').frame.open,
                    relayAuthorization: createRelayAuthorization('tun_bad_signature', destination, {
                        signatureBase64Url: Buffer.from(new Uint8Array(64).fill(1)).toString('base64url'),
                    }),
                },
            },
        });

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_bad_signature',
                reasonCode: 'relay_authorization_invalid',
            }),
        }));
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({ kind: 'open' }),
        }));
        expect(io.to).not.toHaveBeenCalledWith('machine:machine_1:user_1');
        expect(io.local.to).toHaveBeenCalledWith('socket_1');
        expect(coordinator.admit).not.toHaveBeenCalled();
        expect(coordinator.routeOwnerEnvelope).not.toHaveBeenCalled();
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
    ])('rejects relay authorization binding mismatches for $name before consuming the grant', async (testCase) => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000, 3001],
            relayAuthorizationTrustRoots,
        });

        const relayAuthorization = createRelayAuthorization(
            testCase.authorizedTunnelId,
            testCase.authorizedDestination,
            { targetMachineId: testCase.authorizedTargetMachineId },
        );
        socket.trigger('peer:tunnel:v1', createOpenEnvelope(testCase.openTunnelId, testCase.openDestination, {
            targetMachineId: testCase.openTargetMachineId,
            recipientMachineId: testCase.openTargetMachineId,
            relayAuthorization,
        }));
        socket.trigger('peer:tunnel:v1', createOpenEnvelope(testCase.authorizedTunnelId, testCase.authorizedDestination, {
            targetMachineId: testCase.authorizedTargetMachineId,
            recipientMachineId: testCase.authorizedTargetMachineId,
            relayAuthorization,
        }));

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: testCase.openTunnelId,
                reasonCode: 'relay_authorization_invalid',
            }),
        }));
        const relayedOpenCalls = io.roomEmit.mock.calls.filter(([, payload]) =>
            (payload as { frame?: { kind?: string } }).frame?.kind === 'open',
        );
        expect(relayedOpenCalls).toHaveLength(1);
        expect((relayedOpenCalls[0]?.[1] as { frame?: { open?: { tunnelId?: string } } }).frame?.open?.tunnelId)
            .toBe(testCase.authorizedTunnelId);

        socket.trigger('disconnect');
    });

    it('rejects duplicate active open frames for the same authorized tunnel key', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_duplicate'));
        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_duplicate'));

        const relayedOpenCalls = io.roomEmit.mock.calls.filter(([, payload]) =>
            (payload as { frame?: { kind?: string } }).frame?.kind === 'open',
        );
        expect(relayedOpenCalls).toHaveLength(1);
        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_duplicate',
                reasonCode: 'tunnel_id_already_open',
            }),
        }));

        socket.trigger('disconnect');
    });

    it('bounds concurrent pending attachment admission and rejects a duplicate pending tunnel', async () => {
        const mod = await loadRegisterRelayModule();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelaySocketHandler) return;

        let settleAdmission!: (result: { status: 'attached' }) => void;
        const admittedTunnelKeys: string[] = [];
        const io = createIo();
        const coordinator: PeerTcpTunnelRelayCoordinator = {
            admit: (input) => {
                admittedTunnelKeys.push(input.tunnelKey);
                return new Promise<PeerTcpTunnelRelayAdmissionResult>((resolve) => {
                    settleAdmission = resolve;
                });
            },
            routeMachineEnvelope: () => 'rejected',
            routeOwnerEnvelope: (input) => {
                io.to('socket_machine_attached').emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, input.envelope);
                return true;
            },
            release: () => undefined,
            close: async () => undefined,
        };
        const socket = createSocket();
        mod.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000, 3001],
            relayAuthorizationTrustRoots,
            maxActiveTunnelsPerSocket: 1,
            coordinator,
        });

        socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope('tun_pending_1', 3000));
        socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope('tun_pending_2', 3001));
        socket.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope('tun_pending_1', 3000));

        expect(admittedTunnelKeys).toHaveLength(1);
        expect(io.roomEmit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_pending_2',
                reasonCode: 'relay_cap_exceeded',
            }),
        }));
        expect(io.roomEmit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_pending_1',
                reasonCode: 'tunnel_id_already_open',
            }),
        }));

        settleAdmission({ status: 'attached' });
        await vi.waitFor(() => {
            expect(io.roomEmit.mock.calls.filter(([, payload]) =>
                (payload as { frame?: { open?: { tunnelId?: unknown } } }).frame?.open?.tunnelId === 'tun_pending_1',
            )).toHaveLength(1);
        });
        socket.trigger('disconnect');
    });

    it('rejects replayed relay authorizations after a tunnel is closed', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000, 3001],
            relayAuthorizationTrustRoots,
            maxActiveTunnelsPerSocket: 1,
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_replay'));
        socket.trigger('peer:tunnel:v1', createCloseEnvelope('tun_replay'));
        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_replay'));
        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_after_replay', 3001));

        const relayedOpenCalls = io.roomEmit.mock.calls.filter(([, payload]) =>
            (payload as { frame?: { kind?: string } }).frame?.kind === 'open',
        );
        expect(relayedOpenCalls).toHaveLength(2);
        expect(relayedOpenCalls.map(([, payload]) =>
            (payload as { frame?: { open?: { tunnelId?: string } } }).frame?.open?.tunnelId,
        )).toEqual(['tun_replay', 'tun_after_replay']);
        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_replay',
                reasonCode: 'relay_authorization_invalid',
            }),
        }));

        socket.trigger('disconnect');
    });

    it('rejects an exact relay authorization replay on a replacement socket after handler lifecycle loss', async () => {
        vi.resetModules();
        const firstModule = await loadRegisterRelayModule();
        const socketA = createSocket({ id: 'relay_socket_a' });
        const ioA = createIo();
        const authorization = createRelayAuthorization('tun_cross_lifecycle', { host: '127.0.0.1', port: 3000 }, {
            targetMachineId: 'machine_1',
            relaySocketId: 'relay_socket_a',
        });
        const open = createOpenEnvelope('tun_cross_lifecycle', 3000, {
            relaySocketId: 'relay_socket_a',
            relayAuthorization: authorization,
        });

        firstModule?.registerPeerTcpTunnelRelaySocketHandler('user_1', socketA, {
            io: ioA,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });
        socketA.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, open);
        expect(ioA.roomEmit.mock.calls.filter(([, payload]) =>
            (payload as { frame?: { kind?: string } }).frame?.kind === 'open',
        )).toHaveLength(1);

        // Model a different server replica / restarted handler whose process-local
        // relay-consumption state has never seen the authorization.
        vi.resetModules();
        const replacementModule = await loadRegisterRelayModule();
        const socketB = createSocket({ id: 'relay_socket_b' });
        const ioB = createIo();
        replacementModule?.registerPeerTcpTunnelRelaySocketHandler('user_1', socketB, {
            io: ioB,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });
        socketB.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, open);

        expect(ioB.roomEmit.mock.calls.filter(([, payload]) =>
            (payload as { frame?: { kind?: string } }).frame?.kind === 'open',
        )).toHaveLength(0);
        expect(ioB.roomEmit).toHaveBeenCalledWith(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_cross_lifecycle',
                reasonCode: 'relay_authorization_invalid',
            }),
        }));

        const replacementAuthorization = createRelayAuthorization(
            'tun_replacement_grant',
            { host: '127.0.0.1', port: 3000 },
            { targetMachineId: 'machine_1', relaySocketId: 'relay_socket_b' },
        );
        socketB.trigger(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope(
            'tun_replacement_grant',
            3000,
            { relaySocketId: 'relay_socket_b', relayAuthorization: replacementAuthorization },
        ));
        expect(ioB.roomEmit.mock.calls.filter(([, payload]) =>
            (payload as { frame?: { kind?: string } }).frame?.kind === 'open',
        )).toHaveLength(1);

        socketA.trigger('disconnect');
        socketB.trigger('disconnect');
    }, 60_000);

    it('enforces the configured max active relay tunnel cap', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000, 3001],
            relayAuthorizationTrustRoots,
            maxActiveTunnelsPerSocket: 1,
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_cap_1', 3000));
        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_cap_2', 3001));

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_cap_2',
                reasonCode: 'relay_cap_exceeded',
            }),
        }));

        socket.trigger('disconnect');
    });

    it('releases relay tunnel keys from both participant sockets after terminal close', async () => {
        const mod = await loadRegisterRelayModule();
        const userSocket = createSocket();
        const machineSocket = createSocket({ clientType: 'machine-scoped', machineId: 'machine_1' });
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', userSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000, 3001],
            relayAuthorizationTrustRoots,
            maxActiveTunnelsPerSocket: 1,
        });
        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', machineSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000, 3001],
            relayAuthorizationTrustRoots,
            maxActiveTunnelsPerSocket: 1,
        });

        userSocket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_socket_release_1', 3000));
        machineSocket.trigger('peer:tunnel:v1', createMachineDataEnvelope('tun_socket_release_1', 'pong'));
        userSocket.trigger('peer:tunnel:v1', createCloseEnvelope('tun_socket_release_1'));
        userSocket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_socket_release_2', 3001));

        const secondTunnelMachineFrame = createMachineDataEnvelope('tun_socket_release_2', 'pong');
        machineSocket.trigger('peer:tunnel:v1', secondTunnelMachineFrame);

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', secondTunnelMachineFrame);
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_socket_release_2',
                reasonCode: 'relay_cap_exceeded',
            }),
        }));

        userSocket.trigger('disconnect');
        machineSocket.trigger('disconnect');
    });

    it('rejects same-account user-socket takeover attempts for an existing tunnel without closing the opener tunnel', async () => {
        const mod = await loadRegisterRelayModule();
        const openerSocket = createSocket({ id: 'socket_user_a' });
        const takeoverSocket = createSocket({ id: 'socket_user_b', clientType: 'session-scoped' });
        const machineSocket = createSocket({
            id: 'socket_machine_1',
            clientType: 'machine-scoped',
            machineId: 'machine_1',
        });
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', openerSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });
        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', takeoverSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });
        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', machineSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        openerSocket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_takeover', 3000, {
            relaySocketId: 'socket_user_a',
        }));
        const takeoverClose = createCloseEnvelope('tun_takeover');
        takeoverSocket.trigger('peer:tunnel:v1', takeoverClose);

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_takeover',
                reasonCode: 'socket_binding_mismatch',
            }),
        }));
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', takeoverClose);

        const machineData = createMachineDataEnvelope('tun_takeover', 'still-open');
        machineSocket.trigger('peer:tunnel:v1', machineData);

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', machineData);
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_takeover',
                reasonCode: 'tunnel_not_open',
            }),
        }));

        openerSocket.trigger('disconnect');
        takeoverSocket.trigger('disconnect');
        machineSocket.trigger('disconnect');
    });

    it('enforces the configured relay byte cap', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        const emitted: unknown[] = [];
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            maxBytes: 4,
            maxFrameBytes: 64,
            observability: {
                emit: (event) => emitted.push(event),
            },
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_bytes'));
        socket.trigger('peer:tunnel:v1', createDataEnvelope('tun_bytes', 'hello'));

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_bytes',
                reasonCode: 'relay_cap_exceeded',
            }),
        }));
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'flow.closed',
                flow: expect.objectContaining({ flowId: 'tun_bytes' }),
                data: expect.objectContaining({
                    reasonCode: 'relay_cap_exceeded',
                    cleanupSettled: true,
                }),
            }),
        ]));

        socket.trigger('peer:tunnel:v1', createDataEnvelope('tun_bytes', 'x'));
        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_bytes',
                reasonCode: 'tunnel_not_open',
            }),
        }));

        socket.trigger('disconnect');
    });

    it('relays negotiated binary_frame_v2 frames without base64-wrapping the payload', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        const openEnvelope = createOpenEnvelope('tun_binary');
        expect(openEnvelope.frame.kind).toBe('open');
        socket.trigger('peer:tunnel:v1', {
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
        const binaryEnvelope = createBinaryEnvelope({
            tunnelId: 'tun_binary',
            payload: new Uint8Array([1, 2, 3, 4]),
        });
        socket.trigger('peer:tunnel:v1', binaryEnvelope);

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', binaryEnvelope);
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({ payloadBase64: expect.any(String) }),
        }));

        socket.trigger('disconnect');
    });

    it('rejects binary_frame_v2 frames for tunnels that did not negotiate binary encoding', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_v1_only'));
        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_v1_only',
            payload: new Uint8Array([1]),
        }));

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_v1_only',
                reasonCode: 'encoding_unsupported',
            }),
        }));

        socket.trigger('disconnect');
    });

    it('rejects implicit V1 opens when V1 fallback is disabled', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2, 'json_base64_v1'],
            allowV1Fallback: false,
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_v1_implicit'));

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_v1_implicit',
                reasonCode: 'encoding_unsupported',
            }),
        }));
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({ kind: 'open' }),
        }));

        socket.trigger('disconnect');
    });

    it('enforces binary_frame_v2 raw payload caps before forwarding', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            maxRawPayloadBytes: 2,
        });

        const openEnvelope = createOpenEnvelope('tun_binary_cap');
        expect(openEnvelope.frame.kind).toBe('open');
        socket.trigger('peer:tunnel:v1', {
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
        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_binary_cap',
            payload: new Uint8Array([1, 2, 3]),
        }));

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_binary_cap',
                reasonCode: 'relay_cap_exceeded',
            }),
        }));

        socket.trigger('disconnect');
    });

    it('forwards multiple binary_frame_v2 substreams over one authorized relay tunnel', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            maxActiveTunnelsPerSocket: 1,
        });

        const openEnvelope = createOpenEnvelope('tun_mux');
        expect(openEnvelope.frame.kind).toBe('open');
        socket.trigger('peer:tunnel:v1', {
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
        const substreamA = createBinaryEnvelope({ tunnelId: 'tun_mux', kind: 'open', substreamId: 'sub_a' });
        const substreamB = createBinaryEnvelope({ tunnelId: 'tun_mux', kind: 'open', substreamId: 'sub_b' });
        socket.trigger('peer:tunnel:v1', substreamA);
        socket.trigger('peer:tunnel:v1', substreamB);

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', substreamA);
        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', substreamB);
        expect(socket.emit).not.toHaveBeenCalledWith('error', expect.objectContaining({
            error: expect.stringMatching(/active tunnel cap exceeded/i),
        }));

        socket.trigger('disconnect');
    });

    it('allows data-first substreams only for retained signed daemon Voice authority', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        const voiceTunnelId = 'typed_voice_relay';
        const voiceOpen = createOpenEnvelope(voiceTunnelId, 3000, {
            relayAuthorization: createRelayAuthorization(
                voiceTunnelId,
                { host: '127.0.0.1', port: 3000 },
                { flowKind: 'voice_media' },
            ),
        });
        socket.trigger('peer:tunnel:v1', {
            ...voiceOpen,
            frame: {
                ...voiceOpen.frame,
                open: {
                    ...voiceOpen.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        const voiceData = createBinaryEnvelope({
            tunnelId: voiceTunnelId,
            substreamId: 'daemon.voiceInference.stt.stream-1.1',
            payload: new Uint8Array([1, 2, 3, 4]),
        });
        socket.trigger('peer:tunnel:v1', voiceData);
        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', voiceData);

        const genericTunnelId = 'generic_data_first';
        const genericOpen = createOpenEnvelope(genericTunnelId);
        socket.trigger('peer:tunnel:v1', {
            ...genericOpen,
            frame: {
                ...genericOpen.frame,
                open: {
                    ...genericOpen.frame.open,
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                },
            },
        });
        const genericData = createBinaryEnvelope({
            tunnelId: genericTunnelId,
            substreamId: 'sub_data_first',
            payload: new Uint8Array([1]),
        });
        socket.trigger('peer:tunnel:v1', genericData);
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', genericData);
        expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({
            error: expect.stringMatching(/substream cap or lifecycle check failed/i),
        }));

        socket.trigger('disconnect');
    });

    it('keeps a binary_frame_v2 relay tunnel authorized after a substream close', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            maxActiveTunnelsPerSocket: 1,
        });

        const openEnvelope = createOpenEnvelope('tun_mux_close');
        expect(openEnvelope.frame.kind).toBe('open');
        socket.trigger('peer:tunnel:v1', {
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
        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_mux_close',
            kind: 'open',
            substreamId: 'sub_a',
        }));
        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_mux_close',
            kind: 'close',
            substreamId: 'sub_a',
            reasonCode: 'client_closed',
        }));
        const substreamB = createBinaryEnvelope({
            tunnelId: 'tun_mux_close',
            kind: 'open',
            substreamId: 'sub_b',
        });
        socket.trigger('peer:tunnel:v1', substreamB);

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', substreamB);
        expect(socket.emit).not.toHaveBeenCalledWith('error', expect.objectContaining({
            error: expect.stringMatching(/encoding is unsupported|frame arrived before an authorized open/i),
        }));

        socket.trigger('disconnect');
    });

    it('keeps binary_frame_v2 substreams active after a client-to-daemon half-close', async () => {
        const mod = await loadRegisterRelayModule();
        const userSocket = createSocket();
        const machineSocket = createSocket({ clientType: 'machine-scoped', machineId: 'machine_1' });
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', userSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            maxActiveTunnelsPerSocket: 1,
        });
        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', machineSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            maxActiveTunnelsPerSocket: 1,
        });

        const openEnvelope = createOpenEnvelope('tun_mux_half_close');
        expect(openEnvelope.frame.kind).toBe('open');
        userSocket.trigger('peer:tunnel:v1', {
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
        userSocket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_mux_half_close',
            kind: 'open',
            substreamId: 'sub_half',
        }));
        userSocket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_mux_half_close',
            kind: 'close',
            substreamId: 'sub_half',
            direction: 'client_to_daemon',
            halfClose: true,
            reasonCode: 'client_write_complete',
        }));
        const machineData = createBinaryEnvelope({
            tunnelId: 'tun_mux_half_close',
            sender: { kind: 'machine', machineId: 'machine_1' },
            recipient: { kind: 'user' },
            kind: 'data',
            substreamId: 'sub_half',
            direction: 'daemon_to_client',
            payload: new Uint8Array([1, 2, 3]),
        });
        machineSocket.trigger('peer:tunnel:v1', machineData);

        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', machineData);
        expect(userSocket.emit).not.toHaveBeenCalledWith('error', expect.objectContaining({
            error: expect.stringMatching(/substream cap or lifecycle check failed/i),
        }));
        expect(machineSocket.emit).not.toHaveBeenCalledWith('error', expect.objectContaining({
            error: expect.stringMatching(/substream cap or lifecycle check failed/i),
        }));

        userSocket.trigger('disconnect');
        machineSocket.trigger('disconnect');
    });

    it('enforces configured concurrent substream caps independently from active tunnel caps', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            maxActiveTunnelsPerSocket: 1,
            substreams: {
                maxConcurrentSubstreams: 1,
                maxTotalSubstreams: 4,
                maxBytesPerSubstream: 1024,
                maxAggregateBytes: 4096,
                maxSubstreamIdleMs: 30_000,
                maxSessionIdleMs: 60_000,
            },
        });

        const openEnvelope = createOpenEnvelope('tun_mux_cap');
        expect(openEnvelope.frame.kind).toBe('open');
        socket.trigger('peer:tunnel:v1', {
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
        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_mux_cap',
            kind: 'open',
            substreamId: 'sub_a',
        }));
        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_mux_cap',
            kind: 'open',
            substreamId: 'sub_b',
        }));

        expect(findBinaryAbortForSubstream(io, 'sub_b')).toBe(true);

        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_mux_cap',
            kind: 'close',
            substreamId: 'sub_a',
            reasonCode: 'client_closed',
        }));
        const retriedUnadmittedSubstream = createBinaryEnvelope({
            tunnelId: 'tun_mux_cap',
            kind: 'open',
            substreamId: 'sub_b',
        });
        socket.trigger('peer:tunnel:v1', retriedUnadmittedSubstream);
        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', retriedUnadmittedSubstream);

        socket.trigger('disconnect');
    });

    it('keeps a byte-capped binary substream terminal without closing its parent tunnel', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            substreams: {
                maxConcurrentSubstreams: 2,
                maxTotalSubstreams: 4,
                maxBytesPerSubstream: 2,
                maxAggregateBytes: 16,
                maxSubstreamIdleMs: 30_000,
                maxSessionIdleMs: 60_000,
            },
        });

        const openEnvelope = createOpenEnvelope('tun_mux_byte_cap');
        expect(openEnvelope.frame.kind).toBe('open');
        socket.trigger('peer:tunnel:v1', {
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
        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_mux_byte_cap',
            kind: 'open',
            substreamId: 'sub_capped',
        }));
        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_mux_byte_cap',
            substreamId: 'sub_capped',
            payload: new Uint8Array([1, 2, 3]),
        }));
        expect(findBinaryAbortForSubstream(io, 'sub_capped')).toBe(true);

        const resumedCappedSubstream = createBinaryEnvelope({
            tunnelId: 'tun_mux_byte_cap',
            substreamId: 'sub_capped',
            payload: new Uint8Array([4]),
        });
        socket.trigger('peer:tunnel:v1', resumedCappedSubstream);
        expect(io.roomEmit).not.toHaveBeenCalledWith('peer:tunnel:v1', resumedCappedSubstream);

        const healthySibling = createBinaryEnvelope({
            tunnelId: 'tun_mux_byte_cap',
            kind: 'open',
            substreamId: 'sub_healthy',
        });
        socket.trigger('peer:tunnel:v1', healthySibling);
        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', healthySibling);

        socket.trigger('disconnect');
    });

    it('enforces configured binary_frame_v2 substream session idle caps', async () => {
        vi.useFakeTimers();
        try {
            const mod = await loadRegisterRelayModule();
            const socket = createSocket();
            const io = createIo();
            expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

            vi.setSystemTime(0);
            mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
                io,
                serverRoutedEnabled: true,
                allowedPorts: [3000],
                relayAuthorizationTrustRoots,
                maxIdleMs: 1_000,
                substreams: {
                    maxConcurrentSubstreams: 4,
                    maxTotalSubstreams: 8,
                    maxBytesPerSubstream: 1024,
                    maxAggregateBytes: 4096,
                    maxSubstreamIdleMs: 1_000,
                    maxSessionIdleMs: 30,
                },
            });

            const openEnvelope = createOpenEnvelope('tun_mux_session_idle');
            expect(openEnvelope.frame.kind).toBe('open');
            socket.trigger('peer:tunnel:v1', {
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
            socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
                tunnelId: 'tun_mux_session_idle',
                kind: 'open',
                substreamId: 'sub_idle',
            }));

            vi.setSystemTime(31);
            socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
                tunnelId: 'tun_mux_session_idle',
                substreamId: 'sub_idle',
                payload: new Uint8Array([1]),
            }));

            expect(findBinaryAbortForSubstream(io, 'sub_idle')).toBe(true);

            socket.trigger('disconnect');
        } finally {
            vi.useRealTimers();
        }
    });

    it('enforces the configured relay duration cap', async () => {
        vi.useFakeTimers();
        try {
            const mod = await loadRegisterRelayModule();
            const socket = createSocket();
            const io = createIo();
            const emitted: unknown[] = [];
            expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

            vi.setSystemTime(0);
            mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
                io,
                serverRoutedEnabled: true,
                allowedPorts: [3000],
                relayAuthorizationTrustRoots,
                maxDurationMs: 100,
                observability: {
                    emit: (event) => emitted.push(event),
                },
            });

            socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_duration'));
            vi.setSystemTime(101);
            socket.trigger('peer:tunnel:v1', createDataEnvelope('tun_duration', 'x'));

            expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
                frame: expect.objectContaining({
                    kind: 'abort',
                    tunnelId: 'tun_duration',
                    reasonCode: 'relay_cap_exceeded',
                }),
            }));
            expect(emitted).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'flow.closed',
                    flow: expect.objectContaining({ flowId: 'tun_duration' }),
                    data: expect.objectContaining({
                        reasonCode: 'relay_cap_exceeded',
                        cleanupSettled: true,
                    }),
                }),
            ]));

            socket.trigger('peer:tunnel:v1', createDataEnvelope('tun_duration', 'after-duration'));
            expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
                frame: expect.objectContaining({
                    kind: 'abort',
                    tunnelId: 'tun_duration',
                    reasonCode: 'tunnel_not_open',
                }),
            }));

            socket.trigger('disconnect');
        } finally {
            vi.useRealTimers();
        }
    });

    it('enforces the configured relay idle cap', async () => {
        vi.useFakeTimers();
        try {
            const mod = await loadRegisterRelayModule();
            const socket = createSocket();
            const io = createIo();
            const emitted: unknown[] = [];
            expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

            vi.setSystemTime(0);
            mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
                io,
                serverRoutedEnabled: true,
                allowedPorts: [3000],
                relayAuthorizationTrustRoots,
                maxIdleMs: 30,
                maxDurationMs: 30,
                observability: {
                    emit: (event) => emitted.push(event),
                },
            });

            socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_idle'));
            vi.setSystemTime(31);
            socket.trigger('peer:tunnel:v1', createDataEnvelope('tun_idle', 'x'));

            expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
                frame: expect.objectContaining({
                    kind: 'abort',
                    tunnelId: 'tun_idle',
                    reasonCode: 'relay_cap_exceeded',
                }),
            }));
            expect(emitted).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'flow.closed',
                    flow: expect.objectContaining({ flowId: 'tun_idle' }),
                    data: expect.objectContaining({
                        reasonCode: 'relay_cap_exceeded',
                        cleanupSettled: true,
                    }),
                }),
            ]));

            socket.trigger('peer:tunnel:v1', createDataEnvelope('tun_idle', 'after-idle'));
            expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
                frame: expect.objectContaining({
                    kind: 'abort',
                    tunnelId: 'tun_idle',
                    reasonCode: 'tunnel_not_open',
                }),
            }));

            socket.trigger('disconnect');
        } finally {
            vi.useRealTimers();
        }
    });

    it('expires idle relay tunnels without waiting for another frame to clean up state', async () => {
        vi.useFakeTimers();
        try {
            const mod = await loadRegisterRelayModule();
            const socket = createSocket();
            const io = createIo();
            const emitted: unknown[] = [];
            expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

            vi.setSystemTime(0);
            mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
                io,
                serverRoutedEnabled: true,
                allowedPorts: [3000],
                relayAuthorizationTrustRoots,
                maxIdleMs: 30,
                observability: {
                    emit: (event) => emitted.push(event),
                },
            });

            socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_idle_timer'));
            await vi.advanceTimersByTimeAsync(31);
            socket.trigger('peer:tunnel:v1', createDataEnvelope('tun_idle_timer', 'x'));

            expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
                frame: expect.objectContaining({
                    kind: 'abort',
                    tunnelId: 'tun_idle_timer',
                    reasonCode: 'relay_cap_exceeded',
                }),
            }));
            expect(emitted).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'flow.closed',
                    flow: expect.objectContaining({ flowId: 'tun_idle_timer' }),
                    data: expect.objectContaining({
                        carrierEncoding: 'json_base64_v1',
                        signedFlowKind: 'tcp_tunnel',
                        cleanupSettled: true,
                        reasonCode: 'relay_cap_exceeded',
                    }),
                }),
            ]));
            expect(emitted.filter((event) => (event as { kind?: unknown }).kind === 'flow.closed')).toHaveLength(1);
            expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
                frame: expect.objectContaining({
                    kind: 'abort',
                    tunnelId: 'tun_idle_timer',
                    reasonCode: 'tunnel_not_open',
                }),
            }));

            socket.trigger('disconnect');
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles the authoritative local user once when the cluster adapter is unavailable at idle expiry', async () => {
        vi.useFakeTimers();
        try {
            const mod = await loadRegisterRelayModule();
            expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');
            if (!mod?.registerPeerTcpTunnelRelaySocketHandler) return;

            const socket = createSocket();
            const io = createIo();
            const isolatedReplica = createIsolatedReplicaCoordinator();
            mod.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
                io,
                serverRoutedEnabled: true,
                allowedPorts: [3000],
                relayAuthorizationTrustRoots,
                maxIdleMs: 30,
                coordinator: isolatedReplica.coordinator,
            });

            socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_cluster_partition_idle'));
            await vi.advanceTimersByTimeAsync(0);
            io.roomEmit.mockClear();
            io.localRoomEmit.mockClear();

            await vi.advanceTimersByTimeAsync(31);

            expect(io.localRoomEmit.mock.calls.filter(([, payload]) =>
                (payload as { frame?: { tunnelId?: unknown; reasonCode?: unknown } }).frame?.tunnelId
                    === 'tun_cluster_partition_idle'
                && (payload as { frame?: { reasonCode?: unknown } }).frame?.reasonCode
                    === 'relay_cap_exceeded',
            )).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('emits socket-loss closure only after disconnect cleanup removes relay state', async () => {
        const mod = await loadRegisterRelayModule();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelaySocketHandler) return;

        const socket = createSocket();
        const io = createIo();
        const emitted: unknown[] = [];
        let checkedPostCloseState = false;
        mod.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            observability: {
                emit: (event) => {
                    emitted.push(event);
                    if (event.kind === 'flow.closed' && !checkedPostCloseState) {
                        checkedPostCloseState = true;
                        socket.trigger('peer:tunnel:v1', createDataEnvelope('tun_disconnect_receipt', 'after-disconnect'));
                    }
                },
            },
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_disconnect_receipt'));
        socket.trigger('disconnect');
        socket.trigger('disconnect');

        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'flow.closed',
                flow: expect.objectContaining({ flowId: 'tun_disconnect_receipt' }),
                data: expect.objectContaining({
                    carrierEncoding: 'json_base64_v1',
                    signedFlowKind: 'tcp_tunnel',
                    cleanupSettled: true,
                    reasonCode: 'relay_socket_disconnected',
                }),
            }),
        ]));
        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_disconnect_receipt',
                reasonCode: 'tunnel_not_open',
            }),
        }));
        expect(io.roomEmit.mock.calls.filter(([, payload]) =>
            (payload as { frame?: { reasonCode?: unknown } }).frame?.reasonCode
                === 'relay_socket_disconnected',
        )).toEqual([[
            'peer:tunnel:v1',
            expect.objectContaining({
                sender: { kind: 'user', socketId: 'socket_1' },
                recipient: { kind: 'machine', machineId: 'machine_1' },
                frame: expect.objectContaining({
                    kind: 'abort',
                    tunnelId: 'tun_disconnect_receipt',
                    reasonCode: 'relay_socket_disconnected',
                }),
            }),
        ]]);
    });

    it('settles an open relay when its sole machine recipient disconnects before sending a frame', async () => {
        const mod = await loadRegisterRelayModule();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelaySocketHandler) return;

        const userSocket = createSocket();
        const machineSocket = createSocket({
            id: 'socket_machine_recipient',
            clientType: 'machine-scoped',
            machineId: 'machine_1',
        });
        const io = createIo();
        mod.registerPeerTcpTunnelRelaySocketHandler('user_1', userSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });
        mod.registerPeerTcpTunnelRelaySocketHandler('user_1', machineSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
        });

        try {
            userSocket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_recipient_disconnect_before_reply'));
            io.roomEmit.mockClear();

            machineSocket.trigger('disconnect');
            const socketLossAbortCount = io.roomEmit.mock.calls.filter(([, payload]) =>
                (payload as { frame?: { tunnelId?: unknown; reasonCode?: unknown } }).frame?.tunnelId
                    === 'tun_recipient_disconnect_before_reply'
                && (payload as { frame?: { reasonCode?: unknown } }).frame?.reasonCode
                    === 'relay_socket_disconnected',
            ).length;

            io.roomEmit.mockClear();
            userSocket.trigger(
                'peer:tunnel:v1',
                createDataEnvelope('tun_recipient_disconnect_before_reply', 'after-machine-disconnect'),
            );
            const tunnelNotOpenRejected = io.roomEmit.mock.calls.some(([, payload]) =>
                (payload as { frame?: { tunnelId?: unknown; reasonCode?: unknown } }).frame?.tunnelId
                    === 'tun_recipient_disconnect_before_reply'
                && (payload as { frame?: { reasonCode?: unknown } }).frame?.reasonCode
                    === 'tunnel_not_open',
            );

            expect({ socketLossAbortCount, tunnelNotOpenRejected }).toEqual({
                socketLossAbortCount: 1,
                tunnelNotOpenRejected: true,
            });
        } finally {
            userSocket.trigger('disconnect');
            machineSocket.trigger('disconnect');
        }
    });

    it('settles an open relay when its sole machine recipient disconnects on another server replica', async () => {
        vi.resetModules();
        const userReplica = await loadRegisterRelayModule();
        vi.resetModules();
        const machineReplica = await loadRegisterRelayModule();
        expect(userReplica?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');
        expect(machineReplica?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');
        if (
            !userReplica?.registerPeerTcpTunnelRelaySocketHandler
            || !machineReplica?.registerPeerTcpTunnelRelaySocketHandler
        ) return;

        const userSocket = createSocket();
        const machineSocket = createSocket({
            id: 'socket_machine_remote_replica',
            clientType: 'machine-scoped',
            machineId: 'machine_1',
        });
        // Model adapter-wide delivery without exposing the remote replica's socket as a
        // local socket object. The opening replica owns relay state; the machine replica
        // owns the disconnect callback.
        const userReplicaIo = createIo();
        const machineReplicaIo = createIo();
        const isolatedReplica = createIsolatedReplicaCoordinator((envelope) => {
            machineReplicaIo.to(machineSocket.id).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);
        });
        userReplica.registerPeerTcpTunnelRelaySocketHandler('user_1', userSocket, {
            io: userReplicaIo,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            coordinator: isolatedReplica.coordinator,
        });
        machineReplica.registerPeerTcpTunnelRelaySocketHandler('user_1', machineSocket, {
            io: machineReplicaIo,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            coordinator: isolatedReplica.coordinator,
        });

        try {
            userSocket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_remote_recipient_disconnect'));
            await vi.waitFor(() => {
                expect(machineReplicaIo.roomEmit.mock.calls.some(([, payload]) =>
                    (payload as { frame?: { open?: { tunnelId?: unknown } } }).frame?.open?.tunnelId
                        === 'tun_remote_recipient_disconnect',
                )).toBe(true);
            });
            userReplicaIo.roomEmit.mockClear();
            machineReplicaIo.roomEmit.mockClear();

            machineSocket.trigger(
                'peer:tunnel:v1',
                createMachineDataEnvelope(
                    'tun_remote_recipient_disconnect',
                    'remote-machine-response',
                    0,
                    { recipient: { kind: 'user', socketId: userSocket.id } },
                ),
            );
            await vi.waitFor(() => {
                expect(userReplicaIo.localRoomEmit).toHaveBeenCalledWith(
                    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
                    expect.objectContaining({
                        frame: expect.objectContaining({
                            kind: 'data',
                            tunnelId: 'tun_remote_recipient_disconnect',
                        }),
                    }),
                );
            });
            userReplicaIo.roomEmit.mockClear();
            userReplicaIo.localRoomEmit.mockClear();

            isolatedReplica.disconnectMachine();
            machineSocket.trigger('disconnect');
            const socketLossAbortCount = [
                ...userReplicaIo.roomEmit.mock.calls,
                ...machineReplicaIo.roomEmit.mock.calls,
            ].filter(([, payload]) =>
                (payload as { frame?: { tunnelId?: unknown; reasonCode?: unknown } }).frame?.tunnelId
                    === 'tun_remote_recipient_disconnect'
                && (payload as { frame?: { reasonCode?: unknown } }).frame?.reasonCode
                    === 'relay_socket_disconnected',
            ).length;
            expect(userReplicaIo.localRoomEmit).toHaveBeenCalledWith(
                PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
                expect.objectContaining({
                    frame: expect.objectContaining({
                        kind: 'abort',
                        tunnelId: 'tun_remote_recipient_disconnect',
                        reasonCode: 'relay_socket_disconnected',
                    }),
                }),
            );

            userReplicaIo.roomEmit.mockClear();
            userSocket.trigger(
                'peer:tunnel:v1',
                createDataEnvelope('tun_remote_recipient_disconnect', 'after-remote-machine-disconnect'),
            );
            const tunnelNotOpenRejected = userReplicaIo.roomEmit.mock.calls.some(([, payload]) =>
                (payload as { frame?: { tunnelId?: unknown; reasonCode?: unknown } }).frame?.tunnelId
                    === 'tun_remote_recipient_disconnect'
                && (payload as { frame?: { reasonCode?: unknown } }).frame?.reasonCode
                    === 'tunnel_not_open',
            );

            expect({ socketLossAbortCount, tunnelNotOpenRejected }).toEqual({
                socketLossAbortCount: 1,
                tunnelNotOpenRejected: true,
            });
        } finally {
            userSocket.trigger('disconnect');
            machineSocket.trigger('disconnect');
        }
    });

    it('emits bounded observability lifecycle events for accepted and closed relay tunnels', async () => {
        const mod = await loadRegisterRelayModule();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelaySocketHandler) return;

        const socket = createSocket();
        const machineSocket = createSocket({
            id: 'socket_machine_observable',
            clientType: 'machine-scoped',
            machineId: 'machine_1',
        });
        const io = createIo();
        const emitted: unknown[] = [];
        mod.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            observability: {
                emit: (event) => emitted.push(event),
            },
        });
        mod.registerPeerTcpTunnelRelaySocketHandler('user_1', machineSocket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            observability: {
                emit: (event) => emitted.push(event),
            },
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_observable'));
        socket.trigger('peer:tunnel:v1', createDataEnvelope('tun_observable', 'secret-payload'));
        machineSocket.trigger('peer:tunnel:v1', createMachineDataEnvelope('tun_observable', 'daemon-reply'));
        socket.trigger('peer:tunnel:v1', createCloseEnvelope('tun_observable'));

        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'flow.ready', flow: expect.objectContaining({ flowId: 'tun_observable' }) }),
            expect.objectContaining({ kind: 'flow.closed', flow: expect.objectContaining({ flowId: 'tun_observable' }) }),
        ]));
        const serialized = JSON.stringify(emitted);
        expect(serialized).not.toContain('secret-payload');
        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'flow.closed',
                flow: expect.objectContaining({ flowId: 'tun_observable' }),
                data: expect.objectContaining({
                    bytesIn: Buffer.byteLength('secret-payload'),
                    bytesOut: Buffer.byteLength('daemon-reply'),
                }),
            }),
        ]));
    });

    it('emits only bounded Voice encryption classification after relay state cleanup', async () => {
        const mod = await loadRegisterRelayModule();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelaySocketHandler) return;

        const socket = createSocket();
        const io = createIo();
        const emitted: unknown[] = [];
        let checkedPostCloseState = false;
        mod.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            observability: {
                emit: (event) => {
                    emitted.push(event);
                    if (event.kind === 'flow.closed' && !checkedPostCloseState) {
                        checkedPostCloseState = true;
                        socket.trigger('peer:tunnel:v1', createDataEnvelope('tun_voice_encrypted', 'after-close'));
                    }
                },
            },
        });

        const openVoiceTunnel = (tunnelId: string) => {
            const open = createOpenEnvelope(tunnelId, 3000, {
                relayAuthorization: createRelayAuthorization(
                    tunnelId,
                    { host: '127.0.0.1', port: 3000 },
                    { flowKind: 'voice_media' },
                ),
            });
            socket.trigger('peer:tunnel:v1', {
                ...open,
                frame: {
                    ...open.frame,
                    open: {
                        ...open.frame.open,
                        selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                    },
                },
            });
        };

        openVoiceTunnel('tun_voice_encrypted');
        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_voice_encrypted',
            substreamId: 'voice-substream',
            payload: encodePeerApplicationEncryptedFrameV1({
                v: 1,
                kind: 'data',
                nonceBase64Url: 'AAAAAAAAAAAAAAAA',
                ciphertextBase64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
            }),
        }));
        socket.trigger('peer:tunnel:v1', createCloseEnvelope('tun_voice_encrypted'));

        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'flow.ready',
                flow: expect.objectContaining({ flowKind: 'voice_media' }),
                data: expect.objectContaining({
                    carrierEncoding: 'binary_frame_v2',
                    signedFlowKind: 'voice_media',
                }),
            }),
            expect.objectContaining({
                kind: 'flow.closed',
                flow: expect.objectContaining({ flowKind: 'voice_media' }),
                data: expect.objectContaining({
                    encryptedApplicationFrames: 1,
                    unprotectedApplicationFrames: 0,
                    allApplicationFramesEncrypted: true,
                    cleanupSettled: true,
                }),
            }),
        ]));
        expect(io.roomEmit).toHaveBeenCalledWith('peer:tunnel:v1', expect.objectContaining({
            frame: expect.objectContaining({
                kind: 'abort',
                tunnelId: 'tun_voice_encrypted',
                reasonCode: 'tunnel_not_open',
            }),
        }));

        openVoiceTunnel('tun_voice_unprotected');
        socket.trigger('peer:tunnel:v1', createBinaryEnvelope({
            tunnelId: 'tun_voice_unprotected',
            substreamId: 'voice-substream',
            payload: new Uint8Array([1, 2, 3, 4]),
        }));
        socket.trigger('peer:tunnel:v1', createCloseEnvelope('tun_voice_unprotected'));

        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'flow.closed',
                flow: expect.objectContaining({ flowId: 'tun_voice_unprotected' }),
                data: expect.objectContaining({
                    encryptedApplicationFrames: 0,
                    unprotectedApplicationFrames: 1,
                    allApplicationFramesEncrypted: false,
                    cleanupSettled: true,
                }),
            }),
        ]));
        expect(JSON.stringify(emitted)).not.toContain('AAAAAAAAAAAAAAAAAAAAAA');
    });

    it('emits redacted policy denial events without exposing relay grants', async () => {
        const mod = await loadRegisterRelayModule();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');
        if (!mod?.registerPeerTcpTunnelRelaySocketHandler) return;

        const socket = createSocket();
        const io = createIo();
        const emitted: unknown[] = [];
        mod.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: false,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            observability: {
                emit: (event) => emitted.push(event),
            },
        });

        socket.trigger('peer:tunnel:v1', createOpenEnvelope('tun_denied'));

        expect(emitted).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'flow.denied',
                flow: expect.objectContaining({ flowId: 'tun_denied' }),
                data: expect.objectContaining({ reasonCode: 'relay_disabled_by_server_policy' }),
            }),
        ]));
        expect(JSON.stringify(emitted)).not.toContain('relay_grant_tun_denied');
    });
});
