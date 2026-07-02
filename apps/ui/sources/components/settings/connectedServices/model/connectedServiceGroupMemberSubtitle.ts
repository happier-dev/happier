import type { ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import { t } from '@/text';

type ConnectedServiceGroupMember = ConnectedServiceAuthGroupV1['members'][number];

export type ConnectedServiceGroupMemberBlockerKind =
    | 'quota_exhausted'
    | 'rate_limited'
    | 'capacity_limited'
    | 'auth_invalid'
    | 'plan_unavailable'
    | 'validation_blocked'
    | 'exhausted'
    | 'cooldown';

export type ConnectedServiceGroupMemberReadiness =
    | 'ready'
    | 'disabled'
    | ConnectedServiceGroupMemberBlockerKind;

export type ConnectedServiceGroupMemberBlocker = Readonly<{
    kind: ConnectedServiceGroupMemberBlockerKind;
    untilMs: number;
}>;

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function isFutureLimiter(value: number | null, nowMs: number): value is number {
    return value !== null && value > nowMs;
}

function readMemberState(member: ConnectedServiceGroupMember): Record<string, unknown> {
    return member.state && typeof member.state === 'object' && !Array.isArray(member.state)
        ? member.state as Record<string, unknown>
        : {};
}

/**
 * F9 limiter-blocker projection: surfaces the one concrete reason a group member cannot serve
 * traffic right now, with its reset window. Precedence mirrors the daemon's selection-eligibility
 * limiter order: identity blocks (auth/plan/validation) outrank quota blocks, which outrank the
 * generic exhausted/cooldown windows.
 */
export function resolveConnectedServiceGroupMemberBlocker(
    member: ConnectedServiceGroupMember,
): ConnectedServiceGroupMemberBlocker | null {
    const state = readMemberState(member);
    const nowMs = Date.now();
    const limiters: ReadonlyArray<readonly [ConnectedServiceGroupMemberBlockerKind, number | null]> = [
        ['auth_invalid', readNumber(state.authInvalidUntilMs)],
        ['plan_unavailable', readNumber(state.planUnavailableUntilMs)],
        ['validation_blocked', readNumber(state.validationBlockedUntilMs)],
        ['quota_exhausted', readNumber(state.quotaExhaustedUntilMs)],
        ['rate_limited', readNumber(state.rateLimitedUntilMs)],
        ['capacity_limited', readNumber(state.capacityLimitedUntilMs)],
        ['exhausted', readNumber(state.exhaustedUntilMs)],
        ['cooldown', readNumber(state.cooldownUntilMs)],
    ];
    for (const [kind, untilMs] of limiters) {
        if (isFutureLimiter(untilMs, nowMs)) return { kind, untilMs };
    }
    return null;
}

export function resolveConnectedServiceGroupMemberReadiness(
    member: ConnectedServiceGroupMember,
): ConnectedServiceGroupMemberReadiness {
    if (!member.enabled) return 'disabled';
    return resolveConnectedServiceGroupMemberBlocker(member)?.kind ?? 'ready';
}

function formatConnectedServiceGroupMemberBlocker(
    blocker: ConnectedServiceGroupMemberBlocker | null,
): string | null {
    if (!blocker) return null;
    const time = new Date(blocker.untilMs).toLocaleString();
    switch (blocker.kind) {
        case 'auth_invalid':
            return t('connectedServices.detail.groups.memberAuthInvalidUntil', { time });
        case 'plan_unavailable':
            return t('connectedServices.detail.groups.memberPlanUnavailableUntil', { time });
        case 'validation_blocked':
            return t('connectedServices.detail.groups.memberValidationBlockedUntil', { time });
        case 'quota_exhausted':
            return t('connectedServices.detail.groups.memberQuotaExhaustedUntil', { time });
        case 'rate_limited':
            return t('connectedServices.detail.groups.memberRateLimitedUntil', { time });
        case 'capacity_limited':
            return t('connectedServices.detail.groups.memberCapacityLimitedUntil', { time });
        case 'exhausted':
            return t('connectedServices.detail.groups.memberExhaustedUntil', { time });
        case 'cooldown':
            return t('connectedServices.detail.groups.cooldown', { time });
    }
}

export function formatConnectedServiceGroupMemberSubtitle(
    member: ConnectedServiceGroupMember,
    group: ConnectedServiceAuthGroupV1,
): string {
    const state = readMemberState(member);
    const lastFailureKind = readString(state.lastFailureKind) || null;
    const parts = [
        member.profileId === group.activeProfileId ? t('connectedServices.detail.groups.memberActive') : null,
        member.enabled ? t('connectedServices.detail.groups.memberEnabled') : t('connectedServices.detail.groups.memberDisabled'),
        t('connectedServices.detail.groups.memberPriority', { priority: member.priority }),
        formatConnectedServiceGroupMemberBlocker(resolveConnectedServiceGroupMemberBlocker(member)),
        lastFailureKind
            ? t('connectedServices.detail.groups.memberLastFailure', { reason: lastFailureKind })
            : null,
    ];
    return parts.filter(Boolean).join(' • ');
}
