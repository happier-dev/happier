import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { AccountExternalAuthProofV1Schema } from './accountExternalAuthProof.js';
import {
  normalizeVerifiedEmail,
  VERIFIED_EMAIL_MAX_SCALARS,
} from './verifiedEmail.js';
import {
  acceptPasswordTextV1,
  AccountPasswordCredentialV1Schema,
  E2eeAccountPasswordCredentialV1Schema,
  PlainAccountPasswordCredentialV1Schema,
  PASSWORD_MAX_UTF8_BYTES_V1,
} from './accountPasswordCredential.js';
import {
  PasswordMutationChallengeProofV1Schema,
  PasswordMutationChallengeV1Schema,
} from './passwordMutationChallenge.js';
import { NativeAuthOneTimeBearerV1Schema } from './nativeAuthOneTimeOperation.js';

export const ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1 =
  '/v1/auth/password/mutation/challenge' as const;
export const NATIVE_AUTH_PASSWORD_RESET_SUBMIT_PATH_V1 =
  '/v1/auth/password/reset/submit' as const;
export const ACCOUNT_SECURITY_PATH_V1 = '/v1/account/security' as const;
export const ACCOUNT_PASSWORD_ENROLL_PATH_V1 =
  '/v1/account/password/enroll' as const;
export const ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1 =
  '/v1/account/password/enroll/email/request' as const;
export const ACCOUNT_PASSWORD_CHANGE_PATH_V1 =
  '/v1/account/password/change' as const;
export const ACCOUNT_PASSWORD_REMOVE_PATH_V1 =
  '/v1/account/password/remove' as const;
export const ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1 =
  '/v1/account/email/change/request' as const;
export const ACCOUNT_EMAIL_CHANGE_PATH_V1 = '/v1/account/email/change' as const;

const PasswordTextWireV1Schema = lazyZodSchema(() =>
  z.string().check(
    z.maxLength(PASSWORD_MAX_UTF8_BYTES_V1),
    z.refine((value) => acceptPasswordTextV1(value).accepted, {
      message: 'invalid password text',
    }),
  ),
);
const CredentialRevisionV1Schema = lazyZodSchema(() =>
  z.number().check(z.int(), z.minimum(1), z.maximum(2_147_483_647)),
);
const VerifiedEmailWireV1Schema = lazyZodSchema(() =>
  z.string().check(
    z.maxLength(VERIFIED_EMAIL_MAX_SCALARS * 2),
    z.refine((value) => normalizeVerifiedEmail(value) !== null, {
      message: 'invalid email address',
    }),
  ),
);
const NormalizedEmailWireV1Schema = lazyZodSchema(() =>
  z.string().check(
    z.maxLength(VERIFIED_EMAIL_MAX_SCALARS * 2),
    z.refine(
      (value) => normalizeVerifiedEmail(value)?.normalizedEmail === value,
      { message: 'email must already be normalized' },
    ),
  ),
);
const TransitionRequestDigestWireV1Schema = lazyZodSchema(() =>
  z.string().check(z.regex(/^aemrb1_[A-Za-z0-9_-]{43}$/)),
);

export const AccountSecurityGetRequestV1Schema = lazyZodSchema(() =>
  z.strictObject({}),
);
/** Device-local historical custody; no caller-selected Account or credential material. */
export const AccountHistoricalEncryptionKeyForgetInputV1Schema = lazyZodSchema(
  () => z.strictObject({}),
);
export const AccountHistoricalEncryptionKeyForgetResultV1Schema = lazyZodSchema(
  () =>
    z.strictObject({
      status: z.enum(['forgotten', 'nothing_retained', 'cancelled']),
    }),
);
export type AccountHistoricalEncryptionKeyForgetResultV1 = z.infer<
  typeof AccountHistoricalEncryptionKeyForgetResultV1Schema
>;
/** Client-custody recovery rewrites templates individually and never discards key material. */
export const AccountEncryptionAutomationTemplatesRecoverInputV1Schema =
  lazyZodSchema(() => z.strictObject({}));
export const AccountEncryptionAutomationTemplatesRecoverResultV1Schema =
  lazyZodSchema(() =>
    z.strictObject({
      templates: z.array(
        z.strictObject({
          automationId: z.string().check(z.minLength(1)),
          status: z.enum([
            'recovered',
            'already_plain',
            'retained_e2ee',
            'locked',
            'conflict',
          ]),
        }),
      ),
    }),
  );
