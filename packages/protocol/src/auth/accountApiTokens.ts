import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ApiTokenGrantV1Schema } from './apiTokenGrant.js';
import { EmbedConfigV1Schema } from '../embed/embedConfigV1.js';
import { decodeBase64, encodeBase64, type Base64Variant } from '../crypto/base64.js';
import { SERVER_IDENTITY_ID_PATTERN } from '../features/payload/capabilities/serverIdentityCapabilities.js';

const AccountApiTokenIdV1Schema = lazyZodSchema(() => z.string().uuid());
const AccountApiTokenInstantV1Schema = lazyZodSchema(() => z.string().datetime({ offset: true }).max(64));
const AccountApiTokenDisplayPrefixV1Schema = lazyZodSchema(() => z.string().regex(/^hap_v1_[0-9a-f]{8}$/u));
const ACCOUNT_API_TOKEN_BEARER_V1_PATTERN =
  /^hap_v1_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/u;
export const AccountApiTokenBearerV1Schema = lazyZodSchema(() => z.string().regex(
  ACCOUNT_API_TOKEN_BEARER_V1_PATTERN,
));

export type ParsedAccountApiTokenBearerV1 = Readonly<{
  tokenId: string;
  secret: string;
}>;

/** The sole parser for the exact bearer shape minted by the Account server. */
export function parseAccountApiTokenBearerV1(
  token: string,
): ParsedAccountApiTokenBearerV1 | null {
  const match = ACCOUNT_API_TOKEN_BEARER_V1_PATTERN.exec(token);
  const tokenId = match?.[1];
  const secret = match?.[2];
  return tokenId && secret ? { tokenId, secret } : null;
}

function canonicalBytes(length: number, variant: Base64Variant) {
  const encodedLength = variant === 'base64' ? Math.ceil(length / 3) * 4 : Math.ceil(length * 4 / 3);
  return z.string().length(encodedLength).refine((value) => {
    const bytes = decodeBase64(value, variant);
    return bytes.length === length && encodeBase64(bytes, variant) === value;
  });
}

const ApiTokenHomeIdentitySchema = lazyZodSchema(() => z.string().regex(SERVER_IDENTITY_ID_PATTERN));
const ApiTokenContentPublicKeySchema = canonicalBytes(32, 'base64');
const ApiTokenUuidV4Schema = lazyZodSchema(() => z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u));

/** Opaque sealed content material. No recovery, content or wrapping secret is transported. */
export const AccountApiTokenEncryptionAccessV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  serverIdentityId: ApiTokenHomeIdentitySchema,
  contentPublicKey: ApiTokenContentPublicKeySchema,
  wrappedContentPrivateKey: canonicalBytes(72, 'base64url'),
}).strict());
export type AccountApiTokenEncryptionAccessV1 = z.infer<typeof AccountApiTokenEncryptionAccessV1Schema>;

export const AccountApiTokenCreateEncryptionV1Schema = lazyZodSchema(() => z.object({
  access: AccountApiTokenEncryptionAccessV1Schema,
}).strict());
export type AccountApiTokenCreateEncryptionV1 = z.infer<typeof AccountApiTokenCreateEncryptionV1Schema>;

/** A non-secret, Account-scoped token projection suitable for Settings lists. */
export const AccountApiTokenSummaryV1Schema = lazyZodSchema(() => z.object({
  tokenId: AccountApiTokenIdV1Schema,
  label: z.string().trim().min(1).max(256),
  displayPrefix: AccountApiTokenDisplayPrefixV1Schema,
  createdAt: AccountApiTokenInstantV1Schema,
  lastUsedAt: AccountApiTokenInstantV1Schema.nullable(),
  expiresAt: AccountApiTokenInstantV1Schema.nullable(),
  hasEncryptionAccess: z.boolean(),
  hasUnattendedTeamAccess: z.boolean(),
  grant: ApiTokenGrantV1Schema,
  parentTokenId: AccountApiTokenIdV1Schema.nullable(),
  activeChildCount: z.number().int().nonnegative(),
  embedConfig: EmbedConfigV1Schema.nullable(),
}).strict());
export type AccountApiTokenSummaryV1 = z.infer<typeof AccountApiTokenSummaryV1Schema>;

