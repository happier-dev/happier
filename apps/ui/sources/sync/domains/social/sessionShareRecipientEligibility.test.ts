import { describe, expect, it } from 'vitest';

import type { UserProfile } from './friendTypes';
import { resolveSessionShareRecipientEligibility } from './sessionShareRecipientEligibility';

function profile(overrides: Partial<UserProfile>): UserProfile {
    return {
        id: 'user-1',
        username: 'friend',
        firstName: '',
        lastName: null,
        avatar: null,
        bio: null,
        publicKey: 'signing-key',
        contentPublicKey: 'content-key',
        contentPublicKeySig: 'content-signature',
        badges: [],
        status: 'friend',
        ...overrides,
    };
}

describe('resolveSessionShareRecipientEligibility', () => {
    it('allows only accepted friends with registered content encryption keys', () => {
        expect(resolveSessionShareRecipientEligibility(profile({}))).toEqual({ eligible: true });
        expect(resolveSessionShareRecipientEligibility(profile({ status: 'pending' }))).toEqual({
            eligible: false,
            reason: 'relationship-pending',
        });
        expect(resolveSessionShareRecipientEligibility(profile({ status: 'requested' }))).toEqual({
            eligible: false,
            reason: 'relationship-requested',
        });
        expect(resolveSessionShareRecipientEligibility(profile({ contentPublicKeySig: null }))).toEqual({
            eligible: false,
            reason: 'missing-content-keys',
        });
    });
});
