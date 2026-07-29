import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter as PATH_DELIMITER, join } from 'node:path';

import {
    defaultAndroidToolRunner,
    type AndroidToolRunner,
} from './process';

export type { AndroidToolRunner };

const ADB_PROBE_TIMEOUT_MS = 2_000;
const MAX_DIAGNOSTIC_OUTPUT_BYTES = 512;

export type AndroidAdbResolutionSource =
    | 'env_override'
    | 'android_sdk'
    | 'path'
    | 'unavailable';

export type AndroidAdbToolingResolution = Readonly<
    | { ok: true; command: string; source: Exclude<AndroidAdbResolutionSource, 'unavailable'>; version?: string }
    | { ok: false; reasonCode: 'adb_unavailable'; diagnostics: readonly Record<string, unknown>[] }
>;

export type AndroidAdbDeviceRecord = Readonly<{
    serial: string;
    state: 'device' | 'offline' | 'unauthorized' | 'unknown';
    transportId?: string;
    model?: string;
    product?: string;
    device?: string;
    raw: string;
}>;

export type AndroidAdbToolingResolverInput = Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    pathExists?: (path: string) => Promise<boolean> | boolean;
    findOnPath?: (command: string, env: Readonly<Record<string, string | undefined>>) => Promise<string | null> | string | null;
    runner?: AndroidToolRunner;
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

type AndroidAdbCandidate = Readonly<{
    command: string;
    source: Exclude<AndroidAdbResolutionSource, 'unavailable'>;
}>;

