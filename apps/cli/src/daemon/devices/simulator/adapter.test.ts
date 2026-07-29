import { describe, expect, it, vi } from 'vitest';

import type {
    SimulatorDeviceResourceV1,
    SimulatorPreviewActionResultV1,
} from '@happier-dev/protocol';
import { DEFAULT_SIMULATOR_STREAM_CONTROLS_V1 } from '@happier-dev/protocol';

import {
    createComposedSimulatorPreviewAdapter,
    type SimulatorPlatformPreviewAdapter,
} from './adapter';

const iosResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'sim_ios',
    platform: 'ios',
    deviceId: 'device_ios',
    displayName: 'iPhone 16 Pro',
    capture: {
        status: 'available',
        sourceId: 'source_ios',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

const androidResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'sim_android',
    platform: 'android',
    deviceId: 'device_android',
    displayName: 'Pixel 9',
    capture: {
        status: 'available',
        sourceId: 'source_android',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

function createPlatform(
    overrides: Partial<SimulatorPlatformPreviewAdapter> & Pick<SimulatorPlatformPreviewAdapter, 'platform'>,
): SimulatorPlatformPreviewAdapter {
    return {
        platform: overrides.platform,
        listResources: overrides.listResources ?? (() => []),
        listDiagnostics: overrides.listDiagnostics ?? (() => []),
        dispatchAction: overrides.dispatchAction ?? (() => undefined),
        stop: overrides.stop ?? (async () => {}),
    };
}

describe('simulator preview composed adapter', () => {
    it('composes platform resources and isolates resource/diagnostic failures', async () => {
        const adapter = createComposedSimulatorPreviewAdapter({
            platforms: [
                createPlatform({
                    platform: 'ios',
                    listResources: () => [iosResource],
                    listDiagnostics: () => [{
                        platform: 'ios',
                        reasonCode: 'ios_private_helper_unavailable',
                    }],
                }),
                createPlatform({
                    platform: 'android',
                    listResources: () => {
                        throw new Error('adb unavailable');
                    },
                    listDiagnostics: () => {
                        throw new Error('scrcpy unavailable');
                    },
                }),
            ],
        });

        await expect(adapter.listResources()).resolves.toEqual([iosResource]);
        await expect(adapter.listDiagnostics()).resolves.toEqual([
            {
                platform: 'android',
                code: 'simulator_platform_resources_unavailable',
                errorName: 'Error',
            },
            {
                platform: 'ios',
                reasonCode: 'ios_private_helper_unavailable',
            },
            {
                platform: 'android',
                code: 'simulator_platform_diagnostics_unavailable',
                errorName: 'Error',
            },
        ]);
    });

    it('routes simulator actions to the owning platform by simulator id', async () => {
        const iosDispatch = vi.fn(async (): Promise<SimulatorPreviewActionResultV1> => ({
            v: 1,
            eventType: 'simulator.sideband.request',
            status: 'accepted',
            diagnostics: [],
        }));
        const androidDispatch = vi.fn();
        const adapter = createComposedSimulatorPreviewAdapter({
            platforms: [
                createPlatform({
                    platform: 'ios',
                    listResources: () => [iosResource],
                    dispatchAction: iosDispatch,
                }),
                createPlatform({
                    platform: 'android',
                    listResources: () => [androidResource],
                    dispatchAction: androidDispatch,
                }),
            ],
        });
        const resources = await adapter.listResources();

        await expect(adapter.dispatchAction({
            event: {
                type: 'simulator.sideband.request',
                simulatorId: 'sim_ios',
                kind: 'logs',
            },
            resources,
        })).resolves.toMatchObject({ status: 'accepted' });

        expect(iosDispatch).toHaveBeenCalledWith({
            event: {
                type: 'simulator.sideband.request',
                simulatorId: 'sim_ios',
                kind: 'logs',
            },
            resources,
            platformResources: [iosResource],
            resource: iosResource,
        });
        expect(androidDispatch).not.toHaveBeenCalled();
    });

    it('routes control actions to the owning platform by source id', async () => {
        const androidDispatch = vi.fn(async (): Promise<SimulatorPreviewActionResultV1> => ({
            v: 1,
            eventType: 'simulator.control.send',
            status: 'accepted',
            diagnostics: [],
        }));
        const adapter = createComposedSimulatorPreviewAdapter({
            platforms: [
                createPlatform({
                    platform: 'ios',
                    listResources: () => [iosResource],
                }),
                createPlatform({
                    platform: 'android',
                    listResources: () => [androidResource],
                    dispatchAction: androidDispatch,
                }),
            ],
        });
        const resources = await adapter.listResources();

        await expect(adapter.dispatchAction({
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream_android',
                    sourceId: 'source_android',
                    eventId: 'tap_1',
                    x: 0.25,
                    y: 0.75,
                },
            },
            resources,
        })).resolves.toMatchObject({ status: 'accepted' });

        expect(androidDispatch).toHaveBeenCalledWith(expect.objectContaining({
            platformResources: [androidResource],
            resource: androidResource,
        }));
    });

    it('routes sideband requests to the owning platform even when capture is unavailable', async () => {
        const unavailableIosResource: SimulatorDeviceResourceV1 = {
            ...iosResource,
            capture: {
                status: 'unavailable',
                sourceId: 'source_ios',
                reasonCode: 'ios_capture_adapter_unavailable',
            },
            unavailableReason: 'ios_capture_adapter_unavailable',
        };
        const iosDispatch = vi.fn(async (): Promise<SimulatorPreviewActionResultV1> => ({
            v: 1,
            eventType: 'simulator.sideband.request',
            status: 'accepted',
            diagnostics: [],
        }));
        const adapter = createComposedSimulatorPreviewAdapter({
            platforms: [
                createPlatform({
                    platform: 'ios',
                    listResources: () => [unavailableIosResource],
                    dispatchAction: iosDispatch,
                }),
            ],
        });
        const resources = await adapter.listResources();

        await expect(adapter.dispatchAction({
            event: {
                type: 'simulator.sideband.request',
                simulatorId: 'sim_ios',
                kind: 'capture_health',
            },
            resources,
        })).resolves.toMatchObject({ status: 'accepted' });
        expect(iosDispatch).toHaveBeenCalledWith(expect.objectContaining({
            resource: unavailableIosResource,
        }));
    });

    it('rejects ambiguous duplicate simulator/source routing without calling native dispatch', async () => {
        const dispatchAction = vi.fn();
        const duplicate: SimulatorDeviceResourceV1 = {
            ...androidResource,
            simulatorId: 'sim_ios',
            capture: {
                status: 'available',
                sourceId: 'source_ios',
                supportedCodecs: ['image.mjpeg'],
                inputMode: 'exclusive',
                streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
            },
        };
        const adapter = createComposedSimulatorPreviewAdapter({
            platforms: [
                createPlatform({
                    platform: 'ios',
                    listResources: () => [iosResource],
                    dispatchAction,
                }),
                createPlatform({
                    platform: 'android',
                    listResources: () => [duplicate],
                    dispatchAction,
                }),
            ],
        });
        const resources = await adapter.listResources();

        await expect(adapter.dispatchAction({
            event: {
                type: 'simulator.sideband.request',
                simulatorId: 'sim_ios',
                kind: 'logs',
            },
            resources,
        })).resolves.toMatchObject({
            status: 'rejected',
            reasonCode: 'ambiguous_simulator',
        });
        await expect(adapter.dispatchAction({
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream_1',
                    sourceId: 'source_ios',
                    eventId: 'tap_1',
                    x: 0.5,
                    y: 0.5,
                },
            },
            resources,
        })).resolves.toMatchObject({
            status: 'rejected',
            reasonCode: 'ambiguous_simulator_source',
        });
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('stops every platform once even when one stop rejects', async () => {
        const stopIos = vi.fn(async () => {
            throw new Error('helper stop failed');
        });
        const stopAndroid = vi.fn(async () => {});
        const adapter = createComposedSimulatorPreviewAdapter({
            platforms: [
                createPlatform({ platform: 'ios', stop: stopIos }),
                createPlatform({ platform: 'android', stop: stopAndroid }),
            ],
        });

        await expect(adapter.stop()).resolves.toBeUndefined();
        await expect(adapter.stop()).resolves.toBeUndefined();
        expect(stopIos).toHaveBeenCalledOnce();
        expect(stopAndroid).toHaveBeenCalledOnce();
    });
});
