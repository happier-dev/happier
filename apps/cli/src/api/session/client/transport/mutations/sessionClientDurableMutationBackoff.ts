const DEFAULT_BASE_RETRY_MS = 500;
const DEFAULT_MAX_RETRY_MS = 30_000;
const DEFAULT_JITTER_MS = 250;
const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_TRANSCRIPT_FLUSH_BATCH_LIMIT = 25;

function readBoundedIntEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

export function resolveSessionClientDurableMutationRetryDelayMs(attempts: number): number {
    const baseMs = readBoundedIntEnv('HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS', DEFAULT_BASE_RETRY_MS);
    const maxMs = readBoundedIntEnv('HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS', DEFAULT_MAX_RETRY_MS);
    const jitterMs = readBoundedIntEnv('HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS', DEFAULT_JITTER_MS);
    const exponent = Math.min(Math.max(0, attempts), 8);
    const delay = Math.min(maxMs, baseMs * (2 ** exponent));
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    return delay + jitter;
}

export function resolveSessionClientDurableMutationMaxAttempts(): number {
    return Math.max(1, readBoundedIntEnv('HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS));
}

export function resolveSessionClientDurableMutationTranscriptFlushBatchLimit(): number {
    return Math.max(
        1,
        readBoundedIntEnv(
            'HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT',
            DEFAULT_TRANSCRIPT_FLUSH_BATCH_LIMIT,
        ),
    );
}
