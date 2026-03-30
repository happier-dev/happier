import { computeRestartDelayMs } from '@/subprocess/supervision/backoff';

import type { ManagedServiceRestartDecision, ManagedServiceRestartPolicy } from './managedServiceTypes';

export type { ManagedServiceRestartDecision, ManagedServiceRestartPolicy } from './managedServiceTypes';

function normalizeNonNegativeInt(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
}

function normalizeRestartAttemptLimit(value: number | null): number | null {
    if (value === null) return null;
    return normalizeNonNegativeInt(value);
}

export function normalizeManagedServiceRestartPolicy(
    policy: ManagedServiceRestartPolicy,
): ManagedServiceRestartPolicy {
    const baseDelayMs = normalizeNonNegativeInt(policy.baseDelayMs);
    const maxDelayMs = Math.max(baseDelayMs, normalizeNonNegativeInt(policy.maxDelayMs));

    return {
        maxRestartAttempts: normalizeRestartAttemptLimit(policy.maxRestartAttempts),
        baseDelayMs,
        maxDelayMs,
        jitterMs: normalizeNonNegativeInt(policy.jitterMs),
    };
}

export function createManagedServiceRestartDecision(params: Readonly<{
    policy: ManagedServiceRestartPolicy;
    completedRestartCount: number;
    random: () => number;
}>): ManagedServiceRestartDecision {
    const policy = normalizeManagedServiceRestartPolicy(params.policy);
    const completedRestartCount = normalizeNonNegativeInt(params.completedRestartCount);
    const attempt = completedRestartCount + 1;

    if (policy.maxRestartAttempts !== null && attempt > policy.maxRestartAttempts) {
        return {
            type: 'do_not_restart',
            reason: 'max_restart_attempts_exhausted',
        };
    }

    return {
        type: 'restart_after_delay',
        attempt,
        delayMs: computeRestartDelayMs({
            attempt,
            baseDelayMs: policy.baseDelayMs,
            maxDelayMs: policy.maxDelayMs,
            jitterMs: policy.jitterMs,
            random: params.random,
        }),
    };
}
