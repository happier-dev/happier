import { describe, expect, it } from 'vitest';

import { unavailableMachineLiveStreamCaptureAdapter } from './captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from './captureRegistry';

describe('createMachineLiveStreamCaptureRegistry', () => {
    it('retires the exact source occurrence when the same source id is replaced', () => {
        const registry = createMachineLiveStreamCaptureRegistry();
        const register = () => registry.register({ sourceId: 'screen', streamFamily: 'screen', adapter: unavailableMachineLiveStreamCaptureAdapter,
            capabilities: { v: 1, sourceId: 'screen', sourceKind: 'screen', supportedCodecs: ['image.mjpeg'],
                inputMode: 'none', sidebands: [], health: { status: 'available' } } });
        register();
        const admitted = registry.describeViewing({ pluginId: 'acme.viewer', reference: { kind: 'host', sourceId: 'screen' } });
        expect(admitted.ok).toBe(true);
        if (!admitted.ok) throw new Error('expected admitted viewing');
        const oldOccurrence = admitted.source.sourceOccurrenceId;
        register();
        expect(admitted.source.retirementSignal?.aborted).toBe(true);
        const replaced = registry.resolve({ sourceId: 'screen' });
        expect(replaced.ok && replaced.source.sourceOccurrenceId).not.toBe(oldOccurrence);
    });
    it('resolves the explicitly named plugin producer and rejects a host alias', () => {
        const registry = createMachineLiveStreamCaptureRegistry();
        const source = {
            sourceId: 'private-source', streamFamily: 'screen',
            adapter: unavailableMachineLiveStreamCaptureAdapter,
            capabilities: {
                v: 1 as const, sourceId: 'private-source', sourceKind: 'screen' as const,
                supportedCodecs: ['image.mjpeg' as const], inputMode: 'none' as const,
                sidebands: [], health: { status: 'available' as const },
            },
            plugin: { pluginId: 'acme.owner', localId: 'screen', occurrenceId: 'owner-1' },
        };
        registry.register(source);
        expect(registry.describeViewing({ pluginId: 'acme.foreign',
            reference: { kind: 'plugin', source: { pluginId: 'acme.owner', localId: 'screen' } },
        })).toMatchObject({ ok: true, source: { sourceId: 'private-source', plugin: { pluginId: 'acme.owner' } } });
        expect(registry.describeViewing({ pluginId: 'acme.foreign',
            reference: { kind: 'host', sourceId: 'private-source' },
        })).toEqual({ ok: false, reasonCode: 'capture_source_denied' });
    });
    it('requires an exact source when a family contains multiple views and checks that source belongs to the family', () => {
        const registry = createMachineLiveStreamCaptureRegistry();
        for (const sourceId of ['view-a', 'view-b']) {
            registry.register({
                sourceId,
                streamFamily: 'browser.streamed',
                adapter: unavailableMachineLiveStreamCaptureAdapter,
                capabilities: {
                    v: 1, sourceId, sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
                    maxFramesPerSecond: 12, inputMode: 'shared', sidebands: [], health: { status: 'available' },
                },
            });
        }
        expect(registry.resolve({ streamFamily: 'browser.streamed' })).toMatchObject({ ok: false });
        expect(registry.resolve({ sourceId: 'view-b', streamFamily: 'browser.streamed' })).toMatchObject({
            ok: true, source: { sourceId: 'view-b' },
        });
        expect(registry.resolve({ sourceId: 'view-b', streamFamily: 'screen' })).toMatchObject({ ok: false });
        registry.unregister('view-b');
        expect(registry.resolve({ sourceId: 'view-b', streamFamily: 'browser.streamed' })).toMatchObject({ ok: false });
    });
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
