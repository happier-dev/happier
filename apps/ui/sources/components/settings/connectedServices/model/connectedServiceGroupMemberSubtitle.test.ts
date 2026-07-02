import { describe, expect, it, vi } from 'vitest';
import { ConnectedServiceAuthGroupV1Schema, type ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import { t } from '@/text';

import {
    formatConnectedServiceGroupMemberSubtitle,
    resolveConnectedServiceGroupMemberBlocker,
    resolveConnectedServiceGroupMemberReadiness,
} from './connectedServiceGroupMemberSubtitle';

function buildGroupWithMemberState(params: {
    state: Record<string, unknown>;
    enabled?: boolean;
}): ConnectedServiceAuthGroupV1 {
    return ConnectedServiceAuthGroupV1Schema.parse({
        v: 1,
        serviceId: 'anthropic',
        groupId: 'primary',
        displayName: 'Team pool',
        policy: { v: 1 },
        activeProfileId: 'work',
        generation: 2,
        state: { status: 'ready' },
        createdAt: 1,
        updatedAt: 2,
        members: [
            {
                v: 1,
                serviceId: 'anthropic',
                groupId: 'primary',
                profileId: 'work',
                priority: 10,
                enabled: params.enabled ?? true,
                state: params.state,
                createdAt: 1,
                updatedAt: 2,
            },
        ],
    });
}

describe('connectedServiceGroupMemberSubtitle', () => {
    it('projects each active limiter into a typed blocker with stable precedence', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_800_000_000_000));
        try {
            const expectations: ReadonlyArray<readonly [Record<string, unknown>, string, number]> = [
                [{
                    authInvalidUntilMs: 1_800_000_010_000,
                    planUnavailableUntilMs: 1_800_000_020_000,
                    validationBlockedUntilMs: 1_800_000_030_000,
                    quotaExhaustedUntilMs: 1_800_000_040_000,
                    rateLimitedUntilMs: 1_800_000_050_000,
                    capacityLimitedUntilMs: 1_800_000_060_000,
                    exhaustedUntilMs: 1_800_000_070_000,
                    cooldownUntilMs: 1_800_000_080_000,
                }, 'auth_invalid', 1_800_000_010_000],
                [{ planUnavailableUntilMs: 1_800_000_020_000 }, 'plan_unavailable', 1_800_000_020_000],
                [{ validationBlockedUntilMs: 1_800_000_030_000 }, 'validation_blocked', 1_800_000_030_000],
                [{ quotaExhaustedUntilMs: 1_800_000_040_000 }, 'quota_exhausted', 1_800_000_040_000],
                [{ rateLimitedUntilMs: 1_800_000_050_000 }, 'rate_limited', 1_800_000_050_000],
                [{ capacityLimitedUntilMs: 1_800_000_060_000 }, 'capacity_limited', 1_800_000_060_000],
                [{ exhaustedUntilMs: 1_800_000_070_000 }, 'exhausted', 1_800_000_070_000],
                [{ cooldownUntilMs: 1_800_000_080_000 }, 'cooldown', 1_800_000_080_000],
            ];

            for (const [state, kind, untilMs] of expectations) {
                const group = buildGroupWithMemberState({ state });
                expect(resolveConnectedServiceGroupMemberBlocker(group.members[0]!)).toEqual({ kind, untilMs });
                expect(resolveConnectedServiceGroupMemberReadiness(group.members[0]!)).toBe(kind);
            }

            const ready = buildGroupWithMemberState({ state: {} });
            expect(resolveConnectedServiceGroupMemberBlocker(ready.members[0]!)).toBeNull();
            expect(resolveConnectedServiceGroupMemberReadiness(ready.members[0]!)).toBe('ready');

            const disabled = buildGroupWithMemberState({
                state: { quotaExhaustedUntilMs: 1_800_000_040_000 },
                enabled: false,
            });
            expect(resolveConnectedServiceGroupMemberReadiness(disabled.members[0]!)).toBe('disabled');
        } finally {
            vi.useRealTimers();
        }
    });

    it('surfaces the concrete blocker with its reset window in the member subtitle', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_800_000_000_000));
        try {
            const group = buildGroupWithMemberState({
                state: {
                    planUnavailableUntilMs: 1_800_000_020_000,
                    lastFailureKind: 'plan_unavailable',
                },
            });

            const subtitle = formatConnectedServiceGroupMemberSubtitle(group.members[0]!, group);

            expect(subtitle).toContain(t('connectedServices.detail.groups.memberPlanUnavailableUntil', {
                time: new Date(1_800_000_020_000).toLocaleString(),
            }));
            expect(subtitle).toContain(t('connectedServices.detail.groups.memberLastFailure', { reason: 'plan_unavailable' }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not surface expired limiter timestamps as active member blockers', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_800_000_100_000));
        try {
            const group = ConnectedServiceAuthGroupV1Schema.parse({
                v: 1,
                serviceId: 'anthropic',
                groupId: 'primary',
                displayName: 'Team pool',
                policy: { v: 1 },
                activeProfileId: 'work',
                generation: 2,
                state: { status: 'ready' },
                createdAt: 1,
                updatedAt: 2,
                members: [
                    {
                        v: 1,
                        serviceId: 'anthropic',
                        groupId: 'primary',
                        profileId: 'work',
                        priority: 10,
                        enabled: true,
                        state: {
                            exhaustedUntilMs: 1_800_000_010_000,
                            cooldownUntilMs: 1_800_000_020_000,
                            lastFailureKind: 'usage_limit',
                        },
                        createdAt: 1,
                        updatedAt: 2,
                    },
                ],
            });

            const subtitle = formatConnectedServiceGroupMemberSubtitle(group.members[0]!, group);

            expect(subtitle).not.toContain(t('connectedServices.detail.groups.memberExhaustedUntil', {
                time: new Date(1_800_000_010_000).toLocaleString(),
            }));
            expect(subtitle).not.toContain(t('connectedServices.detail.groups.cooldown', {
                time: new Date(1_800_000_020_000).toLocaleString(),
            }));
            expect(subtitle).toContain(t('connectedServices.detail.groups.memberLastFailure', { reason: 'usage_limit' }));
        } finally {
            vi.useRealTimers();
        }
    });
});
