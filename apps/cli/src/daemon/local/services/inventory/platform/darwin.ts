import type { LocalServiceListenerFact } from '../scanner';
import type { LocalServiceInventoryDiagnostic } from '../scanner';
import type { LocalServiceProcessFact } from '../provenance';
import { projectLocalServiceProcessFacts } from '@/processes/census/projectLocalServiceProcessFacts';

export type DarwinExecFileBoundary = (
    command: string,
    args: readonly string[],
    options: Readonly<{ maxBuffer: number; env?: NodeJS.ProcessEnv }>,
) => Promise<Readonly<{ stdout: string | Buffer }>>;

export type DarwinLocalServiceScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    readProcessFacts?: () => Promise<ReadonlyMap<number, LocalServiceProcessFact>>;
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

function parseLsofNameField(value: string): Readonly<{ address: string; port: number }> | null {
    const withoutPrefix = value.trim().replace(/\s+\(LISTEN\).*$/i, '').replace(/^TCP\s+/i, '').split('->')[0]!.trim();
    const portMatch = /:(\d+)$/.exec(withoutPrefix);
    if (!portMatch) return null;
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    const addressRaw = withoutPrefix.slice(0, withoutPrefix.length - portMatch[0].length).trim();
    const address = addressRaw === '*' ? '0.0.0.0' : addressRaw.replace(/^\[|\]$/g, '');
    return { address, port };
}

function parseDarwinSocketFields(output: string) {
    const sockets: { pid?: number; name?: string; state?: string }[] = [];
    let pid: number | undefined;
    let socket: typeof sockets[number] | undefined;
    for (const line of output.split(/\r?\n/u)) {
        if (line.startsWith('p')) {
            const parsed = Number(line.slice(1));
            pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
            socket = undefined;
        }
        if (line.startsWith('f')) { socket = { pid }; sockets.push(socket); }
        if (line.startsWith('n')) {
            if (!socket) { socket = { pid }; sockets.push(socket); }
            socket.name = line.slice(1);
        }
        if (line.startsWith('TST=') && socket) socket.state = line.slice(4);
    }
    return sockets;
}

export function parseDarwinLsofTcpListenOutput(output: string): LocalServiceListenerFact[] {
    return parseDarwinSocketFields(output).flatMap(socket => {
        const parsed = socket.name && !socket.name.includes('->') && (!socket.state || socket.state === 'LISTEN')
            ? parseLsofNameField(socket.name) : null;
        return parsed ? [{ ...parsed, protocol: 'tcp' as const, ...(socket.pid ? { pid: socket.pid } : {}) }] : [];
    });
}

function measureDarwinConnections(output: string, listeners: readonly LocalServiceListenerFact[], degraded: boolean): LocalServiceListenerFact[] {
    // lsof -F's f record delimits one socket and TST carries its native TCP state.
    const sockets = parseDarwinSocketFields(output);
    const knownStates = new Set(['CLOSED', 'LISTEN', 'SYN_SENT', 'SYN_RCVD', 'ESTABLISHED', 'CLOSE_WAIT',
        'FIN_WAIT_1', 'CLOSING', 'LAST_ACK', 'FIN_WAIT_2', 'TIME_WAIT']);
    return listeners.map(listener => {
        const matching = sockets.filter(socket => {
            const endpoint = socket.name ? parseLsofNameField(socket.name) : null;
            // Accepted sockets can move to workers; PID equality would invent a false zero.
            return endpoint?.port === listener.port
                && (listener.address === '0.0.0.0' || listener.address === '::' || endpoint.address === listener.address);
        });
        return { ...listener, establishedConnections: degraded || listener.pid === undefined
            || matching.some(socket => !socket.state || !knownStates.has(socket.state)) ? null : matching.filter(socket => socket.state === 'ESTABLISHED').length };
    });
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
        const result = await execFile('lsof', ['-nP', '-iTCP', '-F', 'pcfnT'], {
            maxBuffer: Number.POSITIVE_INFINITY,
        });
        return { output: stdoutTextFromExecFileResult(result), degraded: false };
    } catch (error) {
        return { output: stdoutTextFromExecFileError(error), degraded: true };
    }
}

export async function readDarwinLocalServiceListeners(input: Readonly<{
    execFile: DarwinExecFileBoundary;
    includeProcessFacts?: boolean;
}>): Promise<DarwinLocalServiceScanResult> {
    const listenOutput = await readDarwinTcpListenOutput(input.execFile);
    const parsed = { listeners: measureDarwinConnections(listenOutput.output,
        parseDarwinLsofTcpListenOutput(listenOutput.output), listenOutput.degraded) };
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
    const readProcessFacts = async (): Promise<ReadonlyMap<number, LocalServiceProcessFact>> => listenerPids.length > 0
        ? await projectLocalServiceProcessFacts({
            seedPids: listenerPids,
            onReadFailure: () => diagnostics.push({
                code: 'darwin_process_fact_scan_failed',
                severity: 'warning',
                message: 'Darwin process fact scan failed.',
            }),
        })
        : new Map<number, LocalServiceProcessFact>();
    return {
        listeners: parsed.listeners,
        processes: input.includeProcessFacts === false ? new Map<number, LocalServiceProcessFact>() : await readProcessFacts(),
        ...(input.includeProcessFacts === false ? { readProcessFacts } : {}),
        diagnostics,
    };
}
