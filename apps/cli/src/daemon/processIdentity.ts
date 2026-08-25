import { readFile, readdir, readlink } from 'node:fs/promises';

import { execFileWithDeadline } from '@happier-dev/cli-common/process';

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
