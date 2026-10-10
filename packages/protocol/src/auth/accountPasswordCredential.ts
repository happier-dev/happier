import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { encodeCanonicalLengthDelimited } from '../crypto/canonicalDigest.js';
import { AccountEncryptionModeSchema, type AccountEncryptionMode } from '../features/payload/capabilities/encryptionCapabilities.js';

/**
 * Lane 02 native password credential codecs.
 *
 * One module owns the password *text* contract, the byte-oriented hash record
 * shared by Plain password hashes and E2EE derived-authentication verifiers,
 * the password envelope around the existing 32-byte recovery secret, and the
 * closed mode-qualified credential union persisted in
 * `AccountPasswordCredential.credential`.
 *
 * Nothing here derives, wraps or verifies anything: derivation lives in the
 * client KDF owner, verification in the server password primitive. This module
 * is the single parse/serialize authority both of them share so Plain and E2EE
 * inputs can never diverge (L02-R21).
 */

// ---------------------------------------------------------------------------
// Password text acceptance (02.04 §8, 02.05 §3)
// ---------------------------------------------------------------------------

/** Shared Happier V1 acceptance bound. Plain and E2EE must not differ. */
export const PASSWORD_MIN_SCALARS_V1 = 15;
export const PASSWORD_MAX_UTF8_BYTES_V1 = 1024;

export type PasswordTextRejectionReasonV1 =
    | 'malformed_unicode'
    | 'too_few_scalars'
    | 'too_many_bytes';

export type PasswordTextAcceptanceV1 =
    | Readonly<{ accepted: true; utf8: Uint8Array; scalars: number }>
    | Readonly<{ accepted: false; reason: PasswordTextRejectionReasonV1 }>;

/**
 * Convert entered password text to the exact bytes every platform must feed to
 * scrypt or Argon2id.
 *
 * The sequence is preserved exactly as entered: no trim, case fold, NFC, NFD,
 * NFKC or NFKD. Changing normalization later would make existing envelopes
 * impossible to reproduce, so the absence of it is the contract. Unpaired
 * UTF-16 surrogates are rejected rather than silently encoded as U+FFFD, which
 * is what `TextEncoder` would otherwise do and which would make two different
 * passwords collide on one platform but not another.
 */
export function acceptPasswordTextV1(password: string): PasswordTextAcceptanceV1 {
    let scalars = 0;
    for (let index = 0; index < password.length; index += 1) {
        const code = password.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const low = index + 1 < password.length ? password.charCodeAt(index + 1) : 0;
            if (low < 0xdc00 || low > 0xdfff) return { accepted: false, reason: 'malformed_unicode' };
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return { accepted: false, reason: 'malformed_unicode' };
        }
        scalars += 1;
    }
    if (scalars < PASSWORD_MIN_SCALARS_V1) return { accepted: false, reason: 'too_few_scalars' };
    const utf8 = new TextEncoder().encode(password);
    if (utf8.byteLength > PASSWORD_MAX_UTF8_BYTES_V1) return { accepted: false, reason: 'too_many_bytes' };
    return { accepted: true, utf8, scalars };
}

// ---------------------------------------------------------------------------
// Canonical base64url fields
// ---------------------------------------------------------------------------

function decodeCanonicalBase64Url(value: string): Uint8Array | null {
    let decoded: Uint8Array;
    try {
        decoded = decodeBase64(value, 'base64url');
    } catch {
        return null;
    }
    // The shared decoder is deliberately lenient; re-encoding is what makes a
    // persisted field canonical, so two byte-identical credentials cannot have
    // two spellings.
    return encodeBase64(decoded, 'base64url') === value ? decoded : null;
}

function base64UrlOfExactBytes(byteLength: number) {
    return z.string().max(4 * Math.ceil(byteLength / 3) + 8).refine(
        (value) => decodeCanonicalBase64Url(value)?.byteLength === byteLength,
        { message: `expected canonical base64url of exactly ${byteLength} bytes` },
    );
}

