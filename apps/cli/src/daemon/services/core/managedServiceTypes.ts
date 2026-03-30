export const MANAGED_SERVICE_LIFECYCLE_STATES = [
    'stopped',
    'starting',
    'running',
    'degraded',
    'stopping',
    'crashed',
] as const;

export type ManagedServiceLifecycleState = (typeof MANAGED_SERVICE_LIFECYCLE_STATES)[number];

export type ManagedServiceRestartPolicy = Readonly<{
    maxRestartAttempts: number | null;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterMs: number;
}>;

export type ManagedServiceRestartDecision =
    | Readonly<{
        type: 'restart_after_delay';
        attempt: number;
        delayMs: number;
    }>
    | Readonly<{
        type: 'do_not_restart';
        reason: 'max_restart_attempts_exhausted';
    }>;
