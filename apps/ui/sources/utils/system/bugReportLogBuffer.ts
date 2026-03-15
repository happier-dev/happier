export type BugReportLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export type BugReportLogEntry = {
    level: BugReportLogLevel;
    timestamp: string;
    message: string;
};

let maxEntries = 250;
let maxMessageChars = 2_000;
const MIN_MESSAGE_CHARS = 16;
let installed = false;
let browserErrorCaptureInstalled = false;
const entries: BugReportLogEntry[] = [];
const originalConsole: Partial<Record<BugReportLogLevel, (...args: unknown[]) => void>> = {};

function formatArg(arg: unknown): string {
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean' || arg === null || arg === undefined) {
        return String(arg);
    }
    if (arg instanceof Error) {
        const stack = typeof arg.stack === 'string' && arg.stack.trim().length > 0 ? arg.stack.trim() : '';
        // Prefer including a stack for diagnostics, but keep it bounded by maxMessageChars.
        return stack ? `${arg.name}: ${arg.message}\nstack: ${stack}` : `${arg.name}: ${arg.message}`;
    }
    try {
        return JSON.stringify(arg);
    } catch {
        return Object.prototype.toString.call(arg);
    }
}

function trimMessage(input: string): string {
    const normalizedMax = Math.max(MIN_MESSAGE_CHARS, Math.floor(maxMessageChars));
    if (input.length <= normalizedMax) return input;
    if (normalizedMax <= 3) return input.slice(0, normalizedMax);
    // Keep output ASCII-only to avoid surprises in environments that don't handle unicode well.
    return `${input.slice(0, normalizedMax - 3)}...`;
}

function appendEntry(entry: BugReportLogEntry): void {
    entries.push(entry);
    if (entries.length <= maxEntries) return;
    const overflow = entries.length - maxEntries;
    entries.splice(0, overflow);
}

function wrapConsoleLevel(level: BugReportLogLevel): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
        appendEntry({
            level,
            timestamp: new Date().toISOString(),
            message: trimMessage(args.map(formatArg).join(' ')),
        });

        const original = originalConsole[level];
        if (original) {
            original(...args);
        }
    };
}

function installBrowserErrorCaptureIfAvailable(): void {
    if (browserErrorCaptureInstalled) return;
    const win = (globalThis as any)?.window;
    if (!win) return;

    const previousOnError = typeof win.onerror === 'function' ? win.onerror : null;
    const previousOnUnhandledRejection = typeof win.onunhandledrejection === 'function' ? win.onunhandledrejection : null;

    win.onerror = (message: unknown, source: unknown, lineno: unknown, colno: unknown, error: unknown) => {
        const msg = typeof message === 'string' ? message : 'Unhandled window error';
        const filename = typeof source === 'string' ? source : '';
        const line = typeof lineno === 'number' ? lineno : null;
        const col = typeof colno === 'number' ? colno : null;
        const stack =
            error instanceof Error && typeof error.stack === 'string' && error.stack.trim().length > 0
                ? error.stack.trim()
                : '';
        const where = filename ? ` (${filename}${line ? `:${line}` : ''}${col ? `:${col}` : ''})` : '';
        const suffix = stack ? `\nstack: ${stack}` : (error ? `\ndetail: ${formatArg(error)}` : '');

        appendEntry({
            level: 'error',
            timestamp: new Date().toISOString(),
            message: trimMessage(`${msg}${where}${suffix}`),
        });

        if (previousOnError) {
            try {
                return previousOnError(message, source, lineno, colno, error);
            } catch {
                // Ignore errors from previous handlers.
            }
        }
        return false;
    };

    win.onunhandledrejection = (evt: any) => {
        const reason = evt?.reason;
        const suffix = reason instanceof Error
            ? formatArg(reason)
            : typeof reason === 'string'
                ? reason
                : reason
                    ? formatArg(reason)
                    : 'unknown';
        appendEntry({
            level: 'error',
            timestamp: new Date().toISOString(),
            message: trimMessage(`Unhandled promise rejection\n${suffix}`),
        });

        if (previousOnUnhandledRejection) {
            try {
                return previousOnUnhandledRejection(evt);
            } catch {
                // Ignore errors from previous handlers.
            }
        }
        return undefined;
    };
    browserErrorCaptureInstalled = true;
}

export function installBugReportConsoleCapture(options?: { maxEntries?: number; maxMessageChars?: number }): void {
    if (typeof options?.maxEntries === 'number' && Number.isFinite(options.maxEntries) && options.maxEntries > 0) {
        maxEntries = Math.max(1, Math.floor(options.maxEntries));
    }
    if (
        typeof options?.maxMessageChars === 'number'
        && Number.isFinite(options.maxMessageChars)
        && options.maxMessageChars > 0
    ) {
        maxMessageChars = Math.max(MIN_MESSAGE_CHARS, Math.floor(options.maxMessageChars));
    }

    // Console capture and browser error capture are separate; the browser capture can be installed even
    // when console capture was already installed earlier.
    installBrowserErrorCaptureIfAvailable();
    if (installed) return;

    const levels: BugReportLogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
    const consoleMethods = console as unknown as Record<BugReportLogLevel, unknown>;
    for (const level of levels) {
        const rawMethod = consoleMethods[level];
        if (typeof rawMethod !== 'function') continue;
        originalConsole[level] = rawMethod.bind(console) as (...args: unknown[]) => void;
        (consoleMethods as Record<BugReportLogLevel, (...args: unknown[]) => void>)[level] = wrapConsoleLevel(level);
    }

    installed = true;
}

export function getBugReportLogEntries(): BugReportLogEntry[] {
    return entries.slice();
}

export function clearBugReportLogBuffer(): void {
    entries.length = 0;
}

export function getBugReportLogText(maxChars: number = 50_000, options?: { sinceMs?: number }): string {
    const normalizedMax = Math.max(1_000, Math.floor(maxChars));
    const filteredEntries = typeof options?.sinceMs === 'number' && Number.isFinite(options.sinceMs)
        ? entries.filter((entry) => {
            const parsed = Date.parse(entry.timestamp);
            return Number.isFinite(parsed) && parsed >= options.sinceMs!;
        })
        : entries;
    const lines = filteredEntries.map((entry) => `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`);
    const output = lines.join('\n');
    if (output.length <= normalizedMax) return output;
    return output.slice(output.length - normalizedMax);
}