export type AccountEncryptionAutomationTemplatesRecoverResultV1 = z.infer<
  typeof AccountEncryptionAutomationTemplatesRecoverResultV1Schema
>;
export const AccountSecurityGetResponseV1Schema = lazyZodSchema(() =>
  z.strictObject({
    v: z.literal(1),
    encryptionMode: z.enum(['plain', 'e2ee']),
    nativeEmail: z.nullable(z.string()),
    password: z.discriminatedUnion('status', [
      z.strictObject({
        status: z.literal('enrolled'),
        revision: CredentialRevisionV1Schema,
      }),
      z.strictObject({ status: z.literal('not_enrolled'), revision: z.null() }),
    ]),
  }),
);
export type AccountSecurityGetResponseV1 = z.infer<
  typeof AccountSecurityGetResponseV1Schema
>;

export const AccountPasswordEnrollRequestV1Schema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      v: z.literal(1),
      kind: z.literal('plain'),
      email: VerifiedEmailWireV1Schema,
      targetCredential: PlainAccountPasswordCredentialV1Schema,
      verificationToken: z.optional(NativeAuthOneTimeBearerV1Schema),
      reauthentication: AccountExternalAuthProofV1Schema,
    }),
    z.strictObject({
      v: z.literal(1),
      kind: z.literal('e2ee'),
      email: VerifiedEmailWireV1Schema,
      targetCredential: E2eeAccountPasswordCredentialV1Schema,
      verificationToken: z.optional(NativeAuthOneTimeBearerV1Schema),
      proof: PasswordMutationChallengeProofV1Schema,
    }),
  ]),
);

export const AccountPasswordChangeRequestV1Schema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      v: z.literal(1),
      kind: z.literal('plain'),
      expectedCredentialRevision: CredentialRevisionV1Schema,
      currentPassword: PasswordTextWireV1Schema,
      newPassword: PasswordTextWireV1Schema,
    }),
    z.strictObject({
      v: z.literal(1),
      kind: z.literal('e2ee'),
      action: z.enum(['change', 'recover']),
      expectedCredentialRevision: CredentialRevisionV1Schema,
      targetCredential: E2eeAccountPasswordCredentialV1Schema,
      proof: PasswordMutationChallengeProofV1Schema,
    }),
  ]),
);

export const AccountPasswordRemoveRequestV1Schema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      v: z.literal(1),
      kind: z.literal('plain'),
      expectedCredentialRevision: CredentialRevisionV1Schema,
      currentPassword: PasswordTextWireV1Schema,
    }),
    z.strictObject({
      v: z.literal(1),
      kind: z.literal('e2ee'),
      expectedCredentialRevision: CredentialRevisionV1Schema,
      proof: PasswordMutationChallengeProofV1Schema,
    }),
  ]),
);

export const AccountEmailChangeRequestV1Schema = lazyZodSchema(() =>
  z.strictObject({
    v: z.literal(1),
    email: VerifiedEmailWireV1Schema,
  }),
);

export const AccountPasswordEnrollEmailRequestV1Schema = lazyZodSchema(() =>
  z.strictObject({
    v: z.literal(1),
    email: VerifiedEmailWireV1Schema,
  }),
);

export const AccountEmailChangeCompleteRequestV1Schema = lazyZodSchema(() =>
  z.strictObject({
    v: z.literal(1),
    verificationToken: NativeAuthOneTimeBearerV1Schema,
  }),
);

export const PlainPasswordResetSubmitRequestV1Schema = lazyZodSchema(() =>
  z.strictObject({
    v: z.literal(1),
    token: NativeAuthOneTimeBearerV1Schema,
    password: PasswordTextWireV1Schema,
  }),
);

export const PlainPasswordResetSubmitResponseV1Schema = lazyZodSchema(() =>
  z.strictObject({
    v: z.literal(1),
    status: z.literal('password_reset'),
  }),
);

