import type { LocalServiceListenerFact } from '../scanner';
import type { LocalServiceInventoryDiagnostic } from '../scanner';
import { LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH, type LocalServiceProcessFact } from '../provenance';
import { collectLocalServiceProcessLineageFacts } from './processLineage';

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

export function parseDarwinPsProcessOutput(output: string): ReadonlyMap<number, LocalServiceProcessFact> {
    const processes = new Map<number, LocalServiceProcessFact>();
    for (const line of output.split(/\r?\n/u)) {
        const withLstart = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u.exec(line);
        const legacy = withLstart ? null : /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
        const pidRaw = withLstart?.[1] ?? legacy?.[1];
        const ppidRaw = withLstart?.[2] ?? legacy?.[2];
        const processStartTimeMs = withLstart?.[3] ? parseDarwinLstartDate(withLstart[3]) : undefined;
        const command = withLstart?.[4] ?? legacy?.[3];
        if (!pidRaw || !command) continue;
        const pid = Number(pidRaw);
        const ppid = Number(ppidRaw);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        processes.set(pid, {
            pid,
            ...(Number.isInteger(ppid) && ppid > 0 ? { ppid } : {}),
            ...(typeof processStartTimeMs === 'number' ? { processStartTimeMs } : {}),
            command: command.slice(0, 1_000),
        });
    }
    return processes;
}

function parseDarwinLsofExecutablePathOutput(output: string): ReadonlyMap<number, string> {
    const executablePathByPid = new Map<number, string>();
    let pid: number | undefined;
    let isProgramText = false;
    for (const line of output.split(/\r?\n/u)) {
        if (!line) continue;
        const tag = line[0];
        const value = line.slice(1);
        if (tag === 'p') {
            const parsedPid = Number(value);
            pid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined;
            isProgramText = false;
            continue;
        }
        if (tag === 'f') {
            isProgramText = value.trim() === 'txt';
            continue;
        }
        if (tag !== 'n' || !pid || !isProgramText || executablePathByPid.has(pid)) continue;
        const executablePath = value.trim();
        if (executablePath) {
            // Darwin reports the process image as the first `txt` vnode, followed
            // by other mapped program-text objects such as dyld and shared data.
            executablePathByPid.set(pid, executablePath.slice(0, 1_000));
        }
    }
    return executablePathByPid;
}

export async function readDarwinProcessFacts(input: Readonly<{
    execFile: DarwinExecFileBoundary;
    pids: readonly number[];
}>): Promise<ReadonlyMap<number, LocalServiceProcessFact>> {
    const pids = [...new Set(input.pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (pids.length === 0) return new Map();
    const pidList = pids.join(',');
    const [result, executablePathByPid] = await Promise.all([
        input.execFile(
            'ps',
            ['-o', 'pid=,ppid=,lstart=,command=', '-p', pidList],
            { timeout: 2_000, maxBuffer: 1024 * 1024 },
        ),
        input.execFile(
            'lsof',
            ['-nP', '-a', '-d', 'txt', '-p', pidList, '-F', 'pfn'],
            { timeout: 2_000, maxBuffer: 1024 * 1024 },
        ).then(
            (executableResult) => parseDarwinLsofExecutablePathOutput(
                stdoutTextFromExecFileResult(executableResult),
            ),
            () => new Map<number, string>(),
        ),
    ]);
    const processes = parseDarwinPsProcessOutput(stdoutTextFromExecFileResult(result));
    return new Map([...processes].map(([pid, process]) => {
        const executablePath = executablePathByPid.get(pid);
        return [
            pid,
            {
                ...process,
                ...(executablePath ? { executablePath } : {}),
            },
        ];
    }));
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
            ...(process?.executablePath ? { executablePath: process.executablePath } : {}),
            ...(cwd ? { cwd } : process?.cwd ? { cwd: process.cwd } : {}),
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
            ...(process?.executablePath ? { executablePath: process.executablePath } : {}),
            ...(cwd ? { cwd } : process?.cwd ? { cwd: process.cwd } : {}),
        });
    }
    return processes;
}

export async function readDarwinLocalServiceListeners(input: Readonly<{
    execFile: DarwinExecFileBoundary;
}>): Promise<DarwinLocalServiceScanResult> {
    try {
        const result = await input.execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], {
            timeout: 2_000,
            maxBuffer: 1024 * 1024,
        });
        const parsed = parseDarwinLsofTcpListenFacts(stdoutTextFromExecFileResult(result));
        const listenerPids = [...new Set(parsed.listeners
            .map((listener) => listener.pid)
            .filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0))];
        const diagnostics: LocalServiceInventoryDiagnostic[] = [];
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
    } catch {
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
}