/** Decode a field this module already validated. */
export function decodePasswordCredentialFieldV1(value: string): Uint8Array {
    const decoded = decodeCanonicalBase64Url(value);
    if (!decoded) throw new Error('password_credential_field_not_canonical');
    return decoded;
}

export function encodePasswordCredentialFieldV1(bytes: Uint8Array): string {
    return encodeBase64(bytes, 'base64url');
}

// ---------------------------------------------------------------------------
// Byte-oriented password hash record
// ---------------------------------------------------------------------------

/**
 * V1 uses one hash primitive with one writer. The accepted parameter window is
 * the OWASP Password Storage Cheat Sheet scrypt ladder (N=2^17/r=8/p=1 and its
 * documented equal-work alternatives down to N=2^14/r=8/p=5). Values outside it
 * are refused before any allocation, so a corrupted or hostile stored record
 * cannot make the server allocate an arbitrary buffer.
 */
export const PASSWORD_SCRYPT_SALT_BYTES_V1 = 16;
export const PASSWORD_SCRYPT_KEY_BYTES_V1 = 32;
export const PASSWORD_SCRYPT_MIN_COST_V1 = 2 ** 14;
export const PASSWORD_SCRYPT_MAX_COST_V1 = 2 ** 17;
export const PASSWORD_SCRYPT_BLOCK_SIZE_V1 = 8;
export const PASSWORD_SCRYPT_MIN_PARALLELISM_V1 = 1;
export const PASSWORD_SCRYPT_MAX_PARALLELISM_V1 = 5;

/**
 * scrypt's working set is `128 * N * r` and is independent of `p`, so the whole
 * accepted ladder is bounded by the largest rung. Callers size their admission
 * ceiling from this, not from a nearby round number.
 */
export const PASSWORD_SCRYPT_MAX_FOOTPRINT_BYTES_V1 =
    128 * PASSWORD_SCRYPT_MAX_COST_V1 * PASSWORD_SCRYPT_BLOCK_SIZE_V1;

export const PasswordScryptParametersV1Schema = lazyZodSchema(() => z.object({
    n: z.number().int().min(PASSWORD_SCRYPT_MIN_COST_V1).max(PASSWORD_SCRYPT_MAX_COST_V1)
        .refine((value) => (value & (value - 1)) === 0, { message: 'scrypt cost must be a power of two' }),
    r: z.literal(PASSWORD_SCRYPT_BLOCK_SIZE_V1),
    p: z.number().int().min(PASSWORD_SCRYPT_MIN_PARALLELISM_V1).max(PASSWORD_SCRYPT_MAX_PARALLELISM_V1),
    keyLength: z.literal(PASSWORD_SCRYPT_KEY_BYTES_V1),
}).strict().refine(
    ({ n, p }) => p >= (n >= 2 ** 17 ? 1 : n >= 2 ** 16 ? 2 : n >= 2 ** 15 ? 3 : 5),
    { message: 'scrypt parallelism is below the minimum for this memory cost', path: ['p'] },
));
export type PasswordScryptParametersV1 = z.infer<typeof PasswordScryptParametersV1Schema>;

/** Working-set bytes for a validated parameter set. */
export function passwordScryptFootprintBytesV1(parameters: PasswordScryptParametersV1): number {
    return 128 * parameters.n * parameters.r;
}

/**
 * The one byte-oriented hash record. The Plain branch hashes accepted password
 * UTF-8; the E2EE branch hashes the already-derived fixed-length `authKey`.
 * Both go through the same server verifier module, so there is exactly one
 * password-hash format in the system.
 */
export const PasswordMaterialHashV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    algorithm: z.literal('scrypt'),
    parameters: PasswordScryptParametersV1Schema,
    salt: base64UrlOfExactBytes(PASSWORD_SCRYPT_SALT_BYTES_V1),
    digest: base64UrlOfExactBytes(PASSWORD_SCRYPT_KEY_BYTES_V1),
}).strict());
export type PasswordMaterialHashV1 = z.infer<typeof PasswordMaterialHashV1Schema>;

