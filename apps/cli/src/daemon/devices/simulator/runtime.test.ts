import { describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    type SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';

import {
    unavailableMachineLiveStreamCaptureAdapter,
} from '../../peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import { createSimulatorCaptureRegistryReconciler } from './captureRegistration';

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
    deviceId: 'device_android',
    displayName: 'Pixel 9',
    capture: {
        status: 'unavailable',
        sourceId: 'source_android',
        reasonCode: 'android_emulator_bridge_unavailable',
    },
};

const androidStreamResource = {
    v: 1,
    simulatorId: 'sim_android_stream',
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
} satisfies SimulatorDeviceResourceV1;

describe('daemon simulator preview runtime', () => {
    it('serves a sorted daemon-owned simulator snapshot', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            resources: [iosResource, androidResource],
        });

        await expect(runtime.routes.getSnapshot()).resolves.toEqual({
            v: 1,
            machineId: 'machine_1',
            generatedAt: 2_000,
            refreshState: 'idle',
            resources: [androidResource, iosResource],
            diagnostics: [],
        });
    });

    it('keeps backed stream controls in daemon-visible snapshots while stripping absolute orientation input', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const resourceWithBackedControls: SimulatorDeviceResourceV1 = {
            ...androidStreamResource,
            capture: {
                ...androidStreamResource.capture,
                supportedInputKinds: ['tap', 'orientation', 'pinch', 'rotate'],
                streamControls: {
                    requestKeyframe: true,
                    snapshot: true,
                    setQuality: true,
                    setFps: true,
                    setScale: true,
                },
            },
        };
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            resources: [resourceWithBackedControls],
        });

        await expect(runtime.snapshot()).resolves.toMatchObject({
            resources: [
                {
                    capture: {
                        // Absolute orientation has no scrcpy producer path → still stripped.
                        supportedInputKinds: ['tap', 'pinch', 'rotate'],
                        // The server-restart producer backs every stream control → advertised bits survive.
                        streamControls: {
                            requestKeyframe: true,
                            snapshot: true,
                            setQuality: true,
                            setFps: true,
                            setScale: true,
                        },
                    },
                },
            ],
        });
    });

    it('accepts encoder-control RPCs when the live resource advertises the control (resource-gated backing)', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const backedResource: SimulatorDeviceResourceV1 = {
            ...androidStreamResource,
            capture: {
                ...androidStreamResource.capture,
                streamControls: {
                    requestKeyframe: true,
                    snapshot: true,
                    setQuality: true,
                    setFps: true,
                    setScale: true,
                },
            },
        };
        const dispatchStreamControl = vi.fn(async () => ({ ok: true as const }));
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources: [backedResource],
            dispatchStreamControl,
        });
        const backedSourceId = androidStreamResource.capture.sourceId;

        const keyframeResult = await runtime.routes.dispatchAction({
            type: 'simulator.keyframe.request',
            simulatorId: backedResource.simulatorId,
            streamId: 'stream_1',
            sourceId: backedSourceId,
            control: {
                v: 1,
                streamId: 'stream_1',
                sourceId: backedSourceId,
                eventId: 'keyframe_1',
                kind: 'request_keyframe',
            },
        });
        expect(keyframeResult).toMatchObject({ status: 'accepted', eventType: 'simulator.keyframe.request' });
        expect(dispatchStreamControl).toHaveBeenCalledTimes(1);
    });

    it('reports encoder-control RPCs unavailable when the resource does not advertise the control', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const dispatchStreamControl = vi.fn(async () => ({ ok: true as const }));
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources: [iosResource],
            dispatchStreamControl,
        });

        const result = await runtime.routes.dispatchAction({
            type: 'simulator.snapshot.request',
            simulatorId: 'sim_ios',
            streamId: 'stream_1',
            sourceId: 'source_ios',
            eventId: 'snapshot_1',
        });
        expect(result).toMatchObject({
            status: 'unavailable',
            reasonCode: 'simulator_stream_control_unbacked',
        });
        expect(dispatchStreamControl).not.toHaveBeenCalled();
    });

    it('includes daemon platform diagnostics even when no simulator resources are available', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            resources: [],
            listDiagnostics: () => [{
                platform: 'ios',
                reasonCode: 'ios_private_helper_unavailable',
                severity: 'error',
            }],
        });

        await expect(runtime.routes.getSnapshot()).resolves.toMatchObject({
            v: 1,
            machineId: 'machine_1',
            generatedAt: 2_000,
            refreshState: 'idle',
            resources: [],
            diagnostics: [{
                platform: 'ios',
                reasonCode: 'ios_private_helper_unavailable',
                severity: 'error',
            }],
        });
    });

    it('handles lease actions locally and delegates native control actions through a single adapter seam', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.sideband.request' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            leaseTtlMs: 1_000,
            resources: [iosResource],
            dispatchAction,
        });

        const acquired = await runtime.routes.dispatchAction({
            type: 'simulator.lease.acquire',
            simulatorId: 'sim_ios',
            streamId: 'stream_1',
            sourceId: 'source_ios',
            viewerId: 'viewer_1',
        });
        expect(acquired).toMatchObject({
            v: 1,
            eventType: 'simulator.lease.acquire',
            status: 'accepted',
            lease: {
                streamId: 'stream_1',
                sourceId: 'source_ios',
                holderId: 'viewer_1',
                expiresAtMs: 3_000,
            },
        });

        await expect(runtime.routes.dispatchAction({
            type: 'simulator.sideband.request',
            simulatorId: 'sim_ios',
            kind: 'capture_health',
        })).resolves.toMatchObject({
            v: 1,
            eventType: 'simulator.sideband.request',
            status: 'accepted',
        });
        expect(dispatchAction).toHaveBeenCalledWith({
            event: {
                type: 'simulator.sideband.request',
                simulatorId: 'sim_ios',
                kind: 'capture_health',
            },
            resources: [iosResource],
        });
    });

    it('can be driven by one composed adapter and stops adapter resources once', async () => {
        const [runtimeMod, adapterMod] = await Promise.all([
            import('./runtime').catch(() => null),
            import('./adapter').catch(() => null),
        ]);

        expect(runtimeMod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        expect(adapterMod?.createSimulatorPreviewDaemonAdapter).toBeTypeOf('function');
        if (!runtimeMod?.createSimulatorPreviewDaemonRuntime || !adapterMod?.createSimulatorPreviewDaemonAdapter) return;

        const stop = vi.fn(async () => {});
        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.sideband.request' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const adapter = adapterMod.createSimulatorPreviewDaemonAdapter({
            listResources: () => [iosResource],
            listDiagnostics: () => [{
                platform: 'ios',
                reasonCode: 'helper_artifact_missing',
                severity: 'error',
            }],
            dispatchAction,
            stop,
        });
        const runtime = runtimeMod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            adapter,
        });

        await expect(runtime.snapshot()).resolves.toMatchObject({
            resources: [iosResource],
            diagnostics: [{
                platform: 'ios',
                reasonCode: 'helper_artifact_missing',
                severity: 'error',
            }],
        });
        await expect(runtime.routes.dispatchAction({
            type: 'simulator.sideband.request',
            simulatorId: 'sim_ios',
            kind: 'capture_health',
        })).resolves.toMatchObject({
            status: 'accepted',
        });
        expect(dispatchAction).toHaveBeenCalledWith({
            event: {
                type: 'simulator.sideband.request',
                simulatorId: 'sim_ios',
                kind: 'capture_health',
            },
            resources: [iosResource],
        });

        await runtime.stop();
        await runtime.stop();
        expect(stop).toHaveBeenCalledOnce();
    });

    it('reconciles simulator capture sources into the PMS registry during refresh and stop', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const registry = createMachineLiveStreamCaptureRegistry();
        const captureReconciler = createSimulatorCaptureRegistryReconciler({
            registry,
            createAdapter: () => unavailableMachineLiveStreamCaptureAdapter,
        });
        let resources: readonly SimulatorDeviceResourceV1[] = [iosResource];
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources,
            listResources: () => resources,
            captureReconciler,
        });

        await runtime.snapshot();
        expect(registry.resolve({ streamFamily: 'source_ios' })).toMatchObject({
            ok: true,
            source: {
                sourceId: 'source_ios',
                capabilities: {
                    sourceKind: 'simulator',
                    supportedCodecs: ['image.mjpeg'],
                    health: { status: 'available' },
                },
            },
        });

        resources = [androidResource];
        await runtime.snapshot();
        expect(registry.resolve({ sourceId: 'source_ios' })).toMatchObject({
            ok: false,
            diagnostic: { reasonCode: 'capture_source_unavailable' },
        });

        resources = [iosResource];
        await runtime.snapshot();
        await runtime.stop();
        expect(registry.resolve({ sourceId: 'source_ios' })).toMatchObject({
            ok: false,
            diagnostic: { reasonCode: 'capture_source_unavailable' },
        });
    });

    it('turns resource reader failures into snapshot diagnostics', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            listResources: () => {
                throw new Error('xcrun failed');
            },
            listDiagnostics: () => [{
                platform: 'ios',
                reasonCode: 'ios_private_helper_unavailable',
            }],
        });

        await expect(runtime.snapshot()).resolves.toEqual({
            v: 1,
            machineId: 'machine_1',
            generatedAt: 2_000,
            refreshState: 'idle',
            resources: [],
            diagnostics: [
                {
                    code: 'simulator_resources_unavailable',
                    errorName: 'Error',
                },
                {
                    platform: 'ios',
                    reasonCode: 'ios_private_helper_unavailable',
                },
            ],
        });
    });

    it('rejects exclusive input controls without a matching active lease before adapter dispatch', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.control.send' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            leaseTtlMs: 1_000,
            resources: [iosResource],
            dispatchAction,
        });

        await expect(runtime.routes.dispatchAction({
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
        })).resolves.toMatchObject({
            v: 1,
            eventType: 'simulator.control.send',
            status: 'rejected',
            reasonCode: 'input_lease_required',
        });
        expect(dispatchAction).not.toHaveBeenCalled();

        const leaseResult = await runtime.routes.dispatchAction({
            type: 'simulator.lease.acquire',
            simulatorId: 'sim_ios',
            streamId: 'stream_1',
            sourceId: 'source_ios',
            viewerId: 'viewer_1',
        });
        expect(leaseResult.status).toBe('accepted');
        if (leaseResult.status !== 'accepted' || !leaseResult.lease) {
            throw new Error('expected accepted lease');
        }

        await expect(runtime.routes.dispatchAction({
            type: 'simulator.control.send',
            control: {
                v: 1,
                kind: 'tap',
                streamId: 'stream_1',
                sourceId: 'source_ios',
                eventId: 'tap_2',
                leaseId: leaseResult.lease.leaseId,
                x: 0.5,
                y: 0.5,
            },
        })).resolves.toMatchObject({
            v: 1,
            eventType: 'simulator.control.send',
            status: 'accepted',
        });
        expect(dispatchAction).toHaveBeenCalledTimes(1);
    });

    it('rejects shared input controls without a matching active lease before adapter dispatch', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.control.send' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const sharedAndroidResource: SimulatorDeviceResourceV1 = {
            v: 1,
            simulatorId: 'sim_android',
            platform: 'android',
            deviceId: 'emulator-5554',
            displayName: 'Pixel 9',
            capture: {
                status: 'available',
                sourceId: 'source_android',
                supportedCodecs: ['h264.avcc'],
                inputMode: 'shared',
                streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
            },
        };
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            leaseTtlMs: 1_000,
            resources: [sharedAndroidResource],
            dispatchAction,
        });

        await expect(runtime.routes.dispatchAction({
            type: 'simulator.control.send',
            control: {
                v: 1,
                kind: 'tap',
                streamId: 'stream_android',
                sourceId: 'source_android',
                eventId: 'tap_1',
                x: 0.5,
                y: 0.5,
            },
        })).resolves.toMatchObject({
            v: 1,
            eventType: 'simulator.control.send',
            status: 'rejected',
            reasonCode: 'input_lease_required',
        });
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('rejects lease release events that do not match the active stream and source', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.control.send' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            leaseTtlMs: 1_000,
            resources: [iosResource],
            dispatchAction,
        });

        const leaseResult = await runtime.routes.dispatchAction({
            type: 'simulator.lease.acquire',
            simulatorId: 'sim_ios',
            streamId: 'stream_1',
            sourceId: 'source_ios',
            viewerId: 'viewer_1',
        });
        expect(leaseResult.status).toBe('accepted');
        if (leaseResult.status !== 'accepted' || !leaseResult.lease) {
            throw new Error('expected accepted lease');
        }

        await expect(runtime.routes.dispatchAction({
            type: 'simulator.lease.release',
            simulatorId: 'sim_ios',
            streamId: 'stream_other',
            sourceId: 'source_ios',
            leaseId: leaseResult.lease.leaseId,
        })).resolves.toMatchObject({
            v: 1,
            eventType: 'simulator.lease.release',
            status: 'rejected',
            reasonCode: 'input_lease_mismatch',
        });

        await expect(runtime.routes.dispatchAction({
            type: 'simulator.control.send',
            control: {
                v: 1,
                kind: 'tap',
                streamId: 'stream_1',
                sourceId: 'source_ios',
                eventId: 'tap_after_rejected_release',
                leaseId: leaseResult.lease.leaseId,
                x: 0.5,
                y: 0.5,
            },
        })).resolves.toMatchObject({
            v: 1,
            eventType: 'simulator.control.send',
            status: 'accepted',
        });
        expect(dispatchAction).toHaveBeenCalledOnce();
    });

    it('rejects lease acquisition for sources that do not support input', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const watchOnlyResource: SimulatorDeviceResourceV1 = {
            v: 1,
            simulatorId: 'sim_watch_only',
            platform: 'ios',
            deviceId: 'device_watch_only',
            displayName: 'Watch-only Simulator',
            capture: {
                status: 'available',
                sourceId: 'source_watch_only',
                supportedCodecs: ['image.mjpeg'],
                inputMode: 'none',
                streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
            },
        };
        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.control.send' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            now: () => 2_000,
            resources: [watchOnlyResource],
            dispatchAction,
        });

        await expect(runtime.routes.dispatchAction({
            type: 'simulator.lease.acquire',
            simulatorId: 'sim_watch_only',
            streamId: 'stream_watch_only',
            sourceId: 'source_watch_only',
            viewerId: 'viewer_1',
        })).resolves.toMatchObject({
            v: 1,
            eventType: 'simulator.lease.acquire',
            status: 'rejected',
            reasonCode: 'input_not_supported',
        });
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('retires the daemon-local loopback stream open/close RPC (server_relay owns live capture)', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const startCapture = vi.fn(async () => ({ ok: true as const, session: { stop: vi.fn() } }));
        const registry = createMachineLiveStreamCaptureRegistry();
        const captureReconciler = createSimulatorCaptureRegistryReconciler({
            registry,
            createAdapter: () => ({ start: startCapture }),
        });
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources: [androidStreamResource],
            captureReconciler,
        });

        await expect(runtime.routes.dispatchAction({
            type: 'simulator.stream.open',
            simulatorId: 'sim_android_stream',
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
            simulatorId: 'sim_android_stream',
            streamId: 'stream_android_1',
        })).resolves.toEqual({
            v: 1,
            eventType: 'simulator.stream.close',
            status: 'unavailable',
            reasonCode: 'simulator_stream_server_relay_only',
            diagnostics: [],
        });
        // Live capture is never started behind the relay terminator via this retired RPC.
        expect(startCapture).not.toHaveBeenCalled();
    });

    it('returns stable unavailable results for unbacked stream controls without delegating to platform input dispatch', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.stream.open' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources: [iosResource],
            dispatchAction,
        });

        await expect(runtime.routes.dispatchAction({
            type: 'simulator.snapshot.request',
            simulatorId: 'sim_ios',
            streamId: 'stream_1',
            sourceId: 'source_ios',
            eventId: 'snapshot_1',
        })).resolves.toEqual({
            v: 1,
            eventType: 'simulator.snapshot.request',
            status: 'unavailable',
            reasonCode: 'simulator_stream_control_unbacked',
            diagnostics: [],
        });
        expect(dispatchAction).not.toHaveBeenCalled();
    });

    it('returns stable unavailable results for non-produced sidebands without delegating to platform dispatch', async () => {
        const mod = await import('./runtime').catch(() => null);

        expect(mod?.createSimulatorPreviewDaemonRuntime).toBeTypeOf('function');
        if (!mod?.createSimulatorPreviewDaemonRuntime) return;

        const dispatchAction = vi.fn(async () => ({
            v: 1 as const,
            eventType: 'simulator.sideband.request' as const,
            status: 'accepted' as const,
            diagnostics: [],
        }));
        const runtime = mod.createSimulatorPreviewDaemonRuntime({
            machineId: 'machine_1',
            resources: [iosResource],
            dispatchAction,
        });

        await expect(runtime.routes.dispatchAction({
            type: 'simulator.sideband.request',
            simulatorId: 'sim_ios',
            kind: 'logs',
        })).resolves.toEqual({
            v: 1,
            eventType: 'simulator.sideband.request',
            status: 'unavailable',
            reasonCode: 'simulator_sideband_unbacked',
            diagnostics: [],
        });
        expect(dispatchAction).not.toHaveBeenCalled();
    });
});
