import { describe, expect, it } from 'vitest';

type RelayCapsModule = typeof import('./relayCaps');

async function loadRelayCapsModule(): Promise<RelayCapsModule | null> {
    const modulePath = './relayCaps.js';
    return import(modulePath).catch(() => null) as Promise<RelayCapsModule | null>;
}

describe('resolvePeerTcpTunnelRelayCaps', () => {
    it('defaults server-routed relay disabled and clamps caps to bounded values', async () => {
        const mod = await loadRelayCapsModule();

        expect(mod?.resolvePeerTcpTunnelRelayCaps({})).toEqual(expect.objectContaining({
            serverRoutedEnabled: false,
            maxActiveTunnelsPerSocket: 8,
            maxFrameBytes: 64 * 1024,
            maxBytes: 64 * 1024 * 1024,
            maxIdleMs: 30_000,
            maxDurationMs: 300_000,
        }));

        expect(mod?.resolvePeerTcpTunnelRelayCaps({
            serverRoutedEnabled: true,
            maxActiveTunnelsPerSocket: 999,
            maxFrameBytes: 99 * 1024 * 1024,
        })).toEqual(expect.objectContaining({
            serverRoutedEnabled: true,
            maxActiveTunnelsPerSocket: 128,
            maxFrameBytes: 8 * 1024 * 1024,
        }));
    });
});
