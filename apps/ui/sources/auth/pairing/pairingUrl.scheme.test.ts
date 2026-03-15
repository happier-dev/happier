import { describe, expect, it, vi } from 'vitest';

describe('pairingUrl scheme override', () => {
    it('builds and parses pairing deep links using the configured app scheme', async () => {
        vi.resetModules();
        vi.doMock('expo-constants', () => ({
            default: {
                expoConfig: {
                    scheme: 'happier-dev',
                },
            },
        }));

        const { buildPairingDeepLink, parsePairingDeepLink } = await import('./pairingUrl');

        expect(
            buildPairingDeepLink({
                pairId: 'pid123',
                secret: 'sec_abc',
                serverUrl: 'https://stack.example.test/path?x=1',
            }),
        ).toBe(
            'happier-dev:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test%2Fpath%3Fx%3D1',
        );

        expect(
            parsePairingDeepLink('happier-dev:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test'),
        ).toEqual({
            pairId: 'pid123',
            secret: 'sec_abc',
            serverUrl: 'https://stack.example.test',
        });

        // Fail closed: production-scheme links should not parse in dev-scheme builds.
        expect(parsePairingDeepLink('happier:///pair?v=1&pairId=pid123&secret=sec_abc')).toBeNull();
    });
});