/** The Account is derived from verified credential provenance, never this input. */
export const AccountApiTokensCreateActionInputV1Schema = lazyZodSchema(() => z.object({
  tokenId: ApiTokenUuidV4Schema,
  label: z.string().trim().min(1).max(256),
  expiresAt: AccountApiTokenInstantV1Schema.nullable().optional(),
  encryption: AccountApiTokenCreateEncryptionV1Schema.optional(),
  authorizeUnattendedTeamAccess: z.boolean().optional(),
  grant: ApiTokenGrantV1Schema.optional(),
  embedConfig: EmbedConfigV1Schema.optional(),
}).strict());
export type AccountApiTokensCreateActionInputV1 = z.infer<typeof AccountApiTokensCreateActionInputV1Schema>;

export const AccountApiTokensUpdateActionInputV1Schema = lazyZodSchema(() => z.object({
  tokenId: AccountApiTokenIdV1Schema,
  label: z.string().trim().min(1).max(256).optional(),
  grant: ApiTokenGrantV1Schema.optional(),
  embedConfig: EmbedConfigV1Schema.nullable().optional(),
}).strict().refine((value) => value.label !== undefined || value.grant !== undefined || value.embedConfig !== undefined, 'An update must contain at least one change.'));
export type AccountApiTokensUpdateActionInputV1 = z.infer<typeof AccountApiTokensUpdateActionInputV1Schema>;
export const AccountApiTokensUpdateActionOutputV1Schema = lazyZodSchema(() => z.object({ apiToken: AccountApiTokenSummaryV1Schema }).strict());
export type AccountApiTokensUpdateActionOutputV1 = z.infer<typeof AccountApiTokensUpdateActionOutputV1Schema>;

export const AccountApiTokenChildCreateRequestV1Schema = lazyZodSchema(() => z.object({
  tokenId: ApiTokenUuidV4Schema,
  label: z.string().trim().min(1).max(256),
  expiresAt: AccountApiTokenInstantV1Schema,
  grant: ApiTokenGrantV1Schema,
  requireCreatedByChildTokenId: AccountApiTokenIdV1Schema.optional(),
}).strict());
export type AccountApiTokenChildCreateRequestV1 = z.infer<typeof AccountApiTokenChildCreateRequestV1Schema>;
export const AccountApiTokenChildRevokeRequestV1Schema = lazyZodSchema(() => z.object({ tokenId: AccountApiTokenIdV1Schema }).strict());
export type AccountApiTokenChildRevokeRequestV1 = z.infer<typeof AccountApiTokenChildRevokeRequestV1Schema>;
export const AccountApiTokenSelfV1Schema = lazyZodSchema(() => z.object({
  accountId: z.string().min(1),
  accountEncryptionMode: z.enum(['plain', 'e2ee']),
  credentialId: AccountApiTokenIdV1Schema,
  parentTokenId: AccountApiTokenIdV1Schema.nullable(),
  expiresAt: AccountApiTokenInstantV1Schema.nullable(),
  grant: ApiTokenGrantV1Schema,
  embedConfig: EmbedConfigV1Schema.nullable(),
}).strict());
export type AccountApiTokenSelfV1 = z.infer<typeof AccountApiTokenSelfV1Schema>;

/**
 * `token` is the sole plaintext bearer disclosure. The strict nested summary
 * intentionally makes later read/revoke results unable to carry a secret.
 */
export const AccountApiTokensCreateActionOutputV1Schema = lazyZodSchema(() => z.object({
  token: AccountApiTokenBearerV1Schema,
  apiToken: AccountApiTokenSummaryV1Schema,
}).strict().superRefine((value, context) => {
  if (!value.token.startsWith(`hap_v1_${value.apiToken.tokenId}_`)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['token'],
      message: 'The one-time bearer must match the returned API-token summary.',
    });
  }
}));
export type AccountApiTokensCreateActionOutputV1 = z.infer<typeof AccountApiTokensCreateActionOutputV1Schema>;