/** 02.04 §2 vocabulary for the Plain branch of the same record. */
export const PlainPasswordHashV1Schema = PasswordMaterialHashV1Schema;
export type PlainPasswordHashV1 = PasswordMaterialHashV1;

/** 02.05 §3 vocabulary for the derived-key branch of the same record. */
export const PasswordAuthenticationMaterialHashV1Schema = PasswordMaterialHashV1Schema;
export type PasswordAuthenticationMaterialHashV1 = PasswordMaterialHashV1;

// ---------------------------------------------------------------------------
// Derived-authentication verifier
// ---------------------------------------------------------------------------

/** The domain-separated `authKey` the client proves at the unlock boundary. */
export const PASSWORD_DERIVED_AUTH_KEY_BYTES_V1 = 32;

export const PasswordDerivedAuthenticationVerifierV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    hash: PasswordAuthenticationMaterialHashV1Schema,
}).strict());
export type PasswordDerivedAuthenticationVerifierV1 = z.infer<typeof PasswordDerivedAuthenticationVerifierV1Schema>;

// ---------------------------------------------------------------------------
// Password envelope around the existing 32-byte recovery secret
// ---------------------------------------------------------------------------

export const PASSWORD_ENVELOPE_KDF_SALT_BYTES_V1 = 16;
export const PASSWORD_ENVELOPE_NONCE_BYTES_V1 = 12;
export const PASSWORD_ENVELOPE_SECRET_BYTES_V1 = 32;
/** AES-GCM ciphertext of the 32-byte secret plus its 16-byte tag. */
export const PASSWORD_ENVELOPE_CIPHERTEXT_BYTES_V1 = PASSWORD_ENVELOPE_SECRET_BYTES_V1 + 16;
export const PASSWORD_ENVELOPE_SIGNING_PUBLIC_KEY_BYTES_V1 = 32;

/** The complete set of KDF parameter tuples current Happier writers produce. */
const PASSWORD_ENVELOPE_WRITER_PROFILE_FACTS_V1 = [
    { algorithm: 'argon2id13', opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, outputBytes: 32 },
] as const;

/**
 * Reader allocation bounds are derived from actual writer output. Lane 02 has
 * no released password-envelope predecessor and therefore no authority to
 * admit a wider speculative parameter range.
 */
export const PASSWORD_ENVELOPE_MIN_OPS_LIMIT_V1 = Math.min(
    ...PASSWORD_ENVELOPE_WRITER_PROFILE_FACTS_V1.map(({ opsLimit }) => opsLimit),
);
export const PASSWORD_ENVELOPE_MAX_OPS_LIMIT_V1 = Math.max(
    ...PASSWORD_ENVELOPE_WRITER_PROFILE_FACTS_V1.map(({ opsLimit }) => opsLimit),
);
export const PASSWORD_ENVELOPE_MIN_MEM_LIMIT_BYTES_V1 = Math.min(
    ...PASSWORD_ENVELOPE_WRITER_PROFILE_FACTS_V1.map(({ memLimitBytes }) => memLimitBytes),
);
export const PASSWORD_ENVELOPE_MAX_MEM_LIMIT_BYTES_V1 = Math.max(
    ...PASSWORD_ENVELOPE_WRITER_PROFILE_FACTS_V1.map(({ memLimitBytes }) => memLimitBytes),
);

/**
 * The bounded KDF facts. Public prelogin returns exactly this and nothing else
 * for the E2EE branch: no ciphertext, signing key, verifier or Account ID.
 */
