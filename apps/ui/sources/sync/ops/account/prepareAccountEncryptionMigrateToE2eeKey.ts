import {
    deriveRecoveryContentKey,
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
} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';

type PreparedAccountEncryptionMigrateToE2eeKey = Readonly<{
    seed: Uint8Array;
    keyProof: Readonly<{
        v: 1;
        publicKey: string;
        contentPublicKey: string;
        contentPublicKeySig: string;
        sign: (input: Uint8Array) => string;
    }>;
}> & (
    | { requiresExternalAuthProof: true; credentials: LegacyAuthCredentials }
    | { requiresExternalAuthProof: false; credentials: AuthCredentials }
);

export function accountEncryptionRestoreRequired(): HappyError {
    return new HappyError(
        'The existing Account key must be restored before changing encryption mode',
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
        recoverySecret?: Uint8Array;
    }>,
): Promise<PreparedAccountEncryptionMigrateToE2eeKey> {
    const isKeylessAccount =
        params.expectedSigningKeyFingerprint === null
        && params.expectedContentKeyFingerprint === null;
    if (
        (params.expectedSigningKeyFingerprint === null)
        !== (params.expectedContentKeyFingerprint === null)
    ) {
        throw accountEncryptionRestoreRequired();
    }
    if (
        isKeylessAccount
        && !isTokenOnlyAuthCredentials(params.credentials)
    ) {
        throw accountEncryptionRestoreRequired();
    }

    let seed: Uint8Array;
    try {
        seed = isKeylessAccount
            ? getRandomBytes(32)
            : params.recoverySecret?.slice()
                ?? (isLegacyAuthCredentials(params.credentials) ? decodeBase64(params.credentials.secret, 'base64url') : new Uint8Array());
    } catch {
        throw accountEncryptionRestoreRequired();
    }

    try {
        if (seed.length !== 32) throw accountEncryptionRestoreRequired();
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
            throw accountEncryptionRestoreRequired();
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
            throw accountEncryptionRestoreRequired();
        }

        const keyProof = {
            v: 1 as const,
            publicKey: encodeBase64(publicKeyBytes),
            ...contentBinding,
            sign: (input: Uint8Array) => encodeBase64(signAccountPayload(seed, input)),
        };
        return isKeylessAccount
            ? {
                credentials: { token: params.credentials.token, secret: encodeBase64(seed, 'base64url') },
                seed,
                requiresExternalAuthProof: true,
                keyProof,
            }
            : {
                credentials: isTokenOnlyAuthCredentials(params.credentials)
                    ? { token: params.credentials.token, encryption: deriveRecoveryContentKey(seed) }
                    : params.credentials,
                seed,
                requiresExternalAuthProof: false,
                keyProof,
            };
    } catch (cause) {
        seed.fill(0);
        throw cause;
    }
}
