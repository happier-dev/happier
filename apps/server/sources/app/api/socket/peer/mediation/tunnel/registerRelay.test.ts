import {
    createPeerTcpTunnelRelayAuthorizationSigningInputV1,
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

type RegisterRelayModule = typeof import('./registerRelay');

async function loadRegisterRelayModule(): Promise<RegisterRelayModule | null> {
    const modulePath = './registerRelay.js';
    return import(modulePath).catch(() => null) as Promise<RegisterRelayModule | null>;
}

function createSocket(overrides?: Readonly<{ clientType?: string; machineId?: string }>) {
    const handlers = new Map<string, (payload?: unknown) => void>();
    return {
        id: 'socket_1',
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
    return {
        roomEmit,
        to: vi.fn(() => ({ emit: roomEmit })),
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
        signatureBase64Url?: string;
    }>,
) {
    const issuedAt = Date.now();
    const payload = {
        v: 1,
        grantId: `relay_grant_${tunnelId}`,
        accountId: overrides?.accountId ?? 'user_1',
        targetMachineId: overrides?.targetMachineId ?? 'machine_1',
        flowKind: 'tcp_tunnel',
        routeKind: 'server_relay',
        tunnelId,
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
                    new TextEncoder().encode(createPeerTcpTunnelRelayAuthorizationSigningInputV1(payload)),
                    relayKeyPair.secretKey,
                )).toString('base64url'),
        },
    } as const;
}

function createOpenEnvelope(tunnelId: string, port = 3000) {
    const destination = { host: '127.0.0.1', port } as const;
    return {
        v: 1,
        scopeUserId: 'user_1',
        sender: { kind: 'user' },
        recipient: { kind: 'machine', machineId: 'machine_1' },
        frame: {
            v: 1,
            kind: 'open',
            open: {
                v: 1,
                kind: 'open',
                tunnelId,
                targetMachineId: 'machine_1',
                routeKind: 'server_relay',
                destination,
                relayAuthorization: createRelayAuthorization(tunnelId, destination),
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

function createMachineDataEnvelope(tunnelId: string, payload: string, sequence = 0) {
    return {
        v: 1,
        scopeUserId: 'user_1',
        sender: { kind: 'machine', machineId: 'machine_1' },
        recipient: { kind: 'user' },
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
            sender: { kind: 'user' },
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
            sender: { kind: 'user' },
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
            sender: { kind: 'user' },
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
        expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
    });

    it('rejects server relay opens with invalid relay authorization signatures before relaying', async () => {
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

    it('enforces the configured relay byte cap', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            maxBytes: 4,
            maxFrameBytes: 64,
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
            expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

            vi.setSystemTime(0);
            mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
                io,
                serverRoutedEnabled: true,
                allowedPorts: [3000],
                relayAuthorizationTrustRoots,
                maxDurationMs: 100,
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
            expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

            vi.setSystemTime(0);
            mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
                io,
                serverRoutedEnabled: true,
                allowedPorts: [3000],
                relayAuthorizationTrustRoots,
                maxIdleMs: 30,
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
            expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

            vi.setSystemTime(0);
            mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
                io,
                serverRoutedEnabled: true,
                allowedPorts: [3000],
                relayAuthorizationTrustRoots,
                maxIdleMs: 30,
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
});
