import { describe, expect, it, vi } from 'vitest';

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

describe('registerPeerTcpTunnelLoopbackRoutes', () => {
    it('fails duplicate tunnel route registration on one loopback Fastify app', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);

        expect(mod?.registerPeerTcpTunnelLoopbackRoutes).toBeTypeOf('function');
        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs(),
            expected: {
                accountId: 'account_1',
                machineId: 'machine_1',
                endpointFingerprint: 'endpoint_1',
            },
            trustRoots: [],
            connectTcp: async () => ({ close: async () => undefined }),
        });

        expect(() => mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs(),
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
            nowMs: loopbackOptions.nowMs(),
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

    it('uses Fastify-owned websocket routing instead of attaching a raw upgrade listener', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const listenerCountBefore = app.server.listenerCount('upgrade');

        mod?.registerPeerTcpTunnelLoopbackRoutes(app, {
            nowMs: loopbackOptions.nowMs(),
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

    it('rejects duplicate active tunnel ids before opening another TCP connection', async () => {
        const mod = await loadRegisterRoutesModule();
        const app = createPeerMediationLoopbackApp(loopbackOptions);
        const openTunnel = vi.fn(async () => ({
            ok: true as const,
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
            nowMs: loopbackOptions.nowMs(),
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
            nowMs: loopbackOptions.nowMs(),
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
                nowMs: loopbackOptions.nowMs(),
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
