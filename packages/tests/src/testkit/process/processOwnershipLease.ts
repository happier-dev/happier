import { spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { repoRootDir } from '../paths';
import { terminateProcessTreeByPid } from './processTree';

export type ProcessInspectionResult =
    | {
        ok: true;
        command: string;
        startTime: string;
    }
    | {
        ok: false;
        reason: 'not_found' | 'ps_missing' | 'inspect_failed';
    };

export type ProcessOwnershipLease<TMetadata = unknown> = Readonly<{
    childPid: number;
    childStartTime: string;
    ownerPid: number;
    ownerStartTime: string;
    createdAtMs: number;
    metadata?: TMetadata;
}>;

export function inspectOwnedProcess(pid: number): ProcessInspectionResult {
    if (!Number.isInteger(pid) || pid <= 1) {
        return { ok: false, reason: 'not_found' };
    }

    try {
        let commandRes = spawnSync('ps', ['-o', 'args=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
        if (commandRes.status !== 0) {
            commandRes = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
        }
        if (commandRes.status !== 0) {
            return { ok: false, reason: 'not_found' };
        }

        let startTimeRes = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
        if (startTimeRes.status !== 0) {
            startTimeRes = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
        }
        if (startTimeRes.status !== 0) {
            return { ok: false, reason: 'inspect_failed' };
        }

        const command = String(commandRes.stdout || '').trim();
        const startTime = String(startTimeRes.stdout || '').trim();
        if (!command || !startTime) {
            return { ok: false, reason: 'inspect_failed' };
        }

        return {
            ok: true,
            command,
            startTime,
        };
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'ENOENT') return { ok: false, reason: 'ps_missing' };
        return { ok: false, reason: 'inspect_failed' };
    }
}

export async function waitForOwnedProcessInspection(
    pid: number,
    timeoutMs = 2_000,
    inspectProcess: (pid: number) => ProcessInspectionResult = inspectOwnedProcess,
): Promise<Extract<ProcessInspectionResult, { ok: true }> | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const inspection = inspectProcess(pid);
        if (inspection.ok) return inspection;
        if (inspection.reason === 'ps_missing' || inspection.reason === 'not_found') return null;
        await sleep(50);
    }
    return null;
}

export function resolveProcessOwnershipLeasesDir(params: {
    rootDir?: string;
    leaseKind: string;
}): string {
    return resolve(params.rootDir ?? repoRootDir(), '.project', 'tmp', `${params.leaseKind}-processes`);
}

function resolveProcessOwnershipLeasePath(params: {
    rootDir?: string;
    leaseKind: string;
    childPid: number;
}): string {
    return resolve(resolveProcessOwnershipLeasesDir(params), `pid-${params.childPid}.json`);
}

function parseProcessOwnershipLease(raw: string): ProcessOwnershipLease | null {
    try {
        const parsed = JSON.parse(raw) as Partial<ProcessOwnershipLease> | null;
        if (!parsed || typeof parsed !== 'object') return null;

        const childPid = typeof parsed.childPid === 'number' ? parsed.childPid : Number(parsed.childPid);
        const ownerPid = typeof parsed.ownerPid === 'number' ? parsed.ownerPid : Number(parsed.ownerPid);
        const createdAtMs = typeof parsed.createdAtMs === 'number' ? parsed.createdAtMs : Number(parsed.createdAtMs);
        const childStartTime = typeof parsed.childStartTime === 'string' ? parsed.childStartTime.trim() : '';
        const ownerStartTime = typeof parsed.ownerStartTime === 'string' ? parsed.ownerStartTime.trim() : '';

        if (!Number.isInteger(childPid) || childPid <= 1) return null;
        if (!Number.isInteger(ownerPid) || ownerPid <= 1) return null;
        if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
        if (!childStartTime || !ownerStartTime) return null;

        return {
            childPid,
            childStartTime,
            ownerPid,
            ownerStartTime,
            createdAtMs,
            metadata: parsed.metadata,
        };
    } catch {
        return null;
    }
}

async function listProcessOwnershipLeaseCandidates(params: {
    rootDir?: string;
    leaseKind: string;
}): Promise<Array<{ lease: ProcessOwnershipLease; path: string }>> {
    const leasesDir = resolveProcessOwnershipLeasesDir(params);
    let entries: string[] = [];
    try {
        entries = await readdir(leasesDir);
    } catch {
        return [];
    }

    const candidates: Array<{ lease: ProcessOwnershipLease; path: string }> = [];
    for (const entry of entries) {
        if (!entry.startsWith('pid-') || !entry.endsWith('.json')) continue;
        const path = resolve(leasesDir, entry);
        try {
            const raw = await readFile(path, 'utf8');
            const lease = parseProcessOwnershipLease(raw);
            if (!lease) continue;
            candidates.push({ lease, path });
        } catch {
            // ignore unreadable lease markers
        }
    }
    return candidates;
}

