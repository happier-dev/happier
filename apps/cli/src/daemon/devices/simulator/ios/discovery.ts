import { access } from 'node:fs/promises';

import type {
    IosSimulatorAdapterHealthV1,
    SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';
import { DEFAULT_SIMULATOR_STREAM_CONTROLS_V1 } from '@happier-dev/protocol';

import { defaultSimulatorToolRunner, type SimulatorToolRunner } from '../process';
import { createIosSimulatorUnavailableHealth } from './diagnostics';
import {
    resolveIosSimulatorHelperArtifact,
    type IosSimulatorHelperArtifactResolution,
    type IosSimulatorHelperSignatureResult,
} from './helperArtifact';
import { resolveIosSimulatorHelperPin } from './helperPin';
import type { IosSimulatorHelperProbeRunner } from './helperProbe';
import { probeIosSimulatorHelperHealth } from './helperProbe';
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
}>;

export type IosSimulatorDiscoveryReader = () =>
    Promise<readonly IosSimulatorDiscoveryDevice[]> | readonly IosSimulatorDiscoveryDevice[];

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
    resolveHelperArtifact: () => Promise<IosSimulatorHelperArtifactResolution>;
    probeHelperHealth: (input: Readonly<{
        helperPath: string;
        runHelper?: IosSimulatorHelperProbeRunner;
    }>) => Promise<IosSimulatorAdapterHealthV1>;
    runSimctl: IosSimulatorSimctlRunner;
    captureAdapterAvailable?: boolean;
    timeoutMs?: number;
}>;

// EXTERNAL-ARTIFACT BOUNDARY: the pin is derived (compute-at-build, verify-at-launch) from the
// vendored manifest.json that scripts/buildIosSimulatorHelper.mjs rewrites after a successful
// sign + notarize + staple. While no signed/notarized helper has been produced, the manifest still
// carries the blocked placeholder, so this resolves to the all-zero placeholder digest and the
// resolver fails closed via the placeholder-digest guard in helperArtifact.ts (iOS capture stays
// unavailable). No human hand-edit of a digest constant is required after running the signer — the
// build output flows into the pin automatically; running the iOS argent QA gate before relying on
// the flip is still required.
export const PINNED_IOS_SIMULATOR_HELPER_ARTIFACT = resolveIosSimulatorHelperPin();

/**
 * Resolve the pinned vendored helper artifact through the real (digest + signature + version)
 * verification chain. Returns ok:false (fail-closed) while the placeholder digest is pinned or the
 * signed/notarized artifact is absent/unverifiable.
 */
export function resolvePinnedIosSimulatorHelperArtifact(input: Readonly<{
    verifyHelperSignature?: (path: string) => Promise<IosSimulatorHelperSignatureResult>;
}> = {}): Promise<IosSimulatorHelperArtifactResolution> {
    return resolveIosSimulatorHelperArtifact({
        expectedVersion: PINNED_IOS_SIMULATOR_HELPER_ARTIFACT.version,
        expectedDigest: PINNED_IOS_SIMULATOR_HELPER_ARTIFACT.digest,
        ...(input.verifyHelperSignature ? { verifySignature: input.verifyHelperSignature } : {}),
    });
}

/**
 * Derive the iOS capture-availability gate from the verified-artifact resolution. The daemon flips
 * `captureAdapterAvailable` true ONLY when this returns true, which keeps the advertised
 * `capture.status: 'available'` honest (capability-truth): availability is gated on the artifact
 * actually verifying, never on a caller assertion.
 */
export async function resolveIosSimulatorCaptureAdapterAvailability(input: Readonly<{
    resolveHelperArtifact?: () => Promise<IosSimulatorHelperArtifactResolution>;
    verifyHelperSignature?: (path: string) => Promise<IosSimulatorHelperSignatureResult>;
}> = {}): Promise<boolean> {
    const resolution = await (input.resolveHelperArtifact
        ?? (() => resolvePinnedIosSimulatorHelperArtifact(
            input.verifyHelperSignature ? { verifyHelperSignature: input.verifyHelperSignature } : {},
        )))();
    return resolution.ok;
}

