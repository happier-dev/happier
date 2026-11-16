const DEFAULT_BASE_RETRY_MS = 500;
const DEFAULT_MAX_RETRY_MS = 30_000;
const DEFAULT_JITTER_MS = 250;
function readBoundedIntEnv(name: string, fallback: number, env: Readonly<Record<string, string | undefined>>): number {
    const parsed = Number.parseInt(String(env[name] ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

/**
 * @realm daemon
 * Node session-mutation retry policy shared by durable outboxes and workflow writes.
 * Reads HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS,
 * HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS and
 * HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS from the supplied environment, or process.env for standalone callers;
 * defaults remain 500 ms, 30 seconds and 250 ms.
 */
export function resolveSessionMutationRetryDelayMs(attempts: number, env: Readonly<Record<string, string | undefined>> = process.env): number {
    const baseMs = readBoundedIntEnv('HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS', DEFAULT_BASE_RETRY_MS, env);
    const maxMs = readBoundedIntEnv('HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS', DEFAULT_MAX_RETRY_MS, env);
    const jitterMs = readBoundedIntEnv('HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS', DEFAULT_JITTER_MS, env);
    const exponent = Math.min(Math.max(0, attempts), 8);
    const delay = Math.min(maxMs, baseMs * (2 ** exponent));
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    return delay + jitter;
}