export async function sweepProcessOwnershipLeases(params: {
    rootDir?: string;
    leaseKind: string;
    currentOwnerPid: number;
    currentOwnerStartTime: string | null;
    inspectProcess?: (pid: number) => ProcessInspectionResult;
    terminateProcessTreeByPid?: typeof terminateProcessTreeByPid;
    isOwnedProcessCommand: (command: string, lease: ProcessOwnershipLease) => boolean;
}): Promise<void> {
    if (process.platform === 'win32') return;
    if (!Number.isInteger(params.currentOwnerPid) || params.currentOwnerPid <= 1) return;
    if (!params.currentOwnerStartTime) return;

    const inspectProcess = params.inspectProcess ?? inspectOwnedProcess;
    const terminate = params.terminateProcessTreeByPid ?? terminateProcessTreeByPid;
    const candidates = await listProcessOwnershipLeaseCandidates({
        rootDir: params.rootDir,
        leaseKind: params.leaseKind,
    });

    for (const candidate of candidates) {
        const { lease, path } = candidate;
        if (lease.ownerPid === params.currentOwnerPid && lease.ownerStartTime === params.currentOwnerStartTime) {
            continue;
        }

        const ownerInfo = inspectProcess(lease.ownerPid);
        if (ownerInfo.ok && ownerInfo.startTime === lease.ownerStartTime) {
            continue;
        }

        const childInfo = inspectProcess(lease.childPid);
        if (!childInfo.ok) {
            if (childInfo.reason === 'not_found') {
                try {
                    unlinkSync(path);
                } catch {
                    // ignore
                }
            }
            continue;
        }

        if (childInfo.startTime !== lease.childStartTime) {
            continue;
        }
        if (!params.isOwnedProcessCommand(childInfo.command, lease)) {
            continue;
        }

        await terminate(lease.childPid, { graceMs: 3_000, pollMs: 50 }).catch(() => {});
        try {
            unlinkSync(path);
        } catch {
            // ignore
        }
    }
}

export async function writeProcessOwnershipLease<TMetadata = unknown>(params: {
    rootDir?: string;
    leaseKind: string;
    childPid: number;
    childStartTime: string;
    ownerPid: number;
    ownerStartTime: string;
    metadata?: TMetadata;
}): Promise<string> {
    const leasesDir = resolveProcessOwnershipLeasesDir({
        rootDir: params.rootDir,
        leaseKind: params.leaseKind,
    });
    mkdirSync(leasesDir, { recursive: true });

    const leasePath = resolveProcessOwnershipLeasePath({
        rootDir: params.rootDir,
        leaseKind: params.leaseKind,
        childPid: params.childPid,
    });

    writeFileSync(
        leasePath,
        JSON.stringify(
            {
                childPid: params.childPid,
                childStartTime: params.childStartTime,
                ownerPid: params.ownerPid,
                ownerStartTime: params.ownerStartTime,
                createdAtMs: Date.now(),
                ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
            },
            null,
            2,
        ),
        'utf8',
    );

    return leasePath;
}

export async function registerProcessOwnershipLease<TMetadata = unknown>(params: {
    rootDir?: string;
    leaseKind: string;
    child: Pick<ChildProcess, 'pid' | 'once'>;
    ownerPid: number;
    ownerStartTime: string | null;
    inspectProcess?: (pid: number) => ProcessInspectionResult;
    metadata?: TMetadata;
}): Promise<{
    leasePath: string | null;
    removeLease: () => void;
}> {
    let leasePath: string | null = null;

    const removeLease = () => {
        if (!leasePath) return;
        try {
            unlinkSync(leasePath);
        } catch {
            // ignore
        }
        leasePath = null;
    };

    if (!params.ownerStartTime) {
        return { leasePath, removeLease };
    }
    if (!Number.isInteger(params.child.pid) || (params.child.pid ?? 0) <= 1) {
        return { leasePath, removeLease };
    }
    const childPid = params.child.pid;
    if (typeof childPid !== 'number') {
        return { leasePath, removeLease };
    }

    const childInspection = await waitForOwnedProcessInspection(
        childPid,
        2_000,
        params.inspectProcess ?? inspectOwnedProcess,
    );
    if (!childInspection) {
        return { leasePath, removeLease };
    }

    leasePath = await writeProcessOwnershipLease({
        rootDir: params.rootDir,
        leaseKind: params.leaseKind,
        childPid,
        childStartTime: childInspection.startTime,
        ownerPid: params.ownerPid,
        ownerStartTime: params.ownerStartTime,
        metadata: params.metadata,
    });

    params.child.once('exit', removeLease);
    return { leasePath, removeLease };
}
