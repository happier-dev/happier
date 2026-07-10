import type { ConnectedServiceAuthGroupMemberStateV1 } from './connectedServiceSchemas.js';

export type ConnectedServiceManualActiveProfileRuntimeBlocker = Readonly<{
    resetAtMs?: number;
}>;

const CONNECTED_SERVICE_MEMBER_RUNTIME_BLOCKER_CLEAR_KEYS = [
    'cooldownStartedAtMs',
    'cooldownUntilMs',
    'exhaustedUntilMs',
    'quotaExhaustedUntilMs',
    'rateLimitedUntilMs',
    'capacityLimitedUntilMs',
    'authInvalidUntilMs',
    'planUnavailableUntilMs',
    'validationBlockedUntilMs',
    'credentialHealthStatus',
    'lastFailureKind',
    'lastFailureCode',
    'lastObservedPlanType',
    'lastObservedAtMs',
] as const satisfies ReadonlyArray<keyof ConnectedServiceAuthGroupMemberStateV1>;

function readFutureTimestamp(value: number | null | undefined, nowMs: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > nowMs ? value : null;
}

export function readConnectedServiceManualActiveProfileRuntimeBlocker(
    state: ConnectedServiceAuthGroupMemberStateV1,
    nowMs: number,
): ConnectedServiceManualActiveProfileRuntimeBlocker | null {
    const resetAtValues = [
        state.cooldownUntilMs,
        state.exhaustedUntilMs,
        state.quotaExhaustedUntilMs,
        state.rateLimitedUntilMs,
    ]
        .map((value) => readFutureTimestamp(value, nowMs))
        .filter((value): value is number => value !== null);

    return resetAtValues.length > 0 ? { resetAtMs: Math.max(...resetAtValues) } : null;
}

export function clearConnectedServiceAuthGroupMemberRuntimeBlockers(
    state: ConnectedServiceAuthGroupMemberStateV1,
): ConnectedServiceAuthGroupMemberStateV1 {
    let changed = false;
    const next: {
        -readonly [Key in keyof ConnectedServiceAuthGroupMemberStateV1]: ConnectedServiceAuthGroupMemberStateV1[Key];
    } = { ...state };

    for (const key of CONNECTED_SERVICE_MEMBER_RUNTIME_BLOCKER_CLEAR_KEYS) {
        if (next[key] !== undefined) {
            delete next[key];
            changed = true;
        }
    }

    return changed ? next : state;
}
