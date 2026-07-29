import type {
    AndroidSimulatorAdapterHealthV1,
    AndroidSimulatorAdapterUnavailableReasonV1,
    MachineLiveStreamInputControlKindV1,
    SimulatorDeviceResourceV1,
    SimulatorPreviewActionResultV1,
    SimulatorPreviewActionV1,
    SimulatorSidebandMessageV1,
} from '@happier-dev/protocol';

import {
    ANDROID_SCRCPY_CONTROL_INPUT_KINDS,
    type AndroidScrcpyControlSender,
} from '../android/control';
import {
    createAndroidSimulatorResource,
    type AndroidSimulatorDiscoveredDevice,
    type AndroidSimulatorDiscoveryReader,
    type AndroidSimulatorResourcesDiscoveryResult,
} from '../android/discovery';
import { createAndroidSimulatorUnavailableHealth } from '../android/diagnostics';
import {
    dispatchAndroidSimulatorInput,
    type AndroidSimulatorInputDisplaySize,
    type AndroidSimulatorInputDisplaySizeResolver,
} from '../android/input';
import type {
    AndroidAdbToolingResolution,
    AndroidToolRunner,
} from '../android/tooling';

const ANDROID_ADB_INPUT_KINDS = [
    'tap',
    'long_press',
    'swipe',
    'drag',
    'keyboard_text',
    'keyboard_key',
    'hardware_button',
] as const satisfies readonly MachineLiveStreamInputControlKindV1[];

const ANDROID_ADB_INPUT_KIND_SET = new Set<MachineLiveStreamInputControlKindV1>(
    ANDROID_ADB_INPUT_KINDS,
);
const ANDROID_SCRCPY_CONTROL_INPUT_KIND_SET = new Set<MachineLiveStreamInputControlKindV1>(
    ANDROID_SCRCPY_CONTROL_INPUT_KINDS,
);

export type AndroidSimulatorPlatformAdapter = Readonly<{
    platform: 'android';
    usesPrivateFrameworks: false;
    health: () => Promise<AndroidSimulatorAdapterHealthV1>;
    listResources: () => Promise<readonly SimulatorDeviceResourceV1[]>;
    listDiagnostics: () => Promise<readonly Record<string, unknown>[]>;
    dispatchAction: (input: AndroidSimulatorPlatformDispatchInput) => Promise<SimulatorPreviewActionResultV1 | void>;
    stop: () => Promise<void>;
    capture: (input: Readonly<{ simulatorId: string }>) => Promise<
        Readonly<
            | { ok: true }
            | {
                ok: false;
                reasonCode: AndroidSimulatorAdapterUnavailableReasonV1 | string;
                requiredOwner?: 'android_emulator_capture_input_bridge';
            }
        >
    >;
}>;

export type AndroidSimulatorScrcpyControl = Readonly<{
    sendScrcpyControl: AndroidScrcpyControlSender;
    displaySize: AndroidSimulatorInputDisplaySize | AndroidSimulatorInputDisplaySizeResolver;
}>;

export type AndroidSimulatorScrcpyControlResolver = (
    input: Readonly<{
        serial: string;
        resource: SimulatorDeviceResourceV1;
    }>,
) => AndroidSimulatorScrcpyControl | null;

