import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { SimulatorDeviceResourceV1 } from '@happier-dev/protocol';

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

const producerControlledResource: SimulatorDeviceResourceV1 = {
    ...availableResource,
    capture: {
        status: 'available',
        sourceId: 'source_1',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: {
            requestKeyframe: true,
            snapshot: true,
            setQuality: true,
            setFps: true,
            setScale: true,
        },
    },
};

describe('useSimulatorPreview', () => {
    it('selects a single view model and renews a held lease near expiry through the API boundary', async () => {
        const mod = await import('./useSimulatorPreview').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('useSimulatorPreview');
        if (!('useSimulatorPreview' in mod)) return;

        const renewLease = vi.fn();
        const releaseLease = vi.fn();
        const hook = await renderHook(() => mod.useSimulatorPreview({
            resources: [producerControlledResource],
            selectedSimulatorId: 'sim_1',
            viewerId: 'viewer_1',
            nowMs: () => 1_950,
            renewLeaseThresholdMs: 100,
            previewStatesBySimulatorId: {
                sim_1: {
                    phase: 'connected',
                    lastFrame: null,
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
                },
            },
            playerStatesBySimulatorId: {},
            api: {
                renewLease,
                releaseLease,
            },
        }));

        expect(hook.getCurrent().viewModel).toMatchObject({
            kind: 'selected',
            lease: { state: 'held-by-me' },
        });
        expect(renewLease).toHaveBeenCalledWith({
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
            leaseId: 'lease_1',
            viewerId: 'viewer_1',
        });

        await hook.getCurrent().actions.releaseLease();
        expect(releaseLease).toHaveBeenCalledWith({
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
            leaseId: 'lease_1',
        });
    });

    it('builds toolbar and recovery controls from callbacks without invoking hooks outside render', async () => {
        const mod = await import('./useSimulatorPreview').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('useSimulatorPreview');
        if (!('useSimulatorPreview' in mod)) return;

        const sendControl = vi.fn();
        const requestKeyframe = vi.fn();
        const setQuality = vi.fn();
        const requestSnapshot = vi.fn();
        const hook = await renderHook(() => mod.useSimulatorPreview({
            resources: [producerControlledResource],
            selectedSimulatorId: 'sim_1',
            viewerId: 'viewer_1',
            nowMs: () => 1_500,
            previewStatesBySimulatorId: {
                sim_1: {
                    phase: 'connected',
                    lastFrame: null,
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
                },
            },
            playerStatesBySimulatorId: {},
            api: {
                sendControl,
                requestKeyframe,
                requestSnapshot,
                setQuality,
            },
        }));

        await expect(hook.getCurrent().actions.requestKeyframe()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.lowerQuality()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.setFps()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.setScale()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.rotateLeft()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.pressHome()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.pressBack()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.pressRecent()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.pressVolumeUp()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.pressVolumeDown()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.requestSnapshot()).resolves.toBeUndefined();

        expect(requestKeyframe).toHaveBeenCalledWith(expect.objectContaining({
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
            control: expect.objectContaining({ kind: 'request_keyframe' }),
        }));
        expect(setQuality).toHaveBeenCalledWith(expect.objectContaining({
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
            control: expect.objectContaining({ kind: 'set_quality' }),
        }));
        expect(requestSnapshot).toHaveBeenCalledWith({
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
        });
        expect(sendControl).toHaveBeenCalledWith({
            control: expect.objectContaining({
                kind: 'set_quality',
                maxFramesPerSecond: 30,
            }),
        });
        expect(sendControl).toHaveBeenCalledWith({
            control: expect.objectContaining({
                kind: 'set_quality',
                maxWidth: 1080,
                maxHeight: 1080,
            }),
        });
        expect(sendControl).not.toHaveBeenCalledWith({
            control: expect.objectContaining({ kind: 'orientation', orientation: 'landscapeLeft' }),
        });
        expect(sendControl).toHaveBeenCalledWith({
            control: expect.objectContaining({ kind: 'hardware_button', button: 'home' }),
        });
        expect(sendControl).toHaveBeenCalledWith({
            control: expect.objectContaining({ kind: 'hardware_button', button: 'back' }),
        });
        expect(sendControl).toHaveBeenCalledWith({
            control: expect.objectContaining({ kind: 'hardware_button', button: 'recents' }),
        });
        expect(sendControl).toHaveBeenCalledWith({
            control: expect.objectContaining({ kind: 'hardware_button', button: 'volumeup' }),
        });
        expect(sendControl).toHaveBeenCalledWith({
            control: expect.objectContaining({ kind: 'hardware_button', button: 'volumedown' }),
        });
    });

    it('routes keyframe and quality toolbar actions through their typed API events without duplicate control dispatch', async () => {
        const mod = await import('./useSimulatorPreview').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('useSimulatorPreview');
        if (!('useSimulatorPreview' in mod)) return;

        const sendControl = vi.fn();
        const requestKeyframe = vi.fn();
        const setQuality = vi.fn();
        const hook = await renderHook(() => mod.useSimulatorPreview({
            resources: [producerControlledResource],
            selectedSimulatorId: 'sim_1',
            viewerId: 'viewer_1',
            nowMs: () => 1_500,
            previewStatesBySimulatorId: {
                sim_1: {
                    phase: 'connected',
                    lastFrame: null,
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
                },
            },
            playerStatesBySimulatorId: {},
            api: {
                sendControl,
                requestKeyframe,
                setQuality,
            },
        }));

        await hook.getCurrent().actions.requestKeyframe();
        await hook.getCurrent().actions.lowerQuality();

        expect(requestKeyframe).toHaveBeenCalledWith(expect.objectContaining({
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
            control: expect.objectContaining({ kind: 'request_keyframe' }),
        }));
        expect(setQuality).toHaveBeenCalledWith(expect.objectContaining({
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
            control: expect.objectContaining({ kind: 'set_quality' }),
        }));
        expect(sendControl).not.toHaveBeenCalled();
    });

    it('does not send lease or device input actions when the adapter advertises inputMode none', async () => {
        const mod = await import('./useSimulatorPreview').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('useSimulatorPreview');
        if (!('useSimulatorPreview' in mod)) return;

        const acquireLease = vi.fn();
        const sendControl = vi.fn();
        const requestKeyframe = vi.fn();
        const hook = await renderHook(() => mod.useSimulatorPreview({
            resources: [{
                ...availableResource,
                capture: {
                    status: 'available',
                    sourceId: 'source_1',
                    supportedCodecs: ['image.mjpeg'],
                    inputMode: 'none',
                    streamControls: {
                        requestKeyframe: true,
                        snapshot: false,
                        setQuality: false,
                        setFps: false,
                        setScale: false,
                    },
                },
            }],
            selectedSimulatorId: 'sim_1',
            viewerId: 'viewer_1',
            nowMs: () => 1_500,
            previewStatesBySimulatorId: {
                sim_1: {
                    phase: 'connected',
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
                },
            },
            playerStatesBySimulatorId: {},
            api: {
                acquireLease,
                sendControl,
                requestKeyframe,
            },
        }));

        expect(hook.getCurrent().viewModel.controls.canWatch).toBe(true);
        expect(hook.getCurrent().viewModel.controls.canControl).toBe(false);

        await expect(hook.getCurrent().actions.acquireLease()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.rotateLeft()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.pressHome()).resolves.toBeUndefined();
        await expect(hook.getCurrent().actions.requestKeyframe()).resolves.toBeUndefined();

        expect(acquireLease).not.toHaveBeenCalled();
        expect(sendControl).not.toHaveBeenCalled();
        expect(requestKeyframe).toHaveBeenCalledWith(expect.objectContaining({
            simulatorId: 'sim_1',
            streamId: 'stream_1',
            sourceId: 'source_1',
            control: expect.objectContaining({ kind: 'request_keyframe' }),
        }));
    });
});
