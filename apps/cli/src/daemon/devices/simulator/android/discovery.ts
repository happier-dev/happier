import type {
    AndroidSimulatorAdapterHealthV1,
    AndroidSimulatorAdapterUnavailableReasonV1,
    MachineLiveStreamInputControlKindV1,
    SimulatorDeviceResourceV1,
    SimulatorStreamControlsV1,
} from '@happier-dev/protocol';

/**
 * Stream controls backed by the Android scrcpy server-restart producer
 * (`restartProducer.ts`). The producer re-launches scrcpy with new encoder args and re-establishes
 * the raw stream with last-frame continuity, so every encoder control is honored. The producer
 * exposes ONE encoder-reconfiguration sink — `setQuality` (via `mergeEncoder`) — which carries
 * bitrate, fps, and a longest-edge resolution cap; `setFps`/`setScale` are CAPABILITY signals for
 * that single sink, not separate methods. The daemon folds the `fps.set`/`scale.set` scalar runtime
 * actions into one `set_quality` sideband (`actions/qualityScalarTranslator.ts`). Plus
 * `request_keyframe` (a restart yields a fresh IDR) and the held-frame `snapshot`. The protocol
 * normalizer (`BACKABLE_SIMULATOR_STREAM_CONTROLS_V1`) confirms each bit is flip-eligible; this
 * advertises the resource-level truth for the Android scrcpy capture source.
 */
const ANDROID_SCRCPY_STREAM_CONTROLS_V1: SimulatorStreamControlsV1 = {
    requestKeyframe: true,
    snapshot: true,
    setQuality: true,
    setFps: true,
    setScale: true,
};

import {
    resolveAndroidScrcpyServerArtifact,
    type AndroidScrcpyServerArtifactResolution,
} from './artifact';
import { createAndroidSimulatorUnavailableHealth } from './diagnostics';
import {
    defaultAndroidToolRunner,
    type AndroidToolRunResult,
    type AndroidToolRunner,
} from './process';
import {
    parseAdbDevicesLongOutput,
    resolveAndroidAdbTooling,
    type AndroidAdbDeviceRecord,
    type AndroidAdbToolingResolution,
} from './tooling';

export type AndroidSimulatorDiscoveredDevice = Readonly<{
    serial: string;
    kind: 'emulator' | 'physical';
    state: 'device' | 'offline' | 'unauthorized' | 'unknown';
    displayName?: string;
}>;

export type AndroidSimulatorDiscoveryReader = () =>
    Promise<readonly AndroidSimulatorDiscoveredDevice[]> | readonly AndroidSimulatorDiscoveredDevice[];

export type AndroidSimulatorResourcesDiscoveryResult = Readonly<{
    resources: readonly SimulatorDeviceResourceV1[];
    diagnostics: readonly Record<string, unknown>[];
    health: AndroidSimulatorAdapterHealthV1;
}>;

export type AndroidAdbDevicesRunner = (
    input: Readonly<{
        command: string;
        args: readonly string[];
        timeoutMs: number;
        signal?: AbortSignal;
    }>,
) => Promise<AndroidToolRunResult>;

