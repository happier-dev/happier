import {
    PASSWORD_ENVELOPE_KDF_SALT_BYTES_V1,
    PASSWORD_ENVELOPE_NONCE_BYTES_V1,
    PASSWORD_ENVELOPE_WRITER_PROFILE_V1,
    acceptPasswordTextV1,
    encodePasswordCredentialFieldV1,
    type PasswordWrappedRecoverySecretV1,
} from '@happier-dev/protocol/auth/accountPasswordCredential';

import { getRandomBytesAsync } from '@/platform/cryptoRandom';

import { derivePasswordKeys, sealPasswordEnvelope } from './passwordEnvelope';

export type PreparedPasswordCredentialMaterialV1 = Readonly<{
    envelope: PasswordWrappedRecoverySecretV1;
    /** base64url `authKey`; the Home stores only a one-way verifier over it. */
    authKey: string;
}>;

/**
 * Prepare the E2EE password credential for one Account secret: fresh salt and
 * nonce, the single supported writer profile, and the domain-separated
 * `wrapKey`/`authKey` split. The password, its root and `wrapKey` never leave
 * this device; only `authKey` is sent, and only to the unlock/enrollment
 * boundary.
 */
export async function preparePasswordCredentialMaterialV1(input: Readonly<{
    password: string;
    secret: Uint8Array;
    signal?: AbortSignal;
}>): Promise<PreparedPasswordCredentialMaterialV1> {
    const accepted = acceptPasswordTextV1(input.password);
    if (!accepted.accepted) throw new Error('password_not_accepted');
    accepted.utf8.fill(0);

    const kdf = {
        ...PASSWORD_ENVELOPE_WRITER_PROFILE_V1,
        salt: encodePasswordCredentialFieldV1(await getRandomBytesAsync(PASSWORD_ENVELOPE_KDF_SALT_BYTES_V1)),
    };
    const keys = await derivePasswordKeys(input.password, kdf, ...(input.signal ? [{ signal: input.signal }] : []));
    try {
        const envelope = await sealPasswordEnvelope({
            secret: input.secret,
            wrapKey: keys.wrapKey,
            kdf,
            nonce: await getRandomBytesAsync(PASSWORD_ENVELOPE_NONCE_BYTES_V1),
        });
        return { envelope, authKey: encodePasswordCredentialFieldV1(keys.authKey) };
    } finally {
        keys.wrapKey.fill(0);
        keys.authKey.fill(0);
    }
}
