import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimulatorAccessibilitySnapshotV1, SimulatorDeviceOperationV1, SimulatorDeviceResourceV1 } from '@happier-dev/protocol';

import { createAndroidSimulatorResource } from '../android/discovery';
import { androidHardwareButtonKeyCode } from '../android/input';
import { createAndroidSimulatorUnavailableHealth } from '../android/diagnostics';
import { resolveAndroidAdbTooling, resolveAndroidEmulatorCommand, type AndroidAdbToolingResolution } from '../android/tooling';
import { createIosSimulatorAccessibility } from '../ios/accessibility';
import { createIosSimulatorResource, parseIosSimulatorDevices } from '../ios/discovery';
import { createIosSimulatorUnavailableHealth } from '../ios/diagnostics';
import { createSimulatorOperationRunner, type SimulatorOperationProcessResult, type SimulatorOperationRunner } from '../process';
import { bootAndroidSimulator, type AndroidEmulatorSpawn } from './androidBoot';
import { isSimulatorDeviceOperationBacked } from './capabilities';
import { parseAndroidAvdName, readAndroidSimulatorInventory } from './inventory';

export type SimulatorDeviceOperationResult = Readonly<
    | { ok: true; device?: SimulatorDeviceResourceV1; png?: Buffer; snapshot?: SimulatorAccessibilitySnapshotV1; pressedIdentifier?: string }
    | { ok: false; errorCode: string; step: string; exitCode?: number; cause?: string }
>;

export type SimulatorDeviceOperations = Readonly<{
    list: (signal?: AbortSignal) => Promise<readonly SimulatorDeviceResourceV1[]>;
    execute: (input: SimulatorDeviceOperationV1, signal?: AbortSignal) => Promise<SimulatorDeviceOperationResult>;
}>;

export type CreateSimulatorDeviceOperationsOptions = Readonly<{
    platform?: NodeJS.Platform;
    env?: Readonly<Record<string, string | undefined>>;
    run?: SimulatorOperationRunner;
    resolveAdb?: () => Promise<AndroidAdbToolingResolution>;
    resolveEmulator?: (adbCommand: string) => Promise<string | null>;
    spawnEmulator?: AndroidEmulatorSpawn;
    accessibility?: Omit<NonNullable<Parameters<typeof createIosSimulatorAccessibility>[0]>, 'platform'>;
}>;

function failed(step: string, result: SimulatorOperationProcessResult): SimulatorDeviceOperationResult {
    return { ok: false, step,
        errorCode: result.aborted ? 'operation_cancelled' : result.errorCode ?? 'simulator_tool_failed',
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        ...(result.stderr || result.cause ? { cause: result.stderr || result.cause } : {}),
    };
}

/** adb shell assembles its arguments into a device-side shell command. Host argv alone does not
 * preserve URLs or app identifiers containing shell syntax, so quote at that external boundary.
 */
