import { LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH, type LocalServiceProcessFact } from '../provenance';
import type { LocalServiceInventoryDiagnostic, LocalServiceListenerFact } from '../scanner';
import { collectLocalServiceProcessLineageFacts } from './processLineage';
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

function parseWindowsLocalAddress(value: string): Readonly<{ address: string; port: number }> | null {
    const trimmed = value.trim();
    const bracketMatch = /^\[([^\]]+)\]:(\d+)$/u.exec(trimmed);
    if (bracketMatch?.[1] && bracketMatch[2]) {
        const port = parsePort(bracketMatch[2]);
        if (port == null) return null;
        return { address: bracketMatch[1], port };
    }

    const separator = trimmed.lastIndexOf(':');
    if (separator <= 0) return null;
    const port = parsePort(trimmed.slice(separator + 1));
    if (port == null) return null;
    const address = trimmed.slice(0, separator);
    if (!address || address === '*') return null;
    return { address, port };
}

export function parseWindowsNetstatTcpListeners(output: string): LocalServiceListenerFact[] {
    const listeners: LocalServiceListenerFact[] = [];
    for (const line of output.split(/\r?\n/u)) {
        const columns = line.trim().split(/\s+/u);
        if (columns.length < 5 || columns[0]?.toUpperCase() !== 'TCP') continue;
        const localAddress = columns[1];
        const state = columns[3];
        const rawPid = columns[4];
        if (!localAddress || state?.toUpperCase() !== 'LISTENING') continue;
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
        const executablePath =
            fact.executablePath?.slice(0, 1_000) ?? '';
        processes.set(fact.pid, {
            pid: fact.pid,
            ...(fact.ppid ? { ppid: fact.ppid } : {}),
            ...(typeof fact.processStartTimeMs === 'number'
                ? { processStartTimeMs: fact.processStartTimeMs }
                : {}),
            command:
                fact.command?.slice(0, 1_000)
                || executablePath
                || 'unknown',
            ...(executablePath ? { executablePath } : {}),
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

export async function readWindowsLocalServiceListeners(input: Readonly<{
    execFile: WindowsExecFileBoundary;
}>): Promise<WindowsLocalServiceScanResult> {
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

    if (diagnostics.length > 0) {
        return {
            listeners,
            processes,
            diagnostics,
        };
    }

    return {
        listeners,
        processes,
        diagnostics: [],
    };
}
