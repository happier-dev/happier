import { MANAGED_GITHUB_APP_ACTION_IDS_V1 } from './githubAppsActionIdsV1.js';
export { MANAGED_GITHUB_APP_ACTION_IDS_V1 } from './githubAppsActionIdsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const ManagedGitHubAppOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('home') }),
  z.strictObject({ kind: z.literal('team'), teamId: z.string().check(z.trim(), z.minLength(1)) }),
]));
export type ManagedGitHubAppOwnerV1 = z.infer<typeof ManagedGitHubAppOwnerV1Schema>;

const PositiveDecimalIdSchema = lazyZodSchema(() => z.string().check(z.regex(/^[1-9][0-9]*$/u)));
const GitHubTextSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
export const CanonicalGitHubHostV1Schema = lazyZodSchema(() => z.string().check(z.maxLength(512), z.url(), z.superRefine((value, ctx) => {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || value !== parsed.origin.toLowerCase()
    ) {
      ctx.addIssue({ code: 'custom', message: 'GitHub hosts must be canonical HTTPS origins' });
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: 'GitHub hosts must be valid URLs' });
  }
})));

export const ManagedGitHubAppSecretHealthV1Schema = lazyZodSchema(() => z.strictObject({
  clientSecretConfigured: z.boolean(),
  privateKeyConfigured: z.boolean(),
  webhookSecretConfigured: z.boolean(),
}));

/** Exact Team consumer relation for one verified installation. */
export const ManagedGitHubAppTeamConsumerV1Schema = lazyZodSchema(() => z.strictObject({
  team: z.strictObject({
    id: z.string().check(z.minLength(1)),
    name: z.string(),
  }),
  binding: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('identity_connection'),
      id: z.string().check(z.minLength(1)),
      providerInstanceId: z.string().check(z.minLength(1)),
      enabled: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal('directory_source'),
      id: z.string().check(z.minLength(1)),
      state: z.enum(['initializing', 'active', 'paused', 'needs_attention']),
    }),
  ]),
}));
export type ManagedGitHubAppTeamConsumerV1 = z.infer<typeof ManagedGitHubAppTeamConsumerV1Schema>;

export const ManagedGitHubAppRegistrationV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  owner: ManagedGitHubAppOwnerV1Schema,
  githubHost: CanonicalGitHubHostV1Schema,
  githubAppId: PositiveDecimalIdSchema,
  githubClientId: GitHubTextSchema,
  githubAppSlug: z.nullable(GitHubTextSchema),
  githubOwnerId: z.nullable(PositiveDecimalIdSchema),
  githubOwnerLogin: z.nullable(GitHubTextSchema),
  revision: z.number().check(z.int(), z.positive()),
  securityRevision: z.number().check(z.int(), z.positive()),
  state: z.enum(['draft', 'verified', 'disabled', 'needs_attention']),
  secretHealth: ManagedGitHubAppSecretHealthV1Schema,
  lastVerifiedAt: z.nullable(z.iso.datetime()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /**
   * The user-authorization callback URL to register on the GitHub App. Derived
   * from the Home's public server URL, never persisted; absent only when the
   * Home has no public server URL configured.
   */
  callbackUrl: z.optional(z.string().check(z.url())),
}));
export type ManagedGitHubAppRegistrationV1 = z.infer<typeof ManagedGitHubAppRegistrationV1Schema>;

/**
 * What a set of installation consumers requires from GitHub, and what
 * the last verification found missing. The Home computes it from the same
 * requirement table its readiness checks enforce, so an administrator repairing
 * least privilege reads the Home's own rule rather than a hand-kept list.
 */
export const ManagedGitHubAppRequirementsV1Schema = lazyZodSchema(() => z.strictObject({
  permissions: z.record(z.string(), z.enum(['read', 'write'])),
  events: z.array(z.string().check(z.minLength(1))),
  missingPermissions: z.array(z.strictObject({
    permission: z.string().check(z.minLength(1)),
    required: z.enum(['read', 'write']),
  })),
  missingEvents: z.array(z.string().check(z.minLength(1))),
}));
export type ManagedGitHubAppRequirementsV1 = z.infer<typeof ManagedGitHubAppRequirementsV1Schema>;

export const ManagedGitHubAppInstallationV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  registrationId: z.string().check(z.minLength(1)),
  githubInstallationId: PositiveDecimalIdSchema,
  githubOrganizationId: PositiveDecimalIdSchema,
  githubOrganizationLogin: GitHubTextSchema,
  repositorySelection: z.enum(['all', 'selected']),
  revision: z.number().check(z.int(), z.positive()),
  state: z.string().check(z.minLength(1)),
  verifiedPermissions: z.record(z.string(), z.enum(['read', 'write'])),
  verifiedEvents: z.array(z.string().check(z.minLength(1))),
  suspendedAt: z.nullable(z.iso.datetime()),
  lastVerifiedAt: z.nullable(z.iso.datetime()),
  teamConsumers: z._default(z.array(ManagedGitHubAppTeamConsumerV1Schema), []),
  /** Access required by enabled consumers; absent on older Homes. */
  requirements: z.optional(ManagedGitHubAppRequirementsV1Schema),
  /** Setup/repair preview for all configured consumers, including disabled or paused ones. */
  prospectiveRequirements: z.optional(ManagedGitHubAppRequirementsV1Schema),
}));
export type ManagedGitHubAppInstallationV1 = z.infer<typeof ManagedGitHubAppInstallationV1Schema>;

export const ManagedGitHubAppsListInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedGitHubAppOwnerV1Schema,
}));
export const ManagedGitHubAppsListOutputV1Schema = lazyZodSchema(() => z.strictObject({
  registrations: z.array(ManagedGitHubAppRegistrationV1Schema),
  installations: z.array(ManagedGitHubAppInstallationV1Schema),
}));

export const ManagedGitHubAppCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedGitHubAppOwnerV1Schema,
  githubHost: CanonicalGitHubHostV1Schema,
  githubAppId: PositiveDecimalIdSchema,
  githubClientId: GitHubTextSchema,
  githubAppSlug: z.optional(z.nullable(GitHubTextSchema)),
  githubOwnerId: z.optional(z.nullable(PositiveDecimalIdSchema)),
  githubOwnerLogin: z.optional(z.nullable(GitHubTextSchema)),
  secrets: z.strictObject({
    clientSecret: z.optional(z.string().check(z.minLength(1))),
    privateKey: z.string().check(z.minLength(1)),
    webhookSecret: z.optional(z.string().check(z.minLength(1))),
  }),
}));
export const ManagedGitHubAppCreateOutputV1Schema = lazyZodSchema(() => z.strictObject({
  registration: ManagedGitHubAppRegistrationV1Schema,
}));

export const ManagedGitHubAppManifestSetupStartInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedGitHubAppOwnerV1Schema,
  appName: z.string().check(z.trim(), z.minLength(1), z.maxLength(100)),
  githubOwner: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('account') }),
    z.strictObject({ kind: z.literal('organization'), login: z.string().check(z.trim(), z.minLength(1), z.maxLength(100)) }),
  ]),
}));
export const ManagedGitHubAppManifestSetupStartOutputV1Schema = lazyZodSchema(() => z.strictObject({
  authorizeUrl: z.url(),
}));

const ManagedGitHubAppSecretReplacementV1Schema = lazyZodSchema(() => z.strictObject({
  clientSecret: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  privateKey: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  webhookSecret: z.optional(z.nullable(z.string().check(z.minLength(1)))),
}));

export const ManagedGitHubAppUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedGitHubAppOwnerV1Schema,
  registrationId: z.string().check(z.minLength(1)),
  expectedRevision: z.number().check(z.int(), z.positive()),
  patch: z.strictObject({
    githubClientId: z.optional(GitHubTextSchema),
    githubAppSlug: z.optional(z.nullable(GitHubTextSchema)),
    githubOwnerLogin: z.optional(z.nullable(GitHubTextSchema)),
    secrets: z.optional(ManagedGitHubAppSecretReplacementV1Schema),
  }),
}));
export const ManagedGitHubAppUpdateOutputV1Schema = lazyZodSchema(() => z.strictObject({
  registration: ManagedGitHubAppRegistrationV1Schema,
}));

export const ManagedGitHubAppVerifyInstallationInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedGitHubAppOwnerV1Schema,
  registrationId: z.string().check(z.minLength(1)),
  expectedRegistrationRevision: z.number().check(z.int(), z.positive()),
  expectedInstallationRevision: z.number().check(z.int(), z.minimum(0)),
  githubInstallationId: PositiveDecimalIdSchema,
  githubOrganizationId: PositiveDecimalIdSchema,
}));
export const ManagedGitHubAppVerifyInstallationOutputV1Schema = lazyZodSchema(() => z.strictObject({
  authorizeUrl: z.url(),
  attemptId: z.string().check(z.minLength(1)),
}));

export const ManagedGitHubAppRemoveInputV1Schema = lazyZodSchema(() => z.strictObject({
  owner: ManagedGitHubAppOwnerV1Schema,
  installationId: z.string().check(z.minLength(1)),
  expectedRevision: z.number().check(z.int(), z.positive()),
}));
export const ManagedGitHubAppRemoveOutputV1Schema = lazyZodSchema(() => z.strictObject({ removed: z.literal(true) }));

