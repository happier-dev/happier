import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';

import {
    sanitizeManagedServerDiagnosticText,
    type ManagedServerDiagnosticSanitizer,
} from './diagnostics';

export const MANAGED_SERVER_LOG_KEEP_COUNT_ENV = 'HAPPIER_MANAGED_SERVER_LOG_KEEP_COUNT';
const DEFAULT_KEEP_COUNT = 50;

export type ManagedServerDurableLogSource = 'stdout' | 'stderr';

/**
 * Live capture handle for a managed server process spawned by the generic plugin host. Teeing
 * post-spawn stdout/stderr here PERSISTS the output for later incident diagnosis. All methods are
 * best-effort and never throw — on any I/O failure the capture degrades to a no-op so logging can
 * never break the managed server. The `logPath` is always returned so callers can surface it on the
 * snapshot / in errors.
 */
export type ManagedServerDurableLogCapture = Readonly<{
    logPath: string;
    write: (source: ManagedServerDurableLogSource, chunk: Buffer | string) => void;
    recordNote: (note: string) => void;
    close: () => Promise<void>;
}>;

type ManagedServerDurableLogHeader = Readonly<{
    id: string;
    commandBasename: string;
    args: readonly string[];
    hostname?: string;
    port: number | null;
    baseUrl: string | null;
    spawnPid: number | null;
    launchFingerprint?: string;
    startedAtIso: string;
}>;

export function resolveManagedServerDurableLogDir(logsDir: string): string {
    return join(logsDir, 'managed-servers');
}

/**
 * Local-time `YYYY-MM-DD-HH-MM-SS` stamp, matching the repo's other log filenames. The `sv-SE`
 * locale yields `YYYY-MM-DD HH:MM:SS`, then separators are normalized to `-`.
 */
export function formatManagedServerDurableLogTimestamp(date: Date = new Date()): string {
    return date
        .toLocaleString('sv-SE', {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        })
        .replace(/[: ]/gu, '-')
        .replace(/,/gu, '');
}

/**
 * `<logsDir>/managed-servers/<YYYY-MM-DD-HH-MM-SS>-<id>-port-<port>-pid-<pid-or-pending>.log`.
 */
export function resolveManagedServerDurableLogPath(params: Readonly<{
    logsDir: string;
    id: string;
    port: number | null;
    pid: number | null;
    now?: Date;
}>): string {
    const timestamp = formatManagedServerDurableLogTimestamp(params.now ?? new Date());
    const idLabel = params.id.replace(/[^A-Za-z0-9_.-]+/gu, '-') || 'managed-server';
    const portLabel = Number.isInteger(params.port) && (params.port ?? -1) > 0 ? String(params.port) : 'unknown';
    const pidLabel = Number.isInteger(params.pid) && (params.pid ?? -1) > 0 ? String(params.pid) : 'pending';
    return join(
        resolveManagedServerDurableLogDir(params.logsDir),
        `${timestamp}-${idLabel}-port-${portLabel}-pid-${pidLabel}.log`,
    );
}

function buildHeaderText(header: ManagedServerDurableLogHeader): string {
    const lines = [
        '# managed server log',
        `# id: ${header.id}`,
        `# started: ${header.startedAtIso}`,
        `# command: ${[header.commandBasename, ...header.args].join(' ')}`,
        ...(header.hostname ? [`# host: ${header.hostname} port: ${header.port ?? '(none)'}`] : [`# port: ${header.port ?? '(none)'}`]),
        `# baseUrl: ${header.baseUrl ?? '(none)'}`,
        `# spawnPid: ${header.spawnPid ?? '(none)'}`,
        `# launchFingerprint: ${header.launchFingerprint ?? '(none)'}`,
        '# NOTE: no environment values, auth headers, or tokens are recorded here.',
        '',
    ];
    return `${lines.join('\n')}\n`;
}

