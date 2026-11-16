import type {
    IosSimulatorAdapterHealthV1,
    SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';
import { DEFAULT_SIMULATOR_STREAM_CONTROLS_V1 } from '@happier-dev/protocol/devices/simulator/v1';

import { defaultSimulatorToolRunner, type SimulatorToolRunner } from '../process';
import { getSimulatorDeviceOperationCapabilities } from '../operations/capabilities';
import { createIosSimulatorAccessibility } from './accessibility';
import { createIosSimulatorUnavailableHealth } from './diagnostics';
import { resolveIosSimulatorNativeProducer } from './native';
import {
    resolveIosSimulatorXcodeEnvironment,
    type IosSimulatorXcodeCommandResult,
    type IosSimulatorXcodeEnvironment,
    type IosSimulatorXcodeCommandRunner,
} from './xcode';

export type IosSimulatorDiscoveryDevice = Readonly<{
    udid: string;
    name: string;
    runtime?: string;
    state?: 'booted' | 'shutdown' | 'unavailable';
    available?: boolean;
}>;

export type IosSimulatorSimctlRunner = (
    input: Readonly<{ command: 'xcrun'; args: readonly string[]; timeoutMs: number }>,
) => Promise<IosSimulatorXcodeCommandResult>;

export type IosSimulatorResourcesDiscoveryResult = Readonly<{
    resources: readonly SimulatorDeviceResourceV1[];
    diagnostics: readonly Record<string, unknown>[];
    health: IosSimulatorAdapterHealthV1;
}>;

export type DiscoverIosSimulatorResourcesInput = Readonly<{
    resolveXcodeEnvironment: () => Promise<IosSimulatorXcodeEnvironment>;
    readProducerHealth: () => IosSimulatorAdapterHealthV1 | Promise<IosSimulatorAdapterHealthV1>;
    runSimctl: IosSimulatorSimctlRunner;
    captureAdapterAvailable?: boolean;
    accessibilityAvailable?: boolean;
    timeoutMs?: number;
}>;

export type CreateDefaultIosSimulatorResourcesDiscoveryInput = Readonly<{
    platform?: NodeJS.Platform | string;
    runCommand?: IosSimulatorXcodeCommandRunner;
    readProducerHealth?: () => IosSimulatorAdapterHealthV1 | Promise<IosSimulatorAdapterHealthV1>;
    captureAdapterAvailable?: boolean;
    timeoutMs?: number;
}>;

export function iosSimulatorId(udid: string): string {
    return udid;
}

export function iosSimulatorSourceId(udid: string): string {
    return `ios-simulator:${udid}:screen`;
}

export function createIosSimulatorResource(input: Readonly<{
    device: IosSimulatorDiscoveryDevice;
    health: IosSimulatorAdapterHealthV1;
    captureAdapterAvailable?: boolean;
    accessibilityAvailable?: boolean;
}>): SimulatorDeviceResourceV1 {
    const state = input.device.available === false || input.device.state === 'unavailable'
        ? 'unavailable' : input.device.state === 'shutdown' ? 'stopped' : 'running';
    const base = {
        v: 1 as const,
        simulatorId: iosSimulatorId(input.device.udid),
        platform: 'ios' as const,
        deviceId: input.device.udid,
        displayName: input.device.name,
        state,
        ...(state === 'running' ? { runtimeId: input.device.udid } : {}),
        ...getSimulatorDeviceOperationCapabilities('ios', state, { accessibilityAvailable: input.accessibilityAvailable }),
    };

    if (state !== 'running') {
        return {
            ...base,
            capture: {
                status: 'unavailable',
                sourceId: iosSimulatorSourceId(input.device.udid),
                reasonCode: 'simulator_not_booted',
            },
            unavailableReason: 'simulator_not_booted',
        };
    }

    if (input.health.status === 'available') {
        if (input.captureAdapterAvailable !== true) {
            return {
                ...base,
                capture: {
                    status: 'unavailable',
                    sourceId: iosSimulatorSourceId(input.device.udid),
                    reasonCode: 'ios_capture_adapter_unavailable',
                },
                unavailableReason: 'ios_capture_adapter_unavailable',
            };
        }
        return {
            ...base,
            capture: {
                status: 'available',
                sourceId: iosSimulatorSourceId(input.device.udid),
                supportedCodecs: input.health.supportedCodecs,
                inputMode: 'exclusive',
                supportedInputKinds: input.health.supportedInputKinds,
                streamControls: DEFAULT_SIMULATOR_STREAM_CONTROLS_V1,
            },
        };
    }

    return {
        ...base,
        capture: {
            status: 'unavailable',
            sourceId: iosSimulatorSourceId(input.device.udid),
            reasonCode: input.health.reasonCode,
        },
        unavailableReason: input.health.reasonCode,
    };
}

function diagnostic(input: Readonly<{
    reasonCode: string;
    severity?: 'info' | 'error';
    diagnostics?: readonly Record<string, unknown>[];
}>): Record<string, unknown> {
    return {
        platform: 'ios',
        status: 'unavailable',
        severity: input.severity ?? 'error',
        reasonCode: input.reasonCode,
        diagnostics: input.diagnostics ?? [],
    };
}

export function parseIosSimulatorDevices(stdout: string): Readonly<
    | { ok: true; devices: readonly IosSimulatorDiscoveryDevice[] }
    | { ok: false; diagnostics: readonly Record<string, unknown>[] }
> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch (error) {
        return {
            ok: false,
            diagnostics: [{
                code: 'simctl_devices_malformed_output',
                errorName: error instanceof Error ? error.name : 'UnknownError',
            }],
        };
    }
    if (
        typeof parsed !== 'object'
        || parsed === null
        || !('devices' in parsed)
        || typeof (parsed as { devices?: unknown }).devices !== 'object'
        || (parsed as { devices?: unknown }).devices === null
    ) {
        return {
            ok: false,
            diagnostics: [{ code: 'simctl_devices_malformed_output' }],
        };
    }

    const devices: IosSimulatorDiscoveryDevice[] = [];
    const deviceGroups = Object.entries((parsed as { devices: Record<string, unknown> }).devices);
    for (const [runtime, group] of deviceGroups) {
        if (!Array.isArray(group)) continue;
        for (const device of group) {
            if (
                typeof device !== 'object'
                || device === null
                || typeof (device as { udid?: unknown }).udid !== 'string'
                || typeof (device as { name?: unknown }).name !== 'string'
            ) {
                continue;
            }
            devices.push({
                udid: (device as { udid: string }).udid,
                name: (device as { name: string }).name,
                runtime,
                state: (device as { state?: unknown }).state === 'Booted' ? 'booted'
                    : (device as { state?: unknown }).state === 'Shutdown' ? 'shutdown' : 'unavailable',
                available: (device as { isAvailable?: unknown }).isAvailable !== false,
            });
        }
    }
    return { ok: true, devices };
}

