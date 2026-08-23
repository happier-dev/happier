import { LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH, type LocalServiceProcessFact } from '../provenance';
import type { LocalServiceListenerFact } from '../scanner';
import type { LocalServiceInventoryDiagnostic } from '../scanner';
import { collectLocalServiceProcessLineageFacts } from './processLineage';
import { classifyPosixProcessOwnership, resolveDaemonPosixUserId } from './processOwnership';

type ProcNetInput = Readonly<{
    tcp4: string;
    tcp6: string;
    inodeToPid: ReadonlyMap<string, number>;
}>;

export type LinuxProcfsBoundary = Readonly<{
    procRoot?: string;
    readFile(path: string, encoding: 'utf8'): Promise<string | Buffer>;
    readdir(path: string): Promise<readonly string[]>;
    readlink(path: string): Promise<string>;
    /** Clock for the scan deadline; injected in tests. */
    now?: () => number;
    /**
     * Wall-clock budget for the `/proc` fd walk. macOS and Windows already bound their scans at
     * two seconds; Linux had none, so a machine with many processes could hold the inventory
     * loop open indefinitely. On expiry the scan returns what it resolved plus a warning
     * diagnostic rather than an empty result.
     */
    deadlineMs?: number;
    daemonUserId?: string;
}>;

export type LinuxLocalServiceScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

const DEFAULT_LINUX_SCAN_DEADLINE_MS = 2_000;
const PROC_FD_SCAN_CHUNK = 32;

function parseHexPort(value: string): number | null {
    const port = Number.parseInt(value, 16);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function parseIpv4Hex(value: string): string | null {
    if (!/^[0-9a-f]{8}$/iu.test(value)) return null;
    const bytes = value.match(/../gu);
    if (!bytes || bytes.length !== 4) return null;
    return bytes.reverse().map((byte) => Number.parseInt(byte, 16)).join('.');
}

function parseIpv6Hex(value: string): string | null {
    if (!/^[0-9a-f]{32}$/iu.test(value)) return null;
    const bytes: string[] = [];
    for (let offset = 0; offset < value.length; offset += 8) {
        const word = value.slice(offset, offset + 8);
        bytes.push(word.slice(6, 8), word.slice(4, 6), word.slice(2, 4), word.slice(0, 2));
    }

    const hextets: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 2) {
        hextets.push(Number.parseInt(`${bytes[offset]}${bytes[offset + 1]}`, 16).toString(16));
    }

    return compressIpv6Hextets(hextets);
}

function compressIpv6Hextets(hextets: readonly string[]): string {
    let bestStart = -1;
    let bestLength = 0;
    for (let index = 0; index < hextets.length;) {
        if (hextets[index] !== '0') {
            index += 1;
            continue;
        }
        const start = index;
        while (index < hextets.length && hextets[index] === '0') index += 1;
        const length = index - start;
        if (length > bestLength) {
            bestStart = start;
            bestLength = length;
        }
    }

    if (bestLength < 2) return hextets.join(':');

    const before = hextets.slice(0, bestStart).join(':');
    const after = hextets.slice(bestStart + bestLength).join(':');
    if (!before && !after) return '::';
    if (!before) return `::${after}`;
    if (!after) return `${before}::`;
    return `${before}::${after}`;
}

type LinuxListeningSocketRow = Readonly<{ address: string; port: number; inode: string }>;

function parseProcNetTcpRows(content: string, family: 'ipv4' | 'ipv6'): LinuxListeningSocketRow[] {
    const rows: LinuxListeningSocketRow[] = [];
    const lines = content.split(/\r?\n/u).slice(1);

    for (const rawLine of lines) {
        const columns = rawLine.trim().split(/\s+/u);
        if (columns.length < 10) continue;
        const localAddress = columns[1];
        const state = columns[3];
        const inode = columns[9];
        if (!localAddress || state !== '0A' || !inode) continue;

        const [addressHex, portHex] = localAddress.split(':');
        if (!addressHex || !portHex) continue;

        const port = parseHexPort(portHex);
        const address = family === 'ipv4' ? parseIpv4Hex(addressHex) : parseIpv6Hex(addressHex);
        if (port == null || !address) continue;

        rows.push({ address, port, inode });
    }

    return rows;
}

function attachListenerPids(
    rows: readonly LinuxListeningSocketRow[],
    inodeToPid: ReadonlyMap<string, number>,
): LocalServiceListenerFact[] {
    return rows.map((row) => {
        const pid = inodeToPid.get(row.inode);
        return {
            address: row.address,
            port: row.port,
            protocol: 'tcp' as const,
            ...(pid ? { pid } : {}),
        };
    });
}

export function parseLinuxProcNetTcpListeners(input: ProcNetInput): LocalServiceListenerFact[] {
    return attachListenerPids(
        [
            ...parseProcNetTcpRows(input.tcp4, 'ipv4'),
            ...parseProcNetTcpRows(input.tcp6, 'ipv6'),
        ],
        input.inodeToPid,
    );
}