function adbExecutableName(): string {
    return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

function readNonEmpty(value: string | undefined): string | null {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
}

async function defaultPathExists(path: string): Promise<boolean> {
    try {
        await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

async function defaultFindOnPath(
    command: string,
    env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
    const pathRaw = readNonEmpty(env.PATH);
    if (!pathRaw) return null;
    const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
    const commandNames = process.platform === 'win32' && !command.toLowerCase().endsWith('.exe')
        ? [command, `${command}.exe`]
        : [command];

    for (const directory of pathRaw.split(PATH_DELIMITER).map((entry) => entry.trim()).filter(Boolean)) {
        for (const commandName of commandNames) {
            const candidate = join(directory, commandName);
            try {
                await access(candidate, accessMode);
                return candidate;
            } catch {
                // Continue scanning PATH.
            }
        }
    }
    return null;
}

function boundDiagnosticOutput(value: string): string {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.byteLength <= MAX_DIAGNOSTIC_OUTPUT_BYTES) return value;
    return bytes.subarray(0, MAX_DIAGNOSTIC_OUTPUT_BYTES).toString('utf8');
}

function parseAdbVersion(stdout: string): string | undefined {
    const match = /\bAndroid Debug Bridge version\s+([^\s]+)/i.exec(stdout)
        ?? /\bVersion\s+([^\s]+)/i.exec(stdout);
    return match?.[1];
}

function normalizeAdbState(state: string): AndroidAdbDeviceRecord['state'] {
    if (state === 'device' || state === 'offline' || state === 'unauthorized') return state;
    return 'unknown';
}

export function parseAdbDevicesLongOutput(stdout: string): Readonly<{
    records: readonly AndroidAdbDeviceRecord[];
    diagnostics: readonly Record<string, unknown>[];
}> {
    const records: AndroidAdbDeviceRecord[] = [];
    const diagnostics: Record<string, unknown>[] = [];

    for (const rawLine of stdout.split(/\r?\n/)) {
        const raw = rawLine.trim();
        if (!raw || raw === 'List of devices attached') continue;

        const parts = raw.split(/\s+/);
        if (parts.length < 2 || parts[0] === undefined || parts[1] === undefined) {
            diagnostics.push({
                platform: 'android',
                severity: 'warning',
                reasonCode: 'malformed_adb_devices_output',
                raw,
            });
            continue;
        }

        const serial = parts[0].trim();
        const state = parts[1].trim();
        if (!serial || !state) {
            diagnostics.push({
                platform: 'android',
                severity: 'warning',
                reasonCode: 'malformed_adb_devices_output',
                raw,
            });
            continue;
        }

        const record: {
            serial: string;
            state: AndroidAdbDeviceRecord['state'];
            transportId?: string;
            model?: string;
            product?: string;
            device?: string;
            raw: string;
        } = {
            serial,
            state: normalizeAdbState(state),
            raw,
        };

        for (const token of parts.slice(2)) {
            const separator = token.indexOf(':');
            if (separator <= 0) continue;
            const key = token.slice(0, separator);
            const value = token.slice(separator + 1);
            if (!value) continue;
            if (key === 'transport_id') record.transportId = value;
            if (key === 'model') record.model = value;
            if (key === 'product') record.product = value;
            if (key === 'device') record.device = value;
        }

        records.push(record);
    }

    return { records, diagnostics };
}

async function collectCandidates(input: Required<Pick<AndroidAdbToolingResolverInput, 'pathExists' | 'findOnPath'>> & Readonly<{
    env: Readonly<Record<string, string | undefined>>;
}>): Promise<Readonly<{ candidates: readonly AndroidAdbCandidate[]; diagnostics: readonly Record<string, unknown>[] }>> {
    const diagnostics: Record<string, unknown>[] = [];
    const candidates: AndroidAdbCandidate[] = [];
    const explicitAdb = readNonEmpty(input.env.HAPPIER_ANDROID_ADB_PATH) ?? readNonEmpty(input.env.ANDROID_ADB_PATH);
    if (explicitAdb) {
        if (await input.pathExists(explicitAdb)) {
            candidates.push({ command: explicitAdb, source: 'env_override' });
            return { candidates, diagnostics };
        }
        diagnostics.push({
            platform: 'android',
            severity: 'warning',
            reasonCode: 'adb_candidate_missing',
            source: 'env_override',
            command: explicitAdb,
        });
    }

    const sdkRoots = [
        readNonEmpty(input.env.ANDROID_HOME),
        readNonEmpty(input.env.ANDROID_SDK_ROOT),
    ].filter((root): root is string => root !== null);
    for (const sdkRoot of sdkRoots) {
        const sdkAdb = join(sdkRoot, 'platform-tools', adbExecutableName());
        if (await input.pathExists(sdkAdb)) {
            candidates.push({ command: sdkAdb, source: 'android_sdk' });
            return { candidates, diagnostics };
        }
        diagnostics.push({
            platform: 'android',
            severity: 'info',
            reasonCode: 'adb_candidate_missing',
            source: 'android_sdk',
            command: sdkAdb,
        });
    }

    const pathAdb = await input.findOnPath(adbExecutableName(), input.env);
    if (pathAdb) {
        candidates.push({ command: pathAdb, source: 'path' });
    }
    return { candidates, diagnostics };
}

export async function resolveAndroidAdbTooling(input: AndroidAdbToolingResolverInput = {}): Promise<AndroidAdbToolingResolution> {
    const env = input.env ?? process.env;
    const pathExists = input.pathExists ?? defaultPathExists;
    const findOnPath = input.findOnPath ?? defaultFindOnPath;
    const runner = input.runner ?? defaultAndroidToolRunner;
    const timeoutMs = input.timeoutMs ?? ADB_PROBE_TIMEOUT_MS;
    const candidateResult = await collectCandidates({ env, pathExists, findOnPath });
    const [candidate] = candidateResult.candidates;

    if (!candidate) {
        return {
            ok: false,
            reasonCode: 'adb_unavailable',
            diagnostics: [
                ...candidateResult.diagnostics,
                {
                    platform: 'android',
                    severity: 'error',
                    reasonCode: 'adb_unavailable',
                    source: 'unavailable',
                },
            ],
        };
    }

    try {
        const probe = await runner({
            command: candidate.command,
            args: ['version'],
            timeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (probe.exitCode === 0) {
            return {
                ok: true,
                command: candidate.command,
                source: candidate.source,
                ...(parseAdbVersion(probe.stdout) ? { version: parseAdbVersion(probe.stdout) } : {}),
            };
        }

        return {
            ok: false,
            reasonCode: 'adb_unavailable',
            diagnostics: [
                ...candidateResult.diagnostics,
                {
                    platform: 'android',
                    severity: 'error',
                    reasonCode: 'adb_unavailable',
                    source: candidate.source,
                    command: candidate.command,
                    probe: 'adb version',
                    exitCode: probe.exitCode,
                    stdout: boundDiagnosticOutput(probe.stdout),
                    stderr: boundDiagnosticOutput(probe.stderr),
                    ...(probe.timedOut ? { timedOut: true } : {}),
                    ...(probe.aborted ? { aborted: true } : {}),
                },
            ],
        };
    } catch (error) {
        return {
            ok: false,
            reasonCode: 'adb_unavailable',
            diagnostics: [
                ...candidateResult.diagnostics,
                {
                    platform: 'android',
                    severity: 'error',
                    reasonCode: 'adb_unavailable',
                    source: candidate.source,
                    command: candidate.command,
                    probe: 'adb version',
                    errorName: error instanceof Error ? error.name : 'UnknownError',
                },
            ],
        };
    }
}
