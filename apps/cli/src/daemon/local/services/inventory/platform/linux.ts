import type { LocalServiceProcessFact } from '../provenance';
import type { LocalServiceListenerFact, LocalServiceInventoryDiagnostic } from '../scanner';
import { projectLocalServiceProcessFacts } from '@/processes/census/projectLocalServiceProcessFacts';

type ProcNetInput = Readonly<{
    tcp4: string;
    tcp6: string;
    inodeToPid: ReadonlyMap<string, number>;
}>;

export type LinuxProcfsBoundary = Readonly<{
    /** Listener summaries do not consume process provenance or ownership. */
    includeProcessFacts?: boolean;
    /** Count-only consumers need ownership only to exclude these internal listeners. */
    listenerOwnerPids?: readonly number[];
    procRoot?: string;
    readFile(path: string, encoding: 'utf8'): Promise<string | Buffer>;
    readdir(path: string): Promise<readonly string[]>;
    readlink(path: string): Promise<string>;
    /** Clock for a caller-supplied scan deadline; injected in tests. */
    now?: () => number;
    /**
     * Optional wall-clock budget owned by the containing caller. Native procfs observation has
     * no default cutoff: a subprocess probe's timeout is not a budget for walking a busy host.
     * On expiry the scan returns resolved facts plus an explicit incomplete-scan diagnostic.
     */
    deadlineMs?: number;
}>;

export type LinuxLocalServiceScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    readProcessFacts?: () => Promise<ReadonlyMap<number, LocalServiceProcessFact>>;
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
    /** Actual unreadable FD owners while kernel listening inodes remain unattributed. */
    socketOwnerReadFailures: readonly number[];
    /** A detailed reader must repeat attribution without the summary's PID restriction. */
    listenerOwnersRestricted?: true;
}>;

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

type LinuxListeningSocketRow = Readonly<{ address: string; port: number; inode: string; state: string }>;

function parseProcNetTcpRows(content: string, family: 'ipv4' | 'ipv6'): LinuxListeningSocketRow[] {
    const rows: LinuxListeningSocketRow[] = [];
    const lines = content.split(/\r?\n/u).slice(1);

    for (const rawLine of lines) {
        const columns = rawLine.trim().split(/\s+/u);
        if (columns.length < 10) continue;
        const localAddress = columns[1];
        const state = columns[3];
        const inode = columns[9];
        if (!localAddress || !state || !inode) continue;

        const [addressHex, portHex] = localAddress.split(':');
        if (!addressHex || !portHex) continue;

        const port = parseHexPort(portHex);
        const address = family === 'ipv4' ? parseIpv4Hex(addressHex) : parseIpv6Hex(addressHex);
        if (port == null || !address) continue;

        rows.push({ address, port, inode, state });
    }

    return rows;
}

