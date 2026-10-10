import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { CanonicalGitHubHostV1Schema } from '../../identity/githubApps.js';

import {
  AccountEncryptionModeSchema,
  EncryptionStoragePolicySchema,
} from '../../features/payload/capabilities/encryptionCapabilities.js';

/**
 * Who may create a Team on this Home. This can only narrow a deployed Teams
 * capability; it never enables one.
 */
export const TeamCreationPolicyV1Schema = lazyZodSchema(() => z.enum(['self_service', 'managed_only', 'disabled']));
export type TeamCreationPolicyV1 = z.infer<typeof TeamCreationPolicyV1Schema>;

/**
 * The persisted default, and the value every unreadable or absent policy falls
 * back to. Team creation must never widen through a missing or damaged row.
 */
export const HOME_TEAM_CREATION_POLICY_DEFAULT_V1: TeamCreationPolicyV1 = 'managed_only';

/**
 * Reads the stored Team-creation decision defensively. Absent, malformed, and
 * unknown values resolve to the restrictive default; only an exact known value
 * can widen creation.
 */
export function readTeamCreationPolicyV1(value: unknown): TeamCreationPolicyV1 {
  const parsed = TeamCreationPolicyV1Schema.safeParse(value);
  return parsed.success ? parsed.data : HOME_TEAM_CREATION_POLICY_DEFAULT_V1;
}

/**
 * Whether members who belong to no Team are shown the Teams destination. A Home
 * that never stored the choice shows it: absent means on. Members of a Team and
 * Home administrators are always shown it.
 */
export const HOME_TEAMS_VISIBLE_TO_MEMBERS_DEFAULT_V1 = true;

/** Who may obtain an Account on this Home, narrowest first. */
export const HomeAdmissionModeV1Schema = lazyZodSchema(() => z.enum(['closed', 'invitation_only', 'self_service']));
export type HomeAdmissionModeV1 = z.infer<typeof HomeAdmissionModeV1Schema>;

/**
 * The Home may disable its sign-in service or inherit the deployment's. It can
 * never select another issuer, so this narrowing carries no issuer fields.
 */
export const HomeSignInServiceNarrowingV1Schema = lazyZodSchema(() => z.object({
  mode: z.literal('disabled'),
}).strict());

const HomeAuthenticationMethodIdV1Schema = lazyZodSchema(() => z.string().min(1).max(128).refine(
  (value) => value === value.trim().toLowerCase(),
  { message: 'Authentication method IDs must be canonical lowercase identifiers.' },
));

/**
 * The bounded Home authentication/storage/admission policy document.
 *
 * Every field is optional and an absent field inherits the deployment. A present
 * field decides in both directions (plan `2026-09-26-home-owner-console` §3.4,
 * AM-4) but only where the deployment left the matching env key unset: an
 * explicitly set key is a lock the document can never override (D-1).
 *
 * - `enabledMethodIds` lists the methods offered. A listed method whose enable
 *   key the deployment left unset is turned on; an unlisted method is off.
 * - `permittedAccountModes` including `plain` turns keyless Accounts on where
 *   the deployment left that unset.
 * - `anonymousSignup` and `storagePolicy` set their deployment keys where unset;
 *   the storage policy applies at the next server start.
 *
 * The effective method and mode sets are resolved by the canonical `authPolicy`
 * owner and the encryption owner; this codec only owns storage shape and the
 * document's internal consistency.
 */
export const HomeAuthenticationPolicyV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  enabledMethodIds: z.array(HomeAuthenticationMethodIdV1Schema).min(1).optional(),
  permittedAccountModes: z.array(AccountEncryptionModeSchema).min(1).optional(),
  recommendedProvisioningMode: AccountEncryptionModeSchema.optional(),
  admission: HomeAdmissionModeV1Schema.optional(),
  signInService: HomeSignInServiceNarrowingV1Schema.nullable().optional(),
  /** Key-only (anonymous) signup; `AUTH_ANONYMOUS_SIGNUP_ENABLED` where the deployment leaves it unset. */
  anonymousSignup: z.boolean().optional(),
  /** Which Accounts may store data without E2EE; applies at the next server start. */
  storagePolicy: EncryptionStoragePolicySchema.optional(),
}).strict().superRefine((policy, ctx) => {
  if (policy.enabledMethodIds && new Set(policy.enabledMethodIds).size !== policy.enabledMethodIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['enabledMethodIds'],
      message: 'Enabled authentication method IDs must be unique.',
    });
  }
  if (policy.permittedAccountModes && new Set(policy.permittedAccountModes).size !== policy.permittedAccountModes.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['permittedAccountModes'],
      message: 'Permitted Account modes must be unique.',
    });
  }
  if (
    policy.recommendedProvisioningMode
    && policy.permittedAccountModes
    && !policy.permittedAccountModes.includes(policy.recommendedProvisioningMode)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recommendedProvisioningMode'],
      message: 'The recommended provisioning mode must be one of the permitted Account modes.',
    });
  }
}));

export type HomeAuthenticationPolicyV1 = z.infer<typeof HomeAuthenticationPolicyV1Schema>;

/**
 * How the stored authentication narrowing reads right now.
 *
 * `unreadable` exists because a document this deployment can no longer parse
 * must surface as an actionable configuration problem. Collapsing it into
 * `inherited` would silently broaden sign-in back to the deployment ceiling.
 */
export type HomeAuthenticationPolicyReadV1 =
  | Readonly<{ status: 'inherited' }>
  | Readonly<{ status: 'narrowed'; policy: HomeAuthenticationPolicyV1 }>
  | Readonly<{ status: 'unreadable' }>;

