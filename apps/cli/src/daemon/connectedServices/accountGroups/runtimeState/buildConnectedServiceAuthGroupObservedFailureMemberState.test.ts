import { describe, expect, it } from 'vitest';

import {
    buildConnectedServiceAuthGroupObservedFailureMemberState,
} from './buildConnectedServiceAuthGroupObservedFailureMemberState';

describe('buildConnectedServiceAuthGroupObservedFailureMemberState', () => {
    it('records the failed limiter and removes stale window metadata on later unqualified failures', () => {
        const failed = buildConnectedServiceAuthGroupObservedFailureMemberState({ existing: {},
            reason: 'usage_limit', providerLimitId: ' weekly ', retryAtMs: 90_000,
            cooldownMs: 30_000, planType: null, observedAtMs: 1_000 });
        expect(failed).toMatchObject({ lastFailureProviderLimitId: 'weekly' });
        for (const reason of ['usage_limit', 'auth_expired']) {
            expect(buildConnectedServiceAuthGroupObservedFailureMemberState({ existing: failed,
                reason, retryAtMs: null, cooldownMs: 30_000, planType: null, observedAtMs: 2_000,
            })).not.toHaveProperty('lastFailureProviderLimitId');
        }
    });

    it.each([null, 6_000, 100_000_000])('records model entitlement with the provider deadline or configured cooldown (%s)', (retryAtMs) => {
        expect(buildConnectedServiceAuthGroupObservedFailureMemberState({
            existing: {},
            reason: 'plan',
            limitCategory: 'plan_invalid',
            quotaScope: 'model',
            providerLimitId: 'gpt-5.6-sol',
            retryAtMs,
            cooldownMs: 30_000,
            autoDisablePlanInvalidAccounts: false,
            planType: 'free',
            observedAtMs: 1_000,
        })).toEqual(expect.objectContaining({
            lastFailureKind: 'plan',
            lastFailureCode: 'model_not_entitled',
            modelUnavailableUntilMsByModelId: {
                'gpt-5.6-sol': retryAtMs ?? 31_000,
            },
        }));
    });

    it('marks only exact model entitlement evidence for optional persistent disable', () => {
        expect(buildConnectedServiceAuthGroupObservedFailureMemberState({
            existing: {}, reason: 'plan', limitCategory: 'plan_invalid', quotaScope: 'model',
            providerLimitId: 'gpt-5.6-sol', retryAtMs: null, cooldownMs: 30_000,
            autoDisablePlanInvalidAccounts: true, planType: 'free', observedAtMs: 1_000,
        })).toMatchObject({ autoDisabledReason: 'model_not_entitled' });
        const providerScoped = buildConnectedServiceAuthGroupObservedFailureMemberState({
            existing: {}, reason: 'permission_denied', limitCategory: 'plan_invalid', quotaScope: 'provider',
            providerLimitId: null, retryAtMs: null, cooldownMs: 30_000,
            autoDisablePlanInvalidAccounts: true, planType: 'free', observedAtMs: 1_000,
        });
        expect(providerScoped).toEqual(expect.objectContaining({
            planUnavailableUntilMs:
                31_000,
        }));
        expect(providerScoped).not.toHaveProperty('autoDisabledReason');
        expect(buildConnectedServiceAuthGroupObservedFailureMemberState({
            existing: {}, reason: 'plan', retryAtMs: 6_000, cooldownMs: 30_000,
            planType: 'free', observedAtMs: 1_000,
        })).toMatchObject({ planUnavailableUntilMs: 6_000 });
    });
});
