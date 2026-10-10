import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { HomeCapabilitiesV1Schema } from './capabilities.js';
import {
  HomeAdmissionModeV1Schema,
  HomeIdentityNetworkPolicyV1Schema,
  HomeTeamProviderPolicyV1Schema,
  ManagedIdentityProviderKindV1Schema,
  TeamCreationPolicyV1Schema,
} from './policy.js';
import { AccountStatusV1Schema, HomeRoleV1Schema } from './roles.js';
import {
  AccountEncryptionModeSchema,
  EncryptionStoragePolicySchema,
} from '../../features/payload/capabilities/encryptionCapabilities.js';

/**
 * Whether this Home has an active owner. `setup_required` is a bootstrap state
 * that only the zero-owner claim service can leave; ordinary UI explains it and
 * never offers a public claim action.
 */
export const HomeGovernanceSetupStateV1Schema = lazyZodSchema(() => z.enum(['owned', 'setup_required']));
export type HomeGovernanceSetupStateV1 = z.infer<typeof HomeGovernanceSetupStateV1Schema>;

/**
 * The authentication narrowing as the administration surface sees it. It
 * mirrors the stored document's read result so an unreadable configuration is
 * rendered as an actionable problem instead of silently inherited.
 */
export const HomeAuthenticationPolicyProjectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('inherited') }).strict(),
  z.object({
    status: z.literal('narrowed'),
    enabledMethodIds: z.array(z.string().min(1)).nullable(),
    permittedAccountModes: z.array(z.enum(['e2ee', 'plain'])).nullable(),
    recommendedProvisioningMode: z.enum(['e2ee', 'plain']).nullable(),
    admission: HomeAdmissionModeV1Schema.nullable(),
    signInServiceDisabled: z.boolean(),
    /**
     * The stored key-only signup and storage decisions (`null` when the document
     * leaves them to the deployment). An editor that replaces the document must
     * carry them over, so they are projected as stored, never as effective.
     * Optional because a Home that predates them does not report them.
     */
    anonymousSignup: z.boolean().nullable().optional(),
    storagePolicy: EncryptionStoragePolicySchema.nullable().optional(),
  }).strict(),
  z.object({ status: z.literal('unreadable') }).strict(),
]));

export type HomeAuthenticationPolicyProjectionV1 = z.infer<typeof HomeAuthenticationPolicyProjectionV1Schema>;

const HomeTeamProviderPolicyProjectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('inherited') }).strict(),
  z.object({ status: z.literal('narrowed'), policy: HomeTeamProviderPolicyV1Schema }).strict(),
  z.object({ status: z.literal('unreadable') }).strict(),
]));

const HomeIdentityNetworkPolicyProjectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('inherited') }).strict(),
  z.object({ status: z.literal('narrowed'), policy: HomeIdentityNetworkPolicyV1Schema }).strict(),
  z.object({ status: z.literal('unreadable') }).strict(),
]));

export const HomeGovernancePolicyProjectionV1Schema = lazyZodSchema(() => z.object({
  revision: z.number().int().min(0),
  teamCreationPolicy: TeamCreationPolicyV1Schema,
  /** Optional because a Home that predates it reports nothing; absent means Teams are shown. */
  teamsVisibleToMembers: z.boolean().optional(),
  authentication: HomeAuthenticationPolicyProjectionV1Schema,
  teamProviders: HomeTeamProviderPolicyProjectionV1Schema.optional(),
  identityNetwork: HomeIdentityNetworkPolicyProjectionV1Schema.optional(),
}).strict());

export type HomeGovernancePolicyProjectionV1 = z.infer<typeof HomeGovernancePolicyProjectionV1Schema>;

/**
 * The deployment-owned identity facts a Home administrator can see but never
 * change from this Home.
 *
 * They exist because two administration answers are otherwise unexplainable:
 * why WorkOS setup is offered or refused, and why a private identity endpoint
 * can or cannot be allowed here. Both are decided by the operator's runtime
 * configuration, so the projection reports the resulting capability and never
 * the environment variable names, keys or hosts behind it.
 */
export const HomeIdentityDeploymentServicesV1Schema = lazyZodSchema(() => z.object({
  workos: z.enum(['configured', 'partially_configured', 'not_configured']),
  privateIdentityNetworkAllowed: z.boolean(),
  /**
   * The Team identity-provider kinds this deployment can run: the ceiling an
   * inherited Home policy resolves to and the only kinds a Home may add when it
   * saves a narrowing. The policy editor seeds from it, never from the enum.
   */
  teamProviderKinds: z.array(ManagedIdentityProviderKindV1Schema),
  /**
   * OIDC providers the deployment declares itself (`AUTH_PROVIDERS_CONFIG_PATH|JSON`): shown
   * read-only beside the Home's managed providers. Name and the declaring key only; issuer,
   * client id and secret stay on the server. Optional: older Homes do not report it.
   */
  deploymentOidcProviders: z.array(z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    sourceKey: z.enum(['AUTH_PROVIDERS_CONFIG_PATH', 'AUTH_PROVIDERS_CONFIG_JSON']),
  }).strict()).optional(),
}).strict());