export const ManagedGitHubAppErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'github_app_forbidden',
  'github_app_not_found',
  'github_app_revision_conflict',
  'github_enterprise_origin_not_approved',
  'github_installation_revision_conflict',
  'github_app_not_configured',
  'github_manifest_exchange_failed',
  'github_app_already_registered',
  'github_installation_evidence_invalid',
  'github_app_mismatch',
  'github_installation_mismatch',
  'github_organization_mismatch',
  'github_permission_missing',
  'github_administrator_identity_required',
  'github_administrator_mismatch',
  'github_administrator_evidence_unavailable',
  'github_network_policy_changed',
  'github_installation_in_use',
]));
export type ManagedGitHubAppErrorCodeV1 = z.infer<typeof ManagedGitHubAppErrorCodeV1Schema>;
export const ManagedGitHubAppErrorV1Schema = lazyZodSchema(() => z.strictObject({
  error: ManagedGitHubAppErrorCodeV1Schema,
  currentRevision: z.optional(z.nullable(z.number().check(z.int(), z.positive()))),
  blockers: z.optional(z.strictObject({
    identityProviderInstances: z.number().check(z.int(), z.minimum(0)),
    directorySources: z.number().check(z.int(), z.minimum(0)),
  })),
}));
export type ManagedGitHubAppActionIdV1 = typeof MANAGED_GITHUB_APP_ACTION_IDS_V1[number];
export const ManagedGitHubAppActionIdV1Schema = lazyZodSchema(() => z.enum(MANAGED_GITHUB_APP_ACTION_IDS_V1));

export const MANAGED_GITHUB_APP_ACTION_PATHS_V1 = Object.freeze({
  'identity.githubApps.list': '/v1/identity/github-apps/list',
  'identity.githubApps.create': '/v1/identity/github-apps/create',
  'identity.githubApps.manifestSetup.start': '/v1/identity/github-apps/manifest-setup/start',
  'identity.githubApps.update': '/v1/identity/github-apps/update',
  'identity.githubApps.verifyInstallation': '/v1/identity/github-apps/verify-installation',
  'identity.githubApps.remove': '/v1/identity/github-apps/remove',
} satisfies Readonly<Record<ManagedGitHubAppActionIdV1, string>>);

export const MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1 = Object.freeze({
  'identity.githubApps.list': ManagedGitHubAppsListInputV1Schema,
  'identity.githubApps.create': ManagedGitHubAppCreateInputV1Schema,
  'identity.githubApps.manifestSetup.start': ManagedGitHubAppManifestSetupStartInputV1Schema,
  'identity.githubApps.update': ManagedGitHubAppUpdateInputV1Schema,
  'identity.githubApps.verifyInstallation': ManagedGitHubAppVerifyInstallationInputV1Schema,
  'identity.githubApps.remove': ManagedGitHubAppRemoveInputV1Schema,
});

export const MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1 = Object.freeze({
  'identity.githubApps.list': ManagedGitHubAppsListOutputV1Schema,
  'identity.githubApps.create': ManagedGitHubAppCreateOutputV1Schema,
  'identity.githubApps.manifestSetup.start': ManagedGitHubAppManifestSetupStartOutputV1Schema,
  'identity.githubApps.update': ManagedGitHubAppUpdateOutputV1Schema,
  'identity.githubApps.verifyInstallation': ManagedGitHubAppVerifyInstallationOutputV1Schema,
  'identity.githubApps.remove': ManagedGitHubAppRemoveOutputV1Schema,
});

export type ManagedGitHubAppsListInputV1 = z.infer<typeof ManagedGitHubAppsListInputV1Schema>;
export type ManagedGitHubAppsListOutputV1 = z.infer<typeof ManagedGitHubAppsListOutputV1Schema>;
export type ManagedGitHubAppCreateInputV1 = z.infer<typeof ManagedGitHubAppCreateInputV1Schema>;
export type ManagedGitHubAppCreateOutputV1 = z.infer<typeof ManagedGitHubAppCreateOutputV1Schema>;
export type ManagedGitHubAppManifestSetupStartInputV1 = z.infer<typeof ManagedGitHubAppManifestSetupStartInputV1Schema>;
export type ManagedGitHubAppManifestSetupStartOutputV1 = z.infer<typeof ManagedGitHubAppManifestSetupStartOutputV1Schema>;
export type ManagedGitHubAppUpdateInputV1 = z.infer<typeof ManagedGitHubAppUpdateInputV1Schema>;
export type ManagedGitHubAppUpdateOutputV1 = z.infer<typeof ManagedGitHubAppUpdateOutputV1Schema>;
export type ManagedGitHubAppVerifyInstallationInputV1 = z.infer<typeof ManagedGitHubAppVerifyInstallationInputV1Schema>;
export type ManagedGitHubAppVerifyInstallationOutputV1 = z.infer<typeof ManagedGitHubAppVerifyInstallationOutputV1Schema>;
export type ManagedGitHubAppRemoveInputV1 = z.infer<typeof ManagedGitHubAppRemoveInputV1Schema>;
export type ManagedGitHubAppRemoveOutputV1 = z.infer<typeof ManagedGitHubAppRemoveOutputV1Schema>;
