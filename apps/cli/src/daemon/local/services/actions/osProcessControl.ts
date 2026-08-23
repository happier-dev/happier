import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { taskkillWindowsProcessTree } from '@/subprocess/supervision/taskkillWindowsProcessTree';
import type { NormalizedLocalServiceInventorySnapshot } from '../inventory/scanner';
import type {
    TerminateListenerProbeInput,
    TerminateListenerProbeResult,
    TerminateProcessControl,
    TerminateProcessSignalInput,
    TerminateProcessSignalOutcome,
    TerminateWindowsTreeInput,
} from './terminate';

/**
 * Real OS process-control adapter backing {@link TerminateDetectedService} (LSV-5).
 *
 * This is the system boundary the terminate orchestration injects: process signals, descendant
 * resolution, liveness probes, listener re-resolution (for TOCTOU revalidation), and the Windows
 * `taskkill` tree kill. Keeping it isolated lets the orchestration logic stay deterministically
 * unit-tested while the daemon supplies these real implementations.
 *
 * Listener re-resolution goes through the daemon's **existing** single-flight inventory refresh
 * rather than a raw platform scan, so a terminate coalesces onto the same machine-wide
 * `lsof`/`/proc`/`netstat` pass the inventory loop already runs instead of stacking its own.
 * There is deliberately no second single-flight owner here.
 */

export type OsProcessControlExecFile = (
    command: string,
    args: readonly string[],
    options: Readonly<{ timeout: number; maxBuffer: number }>,
) => Promise<Readonly<{ stdout: string | Buffer }>>;

export type CreateOsProcessControlInput = Readonly<{
    /**
     * The daemon's coalescing inventory refresh. Sharing it keeps TOCTOU re-resolution on live
     * truth without adding scans: concurrent callers await the same in-flight pass.
     */
    refreshInventory: () => Promise<NormalizedLocalServiceInventorySnapshot>;
    platform?: NodeJS.Platform;
    wait?: (ms: number) => Promise<void>;
    /** Signal boundary; injected in tests to exercise ESRCH/EPERM classification. */
    kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
    /** Process-table boundary used for POSIX descendant resolution. */
    execFile?: OsProcessControlExecFile;
}>;

const PROCESS_TABLE_TIMEOUT_MS = 2_000;
const PROCESS_TABLE_MAX_BUFFER = 4 * 1024 * 1024;

function resolvePlatform(platform: NodeJS.Platform): 'posix' | 'windows' {
    return platform === 'win32' ? 'windows' : 'posix';
}

function hostsCompatible(scanned: string, requested: string): boolean {
    if (scanned === requested) return true;
    // A wildcard listener (`0.0.0.0`/`::`/`*`) answers loopback requests for the same port.
    return scanned === '0.0.0.0' || scanned === '::' || scanned === '*';
}

async function defaultWait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

function stdoutText(result: Readonly<{ stdout: string | Buffer }>): string {
    return typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
}

/** `ps -A -o pid=,ppid=` -> child pids indexed by parent. */
export function parsePosixProcessParentTable(output: string): ReadonlyMap<number, readonly number[]> {
    const childrenByParent = new Map<number, number[]>();
    for (const line of output.split(/\r?\n/u)) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
        if (!match?.[1] || !match[2]) continue;
        const pid = Number(match[1]);
        const ppid = Number(match[2]);
        if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue;
        const siblings = childrenByParent.get(ppid);
        if (siblings) {
            siblings.push(pid);
        } else {
            childrenByParent.set(ppid, [pid]);
        }
    }
    return childrenByParent;
}

/**
 * Transitive descendants of `pid`. Excludes the daemon's own pid and pids 0/1 so a malformed
 * process table can never turn a service terminate into self-termination.
 */
export function collectProcessDescendants(input: Readonly<{
    pid: number;
    childrenByParent: ReadonlyMap<number, readonly number[]>;
    selfPid: number;
}>): readonly number[] {
    const descendants: number[] = [];
    const visited = new Set<number>([input.pid]);
    const frontier: number[] = [input.pid];
    while (frontier.length > 0) {
        const parent = frontier.pop() as number;
        for (const child of input.childrenByParent.get(parent) ?? []) {
            if (visited.has(child) || child <= 1 || child === input.selfPid) continue;
            visited.add(child);
            descendants.push(child);
            frontier.push(child);
        }
    }
    return descendants;
}