function joinProcPath(root: string, ...parts: readonly string[]): string {
    return [root.replace(/\/+$/u, ''), ...parts].join('/');
}

function parseNumericPid(raw: string): number | null {
    if (!/^\d+$/u.test(raw)) return null;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parseProcStatFacts(content: string): Readonly<{ ppid?: number; startTicks?: number }> {
    const trimmed = content.trim();
    const commandEnd = trimmed.lastIndexOf(')');
    const afterCommand = commandEnd >= 0 ? trimmed.slice(commandEnd + 1).trim() : '';
    const fields = afterCommand.split(/\s+/u);
    const ppid = Number(fields[1]);
    const startTicks = Number(fields[19]);
    return {
        ...(Number.isInteger(ppid) && ppid > 0 ? { ppid } : {}),
        ...(Number.isFinite(startTicks) && startTicks >= 0 ? { startTicks } : {}),
    };
}

/** `/proc/<pid>/status` exposes `Uid: <real> <effective> <saved> <fs>`; the real uid is the owner. */
export function parseProcStatusRealUserId(content: string): string | undefined {
    return /^Uid:\s+(\d+)/mu.exec(content)?.[1];
}

function parseProcCmdline(content: string): string {
    // `/proc/<pid>/cmdline` separates argv entries with NUL bytes.
    return content
        .split('\0')
        .map((part) => part.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 1_000);
}

async function readOptionalLink(boundary: LinuxProcfsBoundary, path: string): Promise<string | undefined> {
    try {
        return await boundary.readlink(path);
    } catch {
        return undefined;
    }
}

function parseLinuxBootTimeMs(content: string): number | undefined {
    const match = /^btime\s+(\d+)\s*$/mu.exec(content);
    const seconds = Number(match?.[1]);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds * 1_000) : undefined;
}

function processStartTimeFromTicks(input: Readonly<{
    bootTimeMs: number | undefined;
    startTicks: number | undefined;
}>): number | undefined {
    if (typeof input.bootTimeMs !== 'number' || typeof input.startTicks !== 'number') return undefined;
    // Linux exposes process start time in clock ticks since boot. Most supported
    // Linux targets report 100 ticks/sec; this value is only used for identity
    // equality across adjacent scans, not for user-visible wall-clock display.
    return Math.trunc(input.bootTimeMs + input.startTicks * 10);
}

async function readProcessFact(
    boundary: LinuxProcfsBoundary,
    procRoot: string,
    pid: number,
    bootTimeMs: number | undefined,
    daemonUserId: string | undefined,
): Promise<LocalServiceProcessFact | null> {
    try {
        const base = joinProcPath(procRoot, String(pid));
        const [stat, cmdline, status] = await Promise.all([
            boundary.readFile(joinProcPath(base, 'stat'), 'utf8'),
            boundary.readFile(joinProcPath(base, 'cmdline'), 'utf8').catch(() => ''),
            boundary.readFile(joinProcPath(base, 'status'), 'utf8').catch(() => ''),
        ]);
        const command = parseProcCmdline(String(cmdline));
        const statFacts = parseProcStatFacts(String(stat));
        const processStartTimeMs = processStartTimeFromTicks({
            bootTimeMs,
            startTicks: statFacts.startTicks,
        });
        const cwd = await readOptionalLink(boundary, joinProcPath(base, 'cwd'));
        const processOwnership = classifyPosixProcessOwnership(
            parseProcStatusRealUserId(String(status)),
            daemonUserId,
        );
        return {
            pid,
            ...(statFacts.ppid ? { ppid: statFacts.ppid } : {}),
            ...(typeof processStartTimeMs === 'number' ? { processStartTimeMs } : {}),
            command: command || 'unknown',
            ...(cwd ? { cwd } : {}),
            ...(processOwnership ? { processOwnership } : {}),
        };
    } catch {
        return null;
    }
}

export async function readLinuxProcessFacts(
    boundary: LinuxProcfsBoundary,
    pids: readonly number[],
): Promise<ReadonlyMap<number, LocalServiceProcessFact>> {
    const procRoot = boundary.procRoot ?? '/proc';
    const daemonUserId = boundary.daemonUserId ?? resolveDaemonPosixUserId();
    const bootTimeMs = parseLinuxBootTimeMs(String(
        await boundary.readFile(joinProcPath(procRoot, 'stat'), 'utf8').catch(() => ''),
    ));
    const processes = new Map<number, LocalServiceProcessFact>();
    await Promise.all([...new Set(pids)].map(async (pid) => {
        if (!Number.isInteger(pid) || pid <= 0) return;
        const processFact = await readProcessFact(boundary, procRoot, pid, bootTimeMs, daemonUserId);
        if (processFact) {
            processes.set(pid, processFact);
        }
    }));
    return processes;
}

