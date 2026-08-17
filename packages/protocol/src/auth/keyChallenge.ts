import { z } from 'zod';

import { encodeBase64 } from '../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';

const ExpectedAccountIdSchema = z.string().trim().min(1).max(256);

export const KeyChallengeAuthRequestSchema = z
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
  .superRefine((value, context) => {
    const hasContentKey = value.contentPublicKey !== undefined;
    const hasContentSignature = value.contentPublicKeySig !== undefined;
    if (hasContentKey !== hasContentSignature) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'contentPublicKey and contentPublicKeySig must be provided together',
      });
    }
  });
export type KeyChallengeAuthRequest = z.infer<
  typeof KeyChallengeAuthRequestSchema
>;

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