function attachListenerPids(
    rows: readonly LinuxListeningSocketRow[],
    inodeToPid: ReadonlyMap<string, number>,
    complete: boolean = true,
): LocalServiceListenerFact[] {
    const establishedByPort = new Map<number, { total: number; byAddress: Map<string, number> }>();
    if (complete) {
        for (const row of rows) {
            if (row.state !== '01') continue;
            let counts = establishedByPort.get(row.port);
            if (!counts) {
                counts = { total: 0, byAddress: new Map() };
                establishedByPort.set(row.port, counts);
            }
            counts.total++;
            counts.byAddress.set(row.address, (counts.byAddress.get(row.address) ?? 0) + 1);
        }
    }
    return rows.filter(row => row.state === '0A').map((row) => {
        const pid = inodeToPid.get(row.inode);
        const counts = establishedByPort.get(row.port);
        return {
            address: row.address,
            port: row.port,
            protocol: 'tcp' as const,
            establishedConnections: complete ? (row.address === '0.0.0.0' || row.address === '::'
                ? counts?.total : counts?.byAddress.get(row.address)) ?? 0 : null,
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
        input.tcp4.includes('local_address') && input.tcp6.includes('local_address'),
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

async function readSocketInodesForPid(
    boundary: LinuxProcfsBoundary,
    procRoot: string,
    pid: number,
): Promise<Readonly<{ inodes: readonly string[]; readFailed: boolean }>> {
    try {
        const fdDir = joinProcPath(procRoot, String(pid), 'fd');
        const fds = await boundary.readdir(fdDir);
        const inodes: string[] = [];
        let readFailed = false;
        await Promise.all(fds.map(async (fd) => {
            try {
                const target = await boundary.readlink(joinProcPath(fdDir, fd));
                const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
                if (inode) inodes.push(inode);
            } catch { readFailed = true; }
        }));
        return { inodes, readFailed };
    } catch {
        return { inodes: [], readFailed: true };
    }
}

/**
 * Second pass: attribute only the *listening* socket inodes to their owning pid.
 *
 * The previous shape read full process facts (stat + cmdline + two readlinks) for every pid on
 * the machine before it knew which ones mattered, with no deadline — O(all pids x all fds) on a
 * loop that runs every ten seconds. Here the fd walk stops as soon as every wanted inode is
 * attributed. Process enrichment then projects the listener pids and their lineage from the
 * canonical census, which is shared by all three platforms.
 */
async function resolveListeningSocketOwners(input: Readonly<{
    boundary: LinuxProcfsBoundary;
    procRoot: string;
    pids: readonly number[];
    wantedInodes: ReadonlySet<string>;
    deadlineAt: number;
    now: () => number;
}>): Promise<Readonly<{ inodeToPid: ReadonlyMap<string, number>; deadlineExceeded: boolean; unreadablePids: readonly number[] }>> {
    const inodeToPid = new Map<string, number>();
    const unreadablePids: number[] = [];
    if (input.wantedInodes.size === 0) {
        return { inodeToPid, deadlineExceeded: false, unreadablePids: [] };
    }
    for (let offset = 0; offset < input.pids.length; offset += PROC_FD_SCAN_CHUNK) {
        if (input.now() >= input.deadlineAt) {
            return { inodeToPid, deadlineExceeded: true, unreadablePids: [] };
        }
        const chunk = input.pids.slice(offset, offset + PROC_FD_SCAN_CHUNK);
        await Promise.all(chunk.map(async (pid) => {
            const sockets = await readSocketInodesForPid(input.boundary, input.procRoot, pid);
            if (sockets.readFailed) unreadablePids.push(pid);
            for (const inode of sockets.inodes) {
                if (input.wantedInodes.has(inode)) {
                    inodeToPid.set(inode, pid);
                }
            }
        }));
        if (inodeToPid.size >= input.wantedInodes.size) {
            return { inodeToPid, deadlineExceeded: false, unreadablePids: [] };
        }
    }
    return { inodeToPid, deadlineExceeded: false, unreadablePids };
}

export async function readLinuxLocalServiceListeners(boundary: LinuxProcfsBoundary): Promise<LinuxLocalServiceScanResult> {
    const procRoot = boundary.procRoot ?? '/proc';
    const now = boundary.now ?? (() => Date.now());
    const deadlineAt = boundary.deadlineMs === undefined ? Number.POSITIVE_INFINITY : now() + boundary.deadlineMs;
    try {
        const [tcp4, tcp6, procEntries] = await Promise.all([
            boundary.readFile(joinProcPath(procRoot, 'net', 'tcp'), 'utf8'),
            boundary.readFile(joinProcPath(procRoot, 'net', 'tcp6'), 'utf8').catch((error: unknown) => {
                // Linux omits this table when IPv6 is unavailable; I/O and permission
                // failures must reach the scan's nonauthoritative failure result.
                if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return '';
                throw error;
            }),
            boundary.listenerOwnerPids === undefined ? boundary.readdir(procRoot) : [],
        ]);
        const rows = [
            ...parseProcNetTcpRows(String(tcp4), 'ipv4'),
            ...parseProcNetTcpRows(String(tcp6), 'ipv6'),
        ];
        const pids = boundary.listenerOwnerPids ?? procEntries
            .map(parseNumericPid)
            .filter((pid): pid is number => pid !== null);
        const owners = await resolveListeningSocketOwners({
            boundary,
            procRoot,
            pids,
            wantedInodes: new Set(rows.filter(row => row.state === '0A').map((row) => row.inode)),
            deadlineAt,
            now,
        });
        const listeners = attachListenerPids(rows, owners.inodeToPid, !owners.deadlineExceeded
            && String(tcp4).includes('local_address') && String(tcp6).includes('local_address'));

        const diagnostics: LocalServiceInventoryDiagnostic[] = owners.deadlineExceeded
            ? [{
                code: 'linux_procfs_scan_deadline_exceeded',
                severity: 'warning',
                message: 'Linux /proc scan exceeded its deadline; listener attribution may be incomplete.',
            }]
            : [];
        const listenerPids = [...new Set([...listeners
            .map((listener) => listener.pid)
            .filter((pid): pid is number => typeof pid === 'number'), ...owners.unreadablePids])];
        const readProcessFacts = async (): Promise<ReadonlyMap<number, LocalServiceProcessFact>> => listenerPids.length > 0
            ? await projectLocalServiceProcessFacts({
                seedPids: listenerPids,
                onReadFailure: () => {
                    diagnostics.push({
                        code: 'linux_process_fact_scan_failed',
                        severity: 'warning',
                        message: 'Linux process fact scan failed.',
                    });
                },
            })
            : new Map<number, LocalServiceProcessFact>();

        return { listeners, processes: boundary.includeProcessFacts === false ? new Map<number, LocalServiceProcessFact>() : await readProcessFacts(),
            ...(boundary.includeProcessFacts === false ? { readProcessFacts } : {}),
            diagnostics, socketOwnerReadFailures: owners.unreadablePids,
            ...(boundary.listenerOwnerPids === undefined ? {} : { listenerOwnersRestricted: true as const }) };
    } catch (error) {
        return {
            listeners: [],
            processes: new Map(),
            socketOwnerReadFailures: [],
            diagnostics: [{
                code: 'linux_procfs_scan_failed',
                severity: 'warning',
                message: error instanceof Error ? error.message : String(error),
            }],
        };
    }
}
