import { LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH, type LocalServiceProcessFact } from '../provenance';
import type { LocalServiceInventoryDiagnostic, LocalServiceListenerFact } from '../scanner';
import { collectLocalServiceProcessLineageFacts } from './processLineage';
import {
    probeWindowsProcessOwnership,
    type LocalServiceProcessOwnership,
} from './processOwnership';
import {
    parseWindowsProcessInventoryJson,
    readWindowsProcessInventory,
    type WindowsProcessInventoryFact,
} from '../../../../platform/windows/windowsProcessInventory';

export type WindowsExecFileBoundary = (
    command: string,
    args: readonly string[],
    options: Readonly<{ timeout: number; maxBuffer: number }>,
) => Promise<Readonly<{ stdout: string | Buffer }>>;

export type WindowsLocalServiceScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

function parsePositiveInteger(value: string | number | null | undefined): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parsePort(value: string): number | null {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null;
}

function splitHostPort(value: string): Readonly<{ host: string; port: number }> | null {
    const trimmed = value.trim();
    const bracketMatch = /^\[([^\]]+)\]:(\d+)$/u.exec(trimmed);
    if (bracketMatch?.[1] && bracketMatch[2]) {
        return { host: bracketMatch[1], port: Number(bracketMatch[2]) };
    }
    const separator = trimmed.lastIndexOf(':');
    if (separator <= 0) return null;
    const port = Number(trimmed.slice(separator + 1));
    if (!Number.isInteger(port) || port < 0 || port > 65_535) return null;
    return { host: trimmed.slice(0, separator), port };
}

function parseWindowsLocalAddress(value: string): Readonly<{ address: string; port: number }> | null {
    const split = splitHostPort(value);
    if (!split) return null;
    const port = parsePort(String(split.port));
    if (port == null) return null;
    if (!split.host || split.host === '*') return null;
    return { address: split.host, port };
}

/**
 * `netstat -ano` prints a **localized** State column on a non-English Windows, so matching the
 * literal `LISTENING` is not by itself a safe listening test — a localized host would produce a
 * silently empty inventory. Whether Windows localizes that column is not established here (no
 * non-English host and no vendor citation was available), so instead of asserting an answer the
 * dependency is removed: a listening TCP socket always reports the wildcard Foreign Address with
 * port `0`, which is locale-independent. Either signal is accepted, so an English host behaves
 * exactly as before and a localized one still resolves its listeners.
 */
function isNetstatListeningRow(state: string | undefined, foreignAddress: string | undefined): boolean {
    if (state?.toUpperCase() === 'LISTENING') return true;
    const foreign = foreignAddress ? splitHostPort(foreignAddress) : null;
    return foreign?.port === 0;
}

export function parseWindowsNetstatTcpListeners(output: string): LocalServiceListenerFact[] {
    const listeners: LocalServiceListenerFact[] = [];
    for (const line of output.split(/\r?\n/u)) {
        const columns = line.trim().split(/\s+/u);
        if (columns.length < 5 || columns[0]?.toUpperCase() !== 'TCP') continue;
        const localAddress = columns[1];
        const foreignAddress = columns[2];
        const state = columns[3];
        const rawPid = columns[4];
        if (!localAddress || !isNetstatListeningRow(state, foreignAddress)) continue;
        const parsedAddress = parseWindowsLocalAddress(localAddress);
        if (!parsedAddress) continue;
        const pid = parsePositiveInteger(rawPid);
        listeners.push({
            address: parsedAddress.address,
            port: parsedAddress.port,
            protocol: 'tcp',
            ...(pid ? { pid } : {}),
        });
    }
    return listeners;
}

export function parseWindowsProcessFactsJson(output: string): ReadonlyMap<number, LocalServiceProcessFact> {
    return projectWindowsProcessFacts(
        parseWindowsProcessInventoryJson(output),
    );
}

