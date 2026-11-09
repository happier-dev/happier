export { resolveSessionMutationRetryDelayMs as resolveSessionClientDurableMutationRetryDelayMs } from '@happier-dev/plugin-sdk/sessions';

const DEFAULT_MAX_ATTEMPTS = 12;

function readBoundedIntEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

export function resolveSessionClientDurableMutationMaxAttempts(): number {
    return Math.max(1, readBoundedIntEnv('HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS));
}
