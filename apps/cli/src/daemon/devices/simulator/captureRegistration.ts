import {
    MachineLiveStreamCaptureSourceV1Schema,
    simulatorCaptureStreamFamilyV1,
    type MachineLiveStreamCaptureSourceV1,
    type SimulatorCaptureCapabilitiesV1,
    type SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';

import type { MachineLiveStreamCaptureAdapter } from '../../peer/mediation/stream/captureAdapter';
import type { MachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';

export type SimulatorCaptureRegistrationDiagnostic = Readonly<{
    reasonCode: string;
    platform?: SimulatorDeviceResourceV1['platform'];
    simulatorId?: string;
    sourceId?: string;
    errorName?: string;
}>;

export type SimulatorCaptureRegistrationReconcileResult = Readonly<{
    registered: readonly string[];
    unregistered: readonly string[];
    diagnostics: readonly SimulatorCaptureRegistrationDiagnostic[];
}>;

export type SimulatorCaptureRegistryReconciler = Readonly<{
    reconcile(resources: readonly SimulatorDeviceResourceV1[]): SimulatorCaptureRegistrationReconcileResult;
    stop(): SimulatorCaptureRegistrationReconcileResult;
}>;

export type CreateSimulatorCaptureRegistryReconcilerInput = Readonly<{
    registry: MachineLiveStreamCaptureRegistry;
    createAdapter(resource: SimulatorDeviceResourceV1): MachineLiveStreamCaptureAdapter;
    maxFramesPerSecond?: number;
}>;

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
}

function isCaptureAvailable(
    resource: SimulatorDeviceResourceV1,
): resource is SimulatorDeviceResourceV1 & {
    capture: SimulatorCaptureCapabilitiesV1;
} {
    return resource.capture.status !== 'unavailable' && !resource.unavailableReason;
}

function capabilitiesForResource(
    resource: SimulatorDeviceResourceV1 & { capture: SimulatorCaptureCapabilitiesV1 },
    maxFramesPerSecond: number,
): MachineLiveStreamCaptureSourceV1 {
    return MachineLiveStreamCaptureSourceV1Schema.parse({
        v: 1,
        sourceId: resource.capture.sourceId,
        sourceKind: 'simulator',
        displayName: resource.displayName,
        supportedCodecs: resource.capture.supportedCodecs,
        maxFramesPerSecond,
        inputMode: resource.capture.inputMode,
        sidebands: ['capture_health'],
        health: { status: 'available' },
    });
}

export function createSimulatorCaptureRegistryReconciler(
    input: CreateSimulatorCaptureRegistryReconcilerInput,
): SimulatorCaptureRegistryReconciler {
    const managedSourceIds = new Set<string>();
    const maxFramesPerSecond = input.maxFramesPerSecond ?? 30;

    const unregisterMissing = (nextSourceIds: ReadonlySet<string>): readonly string[] => {
        const unregistered: string[] = [];
        for (const sourceId of [...managedSourceIds]) {
            if (nextSourceIds.has(sourceId)) continue;
            input.registry.unregister(sourceId);
            managedSourceIds.delete(sourceId);
            unregistered.push(sourceId);
        }
        return unregistered;
    };

    return Object.freeze({
        reconcile: (resources) => {
            const registered: string[] = [];
            const diagnostics: SimulatorCaptureRegistrationDiagnostic[] = [];
            const nextSourceIds = new Set<string>();

            for (const resource of resources) {
                if (!isCaptureAvailable(resource)) continue;

                const sourceId = resource.capture.sourceId;

                let adapter: MachineLiveStreamCaptureAdapter;
                try {
                    adapter = input.createAdapter(resource);
                } catch (error) {
                    diagnostics.push({
                        reasonCode: 'simulator_capture_adapter_unavailable',
                        platform: resource.platform,
                        simulatorId: resource.simulatorId,
                        sourceId,
                        errorName: errorName(error),
                    });
                    continue;
                }

                const streamFamily = simulatorCaptureStreamFamilyV1(sourceId);
                if (!streamFamily) {
                    diagnostics.push({
                        reasonCode: 'simulator_capture_source_invalid',
                        platform: resource.platform,
                        simulatorId: resource.simulatorId,
                        sourceId,
                    });
                    continue;
                }

                input.registry.register({
                    sourceId,
                    streamFamily,
                    adapter,
                    capabilities: capabilitiesForResource(resource, maxFramesPerSecond),
                });
                managedSourceIds.add(sourceId);
                nextSourceIds.add(sourceId);
                registered.push(sourceId);
            }

            return {
                registered,
                unregistered: unregisterMissing(nextSourceIds),
                diagnostics,
            };
        },
        stop: () => ({
            registered: [],
            unregistered: unregisterMissing(new Set()),
            diagnostics: [],
        }),
    });
}
