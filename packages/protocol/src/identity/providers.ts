import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { IdentityConnectionTestDiagnosticsV1Schema } from './testDiagnostics.js';

const ProviderIdSchema = lazyZodSchema(() => z.string().trim().min(1));
const NonEmptyStringSchema = lazyZodSchema(() => z.string().trim().min(1));
const ProviderDisplayNameSchema = lazyZodSchema(() => z.string().trim().min(1).max(256));

/** Exact Team identity binding visible only in authorized owner administration. */
export const ManagedIdentityProviderTeamConsumerV1Schema = lazyZodSchema(() => z.object({
  team: z.object({
    id: NonEmptyStringSchema,
    name: z.string(),
  }).strict(),
  binding: z.object({
    kind: z.literal('identity_connection'),
    id: NonEmptyStringSchema,
    enabled: z.boolean(),
  }).strict(),
}).strict());
export type ManagedIdentityProviderTeamConsumerV1 = z.infer<typeof ManagedIdentityProviderTeamConsumerV1Schema>;

export const ManagedIdentityProviderOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('home') }).strict(),
  z.object({ kind: z.literal('team'), teamId: NonEmptyStringSchema }).strict(),
]));
export type ManagedIdentityProviderOwnerV1 = z.infer<typeof ManagedIdentityProviderOwnerV1Schema>;
const ManagedIdentityProviderOwnerInputV1Schema = lazyZodSchema(() => ManagedIdentityProviderOwnerV1Schema
  .default({ kind: 'home' }));

const ManagedOidcProviderConfigFieldsV1 = {
  v: z.literal(1),
  kind: z.literal('oidc'),
  issuer: NonEmptyStringSchema,
  clientId: NonEmptyStringSchema,
  clientAuthenticationMethod: z.enum(['client_secret_post', 'client_secret_basic']),
  scopes: NonEmptyStringSchema.refine(
    (value) => value.split(/\s+/u).some((scope) => scope.toLowerCase() === 'openid'),
    'OIDC scopes must include openid',
  ),
  httpTimeoutSeconds: z.number().int().min(1).max(120),
  claims: z.object({
    login: NonEmptyStringSchema,
    email: NonEmptyStringSchema,
    groups: NonEmptyStringSchema,
  }).strict(),
  allow: z.object({
    usersAllowlist: z.array(NonEmptyStringSchema),
    emailDomains: z.array(NonEmptyStringSchema),
    groupsAny: z.array(NonEmptyStringSchema),
    groupsAll: z.array(NonEmptyStringSchema),
  }).strict(),
  fetchUserInfo: z.boolean(),
  storeRefreshToken: z.boolean(),
  ui: z.object({
    buttonColor: NonEmptyStringSchema.nullable(),
    iconHint: NonEmptyStringSchema.nullable(),
  }).strict(),
} as const;

/** Canonical current provider document. Security-effective choices are always explicit. */
export const ManagedOidcProviderConfigV1Schema = lazyZodSchema(() => z.object(ManagedOidcProviderConfigFieldsV1).strict());
export type ManagedOidcProviderConfigV1 = z.infer<typeof ManagedOidcProviderConfigV1Schema>;

/**
 * Creation is the only wire boundary that accepts the predecessor omission. It
 * immediately materializes the explicit current value before persistence.
 */
const ManagedOidcProviderCreateConfigV1Schema = lazyZodSchema(() => z.object({
  ...ManagedOidcProviderConfigFieldsV1,
  clientAuthenticationMethod: ManagedOidcProviderConfigFieldsV1.clientAuthenticationMethod
    .default('client_secret_post'),
}).strict());

const ManagedIdentityProviderCommonFieldsV1 = {
  v: z.literal(1),
  owner: ManagedIdentityProviderOwnerV1Schema,
  id: ProviderIdSchema,
  displayName: ProviderDisplayNameSchema,
  enabled: z.boolean(),
  firstEnabledAt: z.number().int().nullable(),
  securityRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  lastSuccessfulTest: z.object({
    at: z.number().int(),
    testedSecurityRevision: z.number().int().positive(),
    current: z.boolean(),
  }).strict().nullable(),
  createdByAccountId: z.string().min(1).nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  teamConsumers: z.array(ManagedIdentityProviderTeamConsumerV1Schema).default([]),
  /**
   * The redirect URI the administrator must register at the identity provider.
   * Derived from the Home's public server URL and the provider id, never
   * persisted; absent only when the Home has no public server URL configured.
   */
  callbackUrl: z.string().url().optional(),
} as const;

