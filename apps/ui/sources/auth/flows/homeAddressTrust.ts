import type { KeyChallengeV2Audience } from '@happier-dev/protocol/auth/keyChallenge';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { Modal } from '@/modal';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

/**
 * A Home whose stable identity this device has already proven itself to, by
 * completing an authentication against it. Stored credentials for that identity
 * are that record: the pre-authentication feature probe learns an identity
 * through the very endpoint being judged, so its pin alone establishes nothing.
 */
async function hasCompletedAuthenticationWithHome(serverIdentityId: string): Promise<boolean> {
    const profile = getServerProfileById(serverIdentityId);
    if (!profile || profile.serverIdentityId !== serverIdentityId) return false;
    const credentials = await TokenStorage.getCredentialsForServerUrl(
        profile.canonicalServerUrl ?? profile.serverUrl,
        { serverId: serverIdentityId },
    );
    return credentials !== null;
}

/**
 * Decides whether a v2 challenge may be signed when the Home names an address
 * other than the one this device selected.
 *
 * An established Home is identity-bound: it legitimately answers on several
 * addresses (LAN, Tailscale, tunnels, port forwards, dev targets), and this
 * device already holds a credential proving which Home that identity is.
 *
 * First contact is address-bound instead against an anchor the contacted
 * endpoint could not have supplied in band — the selected address, or a
 * canonical URL that arrived with a scanned or pasted descriptor. The identity
 * itself is learned through that endpoint: one that proxies the real Home's
 * feature probe and challenge would otherwise collect a signed proof and redeem
 * it there. The address the person selected is the one fact that endpoint
 * cannot choose, so the only way past it is an explicit decision that names
 * both addresses. Refusing outright would instead lock out every Home reached
 * on a second address before its first sign-in.
 */
export async function confirmAlternateIssuedHomeAddress(params: Readonly<{
    /** The address the Home named in its challenge. */
    issued: Readonly<{ origin: string }>;
    /** The address this device selected, plus the identity it expects. */
    expected: Required<KeyChallengeV2Audience>;
}>): Promise<boolean> {
    if (await hasCompletedAuthenticationWithHome(params.expected.serverIdentityId)) return true;
    return await Modal.confirm(
        t('errors.homeAddressMismatchTitle'),
        t('errors.homeAddressMismatchBody', {
            claimed: params.issued.origin,
            reached: params.expected.origin,
        }),
        { confirmText: t('common.continue'), cancelText: t('common.cancel') },
    );
}
