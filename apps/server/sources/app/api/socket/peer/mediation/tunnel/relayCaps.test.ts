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
            supportedEncodings: ['json_base64_v1', 'binary_frame_v2'],
            preferredEncoding: 'binary_frame_v2',
            allowV1Fallback: true,
            maxBinaryHeaderBytes: 16 * 1024,
            maxRawPayloadBytes: 256 * 1024,
            maxFramedMessageBytes: 512 * 1024,
            substreams: expect.objectContaining({
                maxConcurrentSubstreams: 32,
                maxTotalSubstreams: 1024,
            }),
            maxIdleMs: 30_000,
            maxDurationMs: 300_000,
        }));

        expect(mod?.resolvePeerTcpTunnelRelayCaps({
            serverRoutedEnabled: true,
            maxActiveTunnelsPerSocket: 999,
            maxFrameBytes: 99 * 1024 * 1024,
            maxBinaryHeaderBytes: 99 * 1024 * 1024,
            maxRawPayloadBytes: 99 * 1024 * 1024,
            maxFramedMessageBytes: 99 * 1024 * 1024,
            substreams: {
                maxConcurrentSubstreams: 999,
                maxTotalSubstreams: 9999,
                maxBytesPerSubstream: 99 * 1024 * 1024,
                maxAggregateBytes: 99 * 1024 * 1024,
                maxSubstreamIdleMs: 1000,
                maxSessionIdleMs: 2000,
            },
        })).toEqual(expect.objectContaining({
            serverRoutedEnabled: true,
            maxActiveTunnelsPerSocket: 128,
            maxFrameBytes: 8 * 1024 * 1024,
            maxBinaryHeaderBytes: 8 * 1024 * 1024,
            maxRawPayloadBytes: 8 * 1024 * 1024,
            maxFramedMessageBytes: 8 * 1024 * 1024,
            substreams: expect.objectContaining({
                maxConcurrentSubstreams: 128,
                maxTotalSubstreams: 4096,
            }),
        }));
    });
});
