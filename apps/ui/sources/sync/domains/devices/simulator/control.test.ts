import { describe, expect, it } from 'vitest';

describe('simulator preview input control builder', () => {
    it('builds lease-scoped tap controls from preview coordinates', async () => {
        const mod = await import('./control').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('buildSimulatorPreviewTapControl');
        if (!('buildSimulatorPreviewTapControl' in mod)) return;

        expect(mod.buildSimulatorPreviewTapControl({
            streamId: 'stream_1',
            sourceId: 'source_1',
            viewerId: 'viewer_1',
            eventId: 'event_1',
            activeLease: {
                v: 1,
                leaseId: 'lease_1',
                streamId: 'stream_1',
                sourceId: 'source_1',
                holderId: 'viewer_1',
                mode: 'exclusive',
                acquiredAtMs: 1_000,
                expiresAtMs: 2_000,
            },
            point: { x: 0.5, y: 0.5 },
            orientation: 'landscapeLeft',
            viewport: { width: 400, height: 400 },
            content: { x: 100, y: 0, width: 200, height: 400 },
        })).toEqual({
            ok: true,
            control: {
                v: 1,
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'event_1',
                leaseId: 'lease_1',
                kind: 'tap',
                x: 0.5,
                y: 0.5,
            },
        });
    });

    it('fails closed when the viewer does not hold an input lease', async () => {
        const mod = await import('./control').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('buildSimulatorPreviewTapControl');
        if (!('buildSimulatorPreviewTapControl' in mod)) return;

        expect(mod.buildSimulatorPreviewTapControl({
            streamId: 'stream_1',
            sourceId: 'source_1',
            viewerId: 'viewer_1',
            eventId: 'event_1',
            activeLease: null,
            point: { x: 0.5, y: 0.5 },
            orientation: 'portrait',
            viewport: { width: 400, height: 400 },
            content: { x: 0, y: 0, width: 400, height: 400 },
        })).toEqual({
            ok: false,
            reasonCode: 'input_lease_required',
        });
    });

    it('fails closed when another viewer holds the active input lease', async () => {
        const mod = await import('./control').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('buildSimulatorPreviewTapControl');
        if (!('buildSimulatorPreviewTapControl' in mod)) return;

        expect(mod.buildSimulatorPreviewTapControl({
            streamId: 'stream_1',
            sourceId: 'source_1',
            viewerId: 'viewer_2',
            eventId: 'event_1',
            activeLease: {
                v: 1,
                leaseId: 'lease_1',
                streamId: 'stream_1',
                sourceId: 'source_1',
                holderId: 'viewer_1',
                mode: 'exclusive',
                acquiredAtMs: 1_000,
                expiresAtMs: 2_000,
            },
            point: { x: 0.5, y: 0.5 },
            orientation: 'portrait',
            viewport: { width: 400, height: 400 },
            content: { x: 0, y: 0, width: 400, height: 400 },
        })).toEqual({
            ok: false,
            reasonCode: 'input_lease_holder_mismatch',
        });
    });
});