function projectWindowsProcessFacts(
    raw: ReadonlyMap<number, WindowsProcessInventoryFact>,
): ReadonlyMap<number, LocalServiceProcessFact> {
    const processes = new Map<number, LocalServiceProcessFact>();
    for (const fact of raw.values()) {
        processes.set(fact.pid, {
            pid: fact.pid,
            ...(fact.ppid ? { ppid: fact.ppid } : {}),
            ...(typeof fact.processStartTimeMs === 'number'
                ? { processStartTimeMs: fact.processStartTimeMs }
                : {}),
            command:
                fact.command?.slice(0, 1_000)
                || fact.executablePath?.slice(0, 1_000)
                || 'unknown',
        });
    }
    return processes;
}

export async function readWindowsProcessFacts(input: Readonly<{
    execFile: WindowsExecFileBoundary;
    pids: readonly number[];
}>): Promise<ReadonlyMap<number, LocalServiceProcessFact>> {
    const pids = [...new Set(input.pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (pids.length === 0) return new Map();
    return projectWindowsProcessFacts(await readWindowsProcessInventory({
        execFile: input.execFile,
        pids,
    }));
}

function stdoutToString(stdout: string | Buffer): string {
    return typeof stdout === 'string' ? stdout : stdout.toString('utf8');
}

/**
 * Stamp ownership onto the listener pids only. Windows has no uid to compare, and a per-process
 * `Invoke-CimMethod GetOwner` on every ten-second scan is not worth its cost; the question the
 * terminate gate actually asks — may this daemon terminate this process? — is answered in-process
 * by opening the target for termination.
 */
function withListenerOwnership(input: Readonly<{
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    listenerPids: readonly number[];
    probeOwnership: (pid: number) => LocalServiceProcessOwnership | undefined;
}>): ReadonlyMap<number, LocalServiceProcessFact> {
    const processes = new Map(input.processes);
    for (const pid of input.listenerPids) {
        const processOwnership = input.probeOwnership(pid);
        if (!processOwnership) continue;
        const existing = processes.get(pid);
        processes.set(pid, {
            ...(existing ?? { pid, command: 'unknown' }),
            processOwnership,
        });
    }
    return processes;
}

export async function readWindowsLocalServiceListeners(input: Readonly<{
    execFile: WindowsExecFileBoundary;
    probeProcessOwnership?: (pid: number) => LocalServiceProcessOwnership | undefined;
}>): Promise<WindowsLocalServiceScanResult> {
    const probeOwnership = input.probeProcessOwnership
        ?? ((pid: number) => probeWindowsProcessOwnership(pid));
    let listeners: readonly LocalServiceListenerFact[];
    try {
        const result = await input.execFile('netstat.exe', ['-ano', '-p', 'tcp'], {
            timeout: 2_000,
            maxBuffer: 1024 * 1024,
        });
        listeners = parseWindowsNetstatTcpListeners(stdoutToString(result.stdout));
    } catch {
        return {
            listeners: [],
            processes: new Map(),
            diagnostics: [{
                code: 'windows_netstat_scan_failed',
                severity: 'warning',
                message: 'Windows local-service listener scan failed.',
            }],
        };
    }

    const pids = [...new Set(listeners
        .map((listener) => listener.pid)
        .filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0))];
    if (pids.length === 0) {
        return {
            listeners,
            processes: new Map(),
            diagnostics: [],
        };
    }

    const diagnostics: LocalServiceInventoryDiagnostic[] = [];
    const processes = await collectLocalServiceProcessLineageFacts({
        seedPids: pids,
        maxDepth: LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH,
        readProcessFacts: async (queryPids) => await readWindowsProcessFacts({
            execFile: input.execFile,
            pids: queryPids,
        }),
        onReadFailure: () => {
            diagnostics.push({
                code: 'windows_process_fact_scan_failed',
                severity: 'warning',
                message: 'Windows process fact scan failed.',
            });
        },
    });

    return {
        listeners,
        processes: withListenerOwnership({ processes, listenerPids: pids, probeOwnership }),
        diagnostics,
    };
}
