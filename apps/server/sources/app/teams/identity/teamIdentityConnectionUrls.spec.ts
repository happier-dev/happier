import { describe, expect, it } from 'vitest';

import { resolveTeamIdentityConnectionReturnUrl } from './teamIdentityConnectionUrls';

describe('Team identity connection return URL', () => {
    it('returns Home Test and Portal flows to the exact Home connection detail', () => {
        const result = resolveTeamIdentityConnectionReturnUrl({
            env: { HAPPIER_WEBAPP_URL: 'https://app.example.test/base?discard=true#discard' },
            homeServerIdentityId: 'home/exact', teamId: null, connectionId: 'connection/exact',
            purpose: 'workos_admin_portal',
        });
        const url = new URL(result!);
        expect(url.pathname).toBe('/base/settings/home/home%2Fexact/sign-in-providers/connections/connection%2Fexact');
        expect([...url.searchParams]).toEqual([['purpose', 'workos_admin_portal']]);
        expect(url.hash).toBe('');
        const ordinary = new URL(resolveTeamIdentityConnectionReturnUrl({
            env: { HAPPIER_WEBAPP_URL: 'https://app.example.test/base' },
            homeServerIdentityId: 'home/exact', teamId: null, connectionId: 'connection/exact',
        })!);
        expect(ordinary.pathname).toBe(url.pathname);
        expect(ordinary.search).toBe('');
    });
    it('binds nonsecret Portal intent to the exact Home, Team and connection without changing ordinary return routes', () => {
        const input = {
            env: { HAPPIER_WEBAPP_URL: 'https://app.example.test/base?discard=true#discard' },
            homeServerIdentityId: 'home/exact', teamId: 'team/exact', connectionId: 'connection/exact',
        };
        const ordinary = new URL(resolveTeamIdentityConnectionReturnUrl(input)!);
        expect(ordinary.pathname).toBe('/base/settings/teams/home%2Fexact/team%2Fexact/authentication/connection%2Fexact');
        expect(ordinary.search).toBe('');
        expect(ordinary.hash).toBe('');
        const portal = new URL(resolveTeamIdentityConnectionReturnUrl({ ...input, purpose: 'workos_admin_portal' })!);
        expect(portal.pathname).toBe(ordinary.pathname);
        expect([...portal.searchParams]).toEqual([['purpose', 'workos_admin_portal']]);
    });
});
