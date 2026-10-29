import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '../crypto/base64.js';
import {
    acceptPasswordTextV1,
    AccountPasswordCredentialV1Schema,
    createPasswordEnvelopeAadV1,
    parseAccountPasswordCredentialV1,
    PasswordEnvelopeKdfV1Schema,
    PasswordMaterialHashV1Schema,
    PasswordWrappedRecoverySecretV1Schema,
    PASSWORD_MAX_UTF8_BYTES_V1,
    PASSWORD_MIN_SCALARS_V1,
    PASSWORD_SCRYPT_MAX_FOOTPRINT_BYTES_V1,
    type PasswordWrappedRecoverySecretV1,
} from './accountPasswordCredential.js';

function bytes(length: number, fill = 7): string {
    return encodeBase64(new Uint8Array(length).fill(fill), 'base64url');
}

const validHash = {
    v: 1 as const,
    algorithm: 'scrypt' as const,
    parameters: { n: 2 ** 15, r: 8 as const, p: 3, keyLength: 32 as const },
    salt: bytes(16),
    digest: bytes(32, 9),
};

const validEnvelope: PasswordWrappedRecoverySecretV1 = {
    v: 1,
    accountSigningPublicKey: bytes(32, 3),
    kdf: {
        algorithm: 'argon2id13',
        salt: bytes(16, 5),
        opsLimit: 3,
        memLimitBytes: 64 * 1024 * 1024,
        outputBytes: 32,
    },
    cipher: { algorithm: 'aes256gcm', nonce: bytes(12, 1), ciphertext: bytes(48, 2) },
};

describe('acceptPasswordTextV1', () => {
    it('accepts exactly the shared minimum and rejects one scalar below it', () => {
        expect(acceptPasswordTextV1('a'.repeat(PASSWORD_MIN_SCALARS_V1)).accepted).toBe(true);
        expect(acceptPasswordTextV1('a'.repeat(PASSWORD_MIN_SCALARS_V1 - 1))).toEqual({
            accepted: false,
            reason: 'too_few_scalars',
        });
    });

    it('counts astral characters as one scalar, not two UTF-16 units', () => {
        // 15 surrogate pairs is 30 UTF-16 units but exactly 15 Unicode scalars.
        const result = acceptPasswordTextV1('\u{1f600}'.repeat(PASSWORD_MIN_SCALARS_V1));
        expect(result.accepted).toBe(true);
        if (!result.accepted) return;
        expect(result.scalars).toBe(PASSWORD_MIN_SCALARS_V1);
        expect(result.utf8.byteLength).toBe(PASSWORD_MIN_SCALARS_V1 * 4);
    });

    it('rejects unpaired surrogates instead of encoding U+FFFD', () => {
        const lonely = `${'a'.repeat(PASSWORD_MIN_SCALARS_V1)}\ud800`;
        expect(acceptPasswordTextV1(lonely)).toEqual({ accepted: false, reason: 'malformed_unicode' });
        expect(acceptPasswordTextV1(`\udc00${'a'.repeat(PASSWORD_MIN_SCALARS_V1)}`)).toEqual({
            accepted: false,
            reason: 'malformed_unicode',
        });
    });

    it('does not normalize, trim or case fold', () => {
        const precomposed = `café${'x'.repeat(11)}`;
        const decomposed = `café${'x'.repeat(11)}`;
        const precomposedResult = acceptPasswordTextV1(precomposed);
        const decomposedResult = acceptPasswordTextV1(decomposed);
        expect(precomposedResult.accepted && decomposedResult.accepted).toBe(true);
        if (!precomposedResult.accepted || !decomposedResult.accepted) return;
        // Normalizing here would silently merge two distinct passwords and make
        // every existing envelope irreproducible.
        expect(Array.from(precomposedResult.utf8)).not.toEqual(Array.from(decomposedResult.utf8));

        const padded = `  ${'a'.repeat(PASSWORD_MIN_SCALARS_V1)}  `;
        const paddedResult = acceptPasswordTextV1(padded);
        expect(paddedResult.accepted).toBe(true);
        if (!paddedResult.accepted) return;
        expect(new TextDecoder().decode(paddedResult.utf8)).toBe(padded);
    });

    it('bounds by UTF-8 bytes, not scalars', () => {
        expect(acceptPasswordTextV1('a'.repeat(PASSWORD_MAX_UTF8_BYTES_V1)).accepted).toBe(true);
        expect(acceptPasswordTextV1('a'.repeat(PASSWORD_MAX_UTF8_BYTES_V1 + 1))).toEqual({
            accepted: false,
            reason: 'too_many_bytes',
        });
        // 400 four-byte scalars is only 400 scalars but 1600 bytes.
        expect(acceptPasswordTextV1('\u{1f600}'.repeat(400))).toEqual({
            accepted: false,
            reason: 'too_many_bytes',
        });
    });
});

