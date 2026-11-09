import { describe, expect, it } from 'vitest';
import { projectConnectedAccountSubscriptionFacts, resolveConnectedAccountAccessMode } from './resolveConnectedAccountAccessMode';
import { presentConnectedAccountAccessModeForAccount } from './presentConnectedAccountAccessMode';
import { t } from '@/text';

describe('account access mode presentation facts', () => {
    it('prefers the producer mode to observed usage and uses a subscribed observation only when mode is unknown', () => {
        expect(resolveConnectedAccountAccessMode({ accessMode: 'apiKey' }, { status: 'subscribed' }))
            .toEqual({ kind: 'apiKey', keySuffix: null });
        expect(resolveConnectedAccountAccessMode({ accessMode: 'subscription' }, { status: 'none' }))
            .toEqual({ kind: 'subscription' });
        expect(resolveConnectedAccountAccessMode({}, { status: 'subscribed' })).toEqual({ kind: 'subscription' });
        expect(resolveConnectedAccountAccessMode({}, { status: 'none' })).toBeNull();
        expect(resolveConnectedAccountAccessMode({}, { status: 'unavailable' })).toBeNull();
        expect(resolveConnectedAccountAccessMode({})).toBeNull();
    });
    it('presents an explicit key without a stale plan and keeps subscription and unknown plan facts', () => {
        expect(presentConnectedAccountAccessModeForAccount({ accessMode: 'apiKey' }, 'Old subscription'))
            .toBe(t('connectedServicesSettings.accessApiKey'));
        expect(presentConnectedAccountAccessModeForAccount({ accessMode: 'subscription' }, 'Pro')).toBe('Pro');
        expect(presentConnectedAccountAccessModeForAccount({ accessMode: 'subscription' }, null))
            .toBe(t('connectedServicesSettings.accessSubscription'));
        expect(presentConnectedAccountAccessModeForAccount({}, 'Observed plan')).toBe('Observed plan');
        expect(presentConnectedAccountAccessModeForAccount({}, null)).toBeNull();
    });
    it('suppresses stale subscription facts only for an explicit API-key account', () => {
        const facts = { planLabel: 'Old subscription', subscription: {
            status: 'subscribed' as const, renewal: 'on' as const, observedAtMs: 1_000, staleAfterMs: 10_000,
        } };
        expect(projectConnectedAccountSubscriptionFacts({ kind: 'apiKey', keySuffix: null }, facts))
            .toEqual({ planLabel: null, subscription: null });
        expect(projectConnectedAccountSubscriptionFacts({ kind: 'subscription' }, facts)).toEqual(facts);
        expect(projectConnectedAccountSubscriptionFacts(null, facts)).toEqual(facts);
    });
});
