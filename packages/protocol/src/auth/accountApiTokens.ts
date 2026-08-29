import { z } from 'zod';

const AccountApiTokenIdV1Schema = z.string().uuid();
const AccountApiTokenInstantV1Schema = z.string().datetime({ offset: true }).max(64);
const AccountApiTokenDisplayPrefixV1Schema = z.string().regex(/^hap_v1_[0-9a-f]{8}$/u);
const ACCOUNT_API_TOKEN_BEARER_V1_PATTERN =
  /^hap_v1_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/u;
export const AccountApiTokenBearerV1Schema = z.string().regex(
  ACCOUNT_API_TOKEN_BEARER_V1_PATTERN,
);

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

/** A non-secret, Account-scoped token projection suitable for Settings lists. */
export const AccountApiTokenSummaryV1Schema = z.object({
  tokenId: AccountApiTokenIdV1Schema,
  label: z.string().trim().min(1).max(256),
  displayPrefix: AccountApiTokenDisplayPrefixV1Schema,
  createdAt: AccountApiTokenInstantV1Schema,
  lastUsedAt: AccountApiTokenInstantV1Schema.nullable(),
  expiresAt: AccountApiTokenInstantV1Schema.nullable(),
}).strict();
export type AccountApiTokenSummaryV1 = z.infer<typeof AccountApiTokenSummaryV1Schema>;

/** The Account is derived from verified credential provenance, never this input. */
export const AccountApiTokensCreateActionInputV1Schema = z.object({
  label: z.string().trim().min(1).max(256),
  expiresAt: AccountApiTokenInstantV1Schema.nullable().optional(),
}).strict();
export type AccountApiTokensCreateActionInputV1 = z.infer<typeof AccountApiTokensCreateActionInputV1Schema>;

/**
 * `token` is the sole plaintext bearer disclosure. The strict nested summary
 * intentionally makes later read/revoke results unable to carry a secret.
 */
export const AccountApiTokensCreateActionOutputV1Schema = z.object({
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
});
export type AccountApiTokensCreateActionOutputV1 = z.infer<typeof AccountApiTokensCreateActionOutputV1Schema>;

export const AccountApiTokensListActionInputV1Schema = z.object({}).strict();
export type AccountApiTokensListActionInputV1 = z.infer<typeof AccountApiTokensListActionInputV1Schema>;

/** List projections are summaries only and can never re-disclose a bearer. */
export const AccountApiTokensListActionOutputV1Schema = z.object({
  tokens: z.array(AccountApiTokenSummaryV1Schema),
}).strict();
export type AccountApiTokensListActionOutputV1 = z.infer<typeof AccountApiTokensListActionOutputV1Schema>;

export const AccountApiTokensRevokeActionInputV1Schema = z.object({
  tokenId: AccountApiTokenIdV1Schema,
}).strict();
export type AccountApiTokensRevokeActionInputV1 = z.infer<typeof AccountApiTokensRevokeActionInputV1Schema>;

export const AccountApiTokensRevokeActionOutputV1Schema = z.object({
  revoked: z.boolean(),
}).strict();
export type AccountApiTokensRevokeActionOutputV1 = z.infer<typeof AccountApiTokensRevokeActionOutputV1Schema>;

export const AccountApiTokensRevokeAllActionInputV1Schema = z.object({}).strict();
export type AccountApiTokensRevokeAllActionInputV1 = z.infer<typeof AccountApiTokensRevokeAllActionInputV1Schema>;

export const AccountApiTokensRevokeAllActionOutputV1Schema = z.object({
  revokedCount: z.number().int().nonnegative(),
}).strict();
export type AccountApiTokensRevokeAllActionOutputV1 = z.infer<typeof AccountApiTokensRevokeAllActionOutputV1Schema>;

/** Authenticated endpoints below the Action boundary; the Account is never a URL or body selector. */
export const ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1 = '/v1/auth/api-tokens/create';
export const ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 = '/v1/auth/api-tokens/list';
export const ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1 = '/v1/auth/api-tokens/revoke';
export const ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1 = '/v1/auth/api-tokens/revoke-all';
export const ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1 = '/v1/auth/api-tokens/introspect';
/**
 * The canonical request is under 100 bytes. One KiB still admits a fully
 * escaped token plus ordinary JSON formatting while preventing this fixed-size
 * authentication envelope from inheriting the server's unrelated 100 MiB
 * application-body ceiling.
 */
export const ACCOUNT_API_TOKEN_INTROSPECTION_MAX_BODY_BYTES_V1 = 1_024;

/** The PAT is a subject credential; the authenticated daemon Account is transport provenance. */
export const AccountApiTokenIntrospectionRequestV1Schema = z.object({
  token: AccountApiTokenBearerV1Schema,
}).strict();
export type AccountApiTokenIntrospectionRequestV1 = z.infer<typeof AccountApiTokenIntrospectionRequestV1Schema>;

/** Minimal PAT principal returned only after authenticated Account-bound introspection. */
export const AccountApiTokenIntrospectionSuccessV1Schema = z.object({
  accountId: z.string().min(1),
  principalId: z.string().min(1),
  credentialId: AccountApiTokenIdV1Schema,
  expiresAt: AccountApiTokenInstantV1Schema.nullable(),
  authority: z.literal('account_automation'),
}).strict().superRefine((value, context) => {
  if (value.principalId !== value.accountId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['principalId'],
      message: 'The introspected principal must be bound to its Account.',
    });
  }
});
export type AccountApiTokenIntrospectionSuccessV1 = z.infer<typeof AccountApiTokenIntrospectionSuccessV1Schema>;

/** Opaque PAT-subject rejection emitted only after the daemon connection is authenticated. */
export const AccountApiTokenIntrospectionSubjectFailureV1Schema = z.object({
  error: z.literal('invalid_token'),
}).strict();
export type AccountApiTokenIntrospectionSubjectFailureV1 = z.infer<
  typeof AccountApiTokenIntrospectionSubjectFailureV1Schema
>;

export const AccountApiTokensServerErrorV1Schema = z.object({
  error: z.enum(['invalid_request', 'present_user_required']),
}).strict();
export type AccountApiTokensServerErrorV1 = z.infer<typeof AccountApiTokensServerErrorV1Schema>;