export const ManagedGitHubIdentityProviderConfigV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('github_app_identity'),
}).strict());
export type ManagedGitHubIdentityProviderConfigV1 = z.infer<typeof ManagedGitHubIdentityProviderConfigV1Schema>;

/**
 * Safe owner-administration projection. Creation and OIDC configuration inputs
 * remain OIDC-specific; the GitHub arm exposes only the existing installation
 * reference needed to administer that explicit identity consumer.
 */
export const ManagedOidcIdentityProviderV1Schema = lazyZodSchema(() => z.object({
  ...ManagedIdentityProviderCommonFieldsV1,
  kind: z.literal('oidc'),
  config: ManagedOidcProviderConfigV1Schema,
  secret: z.object({
    configured: z.boolean(),
    health: z.enum(['configured', 'missing', 'unreadable']),
  }).strict(),
}).strict());
export type ManagedOidcIdentityProviderV1 = z.infer<typeof ManagedOidcIdentityProviderV1Schema>;

export const ManagedIdentityProviderV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ManagedOidcIdentityProviderV1Schema,
  z.object({
    ...ManagedIdentityProviderCommonFieldsV1,
    kind: z.literal('github_app_identity'),
    config: ManagedGitHubIdentityProviderConfigV1Schema,
    githubAppInstallationId: ProviderIdSchema,
  }).strict(),
]));
export type ManagedIdentityProviderV1 = z.infer<typeof ManagedIdentityProviderV1Schema>;

export const ManagedIdentityProvidersListInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
}).strict());
export const ManagedIdentityProvidersListResultV1Schema = lazyZodSchema(() => z.object({
  items: z.array(ManagedIdentityProviderV1Schema),
  unreadableCount: z.number().int().min(0),
}).strict());

export const ManagedIdentityProviderCreateInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  displayName: ProviderDisplayNameSchema,
  config: ManagedOidcProviderCreateConfigV1Schema,
  clientSecret: z.string().min(1),
}).strict());

export const ManagedIdentityProviderUpdateInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  id: ProviderIdSchema,
  expectedRevision: z.number().int().positive(),
  displayName: ProviderDisplayNameSchema.optional(),
  config: ManagedOidcProviderConfigV1Schema.optional(),
}).strict().refine(
  (value) => value.displayName !== undefined || value.config !== undefined,
  'A provider update must change displayName or config',
));

export const ManagedIdentityProviderSecretReplaceInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  id: ProviderIdSchema,
  expectedRevision: z.number().int().positive(),
  clientSecret: z.string().min(1),
}).strict());

export const ManagedIdentityProviderLifecycleInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  id: ProviderIdSchema,
  expectedRevision: z.number().int().positive(),
  expectedSecurityRevision: z.number().int().positive(),
}).strict());

export const ManagedIdentityProviderTestStartInputV1Schema = ManagedIdentityProviderLifecycleInputV1Schema;
export const ManagedIdentityProviderTestStartResultV1Schema = lazyZodSchema(() => z.object({
  authorizeUrl: z.url(),
  attemptId: NonEmptyStringSchema,
}).strict());

export const ManagedIdentityProviderTestConsumeInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  id: ProviderIdSchema,
  resultHandle: NonEmptyStringSchema,
}).strict());
export const ManagedIdentityProviderTestConsumeResultV1Schema = lazyZodSchema(() => z.object({
  provider: ManagedOidcIdentityProviderV1Schema,
  testedAt: z.number().int(),
  subjectPresent: z.literal(true),
  /** Absent when the tested provider produced no sanitized diagnostics. */
  diagnostics: IdentityConnectionTestDiagnosticsV1Schema.optional(),
}).strict());

export const ManagedIdentityProviderRemovePreflightInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  id: ProviderIdSchema,
  expectedRevision: z.number().int().positive(),
}).strict());

export const ManagedIdentityProviderRemovePreflightResultV1Schema = lazyZodSchema(() => z.object({
  provider: ManagedIdentityProviderV1Schema,
  canRemove: z.boolean(),
  blockers: z.object({
    identityCount: z.number().int().min(0),
    connectionCount: z.number().int().min(0),
    affectedAccountIds: z.array(z.string().min(1)),
  }).strict(),
}).strict());

export const ManagedIdentityProviderRemoveResultV1Schema = lazyZodSchema(() => z.object({
  outcome: z.literal('removed'),
}).strict());

export const ManagedIdentityProviderErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'identity_provider_forbidden',
  'identity_provider_not_found',
  'identity_provider_unreadable',
  'identity_provider_invalid',
  'identity_provider_revision_conflict',
  'identity_provider_issuer_immutable',
  'identity_provider_in_use',
  'identity_provider_disabled',
  'oidc_discovery_failed',
  'oidc_issuer_mismatch',
  'oidc_endpoint_forbidden',
]));
export type ManagedIdentityProviderErrorCodeV1 = z.infer<typeof ManagedIdentityProviderErrorCodeV1Schema>;

