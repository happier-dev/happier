import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { classifyPairingLink } from './classifyPairingLink';
import { buildHomeQrInviteDeepLink } from './pairingUrl';

const INVITE = {
    v: 2 as const,
    intent: 'home_device' as const,
    direction: 'trusted_home_displays' as const,
    pairId: 'pair-1',
    home: {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_b',
        canonicalServerUrl: 'https://home-b.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
    },
    qrSecretBase64Url: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
    issuedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
};

describe('classifyPairingLink', () => {
    it('routes Source setup links to review with their explicit Home and excludes them from pinned recovery', () => {
        const path = '/projects/setup?source=source%2Fa&target=srv_home_b';
        for (const link of [`https://app.example.test${path}`, `happier://${path.slice(1)}`, `happier-dev://${path.slice(1)}`]) {
            expect(classifyPairingLink(link)).toEqual({ kind: 'source_setup', path, sourceId: 'source/a', homeTarget: 'srv_home_b' });
            expect(classifyPairingLink(link, {
                expectedInvite: { homeServerIdentityId: 'srv_home_b', direction: 'trusted_home_displays' },
            })).toEqual({ kind: 'unknown' });
        }
        expect(classifyPairingLink('https://app.example.test/projects/setup?source=source-a')).toEqual({ kind: 'unknown' });
        expect(classifyPairingLink('https://app.example.test/projects/sources?source=source-a&target=srv_home_b')).toEqual({ kind: 'unknown' });
        expect(classifyPairingLink('https://app.example.test/projects/setup?source=source-a&source=source-b&target=srv_home_b')).toEqual({ kind: 'unknown' });
    });
    it('classifies each scanned or pasted link family through one owner', () => {
        const inviteLink = buildHomeQrInviteDeepLink({ invite: INVITE });
        expect(classifyPairingLink(`  ${inviteLink}  `)).toEqual({ kind: 'home_qr_invite', rawLink: inviteLink, invite: INVITE });
        expect(classifyPairingLink('happier:///pair?v=1&pairId=pid123&secret=sec_abc')).toEqual({ kind: 'legacy_pairing' });
        expect(classifyPairingLink('happier://account?pubkey123')).toEqual({ kind: 'account_connect', publicKeyB64Url: 'pubkey123' });
        expect(classifyPairingLink('happier://terminal?key=terminalkey')).toMatchObject({
            kind: 'terminal_connect',
            terminal: { publicKeyB64Url: 'terminalkey' },
        });
        expect(classifyPairingLink('https://relay.example.test')).toEqual({ kind: 'unknown' });
        expect(classifyPairingLink('')).toEqual({ kind: 'unknown' });
    });

    it('recognises a Team join link as the join destination it names, bearer and Home target intact', () => {
        const link = 'https://app.example.test/join/tj_abc123?target=hx1.carrier&targetBinding=bind-1';
        expect(classifyPairingLink(`  ${link}  `)).toEqual({
            kind: 'team_join',
            path: '/join/tj_abc123?target=hx1.carrier&targetBinding=bind-1',
        });
        // A join link that names no Home is not portable (it cannot be issued), so it is not one.
        expect(classifyPairingLink('https://app.example.test/join/tj_abc123')).toEqual({ kind: 'unknown' });
        expect(classifyPairingLink('https://app.example.test/joined/tj_abc123?target=hx1')).toEqual({ kind: 'unknown' });
        // A recovery pinned to one Home's invite admits no join link either.
        expect(classifyPairingLink(link, {
            expectedInvite: { homeServerIdentityId: 'srv_home_b', direction: 'trusted_home_displays' },
        })).toEqual({ kind: 'unknown' });
    });

    it('admits only the exact expected Home invite when a recovery pins one', () => {
        const inviteLink = buildHomeQrInviteDeepLink({ invite: INVITE });
        const expectedInvite = { homeServerIdentityId: 'srv_home_b', direction: 'trusted_home_displays' as const };
        expect(classifyPairingLink(inviteLink, { expectedInvite })).toMatchObject({ kind: 'home_qr_invite' });
        expect(classifyPairingLink(inviteLink, {
            expectedInvite: { homeServerIdentityId: 'srv_other', direction: 'trusted_home_displays' },
        })).toEqual({ kind: 'unknown' });
        // A pinned recovery accepts no other link family.
        expect(classifyPairingLink('happier://account?pubkey123', { expectedInvite })).toEqual({ kind: 'unknown' });
        expect(classifyPairingLink('happier:///pair?v=1&pairId=pid123&secret=sec_abc', { expectedInvite })).toEqual({ kind: 'unknown' });
    });
});
