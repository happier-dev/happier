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

    it('builds lease-scoped swipe, keyboard text, hardware button, and orientation controls', async () => {
        const mod = await import('./control').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('buildSimulatorPreviewControl');
        if (!('buildSimulatorPreviewControl' in mod)) return;

        const base = {
            streamId: 'stream_1',
            sourceId: 'source_1',
            viewerId: 'viewer_1',
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
        } as const;

        expect(mod.buildSimulatorPreviewControl({
            ...base,
            eventId: 'swipe_1',
            action: {
                kind: 'swipe',
                from: { x: 0.5, y: 0.25 },
                to: { x: 0.5, y: 0.75 },
                durationMs: 250,
                orientation: 'portrait',
                viewport: { width: 400, height: 400 },
                content: { x: 100, y: 0, width: 200, height: 400 },
            },
        })).toEqual({
            ok: true,
            control: {
                v: 1,
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'swipe_1',
                leaseId: 'lease_1',
                kind: 'swipe',
                fromX: 0.5,
                fromY: 0.25,
                toX: 0.5,
                toY: 0.75,
                durationMs: 250,
            },
        });

        expect(mod.buildSimulatorPreviewControl({
            ...base,
            eventId: 'text_1',
            action: { kind: 'keyboard_text', text: 'hello' },
        })).toMatchObject({
            ok: true,
            control: { kind: 'keyboard_text', leaseId: 'lease_1', text: 'hello' },
        });

        expect(mod.buildSimulatorPreviewControl({
            ...base,
            eventId: 'button_1',
            action: { kind: 'hardware_button', button: 'home' },
        })).toMatchObject({
            ok: true,
            control: { kind: 'hardware_button', leaseId: 'lease_1', button: 'home' },
        });

        expect(mod.buildSimulatorPreviewControl({
            ...base,
            eventId: 'orientation_1',
            action: { kind: 'orientation', orientation: 'landscapeLeft' },
        })).toMatchObject({
            ok: true,
            control: { kind: 'orientation', leaseId: 'lease_1', orientation: 'landscapeLeft' },
        });
    });

    it('builds stream recovery controls without requiring an input lease', async () => {
        const mod = await import('./control').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('buildSimulatorPreviewControl');
        if (!('buildSimulatorPreviewControl' in mod)) return;

        expect(mod.buildSimulatorPreviewControl({
            streamId: 'stream_1',
            sourceId: 'source_1',
            viewerId: 'viewer_1',
            eventId: 'keyframe_1',
            activeLease: null,
            action: { kind: 'request_keyframe' },
        })).toEqual({
            ok: true,
            control: {
                v: 1,
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'keyframe_1',
                kind: 'request_keyframe',
            },
        });

        expect(mod.buildSimulatorPreviewControl({
            streamId: 'stream_1',
            sourceId: 'source_1',
            viewerId: 'viewer_1',
            eventId: 'quality_1',
            activeLease: null,
            action: { kind: 'set_quality', maxFramesPerSecond: 30, maxWidth: 1080 },
        })).toMatchObject({
            ok: true,
            control: { kind: 'set_quality', maxFramesPerSecond: 30, maxWidth: 1080 },
        });
    });

    it('ignores geometry-based input outside the device content frame', async () => {
        const mod = await import('./control').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('buildSimulatorPreviewControl');
        if (!('buildSimulatorPreviewControl' in mod)) return;

        expect(mod.buildSimulatorPreviewControl({
            streamId: 'stream_1',
            sourceId: 'source_1',
            viewerId: 'viewer_1',
            eventId: 'swipe_1',
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
            action: {
                kind: 'swipe',
                from: { x: 0.1, y: 0.5 },
                to: { x: 0.8, y: 0.5 },
                orientation: 'portrait',
                viewport: { width: 400, height: 400 },
                content: { x: 100, y: 0, width: 200, height: 400 },
            },
        })).toEqual({
            ok: false,
            reasonCode: 'outside_device_frame',
        });
    });
});
