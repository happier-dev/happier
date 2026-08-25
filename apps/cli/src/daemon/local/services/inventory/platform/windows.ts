import { LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH, type LocalServiceProcessFact } from '../provenance';
import type { LocalServiceInventoryDiagnostic, LocalServiceListenerFact } from '../scanner';
import { collectLocalServiceProcessLineageFacts } from './processLineage';
import { classifyProcessOwnershipByIdentity } from './processOwnership';
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

/** The English TCP state tokens `netstat` emits. Used only to detect an *unrecognized* token. */
const WINDOWS_NETSTAT_TCP_STATES: ReadonlySet<string> = new Set([
    'CLOSED', 'LISTENING', 'SYN_SENT', 'SYN_RECEIVED', 'ESTABLISHED', 'FIN_WAIT_1',
    'FIN_WAIT_2', 'CLOSE_WAIT', 'CLOSING', 'LAST_ACK', 'TIME_WAIT', 'DELETE_TCB', 'BOUND',
]);

/**
 * Matching the literal `LISTENING` is the whole Windows listening test today, and if a
 * non-English Windows localizes the State column the entire inventory goes silently empty.
 *
 * That the State column *is* localized is supported by third-party evidence — Checkmk werk 14040
 * ships a fix for German Windows emitting `SCHLIESSEN_WARTEN` where the parser expected
 * `CLOSE_WAIT` — but no Microsoft documentation and no non-English host was available to confirm
 * the exact token a localized listener reports. So rather than assert an answer in either
 * direction, the dependency on the answer is removed: when the state token is one we recognize,
 * it decides, exactly as before.
 * When it is a token we cannot interpret, the locale-independent signature of a listening TCP
 * socket decides instead: its Foreign Address is the wildcard with port `0`, which no connected
 * socket reports.
 */
function isNetstatListeningRow(state: string | undefined, foreignAddress: string | undefined): boolean {
    const token = state?.toUpperCase();
    if (token === 'LISTENING') return true;
    if (token && WINDOWS_NETSTAT_TCP_STATES.has(token)) return false;
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
        // Ownership rides on the same row as the rest of the fact: the SID projection is only
        // requested for listener pids, so ancestors simply carry no owner and stay `undefined`,
        // which the scanner grades `medium` and the terminate gate refuses.
        const processOwnership = classifyProcessOwnershipByIdentity(
            fact.ownerSid,
            fact.currentUserSid,
        );
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
            ...(processOwnership ? { processOwnership } : {}),
        });
    }
    return processes;
}

export async function readWindowsProcessFacts(input: Readonly<{
    execFile: WindowsExecFileBoundary;
    pids: readonly number[];
    /** Listener pids: the only ones whose owning principal the terminate gate needs. */
    ownerSidPids?: readonly number[];
}>): Promise<ReadonlyMap<number, LocalServiceProcessFact>> {
    const pids = [...new Set(input.pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (pids.length === 0) return new Map();
    return projectWindowsProcessFacts(await readWindowsProcessInventory({
        execFile: input.execFile,
        pids,
        ...(input.ownerSidPids ? { ownerSidPids: input.ownerSidPids } : {}),
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
            // Owner SIDs only for the listener pids in this batch — order-independent, so it
            // does not matter which lineage depth a pid is read at, and ancestors never pay for
            // a WMI method call whose answer nothing reads.
            ownerSidPids: queryPids.filter((pid) => pids.includes(pid)),
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
        processes,
        diagnostics,
    };
}
