import { describe, expect, it } from 'vitest';

import { resolveReversePairingHome } from './resolveReversePairingHome';

describe('requester QR Home admission', () => {
    const origin = 'https://home.example.test';
    const identity = 'srv_requester_home';
    const descriptor = {
        v: 1 as const,
        homeServerIdentityId: identity,
        canonicalServerUrl: origin,
        revision: 2,
        endpoints: [{ kind: 'https' as const, url: origin }],
    };
    const profile = {
        id: 'first-open', name: 'First Open', serverUrl: origin,
        source: 'stack-env' as const, createdAt: 1, updatedAt: 1, lastUsedAt: 0,
    };

    it('admits an identity-bound public descriptor for the exact fresh Home without adopting it', () => {
        expect(resolveReversePairingHome(profile, {
            serverIdentityId: identity, descriptor,
        })).toEqual({ descriptor, requiresAuthenticatedObservation: true });
    });

    it('refuses a different origin or a conflicting pinned identity', () => {
        const discovery = { serverIdentityId: identity, descriptor };
        expect(resolveReversePairingHome({ ...profile, serverUrl: 'https://other.example.test' }, discovery)).toBeNull();
        expect(resolveReversePairingHome({ ...profile, serverIdentityId: 'srv_other_home' }, discovery)).toBeNull();
    });
});
