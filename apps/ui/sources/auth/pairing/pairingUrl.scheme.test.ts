import { describe, expect, it, vi } from 'vitest';

describe('pairingUrl scheme override', () => {
    it('builds with the configured scheme and parses first-party Happier schemes', async () => {
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

        expect(parsePairingDeepLink('happier:///pair?v=1&pairId=pid123&secret=sec_abc')).toEqual({
            pairId: 'pid123',
            secret: 'sec_abc',
            serverUrl: null,
        });

        expect(parsePairingDeepLink('happier-internaldev:///pair?v=1&pairId=pid123&secret=sec_abc')).toEqual({
            pairId: 'pid123',
            secret: 'sec_abc',
            serverUrl: null,
        });

        expect(parsePairingDeepLink('happier-custom:///pair?v=1&pairId=pid123&secret=sec_abc')).toEqual({
            pairId: 'pid123',
            secret: 'sec_abc',
            serverUrl: null,
        });

        expect(parsePairingDeepLink('otherapp:///pair?v=1&pairId=pid123&secret=sec_abc')).toBeNull();
    });

    it('still parses the locally configured custom scheme exactly', async () => {
        vi.resetModules();
        vi.doMock('expo-constants', () => ({
            default: {
                expoConfig: {
                    scheme: 'my-team-app',
                },
            },
        }));

        const { buildPairingDeepLink, parsePairingDeepLink } = await import('./pairingUrl');

        expect(buildPairingDeepLink({ pairId: 'pid123', secret: 'sec_abc' })).toBe('my-team-app:///pair?v=1&pairId=pid123&secret=sec_abc');
        expect(parsePairingDeepLink('my-team-app:///pair?v=1&pairId=pid123&secret=sec_abc')).toEqual({
            pairId: 'pid123',
            secret: 'sec_abc',
            serverUrl: null,
        });
    });
});