export function readHomeAuthenticationPolicyV1(value: unknown): HomeAuthenticationPolicyReadV1 {
  if (value === null || value === undefined) return { status: 'inherited' };
  const parsed = HomeAuthenticationPolicyV1Schema.safeParse(value);
  return parsed.success ? { status: 'narrowed', policy: parsed.data } : { status: 'unreadable' };
}

export const ManagedIdentityProviderKindV1Schema = lazyZodSchema(() => z.enum([
  'oidc',
  'workos_sso',
  'github_app_identity',
]));
export type ManagedIdentityProviderKindV1 = z.infer<typeof ManagedIdentityProviderKindV1Schema>;

const UniqueManagedIdentityProviderKindsV1Schema = lazyZodSchema(() => z.array(ManagedIdentityProviderKindV1Schema).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Managed identity-provider kinds must be unique.' });
  }
}));

const UniqueGitHubEnterpriseOriginsV1Schema = lazyZodSchema(() => z.array(CanonicalGitHubHostV1Schema).superRefine(
  (values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'GitHub Enterprise origins must be unique.' });
    }
  },
));

/** Home-wide ceiling for Team-owned or Team-bound provider instances. */
export const HomeTeamProviderPolicyV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  allowedTeamProviderKinds: UniqueManagedIdentityProviderKindsV1Schema,
  teamJitAllowed: z.boolean(),
  approvedGitHubEnterpriseOrigins: UniqueGitHubEnterpriseOriginsV1Schema,
}).strict());
export type HomeTeamProviderPolicyV1 = z.infer<typeof HomeTeamProviderPolicyV1Schema>;

const UniqueNonEmptyStringsV1Schema = lazyZodSchema(() => z.array(z.string().trim().min(1)).min(1).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Policy entries must be unique.' });
  }
}));
const UniquePortsV1Schema = lazyZodSchema(() => z.array(z.number().int().min(1).max(65535)).min(1).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Policy ports must be unique.' });
  }
}));

/** A stored Home policy may only narrow the deployment operator's outbound ceiling. */
export const HomeIdentityNetworkPolicyV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.object({ v: z.literal(1), mode: z.literal('public_only') }).strict(),
  z.object({
    v: z.literal(1),
    mode: z.literal('private_allowlist'),
    hostnames: UniqueNonEmptyStringsV1Schema,
    cidrs: UniqueNonEmptyStringsV1Schema,
    ports: UniquePortsV1Schema,
  }).strict(),
]));
export type HomeIdentityNetworkPolicyV1 = z.infer<typeof HomeIdentityNetworkPolicyV1Schema>;

export type HomeTeamProviderPolicyReadV1 =
  | Readonly<{ status: 'inherited' }>
  | Readonly<{ status: 'narrowed'; policy: HomeTeamProviderPolicyV1 }>
  | Readonly<{ status: 'unreadable' }>;

export type HomeIdentityNetworkPolicyReadV1 =
  | Readonly<{ status: 'inherited' }>
  | Readonly<{ status: 'narrowed'; policy: HomeIdentityNetworkPolicyV1 }>
  | Readonly<{ status: 'unreadable' }>;

export function readHomeTeamProviderPolicyV1(value: unknown): HomeTeamProviderPolicyReadV1 {
  if (value === null || value === undefined) return { status: 'inherited' };
  const parsed = HomeTeamProviderPolicyV1Schema.safeParse(value);
  return parsed.success ? { status: 'narrowed', policy: parsed.data } : { status: 'unreadable' };
}

export function readHomeIdentityNetworkPolicyV1(value: unknown): HomeIdentityNetworkPolicyReadV1 {
  if (value === null || value === undefined) return { status: 'inherited' };
  const parsed = HomeIdentityNetworkPolicyV1Schema.safeParse(value);
  return parsed.success ? { status: 'narrowed', policy: parsed.data } : { status: 'unreadable' };
}

/**
 * One partial-patch policy mutation guarded by the singleton's revision.
 *
 * `expectedRevision` is `0` for a Home whose policy row does not exist yet.
 * Every field is decoded before persistence; a mixed patch is authorized and
 * committed atomically by the Home governance owner.
 */
export const HomeGovernancePolicySetInputV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.number().int().min(0),
  teamCreationPolicy: TeamCreationPolicyV1Schema.optional(),
  teamsVisibleToMembers: z.boolean().optional(),
  authenticationPolicy: HomeAuthenticationPolicyV1Schema.nullable().optional(),
  teamProviderPolicy: HomeTeamProviderPolicyV1Schema.nullable().optional(),
  identityNetworkPolicy: HomeIdentityNetworkPolicyV1Schema.nullable().optional(),
  /**
   * The owner saw and accepted the consequence of widening sign-in, admission or
   * storage policy. A widening patch without it is refused with
   * `home_policy_widening_unconfirmed` and changes nothing; narrowing needs none.
   */
  confirmWidening: z.literal(true).optional(),
}).strict().refine(
  (input) => input.teamCreationPolicy !== undefined
    || input.teamsVisibleToMembers !== undefined
    || input.authenticationPolicy !== undefined
    || input.teamProviderPolicy !== undefined
    || input.identityNetworkPolicy !== undefined,
  { message: 'A Home policy patch must change at least one field.' },
));

export type HomeGovernancePolicySetInputV1 = z.infer<typeof HomeGovernancePolicySetInputV1Schema>;
