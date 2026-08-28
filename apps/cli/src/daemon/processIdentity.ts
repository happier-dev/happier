import { readFile, readdir, readlink } from 'node:fs/promises';

import { execFileWithDeadline } from '@happier-dev/cli-common/process';

import { parseProcessCustodyStartIdentity } from '@/subprocess/supervision/processCustody';
import {
    readDarwinProcessFacts,
    type DarwinExecFileBoundary,
} from './local/services/inventory/platform/darwin';
import {
    readLinuxProcessFacts,
    type LinuxProcfsBoundary,
} from './local/services/inventory/platform/linux';
import {
    type WindowsExecFileBoundary,
} from './local/services/inventory/platform/windows';
import type { LocalServiceProcessFact } from './local/services/inventory/provenance';
import {
    readWindowsProcessInventory,
    type WindowsProcessInventoryFact,
} from './platform/windows/windowsProcessInventory';

type SupportedProcessIdentityPlatform = 'darwin' | 'linux' | 'win32';

export type ReadProcessIdentityByPidDependencies = Readonly<{
    platform?: NodeJS.Platform;
    linuxBoundary?: LinuxProcfsBoundary;
    execFile?: DarwinExecFileBoundary & WindowsExecFileBoundary;
}>;

function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedProcessIdentityPlatform {
    return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

function isValidProcessStartTimeMs(value: number | undefined): value is number {
    return Number.isInteger(value) && (value ?? -1) >= 0;
}

/**
 * Process start time is the cross-platform process-generation witness. Command
 * lines can legitimately change while a process remains the same generation.
 */
export function processGenerationMatches(
    expectedProcessStartTimeMs: number | undefined,
    observedProcessStartTimeMs: number | undefined,
): boolean {
    return isValidProcessStartTimeMs(expectedProcessStartTimeMs)
        && isValidProcessStartTimeMs(observedProcessStartTimeMs)
        && expectedProcessStartTimeMs === observedProcessStartTimeMs;
}

export function processGenerationProvesReuse(
    expectedProcessStartTimeMs: number | undefined,
    observedProcessStartTimeMs: number | undefined,
): boolean {
    return isValidProcessStartTimeMs(expectedProcessStartTimeMs)
        && isValidProcessStartTimeMs(observedProcessStartTimeMs)
        && expectedProcessStartTimeMs !== observedProcessStartTimeMs;
}

/** Persisted process generation encoded as the observed pid and process start time. */
type ParsedProcessGenerationIdentity = Readonly<{ pid: number; startMs: number }>;

function parseProcessGenerationIdentity(
    value: string,
): ParsedProcessGenerationIdentity | null {
    const match = /^(\d+):(\d+)$/u.exec(value);
    if (!match?.[1] || !match[2]) return null;
    const pid = Number(match[1]);
    const startMs = Number(match[2]);
    if (
        !Number.isSafeInteger(pid)
        || pid <= 0
        || !Number.isSafeInteger(startMs)
        || startMs < 0
    ) return null;
    return { pid, startMs };
}

/**
 * Compare two tagged native-custody identities owned by the processCustody
 * module (Windows job custody, Darwin subsecond start identity). A tag always
 * decides exactly — the whole-second ambiguity below exists only for legacy
 * `ps lstart` records — except when the two sides are not even the same tag
 * family or a pid disagrees, which stays fenced.
 */
function compareTaggedProcessGenerationIdentities(
    expectedIdentity: string,
    observedIdentity: string,
): ProcessGenerationIdentityComparison | null {
    const expectedTagged = parseProcessCustodyStartIdentity(expectedIdentity);
    const observedTagged = parseProcessCustodyStartIdentity(observedIdentity);
    if (!expectedTagged && !observedTagged) return null;
    if (
        expectedTagged?.kind === 'win32-job'
        && observedTagged?.kind === 'win32-job'
    ) {
        // Job names are generation-unique: the same name proves the same
        // custody generation, a different name proves a different one.
        return expectedTagged.jobName === observedTagged.jobName ? 'same' : 'reused';
    }
    if (
        expectedTagged?.kind === 'darwin-proc'
        && observedTagged?.kind === 'darwin-proc'
    ) {
        if (expectedTagged.pid !== observedTagged.pid) return 'ambiguous';
        // The native timeval includes the subsecond field, so an equal pair
        // proves the exact generation and any difference proves reuse — even
        // within one wall-clock second, which is exactly what the legacy
        // whole-second witness could never decide.
        return expectedTagged.sec === observedTagged.sec && expectedTagged.usec === observedTagged.usec
            ? 'same'
            : 'reused';
    }
    // One side tagged and the other a legacy record (or malformed): the pair
    // cannot decide, so custody fences instead of acting.
    return 'ambiguous';
}

export type ProcessGenerationIdentityComparison =
    /** Both sides prove the exact same process generation. */
    | 'same'
    /** Both sides prove the pid now names a different generation. */
    | 'reused'
    /** The evidence cannot decide; custody must fence instead of acting. */
    | 'ambiguous';

/**
 * Compare a persisted generation identity against a fresh observation of the same-number pid.
 *
 * The verdict is honest about resolution: Linux/Windows start facts decide equality, while an
 * equal whole-second Darwin observation remains ambiguous because it cannot exclude same-second
 * pid reuse. 'ambiguous' is the fail-closed answer — it never authorizes signaling or reaping.
 */
export function compareProcessGenerationIdentities(
    expectedIdentity: string,
    observedIdentity: string,
    platform: NodeJS.Platform = process.platform,
): ProcessGenerationIdentityComparison {
    const taggedComparison = compareTaggedProcessGenerationIdentities(
        expectedIdentity,
        observedIdentity,
    );
    if (taggedComparison !== null) return taggedComparison;
    const expected = parseProcessGenerationIdentity(expectedIdentity);
    const observed = parseProcessGenerationIdentity(observedIdentity);
    if (
        !expected
        || !observed
        || expected.pid !== observed.pid
        || expected.pid <= 0
    ) return 'ambiguous';
    if (expected.startMs !== observed.startMs) return 'reused';
    return platform === 'darwin' ? 'ambiguous' : 'same';
}

function normalizeExactProcessIdentity(
    requestedPid: number,
    processIdentity:
        | LocalServiceProcessFact
        | WindowsProcessInventoryFact
        | null,
): (LocalServiceProcessFact & { name?: string }) | null {
    if (!processIdentity || processIdentity.pid !== requestedPid) return null;
    const processStartTimeMs = processIdentity.processStartTimeMs;
    const command = processIdentity.command?.trim() ?? '';
    if (
        !Number.isFinite(processStartTimeMs)
        || !Number.isInteger(processStartTimeMs)
        || (processStartTimeMs ?? -1) < 0
        || !command
        || command.toLowerCase() === 'unknown'
    ) {
        return null;
    }
    return {
        ...processIdentity,
        processStartTimeMs,
        command,
    };
}

export async function readProcessIdentityByPid(
    pid: number,
    dependencies: ReadProcessIdentityByPidDependencies = {},
): Promise<LocalServiceProcessFact | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;

    const platform = dependencies.platform ?? process.platform;
    if (!isSupportedPlatform(platform)) return null;

    try {
        if (platform === 'linux') {
            const processes = await readLinuxProcessFacts(
                dependencies.linuxBoundary ?? { readFile, readdir, readlink },
                [pid],
            );
            return normalizeExactProcessIdentity(pid, processes.get(pid) ?? null);
        }

        // A `child_process` `timeout` reports a killed `ps`/`powershell` as a SUCCESS with empty
        // stdout on a stalled loop, which lands here as "this pid has no process row" — the same
        // answer as a dead pid. Every generation check downstream (reattach, runner lock,
        // heartbeat, spawn markers) then reads a live runner as unidentifiable.
        const execFileBoundary = dependencies.execFile ?? execFileWithDeadline;
        const processes = platform === 'darwin'
            ? await readDarwinProcessFacts({ execFile: execFileBoundary, pids: [pid] })
            : await readWindowsProcessInventory({ execFile: execFileBoundary, pids: [pid] });
        return normalizeExactProcessIdentity(pid, processes.get(pid) ?? null);
    } catch {
        return null;
    }
}