type AndroidSimulatorPlatformDispatchInput = Readonly<{
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

function validateAndroidControlDispatchAuthority(input: Readonly<{
    event: SimulatorPreviewActionV1;
    resource?: SimulatorDeviceResourceV1 | null;
    authorizedResources?: readonly SimulatorDeviceResourceV1[] | null;
}>): Readonly<{ ok: true; resource?: SimulatorDeviceResourceV1 } | { ok: false; result: SimulatorPreviewActionResultV1 }> {
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
    if (resource.platform !== 'android') {
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
    const controlKind = input.event.control.kind as MachineLiveStreamInputControlKindV1;
    if (
        ANDROID_SCRCPY_CONTROL_INPUT_KIND_SET.has(controlKind)
        && resource.capture.supportedInputKinds?.includes(controlKind) !== true
    ) {
        return {
            ok: false,
            result: actionUnavailableResult(input.event, 'android_simulator_control_unsupported'),
        };
    }
    return { ok: true, resource };
}

function validateAndroidSidebandDispatchAuthority(input: Readonly<{
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
    if (resource.platform !== 'android' || resource.simulatorId !== input.event.simulatorId) {
        return {
            ok: false,
            result: actionRejectedResult(input.event, 'unknown_simulator'),
        };
    }
    return { ok: true, resource };
}

function createAndroidCaptureHealthSideband(input: Readonly<{
    event: Extract<SimulatorPreviewActionV1, { type: 'simulator.sideband.request' }>;
    resource: SimulatorDeviceResourceV1;
    health: AndroidSimulatorAdapterHealthV1;
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

function validateAndroidControlKindSupport(input: Readonly<{
    event: SimulatorPreviewActionV1;
    health: AndroidSimulatorAdapterHealthV1;
    resource?: SimulatorDeviceResourceV1 | null;
}>): Readonly<{ ok: true } | { ok: false; result: SimulatorPreviewActionResultV1 }> {
    if (input.event.type !== 'simulator.control.send' || input.health.status !== 'available') {
        return { ok: true };
    }
    const supportedInputKinds = new Set(input.health.supportedInputKinds);
    const kind = input.event.control.kind as MachineLiveStreamInputControlKindV1;
    const resourceSupportsKind = input.resource?.capture.status === 'available'
        && input.resource.capture.supportedInputKinds?.includes(kind) === true;
    if (supportedInputKinds.has(kind) || resourceSupportsKind) {
        return { ok: true };
    }
    return {
        ok: false,
        result: ANDROID_ADB_INPUT_KIND_SET.has(kind)
            ? actionRejectedResult(input.event, 'input_not_supported')
            : actionUnavailableResult(input.event, 'android_simulator_control_unsupported'),
    };
}

export function createAndroidSimulatorPlatformAdapter(input: Readonly<{
    bridgeAvailable?: boolean;
    discoverDevices?: AndroidSimulatorDiscoveryReader;
    discoverResources?: () => Promise<AndroidSimulatorResourcesDiscoveryResult> | AndroidSimulatorResourcesDiscoveryResult;
    resolveAdbTooling?: () => Promise<AndroidAdbToolingResolution>;
    runAdb?: AndroidToolRunner;
    sendScrcpyControl?: AndroidScrcpyControlSender;
    inputDisplaySize?: AndroidSimulatorInputDisplaySize | AndroidSimulatorInputDisplaySizeResolver;
    resolveScrcpyControl?: AndroidSimulatorScrcpyControlResolver;
    stopScrcpyControl?: () => Promise<void> | void;
    now?: () => number;
}> = { bridgeAvailable: false }): AndroidSimulatorPlatformAdapter {
    const unavailableHealth = createAndroidSimulatorUnavailableHealth({
        reasonCode: 'android_emulator_bridge_unavailable',
        diagnostics: [{
            requiredOwner: 'android_emulator_capture_input_bridge',
        }],
    });
    let lastDiscoveryDiagnostics: readonly Record<string, unknown>[] = [];
    let lastDiscoveryResult: AndroidSimulatorResourcesDiscoveryResult | null = null;
    const readGlobalScrcpyControl = (): AndroidSimulatorScrcpyControl | null => (
        input.sendScrcpyControl && input.inputDisplaySize
            ? {
                sendScrcpyControl: input.sendScrcpyControl,
                displaySize: input.inputDisplaySize,
            }
            : null
    );
    const resolveScrcpyControlForResource = (
        resource: SimulatorDeviceResourceV1 | null | undefined,
    ): AndroidSimulatorScrcpyControl | null => {
        const globalControl = readGlobalScrcpyControl();
        if (globalControl) return globalControl;
        if (!resource || resource.platform !== 'android' || resource.capture.status !== 'available') return null;
        return input.resolveScrcpyControl?.({
            serial: resource.deviceId,
            resource,
        }) ?? null;
    };
    const normalizeDispatchableInputKinds = (
        inputKinds: readonly MachineLiveStreamInputControlKindV1[],
        resource?: SimulatorDeviceResourceV1,
    ): MachineLiveStreamInputControlKindV1[] => {
        const merged: MachineLiveStreamInputControlKindV1[] = [];
        const scrcpyControl = resource
            ? resolveScrcpyControlForResource(resource)
            : readGlobalScrcpyControl();
        const addIfDispatchable = (kind: MachineLiveStreamInputControlKindV1): void => {
            if (ANDROID_ADB_INPUT_KIND_SET.has(kind)) {
                if (!merged.includes(kind)) merged.push(kind);
                return;
            }
            if (scrcpyControl && ANDROID_SCRCPY_CONTROL_INPUT_KIND_SET.has(kind)) {
                if (!merged.includes(kind)) merged.push(kind);
            }
        };

        for (const kind of inputKinds) addIfDispatchable(kind);
        if (!scrcpyControl) return merged;

        for (const kind of ANDROID_SCRCPY_CONTROL_INPUT_KINDS) {
            addIfDispatchable(kind);
        }
        return merged;
    };
    const normalizeHealth = (
        health: AndroidSimulatorAdapterHealthV1,
    ): AndroidSimulatorAdapterHealthV1 => {
        if (health.status !== 'available') return health;

        const supportedInputKinds = normalizeDispatchableInputKinds(health.supportedInputKinds);
        return supportedInputKinds.length === health.supportedInputKinds.length
            && supportedInputKinds.every((kind, index) => health.supportedInputKinds[index] === kind)
            ? health
            : { ...health, supportedInputKinds };
    };
    const normalizeResource = (
        resource: SimulatorDeviceResourceV1,
    ): SimulatorDeviceResourceV1 => {
        if (resource.capture.status !== 'available' || !resource.capture.supportedInputKinds) {
            return resource;
        }

        const currentInputKinds = resource.capture.supportedInputKinds;
        const supportedInputKinds = normalizeDispatchableInputKinds(currentInputKinds, resource);
        return supportedInputKinds.length === currentInputKinds.length
            && supportedInputKinds.every((kind, index) => currentInputKinds[index] === kind)
            ? resource
            : {
                ...resource,
                capture: {
                    ...resource.capture,
                    supportedInputKinds,
                },
            };
    };
    const normalizeDiscoveryResult = (
        result: AndroidSimulatorResourcesDiscoveryResult,
    ): AndroidSimulatorResourcesDiscoveryResult => {
        const health = normalizeHealth(result.health);
        const resources = result.resources.map(normalizeResource);
        const resourcesChanged = resources.some((resource, index) => resource !== result.resources[index]);
        return health === result.health && !resourcesChanged ? result : { ...result, health, resources };
    };
    const readHealth = async (): Promise<AndroidSimulatorAdapterHealthV1> => {
        const supportedInputKinds = normalizeDispatchableInputKinds(ANDROID_ADB_INPUT_KINDS);
        return input.bridgeAvailable
            ? {
                v: 1,
                platform: 'android',
                status: 'available',
                transport: 'scrcpy-local-sockets-over-pms',
                physicalDevicesSupported: false,
                supportedCodecs: ['h264.avcc'],
                supportedInputKinds,
                clipboardSyncDefault: 'disabled',
            }
            : unavailableHealth;
    };
    const readDevices = async (): Promise<readonly AndroidSimulatorDiscoveredDevice[]> => {
        try {
            const devices = await (input.discoverDevices?.() ?? []);
            lastDiscoveryDiagnostics = devices.length === 0
                ? [{
                    platform: 'android',
                    status: 'unavailable',
                    severity: 'info',
                    reasonCode: 'android_emulator_unavailable',
                }]
                : [];
            return devices;
        } catch (error) {
            lastDiscoveryDiagnostics = [{
                platform: 'android',
                status: 'unavailable',
                severity: 'error',
                reasonCode: 'android_device_discovery_failed',
                errorName: error instanceof Error ? error.name : 'UnknownError',
            }];
            return [];
        }
    };
    const readDiscoveryResult = async (): Promise<AndroidSimulatorResourcesDiscoveryResult> => {
        if (input.discoverResources) {
            try {
                const result = normalizeDiscoveryResult(await input.discoverResources());
                lastDiscoveryResult = result;
                lastDiscoveryDiagnostics = result.diagnostics;
                return result;
            } catch (error) {
                const health = createAndroidSimulatorUnavailableHealth({
                    reasonCode: 'android_emulator_unavailable',
                    diagnostics: [{
                        code: 'android_device_discovery_failed',
                        errorName: error instanceof Error ? error.name : 'UnknownError',
                    }],
                });
                const result: AndroidSimulatorResourcesDiscoveryResult = {
                    resources: [],
                    diagnostics: [{
                        platform: 'android',
                        status: 'unavailable',
                        severity: 'error',
                        reasonCode: 'android_device_discovery_failed',
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
            resources: devices.map((device) => createAndroidSimulatorResource({ device, health })),
            diagnostics: [
                ...lastDiscoveryDiagnostics,
                ...(health.status === 'available'
                    ? []
                    : [{
                        platform: health.platform,
                        status: health.status,
                        severity: 'error',
                        reasonCode: health.reasonCode,
                        diagnostics: health.diagnostics,
                    }]),
            ],
            health,
        };
    };
    const readCurrentHealth = async (): Promise<AndroidSimulatorAdapterHealthV1> => {
        if (input.discoverResources) {
            return (lastDiscoveryResult ?? await readDiscoveryResult()).health;
        }
        return await readHealth();
    };
    return {
        platform: 'android',
        usesPrivateFrameworks: false,
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
                const discoveryResult = input.discoverResources || input.discoverDevices
                    ? await readDiscoveryResult()
                    : null;
                const sidebandAuthority = validateAndroidSidebandDispatchAuthority({
                    event,
                    resource,
                    ...(discoveryResult ? { authorizedResources: discoveryResult.resources } : {}),
                });
                if (!sidebandAuthority.ok) return sidebandAuthority.result;
                const health = discoveryResult?.health ?? await readCurrentHealth();
                if (event.kind === 'capture_health') {
                    return actionAcceptedResult(event, createAndroidCaptureHealthSideband({
                        event,
                        resource: sidebandAuthority.resource,
                        health,
                        emittedAtMs: input.now?.() ?? Date.now(),
                    }));
                }
                return actionUnavailableResult(event, `android_simulator_sideband_${event.kind}_unsupported`);
            }

            const authority = validateAndroidControlDispatchAuthority({ event, resource });
            if (!authority.ok) return authority.result;
            let dispatchResource = authority.resource ?? resource ?? null;

            const discoveryResult = event.type === 'simulator.control.send' && (input.discoverResources || input.discoverDevices)
                ? await readDiscoveryResult()
                : null;
            if (discoveryResult) {
                const discoveryAuthority = validateAndroidControlDispatchAuthority({
                    event,
                    resource,
                    authorizedResources: discoveryResult.resources,
                });
                if (!discoveryAuthority.ok) return discoveryAuthority.result;
                dispatchResource = discoveryAuthority.resource ?? dispatchResource;
            }

            const health = discoveryResult?.health ?? await readCurrentHealth();
            if (health.status === 'unavailable') {
                return actionUnavailableResult(event, health.reasonCode);
            }
            const kindSupport = validateAndroidControlKindSupport({
                event,
                health,
                resource: dispatchResource,
            });
            if (!kindSupport.ok) return kindSupport.result;
            const scrcpyControl = resolveScrcpyControlForResource(dispatchResource);
            return await dispatchAndroidSimulatorInput({
                event,
                ...(input.resolveAdbTooling ? { resolveAdbTooling: input.resolveAdbTooling } : {}),
                ...(input.runAdb ? { runAdb: input.runAdb } : {}),
                ...(scrcpyControl ? { sendScrcpyControl: scrcpyControl.sendScrcpyControl } : {}),
                ...(scrcpyControl ? { displaySize: scrcpyControl.displaySize } : input.inputDisplaySize ? { displaySize: input.inputDisplaySize } : {}),
            });
        },
        stop: async () => {
            await input.stopScrcpyControl?.();
        },
        capture: async (captureInput) => {
            if (input.discoverResources || input.discoverDevices) {
                const result = await readDiscoveryResult();
                const resource = result.resources.find((item) => item.simulatorId === captureInput.simulatorId);
                if (!resource) return { ok: false, reasonCode: 'unknown_simulator' };
                return resource.capture.status === 'available'
                    ? { ok: true }
                    : { ok: false, reasonCode: resource.capture.reasonCode };
            }

            const health = await readCurrentHealth();
            if (health.status === 'available') return { ok: true };
            return health.reasonCode === 'android_emulator_bridge_unavailable'
                ? {
                    ok: false,
                    reasonCode: health.reasonCode,
                    requiredOwner: 'android_emulator_capture_input_bridge',
                }
                : {
                    ok: false,
                    reasonCode: health.reasonCode,
                };
        },
    };
}
