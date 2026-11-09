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

function readModelCooldowns(value: unknown): Record<string, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const cooldowns: Record<string, number> = {};
    for (const [modelId, candidate] of Object.entries(value)) {
        const cooldownUntilMs = readNonNegativeNumber(candidate);
        if (modelId.trim().length > 0 && cooldownUntilMs !== null) {
            cooldowns[modelId] = cooldownUntilMs;
        }
    }
    return cooldowns;
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
        limitCategory?: string | null;
        quotaScope?: string | null;
        providerLimitId?: string | null;
        retryAtMs: number | null;
        cooldownMs: number;
        autoDisablePlanInvalidAccounts?: boolean;
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
    const providerLimitId = input.providerLimitId?.trim();
    delete state.lastFailureProviderLimitId;
    if ((input.reason === 'usage_limit' || input.reason === 'rate_limit') && providerLimitId) {
        state.lastFailureProviderLimitId = providerLimitId;
    }
    if (
        input.limitCategory === 'plan_invalid'
        && input.quotaScope === 'model'
        && providerLimitId
    ) {
        return {
            ...state,
            lastFailureCode: 'model_not_entitled',
            modelUnavailableUntilMsByModelId: {
                ...readModelCooldowns(
                    input.existing.modelUnavailableUntilMsByModelId,
                ),
                [providerLimitId]: resolveUsageLimitRetryAtMs(input)
                    ?? input.observedAtMs,
            },
            ...(input.autoDisablePlanInvalidAccounts === true
                ? { autoDisabledReason: 'model_not_entitled' as const }
                : {}),
        };
    }
    if (
        input.reason === 'permission_denied'
        && input.limitCategory === 'plan_invalid'
    ) {
        return {
            ...state,
            planUnavailableUntilMs: resolveUsageLimitRetryAtMs(input),
        };
    }
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
                planUnavailableUntilMs: resolveUsageLimitRetryAtMs(input),
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