export type CreateDefaultIosSimulatorResourcesDiscoveryInput = Readonly<{
    platform?: NodeJS.Platform | string;
    runCommand?: IosSimulatorXcodeCommandRunner;
    runHelper?: IosSimulatorHelperProbeRunner;
    pathExists?: (path: string) => Promise<boolean> | boolean;
    verifyHelperSignature?: (path: string) => Promise<IosSimulatorHelperSignatureResult>;
    resolveHelperArtifact?: () => Promise<IosSimulatorHelperArtifactResolution>;
    expectedHelperVersion?: string;
    expectedHelperDigest?: string;
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
}>): SimulatorDeviceResourceV1 {
    const base = {
        v: 1 as const,
        simulatorId: iosSimulatorId(input.device.udid),
        platform: 'ios' as const,
        deviceId: input.device.udid,
        displayName: input.device.name,
    };

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

function parseBootedDevicesFromSimctl(stdout: string): Readonly<
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
    const deviceGroups = Object.values((parsed as { devices: Record<string, unknown> }).devices);
    for (const group of deviceGroups) {
        if (!Array.isArray(group)) continue;
        for (const device of group) {
            if (
                typeof device !== 'object'
                || device === null
                || (device as { state?: unknown }).state !== 'Booted'
                || (device as { isAvailable?: unknown }).isAvailable === false
                || typeof (device as { udid?: unknown }).udid !== 'string'
                || typeof (device as { name?: unknown }).name !== 'string'
            ) {
                continue;
            }
            devices.push({
                udid: (device as { udid: string }).udid,
                name: (device as { name: string }).name,
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

    const helperArtifact = await input.resolveHelperArtifact();
    const health = helperArtifact.ok
        ? await input.probeHelperHealth({ helperPath: helperArtifact.path })
        : createIosSimulatorUnavailableHealth({
            reasonCode: helperArtifact.reasonCode,
            diagnostics: helperArtifact.diagnostics,
        });

    const simctl = await input.runSimctl({
        command: 'xcrun',
        args: ['simctl', 'list', 'devices', 'booted', '--json'],
        timeoutMs: input.timeoutMs ?? 5_000,
    });
    if (simctl.exitCode !== 0) {
        return {
            resources: [],
            diagnostics: [diagnostic({
                reasonCode: 'simulator_not_booted',
                diagnostics: [{
                    code: 'simctl_booted_devices_failed',
                    exitCode: simctl.exitCode,
                }],
            })],
            health,
        };
    }

    const parsed = parseBootedDevicesFromSimctl(simctl.stdout);
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

async function defaultPathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function createDefaultCommandRunner(runner: SimulatorToolRunner): IosSimulatorXcodeCommandRunner {
    return async (input) => await runner({
        command: input.command,
        args: input.args,
        timeoutMs: input.timeoutMs,
    });
}

function createDefaultHelperRunner(runner: SimulatorToolRunner): IosSimulatorHelperProbeRunner {
    return async (input) => await runner({
        command: input.helperPath,
        args: input.args,
        timeoutMs: input.timeoutMs,
    });
}

export function createDefaultIosSimulatorResourcesDiscovery(
    input: CreateDefaultIosSimulatorResourcesDiscoveryInput = {},
): () => Promise<IosSimulatorResourcesDiscoveryResult> {
    const sharedRunner = defaultSimulatorToolRunner;
    const runCommand = input.runCommand ?? createDefaultCommandRunner(sharedRunner);
    const runHelper = input.runHelper ?? createDefaultHelperRunner(sharedRunner);
    const pathExists = input.pathExists ?? defaultPathExists;
    const timeoutMs = input.timeoutMs ?? 5_000;

    return async () => await discoverIosSimulatorResources({
        resolveXcodeEnvironment: async () => await resolveIosSimulatorXcodeEnvironment({
            ...(input.platform ? { platform: input.platform } : {}),
            runCommand,
            pathExists: async (path) => await pathExists(path),
            timeoutMs,
        }),
        resolveHelperArtifact: input.resolveHelperArtifact ?? (async () => await resolveIosSimulatorHelperArtifact({
            expectedVersion: input.expectedHelperVersion ?? PINNED_IOS_SIMULATOR_HELPER_ARTIFACT.version,
            expectedDigest: input.expectedHelperDigest ?? PINNED_IOS_SIMULATOR_HELPER_ARTIFACT.digest,
            ...(input.verifyHelperSignature ? { verifySignature: input.verifyHelperSignature } : {}),
        })),
        probeHelperHealth: async ({ helperPath }) => await probeIosSimulatorHelperHealth({
            helperPath,
            runHelper,
            timeoutMs,
        }),
        runSimctl: runCommand,
        ...(input.captureAdapterAvailable !== undefined
            ? { captureAdapterAvailable: input.captureAdapterAvailable }
            : {}),
        timeoutMs,
    });
}
