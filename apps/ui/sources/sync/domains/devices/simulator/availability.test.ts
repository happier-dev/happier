import { describe, expect, it } from 'vitest';

import { DEFAULT_SIMULATOR_STREAM_CONTROLS_V1, type SimulatorDeviceResourceV1, type SimulatorSidebandMessageV1 } from '@happier-dev/protocol';

const availableResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'sim_1',
    platform: 'ios',
    deviceId: 'device_1',
    displayName: 'iPhone 16',
    capture: {
        status: 'available',
        sourceId: 'source_1',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

describe('simulator preview availability projection', () => {
    it('projects missing and capture-unavailable devices as explicit unavailable states', async () => {
        const mod = await import('./availability').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('projectSimulatorPreviewAvailability');
        if (!('projectSimulatorPreviewAvailability' in mod)) return;

        expect(mod.projectSimulatorPreviewAvailability({
            resource: null,
            previewState: null,
            stream: null,
        })).toEqual({
            state: 'unavailable',
            reasonCode: 'no_simulator_devices',
        });

        expect(mod.projectSimulatorPreviewAvailability({
            resource: {
                ...availableResource,
                capture: {
                    status: 'unavailable',
                    sourceId: 'source_1',
                    reasonCode: 'ios_simulator_adapter_missing',
                },
            },
            previewState: null,
            stream: null,
        })).toEqual({
            state: 'unavailable',
            reasonCode: 'ios_simulator_adapter_missing',
        });
    });

    it('projects capture-health sidebands and reconnecting last-frame streams as degraded, not blank', async () => {
        const mod = await import('./availability').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('projectSimulatorPreviewAvailability');
        if (!('projectSimulatorPreviewAvailability' in mod)) return;

        const captureHealth = {
            v: 1,
            simulatorId: 'sim_1',
            emittedAtMs: 2_000,
            kind: 'capture_health',
            status: 'degraded',
            reasonCode: 'slow_consumer',
        } satisfies SimulatorSidebandMessageV1;

        expect(mod.projectSimulatorPreviewAvailability({
            resource: availableResource,
            previewState: {
                phase: 'reconnecting',
                lastFrame: {
                    v: 1,
                    streamId: 'stream_1',
                    sequence: 1,
                    timestampMs: 1_000,
                    payloadKind: 'image_keyframe',
                    payloadEncoding: 'binary_base64',
                    payloadBase64: 'AQID',
                    payloadSizeBytes: 3,
                },
                sidebandsByKind: { capture_health: captureHealth },
            },
            stream: {
                phase: 'reconnecting',
                selectedCodec: 'image.mjpeg',
                activeRenderer: 'mjpeg',
                lastFrameUrl: 'data:image/jpeg;base64,AQID',
                decodedFrames: 1,
                droppedFrames: 0,
                bufferedBytes: 0,
            },
        })).toEqual({
            state: 'degraded',
            reasonCode: 'slow_consumer',
        });
    });
});