/** Observers receive the existing non-secret summary, never the one-time bearer. */
export function projectAccountApiTokenCreationObservation(value: unknown): Readonly<{ apiToken: AccountApiTokenSummaryV1 }> {
  const output = AccountApiTokensCreateActionOutputV1Schema.safeParse(value);
  // Approval history already holds the safe summary. Re-observing it must not
  // require (or recover) the one-shot bearer that was deliberately discarded.
  return output.success ? { apiToken: output.data.apiToken }
    : AccountApiTokensUpdateActionOutputV1Schema.parse(value);
}

export const AccountApiTokensListActionInputV1Schema = lazyZodSchema(() => z.object({}).strict());
export type AccountApiTokensListActionInputV1 = z.infer<typeof AccountApiTokensListActionInputV1Schema>;

/** List projections are summaries only and can never re-disclose a bearer. */
export const AccountApiTokensListActionOutputV1Schema = lazyZodSchema(() => z.object({
  tokens: z.array(AccountApiTokenSummaryV1Schema),
}).strict());
export type AccountApiTokensListActionOutputV1 = z.infer<typeof AccountApiTokensListActionOutputV1Schema>;

export const AccountApiTokensRevokeActionInputV1Schema = lazyZodSchema(() => z.object({
  tokenId: AccountApiTokenIdV1Schema,
}).strict());
export type AccountApiTokensRevokeActionInputV1 = z.infer<typeof AccountApiTokensRevokeActionInputV1Schema>;

export const AccountApiTokensRevokeActionOutputV1Schema = lazyZodSchema(() => z.object({
  revoked: z.boolean(),
}).strict());
export type AccountApiTokensRevokeActionOutputV1 = z.infer<typeof AccountApiTokensRevokeActionOutputV1Schema>;

export const AccountApiTokensRevokeAllActionInputV1Schema = lazyZodSchema(() => z.object({}).strict());
export type AccountApiTokensRevokeAllActionInputV1 = z.infer<typeof AccountApiTokensRevokeAllActionInputV1Schema>;

export const AccountApiTokensRevokeAllActionOutputV1Schema = lazyZodSchema(() => z.object({
  revokedCount: z.number().int().nonnegative(),
}).strict());
export type AccountApiTokensRevokeAllActionOutputV1 = z.infer<typeof AccountApiTokensRevokeAllActionOutputV1Schema>;

/** Authenticated endpoints below the Action boundary; the Account is never a URL or body selector. */
export const ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1 = '/v1/auth/api-tokens/create';
export const ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 = '/v1/auth/api-tokens/list';
export const ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1 = '/v1/auth/api-tokens/revoke';
export const ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1 = '/v1/auth/api-tokens/revoke-all';
export const ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1 = '/v1/auth/api-tokens/introspect';
export const ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1 = '/v1/auth/api-tokens/update';
export const ACCOUNT_API_TOKEN_CHILDREN_CREATE_HTTP_PATH_V1 = '/v1/auth/api-tokens/children/create';
export const ACCOUNT_API_TOKEN_CHILDREN_REVOKE_HTTP_PATH_V1 = '/v1/auth/api-tokens/children/revoke';
export const ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1 = '/v1/auth/api-tokens/self';
export const SESSION_CREATION_AUTHORIZATION_HEADER_V1 = 'x-happier-session-creation-authorization' as const;
/**
 * The canonical request is under 100 bytes. One KiB still admits a fully
 * escaped token plus ordinary JSON formatting while preventing this fixed-size
 * authentication envelope from inheriting the server's unrelated 100 MiB
 * application-body ceiling.
 */
export const ACCOUNT_API_TOKEN_INTROSPECTION_MAX_BODY_BYTES_V1 = 1_024;

/** The PAT is a subject credential; the authenticated daemon Account is transport provenance. */
export const AccountApiTokenIntrospectionRequestV1Schema = lazyZodSchema(() => z.object({
  token: AccountApiTokenBearerV1Schema,
}).strict());
export type AccountApiTokenIntrospectionRequestV1 = z.infer<typeof AccountApiTokenIntrospectionRequestV1Schema>;

