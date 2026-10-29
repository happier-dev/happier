import { MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1 } from './providersActionIdsV1.js';
export { MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1 } from './providersActionIdsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { IdentityConnectionTestDiagnosticsV1Schema } from './testDiagnostics.js';

const ProviderIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const NonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const ProviderDisplayNameSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

/** Exact Team identity binding visible only in authorized owner administration. */
export const ManagedIdentityProviderTeamConsumerV1Schema = lazyZodSchema(() => z.strictObject({
  team: z.strictObject({
    id: NonEmptyStringSchema,
    name: z.string(),
  }),
  binding: z.strictObject({
    kind: z.literal('identity_connection'),
    id: NonEmptyStringSchema,
    enabled: z.boolean(),
  }),
}));
export type ManagedIdentityProviderTeamConsumerV1 = z.infer<typeof ManagedIdentityProviderTeamConsumerV1Schema>;

export const ManagedIdentityProviderOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('home') }),
  z.strictObject({ kind: z.literal('team'), teamId: NonEmptyStringSchema }),
]));
export type ManagedIdentityProviderOwnerV1 = z.infer<typeof ManagedIdentityProviderOwnerV1Schema>;
const ManagedIdentityProviderOwnerInputV1Schema = lazyZodSchema(() => z._default(ManagedIdentityProviderOwnerV1Schema, { kind: 'home' }));

const ManagedOidcProviderConfigFieldsV1 = {
  v: z.literal(1),
  kind: z.literal('oidc'),
  issuer: NonEmptyStringSchema,
  clientId: NonEmptyStringSchema,
  clientAuthenticationMethod: z.enum(['client_secret_post', 'client_secret_basic']),
  scopes: lazyZodSchema(() => NonEmptyStringSchema.check(z.refine((value) => value.split(/\s+/u).some((scope) => scope.toLowerCase() === 'openid'), 'OIDC scopes must include openid'))),
  httpTimeoutSeconds: z.number().check(z.int(), z.minimum(1), z.maximum(120)),
  claims: z.strictObject({
    login: NonEmptyStringSchema,
    email: NonEmptyStringSchema,
    groups: NonEmptyStringSchema,
  }),
  allow: z.strictObject({
    usersAllowlist: z.array(NonEmptyStringSchema),
    emailDomains: z.array(NonEmptyStringSchema),
    groupsAny: z.array(NonEmptyStringSchema),
    groupsAll: z.array(NonEmptyStringSchema),
  }),
  fetchUserInfo: z.boolean(),
  storeRefreshToken: z.boolean(),
  ui: z.strictObject({
    buttonColor: z.nullable(NonEmptyStringSchema),
    iconHint: z.nullable(NonEmptyStringSchema),
  }),
} as const;

/** Canonical current provider document. Security-effective choices are always explicit. */
export const ManagedOidcProviderConfigV1Schema = lazyZodSchema(() => z.strictObject(ManagedOidcProviderConfigFieldsV1));
export type ManagedOidcProviderConfigV1 = z.infer<typeof ManagedOidcProviderConfigV1Schema>;

/**
 * Creation is the only wire boundary that accepts the predecessor omission. It
 * immediately materializes the explicit current value before persistence.
 */
const ManagedOidcProviderCreateConfigV1Schema = lazyZodSchema(() => z.strictObject({
  ...ManagedOidcProviderConfigFieldsV1,
  clientAuthenticationMethod: z._default(ManagedOidcProviderConfigFieldsV1.clientAuthenticationMethod, 'client_secret_post'),
}));

const ManagedIdentityProviderCommonFieldsV1 = {
  v: z.literal(1),
  owner: ManagedIdentityProviderOwnerV1Schema,
  id: ProviderIdSchema,
  displayName: ProviderDisplayNameSchema,
  enabled: z.boolean(),
  firstEnabledAt: z.nullable(z.number().check(z.int())),
  securityRevision: z.number().check(z.int(), z.positive()),
  revision: z.number().check(z.int(), z.positive()),
  lastSuccessfulTest: z.nullable(z.strictObject({
    at: z.number().check(z.int()),
    testedSecurityRevision: z.number().check(z.int(), z.positive()),
    current: z.boolean(),
  })),
  createdByAccountId: z.nullable(z.string().check(z.minLength(1))),
  createdAt: z.number().check(z.int()),
  updatedAt: z.number().check(z.int()),
  teamConsumers: z._default(z.array(ManagedIdentityProviderTeamConsumerV1Schema), []),
  /**
   * The redirect URI the administrator must register at the identity provider.
   * Derived from the Home's public server URL and the provider id, never
   * persisted; absent only when the Home has no public server URL configured.
   */
  callbackUrl: z.optional(z.string().check(z.url())),
} as const;

export const ManagedGitHubIdentityProviderConfigV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('github_app_identity'),
}));
export type ManagedGitHubIdentityProviderConfigV1 = z.infer<typeof ManagedGitHubIdentityProviderConfigV1Schema>;

