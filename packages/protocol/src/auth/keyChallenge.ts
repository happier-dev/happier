import { z } from 'zod';

import { encodeBase64 } from '../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { normalizeServerIdentityIdCapability } from '../features/payload/capabilities/serverIdentityCapabilities.js';

const ExpectedAccountIdSchema = z.string().trim().min(1).max(256);
const ChallengeIdSchema = z.string().trim().min(1).max(128);
const ChallengeNonceSchema = z.string().min(1).max(256);
const ChallengeInstantSchema = z.string().datetime({ offset: true });

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

const KeyChallengeV2AudienceOriginSchema = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .refine(
    (value) => canonicalizeKeyChallengeV2AudienceOrigin(value) === value,
    'origin must be a canonical HTTP(S) origin',
  );

const KeyChallengeV2ServerIdentityIdSchema = z.preprocess(
  normalizeServerIdentityIdCapability,
  z.string().optional(),
);

export const KeyChallengeV2AudienceSchema = z
  .object({
    origin: KeyChallengeV2AudienceOriginSchema,
    serverIdentityId: KeyChallengeV2ServerIdentityIdSchema,
  })
  .strict();
export type KeyChallengeV2Audience = z.infer<
  typeof KeyChallengeV2AudienceSchema
>;

export const KeyChallengeV2IssueRequestSchema = z
  .object({
    expectedAccountId: ExpectedAccountIdSchema.optional(),
  })
  .strict();
export type KeyChallengeV2IssueRequest = z.infer<
  typeof KeyChallengeV2IssueRequestSchema
>;

export const KeyChallengeV2IssueResponseSchema = z
  .object({
    challengeId: ChallengeIdSchema,
    nonce: ChallengeNonceSchema,
    issuedAt: ChallengeInstantSchema,
    expiresAt: ChallengeInstantSchema,
    audience: KeyChallengeV2AudienceSchema,
  })
  .strict();
export type KeyChallengeV2IssueResponse = z.infer<
  typeof KeyChallengeV2IssueResponseSchema
>;

const KeyChallengeV2SigningFactsSchema = KeyChallengeV2IssueResponseSchema.extend({
  expectedAccountId: ExpectedAccountIdSchema.optional(),
}).strict();

const KEY_CHALLENGE_SIGNING_DOMAIN_V2 = 'happier.key-challenge.v2';

export function createKeyChallengeV2SigningInput(
  params: Readonly<{
    challengeId: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
    audience: KeyChallengeV2Audience;
    expectedAccountId?: string;
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
    }),
  );
}

function validateContentKeyPair(
  value: Readonly<{
    contentPublicKey?: string;
    contentPublicKeySig?: string;
  }>,
  context: z.RefinementCtx,
): void {
  const hasContentKey = value.contentPublicKey !== undefined;
  const hasContentSignature = value.contentPublicKeySig !== undefined;
  if (hasContentKey !== hasContentSignature) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'contentPublicKey and contentPublicKeySig must be provided together',
    });
  }
}

export const KeyChallengeV1AuthRequestSchema = z
  .object({
    // The released route owns its legacy size/error semantics. Keep the old
    // fields wire-compatible here and let that boundary apply its existing
    // limits after parsing.
    publicKey: z.string(),
    challenge: z.string(),
    signature: z.string(),
    contentPublicKey: z.string().optional(),
    contentPublicKeySig: z.string().optional(),
    expectedAccountId: ExpectedAccountIdSchema.optional(),
  })
  .strict()
  .superRefine(validateContentKeyPair);
export type KeyChallengeV1AuthRequest = z.infer<
  typeof KeyChallengeV1AuthRequestSchema
>;

export const KeyChallengeV2AuthRequestSchema = z
  .object({
    challengeId: ChallengeIdSchema,
    publicKey: z.string(),
    signature: z.string(),
    contentPublicKey: z.string().optional(),
    contentPublicKeySig: z.string().optional(),
    expectedAccountId: ExpectedAccountIdSchema.optional(),
  })
  .strict()
  .superRefine(validateContentKeyPair);
export type KeyChallengeV2AuthRequest = z.infer<
  typeof KeyChallengeV2AuthRequestSchema
>;

export const KeyChallengeAuthRequestSchema = z.union([
  KeyChallengeV1AuthRequestSchema,
  KeyChallengeV2AuthRequestSchema,
]);
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
