import { describe, expect, it } from 'vitest';

import { homeGovernanceProjectionFixture, homeReachabilityFixture } from '@/dev/testkit';

import { reachCanRetireIroh, reachWrappableHost, resolveReachExposure } from './homeReachPresentation';

function projectionAdmittingStrangers(admits: boolean) {
    return homeGovernanceProjectionFixture({
        authenticationOptions: {
            methods: [{
                id: 'key_challenge',
                actions: [
                    { id: 'login', enabled: true, mode: 'keyed' },
                    { id: 'provision', enabled: admits, mode: 'keyed' },
                ],
            }],
            permittedAccountModes: ['e2ee'],
            recommendedProvisioningMode: 'e2ee',
            signInService: { deploymentMode: null, canDisable: false },
        },
    });
}

describe('Reach exposure warning (plan §3.2)', () => {
    it('always warns for a method that reaches the internet, and says whether strangers can sign up', () => {
        const funnel = homeReachabilityFixture({
            hostAccess: { method: 'tailscale_funnel', exposure: 'public', shareUrl: 'https://home.ts.net' },
        });
        expect(resolveReachExposure(funnel, projectionAdmittingStrangers(false)))
            .toEqual({ kind: 'internet', method: 'tailscale_funnel', strangersCanSignUp: false });
        expect(resolveReachExposure(funnel, projectionAdmittingStrangers(true)))
            .toEqual({ kind: 'internet', method: 'tailscale_funnel', strangersCanSignUp: true });
    });

    it('warns about a private address only while anyone who reaches it can create an account', () => {
        const serve = homeReachabilityFixture();
        expect(resolveReachExposure(serve, projectionAdmittingStrangers(false))).toEqual({ kind: 'none' });
        expect(resolveReachExposure(serve, projectionAdmittingStrangers(true)))
            .toEqual({ kind: 'open_address', strangersCanSignUp: true });
        expect(resolveReachExposure(
            homeReachabilityFixture({ publicAddress: { url: null, source: 'none' }, hostAccess: null }),
            projectionAdmittingStrangers(true),
        )).toEqual({ kind: 'none' });
    });

    it('offers turning direct connections off only while devices keep an HTTPS address', () => {
        expect(reachCanRetireIroh(homeReachabilityFixture())).toBe(true);
        expect(reachCanRetireIroh(homeReachabilityFixture({ publicAddress: { url: 'http://home.example', source: 'home' } }))).toBe(false);
        expect(reachCanRetireIroh(homeReachabilityFixture({ publicAddress: { url: null, source: 'none' } }))).toBe(false);
    });
});

describe('reachWrappableHost (Reach diagram on a phone)', () => {
    it('lets a long host wrap at its dots and before its port, without changing the text people read', () => {
        const wrapped = reachWrappableHost('leeroy-mbp.tailfce179.ts.net:8443');
        expect(wrapped.replace(/\u200B/g, '')).toBe('leeroy-mbp.tailfce179.ts.net:8443');
        expect(wrapped).toBe('leeroy-mbp.\u200Btailfce179.\u200Bts.\u200Bnet\u200B:8443');
        expect(reachWrappableHost('localhost')).toBe('localhost');
    });
});
