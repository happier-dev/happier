import {
    isLegacyAuthCredentials,
    isTokenOnlyAuthCredentials,
    type AuthCredentials,
    type LegacyAuthCredentials,
} from '@/auth/storage/tokenStorage';
import {
    deriveAccountSigningPublicKey,
    signAccountPayload,
} from '@/auth/flows/challenge';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { HappyError } from '@/utils/errors/errors';
import {
    computeAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';

type PreparedAccountEncryptionMigrateToE2eeKey = Readonly<{
    credentials: LegacyAuthCredentials;
    seed: Uint8Array;
    requiresExternalAuthProof: boolean;
    keyProof: Readonly<{
        v: 1;
        publicKey: string;
        contentPublicKey: string;
        contentPublicKeySig: string;
        sign: (input: Uint8Array) => string;
    }>;
}>;

function restoreRequired(): never {
    throw new HappyError(
        'The existing Account key must be restored before enabling end-to-end encryption',
        false,
        {
            status: 400,
            kind: 'auth',
            code: 'restore_required',
        },
    );
}

export async function prepareAccountEncryptionMigrateToE2eeKey(
    params: Readonly<{
        credentials: AuthCredentials;
        expectedSigningKeyFingerprint: string | null;
        expectedContentKeyFingerprint: string | null;
    }>,
): Promise<PreparedAccountEncryptionMigrateToE2eeKey> {
    const isKeylessAccount =
        params.expectedSigningKeyFingerprint === null
        && params.expectedContentKeyFingerprint === null;
    if (
        (params.expectedSigningKeyFingerprint === null)
        !== (params.expectedContentKeyFingerprint === null)
    ) {
        return restoreRequired();
    }
    if (
        isKeylessAccount
        && !isTokenOnlyAuthCredentials(params.credentials)
    ) {
        return restoreRequired();
    }

    let seed: Uint8Array;
    let credentials: LegacyAuthCredentials;
    if (isKeylessAccount) {
        seed = getRandomBytes(32);
        credentials = {
            token: params.credentials.token,
            secret: encodeBase64(seed, 'base64url'),
        };
    } else {
        if (!isLegacyAuthCredentials(params.credentials)) {
            return restoreRequired();
        }
        credentials = params.credentials;
        try {
            seed = decodeBase64(credentials.secret, 'base64url');
        } catch {
            return restoreRequired();
        }
        if (seed.length !== 32) {
            return restoreRequired();
        }
    }

    const publicKeyBytes = deriveAccountSigningPublicKey(seed);
    const proposedSigningKeyFingerprint =
        computeAccountEncryptionMigrateKeyFingerprintV1(
            publicKeyBytes,
        );
    if (
        params.expectedSigningKeyFingerprint !== null
        && params.expectedSigningKeyFingerprint
            !== proposedSigningKeyFingerprint
    ) {
        return restoreRequired();
    }

    const contentBinding = await buildContentKeyBinding(seed);
    const proposedContentKeyFingerprint =
        computeAccountEncryptionMigrateKeyFingerprintV1(
            decodeBase64(contentBinding.contentPublicKey),
        );
    if (
        params.expectedContentKeyFingerprint !== null
        && params.expectedContentKeyFingerprint
            !== proposedContentKeyFingerprint
    ) {
        return restoreRequired();
    }

    return {
        credentials,
        seed,
        requiresExternalAuthProof: isKeylessAccount,
        keyProof: {
            v: 1,
            publicKey: encodeBase64(publicKeyBytes),
            ...contentBinding,
            sign: (input) =>
                encodeBase64(signAccountPayload(seed, input)),
        },
    };
}
