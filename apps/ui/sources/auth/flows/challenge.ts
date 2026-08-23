import { getRandomBytes } from '@/platform/cryptoRandom';
import sodium from '@/encryption/libsodium.lib';
import {
    createKeyChallengeV2SigningInput,
    createExpectedAccountKeyChallengeSigningInputV1,
    type KeyChallengeV2Audience,
    type KeyChallengeV2IssueResponse,
} from '@happier-dev/protocol';

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
    }>,
) {
    if (
        params.challenge.audience.origin !== params.expectedAudience.origin
        || params.challenge.audience.serverIdentityId !== params.expectedAudience.serverIdentityId
    ) {
        throw new Error('Authentication failed: key-challenge v2 audience mismatch.');
    }
    const signingInput = createKeyChallengeV2SigningInput({
        ...params.challenge,
        ...(params.expectedAccountId
            ? { expectedAccountId: params.expectedAccountId }
            : {}),
    });
    return {
        signature: signAccountPayload(secret, signingInput),
        publicKey: deriveAccountSigningPublicKey(secret),
    };
}