export type DiscoverAndroidSimulatorResourcesInput = Readonly<{
    resolveAdbTooling?: () => Promise<AndroidAdbToolingResolution>;
    resolveScrcpyServerArtifact?: () => Promise<AndroidScrcpyServerArtifactResolution>;
    resolveBridgeHealth?: (input: Readonly<{
        adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
        scrcpyServerArtifact: Extract<AndroidScrcpyServerArtifactResolution, { ok: true }>;
        devices: readonly AndroidSimulatorDiscoveredDevice[];
    }>) => Promise<AndroidSimulatorAdapterHealthV1> | AndroidSimulatorAdapterHealthV1;
    runAdb?: AndroidAdbDevicesRunner | AndroidToolRunner;
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

export type CreateDefaultAndroidSimulatorResourcesDiscoveryInput = Readonly<{
    resolveAdbTooling?: () => Promise<AndroidAdbToolingResolution>;
    resolveScrcpyServerArtifact?: () => Promise<AndroidScrcpyServerArtifactResolution>;
    resolveBridgeHealth?: DiscoverAndroidSimulatorResourcesInput['resolveBridgeHealth'];
    runAdb?: AndroidAdbDevicesRunner | AndroidToolRunner;
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

const ANDROID_DEFAULT_SUPPORTED_INPUT_KINDS = [
    'tap',
    'long_press',
    'swipe',
    'drag',
    'keyboard_text',
    'keyboard_key',
    'hardware_button',
] as const satisfies readonly MachineLiveStreamInputControlKindV1[];

export function androidSimulatorId(
    serial: string,
    kind: AndroidSimulatorDiscoveredDevice['kind'] = 'emulator',
): string {
    return `android:${kind}:${serial}`;
}

export function androidSimulatorSourceId(serial: string): string {
    return `simulator:android:${serial}:screen`;
}

function unavailableReasonForDevice(
    device: AndroidSimulatorDiscoveredDevice,
    health: AndroidSimulatorAdapterHealthV1,
): AndroidSimulatorAdapterUnavailableReasonV1 | null {
    if (device.kind === 'physical') return 'physical_device_not_supported_v1';
    if (device.state === 'unauthorized') return 'android_device_unauthorized';
    if (device.state === 'offline' || device.state === 'unknown') return 'android_device_offline';
    if (health.status === 'unavailable') return health.reasonCode;
    return null;
}

export function createAndroidSimulatorResource(input: Readonly<{
    device: AndroidSimulatorDiscoveredDevice;
    health: AndroidSimulatorAdapterHealthV1;
}>): SimulatorDeviceResourceV1 {
    const displayName = input.device.displayName ?? input.device.serial;
    const base = {
        v: 1 as const,
        simulatorId: androidSimulatorId(input.device.serial, input.device.kind),
        platform: 'android' as const,
        deviceId: input.device.serial,
        displayName,
    };
    const unavailableReason = unavailableReasonForDevice(input.device, input.health);

    if (!unavailableReason && input.health.status === 'available') {
        return {
            ...base,
            capture: {
                status: 'available',
                sourceId: androidSimulatorSourceId(input.device.serial),
                supportedCodecs: input.health.supportedCodecs,
                inputMode: 'exclusive',
                supportedInputKinds: input.health.supportedInputKinds,
                streamControls: ANDROID_SCRCPY_STREAM_CONTROLS_V1,
            },
        };
    }

    return {
        ...base,
        capture: {
            status: 'unavailable',
            sourceId: androidSimulatorSourceId(input.device.serial),
            reasonCode: unavailableReason ?? 'android_emulator_bridge_unavailable',
        },
        unavailableReason: unavailableReason ?? 'android_emulator_bridge_unavailable',
    };
}

function diagnostic(input: Readonly<{
    reasonCode: AndroidSimulatorAdapterUnavailableReasonV1 | string;
    severity?: 'info' | 'warning' | 'error';
    diagnostics?: readonly Record<string, unknown>[];
}>): Record<string, unknown> {
    return {
        platform: 'android',
        status: 'unavailable',
        severity: input.severity ?? 'error',
        reasonCode: input.reasonCode,
        diagnostics: input.diagnostics ?? [],
    };
}

function unavailableHealth(input: Readonly<{
    reasonCode: AndroidSimulatorAdapterUnavailableReasonV1;
    diagnostics?: readonly Record<string, unknown>[];
}>): AndroidSimulatorAdapterHealthV1 {
    return createAndroidSimulatorUnavailableHealth({
        reasonCode: input.reasonCode,
        diagnostics: input.diagnostics ?? [],
    });
}

function androidDeviceKind(record: AndroidAdbDeviceRecord): AndroidSimulatorDiscoveredDevice['kind'] {
    return record.serial.startsWith('emulator-') ? 'emulator' : 'physical';
}

function displayNameForAdbRecord(record: AndroidAdbDeviceRecord): string {
    return record.model ?? record.device ?? record.product ?? record.serial;
}

function deviceFromAdbRecord(record: AndroidAdbDeviceRecord): AndroidSimulatorDiscoveredDevice {
    return {
        serial: record.serial,
        kind: androidDeviceKind(record),
        state: record.state,
        displayName: displayNameForAdbRecord(record),
    };
}

async function runAdbDevices(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    runner: AndroidAdbDevicesRunner | AndroidToolRunner;
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<Readonly<
    | { ok: true; devices: readonly AndroidSimulatorDiscoveredDevice[]; diagnostics: readonly Record<string, unknown>[] }
    | { ok: false; diagnostics: readonly Record<string, unknown>[] }
>> {
    const result = await input.runner({
        command: input.adb.command,
        args: ['devices', '-l'],
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.exitCode !== 0) {
        return {
            ok: false,
            diagnostics: [{
                code: 'adb_devices_failed',
                exitCode: result.exitCode,
                ...(result.timedOut ? { timedOut: true } : {}),
                ...(result.aborted ? { aborted: true } : {}),
            }],
        };
    }

    const parsed = parseAdbDevicesLongOutput(result.stdout);
    return {
        ok: true,
        devices: parsed.records.map(deviceFromAdbRecord),
        diagnostics: parsed.diagnostics,
    };
}

function defaultBridgeUnavailableHealth(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    scrcpyServerArtifact: Extract<AndroidScrcpyServerArtifactResolution, { ok: true }>;
}>): AndroidSimulatorAdapterHealthV1 {
    return unavailableHealth({
        reasonCode: 'android_emulator_bridge_unavailable',
        diagnostics: [{
            requiredOwner: 'android_emulator_capture_input_bridge',
            adbVersion: input.adb.version,
            scrcpyServerVersion: input.scrcpyServerArtifact.version,
            scrcpyServerDigest: input.scrcpyServerArtifact.digest,
        }],
    });
}

function defaultBridgeAvailableHealth(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    scrcpyServerArtifact: Extract<AndroidScrcpyServerArtifactResolution, { ok: true }>;
}>): AndroidSimulatorAdapterHealthV1 {
    return {
        v: 1,
        platform: 'android',
        status: 'available',
        transport: 'scrcpy-local-sockets-over-pms',
        physicalDevicesSupported: false,
        supportedCodecs: ['h264.avcc'],
        supportedInputKinds: [...ANDROID_DEFAULT_SUPPORTED_INPUT_KINDS],
        clipboardSyncDefault: 'disabled',
        ...(input.adb.version ? { adbVersion: input.adb.version } : {}),
        scrcpyServerVersion: input.scrcpyServerArtifact.version,
        scrcpyServerDigest: input.scrcpyServerArtifact.digest,
    };
}

function projectDevices(input: Readonly<{
    devices: readonly AndroidSimulatorDiscoveredDevice[];
    health: AndroidSimulatorAdapterHealthV1;
}>): readonly SimulatorDeviceResourceV1[] {
    return input.devices.map((device) => createAndroidSimulatorResource({
        device,
        health: input.health,
    }));
}

export async function discoverAndroidSimulatorResources(
    input: DiscoverAndroidSimulatorResourcesInput = {},
): Promise<AndroidSimulatorResourcesDiscoveryResult> {
    const resolveAdb = input.resolveAdbTooling ?? (() => resolveAndroidAdbTooling({
        ...(input.signal ? { signal: input.signal } : {}),
    }));
    const adb = await resolveAdb();
    if (!adb.ok) {
        const health = unavailableHealth({
            reasonCode: adb.reasonCode,
            diagnostics: adb.diagnostics,
        });
        return {
            resources: [],
            diagnostics: [diagnostic({
                reasonCode: adb.reasonCode,
                diagnostics: adb.diagnostics,
            })],
            health,
        };
    }

    const adbDevices = await runAdbDevices({
        adb,
        runner: input.runAdb ?? defaultAndroidToolRunner,
        timeoutMs: input.timeoutMs ?? 5_000,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!adbDevices.ok) {
        const health = unavailableHealth({
            reasonCode: 'android_emulator_unavailable',
            diagnostics: adbDevices.diagnostics,
        });
        return {
            resources: [],
            diagnostics: [diagnostic({
                reasonCode: 'android_emulator_unavailable',
                diagnostics: adbDevices.diagnostics,
            })],
            health,
        };
    }

    if (adbDevices.devices.length === 0) {
        const health = unavailableHealth({
            reasonCode: 'android_emulator_unavailable',
        });
        return {
            resources: [],
            diagnostics: [
                ...adbDevices.diagnostics,
                diagnostic({
                    reasonCode: 'android_emulator_unavailable',
                    severity: 'info',
                }),
            ],
            health,
        };
    }

    const controllableEmulators = adbDevices.devices.filter((device) => (
        device.kind === 'emulator' && device.state === 'device'
    ));
    if (controllableEmulators.length === 0) {
        const reasonCode = adbDevices.devices.some((device) => device.kind === 'physical')
            ? 'physical_device_not_supported_v1'
            : 'android_emulator_unavailable';
        const health = unavailableHealth({ reasonCode });
        return {
            resources: projectDevices({ devices: adbDevices.devices, health }),
            diagnostics: [
                ...adbDevices.diagnostics,
                diagnostic({
                    reasonCode,
                    severity: 'info',
                }),
            ],
            health,
        };
    }

    const resolveArtifact = input.resolveScrcpyServerArtifact ?? resolveAndroidScrcpyServerArtifact;
    const scrcpyServerArtifact = await resolveArtifact();
    if (!scrcpyServerArtifact.ok) {
        const health = unavailableHealth({
            reasonCode: scrcpyServerArtifact.reasonCode,
            diagnostics: scrcpyServerArtifact.diagnostics,
        });
        return {
            resources: projectDevices({ devices: adbDevices.devices, health }),
            diagnostics: [
                ...adbDevices.diagnostics,
                diagnostic({
                    reasonCode: scrcpyServerArtifact.reasonCode,
                    diagnostics: scrcpyServerArtifact.diagnostics,
                }),
            ],
            health,
        };
    }

    const health = await (
        input.resolveBridgeHealth?.({
            adb,
            scrcpyServerArtifact,
            devices: adbDevices.devices,
        }) ?? defaultBridgeUnavailableHealth({ adb, scrcpyServerArtifact })
    );

    return {
        resources: projectDevices({ devices: adbDevices.devices, health }),
        diagnostics: [
            ...adbDevices.diagnostics,
            ...(health.status === 'available'
                ? []
                : [diagnostic({
                    reasonCode: health.reasonCode,
                    diagnostics: health.diagnostics,
                })]),
        ],
        health,
    };
}

export function createDefaultAndroidSimulatorResourcesDiscovery(
    input: CreateDefaultAndroidSimulatorResourcesDiscoveryInput = {},
): () => Promise<AndroidSimulatorResourcesDiscoveryResult> {
    return async () => await discoverAndroidSimulatorResources({
        ...(input.resolveAdbTooling ? { resolveAdbTooling: input.resolveAdbTooling } : {}),
        ...(input.resolveScrcpyServerArtifact ? { resolveScrcpyServerArtifact: input.resolveScrcpyServerArtifact } : {}),
        resolveBridgeHealth: input.resolveBridgeHealth ?? ((healthInput) => defaultBridgeAvailableHealth(healthInput)),
        ...(input.runAdb ? { runAdb: input.runAdb } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
    });
}