describe('PasswordMaterialHashV1Schema', () => {
    it('enforces the OWASP parallelism floor for each accepted memory cost', () => {
        for (const [n, minimumP] of [[2 ** 14, 5], [2 ** 15, 3], [2 ** 16, 2], [2 ** 17, 1]]) {
            const record = (p: number) => ({ ...validHash, parameters: { ...validHash.parameters, n, p } });
            expect(PasswordMaterialHashV1Schema.safeParse(record(minimumP)).success).toBe(true);
            expect(PasswordMaterialHashV1Schema.safeParse(record(minimumP - 1)).success).toBe(false);
        }
    });

    it('refuses parameters outside the accepted ladder before any allocation', () => {
        const reject = (parameters: unknown) =>
            expect(PasswordMaterialHashV1Schema.safeParse({ ...validHash, parameters }).success).toBe(false);
        reject({ ...validHash.parameters, n: 2 ** 15 + 1 });   // not a power of two
        reject({ ...validHash.parameters, n: 2 ** 13 });       // below the floor
        reject({ ...validHash.parameters, n: 2 ** 18 });       // above the ceiling
        reject({ ...validHash.parameters, r: 16 });
        reject({ ...validHash.parameters, p: 6 });
        reject({ ...validHash.parameters, p: 0 });
        reject({ ...validHash.parameters, keyLength: 64 });
    });

    it('keeps the ladder inside the documented working-set ceiling', () => {
        expect(PASSWORD_SCRYPT_MAX_FOOTPRINT_BYTES_V1).toBe(128 * 1024 * 1024);
    });

    it('refuses wrong field lengths and non-canonical encodings', () => {
        expect(PasswordMaterialHashV1Schema.safeParse({ ...validHash, salt: bytes(15) }).success).toBe(false);
        expect(PasswordMaterialHashV1Schema.safeParse({ ...validHash, digest: bytes(31) }).success).toBe(false);
        // Standard base64 padding is not the canonical base64url spelling.
        expect(PasswordMaterialHashV1Schema.safeParse({
            ...validHash,
            salt: encodeBase64(new Uint8Array(16).fill(7), 'base64'),
        }).success).toBe(false);
    });

    it('is closed to unknown fields', () => {
        expect(PasswordMaterialHashV1Schema.safeParse({ ...validHash, pepper: 'x' }).success).toBe(false);
    });
});

