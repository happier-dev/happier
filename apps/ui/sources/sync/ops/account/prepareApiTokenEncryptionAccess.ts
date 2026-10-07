import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { openApiTokenEncryptionAccessV1, wrapApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { AccountApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';

export async function prepareApiTokenEncryptionAccess(params: Readonly<{
    credentials: AuthCredentials;
    currentness: AccountEncryptionCurrentnessResponse;
    serverIdentityId: string;
    accountId: string;
    tokenId: string;
}>): Promise<Readonly<{ encryptionAccess: AccountApiTokenEncryptionAccessV1; wrappingSecret: Uint8Array }>> {
    if (params.currentness.mode !== 'e2ee'
        // A Home that predates the readiness projection omits the field entirely.
        // Absent readiness is "not ready", never an excuse to dereference it.
        || params.currentness.recipientEnvelopeReadiness?.status !== 'available'
        || !params.currentness.contentKeyFingerprint) {
        throw new Error('api_token_encryption_not_ready');
    }
    const encryption = await createEncryptionFromAuthCredentials(params.credentials)
        .catch(() => { throw new Error('api_token_encryption_not_ready'); });
    if (computeAccountEncryptionMigrateKeyFingerprintV1(encryption.contentDataKey) !== params.currentness.contentKeyFingerprint) {
        throw new Error('api_token_encryption_stale');
    }
    const context = {
        serverIdentityId: params.serverIdentityId, accountId: params.accountId,
        tokenId: params.tokenId, contentPublicKey: encodeBase64(encryption.contentDataKey),
    };
    const wrappingSecret = getRandomBytes(32);
    const contentPrivateKey = encryption.getContentPrivateKey();
    const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret, contentPrivateKey, randomBytes: getRandomBytes });
    const opened = openApiTokenEncryptionAccessV1({ context, wrappingSecret, encryptionAccess });
    if (!opened || !opened.every((byte, index) => byte === contentPrivateKey[index])) {
        throw new Error('api_token_encryption_not_ready');
    }
    return { encryptionAccess, wrappingSecret };
}
