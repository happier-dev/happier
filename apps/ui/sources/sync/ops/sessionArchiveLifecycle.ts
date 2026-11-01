import { AsyncTimeoutError } from '@/utils/timing/time';

export type SessionArchiveRequestOptions = Readonly<{
    /** Reuse the enclosing archive-stage deadline rather than starting a new request budget. */
    signal?: AbortSignal;
}>;

const DEFAULT_ARCHIVE_TIMEOUT_MS = 75_000;

function readArchiveTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_TIMEOUT_MS ?? '').trim();
    if (!raw) return DEFAULT_ARCHIVE_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_ARCHIVE_TIMEOUT_MS;
    return Math.max(0, Math.min(5 * 60_000, parsed));
}

export function throwIfSessionArchiveAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const reason = (signal as unknown as { reason?: unknown }).reason;
    if (reason instanceof Error) throw reason;
    const error = new Error('Aborted');
    error.name = 'AbortError';
    throw error;
}

export async function withSessionArchiveDeadline<T>(
    run: (context: Readonly<{ signal: AbortSignal; deadlineMs: number; retryActiveSession: boolean }>) => Promise<T>,
): Promise<T> {
    const configuredTimeoutMs = readArchiveTimeoutMs();
    // Zero retains one attempt without inactivity polling; its network read still needs recovery.
    const timeoutMs = configuredTimeoutMs || DEFAULT_ARCHIVE_TIMEOUT_MS;
    const controller = new AbortController();
    const deadlineMs = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(new AsyncTimeoutError('Session archive', timeoutMs)), timeoutMs);
    try {
        const result = await run({ signal: controller.signal, deadlineMs, retryActiveSession: configuredTimeoutMs > 0 });
        throwIfSessionArchiveAborted(controller.signal);
        return result;
    } finally {
        clearTimeout(timer);
    }
}
