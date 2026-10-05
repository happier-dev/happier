import { z } from 'zod';
import { TerminalPresentUserPolicySchema } from '../actions/invocationAuthority.js';

import { AccountExternalAuthProofV1Schema } from './accountExternalAuthProof.js';
import { normalizeVerifiedEmail, VERIFIED_EMAIL_MAX_SCALARS } from './verifiedEmail.js';
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

export const ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1 = '/v1/auth/password/mutation/challenge' as const;
export const NATIVE_AUTH_PASSWORD_RESET_SUBMIT_PATH_V1 = '/v1/auth/password/reset/submit' as const;
export const ACCOUNT_SECURITY_PATH_V1 = '/v1/account/security' as const;
export const ACCOUNT_TERMINAL_PRESENT_USER_POLICY_PATH_V1 = '/v1/account/security/terminal-present-user' as const;
export const AccountTerminalPresentUserPolicySetRequestV1Schema = z.object({ policy: TerminalPresentUserPolicySchema }).strict();
export type AccountTerminalPresentUserPolicySetRequestV1 = z.infer<typeof AccountTerminalPresentUserPolicySetRequestV1Schema>;
export const AccountTerminalPresentUserPolicySetResponseV1Schema = z.object({ policy: TerminalPresentUserPolicySchema }).strict();
export type AccountTerminalPresentUserPolicySetResponseV1 = z.infer<typeof AccountTerminalPresentUserPolicySetResponseV1Schema>;
export const ACCOUNT_PASSWORD_ENROLL_PATH_V1 = '/v1/account/password/enroll' as const;
export const ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1 = '/v1/account/password/enroll/email/request' as const;
export const ACCOUNT_PASSWORD_CHANGE_PATH_V1 = '/v1/account/password/change' as const;
export const ACCOUNT_PASSWORD_REMOVE_PATH_V1 = '/v1/account/password/remove' as const;
export const ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1 = '/v1/account/email/change/request' as const;
export const ACCOUNT_EMAIL_CHANGE_PATH_V1 = '/v1/account/email/change' as const;

const PasswordTextWireV1Schema = z.string()
  .max(PASSWORD_MAX_UTF8_BYTES_V1)
  .refine((value) => acceptPasswordTextV1(value).accepted, { message: 'invalid password text' });
const CredentialRevisionV1Schema = z.number().int().min(1).max(2_147_483_647);
const VerifiedEmailWireV1Schema = z.string().max(VERIFIED_EMAIL_MAX_SCALARS * 2).refine(
  (value) => normalizeVerifiedEmail(value) !== null,
  { message: 'invalid email address' },
);
const NormalizedEmailWireV1Schema = z.string().max(VERIFIED_EMAIL_MAX_SCALARS * 2).refine(
  (value) => normalizeVerifiedEmail(value)?.normalizedEmail === value,
  { message: 'email must already be normalized' },
);
const TransitionRequestDigestWireV1Schema = z.string().regex(/^aemrb1_[A-Za-z0-9_-]{43}$/);

export const AccountSecurityGetRequestV1Schema = z.object({}).strict();
/** Device-local historical custody; no caller-selected Account or credential material. */
export const AccountHistoricalEncryptionKeyForgetInputV1Schema = z.object({}).strict();
export const AccountHistoricalEncryptionKeyForgetResultV1Schema = z.object({
  status: z.enum(['forgotten', 'nothing_retained', 'cancelled']),
}).strict();
export type AccountHistoricalEncryptionKeyForgetResultV1 = z.infer<typeof AccountHistoricalEncryptionKeyForgetResultV1Schema>;
/** Client-custody recovery rewrites templates individually and never discards key material. */
export const AccountEncryptionAutomationTemplatesRecoverInputV1Schema = z.object({}).strict();
export const AccountEncryptionAutomationTemplatesRecoverResultV1Schema = z.object({
  templates: z.array(z.object({
    automationId: z.string().min(1),
    status: z.enum(['recovered', 'already_plain', 'retained_e2ee', 'locked', 'conflict']),
  }).strict()),
}).strict();
export type AccountEncryptionAutomationTemplatesRecoverResultV1 = z.infer<typeof AccountEncryptionAutomationTemplatesRecoverResultV1Schema>;
export const AccountSecurityGetResponseV1Schema = z.object({
  v: z.literal(1),
  encryptionMode: z.enum(['plain', 'e2ee']),
  terminalPresentUserPolicy: TerminalPresentUserPolicySchema,
  nativeEmail: z.string().nullable(),
  password: z.discriminatedUnion('status', [
    z.object({ status: z.literal('enrolled'), revision: CredentialRevisionV1Schema }).strict(),
    z.object({ status: z.literal('not_enrolled'), revision: z.null() }).strict(),
  ]),
}).strict();
export type AccountSecurityGetResponseV1 = z.infer<typeof AccountSecurityGetResponseV1Schema>;

export const AccountPasswordEnrollRequestV1Schema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('plain'),
    email: VerifiedEmailWireV1Schema,
    targetCredential: PlainAccountPasswordCredentialV1Schema,
    verificationToken: NativeAuthOneTimeBearerV1Schema.optional(),
    reauthentication: AccountExternalAuthProofV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('e2ee'),
    email: VerifiedEmailWireV1Schema,
    targetCredential: E2eeAccountPasswordCredentialV1Schema,
    verificationToken: NativeAuthOneTimeBearerV1Schema.optional(),
    proof: PasswordMutationChallengeProofV1Schema,
  }).strict(),
]);

