import { describe, expect, it } from 'vitest';

import { buildPairingDeepLink, parsePairingDeepLink } from './pairingUrl';

describe('parsePairingDeepLink', () => {
    it('parses canonical pairing deep links', () => {
        expect(
            parsePairingDeepLink(
                'happier:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test',
            ),
        ).toEqual({
            pairId: 'pid123',
            secret: 'sec_abc',
            serverUrl: 'https://stack.example.test',
        });
    });

    it('rejects non-pair links', () => {
        expect(parsePairingDeepLink('happier:///account?abc')).toBeNull();
    });

    it('rejects missing required params', () => {
        expect(parsePairingDeepLink('happier:///pair?v=1&pairId=pid123')).toBeNull();
    });

    it('ignores unsafe server URL schemes', () => {
        expect(
            parsePairingDeepLink('happier:///pair?v=1&pairId=pid123&secret=sec_abc&server=javascript%3Aalert(1)'),
        ).toEqual({
            pairId: 'pid123',
            secret: 'sec_abc',
            serverUrl: null,
        });
    });
});

describe('buildPairingDeepLink', () => {
    it('builds canonical deep links with encoded values', () => {
        expect(
            buildPairingDeepLink({
                pairId: 'pid123',
                secret: 'sec_abc',
                serverUrl: 'https://stack.example.test/path?x=1',
            }),
        ).toBe(
            'happier:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test%2Fpath%3Fx%3D1',
        );
    });
});
