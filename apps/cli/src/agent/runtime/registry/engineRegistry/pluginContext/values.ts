export function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readOptionalFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseEnvBoundedInt(
    name: string,
    opts: Readonly<{ min: number; max: number; fallback: number }>,
): number {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.trim().length === 0) return opts.fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return opts.fallback;
    return Math.min(opts.max, Math.max(opts.min, parsed));
}

export function parseEnvBoolean(name: string, opts?: Readonly<{ defaultValue?: boolean }>): boolean {
    const raw = process.env[name];
    if (typeof raw !== 'string') return opts?.defaultValue ?? false;
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) return opts?.defaultValue ?? false;
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return opts?.defaultValue ?? false;
}

function createAbortReasonError(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (reason instanceof Error) {
        return reason;
    }
    if (typeof reason === 'string' && reason.trim().length > 0) {
        return new Error(reason.trim());
    }
    return new Error('Plugin permission request canceled');
}

export function throwIfSignalAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw createAbortReasonError(signal);
    }
}

export async function withCallerAbortSignal<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T> {
    if (!signal) {
        return await operation;
    }
    throwIfSignalAborted(signal);
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(createAbortReasonError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
        });
    });
}