export const AccountPasswordChangeRequestV1Schema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('plain'),
    expectedCredentialRevision: CredentialRevisionV1Schema,
    currentPassword: PasswordTextWireV1Schema,
    newPassword: PasswordTextWireV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('e2ee'),
    action: z.enum(['change', 'recover']),
    expectedCredentialRevision: CredentialRevisionV1Schema,
    targetCredential: E2eeAccountPasswordCredentialV1Schema,
    proof: PasswordMutationChallengeProofV1Schema,
  }).strict(),
]);

export const AccountPasswordRemoveRequestV1Schema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('plain'),
    expectedCredentialRevision: CredentialRevisionV1Schema,
    currentPassword: PasswordTextWireV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('e2ee'),
    expectedCredentialRevision: CredentialRevisionV1Schema,
    proof: PasswordMutationChallengeProofV1Schema,
  }).strict(),
]);

export const AccountEmailChangeRequestV1Schema = z.object({
  v: z.literal(1),
  email: VerifiedEmailWireV1Schema,
}).strict();

export const AccountPasswordEnrollEmailRequestV1Schema = z.object({
  v: z.literal(1),
  email: VerifiedEmailWireV1Schema,
}).strict();

export const AccountEmailChangeCompleteRequestV1Schema = z.object({
  v: z.literal(1),
  verificationToken: NativeAuthOneTimeBearerV1Schema,
}).strict();

export const PlainPasswordResetSubmitRequestV1Schema = z.object({
  v: z.literal(1),
  token: NativeAuthOneTimeBearerV1Schema,
  password: PasswordTextWireV1Schema,
}).strict();

export const PlainPasswordResetSubmitResponseV1Schema = z.object({
  v: z.literal(1),
  status: z.literal('password_reset'),
}).strict();

export const PasswordMutationPreparationRequestV1Schema = z.union([
  z.object({
    v: z.literal(1),
    action: z.literal('remove'),
    expectedCredentialRevision: CredentialRevisionV1Schema,
    normalizedNativeEmail: NormalizedEmailWireV1Schema.nullable(),
  }).strict(),
  z.object({
    v: z.literal(1),
    action: z.enum(['connect', 'change', 'recover']),
    expectedCredentialRevision: CredentialRevisionV1Schema.nullable(),
    normalizedNativeEmail: NormalizedEmailWireV1Schema.nullable(),
    newPlainPassword: PasswordTextWireV1Schema,
    transitionRequestDigest: TransitionRequestDigestWireV1Schema.optional(),
  }).strict(),
  z.object({
    v: z.literal(1),
    action: z.enum(['connect', 'change', 'recover']),
    expectedCredentialRevision: CredentialRevisionV1Schema.nullable(),
    normalizedNativeEmail: NormalizedEmailWireV1Schema.nullable(),
    newE2eePassword: z.object({
      envelope: E2eeAccountPasswordCredentialV1Schema.shape.envelope,
      authKey: z.string().length(43),
    }).strict(),
    transitionRequestDigest: TransitionRequestDigestWireV1Schema.optional(),
  }).strict(),
]);

export const PasswordMutationPreparationResponseV1Schema = z.union([
  z.object({
    targetCredential: AccountPasswordCredentialV1Schema,
    challenge: PasswordMutationChallengeV1Schema.optional(),
  }).strict(),
  z.object({ challenge: PasswordMutationChallengeV1Schema }).strict(),
]);

export const AccountPasswordMutationResponseV1Schema = z.object({
  v: z.literal(1),
  status: z.enum(['enrolled', 'updated', 'removed']),
}).strict();

export const AccountEmailChangeRequestResponseV1Schema = z.object({
  v: z.literal(1),
  status: z.literal('verification_sent'),
}).strict();

export const AccountSecurityServerErrorV1Schema = z.object({
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
}).strict();

/**
 * Complete strict error surface for the authenticated route boundary. The
 * provider-qualified arm is emitted by canonical login eligibility before an
 * Account Security handler runs; keeping it here prevents route-local loose
 * objects while preserving that provider recovery hint.
 */
export const AccountSecurityRouteErrorV1Schema = z.union([
  AccountSecurityServerErrorV1Schema,
  z.object({ error: z.enum(['invalid_token', 'not-eligible', 'upstream_error']) }).strict(),
  z.object({ error: z.literal('provider-required'), provider: z.string().min(1) }).strict(),
]);

export type AccountPasswordEnrollRequestV1 = z.infer<typeof AccountPasswordEnrollRequestV1Schema>;
export type AccountPasswordEnrollEmailRequestV1 = z.infer<typeof AccountPasswordEnrollEmailRequestV1Schema>;
export type AccountPasswordChangeRequestV1 = z.infer<typeof AccountPasswordChangeRequestV1Schema>;
export type AccountPasswordRemoveRequestV1 = z.infer<typeof AccountPasswordRemoveRequestV1Schema>;
export type PasswordMutationPreparationRequestV1 = z.infer<typeof PasswordMutationPreparationRequestV1Schema>;
export type AccountEmailChangeRequestV1 = z.infer<typeof AccountEmailChangeRequestV1Schema>;
export type AccountEmailChangeRequestResponseV1 = z.infer<typeof AccountEmailChangeRequestResponseV1Schema>;
export type AccountPasswordMutationResponseV1 = z.infer<typeof AccountPasswordMutationResponseV1Schema>;
export type AccountSecurityRouteErrorV1 = z.infer<typeof AccountSecurityRouteErrorV1Schema>;
