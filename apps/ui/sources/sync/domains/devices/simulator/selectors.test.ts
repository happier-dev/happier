import { describe, expect, it } from 'vitest';

import type {
    MachineLiveStreamControlLeaseV1,
    MachineLiveStreamFrameV1,
    SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';

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
        streamControls: {
            requestKeyframe: false,
            snapshot: false,
            setQuality: false,
            setFps: false,
            setScale: false,
        },
    },
};

const activeLease: MachineLiveStreamControlLeaseV1 = {
    v: 1,
    leaseId: 'lease_1',
    streamId: 'stream_1',
    sourceId: 'source_1',
    holderId: 'viewer_1',
    mode: 'exclusive',
    acquiredAtMs: 1_000,
    expiresAtMs: 2_000,
};

function avccFrame(): MachineLiveStreamFrameV1 & { codecId: 'h264.avcc' } {
    return {
        v: 1,
        streamId: 'stream_1',
        sequence: 2,
        timestampMs: 1_200,
        payloadKind: 'image_keyframe',
        payloadEncoding: 'binary_base64',
        payloadBase64: 'AQIDBA==',
        payloadSizeBytes: 4,
        codecId: 'h264.avcc',
    };
}

describe('simulator preview selectors', () => {
    it('returns a single empty view model when no simulator resources are available', async () => {
        const mod = await import('./selectors').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('selectSimulatorPreviewViewModel');
        if (!('selectSimulatorPreviewViewModel' in mod)) return;

        expect(mod.selectSimulatorPreviewViewModel({
            resources: [],
            selectedSimulatorId: null,
            viewerId: 'viewer_1',
            previewStatesBySimulatorId: {},
            playerStatesBySimulatorId: {},
            nowMs: 1_000,
        })).toMatchObject({
            kind: 'empty',
            selectedSimulatorId: null,
            resource: null,
            devices: [],
            availability: { state: 'unavailable', reasonCode: 'no_simulator_devices' },
        });
    });

    it('projects daemon-level platform diagnostics for an empty simulator pane', async () => {
        const mod = await import('./selectors').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('selectSimulatorPreviewViewModel');
        if (!('selectSimulatorPreviewViewModel' in mod)) return;

        expect(mod.selectSimulatorPreviewViewModel({
            resources: [],
            selectedSimulatorId: null,
            viewerId: 'viewer_1',
            previewStatesBySimulatorId: {},
            playerStatesBySimulatorId: {},
            snapshotDiagnostics: [{
                platform: 'android',
                severity: 'error',
                reasonCode: 'android_emulator_bridge_unavailable',
            }],
            nowMs: 1_000,
        }).diagnostics).toEqual([
            { severity: 'error', kind: 'availability', reasonCode: 'no_simulator_devices' },
            { severity: 'error', kind: 'availability', reasonCode: 'android_emulator_bridge_unavailable' },
        ]);
    });

    it('derives lease, controls, sidebands, codec, and last-frame player state for the selected resource', async () => {
        const mod = await import('./selectors').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('selectSimulatorPreviewViewModel');
        if (!('selectSimulatorPreviewViewModel' in mod)) return;

        const viewModel = mod.selectSimulatorPreviewViewModel({
            resources: [availableResource],
            selectedSimulatorId: 'sim_1',
            viewerId: 'viewer_1',
            nowMs: 1_500,
            previewStatesBySimulatorId: {
                sim_1: {
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
                    activeLease,
                    sidebandsByKind: {
                        logs: {
                            v: 1,
                            simulatorId: 'sim_1',
                            emittedAtMs: 1_100,
                            kind: 'logs',
                            level: 'info',
                            message: 'booted',
                        },
                    },
                },
            },
            playerStatesBySimulatorId: {},
        });

        expect(viewModel).toMatchObject({
            kind: 'selected',
            selectedSimulatorId: 'sim_1',
            resource: { simulatorId: 'sim_1' },
            stream: {
                phase: 'reconnecting',
                selectedCodec: 'image.mjpeg',
                activeRenderer: 'mjpeg',
                lastFrameUrl: 'data:image/jpeg;base64,AQID',
                decodedFrames: 1,
            },
            codec: { selected: 'image.mjpeg' },
            lease: { state: 'held-by-me' },
            controls: {
                canWatch: true,
                canControl: true,
                canRequestKeyframe: false,
                canRequestSnapshot: false,
                canSetQuality: false,
                canSetFps: false,
                canSetScale: false,
                supportedInputKinds: expect.arrayContaining(['tap', 'swipe', 'keyboard_text', 'hardware_button']),
            },
            sidebands: {},
            availability: { state: 'degraded' },
        });
        expect(viewModel.controls.supportedInputKinds).not.toEqual(expect.arrayContaining(['orientation', 'pinch', 'rotate']));
    });

    it('enables stream controls only from explicit producer-backed resource capabilities', async () => {
        const mod = await import('./selectors').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('selectSimulatorPreviewViewModel');
        if (!('selectSimulatorPreviewViewModel' in mod)) return;

        const viewModel = mod.selectSimulatorPreviewViewModel({
            resources: [{
                ...availableResource,
                capture: {
                    status: 'available',
                    sourceId: 'source_1',
                    supportedCodecs: ['h264.avcc'],
                    inputMode: 'exclusive',
                    streamControls: {
                        requestKeyframe: true,
                        snapshot: true,
                        setQuality: true,
                        setFps: true,
                        setScale: true,
                    },
                },
            }],
            selectedSimulatorId: 'sim_1',
            viewerId: 'viewer_1',
            nowMs: 1_500,
            previewStatesBySimulatorId: {
                sim_1: {
                    phase: 'connected',
                    lastFrame: null,
                    activeLease,
                },
            },
            playerStatesBySimulatorId: {},
        });

        expect(viewModel.controls).toMatchObject({
            canWatch: true,
            canRequestKeyframe: true,
            canRequestSnapshot: true,
            canSetQuality: true,
            canSetFps: true,
            canSetScale: true,
        });
    });

    it('disables input controls when another viewer owns the active lease', async () => {
        const mod = await import('./selectors').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('selectSimulatorPreviewViewModel');
        if (!('selectSimulatorPreviewViewModel' in mod)) return;

        expect(mod.selectSimulatorPreviewViewModel({
            resources: [availableResource],
            selectedSimulatorId: 'sim_1',
            viewerId: 'viewer_2',
            nowMs: 1_500,
            previewStatesBySimulatorId: {
                sim_1: {
                    phase: 'connected',
                    lastFrame: null,
                    activeLease,
                },
            },
            playerStatesBySimulatorId: {},
        })).toMatchObject({
            lease: { state: 'held-by-other', holderLabel: 'viewer_1' },
            controls: { canControl: false },
        });
    });

    it('preserves per-resource supported input kinds instead of expanding to generic controls', async () => {
        const mod = await import('./selectors').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('selectSimulatorPreviewViewModel');
        if (!('selectSimulatorPreviewViewModel' in mod)) return;

        const viewModel = mod.selectSimulatorPreviewViewModel({
            resources: [{
                ...availableResource,
                capture: {
                    status: 'available',
                    sourceId: 'source_1',
                    supportedCodecs: ['image.mjpeg'],
                    inputMode: 'exclusive',
                    supportedInputKinds: ['tap'],
                },
            }],
            selectedSimulatorId: 'sim_1',
            viewerId: 'viewer_1',
            nowMs: 1_500,
            previewStatesBySimulatorId: {
                sim_1: {
                    phase: 'connected',
                    lastFrame: null,
                    activeLease,
                },
            },
            playerStatesBySimulatorId: {},
        });

        expect(viewModel.controls.supportedInputKinds).toEqual(['tap']);
    });

    it('rejects stale input leases when the resource advertises inputMode none', async () => {
        const mod = await import('./selectors').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('selectSimulatorPreviewViewModel');
        if (!('selectSimulatorPreviewViewModel' in mod)) return;

        const viewModel = mod.selectSimulatorPreviewViewModel({
            resources: [{
                ...availableResource,
                capture: {
                    status: 'available',
                    sourceId: 'source_1',
                    supportedCodecs: ['image.mjpeg'],
                    inputMode: 'none',
                },
            }],
            selectedSimulatorId: 'sim_1',
            viewerId: 'viewer_1',
            nowMs: 1_500,
            previewStatesBySimulatorId: {
                sim_1: {
                    phase: 'connected',
                    lastFrame: null,
                    activeLease,
                },
            },
            playerStatesBySimulatorId: {},
        });

        expect(viewModel.lease).toEqual({ state: 'none' });
        expect(viewModel.controls).toMatchObject({
            canWatch: true,
            canControl: false,
            canRequestKeyframe: false,
            canRequestSnapshot: false,
            canSetQuality: false,
            canSetFps: false,
            canSetScale: false,
            supportedInputKinds: [],
        });
    });

    it('projects H.264 AVCC frames into WebCodecs chunks instead of JPEG URLs', async () => {
        const mod = await import('./selectors').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('selectSimulatorPreviewViewModel');
        if (!('selectSimulatorPreviewViewModel' in mod)) return;

        const viewModel = mod.selectSimulatorPreviewViewModel({
            resources: [{
                ...availableResource,
                capture: {
                    status: 'available',
                    sourceId: 'source_1',
                    supportedCodecs: ['h264.avcc', 'image.mjpeg'],
                    inputMode: 'exclusive',
                },
            }],
            selectedSimulatorId: 'sim_1',
            viewerId: 'viewer_1',
            nowMs: 1_500,
            previewStatesBySimulatorId: {
                sim_1: {
                    phase: 'connected',
                    lastFrame: avccFrame(),
                    activeLease,
                },
            },
            playerStatesBySimulatorId: {},
        });

        expect(viewModel.stream).toMatchObject({
            selectedCodec: 'h264.avcc',
            activeRenderer: 'webcodecs',
            decodedFrames: 1,
        });
        expect(viewModel.stream.lastFrameUrl).toBeUndefined();
        expect(viewModel.stream.avccChunks?.map((chunk) => [...chunk])).toEqual([[1, 2, 3, 4]]);
    });
});
