import type {
    IosSimulatorAdapterHealthV1,
    SimulatorDeviceResourceV1,
    SimulatorPreviewActionResultV1,
    SimulatorPreviewActionV1,
    SimulatorSidebandMessageV1,
} from '@happier-dev/protocol';

import {
    createIosSimulatorResource,
    type IosSimulatorDiscoveryDevice,
    type IosSimulatorDiscoveryReader,
    type IosSimulatorResourcesDiscoveryResult,
} from '../ios/discovery';
import { createIosSimulatorUnavailableHealth } from '../ios/diagnostics';
import {
    dispatchIosSimulatorInput,
    type IosSimulatorInputCommandSender,
} from '../ios/input';

export type IosSimulatorPlatformAdapter = Readonly<{
    platform: 'ios';
    usesPrivateFrameworks: true;
    health: () => Promise<IosSimulatorAdapterHealthV1>;
    listResources: () => Promise<readonly SimulatorDeviceResourceV1[]>;
    listDiagnostics: () => Promise<readonly Record<string, unknown>[]>;
    dispatchAction: (input: IosSimulatorPlatformDispatchInput) => Promise<SimulatorPreviewActionResultV1 | void>;
    stop: () => Promise<void>;
    capture: (input: Readonly<{ simulatorId: string }>) => Promise<
        Readonly<
            | { ok: true }
            | {
                ok: false;
                reasonCode: string;
                requiredOwner?: 'signed_ios_simulator_private_framework_helper';
                privateFrameworks?: readonly ['CoreSimulator', 'SimulatorKit'];
            }
        >
    >;
}>;

type IosSimulatorPlatformDispatchInput = Readonly<{
    event: SimulatorPreviewActionV1;
    resource?: SimulatorDeviceResourceV1 | null;
}>;

function actionUnavailableResult(
    event: SimulatorPreviewActionV1,
    reasonCode: string,
): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: event.type,
        status: 'unavailable',
        reasonCode,
        diagnostics: [],
    };
}

function actionRejectedResult(
    event: SimulatorPreviewActionV1,
    reasonCode: string,
): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: event.type,
        status: 'rejected',
        reasonCode,
        diagnostics: [],
    };
}

function actionAcceptedResult(
    event: SimulatorPreviewActionV1,
    sideband?: SimulatorSidebandMessageV1,
): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: event.type,
        status: 'accepted',
        diagnostics: [],
        ...(sideband ? { sideband } : {}),
    };
}

function validateIosControlDispatchAuthority(input: Readonly<{
    event: SimulatorPreviewActionV1;
    resource?: SimulatorDeviceResourceV1 | null;
    authorizedResources?: readonly SimulatorDeviceResourceV1[] | null;
}>): Readonly<{ ok: true } | { ok: false; result: SimulatorPreviewActionResultV1 }> {
    if (input.event.type !== 'simulator.control.send') {
        return { ok: true };
    }

    let resource = input.resource;
    if (!resource) {
        return {
            ok: false,
            result: actionRejectedResult(input.event, 'simulator_resource_authority_required'),
        };
    }
    if (input.authorizedResources) {
        const authorizedResource = input.authorizedResources.find((candidate) => (
            candidate.simulatorId === resource?.simulatorId
            && candidate.platform === resource?.platform
            && candidate.deviceId === resource?.deviceId
        ));
        if (!authorizedResource) {
            return {
                ok: false,
                result: actionRejectedResult(input.event, 'simulator_resource_authority_required'),
            };
        }
        resource = authorizedResource;
    }
    if (resource.platform !== 'ios') {
        return {
            ok: false,
            result: actionRejectedResult(input.event, 'unknown_simulator_source'),
        };
    }
    if (resource.capture.status === 'unavailable') {
        return {
            ok: false,
            result: actionUnavailableResult(input.event, resource.capture.reasonCode),
        };
    }
    if (resource.capture.sourceId !== input.event.control.sourceId) {
        return {
            ok: false,
            result: actionRejectedResult(input.event, 'unknown_simulator_source'),
        };
    }
    if (resource.capture.inputMode === 'none') {
        return {
            ok: false,
            result: actionRejectedResult(input.event, 'input_not_supported'),
        };
    }
    return { ok: true };
}

function validateIosSidebandDispatchAuthority(input: Readonly<{
    event: SimulatorPreviewActionV1;
    resource?: SimulatorDeviceResourceV1 | null;
    authorizedResources?: readonly SimulatorDeviceResourceV1[] | null;
}>): Readonly<{ ok: true; resource: SimulatorDeviceResourceV1 } | { ok: false; result: SimulatorPreviewActionResultV1 }> {
    if (input.event.type !== 'simulator.sideband.request') {
        return { ok: false, result: actionRejectedResult(input.event, 'invalid_simulator_action') };
    }

    let resource = input.resource;
    if (!resource) {
        return {
            ok: false,
            result: actionRejectedResult(input.event, 'simulator_resource_authority_required'),
        };
    }
    if (input.authorizedResources) {
        const authorizedResource = input.authorizedResources.find((candidate) => (
            candidate.simulatorId === resource?.simulatorId
            && candidate.platform === resource?.platform
            && candidate.deviceId === resource?.deviceId
        ));
        if (!authorizedResource) {
            return {
                ok: false,
                result: actionRejectedResult(input.event, 'simulator_resource_authority_required'),
            };
        }
        resource = authorizedResource;
    }
    if (resource.platform !== 'ios' || resource.simulatorId !== input.event.simulatorId) {
        return {
            ok: false,
            result: actionRejectedResult(input.event, 'unknown_simulator'),
        };
    }
    return { ok: true, resource };
}

