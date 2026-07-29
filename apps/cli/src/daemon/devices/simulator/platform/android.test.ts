import { describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    type MachineLiveStreamInputControlKindV1,
    type SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';
import type { AndroidScrcpyControlSender } from '../android/control';
import type { AndroidToolRunner } from '../android/tooling';

const androidControlResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'android:emulator:emulator-5554',
    platform: 'android',
    deviceId: 'emulator-5554',
    displayName: 'Pixel 9 API 35',
    capture: {
        status: 'available',
        sourceId: 'simulator:android:emulator-5554:screen',
        supportedCodecs: ['h264.avcc'],
        inputMode: 'exclusive',
        supportedInputKinds: ['tap'],
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

function withSupportedInputKinds(
    resource: SimulatorDeviceResourceV1,
    supportedInputKinds: readonly MachineLiveStreamInputControlKindV1[],
): SimulatorDeviceResourceV1 {
    if (resource.capture.status === 'unavailable') {
        throw new Error('expected an available simulator capture resource');
    }
    return {
        ...resource,
        capture: {
            ...resource.capture,
            supportedInputKinds: [...supportedInputKinds],
        },
    };
}

describe('Android emulator platform adapter', () => {
    it('uses an Android-owned unavailable diagnostic instead of iOS private assumptions', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createAndroidSimulatorPlatformAdapter({ bridgeAvailable: false });
        expect(adapter.platform).toBe('android');
        expect(adapter.usesPrivateFrameworks).toBe(false);
        await expect(adapter.health()).resolves.toMatchObject({
            v: 1,
            platform: 'android',
            status: 'unavailable',
            reasonCode: 'android_emulator_bridge_unavailable',
        });
        await expect(adapter.capture({ simulatorId: 'emu_1' })).resolves.toEqual({
            ok: false,
            reasonCode: 'android_emulator_bridge_unavailable',
            requiredOwner: 'android_emulator_capture_input_bridge',
        });
    });

    it('projects authorized Android emulators into daemon resources through the platform adapter', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            bridgeAvailable: true,
            discoverDevices: async () => [{
                serial: 'emulator-5554',
                kind: 'emulator',
                state: 'device',
                displayName: 'Pixel 9 API 35',
            }],
        });

        await expect(adapter.listResources()).resolves.toEqual([{
            v: 1,
            simulatorId: 'android:emulator:emulator-5554',
            platform: 'android',
            deviceId: 'emulator-5554',
            displayName: 'Pixel 9 API 35',
            capture: {
                status: 'available',
                sourceId: 'simulator:android:emulator-5554:screen',
                supportedCodecs: ['h264.avcc'],
                inputMode: 'exclusive',
                supportedInputKinds: [
                    'tap',
                    'long_press',
                    'swipe',
                    'drag',
                    'keyboard_text',
                    'keyboard_key',
                    'hardware_button',
                ],
                // The Android scrcpy server-restart producer backs every encoder control, so the
                // discovered resource advertises them (set_quality / request_keyframe / snapshot /
                // fps / scale).
                streamControls: {
                    requestKeyframe: true,
                    snapshot: true,
                    setQuality: true,
                    setFps: true,
                    setScale: true,
                },
            },
        }]);
        await expect(adapter.capture({ simulatorId: 'android:emulator:emulator-5554' })).resolves.toEqual({ ok: true });
    });

    it('returns capture-health sidebands from the Android platform adapter without entering input dispatch', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            bridgeAvailable: true,
            runAdb,
        });

        await expect(adapter.dispatchAction({
            resource: androidControlResource,
            event: {
                type: 'simulator.sideband.request',
                simulatorId: 'android:emulator:emulator-5554',
                kind: 'capture_health',
            },
        })).resolves.toMatchObject({
            status: 'accepted',
            sideband: {
                kind: 'capture_health',
                simulatorId: 'android:emulator:emulator-5554',
                status: 'available',
            },
        });
        expect(runAdb).not.toHaveBeenCalled();
    });

    it('fails closed with a sideband-specific Android reason for unsupported sidebands', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createAndroidSimulatorPlatformAdapter({ bridgeAvailable: true });

        await expect(adapter.dispatchAction({
            resource: androidControlResource,
            event: {
                type: 'simulator.sideband.request',
                simulatorId: 'android:emulator:emulator-5554',
                kind: 'logs',
            },
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'android_simulator_sideband_logs_unsupported',
        });
    });

    it('surfaces physical Android devices as unsupported V1 resources instead of enabling control', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            bridgeAvailable: true,
            discoverDevices: async () => [{
                serial: 'R5CT123456A',
                kind: 'physical',
                state: 'device',
                displayName: 'Galaxy S25',
            }],
        });

        await expect(adapter.listResources()).resolves.toEqual([{
            v: 1,
            simulatorId: 'android:physical:R5CT123456A',
            platform: 'android',
            deviceId: 'R5CT123456A',
            displayName: 'Galaxy S25',
            capture: {
                status: 'unavailable',
                sourceId: 'simulator:android:R5CT123456A:screen',
                reasonCode: 'physical_device_not_supported_v1',
            },
            unavailableReason: 'physical_device_not_supported_v1',
        }]);
    });

    it('consumes Android discovery results as the platform adapter source of truth', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [{
                    v: 1,
                    simulatorId: 'android:emulator:emulator-5554',
                    platform: 'android',
                    deviceId: 'emulator-5554',
                    displayName: 'Pixel 9 API 35',
                    capture: {
                        status: 'unavailable',
                        sourceId: 'simulator:android:emulator-5554:screen',
                        reasonCode: 'android_emulator_bridge_unavailable',
                    },
                    unavailableReason: 'android_emulator_bridge_unavailable',
                }],
                diagnostics: [{
                    platform: 'android',
                    reasonCode: 'android_emulator_bridge_unavailable',
                }],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'unavailable',
                    reasonCode: 'android_emulator_bridge_unavailable',
                    diagnostics: [{ requiredOwner: 'android_emulator_capture_input_bridge' }],
                },
            }),
        });

        await expect(adapter.health()).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'android_emulator_bridge_unavailable',
        });
        await expect(adapter.listResources()).resolves.toEqual([expect.objectContaining({
            simulatorId: 'android:emulator:emulator-5554',
        })]);
        await expect(adapter.listDiagnostics()).resolves.toEqual([expect.objectContaining({
            reasonCode: 'android_emulator_bridge_unavailable',
        })]);
    });

    it('uses discovery resource capture state instead of health alone for capture availability', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [{
                    v: 1,
                    simulatorId: 'android:emulator:emulator-5554',
                    platform: 'android',
                    deviceId: 'emulator-5554',
                    displayName: 'Pixel 9 API 35',
                    capture: {
                        status: 'unavailable',
                        sourceId: 'simulator:android:emulator-5554:screen',
                        reasonCode: 'android_emulator_bridge_unavailable',
                    },
                    unavailableReason: 'android_emulator_bridge_unavailable',
                }],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'available',
                    transport: 'scrcpy-local-sockets-over-pms',
                    physicalDevicesSupported: false,
                    supportedCodecs: ['h264.avcc'],
                    supportedInputKinds: ['tap'],
                    clipboardSyncDefault: 'disabled',
                },
            }),
        });

        await expect(adapter.capture({ simulatorId: 'android:emulator:emulator-5554' })).resolves.toEqual({
            ok: false,
            reasonCode: 'android_emulator_bridge_unavailable',
        });
    });

    it('dispatches available control actions through the Android input translator', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [androidControlResource],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'available',
                    transport: 'scrcpy-local-sockets-over-pms',
                    physicalDevicesSupported: false,
                    supportedCodecs: ['h264.avcc'],
                    supportedInputKinds: ['tap'],
                    clipboardSyncDefault: 'disabled',
                },
            }),
            resolveAdbTooling: async () => ({ ok: true, command: 'adb', source: 'path' }),
            runAdb,
            inputDisplaySize: { widthPx: 1080, heightPx: 1920 },
        });

        await expect(adapter.dispatchAction({
            resource: androidControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream-1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'event-1',
                    x: 0.5,
                    y: 0.25,
                },
            },
        })).resolves.toMatchObject({ status: 'accepted' });

        expect(runAdb).toHaveBeenCalledWith({
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'input', 'tap', '540', '480'],
            timeoutMs: expect.any(Number),
        });
    });

    it('fails closed instead of dispatching Android input without composed resource authority', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [androidControlResource],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'available',
                    transport: 'scrcpy-local-sockets-over-pms',
                    physicalDevicesSupported: false,
                    supportedCodecs: ['h264.avcc'],
                    supportedInputKinds: ['tap'],
                    clipboardSyncDefault: 'disabled',
                },
            }),
            resolveAdbTooling: async () => ({ ok: true, command: 'adb', source: 'path' }),
            runAdb,
            inputDisplaySize: { widthPx: 1080, heightPx: 1920 },
        });

        await expect(adapter.dispatchAction({
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream-1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'event-1',
                    x: 0.5,
                    y: 0.25,
                },
            },
        })).resolves.toMatchObject({
            status: 'rejected',
            reasonCode: 'simulator_resource_authority_required',
        });
        expect(runAdb).not.toHaveBeenCalled();
    });

    it('fails closed instead of dispatching Android input for resources not returned by discovery', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'available',
                    transport: 'scrcpy-local-sockets-over-pms',
                    physicalDevicesSupported: false,
                    supportedCodecs: ['h264.avcc'],
                    supportedInputKinds: ['tap'],
                    clipboardSyncDefault: 'disabled',
                },
            }),
            resolveAdbTooling: async () => ({ ok: true, command: 'adb', source: 'path' }),
            runAdb,
            inputDisplaySize: { widthPx: 1080, heightPx: 1920 },
        });

        await expect(adapter.dispatchAction({
            resource: androidControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream-1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'event-1',
                    x: 0.5,
                    y: 0.25,
                },
            },
        })).resolves.toMatchObject({
            status: 'rejected',
            reasonCode: 'simulator_resource_authority_required',
        });
        expect(runAdb).not.toHaveBeenCalled();
    });

    it('fails closed instead of dispatching control kinds not supported by discovery health', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [androidControlResource],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'available',
                    transport: 'scrcpy-local-sockets-over-pms',
                    physicalDevicesSupported: false,
                    supportedCodecs: ['h264.avcc'],
                    supportedInputKinds: ['tap'],
                    clipboardSyncDefault: 'disabled',
                },
            }),
            resolveAdbTooling: async () => ({ ok: true, command: 'adb', source: 'path' }),
            runAdb,
            inputDisplaySize: { widthPx: 1080, heightPx: 1920 },
        });

        await expect(adapter.dispatchAction({
            resource: androidControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'keyboard_text',
                    streamId: 'stream-1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'event-1',
                    text: 'hello',
                },
            },
        })).resolves.toMatchObject({
            status: 'rejected',
            reasonCode: 'input_not_supported',
        });
        expect(runAdb).not.toHaveBeenCalled();
    });

    it('keeps scrcpy-control-only gestures unavailable while server control mode is disabled', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [androidControlResource],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'available',
                    transport: 'scrcpy-local-sockets-over-pms',
                    physicalDevicesSupported: false,
                    supportedCodecs: ['h264.avcc'],
                    supportedInputKinds: ['tap'],
                    clipboardSyncDefault: 'disabled',
                },
            }),
            resolveAdbTooling: async () => ({ ok: true, command: 'adb', source: 'path' }),
            runAdb,
            inputDisplaySize: { widthPx: 1080, heightPx: 1920 },
        });

        await expect(adapter.dispatchAction({
            resource: androidControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'pinch',
                    streamId: 'stream-1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'event-1',
                    centerX: 0.5,
                    centerY: 0.5,
                    startDistance: 0.2,
                    endDistance: 0.5,
                },
            },
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'android_simulator_control_unsupported',
        });
        expect(runAdb).not.toHaveBeenCalled();
    });

    it('keeps scrcpy-control-only gestures unavailable when a sender has no display-size metadata', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const sendScrcpyControl = vi.fn<AndroidScrcpyControlSender>(async () => ({
            ok: true,
            diagnostics: [],
        }));
        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            bridgeAvailable: true,
            sendScrcpyControl,
        });

        await expect(adapter.health()).resolves.toMatchObject({
            status: 'available',
            supportedInputKinds: expect.not.arrayContaining(['pinch', 'rotate']),
        });

        await expect(adapter.dispatchAction({
            resource: androidControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'pinch',
                    streamId: 'stream-1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'event-1',
                    centerX: 0.5,
                    centerY: 0.5,
                    startDistance: 0.2,
                    endDistance: 0.5,
                },
            },
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'android_simulator_control_unsupported',
        });
        expect(sendScrcpyControl).not.toHaveBeenCalled();
    });

    it('requires the current resource to advertise scrcpy-control-only gestures before dispatching them', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const sendScrcpyControl = vi.fn<AndroidScrcpyControlSender>(async () => ({
            ok: true,
            diagnostics: [],
        }));
        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            bridgeAvailable: true,
            sendScrcpyControl,
            inputDisplaySize: { widthPx: 1080, heightPx: 1920 },
        });

        await expect(adapter.dispatchAction({
            resource: androidControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'pinch',
                    streamId: 'stream-1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'event-1',
                    centerX: 0.5,
                    centerY: 0.5,
                    startDistance: 0.2,
                    endDistance: 0.5,
                },
            },
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'android_simulator_control_unsupported',
        });
        expect(sendScrcpyControl).not.toHaveBeenCalled();
    });

    it('advertises and dispatches scrcpy-control-only gestures when a control sender and display size are available', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const sendScrcpyControl = vi.fn<AndroidScrcpyControlSender>(async (control) => ({
            ok: true,
            diagnostics: [{ code: 'sent_via_scrcpy_control', kind: control.kind }],
        }));
        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            bridgeAvailable: true,
            sendScrcpyControl,
            inputDisplaySize: { widthPx: 1080, heightPx: 1920 },
        });
        const androidScrcpyControlResource: SimulatorDeviceResourceV1 = {
            v: 1,
            simulatorId: 'android:emulator:emulator-5554',
            platform: 'android',
            deviceId: 'emulator-5554',
            displayName: 'Pixel 9 API 35',
            capture: {
                status: 'available',
                sourceId: 'simulator:android:emulator-5554:screen',
                supportedCodecs: ['h264.avcc'],
                inputMode: 'exclusive',
                supportedInputKinds: ['tap', 'pinch', 'rotate'],
                streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
            },
        };

        await expect(adapter.health()).resolves.toMatchObject({
            status: 'available',
            supportedInputKinds: expect.arrayContaining(['pinch', 'rotate']),
        });
        await expect(adapter.health()).resolves.not.toMatchObject({
            supportedInputKinds: expect.arrayContaining(['orientation']),
        });

        await expect(adapter.dispatchAction({
            resource: androidScrcpyControlResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'rotate',
                    streamId: 'stream-1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'event-1',
                    centerX: 0.5,
                    centerY: 0.5,
                    radius: 0.3,
                    startAngle: 0,
                    endAngle: 90,
                },
            },
        })).resolves.toEqual({
            v: 1,
            eventType: 'simulator.control.send',
            status: 'accepted',
            diagnostics: [{ code: 'sent_via_scrcpy_control', kind: 'rotate' }],
        });

        expect(sendScrcpyControl).toHaveBeenCalledWith({
            v: 1,
            kind: 'rotate',
            streamId: 'stream-1',
            sourceId: 'simulator:android:emulator-5554:screen',
            eventId: 'event-1',
            centerX: 0.5,
            centerY: 0.5,
            radius: 0.3,
            startAngle: 0,
            endAngle: 90,
        });
    });

    it('adds sender-backed scrcpy controls to discovery-owned Android health', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'available',
                    transport: 'scrcpy-local-sockets-over-pms',
                    physicalDevicesSupported: false,
                    supportedCodecs: ['h264.avcc'],
                    supportedInputKinds: ['tap'],
                    clipboardSyncDefault: 'disabled',
                },
            }),
            sendScrcpyControl: async () => ({ ok: true, diagnostics: [] }),
            inputDisplaySize: { widthPx: 1080, heightPx: 1920 },
        });

        await expect(adapter.health()).resolves.toMatchObject({
            status: 'available',
            supportedInputKinds: expect.arrayContaining(['tap', 'pinch', 'rotate']),
        });
        await expect(adapter.health()).resolves.not.toMatchObject({
            supportedInputKinds: expect.arrayContaining(['orientation']),
        });
    });

    it('filters discovery-owned Android health to input controls the adapter can actually route', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'available',
                    transport: 'scrcpy-local-sockets-over-pms',
                    physicalDevicesSupported: false,
                    supportedCodecs: ['h264.avcc'],
                    supportedInputKinds: ['tap', 'pinch', 'rotate', 'orientation'],
                    clipboardSyncDefault: 'disabled',
                },
            }),
        });

        await expect(adapter.health()).resolves.toMatchObject({
            status: 'available',
            supportedInputKinds: ['tap'],
        });
    });

    it('filters discovery-owned Android resource input controls to controls the adapter can actually route', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [{
                    ...androidControlResource,
                    capture: {
                        ...androidControlResource.capture,
                        supportedInputKinds: ['tap', 'pinch', 'rotate', 'orientation'],
                    },
                }],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'available',
                    transport: 'scrcpy-local-sockets-over-pms',
                    physicalDevicesSupported: false,
                    supportedCodecs: ['h264.avcc'],
                    supportedInputKinds: ['tap', 'pinch', 'rotate', 'orientation'],
                    clipboardSyncDefault: 'disabled',
                },
            }),
        });

        await expect(adapter.listResources()).resolves.toEqual([expect.objectContaining({
            capture: expect.objectContaining({
                supportedInputKinds: ['tap'],
            }),
        })]);
    });

    it('advertises and dispatches scrcpy-only controls only for resources backed by the tunnel owner', async () => {
        const mod = await import('./android').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('createAndroidSimulatorPlatformAdapter');
        if (!('createAndroidSimulatorPlatformAdapter' in mod)) return;

        const sendScrcpyControl = vi.fn<AndroidScrcpyControlSender>(async (control) => ({
            ok: true,
            diagnostics: [{ code: 'sent_via_tunnel_owner', kind: control.kind }],
        }));
        const otherResource: SimulatorDeviceResourceV1 = {
            ...androidControlResource,
            simulatorId: 'android:emulator:emulator-5556',
            deviceId: 'emulator-5556',
            capture: {
                ...androidControlResource.capture,
                sourceId: 'simulator:android:emulator-5556:screen',
            },
        };
        const adapter = mod.createAndroidSimulatorPlatformAdapter({
            discoverResources: async () => ({
                resources: [androidControlResource, otherResource],
                diagnostics: [],
                health: {
                    v: 1,
                    platform: 'android',
                    status: 'available',
                    transport: 'scrcpy-local-sockets-over-pms',
                    physicalDevicesSupported: false,
                    supportedCodecs: ['h264.avcc'],
                    supportedInputKinds: ['tap'],
                    clipboardSyncDefault: 'disabled',
                },
            }),
            resolveScrcpyControl: ({ serial }: { serial: string }) => serial === 'emulator-5554'
                ? {
                    displaySize: { widthPx: 1080, heightPx: 1920 },
                    sendScrcpyControl,
                }
                : null,
        });

        await expect(adapter.listResources()).resolves.toEqual([
            expect.objectContaining({
                deviceId: 'emulator-5554',
                capture: expect.objectContaining({
                    supportedInputKinds: ['tap', 'pinch', 'rotate'],
                }),
            }),
            expect.objectContaining({
                deviceId: 'emulator-5556',
                capture: expect.objectContaining({
                    supportedInputKinds: ['tap'],
                }),
            }),
        ]);

        await expect(adapter.dispatchAction({
            resource: withSupportedInputKinds(androidControlResource, ['tap', 'pinch', 'rotate']),
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'pinch',
                    streamId: 'stream-1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'event-1',
                    centerX: 0.5,
                    centerY: 0.5,
                    startDistance: 0.2,
                    endDistance: 0.5,
                },
            },
        })).resolves.toMatchObject({
            status: 'accepted',
            diagnostics: [{ code: 'sent_via_tunnel_owner', kind: 'pinch' }],
        });

        await expect(adapter.dispatchAction({
            resource: otherResource,
            event: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'pinch',
                    streamId: 'stream-2',
                    sourceId: 'simulator:android:emulator-5556:screen',
                    eventId: 'event-2',
                    centerX: 0.5,
                    centerY: 0.5,
                    startDistance: 0.2,
                    endDistance: 0.5,
                },
            },
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'android_simulator_control_unsupported',
        });
        expect(sendScrcpyControl).toHaveBeenCalledTimes(1);
    });
});
