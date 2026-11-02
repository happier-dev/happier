import { describe, expect, it } from 'vitest';

import { redirectSystemPath } from '@/app/+native-intent';
import { buildHomeQrInviteDeepLink, consumeHomeQrInviteRestoreHandoff } from '@/auth/pairing/pairingUrl';
import { encodeBase64 } from '@/encryption/base64';

describe('native system URL routing', () => {
    it.each([true, false])('opens Home for a development-client launch with initial=%s', (initial) => {
        const path = 'happier-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8098';

        expect(redirectSystemPath({ path, initial })).toBe('/');
    });

    it.each([true, false])(
        'replaces a provenance-pinned released V1 invite with a secret-free update-required route for initial=%s',
        (initial) => {
        // Exact golden output asserted by cli-v0.2.1's pairingUrl.scheme.test.ts at
        // b1d15a8a9c241737d1ca9b167459901e6259173a. Keep this literal independent of current writers.
        const releasedV1Link =
            'happier-dev:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test%2Fpath%3Fx%3D1';

            const route = redirectSystemPath({ path: releasedV1Link, initial });

            expect(route).toBe('/restore?legacyPairingUpdateRequired=1');
            expect(route).not.toContain('pid123');
            expect(route).not.toContain('sec_abc');
            expect(route).not.toContain('stack.example.test');
        },
    );

    it.each([true, false])('normalizes account-connect URLs for initial=%s', (initial) => {
        expect(redirectSystemPath({ path: 'happier:///account?abc+123/=', initial })).toBe(
            '/account?accountConnectKey=abc%2B123%2F%3D',
        );
    });

    it('leaves unrelated system paths unchanged', () => {
        expect(redirectSystemPath({ path: 'happier:///terminal?key=abc123', initial: true })).toBe(
            'happier:///terminal?key=abc123',
        );
    });

    it('leaves malformed legacy-looking pairing paths distinct and unchanged', () => {
        const malformed = 'happier-dev:///pair?v=1&pairId=pid123&server=https%3A%2F%2Fstack.example.test';

        expect(redirectSystemPath({ path: malformed, initial: true })).toBe(malformed);
    });

    it('routes a strict V2 Home invite to the restore owner with the OS-invite enter_home intent', () => {
        const path = buildHomeQrInviteDeepLink({
            invite: {
                v: 2,
                intent: 'home_device',
                direction: 'trusted_home_displays',
                pairId: 'pair-native',
                home: {
                    v: 1,
                    homeServerIdentityId: 'srv_home_b',
                    canonicalServerUrl: 'https://home-b.test',
                    revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
                },
                qrSecretBase64Url: encodeBase64(new Uint8Array(32).fill(8), 'base64url'),
                issuedAtMs: Date.now(),
                expiresAtMs: Date.now() + 60_000,
            },
        });

        const route = redirectSystemPath({ path, initial: true });
        expect(route).toMatch(/^\/restore\?pairingHandoff=[A-Za-z0-9_-]+&entryIntent=enter_home$/u);
        expect(route).not.toContain(encodeURIComponent(path));
        const handle = new URL(route, 'https://app.example.test').searchParams.get('pairingHandoff');
        expect(consumeHomeQrInviteRestoreHandoff(handle!)).toBe(path);
    });
});
