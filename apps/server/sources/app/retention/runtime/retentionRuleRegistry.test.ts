import { describe, expect, it } from 'vitest';

import { readRetentionDomainDefinitions } from '@/app/retention/config/retentionDomains';

import { createRetentionRuleRegistry } from './retentionRuleRegistry';

describe('retention/createRetentionRuleRegistry', () => {
    it('registers one rule per supported v1 retention domain, then the intrinsic expiry passes', () => {
        const registry = createRetentionRuleRegistry();

        expect(registry.map((rule) => rule.id)).toEqual([
            'sessions',
            'sessionSidechainMessages',
            'accountChanges',
            'usageEvents',
            'providerAccountUsageHistory',
            'voiceSessionLeases',
            'userFeedItems',
            'publicShareAccessLogs',
            'terminalAuthRequests',
            'accountAuthRequests',
            'authPairingSessions',
            'repeatKeys',
            'globalLocks',
            'automationRuns',
            'automationRunEvents',
            'homeAdministrationEvents',
            'pluginWebhookClaimRecovery',
            'pluginWebhookDeliveryAging',
            'pluginWebhookCredentialRetirement',
            'pluginWebhookDeliveryPurge',
            'accountEncryptionTransitionExpiry',
        ]);
    });

    it('returns an immutable registry', () => {
        const registry = createRetentionRuleRegistry();

        expect(Object.isFrozen(registry)).toBe(true);
    });

    it('owns the domains whose lifecycle remains active without operator retention', () => {
        expect(readRetentionDomainDefinitions()
            .filter((definition) => definition.runsWhenGlobalPolicyIsDisabled)
            .map((definition) => definition.id))
            .toEqual([
                'providerAccountUsageHistory',
                'publicShareAccessLogs',
                'authPairingSessions',
                'repeatKeys',
                'automationRuns',
            ]);
    });
});
