import { describe, expect, it, vi } from 'vitest';

import { unavailableMachineLiveStreamCaptureAdapter } from '../../peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import { DEFAULT_SIMULATOR_STREAM_CONTROLS_V1, type SimulatorDeviceResourceV1 } from '@happier-dev/protocol';

const availableIosResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'A1B2-C3D4',
    platform: 'ios',
    deviceId: 'A1B2-C3D4',
    displayName: 'iPhone 16 Pro',
    capture: {
        status: 'available',
        sourceId: 'ios-simulator:A1B2-C3D4:screen',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
    },
};

const unavailableIosResource: SimulatorDeviceResourceV1 = {
    ...availableIosResource,
    capture: {
        status: 'unavailable',
        sourceId: 'ios-simulator:A1B2-C3D4:screen',
        reasonCode: 'helper_artifact_missing',
    },
    unavailableReason: 'helper_artifact_missing',
};

describe('createSimulatorCaptureRegistryReconciler', () => {
    it('registers available simulator resources as PMS capture sources keyed by source id', async () => {
        const mod = await import('./captureRegistration').catch(() => null);

        expect(mod?.createSimulatorCaptureRegistryReconciler).toBeTypeOf('function');
        if (!mod?.createSimulatorCaptureRegistryReconciler) return;

        const registry = createMachineLiveStreamCaptureRegistry();
        const reconciler = mod.createSimulatorCaptureRegistryReconciler({
            registry,
            createAdapter: () => unavailableMachineLiveStreamCaptureAdapter,
        });

        expect(reconciler.reconcile([availableIosResource])).toEqual({
            registered: ['ios-simulator:A1B2-C3D4:screen'],
            unregistered: [],
            diagnostics: [],
        });
        expect(registry.resolve({ streamFamily: 'ios-simulator:A1B2-C3D4:screen' })).toMatchObject({
            ok: true,
            source: {
                sourceId: 'ios-simulator:A1B2-C3D4:screen',
                streamFamily: 'ios-simulator:A1B2-C3D4:screen',
                capabilities: {
                    sourceKind: 'simulator',
                    supportedCodecs: ['image.mjpeg'],
                    inputMode: 'exclusive',
                    sidebands: ['capture_health'],
                    health: { status: 'available' },
                },
            },
        });
    });

    it('unregisters stale or unavailable simulator capture sources', async () => {
        const mod = await import('./captureRegistration').catch(() => null);

        expect(mod?.createSimulatorCaptureRegistryReconciler).toBeTypeOf('function');
        if (!mod?.createSimulatorCaptureRegistryReconciler) return;

        const registry = createMachineLiveStreamCaptureRegistry();
        const reconciler = mod.createSimulatorCaptureRegistryReconciler({
            registry,
            createAdapter: () => unavailableMachineLiveStreamCaptureAdapter,
        });

        reconciler.reconcile([availableIosResource]);
        expect(reconciler.reconcile([unavailableIosResource])).toEqual({
            registered: [],
            unregistered: ['ios-simulator:A1B2-C3D4:screen'],
            diagnostics: [],
        });
        expect(registry.resolve({ sourceId: 'ios-simulator:A1B2-C3D4:screen' })).toMatchObject({
            ok: false,
            diagnostic: { reasonCode: 'capture_source_unavailable' },
        });
    });

    it('fails closed when a platform adapter cannot be created for an available resource', async () => {
        const mod = await import('./captureRegistration').catch(() => null);

        expect(mod?.createSimulatorCaptureRegistryReconciler).toBeTypeOf('function');
        if (!mod?.createSimulatorCaptureRegistryReconciler) return;

        const registry = createMachineLiveStreamCaptureRegistry();
        const createAdapter = vi.fn(() => {
            throw new Error('missing platform handle');
        });
        const reconciler = mod.createSimulatorCaptureRegistryReconciler({
            registry,
            createAdapter,
        });

        expect(reconciler.reconcile([availableIosResource])).toEqual({
            registered: [],
            unregistered: [],
            diagnostics: [expect.objectContaining({
                reasonCode: 'simulator_capture_adapter_unavailable',
                sourceId: 'ios-simulator:A1B2-C3D4:screen',
            })],
        });
        expect(registry.list()).toEqual([]);
    });

    it('unregisters a previously registered source when its replacement adapter cannot be created', async () => {
        const mod = await import('./captureRegistration').catch(() => null);

        expect(mod?.createSimulatorCaptureRegistryReconciler).toBeTypeOf('function');
        if (!mod?.createSimulatorCaptureRegistryReconciler) return;

        const registry = createMachineLiveStreamCaptureRegistry();
        let failAdapterCreation = false;
        const createAdapter = vi.fn(() => {
            if (failAdapterCreation) {
                throw new Error('platform stream crashed');
            }
            return unavailableMachineLiveStreamCaptureAdapter;
        });
        const reconciler = mod.createSimulatorCaptureRegistryReconciler({
            registry,
            createAdapter,
        });

        expect(reconciler.reconcile([availableIosResource])).toEqual({
            registered: ['ios-simulator:A1B2-C3D4:screen'],
            unregistered: [],
            diagnostics: [],
        });

        failAdapterCreation = true;

        expect(reconciler.reconcile([availableIosResource])).toEqual({
            registered: [],
            unregistered: ['ios-simulator:A1B2-C3D4:screen'],
            diagnostics: [expect.objectContaining({
                reasonCode: 'simulator_capture_adapter_unavailable',
                sourceId: 'ios-simulator:A1B2-C3D4:screen',
            })],
        });
        expect(registry.resolve({ sourceId: 'ios-simulator:A1B2-C3D4:screen' })).toMatchObject({
            ok: false,
            diagnostic: { reasonCode: 'capture_source_unavailable' },
        });
    });
});
