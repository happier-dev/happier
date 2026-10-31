import { describe, expect, it } from 'vitest';

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

    it('distinguishes explicit authorization from a legacy URL-only candidate', () => {
        expect(fingerprintPeerEndpoints([{
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/a',
            authorizationToken: 'token-a',
            expiresAt: 10_000,
        }])).not.toEqual(fingerprintPeerEndpoints([{
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/a?token=legacy-token',
            expiresAt: 10_000,
        }]));
    });

    it('does not retain bearer tokens or URL auth material in fingerprints', () => {
        const token = 'bearer-secret-token';
        const fingerprint = fingerprintPeerEndpoints([{
            kind: 'https',
            url: 'https://url-user-secret:url-pass-secret@example.test/a?token=url-query-secret#url-fragment-secret',
            authorizationToken: token,
            expiresAt: 10_000,
        }]);
        expect(fingerprint).not.toBeNull();
        for (const secret of [token, 'url-user-secret', 'url-pass-secret', 'url-query-secret', 'url-fragment-secret']) {
            expect(fingerprint).not.toContain(secret);
        }
    });
});
