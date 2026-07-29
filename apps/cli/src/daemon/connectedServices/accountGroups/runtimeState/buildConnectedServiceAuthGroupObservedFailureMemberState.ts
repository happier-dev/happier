import type {
    ConnectedServiceAuthGroupMemberStateV1,
} from '@happier-dev/protocol';

function readNonNegativeNumber(value: unknown): number | null {
    if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || value < 0
    ) {
        return null;
    }
    return Math.trunc(value);
}

function resolveUsageLimitRetryAtMs(input: Readonly<{
    retryAtMs: number | null;
    cooldownMs: number;
    observedAtMs: number;
}>): number | null {
    if (input.retryAtMs !== null) return input.retryAtMs;
    const cooldownMs = readNonNegativeNumber(input.cooldownMs);
    return cooldownMs === null
        ? null
        : input.observedAtMs + cooldownMs;
}

export function resolveConnectedServiceAuthGroupFailureRetryAtMs(
    input: Readonly<{
        retryAtMs?: number | null;
        retryAfterMs?: number | null;
        resetsAtMs?: number | null;
        nowMs: number;
    }>,
): number | null {
    const resetsAtMs = readNonNegativeNumber(input.resetsAtMs);
    if (resetsAtMs !== null) return resetsAtMs;
    const retryAfterMs = readNonNegativeNumber(input.retryAfterMs);
    if (retryAfterMs !== null) return input.nowMs + retryAfterMs;
    return readNonNegativeNumber(input.retryAtMs);
}

export function buildConnectedServiceAuthGroupObservedFailureMemberState(
    input: Readonly<{
        existing: ConnectedServiceAuthGroupMemberStateV1;
        reason: string;
        retryAtMs: number | null;
        cooldownMs: number;
        planType: string | null | undefined;
        observedAtMs: number;
    }>,
): ConnectedServiceAuthGroupMemberStateV1 {
    const state: ConnectedServiceAuthGroupMemberStateV1 = {
        ...input.existing,
        lastFailureKind: input.reason,
        lastObservedAtMs: input.observedAtMs,
        ...(input.planType
            ? { lastObservedPlanType: input.planType }
            : {}),
    };
    switch (input.reason) {
        case 'usage_limit':
            return {
                ...state,
                quotaExhaustedUntilMs:
                    resolveUsageLimitRetryAtMs(input),
            };
        case 'rate_limit':
            return {
                ...state,
                rateLimitedUntilMs:
                    resolveUsageLimitRetryAtMs(input),
            };
        case 'capacity':
            return {
                ...state,
                capacityLimitedUntilMs:
                    resolveUsageLimitRetryAtMs(input),
            };
        case 'auth_expired':
        case 'refresh_failed':
        case 'account_disabled':
            return {
                ...state,
                authInvalidUntilMs: input.retryAtMs,
            };
        case 'plan':
            return {
                ...state,
                planUnavailableUntilMs: input.retryAtMs,
            };
        case 'validation':
            return {
                ...state,
                validationBlockedUntilMs: input.retryAtMs,
            };
        default:
            return state;
    }
}
