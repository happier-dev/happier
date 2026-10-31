import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { decodePasswordCredentialFieldV1, encodePasswordCredentialFieldV1, passwordScryptFootprintBytesV1, PasswordMaterialHashV1Schema, PASSWORD_SCRYPT_KEY_BYTES_V1, PASSWORD_SCRYPT_SALT_BYTES_V1, type PasswordMaterialHashV1, type PasswordScryptParametersV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { createPasswordHashAdmission, type PasswordHashAdmission } from './passwordHashAdmission';

/**
 * The one byte-oriented password primitive.
 *
 * Both password-backed credentials go through this module: the Plain branch
 * hashes accepted password UTF-8, the E2EE branch hashes the already-derived
 * 32-byte `authKey`. Neither branch knows the algorithm, so there is exactly
 * one password-hash writer and one verifier in the system.
 *
 * This module is deliberately ignorant of Accounts, routes, modes and HTTP. It
 * takes bytes and a strict hash record and answers whether they correspond.
 */

/**
 * Candidate V1 profile from the OWASP Password Storage Cheat Sheet scrypt
 * ladder: N=2^14, r=8, p=5, with a 16 MiB principal working set.
 * The deployment-image empirical gate in 02.04 §3 remains required before
 * activation; a source comment or a benchmark on a different Node major does
 * not close it. Run `scripts/benchmarkPasswordHashPrimitive.ts` with
 * SCRYPT_COSTS=14 and SCRYPT_P=5 on the deployment image.
 */
export const PASSWORD_HASH_WRITER_PARAMETERS_V1: PasswordScryptParametersV1 = {
    n: 2 ** 14,
    r: 8,
    p: 5,
    keyLength: PASSWORD_SCRYPT_KEY_BYTES_V1,
};

/**
 * Node refuses a run whose `128 * N * r` working set exceeds `maxmem`, whose
 * default is 32 MiB. Derive the ceiling from the record's own parameters rather
 * than configuring a global, so a record the codec accepted always runs and one
 * it would reject never allocates.
 */
function maxMemBytesFor(parameters: PasswordScryptParametersV1): number {
    return passwordScryptFootprintBytesV1(parameters) + 32 * 1024 * 1024;
}

function deriveScrypt(
    material: Uint8Array,
    salt: Uint8Array,
    parameters: PasswordScryptParametersV1,
): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        scrypt(material, salt, parameters.keyLength, {
            N: parameters.n,
            r: parameters.r,
            p: parameters.p,
            maxmem: maxMemBytesFor(parameters),
        }, (error, derived) => {
            if (error) reject(error); else resolve(new Uint8Array(derived));
        });
    });
}

let sharedAdmission: PasswordHashAdmission | null = null;

/** Process-wide bound; every dispatch in this module goes through it. */
export function passwordHashAdmission(): PasswordHashAdmission {
    sharedAdmission ??= createPasswordHashAdmission();
    return sharedAdmission;
}

/**
 * Hash material under the current writer profile. Callers hash *outside* their
 * database transaction: this is hundreds of milliseconds of CPU and must never
 * hold a row lock.
 */
export async function hashPasswordMaterial(material: Uint8Array): Promise<PasswordMaterialHashV1> {
    const salt = new Uint8Array(randomBytes(PASSWORD_SCRYPT_SALT_BYTES_V1));
    const digest = await passwordHashAdmission().run(
        () => deriveScrypt(material, salt, PASSWORD_HASH_WRITER_PARAMETERS_V1),
    );
    return {
        v: 1,
        algorithm: 'scrypt',
        parameters: PASSWORD_HASH_WRITER_PARAMETERS_V1,
        salt: encodePasswordCredentialFieldV1(salt),
        digest: encodePasswordCredentialFieldV1(digest),
    };
}

/**
 * Verify material against a stored record.
 *
 * The record is re-validated here even though it was parsed on the way in: this
 * is the last point before an attacker-influenced parameter would reach a
 * native allocation, and a stored row can be corrupted or restored from an
 * older writer. A record outside the accepted ladder is a verification failure,
 * never an allocation.
 */
export async function verifyPasswordMaterial(
    hash: unknown,
    material: Uint8Array,
): Promise<boolean> {
    const parsed = PasswordMaterialHashV1Schema.safeParse(hash);
    if (!parsed.success) {
        // Keep the cost of a malformed record indistinguishable from a real
        // failure so credential shape does not leak through timing.
        await performDummyPasswordWork();
        return false;
    }
    const expected = decodePasswordCredentialFieldV1(parsed.data.digest);
    const derived = await passwordHashAdmission().run(() => deriveScrypt(
        material,
        decodePasswordCredentialFieldV1(parsed.data.salt),
        parsed.data.parameters,
    ));
    return derived.byteLength === expected.byteLength && timingSafeEqual(derived, expected);
}

/**
 * Equivalent bounded work for a request that has no credential to verify:
 * unknown Account, non-matching Account mode, or a malformed stored record.
 *
 * Without this, "no such Account" returns in microseconds while a real password
 * check takes hundreds of milliseconds, which turns the neutral authentication
 * failure into an Account-existence oracle. The dummy run uses the current
 * writer profile and goes through the same admission bound, so a flood of
 * unknown-Account attempts cannot bypass load shedding either.
 */
export async function performDummyPasswordWork(): Promise<void> {
    await passwordHashAdmission().run(() => deriveScrypt(
        DUMMY_MATERIAL,
        new Uint8Array(randomBytes(PASSWORD_SCRYPT_SALT_BYTES_V1)),
        PASSWORD_HASH_WRITER_PARAMETERS_V1,
    ));
}

/**
 * A fixed non-secret input. It is never compared against anything, so it does
 * not need to be random per call; only the work it causes matters.
 */
const DUMMY_MATERIAL = new TextEncoder().encode('happier.password.dummy-verification.v1');