export async function discoverIosSimulatorResources(
    input: DiscoverIosSimulatorResourcesInput,
): Promise<IosSimulatorResourcesDiscoveryResult> {
    const xcode = await input.resolveXcodeEnvironment();
    if (!xcode.ok) {
        return {
            resources: [],
            diagnostics: [diagnostic({
                reasonCode: xcode.reasonCode,
                diagnostics: xcode.diagnostics,
            })],
            health: createIosSimulatorUnavailableHealth({
                reasonCode: xcode.reasonCode,
                diagnostics: xcode.diagnostics,
            }),
        };
    }

    const health = await input.readProducerHealth();

    const simctl = await input.runSimctl({
        command: 'xcrun',
        args: ['simctl', 'list', 'devices', '--json'],
        timeoutMs: input.timeoutMs ?? 5_000,
    });
    if (simctl.exitCode !== 0) {
        return {
            resources: [],
            diagnostics: [diagnostic({
                reasonCode: 'simulator_not_booted',
                diagnostics: [{
                    code: 'simctl_devices_failed',
                    exitCode: simctl.exitCode,
                }],
            })],
            health,
        };
    }

    const parsed = parseIosSimulatorDevices(simctl.stdout);
    if (!parsed.ok) {
        return {
            resources: [],
            diagnostics: [diagnostic({
                reasonCode: 'simulator_not_booted',
                diagnostics: parsed.diagnostics,
            })],
            health,
        };
    }

    if (parsed.devices.length === 0) {
        return {
            resources: [],
            diagnostics: [diagnostic({
                reasonCode: 'simulator_not_booted',
                severity: 'info',
            })],
            health,
        };
    }

    return {
        resources: parsed.devices.map((device) => createIosSimulatorResource({
            device,
            health,
            captureAdapterAvailable: input.captureAdapterAvailable,
            accessibilityAvailable: input.accessibilityAvailable,
        })),
        diagnostics: health.status !== 'available'
            ? [diagnostic({
                reasonCode: health.reasonCode,
                diagnostics: health.diagnostics,
            })]
            : input.captureAdapterAvailable === true
                ? []
                : [diagnostic({
                    reasonCode: 'ios_capture_adapter_unavailable',
                    diagnostics: [{ code: 'ios_capture_adapter_unavailable' }],
                })],
        health,
    };
}

function createDefaultCommandRunner(runner: SimulatorToolRunner): IosSimulatorXcodeCommandRunner {
    return async (input) => await runner({
        command: input.command,
        args: input.args,
        timeoutMs: input.timeoutMs,
    });
}

export function createDefaultIosSimulatorResourcesDiscovery(
    input: CreateDefaultIosSimulatorResourcesDiscoveryInput = {},
): () => Promise<IosSimulatorResourcesDiscoveryResult> {
    const sharedRunner = defaultSimulatorToolRunner;
    const runCommand = input.runCommand ?? createDefaultCommandRunner(sharedRunner);
    const timeoutMs = input.timeoutMs ?? 5_000;
    const accessibility = createIosSimulatorAccessibility({
        ...(input.platform ? { platform: input.platform as NodeJS.Platform } : {}),
    });

    return async () => await discoverIosSimulatorResources({
        accessibilityAvailable: await accessibility.isAvailable(),
        resolveXcodeEnvironment: async () => await resolveIosSimulatorXcodeEnvironment({
            ...(input.platform ? { platform: input.platform } : {}),
            runCommand,
            timeoutMs,
        }),
        readProducerHealth: input.readProducerHealth ?? (() => resolveIosSimulatorNativeProducer().health),
        runSimctl: runCommand,
        ...(input.captureAdapterAvailable !== undefined
            ? { captureAdapterAvailable: input.captureAdapterAvailable }
            : {}),
        timeoutMs,
    });
}