export function createOsProcessControl(input: CreateOsProcessControlInput): TerminateProcessControl {
    const platform = resolvePlatform(input.platform ?? process.platform);
    const wait = input.wait ?? defaultWait;
    const kill = input.kill ?? ((pid, signal) => {
        process.kill(pid, signal);
    });
    const execFile = input.execFile ?? (async (command, args, options) => {
        const result = await promisify(execFileCallback)(command, [...args], options);
        return { stdout: result.stdout };
    });

    async function probeListener(probe: TerminateListenerProbeInput): Promise<TerminateListenerProbeResult> {
        let snapshot = await input.refreshInventory();
        if (typeof probe.notBefore === 'number' && snapshot.generatedAt < probe.notBefore) {
            // The single-flight refresh handed us a pass that started before this request. One
            // re-read is enough: the previous pass has settled, so the next one is ours.
            snapshot = await input.refreshInventory();
            if (snapshot.generatedAt < probe.notBefore) {
                return { status: 'indeterminate' };
            }
        }
        if (snapshot.refreshState === 'error') {
            // A failed listener scan retains the previous entries verbatim, still marked
            // `listening`. Reading that as truth would revalidate identity against stale facts.
            return { status: 'indeterminate' };
        }
        const matches = snapshot.entries.filter(
            (entry) => entry.state === 'listening' && entry.port === probe.port,
        );
        const exact = matches.find((entry) => entry.address.host === probe.host);
        const chosen = exact ?? matches.find((entry) => hostsCompatible(entry.address.host, probe.host));
        if (!chosen) return { status: 'free' };
        const listenerProcess = chosen.provenance?.process;
        if (!listenerProcess) {
            // Something holds the port but the scan could not attribute it to a pid.
            return { status: 'indeterminate' };
        }
        return {
            status: 'held',
            identity: {
                pid: listenerProcess.pid,
                ...(typeof listenerProcess.processStartTimeMs === 'number'
                    ? { startTime: listenerProcess.processStartTimeMs }
                    : {}),
                ...(listenerProcess.command ? { command: listenerProcess.command } : {}),
                ...(listenerProcess.cwd ? { cwd: listenerProcess.cwd } : {}),
            },
        };
    }

    async function resolveDescendantPids(pid: number): Promise<readonly number[]> {
        if (platform === 'windows') return [];
        try {
            const result = await execFile('ps', ['-A', '-o', 'pid=,ppid='], {
                timeout: PROCESS_TABLE_TIMEOUT_MS,
                maxBuffer: PROCESS_TABLE_MAX_BUFFER,
            });
            return collectProcessDescendants({
                pid,
                childrenByParent: parsePosixProcessParentTable(stdoutText(result)),
                selfPid: process.pid,
            });
        } catch {
            // The process table is unavailable: signal the listener pid alone and let the
            // port-release verification report what actually happened.
            return [];
        }
    }

    async function isProcessAlive(pid: number): Promise<boolean> {
        try {
            // Signal 0 performs no kill but throws ESRCH when the pid is gone.
            kill(pid, 0);
            return true;
        } catch (error) {
            // A process we may not signal still exists. POSIX reports EPERM; libuv maps the
            // Windows `OpenProcess` access denial to EACCES.
            const code = (error as NodeJS.ErrnoException).code;
            return code === 'EPERM' || code === 'EACCES';
        }
    }

    async function signal(signalInput: TerminateProcessSignalInput): Promise<TerminateProcessSignalOutcome> {
        const targets = [signalInput.pid, ...signalInput.descendantPids.filter((pid) => (
            Number.isInteger(pid) && pid > 1 && pid !== signalInput.pid && pid !== process.pid
        ))];
        const deliveredPids: number[] = [];
        let permissionDenied = false;
        let failed = false;
        for (const target of targets) {
            try {
                kill(target, signalInput.signal);
                deliveredPids.push(target);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                // ESRCH on an individual pid means that process already exited between the scan
                // and the signal — benign, and the only ESRCH we absorb. It is recorded as "not
                // delivered" so an all-ESRCH round cannot masquerade as a successful kill.
                if (code === 'ESRCH') continue;
                if (code === 'EPERM' || code === 'EACCES') {
                    if (target === signalInput.pid) permissionDenied = true;
                    continue;
                }
                if (target === signalInput.pid) failed = true;
            }
        }
        if (permissionDenied) return { status: 'permission_denied' };
        if (failed) return { status: 'failed' };
        return deliveredPids.length > 0
            ? { status: 'delivered', deliveredPids }
            : { status: 'no_process_signaled' };
    }

    async function terminateWindowsTree(treeInput: TerminateWindowsTreeInput): Promise<void> {
        await taskkillWindowsProcessTree(treeInput);
    }

    return {
        platform,
        probeListener,
        resolveDescendantPids,
        isProcessAlive,
        signal,
        terminateWindowsTree,
        wait,
    };
}
