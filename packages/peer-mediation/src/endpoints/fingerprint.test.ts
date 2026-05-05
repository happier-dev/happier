import { describe, expect, it, vi } from 'vitest';

import type { TransferEndpointCandidate } from '@happier-dev/protocol';

import { fingerprintPeerEndpoints } from './fingerprint';

describe('fingerprintPeerEndpoints', () => {
    it('returns the same fingerprint regardless of endpoint ordering', () => {
        const endpointsA = [
            {
                kind: 'http' as const,
                url: 'http://127.0.0.1:46001/machine-transfers/direct/a',
                authorizationToken: 'token-1',
                expiresAt: 10_000,
            },
            {
                kind: 'https' as const,
                url: 'https://example.test/machine-transfers/direct/a',
                authorizationToken: 'token-2',
                expiresAt: 20_000,
            },
        ];
        const endpointsB = [...endpointsA].reverse();

        expect(fingerprintPeerEndpoints(endpointsA)).toEqual(
            fingerprintPeerEndpoints(endpointsB),
        );
    });

    it('ignores malformed endpoint candidates and returns null when none are valid', () => {
        const malformedEndpoint = { kind: 'http', expiresAt: 10_000 } as unknown as TransferEndpointCandidate;

        expect(fingerprintPeerEndpoints([
            malformedEndpoint,
        ])).toBeNull();
    });

    it('ignores userinfo, query strings, and hashes when fingerprinting endpoints if the auth token is unchanged', () => {
        expect(
            fingerprintPeerEndpoints([
                {
                    kind: 'https',
                    url: 'https://user:pass@example.test/machine-transfers/direct/a?token=abc&foo=bar#frag',
                    authorizationToken: 'token-a',
                    expiresAt: 10_000,
                },
            ]),
        ).toEqual(
            fingerprintPeerEndpoints([
                {
                    kind: 'https',
                    url: 'https://example.test/machine-transfers/direct/a',
                    authorizationToken: 'token-a',
                    expiresAt: 10_000,
                },
            ]),
        );
    });

    it('does not retain raw bearer tokens as cache keys', () => {
        const setSpy = vi.spyOn(Map.prototype, 'set');
        const token = 'bearer-secret-token';

        try {
            fingerprintPeerEndpoints([
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/a',
                    authorizationToken: token,
                    expiresAt: 10_000,
                },
            ]);

            const recordedKeys = setSpy.mock.calls.map(([key]) => key);
            expect(recordedKeys).not.toContain(token);
        } finally {
            setSpy.mockRestore();
        }
    });
});
