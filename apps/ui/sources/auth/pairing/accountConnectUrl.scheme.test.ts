import { describe, expect, it, vi } from 'vitest';

describe('accountConnectUrl scheme override', () => {
    it('builds with the configured scheme and parses first-party Happier schemes', async () => {
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
        expect(parseAccountConnectDeepLink('happier:///account?abc123')).toEqual({ publicKeyB64Url: 'abc123' });
        expect(parseAccountConnectDeepLink('happier-internaldev:///account?abc123')).toEqual({ publicKeyB64Url: 'abc123' });
        expect(parseAccountConnectDeepLink('happier-custom:///account?abc123')).toEqual({ publicKeyB64Url: 'abc123' });
        expect(parseAccountConnectDeepLink('otherapp:///account?abc123')).toBeNull();
    });
});
