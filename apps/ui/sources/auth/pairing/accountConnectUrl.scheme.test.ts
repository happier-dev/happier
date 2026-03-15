import { describe, expect, it, vi } from 'vitest';

describe('accountConnectUrl scheme override', () => {
    it('builds and parses account deep links using the configured app scheme', async () => {
        vi.resetModules();
        vi.doMock('expo-constants', () => ({
            default: {
                expoConfig: {
                    scheme: 'happier-dev',
                },
            },
        }));

        const { buildAccountConnectDeepLink, parseAccountConnectDeepLink } = await import('./accountConnectUrl');

        expect(buildAccountConnectDeepLink({ publicKeyB64Url: 'abc123' })).toBe('happier-dev:///account?abc123');
        expect(parseAccountConnectDeepLink('happier-dev:///account?abc123')).toEqual({ publicKeyB64Url: 'abc123' });

        // Fail closed: production-scheme links should not parse in dev-scheme builds.
        expect(parseAccountConnectDeepLink('happier:///account?abc123')).toBeNull();
    });
});
