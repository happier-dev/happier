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
    'modelUnavailableUntilMsByModelId',
    'validationBlockedUntilMs',
    'credentialHealthStatus',
    'autoDisabledReason',
    'lastFailureKind',
    'lastFailureCode',
    'lastFailureProviderLimitId',
    'lastObservedAtMs',
] as const satisfies ReadonlyArray<keyof ConnectedServiceAuthGroupMemberStateV1>;

/**
 * Limiter cooldowns that an explicit user selection of a member overrides: the server's manual
 * active-profile guard reports them, and the daemon's switch state drops them for a member the
 * user selected after the failure that set them.
 */
export const CONNECTED_SERVICE_MANUAL_OVERRIDABLE_RUNTIME_BLOCKER_KEYS = [
    'cooldownUntilMs',
    'exhaustedUntilMs',
    'quotaExhaustedUntilMs',
    'rateLimitedUntilMs',
] as const satisfies ReadonlyArray<keyof ConnectedServiceAuthGroupMemberStateV1>;

function futureTimestamp(value: number | null | undefined, nowMs: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > nowMs ? value : null;
}

export function readConnectedServiceManualActiveProfileRuntimeBlocker(
    state: ConnectedServiceAuthGroupMemberStateV1,
    nowMs: number,
): ConnectedServiceManualActiveProfileRuntimeBlocker | null {
    const resetAtValues = CONNECTED_SERVICE_MANUAL_OVERRIDABLE_RUNTIME_BLOCKER_KEYS
        .map((key) => futureTimestamp(state[key], nowMs))
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
