import type { AndroidSimulatorDiscoveredDevice } from '../android/discovery';
import { parseAdbDevicesLongOutput } from '../android/tooling';
import type { SimulatorOperationProcessResult, SimulatorOperationRunner } from '../process';

function failure(code: string, result: SimulatorOperationProcessResult): Record<string, unknown> {
    return { platform: 'android', severity: 'warning', reasonCode: code, exitCode: result.exitCode,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}), ...(result.aborted ? { aborted: true } : {}),
    };
}

export function parseAndroidAvdName(stdout: string): string | undefined {
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.length === 2 && lines[1] === 'OK' && !lines[0]?.startsWith('KO:') ? lines[0] : undefined;
}

/** One inventory read shared by capture discovery and device Actions. No discovery poller. */
export async function readAndroidSimulatorInventory(input: Readonly<{
    adbCommand: string;
    emulatorCommand?: string | null;
    run: SimulatorOperationRunner;
    signal?: AbortSignal;
}>): Promise<Readonly<{ devices: readonly AndroidSimulatorDiscoveredDevice[]; diagnostics: readonly Record<string, unknown>[] }>> {
    const adb = await input.run({ command: input.adbCommand, args: ['devices', '-l'], signal: input.signal });
    const diagnostics: Record<string, unknown>[] = [];
    const parsed = adb.exitCode === 0 ? parseAdbDevicesLongOutput(adb.stdout.toString('utf8')) : { records: [], diagnostics: [] };
    diagnostics.push(...parsed.diagnostics);
    if (adb.exitCode !== 0) diagnostics.push(failure('adb_devices_failed', adb));
    const devices = await Promise.all(parsed.records.map(async (record): Promise<AndroidSimulatorDiscoveredDevice> => {
        const kind = record.serial.startsWith('emulator-') ? 'emulator' : 'physical';
        let avdName: string | undefined;
        if (kind === 'emulator' && record.state === 'device') {
            const name = await input.run({ command: input.adbCommand, args: ['-s', record.serial, 'emu', 'avd', 'name'], signal: input.signal });
            if (name.exitCode === 0) avdName = parseAndroidAvdName(name.stdout.toString('utf8'));
            else diagnostics.push(failure('android_avd_identity_failed', name));
        }
        return { serial: record.serial, kind, state: record.state,
            displayName: avdName ?? record.model ?? record.device ?? record.product ?? record.serial,
            ...(avdName ? { avdName } : {}),
        };
    }));
    if (input.emulatorCommand) {
        const avds = await input.run({ command: input.emulatorCommand, args: ['-list-avds'], signal: input.signal });
        if (avds.exitCode === 0) {
            const runningNames = new Set(devices.flatMap((device) => device.avdName ? [device.avdName] : []));
            for (const name of new Set(avds.stdout.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean))) {
                if (runningNames.has(name)) continue;
                devices.push({ serial: `avd:${name}`, kind: 'emulator', state: 'stopped', displayName: name, avdName: name });
            }
        } else diagnostics.push(failure('android_avd_inventory_failed', avds));
    }
    return { devices, diagnostics };
}