function createIosCaptureHealthSideband(input: Readonly<{
    event: Extract<SimulatorPreviewActionV1, { type: 'simulator.sideband.request' }>;
    resource: SimulatorDeviceResourceV1;
    health: IosSimulatorAdapterHealthV1;
    emittedAtMs: number;
}>): SimulatorSidebandMessageV1 {
    const captureUnavailable = input.resource.capture.status === 'unavailable'
        ? input.resource.capture.reasonCode
        : null;
    const healthUnavailable = input.health.status === 'unavailable'
        ? input.health.reasonCode
        : null;
    const reasonCode = captureUnavailable ?? healthUnavailable;
    return {
        v: 1,
        simulatorId: input.event.simulatorId,
        emittedAtMs: input.emittedAtMs,
        kind: 'capture_health',
        status: reasonCode ? 'unavailable' : 'available',
        ...(reasonCode ? { reasonCode } : {}),
    };
}

export function createIosSimulatorPlatformAdapter(input: Readonly<{
    helperAvailable?: boolean;
    captureAdapterAvailable?: boolean;
    discoverBootedSimulators?: IosSimulatorDiscoveryReader;
    discoverResources?: () => Promise<IosSimulatorResourcesDiscoveryResult> | IosSimulatorResourcesDiscoveryResult;
    sendInputCommand?: IosSimulatorInputCommandSender | null;
    now?: () => number;
}> = { helperAvailable: false }): IosSimulatorPlatformAdapter {
    const unavailableHealth = createIosSimulatorUnavailableHealth({
        reasonCode: 'ios_private_helper_unavailable',
        diagnostics: [{
            requiredOwner: 'signed_ios_simulator_private_framework_helper',
            privateFrameworks: ['CoreSimulator', 'SimulatorKit'],
        }],
    });
    let lastDiscoveryDiagnostics: readonly Record<string, unknown>[] = [];
    let lastDiscoveryResult: IosSimulatorResourcesDiscoveryResult | null = null;
    const readHealth = async (): Promise<IosSimulatorAdapterHealthV1> => input.helperAvailable
        ? {
            v: 1,
            platform: 'ios',
            status: 'available',
            usesPrivateFrameworks: true,
            helperDistribution: 'prebuilt-signed',
            requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
            supportedCodecs: ['image.mjpeg'],
            // Capability-truth (L1): input verbs are advertised only once the capture adapter is
            // wired. While the adapter is unavailable the resource downgrades to
            // ios_capture_adapter_unavailable, so health must not advertise verbs it cannot service.
            supportedInputKinds: input.captureAdapterAvailable === true
                ? ['tap', 'swipe', 'keyboard_text', 'hardware_button']
                : [],
        }
        : unavailableHealth;
    const readDevices = async (): Promise<readonly IosSimulatorDiscoveryDevice[]> => {
        try {
            const devices = await (input.discoverBootedSimulators?.() ?? []);
            lastDiscoveryDiagnostics = devices.length === 0
                ? [{
                    platform: 'ios',
                    status: 'unavailable',
                    severity: 'info',
                    reasonCode: 'simulator_not_booted',
                }]
                : [];
            return devices;
        } catch (error) {
            lastDiscoveryDiagnostics = [{
                platform: 'ios',
                status: 'unavailable',
                severity: 'error',
                reasonCode: 'simulator_discovery_failed',
                errorName: error instanceof Error ? error.name : 'UnknownError',
            }];
            return [];
        }
    };
    const readDiscoveryResult = async (): Promise<IosSimulatorResourcesDiscoveryResult> => {
        if (input.discoverResources) {
            try {
                const result = await input.discoverResources();
                lastDiscoveryResult = result;
                lastDiscoveryDiagnostics = result.diagnostics;
                return result;
            } catch (error) {
                const health = createIosSimulatorUnavailableHealth({
                    reasonCode: 'simulator_not_booted',
                    diagnostics: [{
                        code: 'simulator_discovery_failed',
                        errorName: error instanceof Error ? error.name : 'UnknownError',
                    }],
                });
                const result: IosSimulatorResourcesDiscoveryResult = {
                    resources: [],
                    diagnostics: [{
                        platform: 'ios',
                        status: 'unavailable',
                        severity: 'error',
                        reasonCode: 'simulator_discovery_failed',
                        errorName: error instanceof Error ? error.name : 'UnknownError',
                    }],
                    health,
                };
                lastDiscoveryResult = result;
                lastDiscoveryDiagnostics = result.diagnostics;
                return result;
            }
        }

        const [health, devices] = await Promise.all([readHealth(), readDevices()]);
        return {
            resources: devices.map((device) => createIosSimulatorResource({
                device,
                health,
                captureAdapterAvailable: input.captureAdapterAvailable,
            })),
            diagnostics: [
                ...lastDiscoveryDiagnostics,
                ...(health.status !== 'available'
                    ? [{
                        platform: health.platform,
                        status: health.status,
                        severity: 'error',
                        reasonCode: health.reasonCode,
                        diagnostics: health.diagnostics,
                    }]
                    : input.captureAdapterAvailable === true || devices.length === 0
                        ? []
                        : [{
                            platform: 'ios',
                            status: 'unavailable',
                            severity: 'error',
                            reasonCode: 'ios_capture_adapter_unavailable',
                            diagnostics: [{ code: 'ios_capture_adapter_unavailable' }],
                        }]),
            ],
            health,
        };
    };
    const readCurrentHealth = async (): Promise<IosSimulatorAdapterHealthV1> => {
        if (input.discoverResources) {
            return (lastDiscoveryResult ?? await readDiscoveryResult()).health;
        }
        return await readHealth();
    };
    return {
        platform: 'ios',
        usesPrivateFrameworks: true,
        health: readCurrentHealth,
        listResources: async () => {
            const result = await readDiscoveryResult();
            return result.resources;
        },
        listDiagnostics: async () => {
            if (input.discoverResources) {
                const result = lastDiscoveryResult ?? await readDiscoveryResult();
                return result.diagnostics;
            }
            const health = await readHealth();
            const diagnostics: Record<string, unknown>[] = [...lastDiscoveryDiagnostics];
            if (health.status === 'unavailable') {
                diagnostics.push({
                    platform: health.platform,
                    status: health.status,
                    severity: 'error',
                    reasonCode: health.reasonCode,
                    diagnostics: health.diagnostics,
                });
            }
            return diagnostics;
        },
        dispatchAction: async ({ event, resource }) => {
            if (event.type === 'simulator.sideband.request') {
                const discoveryResult = input.discoverResources || input.discoverBootedSimulators
                    ? await readDiscoveryResult()
                    : null;
                const sidebandAuthority = validateIosSidebandDispatchAuthority({
                    event,
                    resource,
                    ...(discoveryResult ? { authorizedResources: discoveryResult.resources } : {}),
                });
                if (!sidebandAuthority.ok) return sidebandAuthority.result;
                const health = discoveryResult?.health ?? await readCurrentHealth();
                if (event.kind === 'capture_health') {
                    return actionAcceptedResult(event, createIosCaptureHealthSideband({
                        event,
                        resource: sidebandAuthority.resource,
                        health,
                        emittedAtMs: input.now?.() ?? Date.now(),
                    }));
                }
                return actionUnavailableResult(event, `ios_simulator_sideband_${event.kind}_unsupported`);
            }

            const authority = validateIosControlDispatchAuthority({ event, resource });
            if (!authority.ok) return authority.result;

            const discoveryResult = event.type === 'simulator.control.send' && (input.discoverResources || input.discoverBootedSimulators)
                ? await readDiscoveryResult()
                : null;
            if (discoveryResult) {
                const discoveryAuthority = validateIosControlDispatchAuthority({
                    event,
                    resource,
                    authorizedResources: discoveryResult.resources,
                });
                if (!discoveryAuthority.ok) return discoveryAuthority.result;
            }

            const health = discoveryResult?.health ?? await readCurrentHealth();
            if (health.status === 'unavailable') {
                return {
                    v: 1,
                    eventType: event.type,
                    status: 'unavailable',
                    reasonCode: health.reasonCode,
                    diagnostics: [],
                };
            }
            return await dispatchIosSimulatorInput({
                event,
                supportedInputKinds: health.supportedInputKinds,
                ...(input.sendInputCommand !== undefined ? { sendCommand: input.sendInputCommand } : {}),
            });
        },
        stop: async () => {},
        capture: async (captureInput) => {
            const discoveryResult = input.discoverResources ? await readDiscoveryResult() : null;
            if (discoveryResult) {
                const resource = discoveryResult.resources.find((item) => item.simulatorId === captureInput.simulatorId);
                if (!resource) return { ok: false, reasonCode: 'unknown_simulator' };
                return resource.capture.status === 'available'
                    ? { ok: true }
                    : { ok: false, reasonCode: resource.capture.reasonCode };
            }

            const health = await readCurrentHealth();
            if (health.status === 'available') {
                return input.captureAdapterAvailable === true
                    ? { ok: true }
                    : { ok: false, reasonCode: 'ios_capture_adapter_unavailable' };
            }
            return health.reasonCode === 'ios_private_helper_unavailable'
                ? {
                    ok: false,
                    reasonCode: health.reasonCode,
                    requiredOwner: 'signed_ios_simulator_private_framework_helper',
                    privateFrameworks: ['CoreSimulator', 'SimulatorKit'],
                }
                : {
                    ok: false,
                    reasonCode: health.reasonCode,
                };
        },
    };
}