function androidShellArgument(value: string): string {
    return /^[A-Za-z0-9_./:=+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function screenshotResult(png: Buffer): SimulatorDeviceOperationResult {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return png.subarray(0, signature.length).equals(signature)
        ? { ok: true, png }
        : { ok: false, errorCode: 'simulator_screenshot_invalid', step: 'screenshot' };
}

function lifecycleResource(platform: 'ios' | 'android', deviceId: string, state: 'running' | 'stopped', avdName?: string): SimulatorDeviceResourceV1 {
    const resource = platform === 'ios'
        ? createIosSimulatorResource({ device: { udid: deviceId, name: deviceId, state: state === 'running' ? 'booted' : 'shutdown' },
            health: createIosSimulatorUnavailableHealth({ reasonCode: 'ios_native_producer_unavailable' }) })
        : createAndroidSimulatorResource({ device: { serial: deviceId, kind: 'emulator', state: state === 'running' ? 'device' : 'stopped',
            ...(avdName ? { avdName, displayName: avdName } : {}) },
            health: createAndroidSimulatorUnavailableHealth({ reasonCode: 'android_emulator_bridge_unavailable' }) });
    // Booting a device does not attach the capture producer. The adapter replaces this projection
    // with its capture truth when the existing inventory/snapshot owner next publishes the device.
    return { ...resource,
        capture: { status: 'unavailable', sourceId: resource.capture.sourceId, reasonCode: 'capture_not_started' },
        unavailableReason: 'capture_not_started',
    };
}

export function createSimulatorDeviceOperations(options: CreateSimulatorDeviceOperationsOptions = {}): SimulatorDeviceOperations {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const accessibility = createIosSimulatorAccessibility({ ...options.accessibility, platform });
    const run = options.run ?? createSimulatorOperationRunner({ env });
    const resolveAdb = options.resolveAdb ?? (() => resolveAndroidAdbTooling({ env }));
    const resolveEmulator = options.resolveEmulator ?? ((adbCommand) => resolveAndroidEmulatorCommand({ adbCommand, env }));
    const execute = async (input: SimulatorDeviceOperationV1, signal?: AbortSignal): Promise<SimulatorDeviceOperationResult> => {
        const unavailable = (): SimulatorDeviceOperationResult => ({ ok: false, errorCode: 'simulator_operation_unavailable', step: input.operation });
        if (signal?.aborted) return { ok: false, errorCode: 'operation_cancelled', step: input.operation };
        if (input.operation === 'accessibility_snapshot' || input.operation === 'accessibility_press') {
            return input.platform === 'ios' ? accessibility.execute(input, signal)
                : { ok: false, errorCode: 'simulator_accessibility_unavailable', step: input.operation };
        }
        if (input.platform === 'ios' && platform !== 'darwin') return unavailable();
        if (!isSimulatorDeviceOperationBacked(input.platform, input.operation)) return unavailable();
        try {
            let command = 'xcrun';
            let args: readonly string[];
            let stdin: string | undefined;
            if (input.platform === 'ios') {
                if (input.operation === 'screenshot') {
                    // simctl versions can accept '-' yet write a literal filename instead of stdout.
                    // An owned temporary file follows the native screenshot contract on every version.
                    const directory = await mkdtemp(join(tmpdir(), 'happier-simulator-screenshot-'));
                    try {
                        const path = join(directory, 'screenshot.png');
                        const result = await run({ command, args: ['simctl', 'io', input.deviceId, 'screenshot', '--type=png', path], signal });
                        if (result.exitCode !== 0) return failed(input.operation, result);
                        return screenshotResult(await readFile(path));
                    } finally {
                        await rm(directory, { recursive: true, force: true });
                    }
                }
                switch (input.operation) {
                    case 'boot': args = ['simctl', 'boot', input.deviceId]; break;
                    case 'power_off': args = ['simctl', 'shutdown', input.deviceId]; break;
                    case 'app_launch': args = ['simctl', 'launch', input.deviceId, input.appId]; break;
                    case 'app_terminate': args = ['simctl', 'terminate', input.deviceId, input.appId]; break;
                    case 'open_url': args = ['simctl', 'openurl', input.deviceId, input.url]; break;
                    case 'appearance_set': args = ['simctl', 'ui', input.deviceId, 'appearance', input.appearance]; break;
                    case 'text_size_set': args = ['simctl', 'ui', input.deviceId, 'content_size', input.size]; break;
                    case 'location_set': args = ['simctl', 'location', input.deviceId, 'set', `${input.latitude},${input.longitude}`]; break;
                    case 'location_clear': args = ['simctl', 'location', input.deviceId, 'clear']; break;
                    case 'permission_set': args = ['simctl', 'privacy', input.deviceId, input.value, input.permission, input.appId]; break;
                    case 'push': args = ['simctl', 'push', input.deviceId, input.appId, '-']; stdin = JSON.stringify(input.payload); break;
                    case 'hardware': case 'rotate': return unavailable();
                }
            } else {
                const adb = await resolveAdb();
                if (!adb.ok) return { ok: false, errorCode: adb.reasonCode, step: input.operation };
                command = adb.command;
                if (input.operation === 'boot') {
                    if (!input.deviceId.startsWith('avd:')) return { ok: false, errorCode: 'android_avd_identity_required', step: 'boot' };
                    const emulator = await resolveEmulator(command);
                    if (!emulator) return { ok: false, errorCode: 'android_emulator_unavailable', step: 'boot' };
                    const avdName = input.deviceId.slice('avd:'.length);
                    const serial = await bootAndroidSimulator({ emulator, adb: command, avdName, run, signal, env,
                        ...(options.spawnEmulator ? { spawn: options.spawnEmulator } : {}) });
                    return { ok: true, device: lifecycleResource('android', serial, 'running', avdName) };
                }
                if (input.deviceId.startsWith('avd:')) return { ok: false, errorCode: 'simulator_not_booted', step: input.operation };
                if (input.operation === 'power_off') {
                    const identity = await run({ command, args: ['-s', input.deviceId, 'emu', 'avd', 'name'], signal });
                    if (identity.exitCode !== 0) return failed('power_off.identity', identity);
                    const avdName = parseAndroidAvdName(identity.stdout.toString('utf8'));
                    if (!avdName) return { ok: false, errorCode: 'android_emulator_identity_invalid', step: 'power_off.identity' };
                    const poweredOff = await run({ command, args: ['-s', input.deviceId, 'emu', 'kill'], signal });
                    if (poweredOff.exitCode !== 0) return failed('power_off', poweredOff);
                    return { ok: true, device: lifecycleResource('android', `avd:${avdName}`, 'stopped', avdName) };
                }
                let shell: readonly string[] | undefined;
                switch (input.operation) {
                    case 'app_launch': shell = ['monkey', '-p', input.appId, '-c', 'android.intent.category.LAUNCHER', '1']; args = []; break;
                    case 'app_terminate': shell = ['am', 'force-stop', input.appId]; args = []; break;
                    case 'open_url': shell = ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', input.url]; args = []; break;
                    case 'screenshot': args = ['exec-out', 'screencap', '-p']; break;
                    case 'appearance_set': shell = ['cmd', 'uimode', 'night', input.appearance === 'dark' ? 'yes' : 'no']; args = []; break;
                    case 'text_size_set': shell = ['settings', 'put', 'system', 'font_scale', input.size]; args = []; break;
                    case 'location_set': args = ['emu', 'geo', 'fix', String(input.longitude), String(input.latitude)]; break;
                    case 'location_clear': return unavailable();
                    case 'permission_set':
                        // pm reset-permissions affects every package. Reset just this app/permission.
                        if (input.value === 'reset') {
                            const revoke = await run({ command, args: ['-s', input.deviceId, 'shell',
                                ...['pm', 'revoke', input.appId, input.permission].map(androidShellArgument)], signal });
                            if (revoke.exitCode !== 0) return failed('permission_set.revoke', revoke);
                        }
                        shell = input.value === 'reset'
                            ? ['pm', 'clear-permission-flags', input.appId, input.permission, 'user-set', 'user-fixed']
                            : ['pm', input.value, input.appId, input.permission]; args = []; break;
                    case 'hardware': {
                        const keycode = androidHardwareButtonKeyCode(input.button);
                        if (!keycode) return unavailable();
                        shell = ['input', 'keyevent', keycode]; args = []; break;
                    }
                    case 'rotate': {
                        const rotation = { portrait: '0', landscape_left: '1', portrait_upside_down: '2', landscape_right: '3' } satisfies Record<Extract<SimulatorDeviceOperationV1, { operation: 'rotate' }>['orientation'], string>;
                        shell = ['wm', 'user-rotation', 'lock', rotation[input.orientation]]; args = []; break;
                    }
                }
                args = ['-s', input.deviceId, ...(shell ? ['shell', ...shell.map(androidShellArgument)] : args)];
            }
            const result = await run({ command, args, ...(stdin !== undefined ? { stdin } : {}), signal });
            if (result.exitCode !== 0) return failed(input.operation, result);
            if (input.operation === 'screenshot') {
                return screenshotResult(result.stdout);
            }
            if (input.operation === 'boot') {
                const booted = await run({ command, args: ['simctl', 'bootstatus', input.deviceId, '-b'], signal });
                if (booted.exitCode !== 0) return failed('boot', booted);
                return { ok: true, device: lifecycleResource(input.platform, input.deviceId, 'running') };
            }
            if (input.operation === 'power_off') return { ok: true, device: lifecycleResource(input.platform, input.deviceId, 'stopped') };
            return { ok: true };
        } catch (error) {
            const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
            return { ok: false, step: input.operation,
                errorCode: signal?.aborted || error instanceof Error && error.name === 'AbortError' ? 'operation_cancelled'
                    : typeof record.code === 'string' ? record.code : 'action_failed',
                ...(typeof record.exitCode === 'number' ? { exitCode: record.exitCode } : {}),
                ...(error instanceof Error ? { cause: error.message } : {}),
            };
        }
    };
    return {
        list: async (signal) => {
            const resources: SimulatorDeviceResourceV1[] = [];
            if (platform === 'darwin') {
                const result = await run({ command: 'xcrun', args: ['simctl', 'list', 'devices', '--json'], signal });
                if (result.exitCode === 0) {
                    const parsed = parseIosSimulatorDevices(result.stdout.toString('utf8'));
                    const accessibilityAvailable = parsed.ok && parsed.devices.some((device) => device.state === 'booted')
                        ? await accessibility.isAvailable() : false;
                    if (parsed.ok) resources.push(...parsed.devices.map((device) => createIosSimulatorResource({ device, accessibilityAvailable,
                        health: createIosSimulatorUnavailableHealth({ reasonCode: 'ios_native_producer_unavailable' }) })));
                }
            }
            const adb = await resolveAdb();
            if (adb.ok) {
                const inventory = await readAndroidSimulatorInventory({ adbCommand: adb.command,
                    emulatorCommand: await resolveEmulator(adb.command), run, signal });
                resources.push(...inventory.devices.map((device) => createAndroidSimulatorResource({ device,
                    health: createAndroidSimulatorUnavailableHealth({ reasonCode: 'android_emulator_bridge_unavailable' }) })));
            }
            return resources;
        },
        execute,
    };
}