export const PasswordMutationPreparationRequestV1Schema = lazyZodSchema(() =>
  z.union([
    z.strictObject({
      v: z.literal(1),
      action: z.literal('remove'),
      expectedCredentialRevision: CredentialRevisionV1Schema,
      normalizedNativeEmail: z.nullable(NormalizedEmailWireV1Schema),
    }),
    z.strictObject({
      v: z.literal(1),
      action: z.enum(['connect', 'change', 'recover']),
      expectedCredentialRevision: z.nullable(CredentialRevisionV1Schema),
      normalizedNativeEmail: z.nullable(NormalizedEmailWireV1Schema),
      newPlainPassword: PasswordTextWireV1Schema,
      transitionRequestDigest: z.optional(TransitionRequestDigestWireV1Schema),
    }),
    z.strictObject({
      v: z.literal(1),
      action: z.enum(['connect', 'change', 'recover']),
      expectedCredentialRevision: z.nullable(CredentialRevisionV1Schema),
      normalizedNativeEmail: z.nullable(NormalizedEmailWireV1Schema),
      newE2eePassword: z.strictObject({
        envelope: E2eeAccountPasswordCredentialV1Schema.shape.envelope,
        authKey: z.string().check(z.length(43)),
      }),
      transitionRequestDigest: z.optional(TransitionRequestDigestWireV1Schema),
    }),
  ]),
);

export const PasswordMutationPreparationResponseV1Schema = lazyZodSchema(() =>
  z.union([
    z.strictObject({
      targetCredential: AccountPasswordCredentialV1Schema,
      challenge: z.optional(PasswordMutationChallengeV1Schema),
    }),
    z.strictObject({ challenge: PasswordMutationChallengeV1Schema }),
  ]),
);

export const AccountPasswordMutationResponseV1Schema = lazyZodSchema(() =>
  z.strictObject({
    v: z.literal(1),
    status: z.enum(['enrolled', 'updated', 'removed']),
  }),
);

export const AccountEmailChangeRequestResponseV1Schema = lazyZodSchema(() =>
  z.strictObject({
    v: z.literal(1),
    status: z.literal('verification_sent'),
  }),
);

export const AccountSecurityServerErrorV1Schema = lazyZodSchema(() =>
  z.strictObject({
    error: z.enum([
      'invalid_request',
      'authentication_failed',
      'credential_revision_conflict',
      'credential_inconsistent',
      'last_login_method',
      'challenge_unavailable',
      'verification_invalid',
      'identity_changed',
      'reauthentication_required',
      'conflict',
      'unavailable',
      'email_delivery_unavailable',
      'password_hash_overloaded',
      'not_found',
      'present_user_required',
      'method_not_available',
      'invalid_reset',
      'account-disabled',
    ]),
  }),
);

/**
 * Complete strict error surface for the authenticated route boundary. The
 * provider-qualified arm is emitted by canonical login eligibility before an
 * Account Security handler runs; keeping it here prevents route-local loose
 * objects while preserving that provider recovery hint.
 */
export const AccountSecurityRouteErrorV1Schema = lazyZodSchema(() =>
  z.union([
    AccountSecurityServerErrorV1Schema,
    z.strictObject({
      error: z.enum(['invalid_token', 'not-eligible', 'upstream_error']),
    }),
    z.strictObject({
      error: z.literal('provider-required'),
      provider: z.string().check(z.minLength(1)),
    }),
  ]),
);

export type AccountPasswordEnrollRequestV1 = z.infer<
  typeof AccountPasswordEnrollRequestV1Schema
>;
export type AccountPasswordEnrollEmailRequestV1 = z.infer<
  typeof AccountPasswordEnrollEmailRequestV1Schema
>;
export type AccountPasswordChangeRequestV1 = z.infer<
  typeof AccountPasswordChangeRequestV1Schema
>;
export type AccountPasswordRemoveRequestV1 = z.infer<
  typeof AccountPasswordRemoveRequestV1Schema
>;
export type PasswordMutationPreparationRequestV1 = z.infer<
  typeof PasswordMutationPreparationRequestV1Schema
>;
export type AccountEmailChangeRequestV1 = z.infer<
  typeof AccountEmailChangeRequestV1Schema
>;
export type AccountEmailChangeRequestResponseV1 = z.infer<
  typeof AccountEmailChangeRequestResponseV1Schema
>;
export type AccountPasswordMutationResponseV1 = z.infer<
  typeof AccountPasswordMutationResponseV1Schema
>;
export type AccountSecurityRouteErrorV1 = z.infer<
  typeof AccountSecurityRouteErrorV1Schema
>;