export function createManagedServerDurableLogCapture(params: Readonly<{
    logsDir?: string;
    id: string;
    commandBasename: string;
    args: readonly string[];
    hostname?: string;
    port: number | null;
    baseUrl: string | null;
    spawnPid: number | null;
    launchFingerprint?: string;
    sanitizer: ManagedServerDiagnosticSanitizer;
    now?: Date;
}>): ManagedServerDurableLogCapture {
    const now = params.now ?? new Date();
    const logsDir = params.logsDir ?? configuration.logsDir;
    const logPath = resolveManagedServerDurableLogPath({
        logsDir,
        id: params.id,
        port: params.port,
        pid: params.spawnPid,
        now,
    });

    let stream: WriteStream | null = null;
    try {
        mkdirSync(dirname(logPath), { recursive: true });
        stream = createWriteStream(logPath, { flags: 'a' });
        // Swallow late stream errors (e.g. disk full) so the managed server is never affected.
        stream.on('error', () => {
            stream = null;
        });
        stream.write(buildHeaderText({
            id: params.id,
            commandBasename: params.commandBasename,
            args: params.args,
            ...(params.hostname ? { hostname: params.hostname } : {}),
            port: params.port,
            baseUrl: params.baseUrl,
            spawnPid: params.spawnPid,
            ...(params.launchFingerprint ? { launchFingerprint: params.launchFingerprint } : {}),
            startedAtIso: now.toISOString(),
        }));
    } catch {
        stream = null;
    }

    // Per-source line buffering so each persisted line is prefixed with its source + timestamp and
    // run through the shared managed-server diagnostic sanitizer (no secret leakage).
    const lineBuffers: Record<ManagedServerDurableLogSource, string> = { stdout: '', stderr: '' };

    const writeRaw = (text: string): void => {
        if (!stream || text.length === 0) return;
        try {
            stream.write(text);
        } catch {
            // best-effort
        }
    };

    const emitLine = (source: ManagedServerDurableLogSource, line: string): void => {
        const safe = sanitizeManagedServerDiagnosticText(line, params.sanitizer);
        writeRaw(`[${formatManagedServerDurableLogTimestamp(new Date())}] [${source}] ${safe}\n`);
    };

    const write = (source: ManagedServerDurableLogSource, chunk: Buffer | string): void => {
        if (!stream) return;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const combined = lineBuffers[source] + text;
        const segments = combined.split('\n');
        lineBuffers[source] = segments.pop() ?? '';
        for (const line of segments) emitLine(source, line);
    };

    const flushLineBuffers = (): void => {
        for (const source of ['stdout', 'stderr'] as const) {
            const remainder = lineBuffers[source];
            if (remainder.length > 0) {
                lineBuffers[source] = '';
                emitLine(source, remainder);
            }
        }
    };

    return {
        logPath,
        write,
        recordNote: (note: string) => writeRaw(`# ${sanitizeManagedServerDiagnosticText(note, params.sanitizer)}\n`),
        close: async () => {
            flushLineBuffers();
            const current = stream;
            stream = null;
            if (!current) return;
            await new Promise<void>((resolve) => {
                try {
                    current.end(() => resolve());
                } catch {
                    resolve();
                }
            });
        },
    };
}

function resolveKeepCount(explicit: number | undefined): number {
    if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit > 0) return explicit;
    return readPositiveIntEnv(MANAGED_SERVER_LOG_KEEP_COUNT_ENV, DEFAULT_KEEP_COUNT);
}

/**
 * Prune old managed-server logs by COUNT (never by age, never deleting the current log). Files are
 * named `<timestamp>-...log`, so a descending filename sort is chronological (newest first). The
 * newest `keepCount` are retained; the rest are removed best-effort. `keepPath` (the just-created
 * log) is ALWAYS retained regardless of count. Best-effort: never throws.
 */
export async function pruneManagedServerDurableLogs(params: Readonly<{
    logsDir?: string;
    keepCount?: number;
    keepPath?: string;
}> = {}): Promise<void> {
    try {
        const dir = resolveManagedServerDurableLogDir(params.logsDir ?? configuration.logsDir);
        const keepCount = resolveKeepCount(params.keepCount);
        const keepName = params.keepPath ? basename(params.keepPath) : null;

        const entries = (await readdir(dir).catch(() => [] as string[]))
            .filter((entry) => entry.endsWith('.log'))
            .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest first

        let kept = 0;
        for (const entry of entries) {
            const isCurrent = keepName !== null && entry === keepName;
            if (isCurrent || kept < keepCount) {
                kept += 1;
                continue;
            }
            await rm(join(dir, entry), { force: true }).catch(() => undefined);
        }
    } catch {
        // Best-effort pruning only.
    }
}
