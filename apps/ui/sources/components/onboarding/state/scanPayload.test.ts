import { describe, expect, it } from 'vitest';

import { parseOnboardingScanPayload } from './scanPayload';
import { buildHomeQrInviteDeepLink } from '@/auth/pairing/pairingUrl';
import { encodeBase64 } from '@/encryption/base64';

describe('parseOnboardingScanPayload', () => {
    it('preserves recognized Source setup and Team destinations instead of treating them as Home addresses', () => {
        const path = '/projects/setup?source=source-a&target=srv_home_b';
        expect(parseOnboardingScanPayload(`https://app.test${path}`)).toEqual({ kind: 'source_setup', path });
        expect(parseOnboardingScanPayload('https://app.test/join/token?target=srv_home_b')).toEqual({ kind: 'team_join', path: '/join/token?target=srv_home_b' });
    });
    it('preserves a strict V2 Home invite for the restore owner', () => {
        const rawLink = buildHomeQrInviteDeepLink({
            invite: {
                v: 2,
                intent: 'home_device',
                direction: 'trusted_home_displays',
                pairId: 'pair-v2',
                home: {
                    v: 1,
                    homeServerIdentityId: 'srv_home_b',
                    canonicalServerUrl: 'https://home-b.test',
                    revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
                },
                qrSecretBase64Url: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
                issuedAtMs: Date.now(),
                expiresAtMs: Date.now() + 60_000,
            },
        });

        expect(parseOnboardingScanPayload(rawLink)).toEqual({
            kind: 'home_qr_invite',
            rawLink,
        });
    });

    it('classifies the provenance-pinned released V1 invite without retaining its raw secret material', () => {
        expect(parseOnboardingScanPayload('happier:///pair?v=1&pairId=pair_1&secret=sec_1&server=https%3A%2F%2Frelay.example.com')).toEqual({
            kind: 'legacy_pairing_update_required',
        });
    });

    it('recognizes the released V1 shape without optional server metadata', () => {
        expect(parseOnboardingScanPayload('happier:///pair?v=1&pairId=pair_1&secret=sec_1')).toEqual({
            kind: 'legacy_pairing_update_required',
        });
    });

    it('keeps malformed and unknown pairing links distinct from released V1', () => {
        expect(parseOnboardingScanPayload('happier:///pair?v=1&secret=sec_1')).toEqual({ kind: 'unknown' });
        expect(parseOnboardingScanPayload('happier:///pair?v=9&pairId=pair_1&secret=sec_1')).toEqual({ kind: 'unknown' });
    });

    it('parses account connect links', () => {
        expect(parseOnboardingScanPayload('happier:///account?publicKeyB64Url')).toEqual({
            kind: 'account_connect',
            publicKeyB64Url: 'publicKeyB64Url',
        });
    });

    it('parses plain relay urls and rejects unsafe schemes', () => {
        expect(parseOnboardingScanPayload('https://relay.example.com/path/?foo=bar#frag')).toEqual({
            kind: 'relay_url',
            serverUrl: 'https://relay.example.com/path',
        });
        expect(parseOnboardingScanPayload('relay-example')).toEqual({ kind: 'unknown' });
        expect(parseOnboardingScanPayload('javascript:alert(1)')).toEqual({ kind: 'unknown' });
    });
});
