import { describe, expect, it, vi } from 'vitest';

import type {
    LoopbackTunnelAdapter,
    LoopbackTunnelLease,
    LoopbackTunnelProbe,
    LoopbackTunnelRequest,
} from './types';

type Request = LoopbackTunnelRequest & Readonly<{ purpose: 'home' }>;

function createRequest(): Request {
    return {
        remoteHostId: 'home-a',
        destinationHost: '127.0.0.1',
        destinationPort: 3005,
        purpose: 'home',
    };
}

describe('provider-neutral loopback tunnel supervisor', () => {
    it('coalesces starts and releases the native tunnel after the final lease', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: LoopbackTunnelAdapter<Request> = {
            startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const probe: LoopbackTunnelProbe = vi.fn(async () => ({ ok: true as const }));
        const supervisor = loaded!.createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter,
            probe,
            buildKey: () => 'home-key',
            createLease: ({ key, request, localPort }) => ({
                leaseId: `loopback:${key}`,
                key,
                remoteHostId: request.remoteHostId,
                localUrl: `http://127.0.0.1:${localPort}`,
                channelMode: 'loopback-port',
                purpose: request.purpose,
                status: 'ready',
                startedAt: '2026-08-30T00:00:00.000Z',
            }),
        });

        const first = supervisor.ensureTunnel(createRequest());
        const second = supervisor.ensureTunnel(createRequest());
        const [firstLease, secondLease] = await Promise.all([first, second]);

        expect(firstLease).toEqual(secondLease);
        expect(adapter.startLoopbackTunnel).toHaveBeenCalledTimes(1);

        await supervisor.releaseTunnel(firstLease.leaseId);
        expect(adapter.stopLoopbackTunnel).not.toHaveBeenCalled();
        await supervisor.releaseTunnel(secondLease.leaseId);
        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
        expect(supervisor.listTunnels().leases).toEqual([]);
    });

    it('discards a tunnel that finishes after the active server generation changes', async () => {
        const { createLoopbackTunnelSupervisor } = await import('./supervisor');
        let generation = 1;
        let resolveStart: ((value: { nativeTunnelId: string; localPort: number }) => void) | undefined;
        const adapter: LoopbackTunnelAdapter<Request> = {
            startLoopbackTunnel: vi.fn(() => new Promise((resolve) => { resolveStart = resolve; })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter,
            probe: vi.fn(async () => ({ ok: true as const })),
            buildKey: () => 'home-key',
            getGeneration: () => generation,
            createLease: ({ key, request, localPort, generation: leaseGeneration }) => ({
                leaseId: `loopback:${key}`,
                key,
                remoteHostId: request.remoteHostId,
                localUrl: `http://127.0.0.1:${localPort}`,
                channelMode: 'loopback-port',
                purpose: request.purpose,
                status: 'ready',
                startedAt: '2026-08-30T00:00:00.000Z',
                ...(leaseGeneration === undefined ? {} : { generation: leaseGeneration }),
            } as LoopbackTunnelLease),
        });
        const pending = supervisor.ensureTunnel(createRequest());
        generation = 2;
        resolveStart?.({ nativeTunnelId: 'native-stale', localPort: 49153 });
        await expect(pending).rejects.toThrow('loopback_tunnel_stale_generation');
        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-stale');
        expect(supervisor.listTunnels().leases).toEqual([]);
    });

    it('does not expose undefined platform limitations', async () => {
        const { createLoopbackTunnelSupervisor } = await import('./supervisor');
        const supervisor = createLoopbackTunnelSupervisor<Request, LoopbackTunnelLease>({
            adapter: { startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'n', localPort: 1 })), stopLoopbackTunnel: vi.fn(async () => undefined) },
            probe: vi.fn(async () => ({ ok: true as const })),
            buildKey: () => 'k',
            createLease: ({ key, request, localPort }) => ({ leaseId: key, key, remoteHostId: request.remoteHostId, localUrl: `http://127.0.0.1:${localPort}`, channelMode: 'loopback-port', purpose: request.purpose, status: 'ready', startedAt: 'now' }),
        });
        await supervisor.ensureTunnel(createRequest());
        expect(supervisor.listTunnels().platformLimitations).toEqual([]);
    });
});
