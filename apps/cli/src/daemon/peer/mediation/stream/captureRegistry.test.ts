import { describe, expect, it } from 'vitest';

import { unavailableMachineLiveStreamCaptureAdapter } from './captureAdapter';

describe('createMachineLiveStreamCaptureRegistry', () => {
    it('resolves a registered source by id and exposes typed unavailable diagnostics for missing sources', async () => {
        const mod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        if (!('createMachineLiveStreamCaptureRegistry' in mod)) return;

        const registry = mod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter: unavailableMachineLiveStreamCaptureAdapter,
            capabilities: {
                v: 1,
                sourceId: 'source_1',
                sourceKind: 'screen',
                supportedCodecs: ['image.mjpeg'],
                maxFramesPerSecond: 12,
                inputMode: 'exclusive',
                sidebands: ['capture_health'],
                health: { status: 'available' },
            },
        });

        expect(registry.resolve({ sourceId: 'source_1' })).toMatchObject({
            ok: true,
            source: { sourceId: 'source_1' },
        });
        expect(registry.resolve({ sourceId: 'missing' })).toEqual({
            ok: false,
            diagnostic: {
                v: 1,
                sourceId: 'missing',
                reasonCode: 'capture_source_unavailable',
            },
        });
    });
});
