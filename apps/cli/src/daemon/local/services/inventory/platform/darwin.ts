import type { LocalServiceListenerFact } from '../scanner';
import type { LocalServiceInventoryDiagnostic } from '../scanner';

type ExecFileBoundary = (
    command: string,
    args: readonly string[],
    options: Readonly<{ timeout: number; maxBuffer: number }>,
) => Promise<Readonly<{ stdout: string | Buffer }>>;

export type DarwinLocalServiceScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

function parseLsofNameField(value: string): Readonly<{ address: string; port: number }> | null {
    if (!value.includes('(LISTEN)')) return null;
    const withoutPrefix = value.replace(/^TCP\s+/i, '').replace(/\s+\(LISTEN\).*$/i, '').trim();
    const portMatch = /:(\d+)$/.exec(withoutPrefix);
    if (!portMatch) return null;
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    const addressRaw = withoutPrefix.slice(0, withoutPrefix.length - portMatch[0].length).trim();
    const address = addressRaw === '*' ? '0.0.0.0' : addressRaw.replace(/^\[|\]$/g, '');
    return { address, port };
}

export function parseDarwinLsofTcpListenOutput(output: string): LocalServiceListenerFact[] {
    const listeners: LocalServiceListenerFact[] = [];
    let pid: number | undefined;
    for (const line of output.split(/\r?\n/)) {
        if (!line) continue;
        const tag = line[0];
        const value = line.slice(1);
        if (tag === 'p') {
            const parsedPid = Number(value);
            pid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined;
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
    }
    return listeners;
}

export async function readDarwinLocalServiceListeners(input: Readonly<{
    execFile: ExecFileBoundary;
}>): Promise<DarwinLocalServiceScanResult> {
    try {
        const result = await input.execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], {
            timeout: 2_000,
            maxBuffer: 1024 * 1024,
        });
        return {
            listeners: parseDarwinLsofTcpListenOutput(
                typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8'),
            ),
            diagnostics: [],
        };
    } catch (error) {
        return {
            listeners: [],
            diagnostics: [{
                code: 'darwin_lsof_scan_failed',
                severity: 'warning',
                message: error instanceof Error ? error.message : String(error),
            }],
        };
    }
}
