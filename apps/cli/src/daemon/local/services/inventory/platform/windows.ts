import type { LocalServiceProcessFact } from '../provenance';
import type { LocalServiceInventoryDiagnostic, LocalServiceListenerFact } from '../scanner';
import { projectLocalServiceProcessFacts } from '@/processes/census/projectLocalServiceProcessFacts';

export type WindowsExecFileBoundary = (
    command: string,
    args: readonly string[],
    options: Readonly<{ maxBuffer: number }>,
) => Promise<Readonly<{ stdout: string | Buffer }>>;

export type WindowsLocalServiceScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    readProcessFacts?: () => Promise<ReadonlyMap<number, LocalServiceProcessFact>>;
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
    const sockets: { address: string; port: number; state: string }[] = [];
    for (const line of output.split(/\r?\n/u)) {
        const columns = line.trim().split(/\s+/u);
        if (columns.length < 5 || columns[0]?.toUpperCase() !== 'TCP') continue;
        const localAddress = columns[1];
        const foreignAddress = columns[2];
        const state = columns[3];
        const rawPid = columns[4];
        const local = localAddress ? parseWindowsLocalAddress(localAddress) : null;
        if (local && state) sockets.push({ ...local, state: state.toUpperCase() });
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
    return listeners.map(listener => {
        // Accepted sockets can move to workers; zero must cover the entire listening endpoint.
        const matching = sockets.filter(socket => socket.port === listener.port
            && (listener.address === '0.0.0.0' || listener.address === '::' || socket.address === listener.address));
        return { ...listener, establishedConnections: listener.pid === undefined || matching.some(socket => !WINDOWS_NETSTAT_TCP_STATES.has(socket.state))
            ? null : matching.filter(socket => socket.state === 'ESTABLISHED').length };
    });
}

function stdoutToString(stdout: string | Buffer): string {
    return typeof stdout === 'string' ? stdout : stdout.toString('utf8');
}

export async function readWindowsLocalServiceListeners(input: Readonly<{
    execFile: WindowsExecFileBoundary;
    includeProcessFacts?: boolean;
}>): Promise<WindowsLocalServiceScanResult> {
    let listeners: readonly LocalServiceListenerFact[];
    const diagnostics: LocalServiceInventoryDiagnostic[] = [];
    try {
        const result = await input.execFile('netstat.exe', ['-ano', '-p', 'tcp'], {
            maxBuffer: Number.POSITIVE_INFINITY,
        });
        listeners = parseWindowsNetstatTcpListeners(stdoutToString(result.stdout));
    } catch (error) {
        const stdout: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'stdout') : undefined;
        listeners = typeof stdout === 'string' || Buffer.isBuffer(stdout)
            ? parseWindowsNetstatTcpListeners(stdoutToString(stdout)).map(listener => ({ ...listener, establishedConnections: null }))
            : [];
        if (listeners.length === 0) {
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
        diagnostics.push({
            code: 'windows_netstat_scan_partial',
            severity: 'warning',
            message: 'Windows local-service listener scan was incomplete; recovered partial output.',
        });
    }

    const pids = [...new Set(listeners
        .map((listener) => listener.pid)
        .filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0))];
    if (pids.length === 0) {
        return {
            listeners,
            processes: new Map(),
            diagnostics,
        };
    }

    const readProcessFacts = async () => await projectLocalServiceProcessFacts({
        seedPids: pids,
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
        processes: input.includeProcessFacts === false ? new Map<number, LocalServiceProcessFact>() : await readProcessFacts(),
        ...(input.includeProcessFacts === false ? { readProcessFacts } : {}),
        diagnostics,
    };
}
