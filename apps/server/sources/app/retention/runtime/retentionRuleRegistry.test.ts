import { describe, expect, it } from 'vitest';

import {
    createRetentionRuleRegistry,
    readRetentionDomainDefinitions,
} from './retentionRuleRegistry';

describe('retention/createRetentionRuleRegistry', () => {
    it('registers one rule per supported v1 retention domain', () => {
        const registry = createRetentionRuleRegistry();

        expect(registry.map((rule) => rule.id)).toEqual([
            'sessions',
            'sessionSidechainMessages',
            'accountChanges',
            'usageEvents',
            'voiceSessionLeases',
            'userFeedItems',
            'sessionShareAccessLogs',
            'publicShareAccessLogs',
            'terminalAuthRequests',
            'accountAuthRequests',
            'authPairingSessions',
            'repeatKeys',
            'globalLocks',
            'automationRuns',
            'automationRunEvents',
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
                'repeatKeys',
                'automationRuns',
            ]);
    });
});
