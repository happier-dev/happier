import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

const ExternalApiKeyIdV1Schema = lazyZodSchema(() => z.string().uuid());
const ExternalApiKeySecretV1Schema = lazyZodSchema(() => z.string().regex(/^[A-Za-z0-9_-]{43}$/u));
const ExternalApiKeyLabelV1Schema = lazyZodSchema(() => z.string().trim().min(1).max(120));
const ExternalApiKeyInstantV1Schema = lazyZodSchema(() => z.string().datetime({ offset: true }));

/** Resource-scoped external inference credentials are deliberately distinct from Account PATs. */
export const TEAM_CREDENTIAL_EXTERNAL_API_KEY_PREFIX_V1 = 'hapek_v1' as const;

const ExternalApiKeyBearerV1Schema = lazyZodSchema(() => z.string().regex(
  /^hapek_v1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/u,
));

export const TeamCredentialExternalApiKeySummaryV1Schema = lazyZodSchema(() => z.object({
  keyId: ExternalApiKeyIdV1Schema,
  resourceId: z.string().min(1),
  teamMembershipId: z.string().min(1),
  label: ExternalApiKeyLabelV1Schema,
  displayPrefix: z.string().regex(/^hapek_v1_[0-9a-f]{8}$/u),
  createdAt: ExternalApiKeyInstantV1Schema,
  lastUsedAt: ExternalApiKeyInstantV1Schema.nullable(),
  expiresAt: ExternalApiKeyInstantV1Schema.nullable(),
  authenticationStatus: z.enum(['satisfied', 'authentication_required', 'unavailable']),
  canAuthorize: z.boolean(),
}).strict());
export type TeamCredentialExternalApiKeySummaryV1 = z.infer<typeof TeamCredentialExternalApiKeySummaryV1Schema>;

export const TeamCredentialExternalApiKeyCreateInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  teamMembershipId: z.string().min(1),
  label: ExternalApiKeyLabelV1Schema,
  expiresAt: ExternalApiKeyInstantV1Schema.nullable().optional().default(null),
}).strict());
export type TeamCredentialExternalApiKeyCreateInputV1 = z.infer<typeof TeamCredentialExternalApiKeyCreateInputV1Schema>;

/** The bearer is returned only by create; all later projections are summary-only. */
export const TeamCredentialExternalApiKeyCreateOutputV1Schema = lazyZodSchema(() => z.object({
  token: ExternalApiKeyBearerV1Schema,
  key: TeamCredentialExternalApiKeySummaryV1Schema,
}).strict());
export type TeamCredentialExternalApiKeyCreateOutputV1 = z.infer<typeof TeamCredentialExternalApiKeyCreateOutputV1Schema>;

export const TeamCredentialExternalApiKeyListInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
}).strict());
export type TeamCredentialExternalApiKeyListInputV1 = z.infer<typeof TeamCredentialExternalApiKeyListInputV1Schema>;

export const TeamCredentialExternalApiKeyListOutputV1Schema = lazyZodSchema(() => z.object({
  keys: z.array(TeamCredentialExternalApiKeySummaryV1Schema),
}).strict());
export type TeamCredentialExternalApiKeyListOutputV1 = z.infer<typeof TeamCredentialExternalApiKeyListOutputV1Schema>;

export const TeamCredentialExternalApiKeyRevokeInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  keyId: ExternalApiKeyIdV1Schema,
}).strict());
export type TeamCredentialExternalApiKeyRevokeInputV1 = z.infer<typeof TeamCredentialExternalApiKeyRevokeInputV1Schema>;

/** Only the assigned authenticated Account may authorize this exact key. */
export const TeamCredentialExternalApiKeyAuthorizeInputV1Schema = TeamCredentialExternalApiKeyRevokeInputV1Schema;
export type TeamCredentialExternalApiKeyAuthorizeInputV1 = z.infer<typeof TeamCredentialExternalApiKeyAuthorizeInputV1Schema>;
export const TeamCredentialExternalApiKeyAuthorizeOutputV1Schema = lazyZodSchema(() => z.object({
  key: TeamCredentialExternalApiKeySummaryV1Schema,
}).strict());
export type TeamCredentialExternalApiKeyAuthorizeOutputV1 = z.infer<typeof TeamCredentialExternalApiKeyAuthorizeOutputV1Schema>;

export const TeamCredentialExternalApiKeyRevokeOutputV1Schema = lazyZodSchema(() => z.object({
  keyId: ExternalApiKeyIdV1Schema,
  revoked: z.boolean(),
}).strict());
export type TeamCredentialExternalApiKeyRevokeOutputV1 = z.infer<typeof TeamCredentialExternalApiKeyRevokeOutputV1Schema>;

export const TeamCredentialExternalApiKeyRevokeAllInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
}).strict());
export type TeamCredentialExternalApiKeyRevokeAllInputV1 = z.infer<typeof TeamCredentialExternalApiKeyRevokeAllInputV1Schema>;

export const TeamCredentialExternalApiKeyRevokeAllOutputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  revokedCount: z.number().int().nonnegative(),
}).strict());
export type TeamCredentialExternalApiKeyRevokeAllOutputV1 = z.infer<typeof TeamCredentialExternalApiKeyRevokeAllOutputV1Schema>;

export type ParsedTeamCredentialExternalApiKeyV1 = Readonly<{ keyId: string; secret: string }>;

/** Strictly parses only the resource-scoped bearer grammar; Account PATs never reach this owner. */
export function parseTeamCredentialExternalApiKeyV1(value: string): ParsedTeamCredentialExternalApiKeyV1 {
  const parsed = ExternalApiKeyBearerV1Schema.parse(value);
  const prefix = `${TEAM_CREDENTIAL_EXTERNAL_API_KEY_PREFIX_V1}_`;
  const keyIdStart = prefix.length;
  const keyIdEnd = keyIdStart + 36;
  const keyId = parsed.slice(keyIdStart, keyIdEnd);
  const secret = parsed.slice(keyIdEnd + 1);
  ExternalApiKeyIdV1Schema.parse(keyId);
  ExternalApiKeySecretV1Schema.parse(secret);
  return { keyId, secret };
}

export function formatTeamCredentialExternalApiKeyV1(input: ParsedTeamCredentialExternalApiKeyV1): string {
  const keyId = ExternalApiKeyIdV1Schema.parse(input.keyId);
  const secret = ExternalApiKeySecretV1Schema.parse(input.secret);
  const bearer = `${TEAM_CREDENTIAL_EXTERNAL_API_KEY_PREFIX_V1}_${keyId}_${secret}`;
  ExternalApiKeyBearerV1Schema.parse(bearer);
  return bearer;
}

export function createTeamCredentialExternalApiKeyDisplayPrefixV1(keyId: string): string {
  return `${TEAM_CREDENTIAL_EXTERNAL_API_KEY_PREFIX_V1}_${ExternalApiKeyIdV1Schema.parse(keyId).slice(0, 8)}`;
}
