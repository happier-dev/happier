import type { LocalServiceListenerFact } from '../scanner';
import type { LocalServiceInventoryDiagnostic } from '../scanner';
import { LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH, type LocalServiceProcessFact } from '../provenance';
import { collectLocalServiceProcessLineageFacts } from './processLineage';
import { classifyPosixProcessOwnership, resolveDaemonPosixUserId } from './processOwnership';

export type DarwinExecFileBoundary = (
    command: string,
    args: readonly string[],
    options: Readonly<{ timeout: number; maxBuffer: number }>,
) => Promise<Readonly<{ stdout: string | Buffer }>>;

export type DarwinLocalServiceScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

function parseLsofNameField(value: string): Readonly<{ address: string; port: number }> | null {
    const withoutPrefix = value.trim().replace(/\s+\(LISTEN\).*$/i, '').replace(/^TCP\s+/i, '').trim();
    const portMatch = /:(\d+)$/.exec(withoutPrefix);
    if (!portMatch) return null;
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    const addressRaw = withoutPrefix.slice(0, withoutPrefix.length - portMatch[0].length).trim();
    const address = addressRaw === '*' ? '0.0.0.0' : addressRaw.replace(/^\[|\]$/g, '');
    return { address, port };
}

type DarwinLsofTcpListenFacts = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
}>;

function parseDarwinLsofTcpListenFacts(output: string): DarwinLsofTcpListenFacts {
    const listeners: LocalServiceListenerFact[] = [];
    const processes = new Map<number, LocalServiceProcessFact>();
    let pid: number | undefined;
    let ppid: number | undefined;
    let command = '';
    for (const line of output.split(/\r?\n/)) {
        if (!line) continue;
        const tag = line[0];
        const value = line.slice(1);
        if (tag === 'p') {
            const parsedPid = Number(value);
            pid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined;
            ppid = undefined;
            command = '';
            continue;
        }
        if (tag === 'R') {
            const parsedPpid = Number(value);
            ppid = Number.isInteger(parsedPpid) && parsedPpid > 0 ? parsedPpid : undefined;
            continue;
        }
        if (tag === 'c') {
            command = value.trim();
            if (pid && command) {
                processes.set(pid, {
                    pid,
                    ...(ppid ? { ppid } : {}),
                    command,
                });
            }
            continue;
        }
        if (tag !== 'n') continue;
        const parsed = parseLsofNameField(value);
        if (!parsed) continue;
        listeners.push({
            address: parsed.address,
            port: parsed.port,
            protocol: 'tcp',
            ...(pid ? { pid } : {}),
        });
        if (pid && !processes.has(pid)) {
            processes.set(pid, {
                pid,
                ...(ppid ? { ppid } : {}),
                command: command || 'unknown',
            });
        }
    }
    return { listeners, processes };
}

export function parseDarwinLsofTcpListenOutput(output: string): LocalServiceListenerFact[] {
    return [...parseDarwinLsofTcpListenFacts(output).listeners];
}

function parseDarwinLstartDate(value: string): number | undefined {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : undefined;
}

/**
 * `ps -o pid=,ppid=,uid=,lstart=,command=`. The uid column rides along on the call the scan
 * already makes, so process ownership costs nothing extra on darwin.
 */
function parseDarwinPsProcessOutput(
    output: string,
    daemonUserId: string | undefined,
): ReadonlyMap<number, LocalServiceProcessFact> {
    const processes = new Map<number, LocalServiceProcessFact>();
    for (const line of output.split(/\r?\n/u)) {
        const withLstart = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u.exec(line);
        const legacy = withLstart ? null : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
        const pidRaw = withLstart?.[1] ?? legacy?.[1];
        const ppidRaw = withLstart?.[2] ?? legacy?.[2];
        const uidRaw = withLstart?.[3] ?? legacy?.[3];
        const processStartTimeMs = withLstart?.[4] ? parseDarwinLstartDate(withLstart[4]) : undefined;
        const command = withLstart?.[5] ?? legacy?.[4];
        if (!pidRaw || !command) continue;
        const pid = Number(pidRaw);
        const ppid = Number(ppidRaw);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const processOwnership = classifyPosixProcessOwnership(uidRaw, daemonUserId);
        processes.set(pid, {
            pid,
            ...(Number.isInteger(ppid) && ppid > 0 ? { ppid } : {}),
            ...(typeof processStartTimeMs === 'number' ? { processStartTimeMs } : {}),
            command: command.slice(0, 1_000),
            ...(processOwnership ? { processOwnership } : {}),
        });
    }
    return processes;
}

