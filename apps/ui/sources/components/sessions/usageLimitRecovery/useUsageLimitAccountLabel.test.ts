import { describe, expect, it } from 'vitest';

import { formatUsageLimitAccountLabel, readUsageLimitAccountTarget } from './useUsageLimitAccountLabel';

describe('usage-limit account label', () => {
    it('names the limited account with the identity that tells same-named accounts apart', () => {
        expect(formatUsageLimitAccountLabel({ primaryLabel: 'Leeroy Brun', identityLabel: 'leeroy@batiplus.ch', accessibilityLabel: '' }))
            .toBe('Leeroy Brun · leeroy@batiplus.ch');
        expect(formatUsageLimitAccountLabel({ primaryLabel: 'Work', accessibilityLabel: '' })).toBe('Work');
        expect(formatUsageLimitAccountLabel({ primaryLabel: 'Unavailable', targetMissing: true, accessibilityLabel: '' })).toBeNull();
        expect(formatUsageLimitAccountLabel(undefined)).toBeNull();
    });

    it('reads the recorded account or pool from the limit, never another source', () => {
        const usageLimit = { v: 1 as const, resetAtMs: null, retryAfterMs: null, quotaScope: 'account' as const, recoverability: 'wait' as const,
            connectedService: { serviceId: 'happier.agent.codex/openai-codex', profileId: 'fc89', groupId: null } };
        expect(readUsageLimitAccountTarget({ usageLimit } as never)).toEqual({ key: 'limited', target: { kind: 'account',
            account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'fc89' } } });
        expect(readUsageLimitAccountTarget({ usageLimit: { ...usageLimit, connectedService: null } } as never)).toBeNull();
    });
});
