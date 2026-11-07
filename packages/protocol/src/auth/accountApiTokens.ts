import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ApiTokenGrantV1Schema } from './apiTokenGrant.js';
import { EmbedConfigV1Schema } from '../embed/embedConfigV1.js';
import { decodeBase64, encodeBase64, type Base64Variant } from '../crypto/base64.js';
import { SERVER_IDENTITY_ID_PATTERN } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import { DeploymentDeploySemanticInputV1Schema } from '../deployments/deploymentDeployIntentV1.js';

const AccountApiTokenIdV1Schema = lazyZodSchema(() => z.string().check(z.uuid()));
const AccountApiTokenInstantV1Schema = lazyZodSchema(() => z.string().check(z.iso.datetime({ offset: true }), z.maxLength(64)));
const AccountApiTokenDisplayPrefixV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^hap_v1_[0-9a-f]{8}$/u)));
const ACCOUNT_API_TOKEN_BEARER_V1_PATTERN =
  /^hap_v1_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/u;
export const AccountApiTokenBearerV1Schema = lazyZodSchema(() => z.string().check(z.regex(ACCOUNT_API_TOKEN_BEARER_V1_PATTERN)));

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
  return z.string().check(z.length(encodedLength), z.refine((value) => {
    const bytes = decodeBase64(value, variant);
    return bytes.length === length && encodeBase64(bytes, variant) === value;
  }));
}

const ApiTokenHomeIdentitySchema = lazyZodSchema(() => z.string().check(z.regex(SERVER_IDENTITY_ID_PATTERN)));
const ApiTokenContentPublicKeySchema = canonicalBytes(32, 'base64');
const ApiTokenUuidV4Schema = lazyZodSchema(() => z.string().check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)));

/** Opaque sealed content material. No recovery, content or wrapping secret is transported. */
export const AccountApiTokenEncryptionAccessV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  serverIdentityId: ApiTokenHomeIdentitySchema,
  contentPublicKey: ApiTokenContentPublicKeySchema,
  wrappedContentPrivateKey: canonicalBytes(72, 'base64url'),
}));
export type AccountApiTokenEncryptionAccessV1 = z.infer<typeof AccountApiTokenEncryptionAccessV1Schema>;

export const AccountApiTokenCreateEncryptionV1Schema = lazyZodSchema(() => z.strictObject({
  access: AccountApiTokenEncryptionAccessV1Schema,
}));
export type AccountApiTokenCreateEncryptionV1 = z.infer<typeof AccountApiTokenCreateEncryptionV1Schema>;

/** A non-secret, Account-scoped token projection suitable for Settings lists. */
export const AccountApiTokenSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  tokenId: AccountApiTokenIdV1Schema,
  label: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  displayPrefix: AccountApiTokenDisplayPrefixV1Schema,
  createdAt: AccountApiTokenInstantV1Schema,
  lastUsedAt: z.nullable(AccountApiTokenInstantV1Schema),
  expiresAt: z.nullable(AccountApiTokenInstantV1Schema),
  hasEncryptionAccess: z.boolean(),
  hasUnattendedTeamAccess: z.boolean(),
  grant: ApiTokenGrantV1Schema,
  parentTokenId: z.nullable(AccountApiTokenIdV1Schema),
  activeChildCount: z.number().check(z.int(), z.nonnegative()),
  embedConfig: z.nullable(EmbedConfigV1Schema),
}));
export type AccountApiTokenSummaryV1 = z.infer<typeof AccountApiTokenSummaryV1Schema>;

/** Deployment choice is intent; authenticated token preparation produces consent. */
export const AccountApiTokenDeploymentInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DeploymentDeploySemanticInputV1Schema.shape,
  deployApproval: z.optional(z.enum(['automatic', 'ask'])),
}));
export type AccountApiTokenDeploymentInputV1 = z.infer<typeof AccountApiTokenDeploymentInputV1Schema>;

/** The Account is derived from verified credential provenance, never this input. */
export const AccountApiTokensCreateActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  tokenId: ApiTokenUuidV4Schema,
  label: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  expiresAt: z.optional(z.nullable(AccountApiTokenInstantV1Schema)),
  encryption: z.optional(AccountApiTokenCreateEncryptionV1Schema),
  authorizeUnattendedTeamAccess: z.optional(z.boolean()),
  grant: z.optional(ApiTokenGrantV1Schema),
  embedConfig: z.optional(EmbedConfigV1Schema),
  deployment: z.optional(AccountApiTokenDeploymentInputV1Schema),
}));
export type AccountApiTokensCreateActionInputV1 = z.infer<typeof AccountApiTokensCreateActionInputV1Schema>;

export const AccountApiTokensUpdateActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  tokenId: AccountApiTokenIdV1Schema,
  /** Refreshes this token's evidence from the authenticated present person, never input evidence. */
  authorizeUnattendedTeamAccess: z.optional(z.literal(true)),
  label: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  grant: z.optional(ApiTokenGrantV1Schema),
  embedConfig: z.optional(z.nullable(EmbedConfigV1Schema)),
  deployment: z.optional(z.nullable(AccountApiTokenDeploymentInputV1Schema)),
}).check(z.refine((value) => value.label !== undefined || value.grant !== undefined || value.embedConfig !== undefined
  || value.deployment !== undefined || value.authorizeUnattendedTeamAccess === true, 'An update must contain at least one change.')));
export type AccountApiTokensUpdateActionInputV1 = z.infer<typeof AccountApiTokensUpdateActionInputV1Schema>;

export const AccountApiTokensCreateHttpInputV1Schema = AccountApiTokensCreateActionInputV1Schema;
export const AccountApiTokensUpdateHttpInputV1Schema = AccountApiTokensUpdateActionInputV1Schema;
export const AccountApiTokensUpdateActionOutputV1Schema = lazyZodSchema(() => z.strictObject({ apiToken: AccountApiTokenSummaryV1Schema }));
export type AccountApiTokensUpdateActionOutputV1 = z.infer<typeof AccountApiTokensUpdateActionOutputV1Schema>;

export const AccountApiTokenChildCreateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  tokenId: ApiTokenUuidV4Schema,
  label: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  expiresAt: AccountApiTokenInstantV1Schema,
  grant: ApiTokenGrantV1Schema,
  requireCreatedByChildTokenId: z.optional(AccountApiTokenIdV1Schema),
}));
export type AccountApiTokenChildCreateRequestV1 = z.infer<typeof AccountApiTokenChildCreateRequestV1Schema>;
export const AccountApiTokenChildRevokeRequestV1Schema = lazyZodSchema(() => z.strictObject({ tokenId: AccountApiTokenIdV1Schema }));
export type AccountApiTokenChildRevokeRequestV1 = z.infer<typeof AccountApiTokenChildRevokeRequestV1Schema>;
export const AccountApiTokenSelfV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().check(z.minLength(1)),
  accountEncryptionMode: z.enum(['plain', 'e2ee']),
  credentialId: AccountApiTokenIdV1Schema,
  parentTokenId: z.nullable(AccountApiTokenIdV1Schema),
  expiresAt: z.nullable(AccountApiTokenInstantV1Schema),
  grant: ApiTokenGrantV1Schema,
  embedConfig: z.nullable(EmbedConfigV1Schema),
}));
export type AccountApiTokenSelfV1 = z.infer<typeof AccountApiTokenSelfV1Schema>;

/**
 * `token` is the sole plaintext bearer disclosure. The strict nested summary
 * intentionally makes later read/revoke results unable to carry a secret.
 */
export const AccountApiTokensCreateActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  token: AccountApiTokenBearerV1Schema,
  apiToken: AccountApiTokenSummaryV1Schema,
}).check(z.superRefine((value, context) => {
  if (!value.token.startsWith(`hap_v1_${value.apiToken.tokenId}_`)) {
    context.addIssue({
      code: "custom",
      path: ['token'],
      message: 'The one-time bearer must match the returned API-token summary.',
    });
  }
})));
export type AccountApiTokensCreateActionOutputV1 = z.infer<typeof AccountApiTokensCreateActionOutputV1Schema>;

/** Observers receive the existing non-secret summary, never the one-time bearer. */
export function projectAccountApiTokenCreationObservation(value: unknown): Readonly<{ apiToken: AccountApiTokenSummaryV1 }> {
  const output = AccountApiTokensCreateActionOutputV1Schema.safeParse(value);
  // Approval history already holds the safe summary. Re-observing it must not
  // require (or recover) the one-shot bearer that was deliberately discarded.
  return output.success ? { apiToken: output.data.apiToken }
    : AccountApiTokensUpdateActionOutputV1Schema.parse(value);
}

export const AccountApiTokensListActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  includeChildren: z.optional(z.literal(true)),
}));
export type AccountApiTokensListActionInputV1 = z.infer<typeof AccountApiTokensListActionInputV1Schema>;

/** List projections are summaries only and can never re-disclose a bearer. */
export const AccountApiTokensListActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  tokens: z.array(AccountApiTokenSummaryV1Schema),
}));
export type AccountApiTokensListActionOutputV1 = z.infer<typeof AccountApiTokensListActionOutputV1Schema>;

export const AccountApiTokensRevokeActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  tokenId: AccountApiTokenIdV1Schema,
}));
export type AccountApiTokensRevokeActionInputV1 = z.infer<typeof AccountApiTokensRevokeActionInputV1Schema>;

export const AccountApiTokensRevokeActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  revoked: z.boolean(),
}));
export type AccountApiTokensRevokeActionOutputV1 = z.infer<typeof AccountApiTokensRevokeActionOutputV1Schema>;