export async function readDarwinProcessFacts(input: Readonly<{
    execFile: DarwinExecFileBoundary;
    pids: readonly number[];
    daemonUserId?: string;
}>): Promise<ReadonlyMap<number, LocalServiceProcessFact>> {
    const pids = [...new Set(input.pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (pids.length === 0) return new Map();
    const result = await input.execFile(
        'ps',
        ['-o', 'pid=,ppid=,uid=,lstart=,command=', '-p', pids.join(',')],
        { timeout: 2_000, maxBuffer: 1024 * 1024 },
    );
    return parseDarwinPsProcessOutput(
        stdoutTextFromExecFileResult(result),
        input.daemonUserId ?? resolveDaemonPosixUserId(),
    );
}

function parseDarwinLsofCwdOutput(output: string): ReadonlyMap<number, string> {
    const cwdByPid = new Map<number, string>();
    let pid: number | undefined;
    for (const line of output.split(/\r?\n/u)) {
        if (!line) continue;
        const tag = line[0];
        const value = line.slice(1);
        if (tag === 'p') {
            const parsedPid = Number(value);
            pid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined;
            continue;
        }
        if (tag !== 'n' || !pid) continue;
        const cwd = value.trim();
        if (cwd) {
            cwdByPid.set(pid, cwd);
        }
    }
    return cwdByPid;
}

function stdoutTextFromExecFileResult(result: Readonly<{ stdout: string | Buffer }>): string {
    return typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
}

function stdoutTextFromExecFileError(error: unknown): string {
    const stdout = (error as { stdout?: unknown } | null | undefined)?.stdout;
    if (typeof stdout === 'string') return stdout;
    if (Buffer.isBuffer(stdout)) return stdout.toString('utf8');
    return '';
}

function mergeDarwinCwdFacts(input: Readonly<{
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    cwdByPid: ReadonlyMap<number, string>;
}>): ReadonlyMap<number, LocalServiceProcessFact> {
    const processes = new Map(input.processes);
    for (const [pid, cwd] of input.cwdByPid) {
        const process = processes.get(pid);
        if (!process && !cwd) continue;
        processes.set(pid, {
            pid,
            ...(process?.ppid ? { ppid: process.ppid } : {}),
            ...(typeof process?.processStartTimeMs === 'number'
                ? { processStartTimeMs: process.processStartTimeMs }
                : {}),
            command: process?.command ?? 'unknown',
            ...(cwd ? { cwd } : process?.cwd ? { cwd: process.cwd } : {}),
            ...(process?.processOwnership ? { processOwnership: process.processOwnership } : {}),
        });
    }
    return processes;
}

function mergeDarwinProcessFacts(input: Readonly<{
    pids: readonly number[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    cwdByPid: ReadonlyMap<number, string>;
}>): ReadonlyMap<number, LocalServiceProcessFact> {
    const withCwd = mergeDarwinCwdFacts({
        processes: input.processes,
        cwdByPid: input.cwdByPid,
    });
    const processes = new Map<number, LocalServiceProcessFact>();
    for (const pid of input.pids) {
        const process = withCwd.get(pid);
        const cwd = input.cwdByPid.get(pid);
        processes.set(pid, {
            pid,
            ...(process?.ppid ? { ppid: process.ppid } : {}),
            ...(typeof process?.processStartTimeMs === 'number'
                ? { processStartTimeMs: process.processStartTimeMs }
                : {}),
            command: process?.command ?? 'unknown',
            ...(cwd ? { cwd } : process?.cwd ? { cwd: process.cwd } : {}),
            ...(process?.processOwnership ? { processOwnership: process.processOwnership } : {}),
        });
    }
    return processes;
}

/**
 * `lsof` exits non-zero whenever *any* file could not be accessed while still printing every
 * listener it did resolve. Discarding that stdout turned a degraded scan into a successful
 * empty one, which is worse than the failure: the inventory's stale-while-revalidate design
 * reads an authoritative empty result as "every service went away".
 */
async function readDarwinTcpListenOutput(
    execFile: DarwinExecFileBoundary,
): Promise<Readonly<{ output: string; degraded: boolean }>> {
    try {
        const result = await execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], {
            timeout: 2_000,
            maxBuffer: 1024 * 1024,
        });
        return { output: stdoutTextFromExecFileResult(result), degraded: false };
    } catch (error) {
        return { output: stdoutTextFromExecFileError(error), degraded: true };
    }
}

export async function readDarwinLocalServiceListeners(input: Readonly<{
    execFile: DarwinExecFileBoundary;
    daemonUserId?: string;
}>): Promise<DarwinLocalServiceScanResult> {
    const daemonUserId = input.daemonUserId ?? resolveDaemonPosixUserId();
    const listenOutput = await readDarwinTcpListenOutput(input.execFile);
    const parsed = parseDarwinLsofTcpListenFacts(listenOutput.output);
    if (parsed.listeners.length === 0 && listenOutput.degraded) {
        return {
            listeners: [],
            processes: new Map(),
            diagnostics: [{
                code: 'darwin_lsof_scan_failed',
                severity: 'warning',
                message: 'Darwin local-service listener scan failed.',
            }],
        };
    }

    const diagnostics: LocalServiceInventoryDiagnostic[] = listenOutput.degraded
        ? [{
            code: 'darwin_lsof_scan_partial',
            severity: 'warning',
            message: 'Darwin local-service listener scan was incomplete; recovered partial output.',
        }]
        : [];
    const listenerPids = [...new Set(parsed.listeners
        .map((listener) => listener.pid)
        .filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0))];
    let processes: ReadonlyMap<number, LocalServiceProcessFact> = parsed.processes;
    let cwdByPid: ReadonlyMap<number, string> = new Map();
    let processPids = listenerPids;
    if (listenerPids.length > 0) {
        processes = await collectLocalServiceProcessLineageFacts({
            seedPids: listenerPids,
            seedProcesses: parsed.processes,
            maxDepth: LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH,
            readProcessFacts: async (pids) => await readDarwinProcessFacts({
                execFile: input.execFile,
                pids,
                ...(daemonUserId ? { daemonUserId } : {}),
            }),
            onReadFailure: () => {
                diagnostics.push({
                    code: 'darwin_process_fact_scan_failed',
                    severity: 'warning',
                    message: 'Darwin process fact scan failed.',
                });
            },
        });
        processPids = [...new Set([...listenerPids, ...processes.keys()])];
        try {
            const cwdResult = await input.execFile('lsof', ['-nP', '-a', '-d', 'cwd', '-p', processPids.join(','), '-F', 'pn'], {
                timeout: 2_000,
                maxBuffer: 1024 * 1024,
            });
            cwdByPid = parseDarwinLsofCwdOutput(stdoutTextFromExecFileResult(cwdResult));
        } catch (error) {
            const partialStdout = stdoutTextFromExecFileError(error);
            cwdByPid = partialStdout ? parseDarwinLsofCwdOutput(partialStdout) : new Map();
            if (cwdByPid.size === 0) {
                diagnostics.push({
                    code: 'darwin_cwd_fact_scan_failed',
                    severity: 'warning',
                    message: 'Darwin cwd fact scan failed.',
                });
            }
        }
    }
    return {
        listeners: parsed.listeners,
        processes: mergeDarwinProcessFacts({
            pids: processPids,
            processes,
            cwdByPid,
        }),
        diagnostics,
    };
}