/** Minimal PAT principal returned only after authenticated Account-bound introspection. */
export const AccountApiTokenIntrospectionSuccessV1Schema = lazyZodSchema(() => z.object({
  accountId: z.string().min(1),
  principalId: z.string().min(1),
  credentialId: AccountApiTokenIdV1Schema,
  expiresAt: AccountApiTokenInstantV1Schema.nullable(),
  authority: z.literal('account_automation'),
  grant: ApiTokenGrantV1Schema,
  parentTokenId: AccountApiTokenIdV1Schema.nullable(),
  embedConfig: EmbedConfigV1Schema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.principalId !== value.accountId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['principalId'],
      message: 'The introspected principal must be bound to its Account.',
    });
  }
}));
export type AccountApiTokenIntrospectionSuccessV1 = z.infer<typeof AccountApiTokenIntrospectionSuccessV1Schema>;

/** Opaque PAT-subject rejection emitted only after the daemon connection is authenticated. */
export const AccountApiTokenIntrospectionSubjectFailureV1Schema = lazyZodSchema(() => z.object({
  error: z.literal('invalid_token'),
}).strict());
export type AccountApiTokenIntrospectionSubjectFailureV1 = z.infer<
  typeof AccountApiTokenIntrospectionSubjectFailureV1Schema
>;

/** Closed connection-authentication failures emitted before the PAT body is admitted. */
export const AccountApiTokenIntrospectionConnectionFailureV1Schema = lazyZodSchema(() => z.object({
  error: z.enum(['Missing authorization header', 'authentication_failed', 'Authentication failed']),
}).strict());
export type AccountApiTokenIntrospectionConnectionFailureV1 = z.infer<
  typeof AccountApiTokenIntrospectionConnectionFailureV1Schema
>;

export const AccountApiTokensServerErrorV1Schema = lazyZodSchema(() => z.object({
  error: z.enum([
    'invalid_request', 'present_user_required', 'account-disabled',
    'api_token_required', 'api_token_id_conflict',
    'api_token_encryption_unavailable', 'api_token_encryption_stale',
    'api_token_encryption_not_ready',
    'api_token_child_forbidden', 'api_token_child_invalid',
    'credential_scope_denied', 'credential_origin_denied', 'model_not_granted',
    'credential_authentication_evidence_limit',
    'credential_authentication_evidence_unavailable',
  ]),
}).strict());
export type AccountApiTokensServerErrorV1 = z.infer<typeof AccountApiTokensServerErrorV1Schema>;

export const AccountApiTokenCredentialV1Schema = lazyZodSchema(() => z.object({
  bearer: AccountApiTokenBearerV1Schema.refine((value) => {
    const parsed = parseAccountApiTokenBearerV1(value);
    return parsed !== null && canonicalBytes(32, 'base64url').safeParse(parsed.secret).success;
  }),
  wrappingSecret: canonicalBytes(32, 'base64url'),
  serverIdentityId: ApiTokenHomeIdentitySchema,
  accountId: z.string().min(1),
  contentPublicKey: ApiTokenContentPublicKeySchema,
}).strict());
export type AccountApiTokenCredentialV1 = z.infer<typeof AccountApiTokenCredentialV1Schema>;

/** Invocation-local encoding. It must never be used as an HTTP bearer. */
export function formatAccountApiTokenCredentialV1(value: AccountApiTokenCredentialV1): string {
  const payload = AccountApiTokenCredentialV1Schema.parse(value);
  return `hapc_v1_${encodeBase64(new TextEncoder().encode(JSON.stringify(payload)), 'base64url')}`;
}

export function parseAccountApiTokenCredentialV1(value: string): AccountApiTokenCredentialV1 | null {
  if (!value.startsWith('hapc_v1_')) return null;
  try {
    const encoded = value.slice('hapc_v1_'.length);
    const bytes = decodeBase64(encoded, 'base64url');
    if (encodeBase64(bytes, 'base64url') !== encoded) return null;
    const parsed = AccountApiTokenCredentialV1Schema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const AccountApiTokenEncryptionAccessRequestV1Schema = lazyZodSchema(() => z.object({}).strict());
export const AccountApiTokenEncryptionAccessResponseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), accountId: z.string().min(1), tokenId: ApiTokenUuidV4Schema,
  encryptionAccess: AccountApiTokenEncryptionAccessV1Schema,
}).strict());
export type AccountApiTokenEncryptionAccessResponseV1 = z.infer<typeof AccountApiTokenEncryptionAccessResponseV1Schema>;
export const ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1 = '/v1/auth/api-tokens/encryption-access';
