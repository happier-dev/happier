import { describe, expect, it } from 'vitest';

import type {
    MachineLiveStreamControlLeaseV1} from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';
import type {
    MachineLiveStreamFrameV1} from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import type {
    SimulatorDeviceResourceV1,
} from '@happier-dev/protocol/devices/simulator/v1';

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
        supportedInputKinds: ['tap', 'swipe', 'keyboard_text', 'hardware_button'],
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
    it('does not invent supported input when the producer omits its input capabilities', async () => {
        const { selectSimulatorPreviewViewModel } = await import('./selectors');
        const resource: SimulatorDeviceResourceV1 = {
            ...availableResource,
            capture: { ...availableResource.capture, supportedInputKinds: undefined },
        };
        const viewModel = selectSimulatorPreviewViewModel({ resources: [resource], viewerId: 'viewer_1' });

        expect(viewModel.controls.supportedInputKinds).toEqual([]);
    });

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
                canSetQuality: false,
                canSetFps: false,
                canSetScale: false,
                supportedInputKinds: expect.arrayContaining(['tap', 'swipe', 'keyboard_text', 'hardware_button']),
            },
            sidebands: { logs: { kind: 'logs', message: 'booted' } },
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
    it('names the platform and offers exactly the device operations and hardware buttons the producer advertises', async () => {
        const { selectSimulatorPreviewViewModel } = await import('./selectors');
        const select = (resource: SimulatorDeviceResourceV1) => selectSimulatorPreviewViewModel({
            resources: [resource],
            selectedSimulatorId: resource.simulatorId,
            viewerId: 'viewer_1',
            nowMs: 1_500,
            previewStatesBySimulatorId: {},
            playerStatesBySimulatorId: {},
        });
        const ios = select(availableResource);
        expect(ios.devices[0]?.platformLabel).toBe('iOS');
        expect(ios.controls.hardwareButtons).toEqual([]);

        const android = select({
            ...availableResource, platform: 'android', displayName: 'Pixel 9',
            supportedDeviceOperations: ['hardware', 'screenshot'], supportedHardwareButtons: ['home', 'back', 'recents'],
        });
        expect(android.devices[0]).toMatchObject({ platformLabel: 'Android', state: 'running', canBoot: false });
        expect(android.controls.hardwareButtons).toEqual(['home', 'back', 'recents']);
        expect(android.controls.deviceOperations).toEqual(['hardware', 'screenshot']);

        // Buttons without the hardware operation cannot be pressed, so none are offered.
        const noHardwareOperation = select({ ...availableResource, platform: 'android', supportedHardwareButtons: ['home'] });
        expect(noHardwareOperation.controls.hardwareButtons).toEqual([]);

        const stopped = select({
            ...availableResource, state: 'stopped', supportedDeviceOperations: ['boot'],
            capture: { status: 'unavailable', sourceId: 'source_1', reasonCode: 'device_stopped' },
        });
        expect(stopped.devices[0]).toMatchObject({ state: 'stopped', canBoot: true });
    });
});
