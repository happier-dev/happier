import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageScopeKey } from './providerAccountUsageLoadRoute';

describe('providerAccountUsageLoadRoute', () => {
    it('separates identical credentials across active servers', () => {
        expect(buildProviderAccountUsageScopeKey({
            serverId: 'server-a',
            generation: 1,
            credentialScope: 'same-credentials',
        })).not.toBe(buildProviderAccountUsageScopeKey({
            serverId: 'server-b',
            generation: 1,
            credentialScope: 'same-credentials',
        }));
    });

    it('separates cache scope across generations of the same active server', () => {
        expect(buildProviderAccountUsageScopeKey({
            serverId: 'server-a',
            generation: 1,
            credentialScope: 'same-credentials',
        })).not.toBe(buildProviderAccountUsageScopeKey({
            serverId: 'server-a',
            generation: 2,
            credentialScope: 'same-credentials',
        }));
    });
});
