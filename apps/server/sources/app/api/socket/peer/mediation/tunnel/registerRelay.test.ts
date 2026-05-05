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

function createOpenEnvelope(tunnelId: string, port = 3000) {
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
                destination: { host: '127.0.0.1', port },
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

    it('rejects tunnel opens when the declared sender is not bound to the authenticated socket', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket({ clientType: 'user-scoped' });
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
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

    it('rejects duplicate active open frames for the same authorized tunnel key', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
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

    it('enforces the configured max active relay tunnel cap', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000, 3001],
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

    it('enforces the configured relay byte cap', async () => {
        const mod = await loadRegisterRelayModule();
        const socket = createSocket();
        const io = createIo();
        expect(mod?.registerPeerTcpTunnelRelaySocketHandler).toBeTypeOf('function');

        mod?.registerPeerTcpTunnelRelaySocketHandler('user_1', socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
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
});
