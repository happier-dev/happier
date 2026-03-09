import { describe, expect, it } from 'vitest';

import { createRetentionRuleRegistry } from './retentionRuleRegistry';

describe('retention/createRetentionRuleRegistry', () => {
    it('registers one rule per supported v1 retention domain', () => {
        const registry = createRetentionRuleRegistry();

        expect(registry.map((rule) => rule.id)).toEqual([
            'sessions',
            'accountChanges',
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
});