export const PasswordEnvelopeKdfV1Schema = lazyZodSchema(() => z.object({
    algorithm: z.literal('argon2id13'),
    salt: base64UrlOfExactBytes(PASSWORD_ENVELOPE_KDF_SALT_BYTES_V1),
    opsLimit: z.number().int().min(PASSWORD_ENVELOPE_MIN_OPS_LIMIT_V1).max(PASSWORD_ENVELOPE_MAX_OPS_LIMIT_V1),
    memLimitBytes: z.number().int()
        .min(PASSWORD_ENVELOPE_MIN_MEM_LIMIT_BYTES_V1).max(PASSWORD_ENVELOPE_MAX_MEM_LIMIT_BYTES_V1)
        .refine((value) => value % 1024 === 0, { message: 'memLimitBytes must be a whole number of KiB' }),
    outputBytes: z.literal(32),
}).strict().refine(
    ({ algorithm, opsLimit, memLimitBytes, outputBytes }) =>
        PASSWORD_ENVELOPE_WRITER_PROFILE_FACTS_V1.some((profile) =>
            profile.algorithm === algorithm
            && profile.opsLimit === opsLimit
            && profile.memLimitBytes === memLimitBytes
            && profile.outputBytes === outputBytes),
    { message: 'unsupported password-envelope writer profile' },
));
export type PasswordEnvelopeKdfV1 = z.infer<typeof PasswordEnvelopeKdfV1Schema>;

/**
 * The profiles a current Happier client may write. There is exactly one today:
 * three Argon2id passes over a 64 MiB working set. Web/Tauri and native clients
 * execute it off the main thread; live target latency/memory certification is
 * a separate activation gate.
 *
 * This list is both the writer authority and the reader-allocation provenance.
 * A decoy drawn from a wider invented range rather than from real writer output
 * would make absent Accounts distinguishable from enrolled ones.
 *
 * If the §4 measurement gate later raises the profile, append the new profile
 * here and make it the writer default: readers keep accepting both while
 * enrolled envelopes carry the older one, and the decoy distribution stays
 * truthful because it is drawn from this same list.
 */
export const PASSWORD_ENVELOPE_SUPPORTED_WRITER_PROFILES_V1: readonly Readonly<
    Omit<PasswordEnvelopeKdfV1, 'salt'>
>[] = PASSWORD_ENVELOPE_WRITER_PROFILE_FACTS_V1;

/** The profile new envelopes are written with. */
export const PASSWORD_ENVELOPE_WRITER_PROFILE_V1 = PASSWORD_ENVELOPE_SUPPORTED_WRITER_PROFILES_V1[0]!;

/**
 * Pick a supported writer profile from an opaque selector byte. Real writers
 * use {@link PASSWORD_ENVELOPE_WRITER_PROFILE_V1}; the prelogin decoy uses this
 * with a per-mailbox deterministic selector so an absent Account is drawn from
 * the same distribution real Accounts are.
 */
export function selectPasswordEnvelopeWriterProfileV1(
    selector: number,
): Readonly<Omit<PasswordEnvelopeKdfV1, 'salt'>> {
    const profiles = PASSWORD_ENVELOPE_SUPPORTED_WRITER_PROFILES_V1;
    return profiles[Math.abs(Math.trunc(selector)) % profiles.length]!;
}

export const PasswordWrappedRecoverySecretV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    accountSigningPublicKey: base64UrlOfExactBytes(PASSWORD_ENVELOPE_SIGNING_PUBLIC_KEY_BYTES_V1),
    kdf: PasswordEnvelopeKdfV1Schema,
    cipher: z.object({
        algorithm: z.literal('aes256gcm'),
        nonce: base64UrlOfExactBytes(PASSWORD_ENVELOPE_NONCE_BYTES_V1),
        ciphertext: base64UrlOfExactBytes(PASSWORD_ENVELOPE_CIPHERTEXT_BYTES_V1),
    }).strict(),
}).strict());
export type PasswordWrappedRecoverySecretV1 = z.infer<typeof PasswordWrappedRecoverySecretV1Schema>;

export const PASSWORD_ENVELOPE_AAD_DOMAIN_V1 = 'happier.password-wrapped-recovery-secret.v1';

