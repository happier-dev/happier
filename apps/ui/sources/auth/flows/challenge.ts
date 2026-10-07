import { getRandomBytes } from '@/platform/cryptoRandom';
import sodium from '@/encryption/libsodium.lib';
import {
    createHomeAddressMismatchFailure,
    createHomeIdentityMismatchFailure,
} from './authenticationFailure';
import {
    createKeyChallengeV2SigningInput,
    createExpectedAccountKeyChallengeSigningInputV1,
    type KeyChallengeV2Audience,
    type KeyChallengeV2IssueResponse,
} from '@happier-dev/protocol/auth/keyChallenge';

export function deriveAccountSigningPublicKey(
    secret: Uint8Array,
): Uint8Array {
    return sodium.crypto_sign_seed_keypair(secret).publicKey;
}

export function signAccountPayload(
    secret: Uint8Array,
    payload: Uint8Array,
): Uint8Array {
    const keypair = sodium.crypto_sign_seed_keypair(secret);
    return sodium.crypto_sign_detached(payload, keypair.privateKey);
}

export function authChallenge(
    secret: Uint8Array,
    options?: Readonly<{
        expectedAccountId: string;
    }>,
) {
    const challenge = getRandomBytes(32);
    const signingInput =
        options
            ? createExpectedAccountKeyChallengeSigningInputV1({
                challenge,
                expectedAccountId:
                    options.expectedAccountId,
            })
            : challenge;
    return {
        challenge,
        signature: signAccountPayload(secret, signingInput),
        publicKey: deriveAccountSigningPublicKey(secret),
    };
}

export function authChallengeV2(
    secret: Uint8Array,
    params: Readonly<{
        challenge: KeyChallengeV2IssueResponse;
        expectedAudience: Required<KeyChallengeV2Audience>;
        expectedAccountId?: string;
        requireExistingAccount?: true;
        /**
         * The caller established that this Home may answer on an address other
         * than the selected one: it already holds credentials for this identity,
         * or the person confirmed the exact pair of addresses. Absent that, first
         * contact stays bound to the selected address, which is the only fact the
         * endpoint issuing this challenge cannot choose for itself.
         */
        acceptAlternateOrigin?: true;
    }>,
) {
    // A challenge from another Home is never signable: that is a relayed proof.
    if (params.challenge.audience.serverIdentityId !== params.expectedAudience.serverIdentityId) {
        throw createHomeIdentityMismatchFailure();
    }
    if (
        params.acceptAlternateOrigin !== true
        && params.challenge.audience.origin !== params.expectedAudience.origin
    ) {
        throw createHomeAddressMismatchFailure();
    }
    const signingInput = createKeyChallengeV2SigningInput({
        ...params.challenge,
        ...(params.expectedAccountId
            ? { expectedAccountId: params.expectedAccountId }
            : {}),
        ...(params.requireExistingAccount
            ? { requireExistingAccount: true }
            : {}),
    });
    return {
        signature: signAccountPayload(secret, signingInput),
        publicKey: deriveAccountSigningPublicKey(secret),
    };
}
