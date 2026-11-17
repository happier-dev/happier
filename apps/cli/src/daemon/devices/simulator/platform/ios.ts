import type {
    IosSimulatorAdapterHealthV1,
    SimulatorDeviceResourceV1,
    SimulatorPreviewActionResultV1,
    SimulatorPreviewActionV1,
    SimulatorSidebandMessageV1,
} from '@happier-dev/protocol';

import type { IosSimulatorResourcesDiscoveryResult } from '../ios/discovery';
import type { SimulatorPreviewResourceReadResult } from '../adapter';
import { readSimulatorLogSideband } from '../capture/logs';
import { createIosSimulatorUnavailableHealth } from '../ios/diagnostics';
import {
    dispatchIosSimulatorInput,
    type IosSimulatorInputCommandSender,
} from '../ios/input';

export type IosSimulatorPlatformAdapter = Readonly<{
    platform: 'ios';
    usesPrivateFrameworks: true;
    health: () => Promise<IosSimulatorAdapterHealthV1>;
    listResources: () => Promise<SimulatorPreviewResourceReadResult>;
    listDiagnostics: () => Promise<readonly Record<string, unknown>[]>;
    dispatchAction: (input: IosSimulatorPlatformDispatchInput) => Promise<SimulatorPreviewActionResultV1 | void>;
    stop: () => Promise<void>;
    capture: (input: Readonly<{ simulatorId: string }>) => Promise<
        Readonly<
            | { ok: true }
            | {
                ok: false;
                reasonCode: string;
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
    discoverResources: () => Promise<IosSimulatorResourcesDiscoveryResult> | IosSimulatorResourcesDiscoveryResult;
    sendInputCommand?: IosSimulatorInputCommandSender | null;
    now?: () => number;
}>): IosSimulatorPlatformAdapter {
    let lastDiscoveryResult: IosSimulatorResourcesDiscoveryResult | null = null;
    const readDiscoveryResult = async (): Promise<IosSimulatorResourcesDiscoveryResult> => {
        try {
            lastDiscoveryResult = await input.discoverResources();
        } catch (error) {
            const diagnostics = [{ code: 'simulator_discovery_failed', errorName: error instanceof Error ? error.name : 'UnknownError' }];
            lastDiscoveryResult = {
                refreshState: 'error',
                resources: [],
                health: createIosSimulatorUnavailableHealth({ reasonCode: 'simulator_not_booted', diagnostics }),
                diagnostics: [{ platform: 'ios', status: 'unavailable', severity: 'error', reasonCode: 'simulator_discovery_failed', diagnostics }],
            };
        }
        return lastDiscoveryResult;
    };
    return {
        platform: 'ios',
        usesPrivateFrameworks: true,
        health: async () => (lastDiscoveryResult ?? await readDiscoveryResult()).health,
        listResources: readDiscoveryResult,
        listDiagnostics: async () => (lastDiscoveryResult ?? await readDiscoveryResult()).diagnostics,
        dispatchAction: async ({ event, resource }) => {
            if (event.type === 'simulator.sideband.request') {
                const discoveryResult = await readDiscoveryResult();
                const authority = validateIosSidebandDispatchAuthority({ event, resource, authorizedResources: discoveryResult.resources });
                if (!authority.ok) return authority.result;
                if (event.kind === 'logs') {
                    const message = readSimulatorLogSideband(authority.resource.simulatorId);
                    return message ? actionAcceptedResult(event, message) : actionUnavailableResult(event, 'simulator_logs_not_started');
                }
                if (event.kind === 'capture_health') {
                    return actionAcceptedResult(event, createIosCaptureHealthSideband({
                        event, resource: authority.resource, health: discoveryResult.health,
                        emittedAtMs: input.now?.() ?? Date.now(),
                    }));
                }
                return actionUnavailableResult(event, `ios_simulator_sideband_${event.kind}_unsupported`);
            }
            const authority = validateIosControlDispatchAuthority({ event, resource });
            if (!authority.ok) return authority.result;
            const discoveryResult = await readDiscoveryResult();
            const discoveryAuthority = validateIosControlDispatchAuthority({ event, resource, authorizedResources: discoveryResult.resources });
            if (!discoveryAuthority.ok) return discoveryAuthority.result;
            if (discoveryResult.health.status === 'unavailable') {
                return actionUnavailableResult(event, discoveryResult.health.reasonCode);
            }
            return await dispatchIosSimulatorInput({
                event, supportedInputKinds: discoveryResult.health.supportedInputKinds,
                ...(input.sendInputCommand !== undefined ? { sendCommand: input.sendInputCommand } : {}),
            });
        },
        stop: async () => {},
        capture: async ({ simulatorId }) => {
            const discoveryResult = await readDiscoveryResult();
            const resource = discoveryResult.resources.find((item) => item.simulatorId === simulatorId);
            if (!resource) return { ok: false, reasonCode: 'unknown_simulator' };
            return resource.capture.status === 'available'
                ? { ok: true }
                : { ok: false, reasonCode: resource.capture.reasonCode };
        },
    };
}
