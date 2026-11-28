import { describe, expect, it } from 'vitest';

import {
    isConnectedServiceProviderAccountAccessAllowed,
    resolveAgentAccountStatusConsent,
    resolveConnectedServicePoolConsentPolicy,
} from './poolConsent.js';

describe('connected service pool consent', () => {
    it('admits Antigravity provider-account access only for pool members, with the FAQ notice', () => {
        expect(resolveConnectedServicePoolConsentPolicy('antigravity')).toEqual({
            required: true,
            learnMoreUrl: 'https://antigravity.google/docs/faq',
        });
        expect(isConnectedServiceProviderAccountAccessAllowed({ serviceId: 'antigravity', poolMember: false })).toBe(false);
        expect(isConnectedServiceProviderAccountAccessAllowed({ serviceId: 'antigravity', poolMember: true })).toBe(true);
    });

    it('applies the same rule to Gemini accounts', () => {
        expect(resolveConnectedServicePoolConsentPolicy('gemini').required).toBe(true);
        expect(isConnectedServiceProviderAccountAccessAllowed({ serviceId: 'gemini', poolMember: false })).toBe(false);
    });

    it('admits account reads for a non-pool account when the agent\'s account-status setting is on', () => {
        expect(isConnectedServiceProviderAccountAccessAllowed({ serviceId: 'antigravity', poolMember: false,
            accountStatusByAgentId: { agy: true } })).toBe(true);
        expect(isConnectedServiceProviderAccountAccessAllowed({ serviceId: 'antigravity', poolMember: false,
            accountStatusByAgentId: { agy: false, gemini: true } })).toBe(false);
    });

    it('offers the account-status setting only to agents that declare consent-gated services', () => {
        expect(resolveAgentAccountStatusConsent('agy')).toEqual({ serviceIds: ['antigravity'], learnMoreUrl: 'https://antigravity.google/docs/faq' });
        expect(resolveAgentAccountStatusConsent('codex')).toBeNull();
    });

    it('leaves services without the declaration unchanged', () => {
        expect(resolveConnectedServicePoolConsentPolicy('openai-codex')).toEqual({ required: false, learnMoreUrl: null });
        expect(isConnectedServiceProviderAccountAccessAllowed({ serviceId: 'claude-subscription', poolMember: false })).toBe(true);
    });
});
