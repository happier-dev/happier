import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { SERVER_IDENTITY_ID_PATTERN } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import { KeyChallengeV2AudienceSchema, KeyChallengeV2IssueResponseSchema } from './keyChallenge.js';
import { normalizeVerifiedEmail, VERIFIED_EMAIL_MAX_SCALARS } from './verifiedEmail.js';
import {
  AccountPasswordCredentialV1Schema,
  type AccountPasswordCredentialV1,
} from './accountPasswordCredential.js';

export const PASSWORD_CREDENTIAL_MUTATION_OPERATION_V1 = 'password_credential_mutation_v1' as const;
export const PasswordCredentialMutationDigestV1Schema = lazyZodSchema(() => z.string().length(43).refine((value) =>
  encodeBase64(decodeBase64(value, 'base64url'), 'base64url') === value,
));
const AccountIdSchema = lazyZodSchema(() => z.string().min(1).max(256));

// All objects at this authority-bearing V1 boundary are closed. These schemas
// are a new operation and do not extend the incumbent login wire or its bytes.
export const PasswordCredentialMutationV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  action: z.enum(['connect', 'change', 'remove', 'recover']),
  accountId: AccountIdSchema,
  expectedCredentialRevision: z.number().int().min(1).max(2_147_483_647).nullable(),
  normalizedNativeEmail: z.string().max(VERIFIED_EMAIL_MAX_SCALARS * 2).refine((value) =>
    normalizeVerifiedEmail(value)?.normalizedEmail === value,
  ).nullable(),
  newCredentialDigest: PasswordCredentialMutationDigestV1Schema.nullable(),
}).strict());
export type PasswordCredentialMutationV1 = z.infer<typeof PasswordCredentialMutationV1Schema>;

export function createPasswordCredentialMutationDigestV1(value: PasswordCredentialMutationV1): string {
  return computeCanonicalDomainSeparatedDigest('happier.password-credential-mutation.request.v1', [
    createCanonicalJsonSigningInput(PasswordCredentialMutationV1Schema.parse(value)),
  ]);
}

/**
 * The digest a mutation proof carries for the credential it authorizes.
 *
 * Issuer and consumer must compute identical bytes or the proof simply will not
 * verify, so this is deliberately one exported function rather than a formula
 * each route repeats. `transitionRequestDigest` binds the credential to one
 * exact Account encryption-mode transition when the mutation is part of one;
 * an ordinary Account Security mutation passes null.
 */
export function createPasswordCredentialTargetDigestV1(
  targetCredential: AccountPasswordCredentialV1,
  transitionRequestDigest: string | null = null,
): string {
  return computeCanonicalDomainSeparatedDigest('happier.account-encryption-password-target.v1', [
    createCanonicalJsonSigningInput({
      transitionRequestDigest,
      targetCredential: AccountPasswordCredentialV1Schema.parse(targetCredential),
    }),
  ]);
}

export const PasswordMutationChallengeIssueRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  mutation: PasswordCredentialMutationV1Schema,
}).strict());

export const PasswordMutationChallengeV1Schema = lazyZodSchema(() => KeyChallengeV2IssueResponseSchema.extend({
  v: z.literal(1),
  audience: KeyChallengeV2AudienceSchema.extend({
    serverIdentityId: z.string().regex(SERVER_IDENTITY_ID_PATTERN),
  }).strict(),
  expectedAccountId: AccountIdSchema,
  operationKind: z.literal(PASSWORD_CREDENTIAL_MUTATION_OPERATION_V1),
  operationDigest: PasswordCredentialMutationDigestV1Schema,
}).strict());
export type PasswordMutationChallengeV1 = z.infer<typeof PasswordMutationChallengeV1Schema>;

export const PasswordMutationChallengeProofV1Schema = lazyZodSchema(() => z.object({
  challengeId: KeyChallengeV2IssueResponseSchema.shape.challengeId,
  publicKey: z.string().max(512),
  signature: z.string().max(4096),
}).strict());
export type PasswordMutationChallengeProofV1 = z.infer<typeof PasswordMutationChallengeProofV1Schema>;

export function createPasswordMutationChallengeSigningInputV1(value: PasswordMutationChallengeV1): Uint8Array {
  const facts = PasswordMutationChallengeV1Schema.parse(value);
  return new TextEncoder().encode(createCanonicalJsonSigningInput({
    domain: 'happier.password-credential-mutation.v1',
    ...facts,
  }));
}
