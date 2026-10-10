import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const ManagedGitHubAppOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('home') }).strict(),
  z.object({ kind: z.literal('team'), teamId: z.string().trim().min(1) }).strict(),
]));
export type ManagedGitHubAppOwnerV1 = z.infer<typeof ManagedGitHubAppOwnerV1Schema>;

const PositiveDecimalIdSchema = lazyZodSchema(() => z.string().regex(/^[1-9][0-9]*$/u));
const GitHubTextSchema = lazyZodSchema(() => z.string().trim().min(1).max(256));
export const CanonicalGitHubHostV1Schema = lazyZodSchema(() => z.string().max(512).url().superRefine((value, ctx) => {
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
}));

export const ManagedGitHubAppSecretHealthV1Schema = lazyZodSchema(() => z.object({
  clientSecretConfigured: z.boolean(),
  privateKeyConfigured: z.boolean(),
  webhookSecretConfigured: z.boolean(),
}).strict());

/** Exact Team consumer relation for one verified installation. */
export const ManagedGitHubAppTeamConsumerV1Schema = lazyZodSchema(() => z.object({
  team: z.object({
    id: z.string().min(1),
    name: z.string(),
  }).strict(),
  binding: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('identity_connection'),
      id: z.string().min(1),
      providerInstanceId: z.string().min(1),
      enabled: z.boolean(),
    }).strict(),
    z.object({
      kind: z.literal('directory_source'),
      id: z.string().min(1),
      state: z.enum(['initializing', 'active', 'paused', 'needs_attention']),
    }).strict(),
  ]),
}).strict());
export type ManagedGitHubAppTeamConsumerV1 = z.infer<typeof ManagedGitHubAppTeamConsumerV1Schema>;

export const ManagedGitHubAppRegistrationV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  owner: ManagedGitHubAppOwnerV1Schema,
  githubHost: CanonicalGitHubHostV1Schema,
  githubAppId: PositiveDecimalIdSchema,
  githubClientId: GitHubTextSchema,
  githubAppSlug: GitHubTextSchema.nullable(),
  githubOwnerId: PositiveDecimalIdSchema.nullable(),
  githubOwnerLogin: GitHubTextSchema.nullable(),
  revision: z.number().int().positive(),
  securityRevision: z.number().int().positive(),
  state: z.enum(['draft', 'verified', 'disabled', 'needs_attention']),
  secretHealth: ManagedGitHubAppSecretHealthV1Schema,
  lastVerifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /**
   * The user-authorization callback URL to register on the GitHub App. Derived
   * from the Home's public server URL, never persisted; absent only when the
   * Home has no public server URL configured.
   */
  callbackUrl: z.string().url().optional(),
}).strict());
export type ManagedGitHubAppRegistrationV1 = z.infer<typeof ManagedGitHubAppRegistrationV1Schema>;

/**
 * What a set of installation consumers requires from GitHub, and what
 * the last verification found missing. The Home computes it from the same
 * requirement table its readiness checks enforce, so an administrator repairing
 * least privilege reads the Home's own rule rather than a hand-kept list.
 */
export const ManagedGitHubAppRequirementsV1Schema = lazyZodSchema(() => z.object({
  permissions: z.record(z.string(), z.enum(['read', 'write'])),
  events: z.array(z.string().min(1)),
  missingPermissions: z.array(z.object({
    permission: z.string().min(1),
    required: z.enum(['read', 'write']),
  }).strict()),
  missingEvents: z.array(z.string().min(1)),
}).strict());
export type ManagedGitHubAppRequirementsV1 = z.infer<typeof ManagedGitHubAppRequirementsV1Schema>;

export const ManagedGitHubAppInstallationV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  registrationId: z.string().min(1),
  githubInstallationId: PositiveDecimalIdSchema,
  githubOrganizationId: PositiveDecimalIdSchema,
  githubOrganizationLogin: GitHubTextSchema,
  repositorySelection: z.enum(['all', 'selected']),
  revision: z.number().int().positive(),
  state: z.string().min(1),
  verifiedPermissions: z.record(z.string(), z.enum(['read', 'write'])),
  verifiedEvents: z.array(z.string().min(1)),
  suspendedAt: z.iso.datetime().nullable(),
  lastVerifiedAt: z.iso.datetime().nullable(),
  teamConsumers: z.array(ManagedGitHubAppTeamConsumerV1Schema).default([]),
  /** Access required by enabled consumers; absent on older Homes. */
  requirements: ManagedGitHubAppRequirementsV1Schema.optional(),
  /** Setup/repair preview for all configured consumers, including disabled or paused ones. */
  prospectiveRequirements: ManagedGitHubAppRequirementsV1Schema.optional(),
}).strict());
export type ManagedGitHubAppInstallationV1 = z.infer<typeof ManagedGitHubAppInstallationV1Schema>;

export const ManagedGitHubAppsListInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedGitHubAppOwnerV1Schema,
}).strict());
export const ManagedGitHubAppsListOutputV1Schema = lazyZodSchema(() => z.object({
  registrations: z.array(ManagedGitHubAppRegistrationV1Schema),
  installations: z.array(ManagedGitHubAppInstallationV1Schema),
}).strict());

export const ManagedGitHubAppCreateInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedGitHubAppOwnerV1Schema,
  githubHost: CanonicalGitHubHostV1Schema,
  githubAppId: PositiveDecimalIdSchema,
  githubClientId: GitHubTextSchema,
  githubAppSlug: GitHubTextSchema.nullable().optional(),
  githubOwnerId: PositiveDecimalIdSchema.nullable().optional(),
  githubOwnerLogin: GitHubTextSchema.nullable().optional(),
  secrets: z.object({
    clientSecret: z.string().min(1).optional(),
    privateKey: z.string().min(1),
    webhookSecret: z.string().min(1).optional(),
  }).strict(),
}).strict());
export const ManagedGitHubAppCreateOutputV1Schema = lazyZodSchema(() => z.object({
  registration: ManagedGitHubAppRegistrationV1Schema,
}).strict());

export const ManagedGitHubAppManifestSetupStartInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedGitHubAppOwnerV1Schema,
  appName: z.string().trim().min(1).max(100),
  githubOwner: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('account') }).strict(),
    z.object({ kind: z.literal('organization'), login: z.string().trim().min(1).max(100) }).strict(),
  ]),
}).strict());
export const ManagedGitHubAppManifestSetupStartOutputV1Schema = lazyZodSchema(() => z.object({
  authorizeUrl: z.url(),
}).strict());

const ManagedGitHubAppSecretReplacementV1Schema = lazyZodSchema(() => z.object({
  clientSecret: z.string().min(1).nullable().optional(),
  privateKey: z.string().min(1).nullable().optional(),
  webhookSecret: z.string().min(1).nullable().optional(),
}).strict());

export const ManagedGitHubAppUpdateInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedGitHubAppOwnerV1Schema,
  registrationId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  patch: z.object({
    githubClientId: GitHubTextSchema.optional(),
    githubAppSlug: GitHubTextSchema.nullable().optional(),
    githubOwnerLogin: GitHubTextSchema.nullable().optional(),
    secrets: ManagedGitHubAppSecretReplacementV1Schema.optional(),
  }).strict(),
}).strict());
export const ManagedGitHubAppUpdateOutputV1Schema = lazyZodSchema(() => z.object({
  registration: ManagedGitHubAppRegistrationV1Schema,
}).strict());

export const ManagedGitHubAppVerifyInstallationInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedGitHubAppOwnerV1Schema,
  registrationId: z.string().min(1),
  expectedRegistrationRevision: z.number().int().positive(),
  expectedInstallationRevision: z.number().int().min(0),
  githubInstallationId: PositiveDecimalIdSchema,
  githubOrganizationId: PositiveDecimalIdSchema,
}).strict());
export const ManagedGitHubAppVerifyInstallationOutputV1Schema = lazyZodSchema(() => z.object({
  authorizeUrl: z.url(),
  attemptId: z.string().min(1),
}).strict());

export const ManagedGitHubAppRemoveInputV1Schema = lazyZodSchema(() => z.object({
  owner: ManagedGitHubAppOwnerV1Schema,
  installationId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
}).strict());
export const ManagedGitHubAppRemoveOutputV1Schema = lazyZodSchema(() => z.object({ removed: z.literal(true) }).strict());

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
export const ManagedGitHubAppErrorV1Schema = lazyZodSchema(() => z.object({
  error: ManagedGitHubAppErrorCodeV1Schema,
  currentRevision: z.number().int().positive().nullable().optional(),
  blockers: z.object({
    identityProviderInstances: z.number().int().min(0),
    directorySources: z.number().int().min(0),
  }).strict().optional(),
}).strict());

export const MANAGED_GITHUB_APP_ACTION_IDS_V1 = [
  'identity.githubApps.list',
  'identity.githubApps.create',
  'identity.githubApps.manifestSetup.start',
  'identity.githubApps.update',
  'identity.githubApps.verifyInstallation',
  'identity.githubApps.remove',
] as const;
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
