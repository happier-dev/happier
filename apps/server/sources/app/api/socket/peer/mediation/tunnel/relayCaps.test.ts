import { describe, expect, it } from 'vitest';
import * as relayCapsModule from './relayCaps.js';

type RelayCapsModule = typeof import('./relayCaps');

async function loadRelayCapsModule(): Promise<RelayCapsModule | null> {
    return relayCapsModule;
}

describe('resolvePeerTcpTunnelRelayCaps', () => {
    it('defaults relay disabled without invented count caps while retaining frame and message bounds', async () => {
        const mod = await loadRelayCapsModule();

        expect(mod?.resolvePeerTcpTunnelRelayCaps({})).toEqual(expect.objectContaining({
            serverRoutedEnabled: false,
            maxFrameBytes: 64 * 1024,
            supportedEncodings: ['binary_frame_v2'],
            preferredEncoding: 'binary_frame_v2',
            maxBinaryHeaderBytes: 16 * 1024,
            maxRawPayloadBytes: 256 * 1024,
            maxFramedMessageBytes: 512 * 1024,
            substreams: {},
        }));
        expect(mod?.resolvePeerTcpTunnelRelayCaps({}).maxActiveTunnelsPerSocket).toBeUndefined();

        expect(mod?.resolvePeerTcpTunnelRelayCaps({
            serverRoutedEnabled: true,
            maxActiveTunnelsPerSocket: 999,
            maxFrameBytes: 99 * 1024 * 1024,
            maxBinaryHeaderBytes: 99 * 1024 * 1024,
            maxRawPayloadBytes: 99 * 1024 * 1024,
            maxFramedMessageBytes: 99 * 1024 * 1024,
            substreams: {
                maxConcurrentSubstreams: 999,
            },
        })).toEqual(expect.objectContaining({
            serverRoutedEnabled: true,
            maxActiveTunnelsPerSocket: 999,
            maxFrameBytes: 8 * 1024 * 1024,
            maxBinaryHeaderBytes: 8 * 1024 * 1024,
            maxRawPayloadBytes: 8 * 1024 * 1024,
            maxFramedMessageBytes: 8 * 1024 * 1024,
            substreams: expect.objectContaining({
                maxConcurrentSubstreams: 999,
            }),
        }));
    });
});