describe('password envelope', () => {
    it('accepts a valid envelope and refuses a wrong-sized ciphertext', () => {
        expect(PasswordWrappedRecoverySecretV1Schema.parse(validEnvelope)).toEqual(validEnvelope);
        // 32-byte secret plus the 16-byte GCM tag is the only valid length.
        for (const length of [32, 47, 49, 64]) {
            expect(PasswordWrappedRecoverySecretV1Schema.safeParse({
                ...validEnvelope,
                cipher: { ...validEnvelope.cipher, ciphertext: bytes(length) },
            }).success).toBe(false);
        }
    });

    it('refuses KDF facts outside the supported writer profile', () => {
        const reject = (kdf: unknown) =>
            expect(PasswordEnvelopeKdfV1Schema.safeParse(kdf).success).toBe(false);
        reject({ ...validEnvelope.kdf, opsLimit: 2 });
        reject({ ...validEnvelope.kdf, opsLimit: 4 });
        reject({ ...validEnvelope.kdf, memLimitBytes: 32 * 1024 * 1024 });
        reject({ ...validEnvelope.kdf, memLimitBytes: 128 * 1024 * 1024 });
        reject({ ...validEnvelope.kdf, memLimitBytes: 64 * 1024 * 1024 + 1 });
        reject({ ...validEnvelope.kdf, outputBytes: 64 });
        reject({ ...validEnvelope.kdf, algorithm: 'argon2i' });
        reject({ ...validEnvelope.kdf, salt: bytes(32) });
    });

    it('binds every fact an attacker could otherwise swap into the AAD', () => {
        const base = createPasswordEnvelopeAadV1(validEnvelope);
        const variants: PasswordWrappedRecoverySecretV1[] = [
            { ...validEnvelope, accountSigningPublicKey: bytes(32, 4) },
            { ...validEnvelope, kdf: { ...validEnvelope.kdf, salt: bytes(16, 6) } },
            { ...validEnvelope, kdf: { ...validEnvelope.kdf, opsLimit: 4 } },
            { ...validEnvelope, kdf: { ...validEnvelope.kdf, memLimitBytes: 128 * 1024 * 1024 } },
            { ...validEnvelope, cipher: { ...validEnvelope.cipher, nonce: bytes(12, 8) } },
        ];
        for (const variant of variants) {
            expect(Array.from(createPasswordEnvelopeAadV1(variant))).not.toEqual(Array.from(base));
        }
        // The ciphertext is authenticated by GCM itself and must not feed its own AAD.
        expect(Array.from(createPasswordEnvelopeAadV1({
            ...validEnvelope,
            cipher: { ...validEnvelope.cipher, ciphertext: bytes(48, 9) },
        }))).toEqual(Array.from(base));
    });
});

describe('parseAccountPasswordCredentialV1', () => {
    const plainCredential = { v: 1 as const, kind: 'plain_password_hash' as const, hash: validHash };
    const e2eeCredential = {
        v: 1 as const,
        kind: 'e2ee_password_envelope' as const,
        envelope: validEnvelope,
        authVerifier: { v: 1 as const, hash: validHash },
    };


    it('accepts each credential under its own persisted mode', () => {
        expect(parseAccountPasswordCredentialV1('plain', plainCredential)).toEqual({
            ok: true, mode: 'plain', credential: plainCredential,
        });
        expect(parseAccountPasswordCredentialV1('e2ee', e2eeCredential)).toEqual({
            ok: true, mode: 'e2ee', credential: e2eeCredential,
        });
    });

    it('fails closed when the credential kind contradicts Account.encryptionMode', () => {
        expect(parseAccountPasswordCredentialV1('e2ee', plainCredential)).toEqual({
            ok: false, reason: 'mode_mismatch',
        });
        expect(parseAccountPasswordCredentialV1('plain', e2eeCredential)).toEqual({
            ok: false, reason: 'mode_mismatch',
        });
    });

    it('fails closed on malformed, unknown-kind and extended records', () => {
        for (const value of [null, undefined, 'plain_password_hash', {}, { v: 1, kind: 'opaque' }]) {
            expect(parseAccountPasswordCredentialV1('plain', value)).toEqual({ ok: false, reason: 'malformed' });
        }
        expect(parseAccountPasswordCredentialV1('plain', { ...plainCredential, legacy: true })).toEqual({
            ok: false, reason: 'malformed',
        });
        expect(parseAccountPasswordCredentialV1('plain', {
            ...plainCredential,
            hash: { ...validHash, parameters: { ...validHash.parameters, n: 2 ** 20 } },
        })).toEqual({ ok: false, reason: 'malformed' });
    });

    it('keeps the union closed', () => {
        expect(AccountPasswordCredentialV1Schema.safeParse({
            v: 1, kind: 'plain_password_hash', hash: validHash, envelope: validEnvelope,
        }).success).toBe(false);
    });
});
