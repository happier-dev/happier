import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { normalizeVerifiedEmail, VERIFIED_EMAIL_MAX_SCALARS } from './verifiedEmail.js';

/**
 * Lane 02 one-time email operations are strict closed records stored in the
 * existing `RepeatKey` owner. There is no email-token table, consumed-token
 * history, or client-selected duration: these V1 expiries are code-owned and
 * written once to `RepeatKey.expiresAt` when the operation is created.
 */
export const NATIVE_AUTH_EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const NATIVE_AUTH_PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** 32 random bytes, base64url, unpadded. Never stored and never logged. */
export const NATIVE_AUTH_ONE_TIME_BEARER_BYTES = 32;
export const NativeAuthOneTimeBearerV1Schema = lazyZodSchema(() => z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/));

const NativeAuthOneTimePurposeSchema = lazyZodSchema(() => z.enum(['verify_native_email', 'reset_plain_password']));
export type NativeAuthOneTimePurpose = z.infer<typeof NativeAuthOneTimePurposeSchema>;

const KEY_NAMESPACE_BY_PURPOSE = {
    verify_native_email: 'auth_email_verify_v1',
    reset_plain_password: 'auth_password_reset_v1',
} as const satisfies Record<NativeAuthOneTimePurpose, string>;

const AccountIdSchema = lazyZodSchema(() => z.string().min(1).max(256));
const CredentialRevisionSchema = lazyZodSchema(() => z.number().int().min(1).max(2_147_483_647));
/** Opaque bounded reference into the existing server-scoped pending-auth owner. */
const ContinuationIdSchema = lazyZodSchema(() => z.string().min(1).max(256));
const TeamInvitationTokenHashSchema = lazyZodSchema(() => z.string().regex(/^[0-9a-f]{64}$/u));
const NormalizedEmailSchema = lazyZodSchema(() => z.string().max(VERIFIED_EMAIL_MAX_SCALARS).refine(
    (value) => normalizeVerifiedEmail(value)?.normalizedEmail === value,
));

export const NativeAuthOneTimeOperationV1Schema = lazyZodSchema(() => z.discriminatedUnion('purpose', [
    z.object({
        v: z.literal(1),
        purpose: z.literal('verify_native_email'),
        normalizedEmail: NormalizedEmailSchema,
        consumer: z.discriminatedUnion('kind', [
            z.object({
                kind: z.literal('fresh_account'),
                continuationId: ContinuationIdSchema.nullable(),
            }).strict(),
            z.object({
                kind: z.literal('team_invitation'),
                invitationId: AccountIdSchema,
                tokenHash: TeamInvitationTokenHashSchema,
                teamId: AccountIdSchema,
            }).strict(),
            z.object({
                kind: z.literal('password_enrollment'),
                accountId: AccountIdSchema,
            }).strict(),
            z.object({
                kind: z.literal('sign_in_email_change'),
                accountId: AccountIdSchema,
                nativeIdentityId: AccountIdSchema,
                expectedNativeIdentity: NormalizedEmailSchema,
            }).strict(),
        ]),
    }).strict(),
    z.object({
        v: z.literal(1),
        purpose: z.literal('reset_plain_password'),
        accountId: AccountIdSchema,
        credentialRevision: CredentialRevisionSchema,
        nativeIdentityId: AccountIdSchema,
        expectedNativeIdentity: NormalizedEmailSchema,
    }).strict(),
]));
export type NativeAuthOneTimeOperationV1 = z.infer<typeof NativeAuthOneTimeOperationV1Schema>;

export function encodeNativeAuthOneTimeOperationV1(value: NativeAuthOneTimeOperationV1): string {
    return JSON.stringify(NativeAuthOneTimeOperationV1Schema.parse(value));
}

export function decodeNativeAuthOneTimeOperationV1(raw: string): NativeAuthOneTimeOperationV1 | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    const result = NativeAuthOneTimeOperationV1Schema.safeParse(parsed);
    return result.success ? result.data : null;
}

/**
 * The `RepeatKey` key is a namespaced digest of the raw bearer, so possession
 * of storage never yields a usable link and one purpose can never address
 * another purpose's record.
 */
export function createNativeAuthOneTimeOperationKeyV1(
    purpose: NativeAuthOneTimePurpose,
    rawBearer: string,
): string {
    const digest = computeCanonicalDomainSeparatedDigest(
        'happier.native-auth.one-time-operation.v1',
        [purpose, NativeAuthOneTimeBearerV1Schema.parse(rawBearer)],
    );
    return `${KEY_NAMESPACE_BY_PURPOSE[purpose]}:${digest}`;
}

/**
 * Preview surfaces confirm which mailbox a link was sent to without disclosing
 * the whole address to whoever opened the link.
 */
export function maskEmailForNativeAuthPreview(input: string): string | null {
    const normalized = normalizeVerifiedEmail(input);
    if (!normalized) return null;
    const separator = normalized.normalizedEmail.lastIndexOf('@');
    const local = normalized.normalizedEmail.slice(0, separator);
    const domain = normalized.normalizedEmail.slice(separator + 1);
    const visible = Array.from(local).length > 1 ? Array.from(local)[0] : '';
    const hidden = '•'.repeat(Math.max(1, Array.from(local).length - (visible ? 1 : 0)));
    return `${visible}${hidden}@${domain}`;
}