export const AccountApiTokensRevokeAllActionInputV1Schema = lazyZodSchema(() => z.strictObject({}));
export type AccountApiTokensRevokeAllActionInputV1 = z.infer<typeof AccountApiTokensRevokeAllActionInputV1Schema>;

export const AccountApiTokensRevokeAllActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  revokedCount: z.number().check(z.int(), z.nonnegative()),
}));
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
export const AccountApiTokenIntrospectionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  token: AccountApiTokenBearerV1Schema,
}));
export type AccountApiTokenIntrospectionRequestV1 = z.infer<typeof AccountApiTokenIntrospectionRequestV1Schema>;

/** Minimal PAT principal returned only after authenticated Account-bound introspection. */
export const AccountApiTokenIntrospectionSuccessV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().check(z.minLength(1)),
  principalId: z.string().check(z.minLength(1)),
  credentialId: AccountApiTokenIdV1Schema,
  expiresAt: z.nullable(AccountApiTokenInstantV1Schema),
  authority: z.literal('account_automation'),
  grant: ApiTokenGrantV1Schema,
  parentTokenId: z.nullable(AccountApiTokenIdV1Schema),
  embedConfig: z.nullable(EmbedConfigV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.principalId !== value.accountId) {
    context.addIssue({
      code: "custom",
      path: ['principalId'],
      message: 'The introspected principal must be bound to its Account.',
    });
  }
})));
export type AccountApiTokenIntrospectionSuccessV1 = z.infer<typeof AccountApiTokenIntrospectionSuccessV1Schema>;

/** Opaque PAT-subject rejection emitted only after the daemon connection is authenticated. */
export const AccountApiTokenIntrospectionSubjectFailureV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal('invalid_token'),
}));
export type AccountApiTokenIntrospectionSubjectFailureV1 = z.infer<
  typeof AccountApiTokenIntrospectionSubjectFailureV1Schema
>;

/** Closed connection-authentication failures emitted before the PAT body is admitted. */
export const AccountApiTokenIntrospectionConnectionFailureV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.enum(['Missing authorization header', 'authentication_failed', 'Authentication failed']),
}));
export type AccountApiTokenIntrospectionConnectionFailureV1 = z.infer<
  typeof AccountApiTokenIntrospectionConnectionFailureV1Schema
>;

export const AccountApiTokensServerErrorV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.enum([
    'invalid_request', 'present_user_required', 'account-disabled',
    'api_token_required', 'api_token_id_conflict',
    'api_token_encryption_unavailable', 'api_token_encryption_stale',
    'api_token_encryption_not_ready',
    'api_token_child_forbidden', 'api_token_child_invalid',
    'credential_scope_denied', 'credential_origin_denied', 'model_not_granted',
    'credential_authentication_evidence_limit',
    'credential_authentication_evidence_unavailable',
    'database_transaction_conflict_exhausted', 'database_transaction_timeout', 'database_connection_unavailable',
  ]),
  statusCode: z.optional(z.literal(503)),
}).check(z.superRefine((value, context) => {
  const databaseFailure = value.error === 'database_transaction_conflict_exhausted'
    || value.error === 'database_transaction_timeout'
    || value.error === 'database_connection_unavailable';
  if (databaseFailure !== (value.statusCode === 503)) {
    context.addIssue({
      code: 'custom',
      path: ['statusCode'],
      message: 'Database availability failures require the exact HTTP 503 status projection.',
    });
  }
})));
export type AccountApiTokensServerErrorV1 = z.infer<typeof AccountApiTokensServerErrorV1Schema>;

export const AccountApiTokenCredentialV1Schema = lazyZodSchema(() => z.strictObject({
  bearer: AccountApiTokenBearerV1Schema.check(z.refine((value) => {
    const parsed = parseAccountApiTokenBearerV1(value);
    return parsed !== null && canonicalBytes(32, 'base64url').safeParse(parsed.secret).success;
  })),
  wrappingSecret: canonicalBytes(32, 'base64url'),
  serverIdentityId: ApiTokenHomeIdentitySchema,
  accountId: z.string().check(z.minLength(1)),
  contentPublicKey: ApiTokenContentPublicKeySchema,
}));
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

export const AccountApiTokenEncryptionAccessRequestV1Schema = lazyZodSchema(() => z.strictObject({}));
export const AccountApiTokenEncryptionAccessResponseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), accountId: z.string().check(z.minLength(1)), tokenId: ApiTokenUuidV4Schema,
  encryptionAccess: AccountApiTokenEncryptionAccessV1Schema,
}));
export type AccountApiTokenEncryptionAccessResponseV1 = z.infer<typeof AccountApiTokenEncryptionAccessResponseV1Schema>;
export const ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1 = '/v1/auth/api-tokens/encryption-access';
