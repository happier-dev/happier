import { isFriend, type UserProfile } from './friendTypes';

export type SessionShareRecipientEligibility =
    | Readonly<{ eligible: true }>
    | Readonly<{
        eligible: false;
        reason: 'relationship-pending' | 'relationship-requested' | 'relationship-unavailable' | 'missing-content-keys';
    }>;

export function resolveSessionShareRecipientEligibility(
    profile: UserProfile,
): SessionShareRecipientEligibility {
    if (!isFriend(profile.status)) {
        if (profile.status === 'pending') {
            return { eligible: false, reason: 'relationship-pending' };
        }
        if (profile.status === 'requested') {
            return { eligible: false, reason: 'relationship-requested' };
        }
        return { eligible: false, reason: 'relationship-unavailable' };
    }
    if (!profile.publicKey || !profile.contentPublicKey || !profile.contentPublicKeySig) {
        return { eligible: false, reason: 'missing-content-keys' };
    }
    return { eligible: true };
}