/**
 * Canonical AAD for the envelope cipher. It binds the envelope version and
 * purpose, the Account signing public key, and the exact KDF and cipher
 * parameters, so an envelope cannot be replayed under different parameters or
 * against a different Account key. Length-delimited framing keeps two different
 * field splits from producing the same bytes.
 */
export function createPasswordEnvelopeAadV1(
    envelope: Omit<PasswordWrappedRecoverySecretV1, 'cipher'> & Readonly<{
        cipher: Omit<PasswordWrappedRecoverySecretV1['cipher'], 'ciphertext'>;
    }>,
): Uint8Array {
    return encodeCanonicalLengthDelimited([
        PASSWORD_ENVELOPE_AAD_DOMAIN_V1,
        String(envelope.v),
        envelope.accountSigningPublicKey,
        envelope.kdf.algorithm,
        envelope.kdf.salt,
        String(envelope.kdf.opsLimit),
        String(envelope.kdf.memLimitBytes),
        String(envelope.kdf.outputBytes),
        envelope.cipher.algorithm,
        envelope.cipher.nonce,
    ]);
}

// ---------------------------------------------------------------------------
// Closed mode-qualified credential union
// ---------------------------------------------------------------------------

export const PlainAccountPasswordCredentialV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    kind: z.literal('plain_password_hash'),
    hash: PlainPasswordHashV1Schema,
}).strict());
export type PlainAccountPasswordCredentialV1 = z.infer<typeof PlainAccountPasswordCredentialV1Schema>;

export const E2eeAccountPasswordCredentialV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    kind: z.literal('e2ee_password_envelope'),
    envelope: PasswordWrappedRecoverySecretV1Schema,
    authVerifier: PasswordDerivedAuthenticationVerifierV1Schema,
}).strict());
export type E2eeAccountPasswordCredentialV1 = z.infer<typeof E2eeAccountPasswordCredentialV1Schema>;

export const AccountPasswordCredentialV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    PlainAccountPasswordCredentialV1Schema,
    E2eeAccountPasswordCredentialV1Schema,
]));
export type AccountPasswordCredentialV1 = z.infer<typeof AccountPasswordCredentialV1Schema>;

export type AccountPasswordCredentialParseV1 =
    | Readonly<{ ok: true; mode: 'plain'; credential: PlainAccountPasswordCredentialV1 }>
    | Readonly<{ ok: true; mode: 'e2ee'; credential: E2eeAccountPasswordCredentialV1 }>
    | Readonly<{ ok: false; reason: 'malformed' | 'mode_mismatch' }>;

const CREDENTIAL_KIND_FOR_MODE: Record<AccountEncryptionMode, AccountPasswordCredentialV1['kind']> = {
    plain: 'plain_password_hash',
    e2ee: 'e2ee_password_envelope',
};

/**
 * The one choke point every reader and writer uses. `Account.encryptionMode` is
 * authoritative, never credential shape, so a credential whose kind does not
 * match the persisted mode fails closed here — before any disclosure, hashing
 * or mutation — rather than being reinterpreted.
 */
export function parseAccountPasswordCredentialV1(
    mode: AccountEncryptionMode,
    value: unknown,
): AccountPasswordCredentialParseV1 {
    const parsedMode = AccountEncryptionModeSchema.safeParse(mode);
    if (!parsedMode.success) return { ok: false, reason: 'mode_mismatch' };
    const parsed = AccountPasswordCredentialV1Schema.safeParse(value);
    if (!parsed.success) return { ok: false, reason: 'malformed' };
    if (parsed.data.kind !== CREDENTIAL_KIND_FOR_MODE[parsedMode.data]) {
        return { ok: false, reason: 'mode_mismatch' };
    }
    return parsed.data.kind === 'plain_password_hash'
        ? { ok: true, mode: 'plain', credential: parsed.data }
        : { ok: true, mode: 'e2ee', credential: parsed.data };
}
