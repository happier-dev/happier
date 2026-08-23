import { describe, expect, it, vi } from 'vitest';

import {
    ACTION_ID_FAMILIES_V1,
    DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    STATICALLY_UNBACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1,
    classifySimulatorRuntimeActionBackingV1,
    type RuntimeActionExecuteArgs,
    type SimulatorDeviceResourceV1,
    type SimulatorRuntimeActionIdV1,
} from '@happier-dev/protocol';

import type { MachineLiveStreamCaptureStartInput } from '../../../peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from '../../../peer/mediation/stream/captureRegistry';
import { createSimulatorCaptureRegistryReconciler } from '../captureRegistration';
import type { SimulatorDaemonFeatureGate } from '../featureGate';
import { createSimulatorPreviewDaemonRuntime } from '../runtime';

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
        supportedInputKinds: ['tap'],
        streamControls: {
            requestKeyframe: false,
            snapshot: false,
            setQuality: false,
            setFps: false,
            setScale: false,
        },
    },
};

const androidResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'sim_android',
    platform: 'android',
    deviceId: 'emulator-5554',
    displayName: 'Pixel 9',
    capture: {
        status: 'available',
        sourceId: 'simulator:android:emulator-5554:screen',
        supportedCodecs: ['h264.avcc'],
        inputMode: 'exclusive',
        supportedInputKinds: ['tap'],
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

const androidScrcpyControlResource: SimulatorDeviceResourceV1 = {
    ...androidResource,
    capture: {
        status: 'available',
        sourceId: 'simulator:android:emulator-5554:screen',
        supportedCodecs: ['h264.avcc'],
        inputMode: 'exclusive',
        supportedInputKinds: ['tap', 'pinch', 'rotate'],
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

function runtimeArgs(
    args: Omit<RuntimeActionExecuteArgs, 'context'> & Partial<Pick<RuntimeActionExecuteArgs, 'context'>>,
): RuntimeActionExecuteArgs {
    return {
        context: {},
        ...args,
    };
}

// Route-behavior tests below are not exercising the server feature gate; they use an all-enabled
// gate so the (required, fail-closed) gate does not mask the route contract under test.
const allowAllFeatureGate: SimulatorDaemonFeatureGate = {
    isEnabled: () => true,
    refresh: async () => {},
};

describe('daemon simulator runtime action executor', () => {
    // OWNER-GATE closure (mirrors the browser/local-services daemon executors): the server
    // feature gate is required at this execution boundary, and a JavaScript/stale compiled caller
    // that omits it must fail closed for every simulator runtime action before route dispatch.
    it('fails closed for simulator runtime actions when an untyped caller omits the feature gate', async () => {
        const mod = await import('./runtimeActionExecutor');
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            resources: [iosResource],
        });
        const unsafeInput = { routes: runtime.routes };
        // Boundary fixture: deliberately simulates an untyped caller omitting the required gate.
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor(
            unsafeInput as unknown as Parameters<typeof mod.createSimulatorDaemonRuntimeActionExecutor>[0],
        );

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.list',
            input: { type: 'simulator.devices.list' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:feature_disabled:devices.simulatorPreview',
        });
    });

    it('refuses simulator runtime actions at the execution boundary when devices.simulatorPreview is disabled', async () => {
        const mod = await import('./runtimeActionExecutor');
        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.control.send' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            leaseTtlMs: 1_000,
            resources: [iosResource],
            dispatchAction,
        });
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor({
            routes: runtime.routes,
            featureGate: { isEnabled: () => false, refresh: async () => {} },
        });

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.list',
            input: { type: 'simulator.devices.list' },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:feature_disabled:devices.simulatorPreview',
        });
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('maps devices.simulator.list to the daemon simulator snapshot route', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            resources: [iosResource],
        });
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor({ routes: runtime.routes, featureGate: allowAllFeatureGate });

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.list',
            input: { type: 'simulator.devices.list' },
        }))).resolves.toEqual({
            v: 1,
            machineId: 'machine_1',
            generatedAt: 2_000,
            refreshState: 'idle',
            resources: [iosResource],
            diagnostics: [],
        });
    });

    it('maps mutating simulator input through daemon routes so lease enforcement remains authoritative', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.control.send' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            leaseTtlMs: 1_000,
            resources: [iosResource],
            dispatchAction,
        });
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor({ routes: runtime.routes, featureGate: allowAllFeatureGate });

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.input.tap',
            input: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream_1',
                    sourceId: 'source_ios',
                    eventId: 'tap_without_lease',
                    x: 0.5,
                    y: 0.5,
                },
            },
        }))).resolves.toMatchObject({
            v: 1,
            eventType: 'simulator.control.send',
            status: 'rejected',
            reasonCode: 'input_lease_required',
        });
        expect(dispatchAction).not.toHaveBeenCalled();

        const lease = await execute(runtimeArgs({
            actionId: 'devices.simulator.lease.acquire',
            input: {
                type: 'simulator.lease.acquire',
                simulatorId: 'sim_ios',
                streamId: 'stream_1',
                sourceId: 'source_ios',
                viewerId: 'viewer_1',
            },
        }));
        expect(lease).toMatchObject({
            status: 'accepted',
            lease: { leaseId: expect.any(String) },
        });
        const leaseId = (lease as { lease?: { leaseId?: string } }).lease?.leaseId;
        expect(leaseId).toBeTruthy();

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.input.tap',
            input: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: 'stream_1',
                    sourceId: 'source_ios',
                    eventId: 'tap_with_lease',
                    leaseId,
                    x: 0.5,
                    y: 0.5,
                },
            },
        }))).resolves.toMatchObject({
            v: 1,
            eventType: 'simulator.control.send',
            status: 'accepted',
        });
        expect(dispatchAction).toHaveBeenCalledOnce();
    });

    it('rejects Action ID/event and input-control kind mismatches before simulator dispatch', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.control.send' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: {
                getSnapshot: async () => ({
                    v: 1,
                    machineId: 'machine_1',
                    generatedAt: 2_000,
                    refreshState: 'idle',
                    resources: [],
                    diagnostics: [],
                }),
                dispatchAction,
            },
        });
        const tapEvent = {
            type: 'simulator.control.send' as const,
            control: {
                v: 1 as const,
                kind: 'tap' as const,
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'tap_1',
                leaseId: 'lease_1',
                x: 0.5,
                y: 0.5,
            },
        };
        const swipeEvent = {
            type: 'simulator.control.send' as const,
            control: {
                v: 1 as const,
                kind: 'swipe' as const,
                streamId: 'stream_1',
                sourceId: 'source_1',
                eventId: 'swipe_1',
                leaseId: 'lease_1',
                fromX: 0.1,
                fromY: 0.1,
                toX: 0.9,
                toY: 0.9,
            },
        };

        for (const args of [
            runtimeArgs({ actionId: 'devices.simulator.lease.acquire', input: tapEvent }),
            runtimeArgs({ actionId: 'devices.simulator.sideband.request', input: tapEvent }),
            runtimeArgs({ actionId: 'devices.simulator.input.tap', input: swipeEvent }),
        ]) {
            await expect(execute(args)).resolves.toEqual({
                ok: false,
                errorCode: 'invalid_parameters',
                error: 'invalid_parameters',
            });
        }
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('keeps fps scalar actions and scale fail-closed until stream producers own them', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.quality.set' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources: [iosResource],
            dispatchAction,
        });
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: runtime.routes,
            createEventId: () => 'fps_event',
        });

        const disabledResult = {
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:simulator_runtime_action_unbacked',
        };

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.stream.fps.set',
            input: {
                simulatorId: 'sim_ios',
                streamId: 'stream_1',
                sourceId: 'source_ios',
                value: 12,
            },
        }))).resolves.toEqual(disabledResult);

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.stream.scale.set',
            input: {
                simulatorId: 'sim_ios',
                streamId: 'stream_1',
                sourceId: 'source_ios',
                value: 0.5,
            },
        }))).resolves.toEqual(disabledResult);
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('retires public stream open/close through the daemon owner (server_relay owns live capture)', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const registry = createMachineLiveStreamCaptureRegistry();
        const startCapture = vi.fn(async (input: MachineLiveStreamCaptureStartInput) => ({
            ok: true as const,
            session: { stop: vi.fn() },
        }));
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            resources: [androidResource],
            captureReconciler: createSimulatorCaptureRegistryReconciler({
                registry,
                createAdapter: () => ({ start: startCapture }),
            }),
        });
        await expect(runtime.routes.dispatchAction({
            type: 'simulator.stream.open',
            simulatorId: 'sim_android',
            sourceId: 'simulator:android:emulator-5554:screen',
        })).resolves.toEqual({
            v: 1,
            eventType: 'simulator.stream.open',
            status: 'unavailable',
            reasonCode: 'simulator_stream_server_relay_only',
            diagnostics: [],
        });

        await expect(runtime.routes.dispatchAction({
            type: 'simulator.stream.close',
            simulatorId: 'sim_android',
            streamId: 'stream_android_1',
        })).resolves.toEqual({
            v: 1,
            eventType: 'simulator.stream.close',
            status: 'unavailable',
            reasonCode: 'simulator_stream_server_relay_only',
            diagnostics: [],
        });
        // The retired loopback transport never starts live capture behind the relay terminator.
        expect(startCapture).not.toHaveBeenCalled();
    });

    it('routes scrcpy-only Android pinch actions only when the route resource advertises them', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const disabledResult = {
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:simulator_runtime_action_unbacked',
        };
        const dispatchWithoutAdvertisedControl = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.control.send' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtimeWithoutAdvertisedControl = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources: [androidResource],
            dispatchAction: dispatchWithoutAdvertisedControl,
        });
        const executeWithoutAdvertisedControl = mod.createSimulatorDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: runtimeWithoutAdvertisedControl.routes,
        });

        await expect(executeWithoutAdvertisedControl(runtimeArgs({
            actionId: 'devices.simulator.input.pinch',
            input: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'pinch',
                    streamId: 'stream_1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'pinch_unadvertised',
                    leaseId: 'lease_1',
                    centerX: 0.5,
                    centerY: 0.5,
                    startDistance: 0.2,
                    endDistance: 0.5,
                },
            },
        }))).resolves.toEqual(disabledResult);
        expect(dispatchWithoutAdvertisedControl).not.toHaveBeenCalled();

        const dispatchWithAdvertisedControl = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.control.send' as const,
            status: 'accepted' as const,
            diagnostics: [{ code: 'sent_via_scrcpy_control' }],
        }));
        const runtimeWithAdvertisedControl = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            leaseTtlMs: 1_000,
            resources: [androidScrcpyControlResource],
            dispatchAction: dispatchWithAdvertisedControl,
        });
        const executeWithAdvertisedControl = mod.createSimulatorDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: runtimeWithAdvertisedControl.routes,
        });

        const lease = await executeWithAdvertisedControl(runtimeArgs({
            actionId: 'devices.simulator.lease.acquire',
            input: {
                type: 'simulator.lease.acquire',
                simulatorId: 'sim_android',
                streamId: 'stream_1',
                sourceId: 'simulator:android:emulator-5554:screen',
                viewerId: 'viewer_1',
            },
        }));
        const leaseId = (lease as { lease?: { leaseId?: string } }).lease?.leaseId;
        expect(leaseId).toBeTruthy();

        await expect(executeWithAdvertisedControl(runtimeArgs({
            actionId: 'devices.simulator.input.pinch',
            input: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'pinch',
                    streamId: 'stream_1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'pinch_advertised',
                    leaseId,
                    centerX: 0.5,
                    centerY: 0.5,
                    startDistance: 0.2,
                    endDistance: 0.5,
                },
            },
        }))).resolves.toMatchObject({
            v: 1,
            eventType: 'simulator.control.send',
            status: 'accepted',
        });
        expect(dispatchWithAdvertisedControl).toHaveBeenCalledOnce();
    });

    it('keeps unbacked stream controls and native-only input actions disabled at the public action boundary', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.quality.set' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources: [iosResource],
            dispatchAction,
        });
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: runtime.routes,
            createEventId: () => 'fps_event',
        });

        const disabledResult = {
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:simulator_runtime_action_unbacked',
        };

        const unbackedStreamActions: readonly RuntimeActionExecuteArgs[] = [
            runtimeArgs({
                actionId: 'devices.simulator.stream.keyframe',
                input: {
                    type: 'simulator.keyframe.request',
                    simulatorId: 'sim_ios',
                    streamId: 'stream_1',
                    sourceId: 'source_ios',
                    control: {
                        v: 1,
                        kind: 'request_keyframe',
                        streamId: 'stream_1',
                        sourceId: 'source_ios',
                        eventId: 'keyframe_1',
                    },
                },
            }),
            runtimeArgs({
                actionId: 'devices.simulator.stream.snapshot',
                input: {
                    type: 'simulator.snapshot.request',
                    simulatorId: 'sim_ios',
                    streamId: 'stream_1',
                    sourceId: 'source_ios',
                    eventId: 'snapshot_1',
                },
            }),
            runtimeArgs({
                actionId: 'devices.simulator.stream.quality.set',
                input: {
                    type: 'simulator.quality.set',
                    simulatorId: 'sim_ios',
                    streamId: 'stream_1',
                    sourceId: 'source_ios',
                    control: {
                        v: 1,
                        kind: 'set_quality',
                        streamId: 'stream_1',
                        sourceId: 'source_ios',
                        eventId: 'quality_1',
                        maxFramesPerSecond: 24,
                    },
                },
            }),
            runtimeArgs({
                actionId: 'devices.simulator.stream.fps.set',
                input: {
                    simulatorId: 'sim_ios',
                    streamId: 'stream_1',
                    sourceId: 'source_ios',
                    value: 12,
                },
            }),
            runtimeArgs({
                actionId: 'devices.simulator.stream.scale.set',
                input: {
                    simulatorId: 'sim_ios',
                    streamId: 'stream_1',
                    sourceId: 'source_ios',
                    value: 0.5,
                },
            }),
        ];

        for (const args of unbackedStreamActions) {
            await expect(execute(args)).resolves.toEqual(disabledResult);
        }
        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.input.orientation',
            input: {
                type: 'simulator.control.send',
                control: {
                    v: 1,
                    kind: 'orientation',
                    streamId: 'stream_1',
                    sourceId: 'source_ios',
                    eventId: 'orientation_1',
                    leaseId: 'lease_1',
                    orientation: 'landscapeLeft',
                },
            },
        }))).resolves.toEqual(disabledResult);

        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('routes an advertised encoder stream control through to live dispatch instead of failing closed at the prefilter (A1)', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const androidKeyframeResource: SimulatorDeviceResourceV1 = {
            ...androidResource,
            capture: {
                status: 'available',
                sourceId: 'simulator:android:emulator-5554:screen',
                supportedCodecs: ['h264.avcc'],
                inputMode: 'exclusive',
                supportedInputKinds: ['tap'],
                streamControls: {
                    requestKeyframe: true,
                    snapshot: false,
                    setQuality: false,
                    setFps: false,
                    setScale: false,
                },
            },
        };
        // The wired bridge hook: a non-null dispatchStreamControl that accepts the forwarded control.
        const dispatchStreamControl = vi.fn(() => ({ ok: true as const }));
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            resources: [androidKeyframeResource],
            dispatchStreamControl,
        });
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor({ routes: runtime.routes, featureGate: allowAllFeatureGate });

        const result = await execute(runtimeArgs({
            actionId: 'devices.simulator.stream.keyframe',
            input: {
                type: 'simulator.keyframe.request',
                simulatorId: 'sim_android',
                streamId: 'stream_1',
                sourceId: 'simulator:android:emulator-5554:screen',
                control: {
                    v: 1,
                    kind: 'request_keyframe',
                    streamId: 'stream_1',
                    sourceId: 'simulator:android:emulator-5554:screen',
                    eventId: 'keyframe_advertised',
                },
            },
        }));

        // The prefilter no longer short-circuits an advertised encoder control as unbacked; it
        // reaches the runtime, which dispatches over the wired bridge.
        expect(result).toMatchObject({ v: 1, eventType: 'simulator.keyframe.request', status: 'accepted' });
        expect(result).not.toMatchObject({ errorCode: 'runtime_action_disabled' });
        expect(dispatchStreamControl).toHaveBeenCalledOnce();
    });

    it('folds advertised fps.set / scale.set scalars into one set_quality sideband and dispatches them (X3)', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const androidEncoderResource: SimulatorDeviceResourceV1 = {
            ...androidResource,
            capture: {
                status: 'available',
                sourceId: 'simulator:android:emulator-5554:screen',
                supportedCodecs: ['h264.avcc'],
                inputMode: 'exclusive',
                supportedInputKinds: ['tap'],
                streamControls: {
                    requestKeyframe: true,
                    snapshot: true,
                    setQuality: true,
                    setFps: true,
                    setScale: true,
                },
            },
        };
        const dispatchStreamControl = vi.fn(() => ({ ok: true as const }));
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            resources: [androidEncoderResource],
            dispatchStreamControl,
        });
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: runtime.routes,
            createEventId: () => 'translated_quality',
        });

        const fpsResult = await execute(runtimeArgs({
            actionId: 'devices.simulator.stream.fps.set',
            input: {
                simulatorId: 'sim_android',
                streamId: 'stream_1',
                sourceId: 'simulator:android:emulator-5554:screen',
                value: 24,
            },
        }));
        expect(fpsResult).toMatchObject({ v: 1, eventType: 'simulator.quality.set', status: 'accepted' });
        expect(fpsResult).not.toMatchObject({ errorCode: 'runtime_action_disabled' });

        const scaleResult = await execute(runtimeArgs({
            actionId: 'devices.simulator.stream.scale.set',
            input: {
                simulatorId: 'sim_android',
                streamId: 'stream_1',
                sourceId: 'simulator:android:emulator-5554:screen',
                value: 720,
            },
        }));
        expect(scaleResult).toMatchObject({ v: 1, eventType: 'simulator.quality.set', status: 'accepted' });

        expect(dispatchStreamControl).toHaveBeenCalledTimes(2);
        expect(dispatchStreamControl).toHaveBeenNthCalledWith(1, expect.objectContaining({
            kind: 'set_quality',
            streamId: 'stream_1',
            sourceId: 'simulator:android:emulator-5554:screen',
            maxFramesPerSecond: 24,
        }));
        expect(dispatchStreamControl).toHaveBeenNthCalledWith(2, expect.objectContaining({
            kind: 'set_quality',
            maxWidth: 720,
            maxHeight: 720,
        }));
    });

    it('keeps non-produced sideband runtime actions disabled without hitting simulator dispatch', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.sideband.request' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources: [iosResource],
            dispatchAction,
        });
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor({ routes: runtime.routes, featureGate: allowAllFeatureGate });

        await expect(execute(runtimeArgs({
            actionId: 'devices.simulator.sideband.request',
            input: {
                type: 'simulator.sideband.request',
                simulatorId: 'sim_ios',
                kind: 'logs',
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:simulator_sideband_unbacked',
        });
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('drives the unbacked verdict from the shared classifier so the daemon and protocol cannot drift', async () => {
        const mod = await import('./runtimeActionExecutor').catch(() => null);

        expect(mod?.createSimulatorDaemonRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createSimulatorDaemonRuntimeActionExecutor) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.control.send' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources: [iosResource],
            dispatchAction,
        });
        const execute = mod.createSimulatorDaemonRuntimeActionExecutor({
            featureGate: allowAllFeatureGate,
            routes: runtime.routes,
            createEventId: () => 'event_1',
        });

        const disabledResult = {
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:devices.simulator:simulator_runtime_action_unbacked',
        };

        const inputForUnbackedId = (id: SimulatorRuntimeActionIdV1): unknown => {
            switch (id) {
                case 'devices.simulator.stream.keyframe':
                    return {
                        type: 'simulator.keyframe.request',
                        simulatorId: 'sim_ios',
                        streamId: 'stream_1',
                        sourceId: 'source_ios',
                        control: {
                            v: 1, kind: 'request_keyframe', streamId: 'stream_1',
                            sourceId: 'source_ios', eventId: 'k1',
                        },
                    };
                case 'devices.simulator.stream.snapshot':
                    return {
                        type: 'simulator.snapshot.request', simulatorId: 'sim_ios',
                        streamId: 'stream_1', sourceId: 'source_ios', eventId: 's1',
                    };
                case 'devices.simulator.stream.quality.set':
                    return {
                        type: 'simulator.quality.set', simulatorId: 'sim_ios', streamId: 'stream_1',
                        sourceId: 'source_ios',
                        control: {
                            v: 1, kind: 'set_quality', streamId: 'stream_1', sourceId: 'source_ios',
                            eventId: 'q1', maxFramesPerSecond: 24,
                        },
                    };
                case 'devices.simulator.stream.fps.set':
                    return { simulatorId: 'sim_ios', streamId: 'stream_1', sourceId: 'source_ios', value: 12 };
                case 'devices.simulator.stream.scale.set':
                    return { simulatorId: 'sim_ios', streamId: 'stream_1', sourceId: 'source_ios', value: 0.5 };
                case 'devices.simulator.input.orientation':
                    return {
                        type: 'simulator.control.send',
                        control: {
                            v: 1, kind: 'orientation', streamId: 'stream_1', sourceId: 'source_ios',
                            eventId: 'o1', leaseId: 'lease_1', orientation: 'landscapeLeft',
                        },
                    };
                default:
                    return {};
            }
        };

        const unbackedIds = ACTION_ID_FAMILIES_V1.devices_simulator.filter(
            (id) => classifySimulatorRuntimeActionBackingV1(id) === 'statically-unbacked',
        );
        // The set the daemon must deny is exactly the classifier's statically-unbacked set.
        expect(new Set(unbackedIds)).toEqual(STATICALLY_UNBACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1);

        for (const id of unbackedIds) {
            await expect(execute(runtimeArgs({ actionId: id, input: inputForUnbackedId(id) })))
                .resolves.toEqual(disabledResult);
        }
        expect(dispatchAction).not.toHaveBeenCalled();
    });
});
