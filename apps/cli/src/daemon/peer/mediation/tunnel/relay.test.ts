import {
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    createPeerTcpTunnelRelayAuthorizationSigningInputV1,
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    type PeerTcpTunnelRelayEnvelopeV1,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

type RelayModule = typeof import('./relay');

async function loadRelayModule(): Promise<RelayModule | null> {
    const modulePath = './relay.js';
    return import(modulePath).catch(() => null) as Promise<RelayModule | null>;
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
    overrides?: Readonly<{ signatureBase64Url?: string }>,
) {
    const payload = {
        v: 1,
        grantId: `relay_grant_${tunnelId}`,
        accountId: 'user_1',
        targetMachineId: 'machine_1',
        flowKind: 'tcp_tunnel',
        routeKind: 'server_relay',
        tunnelId,
        destination: { host: '127.0.0.1', port: 3000 },
        capProfileId: 'interactive',
        maxFrameBytes: 64 * 1024,
        maxIdleMs: 30_000,
        maxDurationMs: 300_000,
        maxTotalBytes: 64 * 1024 * 1024,
        iat: 1_000,
        exp: 301_000,
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

function createOpenEnvelope(tunnelId: string): PeerTcpTunnelRelayEnvelopeV1 {
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
                destination: { host: '127.0.0.1', port: 3000 },
                relayAuthorization: createRelayAuthorization(tunnelId),
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
    payload?: string;
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
});
