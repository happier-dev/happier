import { describe, expect, it } from 'vitest';

import { countConnectedAccountsNeedingSignIn } from './countConnectedAccountsNeedingSignIn';
import { listConnectedAccountsNeedingSignIn } from './connectedAccountsNeedingSignIn';
import { getLegacyConnectedServiceRegistryEntry } from './connectedServiceRegistry';

const entry = getLegacyConnectedServiceRegistryEntry('openai-codex');
const v4 = (status: string) => ({ ref: { service: entry.service!, accountId: status }, status });
const entries = [entry];

describe('countConnectedAccountsNeedingSignIn', () => {
    it('counts the same negotiated actionable list as Home', () => {
        const params = { profile: {
            connectedAccountsV4: [{ ref: { service: entry.service!, accountId: 'work' }, status: 'needs_reauth' }], connectedServicesV2: [{ serviceId: 'openai-codex', profiles: [
                { profileId: 'work', status: 'needs_reauth' }, { profileId: 'home', status: 'needs_reauth' },
            ] }],
        }, accountTransport: 'advertised-v4' as const, entries: [entry] };
        expect(countConnectedAccountsNeedingSignIn(params)).toBe(listConnectedAccountsNeedingSignIn(params).length);
    });
    it('does not paint an unknown held status as a sign-in need in either released projection', () => {
        expect(countConnectedAccountsNeedingSignIn({ profile: {
            connectedServicesV2: [], connectedAccountsV4: [v4('future-peer-state'), v4('needs_reauth')],
        }, accountTransport: 'advertised-v4', entries })).toBe(1);
        const heldLegacy = [{ serviceId: 'openai-codex', profiles: [
            { profileId: 'a', status: 'future-peer-state' }, { profileId: 'b', status: 'needs_reauth' },
        ] }];
        expect(countConnectedAccountsNeedingSignIn({ profile: { connectedServicesV2: heldLegacy }, accountTransport: 'legacy', entries })).toBe(1);
    });
    it('counts only accounts that need a new sign-in; low limits and retrying refreshes are not a "needs you"', () => {
        expect(countConnectedAccountsNeedingSignIn({ profile: {
            connectedAccountsV4: [v4('needs_reauth'), v4('connected'), v4('refresh_failed_retryable'), v4('refreshing')],
            connectedServicesV2: [],
        }, accountTransport: 'advertised-v4', entries })).toBe(1);
    });

    it('uses negotiated transport rather than falling back based on list length', () => {
        const profile = { connectedAccountsV4: [], connectedServicesV2: [{ serviceId: 'openai-codex', profiles: [
            { profileId: 'a', status: 'needs_reauth' }, { profileId: 'b', status: 'needs_reauth' },
        ] }] };
        expect(countConnectedAccountsNeedingSignIn({ profile, accountTransport: 'legacy', entries })).toBe(1);
        expect(countConnectedAccountsNeedingSignIn({ profile, accountTransport: 'advertised-v4', entries })).toBe(0);
        expect(countConnectedAccountsNeedingSignIn({ profile, accountTransport: 'indeterminate', entries })).toBe(0);
    });
});