export const ManagedIdentityProviderErrorV1Schema = lazyZodSchema(() => z.object({
  error: ManagedIdentityProviderErrorCodeV1Schema,
  current: ManagedIdentityProviderV1Schema.nullable().optional(),
  blockers: z.object({
    identityCount: z.number().int().min(0),
    connectionCount: z.number().int().min(0),
  }).strict().optional(),
}).strict());

export const MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1 = [
  'identity.providers.list',
  'identity.providers.create',
  'identity.providers.update',
  'identity.providers.secret.replace',
  'identity.providers.validate',
  'identity.providers.test.start',
  'identity.providers.test.consume',
  'identity.providers.enable',
  'identity.providers.disable',
  'identity.providers.remove.preview',
  'identity.providers.remove',
] as const;
export type ManagedIdentityProviderActionIdV1 = typeof MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1[number];
export const ManagedIdentityProviderActionIdV1Schema = lazyZodSchema(() => z.enum(MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1));

export const MANAGED_IDENTITY_PROVIDER_ACTION_PATHS_V1 = Object.freeze({
  'identity.providers.list': '/v1/identity/providers/list',
  'identity.providers.create': '/v1/identity/providers/create',
  'identity.providers.update': '/v1/identity/providers/update',
  'identity.providers.secret.replace': '/v1/identity/providers/secret/replace',
  'identity.providers.validate': '/v1/identity/providers/validate',
  'identity.providers.test.start': '/v1/identity/providers/test/start',
  'identity.providers.test.consume': '/v1/identity/providers/test/consume',
  'identity.providers.enable': '/v1/identity/providers/enable',
  'identity.providers.disable': '/v1/identity/providers/disable',
  'identity.providers.remove.preview': '/v1/identity/providers/remove/preflight',
  'identity.providers.remove': '/v1/identity/providers/remove',
} satisfies Readonly<Record<ManagedIdentityProviderActionIdV1, string>>);

export const MANAGED_IDENTITY_PROVIDER_ACTION_INPUT_SCHEMAS_V1 = Object.freeze({
  'identity.providers.list': ManagedIdentityProvidersListInputV1Schema,
  'identity.providers.create': ManagedIdentityProviderCreateInputV1Schema,
  'identity.providers.update': ManagedIdentityProviderUpdateInputV1Schema,
  'identity.providers.secret.replace': ManagedIdentityProviderSecretReplaceInputV1Schema,
  'identity.providers.validate': ManagedIdentityProviderLifecycleInputV1Schema,
  'identity.providers.test.start': ManagedIdentityProviderTestStartInputV1Schema,
  'identity.providers.test.consume': ManagedIdentityProviderTestConsumeInputV1Schema,
  'identity.providers.enable': ManagedIdentityProviderLifecycleInputV1Schema,
  'identity.providers.disable': ManagedIdentityProviderLifecycleInputV1Schema,
  'identity.providers.remove.preview': ManagedIdentityProviderRemovePreflightInputV1Schema,
  'identity.providers.remove': ManagedIdentityProviderRemovePreflightInputV1Schema,
} satisfies Readonly<Record<ManagedIdentityProviderActionIdV1, z.ZodTypeAny>>);

export const MANAGED_IDENTITY_PROVIDER_ACTION_OUTPUT_SCHEMAS_V1 = Object.freeze({
  'identity.providers.list': ManagedIdentityProvidersListResultV1Schema,
  'identity.providers.create': ManagedOidcIdentityProviderV1Schema,
  'identity.providers.update': ManagedOidcIdentityProviderV1Schema,
  'identity.providers.secret.replace': ManagedOidcIdentityProviderV1Schema,
  'identity.providers.validate': ManagedOidcIdentityProviderV1Schema,
  'identity.providers.test.start': ManagedIdentityProviderTestStartResultV1Schema,
  'identity.providers.test.consume': ManagedIdentityProviderTestConsumeResultV1Schema,
  'identity.providers.enable': ManagedIdentityProviderV1Schema,
  'identity.providers.disable': ManagedIdentityProviderV1Schema,
  'identity.providers.remove.preview': ManagedIdentityProviderRemovePreflightResultV1Schema,
  'identity.providers.remove': ManagedIdentityProviderRemoveResultV1Schema,
} satisfies Readonly<Record<ManagedIdentityProviderActionIdV1, z.ZodTypeAny>>);

/** Domain read used by the human removal-impact confirmation flow. */