async function readSocketInodesForPid(
    boundary: LinuxProcfsBoundary,
    procRoot: string,
    pid: number,
): Promise<readonly string[]> {
    try {
        const fdDir = joinProcPath(procRoot, String(pid), 'fd');
        const fds = await boundary.readdir(fdDir);
        const inodes: string[] = [];
        await Promise.all(fds.map(async (fd) => {
            const target = await readOptionalLink(boundary, joinProcPath(fdDir, fd));
            const inode = /^socket:\[(\d+)\]$/u.exec(target ?? '')?.[1];
            if (inode) {
                inodes.push(inode);
            }
        }));
        return inodes;
    } catch {
        return [];
    }
}

/**
 * Second pass: attribute only the *listening* socket inodes to their owning pid.
 *
 * The previous shape read full process facts (stat + cmdline + two readlinks) for every pid on
 * the machine before it knew which ones mattered, with no deadline — O(all pids x all fds) on a
 * loop that runs every ten seconds. Here the fd walk stops as soon as every wanted inode is
 * attributed, and process facts are read only for the listener pids and their lineage, which is
 * what darwin and Windows already do.
 */
async function resolveListeningSocketOwners(input: Readonly<{
    boundary: LinuxProcfsBoundary;
    procRoot: string;
    pids: readonly number[];
    wantedInodes: ReadonlySet<string>;
    deadlineAt: number;
    now: () => number;
}>): Promise<Readonly<{ inodeToPid: ReadonlyMap<string, number>; deadlineExceeded: boolean }>> {
    const inodeToPid = new Map<string, number>();
    if (input.wantedInodes.size === 0) {
        return { inodeToPid, deadlineExceeded: false };
    }
    for (let offset = 0; offset < input.pids.length; offset += PROC_FD_SCAN_CHUNK) {
        if (input.now() >= input.deadlineAt) {
            return { inodeToPid, deadlineExceeded: true };
        }
        const chunk = input.pids.slice(offset, offset + PROC_FD_SCAN_CHUNK);
        await Promise.all(chunk.map(async (pid) => {
            for (const inode of await readSocketInodesForPid(input.boundary, input.procRoot, pid)) {
                if (input.wantedInodes.has(inode)) {
                    inodeToPid.set(inode, pid);
                }
            }
        }));
        if (inodeToPid.size >= input.wantedInodes.size) {
            return { inodeToPid, deadlineExceeded: false };
        }
    }
    return { inodeToPid, deadlineExceeded: false };
}

export async function readLinuxLocalServiceListeners(boundary: LinuxProcfsBoundary): Promise<LinuxLocalServiceScanResult> {
    const procRoot = boundary.procRoot ?? '/proc';
    const now = boundary.now ?? (() => Date.now());
    const deadlineAt = now() + (boundary.deadlineMs ?? DEFAULT_LINUX_SCAN_DEADLINE_MS);
    const daemonUserId = boundary.daemonUserId ?? resolveDaemonPosixUserId();
    try {
        const [tcp4, tcp6, procEntries] = await Promise.all([
            boundary.readFile(joinProcPath(procRoot, 'net', 'tcp'), 'utf8').catch(() => ''),
            boundary.readFile(joinProcPath(procRoot, 'net', 'tcp6'), 'utf8').catch(() => ''),
            boundary.readdir(procRoot),
        ]);
        const rows = [
            ...parseProcNetTcpRows(String(tcp4), 'ipv4'),
            ...parseProcNetTcpRows(String(tcp6), 'ipv6'),
        ];
        const pids = procEntries
            .map(parseNumericPid)
            .filter((pid): pid is number => pid !== null);
        const owners = await resolveListeningSocketOwners({
            boundary,
            procRoot,
            pids,
            wantedInodes: new Set(rows.map((row) => row.inode)),
            deadlineAt,
            now,
        });
        const listeners = attachListenerPids(rows, owners.inodeToPid);

        const diagnostics: LocalServiceInventoryDiagnostic[] = owners.deadlineExceeded
            ? [{
                code: 'linux_procfs_scan_deadline_exceeded',
                severity: 'warning',
                message: 'Linux /proc scan exceeded its deadline; listener attribution may be incomplete.',
            }]
            : [];
        const listenerPids = [...new Set(listeners
            .map((listener) => listener.pid)
            .filter((pid): pid is number => typeof pid === 'number'))];
        const processes = listenerPids.length > 0
            ? await collectLocalServiceProcessLineageFacts({
                seedPids: listenerPids,
                maxDepth: LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH,
                readProcessFacts: async (factPids) => await readLinuxProcessFacts(
                    { ...boundary, ...(daemonUserId ? { daemonUserId } : {}) },
                    factPids,
                ),
                onReadFailure: () => {
                    diagnostics.push({
                        code: 'linux_process_fact_scan_failed',
                        severity: 'warning',
                        message: 'Linux process fact scan failed.',
                    });
                },
            })
            : new Map<number, LocalServiceProcessFact>();

        return { listeners, processes, diagnostics };
    } catch (error) {
        return {
            listeners: [],
            processes: new Map(),
            diagnostics: [{
                code: 'linux_procfs_scan_failed',
                severity: 'warning',
                message: error instanceof Error ? error.message : String(error),
            }],
        };
    }
}