export type HomeIdentityDeploymentServicesV1 = z.infer<typeof HomeIdentityDeploymentServicesV1Schema>;

export const HomeAuthenticationOptionsV1Schema = lazyZodSchema(() => z.object({
  methods: z.array(z.object({
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
    iconHint: z.string().nullable().optional(),
    actions: z.array(z.object({
      id: z.enum(['login', 'provision', 'connect']),
      enabled: z.boolean(),
      mode: z.enum(['keyed', 'keyless', 'either']),
      reason: z.enum([
        'method_not_enabled',
        'provisioning_not_enabled',
        'account_mode_unavailable',
        'email_delivery_unavailable',
      ]).optional(),
    }).strict()),
    /**
     * The deployment env key that fixes this method on or off (D-1). The Home
     * policy cannot turn a fixed method on; the row is read-only.
     */
    fixedBy: z.string().min(1).optional(),
    /**
     * The method cannot be offered on this deployment whatever the Home decides:
     * a prerequisite is missing. `requires` names the deployment keys to set,
     * when this Home knows them.
     */
    unavailable: z.object({ requires: z.array(z.string().min(1)) }).strict().optional(),
  }).strict()),
  permittedAccountModes: z.array(AccountEncryptionModeSchema).min(1),
  recommendedProvisioningMode: AccountEncryptionModeSchema.nullable(),
  signInService: z.object({
    deploymentMode: z.enum(['disabled', 'self', 'external']).nullable(),
    canDisable: z.boolean(),
  }).strict(),
  /** Key-only signup as it applies now, and the deployment key that fixes it. */
  anonymousSignup: z.object({
    enabled: z.boolean(),
    fixedBy: z.string().min(1).nullable(),
  }).strict().optional(),
  /**
   * The storage policy the running server applies, the one stored for the next
   * start (`null` when the Home stores none or it equals the running one), and
   * the deployment key that fixes it.
   */
  storagePolicy: z.object({
    running: EncryptionStoragePolicySchema,
    pending: EncryptionStoragePolicySchema.nullable(),
    fixedBy: z.string().min(1).nullable(),
  }).strict().optional(),
}).strict());

export type HomeAuthenticationOptionsV1 = z.infer<typeof HomeAuthenticationOptionsV1Schema>;

/**
 * The Home Administration snapshot for one explicit Home and one viewer.
 *
 * `activeOwnerCount` backs the last-owner explanation before submission; the
 * transaction remains the decisive authority.
 */
export const HomeGovernanceProjectionV1Schema = lazyZodSchema(() => z.object({
  viewer: z.object({
    accountId: z.string().min(1),
    homeRole: HomeRoleV1Schema,
    status: AccountStatusV1Schema,
  }).strict(),
  capabilities: HomeCapabilitiesV1Schema,
  policy: HomeGovernancePolicyProjectionV1Schema,
  setupState: HomeGovernanceSetupStateV1Schema,
  activeOwnerCount: z.number().int().min(0),
  teamsEnabled: z.boolean(),
  // Optional for the same reason as the policy reads above: a Home that has not
  // been replaced yet simply does not report these facts, and the surface shows
  // the section as unavailable instead of inventing a deployment answer.
  identityServices: HomeIdentityDeploymentServicesV1Schema.optional(),
  authenticationOptions: HomeAuthenticationOptionsV1Schema,
}).strict());

export type HomeGovernanceProjectionV1 = z.infer<typeof HomeGovernanceProjectionV1Schema>;

/** A fresh owner-only Home read for the optional empty-Personal-Home removal affordance. */
export const HomeEmptinessV1Schema = lazyZodSchema(() => z.object({ isEmpty: z.boolean() }).strict());
export type HomeEmptinessV1 = z.infer<typeof HomeEmptinessV1Schema>;

/**
 * The complete non-administrative Home projection available to any active viewer.
 *
 * The last three facts are optional: a Home that predates them omits them, and
 * a current Home omits them for a viewer that is not an active Account there.
 */
export const HomeGovernanceEligibilityV1Schema = lazyZodSchema(() => z.object({
  teamsEnabled: z.boolean(),
  createTeam: z.boolean(),
  /**
   * Creation here names the Account the Team is created for (managed creation):
   * the form asks for that first owner instead of offering self-service creation
   * the Home would refuse. Always false when `createTeam` is false.
   */
  createTeamForChosenAccount: z.boolean(),
  /** How Teams are created here, so a member who cannot create one knows why. */
  teamCreationPolicy: TeamCreationPolicyV1Schema.optional(),
  /**
   * The active Home owners, then administrators, by display name only — never
   * their ids or emails — so a member knows whom to ask.
   */
  administratorNames: z.array(z.string().min(1)).optional(),
  /** Whether this viewer is offered the Teams destination on this Home. */
  showTeams: z.boolean().optional(),
}).strict());

export type HomeGovernanceEligibilityV1 = z.infer<typeof HomeGovernanceEligibilityV1Schema>;