/**
 * Safe owner-administration projection. Creation and OIDC configuration inputs
 * remain OIDC-specific; the GitHub arm exposes only the existing installation
 * reference needed to administer that explicit identity consumer.
 */
export const ManagedOidcIdentityProviderV1Schema = lazyZodSchema(() => z.strictObject({
  ...ManagedIdentityProviderCommonFieldsV1,
  kind: z.literal('oidc'),
  config: ManagedOidcProviderConfigV1Schema,
  secret: z.strictObject({
    configured: z.boolean(),
    health: z.enum(['configured', 'missing', 'unreadable']),
  }),
}));
export type ManagedOidcIdentityProviderV1 = z.infer<typeof ManagedOidcIdentityProviderV1Schema>;

export const ManagedIdentityProviderV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ManagedOidcIdentityProviderV1Schema,
  z.strictObject({
    ...ManagedIdentityProviderCommonFieldsV1,
    kind: z.literal('github_app_identity'),
    config: ManagedGitHubIdentityProviderConfigV1Schema,
    githubAppInstallationId: ProviderIdSchema,
  }),
]));
export type ManagedIdentityProviderV1 = z.infer<typeof ManagedIdentityProviderV1Schema>;

export const ManagedIdentityProvidersListInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
}));
export const ManagedIdentityProvidersListResultV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(ManagedIdentityProviderV1Schema),
  unreadableCount: z.number().check(z.int(), z.minimum(0)),
}));

export const ManagedIdentityProviderCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  displayName: ProviderDisplayNameSchema,
  config: ManagedOidcProviderCreateConfigV1Schema,
  clientSecret: z.string().check(z.minLength(1)),
}));

export const ManagedIdentityProviderUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  id: ProviderIdSchema,
  expectedRevision: z.number().check(z.int(), z.positive()),
  displayName: z.optional(ProviderDisplayNameSchema),
  config: z.optional(ManagedOidcProviderConfigV1Schema),
}).check(z.refine((value) => value.displayName !== undefined || value.config !== undefined, 'A provider update must change displayName or config')));

export const ManagedIdentityProviderSecretReplaceInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  id: ProviderIdSchema,
  expectedRevision: z.number().check(z.int(), z.positive()),
  clientSecret: z.string().check(z.minLength(1)),
}));

export const ManagedIdentityProviderLifecycleInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  id: ProviderIdSchema,
  expectedRevision: z.number().check(z.int(), z.positive()),
  expectedSecurityRevision: z.number().check(z.int(), z.positive()),
}));

export const ManagedIdentityProviderTestStartInputV1Schema = ManagedIdentityProviderLifecycleInputV1Schema;
export const ManagedIdentityProviderTestStartResultV1Schema = lazyZodSchema(() => z.strictObject({
  authorizeUrl: z.url(),
  attemptId: NonEmptyStringSchema,
}));

export const ManagedIdentityProviderTestConsumeInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  id: ProviderIdSchema,
  resultHandle: NonEmptyStringSchema,
}));
export const ManagedIdentityProviderTestConsumeResultV1Schema = lazyZodSchema(() => z.strictObject({
  provider: ManagedOidcIdentityProviderV1Schema,
  testedAt: z.number().check(z.int()),
  subjectPresent: z.literal(true),
  /** Absent when the tested provider produced no sanitized diagnostics. */
  diagnostics: z.optional(IdentityConnectionTestDiagnosticsV1Schema),
}));

export const ManagedIdentityProviderRemovePreflightInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedIdentityProviderOwnerInputV1Schema,
  id: ProviderIdSchema,
  expectedRevision: z.number().check(z.int(), z.positive()),
}));

export const ManagedIdentityProviderRemovePreflightResultV1Schema = lazyZodSchema(() => z.strictObject({
  provider: ManagedIdentityProviderV1Schema,
  canRemove: z.boolean(),
  blockers: z.strictObject({
    identityCount: z.number().check(z.int(), z.minimum(0)),
    connectionCount: z.number().check(z.int(), z.minimum(0)),
    affectedAccountIds: z.array(z.string().check(z.minLength(1))),
  }),
}));

export const ManagedIdentityProviderRemoveResultV1Schema = lazyZodSchema(() => z.strictObject({
  outcome: z.literal('removed'),
}));

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

export const ManagedIdentityProviderErrorV1Schema = lazyZodSchema(() => z.strictObject({
  error: ManagedIdentityProviderErrorCodeV1Schema,
  current: z.optional(z.nullable(ManagedIdentityProviderV1Schema)),
  blockers: z.optional(z.strictObject({
    identityCount: z.number().check(z.int(), z.minimum(0)),
    connectionCount: z.number().check(z.int(), z.minimum(0)),
  })),
}));
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
} satisfies Readonly<Record<ManagedIdentityProviderActionIdV1, z.ZodMiniType>>);

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
} satisfies Readonly<Record<ManagedIdentityProviderActionIdV1, z.ZodMiniType>>);

/** Domain read used by the human removal-impact confirmation flow. */
