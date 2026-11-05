import { isDataKeyAuthCredentials, isLegacyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';

/** A supported legacy Account whose advertised identity matches its actual recovery material. */
export function createLegacyAccountEncryptionCurrentnessFixture(input: Readonly<{ secret: Uint8Array }>): AccountEncryptionCurrentnessResponse {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: input.secret } });
    return { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing',
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } };
}

/** A real data-key Account's currentness, matching the client's actual material. */
export function createDataKeyAccountEncryptionCurrentnessFixture(input: Readonly<{
    machineKey: Uint8Array;
    publicKey: Uint8Array;
}>): AccountEncryptionCurrentnessResponse {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'dataKey', machineKey: input.machineKey }, dataKeyPublicKey: input.publicKey });
    return { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing',
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } };
}

/**
 * Canonical plain-Account currentness response for UI boundary harnesses.
 * Plain Accounts intentionally have no recipient encryption envelope.
 */
export function createPlainAccountEncryptionCurrentnessFixture(input: Readonly<{
    version?: number;
    settingsVersion?: number;
    updatedAt?: number;
}> = {}): AccountEncryptionCurrentnessResponse {
    return Object.freeze({
        mode: 'plain',
        version: input.version ?? 1,
        ...(input.settingsVersion === undefined ? {} : { settingsVersion: input.settingsVersion }),
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: input.updatedAt ?? 1,
        recipientEnvelopeReadiness: Object.freeze({
            status: 'unavailable',
            reason: 'plain_account',
        }),
    });
}

/**
 * The currentness a Home reports for exactly the material these credentials hold.
 * Keyless credentials belong to a plain Account, which has no E2EE material.
 */
export function createAccountEncryptionCurrentnessFixtureForCredentials(
    credentials: AuthCredentials,
): AccountEncryptionCurrentnessResponse {
    if (isLegacyAuthCredentials(credentials)) {
        return createLegacyAccountEncryptionCurrentnessFixture({ secret: decodeBase64(credentials.secret, 'base64url') });
    }
    if (isDataKeyAuthCredentials(credentials)) {
        return createDataKeyAccountEncryptionCurrentnessFixture({
            machineKey: decodeBase64(credentials.encryption.machineKey, 'base64'),
            publicKey: decodeBase64(credentials.encryption.publicKey, 'base64'),
        });
    }
    return createPlainAccountEncryptionCurrentnessFixture();
}

/** Current Home HTTP fixture; the separate legacy /encryption route has a different schema. */
export function createPlainAccountEncryptionCurrentnessHttpResponse(pathname: string): Response | null {
    return pathname === '/v1/account/encryption/currentness'
        ? Response.json(createPlainAccountEncryptionCurrentnessFixture()) : null;
}
