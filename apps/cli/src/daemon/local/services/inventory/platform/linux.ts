import type { LocalServiceListenerFact } from '../scanner';
import type { LocalServiceInventoryDiagnostic } from '../scanner';
import type { LocalServiceProcessFact } from '../provenance';

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
}>;

export type LinuxLocalServiceScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

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

function parseProcNetTcp(content: string, family: 'ipv4' | 'ipv6', inodeToPid: ReadonlyMap<string, number>): LocalServiceListenerFact[] {
    const listeners: LocalServiceListenerFact[] = [];
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

        const pid = inodeToPid.get(inode);
        listeners.push({
            address,
            port,
            protocol: 'tcp',
            ...(pid ? { pid } : {}),
        });
    }

    return listeners;
}

export function parseLinuxProcNetTcpListeners(input: ProcNetInput): LocalServiceListenerFact[] {
    return [
        ...parseProcNetTcp(input.tcp4, 'ipv4', input.inodeToPid),
        ...parseProcNetTcp(input.tcp6, 'ipv6', input.inodeToPid),
    ];
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

function parseProcCmdline(content: string): string {
    return content
        .split('\u0000')
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
): Promise<LocalServiceProcessFact | null> {
    try {
        const base = joinProcPath(procRoot, String(pid));
        const [stat, cmdline] = await Promise.all([
            boundary.readFile(joinProcPath(base, 'stat'), 'utf8'),
            boundary.readFile(joinProcPath(base, 'cmdline'), 'utf8').catch(() => ''),
        ]);
        const command = parseProcCmdline(String(cmdline));
        const statFacts = parseProcStatFacts(String(stat));
        const processStartTimeMs = processStartTimeFromTicks({
            bootTimeMs,
            startTicks: statFacts.startTicks,
        });
        const [cwd, executablePath] = await Promise.all([
            readOptionalLink(boundary, joinProcPath(base, 'cwd')),
            readOptionalLink(boundary, joinProcPath(base, 'exe')),
        ]);
        return {
            pid,
            ...(statFacts.ppid ? { ppid: statFacts.ppid } : {}),
            ...(typeof processStartTimeMs === 'number' ? { processStartTimeMs } : {}),
            command: command || 'unknown',
            ...(executablePath ? { executablePath } : {}),
            ...(cwd ? { cwd } : {}),
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
    const bootTimeMs = parseLinuxBootTimeMs(String(
        await boundary.readFile(joinProcPath(procRoot, 'stat'), 'utf8').catch(() => ''),
    ));
    const processes = new Map<number, LocalServiceProcessFact>();
    await Promise.all([...new Set(pids)].map(async (pid) => {
        if (!Number.isInteger(pid) || pid <= 0) return;
        const processFact = await readProcessFact(boundary, procRoot, pid, bootTimeMs);
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

export async function readLinuxLocalServiceListeners(boundary: LinuxProcfsBoundary): Promise<LinuxLocalServiceScanResult> {
    const procRoot = boundary.procRoot ?? '/proc';
    try {
        const [tcp4, tcp6, procEntries] = await Promise.all([
            boundary.readFile(joinProcPath(procRoot, 'net', 'tcp'), 'utf8').catch(() => ''),
            boundary.readFile(joinProcPath(procRoot, 'net', 'tcp6'), 'utf8').catch(() => ''),
            boundary.readdir(procRoot),
        ]);
        const inodeToPid = new Map<string, number>();
        const pids = procEntries
            .map(parseNumericPid)
            .filter((pid): pid is number => pid !== null);
        const processes = new Map(await readLinuxProcessFacts(boundary, pids));
        await Promise.all(procEntries.map(async (entry) => {
            const pid = parseNumericPid(entry);
            if (!pid) return;
            for (const inode of await readSocketInodesForPid(boundary, procRoot, pid)) {
                inodeToPid.set(inode, pid);
            }
        }));

        return {
            listeners: parseLinuxProcNetTcpListeners({
                tcp4: String(tcp4),
                tcp6: String(tcp6),
                inodeToPid,
            }),
            processes,
            diagnostics: [],
        };
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
