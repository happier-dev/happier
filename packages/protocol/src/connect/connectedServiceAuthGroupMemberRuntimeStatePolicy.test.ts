import { describe, expect, it } from 'vitest';

import {
    clearConnectedServiceAuthGroupMemberRuntimeBlockers,
    readConnectedServiceManualActiveProfileRuntimeBlocker,
} from './connectedServiceAuthGroupMemberRuntimeStatePolicy.js';

describe('connectedServiceAuthGroupMemberRuntimeStatePolicy', () => {
    it('blocks manual active-profile selection only for reset-wait runtime blockers', () => {
        const nowMs = 1_000;

        expect(readConnectedServiceManualActiveProfileRuntimeBlocker({
            cooldownUntilMs: 2_000,
            exhaustedUntilMs: 3_000,
            quotaExhaustedUntilMs: 4_000,
            rateLimitedUntilMs: 5_000,
            capacityLimitedUntilMs: 6_000,
            authInvalidUntilMs: 7_000,
            planUnavailableUntilMs: 8_000,
            validationBlockedUntilMs: 9_000,
            providerResetsAtMs: 10_000,
            credentialHealthStatus: 'needs_reauth',
        }, nowMs)).toEqual({ resetAtMs: 5_000 });
    });

    it('does not turn non-reset health or availability evidence into manual blockers', () => {
        expect(readConnectedServiceManualActiveProfileRuntimeBlocker({
            capacityLimitedUntilMs: 6_000,
            authInvalidUntilMs: 7_000,
            planUnavailableUntilMs: 8_000,
            validationBlockedUntilMs: 9_000,
            providerResetsAtMs: 10_000,
            credentialHealthStatus: 'needs_reauth',
        }, 1_000)).toBeNull();
    });

    it('clears shared member runtime blocker fields after accepted positive evidence', () => {
        expect(clearConnectedServiceAuthGroupMemberRuntimeBlockers({
            cooldownStartedAtMs: 1_000,
            cooldownUntilMs: 2_000,
            exhaustedUntilMs: 3_000,
            quotaExhaustedUntilMs: 4_000,
            rateLimitedUntilMs: 5_000,
            capacityLimitedUntilMs: 6_000,
            authInvalidUntilMs: 7_000,
            planUnavailableUntilMs: 8_000,
            validationBlockedUntilMs: 9_000,
            providerResetsAtMs: 10_000,
            credentialHealthStatus: 'needs_reauth',
            lastFailureKind: 'auth_failed',
            lastObservedAtMs: 11_000,
        })).toEqual({
            providerResetsAtMs: 10_000,
        });
    });
});
