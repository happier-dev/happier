import { describe, expect, it } from 'vitest';

import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';

import { resolveHomeAuthenticationTarget } from './resolveHomeAuthenticationTarget';

describe('resolveHomeAuthenticationTarget', () => {
    it('preserves descriptor identity and separates request endpoint from canonical audience', () => {
        expect(resolveHomeAuthenticationTarget({
            kind: 'descriptor',
            authority: 'account_directory',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'home-b',
                canonicalServerUrl: 'https://home-b.example.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://edge-b.example.test' }],
            },
        })).toEqual({
            endpointUrl: 'https://edge-b.example.test',
            canonicalServerUrl: 'https://home-b.example.test',
            // A scanned or pasted descriptor vouches for its own canonical URL, so
            // first contact may be judged against it rather than the edge endpoint.
            addressAnchorUrl: 'https://home-b.example.test',
            serverId: 'home-b',
            serverIdentityId: 'home-b',
        });
    });

    it('uses the saved Home’s selected public address for authentication', async () => {
        const serverIdentityId = 'srv_auth_address';
        const canonicalServerUrl = 'http://auth-home.localhost:3033';
        const enteredUrl = 'https://auth-home.example.test';
        const profile = await adoptHomeProfile({
            descriptor: { serverUrl: canonicalServerUrl, canonicalServerUrl, homeServerIdentityId: serverIdentityId },
            source: 'url',
            addressSelection: { serverIdentityId, enteredUrl, canonicalServerUrl, useCanonical: false },
        });

        expect(resolveHomeAuthenticationTarget({ kind: 'saved_profile', profileRef: profile.id })).toMatchObject({
            endpointUrl: enteredUrl,
            canonicalServerUrl,
            serverIdentityId,
        });
    });

    it('rejects URL-only targets that lack stable Home identity', () => {
        expect(resolveHomeAuthenticationTarget({ kind: 'https_url', url: 'https://unknown.example.test' })).toBeNull();
    });

});
