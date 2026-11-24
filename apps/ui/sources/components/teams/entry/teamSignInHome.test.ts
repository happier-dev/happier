import { beforeEach, describe, expect, it } from 'vitest';
import { listServerProfiles, removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { resolveTeamSignInDestination, resolveTeamSignInHome, teamSignInReturnPath } from './teamSignInHome';

function descriptorCarrier(homeServerIdentityId: string): string {
    return JSON.stringify({
        kind: 'descriptor',
        authority: 'trusted_enrollment',
        descriptor: {
            v: 1,
            homeServerIdentityId,
            canonicalServerUrl: 'https://acme.example',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://acme.example' }],
        },
    });
}

describe('resolveTeamSignInHome', () => {
    beforeEach(async () => {
        for (const profile of listServerProfiles()) await removeServerProfile(profile.id);
    });

    it('carries the Homes acquisition states for a descriptor carrier instead of downgrading them', () => {
        const carrier = descriptorCarrier('srv_acme');

        // The descriptor names a Home this device has not adopted, which is the
        // ordinary first-device case. The acquisition owner observes and adopts
        // it in place, exactly as the join screen does, so Team sign-in must
        // render that lifecycle rather than dropping the descriptor and sending
        // the person to a manual Add Home flow that never sees it.
        expect(resolveTeamSignInHome({ carrier, linkTarget: { kind: 'acquiring' } }))
            .toEqual({ kind: 'acquiring' });

        const retry = () => {};
        expect(resolveTeamSignInHome({
            carrier,
            linkTarget: { kind: 'acquisition_failed', canonicalServerUrl: 'https://unreachable-home.test', reason: 'unreachable', retry },
        })).toEqual({ kind: 'acquisition_failed', canonicalServerUrl: 'https://unreachable-home.test', reason: 'unreachable', retry });
    });

    it('prefers the adopted profile when the carrier names a Home this device already has', () => {
        const carrier = descriptorCarrier('srv_acme');

        const home = resolveTeamSignInHome({
            carrier,
            linkTarget: {
                kind: 'resolved',
                serverId: 'profile-acme',
                target: { kind: 'saved_profile', profileRef: 'profile-acme' },
            },
        });

        expect(home).toEqual({
            kind: 'resolved',
            target: { kind: 'saved_profile', profileRef: 'profile-acme' },
            savedProfileId: 'profile-acme',
        });
    });

    it('keeps an identity-only carrier on the manual Add Home remedy', () => {
        expect(resolveTeamSignInHome({
            carrier: 'srv_legacy',
            linkTarget: { kind: 'unknown_home', homeServerIdentityId: 'srv_legacy' },
        })).toEqual({ kind: 'unknown_home', homeServerIdentityId: 'srv_legacy' });
    });

    it('still accepts the device-local reference used by in-app navigation and OAuth return', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'https://acme.example', name: 'Acme' });

        const home = resolveTeamSignInHome({ serverId: profile.id });

        expect(home).toEqual({
            kind: 'resolved',
            target: { kind: 'saved_profile', profileRef: profile.id },
            savedProfileId: profile.id,
        });
    });

    it('reports an unadopted Home separately from a link it cannot route at all', () => {
        expect(resolveTeamSignInHome({ serverId: 'profile-unknown' }))
            .toEqual({ kind: 'unknown_home', homeServerIdentityId: 'profile-unknown' });
        expect(resolveTeamSignInHome({}).kind).toBe('unresolved');
        expect(resolveTeamSignInHome({ carrier: '   ', serverId: '' }).kind).toBe('unresolved');
    });
});

describe('teamSignInReturnPath', () => {
    it('returns to the Home the link named rather than to a rewritten device-local id', () => {
        const carrier = descriptorCarrier('srv_acme');

        const path = teamSignInReturnPath({ teamId: 'team-1', carrier });

        expect(path.startsWith('/teams/team-1/sign-in?')).toBe(true);
        expect(new URLSearchParams(path.split('?')[1]).get('target')).toBe(carrier);
    });

    it('marks a server-held invitation continuation without putting its authority in the URL', () => {
        expect(teamSignInReturnPath({
            teamId: 'team-1',
            carrier: 'home-1',
            postAuthInvitation: true,
        })).toBe('/teams/team-1/sign-in?target=home-1&postAuthInvitation=1');
    });

    it('keeps a bare in-app return addressed to the same saved Home', () => {
        expect(teamSignInReturnPath({ teamId: 'team-1', serverId: 'profile-acme' }))
            .toBe('/teams/team-1/sign-in?serverId=profile-acme');
    });

    it('carries the in-app page that asked for the sign-in, and nothing else', () => {
        const origin = '/session/s-1?right=people';
        const path = teamSignInReturnPath({ teamId: 'team-1', serverId: 'profile-acme', returnTo: origin });
        expect(new URLSearchParams(path.split('?')[1]).get('returnTo')).toBe(origin);
        for (const hostile of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'evil.example']) {
            expect(new URLSearchParams(teamSignInReturnPath({ teamId: 'team-1', serverId: 'profile-acme', returnTo: hostile })
                .split('?')[1]).has('returnTo')).toBe(false);
        }
    });
});

describe('resolveTeamSignInDestination', () => {
    it('returns to the in-app page that asked for the sign-in', () => {
        expect(resolveTeamSignInDestination({ teamId: 'team-1', serverId: 'profile-acme', returnTo: '/session/s-1?right=people' }))
            .toBe('/session/s-1?right=people');
        expect(resolveTeamSignInDestination({ teamId: 'team-1', serverId: 'profile-acme', returnTo: '/' })).toBe('/');
    });

    it('refuses an external or cross-origin return and falls back to the Team page', () => {
        for (const hostile of ['https://evil.example/x', '//evil.example/x', '/%2F%2Fevil.example', '/\\evil.example',
            'javascript:alert(1)', 'evil.example', '/x\u0000y']) {
            expect(resolveTeamSignInDestination({ teamId: 'team-1', serverId: 'profile-acme', returnTo: hostile }))
                .toBe('/teams/team-1/sessions?serverId=profile-acme');
        }
        expect(resolveTeamSignInDestination({ teamId: 'team-1', serverId: 'profile-acme', returnTo: null }))
            .toBe('/teams/team-1/sessions?serverId=profile-acme');
    });
});
