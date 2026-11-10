import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { encodeBase64 } from '../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { normalizeServerIdentityIdCapability } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import { TeamInvitationAccountAdmissionV1Schema } from './accountAdmission.js';

const ExpectedAccountIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const ChallengeIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(128)));
const ChallengeNonceSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(256)));
const ChallengeInstantSchema = lazyZodSchema(() => z.string().check(z.iso.datetime({ offset: true })));

export function canonicalizeKeyChallengeV2AudienceOrigin(
  value: unknown,
): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

const KeyChallengeV2AudienceOriginSchema = lazyZodSchema(() => z
  .string().check(z.trim(), z.minLength(1), z.maxLength(191), z.refine((value) => canonicalizeKeyChallengeV2AudienceOrigin(value) === value, 'origin must be a canonical HTTP(S) origin')));

const KeyChallengeV2ServerIdentityIdSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeServerIdentityIdCapability), z.optional(z.string())));

export const KeyChallengeV2AudienceSchema = lazyZodSchema(() => z.strictObject({
    origin: KeyChallengeV2AudienceOriginSchema,
    serverIdentityId: KeyChallengeV2ServerIdentityIdSchema,
  }));
export type KeyChallengeV2Audience = z.infer<
  typeof KeyChallengeV2AudienceSchema
>;

export const KeyChallengeV2IssueRequestSchema = lazyZodSchema(() => z.strictObject({
    expectedAccountId: z.optional(ExpectedAccountIdSchema),
  }));
export type KeyChallengeV2IssueRequest = z.infer<
  typeof KeyChallengeV2IssueRequestSchema
>;

export const KeyChallengeV2IssueResponseSchema = lazyZodSchema(() => z.strictObject({
    challengeId: ChallengeIdSchema,
    nonce: ChallengeNonceSchema,
    issuedAt: ChallengeInstantSchema,
    expiresAt: ChallengeInstantSchema,
    audience: KeyChallengeV2AudienceSchema,
  }));
export type KeyChallengeV2IssueResponse = z.infer<
  typeof KeyChallengeV2IssueResponseSchema
>;

const KeyChallengeV2SigningFactsSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(KeyChallengeV2IssueResponseSchema, {
  expectedAccountId: z.optional(ExpectedAccountIdSchema),
  requireExistingAccount: z.optional(z.literal(true)),
})));

const KEY_CHALLENGE_SIGNING_DOMAIN_V2 = 'happier.key-challenge.v2';

export function createKeyChallengeV2SigningInput(
  params: Readonly<{
    challengeId: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
    audience: KeyChallengeV2Audience;
    expectedAccountId?: string;
    requireExistingAccount?: true;
  }>,
): Uint8Array {
  const facts = KeyChallengeV2SigningFactsSchema.parse(params);
  return new TextEncoder().encode(
    createCanonicalJsonSigningInput({
      domain: KEY_CHALLENGE_SIGNING_DOMAIN_V2,
      challengeId: facts.challengeId,
      nonce: facts.nonce,
      issuedAt: facts.issuedAt,
      expiresAt: facts.expiresAt,
      audience: facts.audience,
      ...(facts.expectedAccountId
        ? { expectedAccountId: facts.expectedAccountId }
        : {}),
      ...(facts.requireExistingAccount
        ? { requireExistingAccount: true }
        : {}),
    }),
  );
}

function validateContentKeyPair(
  value: Readonly<{
    contentPublicKey?: string;
    contentPublicKeySig?: string;
  }>,
  context: z.core.$RefinementCtx,
): void {
  const hasContentKey = value.contentPublicKey !== undefined;
  const hasContentSignature = value.contentPublicKeySig !== undefined;
  if (hasContentKey !== hasContentSignature) {
    context.addIssue({
      code: "custom",
      message:
        'contentPublicKey and contentPublicKeySig must be provided together',
    });
  }
}

export const KeyChallengeV1AuthRequestSchema = lazyZodSchema(() => z.strictObject({
    // The released route owns its legacy size/error semantics. Keep the old
    // fields wire-compatible here and let that boundary apply its existing
    // limits after parsing.
    publicKey: z.string(),
    challenge: z.string(),
    signature: z.string(),
    contentPublicKey: z.optional(z.string()),
    contentPublicKeySig: z.optional(z.string()),
    expectedAccountId: z.optional(ExpectedAccountIdSchema),
    admission: z.optional(TeamInvitationAccountAdmissionV1Schema),
  }).check(z.superRefine(validateContentKeyPair)));
export type KeyChallengeV1AuthRequest = z.infer<
  typeof KeyChallengeV1AuthRequestSchema
>;

export const KeyChallengeV2AuthRequestSchema = lazyZodSchema(() => z.strictObject({
    challengeId: ChallengeIdSchema,
    publicKey: z.string(),
    signature: z.string(),
    contentPublicKey: z.optional(z.string()),
    contentPublicKeySig: z.optional(z.string()),
    expectedAccountId: z.optional(ExpectedAccountIdSchema),
    admission: z.optional(TeamInvitationAccountAdmissionV1Schema),
    requireExistingAccount: z.optional(z.literal(true)),
    /** Narrows a Home login to a terminal credential; never widens authority. */
    credentialKind: z.optional(z.literal('terminal')),
  }).check(z.superRefine(validateContentKeyPair)));
export type KeyChallengeV2AuthRequest = z.infer<
  typeof KeyChallengeV2AuthRequestSchema
>;

export const KeyChallengeAuthRequestSchema = lazyZodSchema(() => z.union([
  KeyChallengeV1AuthRequestSchema,
  KeyChallengeV2AuthRequestSchema,
]));
export type KeyChallengeAuthRequest = z.infer<
  typeof KeyChallengeAuthRequestSchema
>;

export function isKeyChallengeV2AuthRequest(
  request: KeyChallengeAuthRequest,
): request is KeyChallengeV2AuthRequest {
  return 'challengeId' in request;
}

const EXPECTED_ACCOUNT_KEY_CHALLENGE_SIGNING_DOMAIN_V1 =
  'happier.key-challenge.expected-account.v1';

export function createExpectedAccountKeyChallengeSigningInputV1(
  params: Readonly<{
    challenge: Uint8Array;
    expectedAccountId: string;
  }>,
): Uint8Array {
  const expectedAccountId = ExpectedAccountIdSchema.parse(
    params.expectedAccountId,
  );
  return new TextEncoder().encode(
    createCanonicalJsonSigningInput({
      domain: EXPECTED_ACCOUNT_KEY_CHALLENGE_SIGNING_DOMAIN_V1,
      challenge: encodeBase64(params.challenge, 'base64url'),
      expectedAccountId,
    }),
  );
}
