import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ProviderErrorCodeV1Schema } from '../../providers/errors.js';
import { MachinePoolNameV1Schema } from '../../machines/pools/v1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';

import {
  QualifiedConnectedAccountServiceRefSchema,
} from '../../connect/qualifiedConnectedAccountProjectionsV4.js';
import {
  TeamResourceConnectedServiceSelectionV2Schema,
  areTeamResourceConnectedServiceSelectionsEqual,
  type TeamResourceConnectedServiceSelectionV2,
} from '../../connect/connectedServiceBindings.js';
import {
  ProviderAgentTargetKeySchema,
  ProviderModelIdSchema,
} from '../../providers/ids.js';
import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';
import { ProviderBrokerApplicationBindingV1Schema } from '../../providers/brokerRouteGrantV1.js';
import { ProviderWireProtocolSchema } from '../../providers/capabilities/v1.js';
import { ProviderModelBindingSourceV1Schema, ProviderModelConfirmationSourceV1Schema } from '../../providers/compatibility/sourceFacts.js';
import { ProviderBindingCompatibilityV1Schema } from '../../providers/compatibility/v1.js';
import { ProviderCompatibilityFingerprintV1Schema } from '../../providers/fingerprints.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import {
  decodeTeamKeysetCursorV1,
  encodeTeamKeysetCursorV1,
  readTeamKeysetIdV1,
  readTeamKeysetTextV1,
} from '../cursor.js';
import { TeamCredentialResourceReadinessV1Schema } from './readinessV1.js';
import { TeamCredentialUsageCapabilitiesV1Schema, TeamCredentialUsageLimitDenialV1Schema } from './usageV1.js';
import { TeamCredentialUsageLimitDefinitionV1Schema } from './usageV1.js';
import { TeamCredentialAllowedRoutesV1Schema, TeamCredentialDeliveryPolicyV1Schema } from './deliveryV1.js';
import {
  TeamCredentialSourceBindingV1Schema,
} from './sourceBindingV1.js';

export {
  TeamCredentialSourceBindingV1Schema,
  TeamCredentialSourceCredentialIncarnationV1Schema,
} from './sourceBindingV1.js';
export type {
  TeamCredentialSourceBindingV1,
  TeamCredentialSourceCredentialIncarnationV1,
} from './sourceBindingV1.js';

const QualifiedConnectedAccountServiceRefZodSchema = lazyZodSchema(() => asProtocolZod(
  QualifiedConnectedAccountServiceRefSchema,
));
const PluginContributionIdentityV1ZodSchema = lazyZodSchema(() => asProtocolZod(
  PluginContributionIdentityV1Schema,
));

/** Public identity of the Provider definition selected by the source owner. */
export const TeamCredentialProviderPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  identity: PluginContributionIdentityV1ZodSchema,
  definitionRevision: z.literal(1),
}));

export const TeamCredentialDisclosureCeilingV1Schema = lazyZodSchema(() => z.enum([
  'brokered_only',
  'direct_allowed',
]));

export const TeamCredentialSessionUsePolicyV1Schema = lazyZodSchema(() => z.enum([
  'personal_allowed',
  'team_context_required',
  'team_visibility_required',
]));

export const TeamCredentialDeliveryModeV1Schema = lazyZodSchema(() => z.enum([
  'brokered',
  'direct',
  'both',
]));

/** Closed broker-location authority. Selection resolves a Pool to one exact
 * Machine before the incumbent broker-open owner signs any route authority. */
export const TeamCredentialBrokerPlacementV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('machine'), machineId: z.string().check(z.minLength(1), z.maxLength(256)) }),
  z.strictObject({ kind: z.literal('machine_pool'), poolId: z.string().check(z.minLength(1), z.maxLength(256)) }),
]));
export type TeamCredentialBrokerPlacementV1 = z.infer<typeof TeamCredentialBrokerPlacementV1Schema>;

import { TeamCredentialRouteV1Schema } from './deliveryV1.js';
export { TEAM_CREDENTIAL_ROUTES_V1, TeamCredentialRouteV1Schema, TeamCredentialAllowedRoutesV1Schema, TeamCredentialDeliveryPolicyV1Schema, TeamCredentialDeliveryConfigurationV1Schema } from './deliveryV1.js';
export type { TeamCredentialRouteV1, TeamCredentialAllowedRoutesV1, TeamCredentialDeliveryPolicyV1, TeamCredentialDeliveryConfigurationV1 } from './deliveryV1.js';

export const TeamCredentialRequestProtocolKindV1Schema = lazyZodSchema(() => z.enum([
  'openai_responses',
  'openai_chat_completions',
  'anthropic_messages',
]));

export const TeamCredentialRequestPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  allowedProtocolKinds: z.nullable(z.array(TeamCredentialRequestProtocolKindV1Schema).check(z.minLength(1))),
  allowedModelIds: z.nullable(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))).check(z.minLength(1))),
  reasoningEffort: z.nullable(z.strictObject({
    allowedValues: z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))).check(z.minLength(1)),
    defaultValue: z.string().check(z.trim(), z.minLength(1), z.maxLength(64)),
  })),
}).check(z.superRefine((value, ctx) => {
  if (value.reasoningEffort && !value.reasoningEffort.allowedValues.includes(value.reasoningEffort.defaultValue)) {
    ctx.addIssue({ code: "custom", path: ['reasoningEffort', 'defaultValue'], message: 'defaultValue must be allowed' });
  }
  if (value.allowedProtocolKinds && new Set(value.allowedProtocolKinds).size !== value.allowedProtocolKinds.length) {
    ctx.addIssue({ code: "custom", path: ['allowedProtocolKinds'], message: 'values must be unique' });
  }
  if (value.allowedModelIds && new Set(value.allowedModelIds).size !== value.allowedModelIds.length) {
    ctx.addIssue({ code: "custom", path: ['allowedModelIds'], message: 'values must be unique' });
  }
  if (value.reasoningEffort && new Set(value.reasoningEffort.allowedValues).size !== value.reasoningEffort.allowedValues.length) {
    ctx.addIssue({ code: "custom", path: ['reasoningEffort', 'allowedValues'], message: 'values must be unique' });
  }
})));

export type TeamCredentialDisclosureCeilingV1 = z.infer<
  typeof TeamCredentialDisclosureCeilingV1Schema
>;
export type TeamCredentialSessionUsePolicyV1 = z.infer<
  typeof TeamCredentialSessionUsePolicyV1Schema
>;
export type TeamCredentialDeliveryModeV1 = z.infer<
  typeof TeamCredentialDeliveryModeV1Schema
>;

/**
 * The one rule for narrowing a disclosure ceiling to `brokered_only`
 * (Lane 10 child 01 §7.1 rule 5 and the §7.2 "Narrow direct ceiling" row).
 *
 * Broker and direct rights are independent, and narrowing withdraws only the
 * consent to direct disclosure: `both` keeps its broker half, a direct-only
 * grant ends, and no grant gains broker use it did not already carry. The
 * create and edit drafts and the Home's mutations all apply this rule.
 */
export function narrowTeamCredentialDeliveryModeToBrokeredOnlyV1(
  mode: TeamCredentialDeliveryModeV1 | null,
): 'brokered' | null {
  return mode === 'brokered' || mode === 'both' ? 'brokered' : null;
}

export type TeamCredentialRequestProtocolKindV1 = z.infer<typeof TeamCredentialRequestProtocolKindV1Schema>;
export type TeamCredentialRequestPolicyV1 = z.infer<typeof TeamCredentialRequestPolicyV1Schema>;

/**
 * Source-owned, value-free facts an editor may use to build a request policy.
 * The projection deliberately carries neither broker topology nor credential
 * material, and no numeric bound: a request policy constrains only facts a
 * Provider catalog publishes, never a caller-authored token ceiling.
 */
export const TeamCredentialRequestPolicyModelSupportV1Schema = lazyZodSchema(() => z.strictObject({
  descriptor: ProviderModelDescriptorV1Schema,
  application: ProviderBrokerApplicationBindingV1Schema,
  sourceRevision: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  allowedProtocolKinds: z.array(TeamCredentialRequestProtocolKindV1Schema).check(z.minLength(1), z.maxLength(3)),
  reasoningEffort: z.nullable(z.strictObject({
    allowedValues: z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))).check(z.minLength(1), z.maxLength(64)),
    defaultValue: z.string().check(z.trim(), z.minLength(1), z.maxLength(64)),
  })),
}).check(z.superRefine((value, ctx) => {
  if (new Set(value.allowedProtocolKinds).size !== value.allowedProtocolKinds.length) {
    ctx.addIssue({ code: "custom", path: ['allowedProtocolKinds'], message: 'values must be unique' });
  }
  if (value.reasoningEffort) {
    if (new Set(value.reasoningEffort.allowedValues).size !== value.reasoningEffort.allowedValues.length) {
      ctx.addIssue({ code: "custom", path: ['reasoningEffort', 'allowedValues'], message: 'values must be unique' });
    }
    if (!value.reasoningEffort.allowedValues.includes(value.reasoningEffort.defaultValue)) {
      ctx.addIssue({ code: "custom", path: ['reasoningEffort', 'defaultValue'], message: 'defaultValue must be allowed' });
    }
  }
})));
export type TeamCredentialRequestPolicyModelSupportV1 = z.infer<
  typeof TeamCredentialRequestPolicyModelSupportV1Schema
>;

export const TeamCredentialRequestPolicySupportInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('source_draft'),
    teamId: z.string().check(z.minLength(1)),
    source: TeamCredentialSourceBindingV1Schema,
    brokerPlacement: z.nullable(TeamCredentialBrokerPlacementV1Schema),
  }),
  z.strictObject({
    scope: z.literal('resource'),
    resourceId: z.string().check(z.minLength(1), z.maxLength(256)),
  }),
]));
export type TeamCredentialRequestPolicySupportInputV1 = z.infer<
  typeof TeamCredentialRequestPolicySupportInputV1Schema
>;

export const TeamCredentialRequestPolicySupportOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    models: z.array(TeamCredentialRequestPolicyModelSupportV1Schema),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum([
      'broker_unavailable',
      'source_unavailable',
      'update_required',
      'unsupported_application',
      'model_catalog_unavailable',
    ]),
  }),
]));
export type TeamCredentialRequestPolicySupportOutputV1 = z.infer<
  typeof TeamCredentialRequestPolicySupportOutputV1Schema
>;

export const TeamCredentialResourceCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: z.string().check(z.minLength(1)), resourceId: z.string().check(z.minLength(1), z.maxLength(256)),
  displayName: z.string().check(z.trim(), z.minLength(1), z.maxLength(120)),
  source: TeamCredentialSourceBindingV1Schema,
  disclosureCeiling: TeamCredentialDisclosureCeilingV1Schema,
  sessionUsePolicy: TeamCredentialSessionUsePolicyV1Schema,
  brokerPlacement: z.nullable(TeamCredentialBrokerPlacementV1Schema),
  requestPolicy: z.nullable(TeamCredentialRequestPolicyV1Schema),
  allMembersDeliveryMode: z.nullable(TeamCredentialDeliveryModeV1Schema),
  groupGrants: z.array(z.strictObject({
    teamGroupId: z.string().check(z.minLength(1)),
    deliveryMode: TeamCredentialDeliveryModeV1Schema,
  })),
  memberGrants: z.array(z.strictObject({
    teamMembershipId: z.string().check(z.minLength(1)),
    deliveryMode: TeamCredentialDeliveryModeV1Schema,
  })),
  usageLimits: z.array(TeamCredentialUsageLimitDefinitionV1Schema),
}));


export const TeamCredentialResourceAudienceGrantV1Schema = lazyZodSchema(() => z.strictObject({
  teamGroupId: z.string().check(z.minLength(1)),
  deliveryMode: TeamCredentialDeliveryModeV1Schema,
}));

export const TeamCredentialResourceMemberGrantV1Schema = lazyZodSchema(() => z.strictObject({
  teamMembershipId: z.string().check(z.minLength(1)),
  deliveryMode: TeamCredentialDeliveryModeV1Schema,
}));

export const TeamCredentialResourceAudienceInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)), expectedRevision: z.number().check(z.int(), z.nonnegative()),
  allMembersDeliveryMode: z.nullable(TeamCredentialDeliveryModeV1Schema),
  groupGrants: z.array(TeamCredentialResourceAudienceGrantV1Schema),
  memberGrants: z.array(TeamCredentialResourceMemberGrantV1Schema),
}));

export const TeamCredentialResourceDeleteInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)), expectedRevision: z.number().check(z.int(), z.nonnegative()),
}));

export const TeamCredentialResourceReplacementV1Schema = lazyZodSchema(() => z.strictObject({
  enabled: z.boolean(),
  displayName: z.string().check(z.trim(), z.minLength(1), z.maxLength(120)),
  sessionUsePolicy: TeamCredentialSessionUsePolicyV1Schema,
  requestPolicy: z.nullable(TeamCredentialRequestPolicyV1Schema),
  allMembersDeliveryMode: z.nullable(TeamCredentialDeliveryModeV1Schema),
  groupGrants: z.array(TeamCredentialResourceAudienceGrantV1Schema),
  memberGrants: z.array(TeamCredentialResourceMemberGrantV1Schema),
  /** Present only when the source custodian intentionally edits their private authority. */
  custodian: z.optional(z.strictObject({
    source: TeamCredentialSourceBindingV1Schema,
    disclosureCeiling: TeamCredentialDisclosureCeilingV1Schema,
    brokerPlacement: z.nullable(TeamCredentialBrokerPlacementV1Schema),
  })),
  /** Bounded edits preserve limit rows omitted by paginated administration reads. */
  usageLimitDelta: z.strictObject({
    upserts: z.array(z.extend(TeamCredentialUsageLimitDefinitionV1Schema, {
      id: z.optional(z.string().check(z.minLength(1))),
    })),
    deleteIds: z.array(z.string().check(z.minLength(1))),
  }).check(z.superRefine((value, context) => {
    if (new Set(value.deleteIds).size !== value.deleteIds.length) {
      context.addIssue({ code: "custom", path: ['deleteIds'], message: 'values must be unique' });
    }
  })),
}));

export const TeamCredentialResourceUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)), expectedRevision: z.number().check(z.int(), z.nonnegative()),
  enabled: z.optional(z.boolean()),
  displayName: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(120))),
  disclosureCeiling: z.optional(TeamCredentialDisclosureCeilingV1Schema),
  sessionUsePolicy: z.optional(TeamCredentialSessionUsePolicyV1Schema),
  brokerPlacement: z.optional(z.nullable(TeamCredentialBrokerPlacementV1Schema)),
  requestPolicy: z.optional(z.nullable(TeamCredentialRequestPolicyV1Schema)),
  replacement: z.optional(TeamCredentialResourceReplacementV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.replacement === undefined) return;
  const legacyKeys = [
    'enabled',
    'displayName',
    'disclosureCeiling',
    'sessionUsePolicy',
    'brokerPlacement',
    'requestPolicy',
  ] as const;
  for (const key of legacyKeys) {
    if (value[key] !== undefined) {
      context.addIssue({ code: "custom", path: [key], message: 'legacy patch fields cannot be mixed with replacement' });
    }
  }
})));

export const TeamCredentialResourceReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: z.string().check(z.minLength(1)),
  /** Exact Agent/Provider application whose current models are requested. */
  application: z.optional(ProviderBrokerApplicationBindingV1Schema),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(100)), 50),
}));
export type TeamCredentialResourceReadInputV1 = z.infer<typeof TeamCredentialResourceReadInputV1Schema>;

/** Account-scoped set read; Team authority is still admitted independently. */
export const TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1 = '/v1/teams/credential-resources/entitled/discover';

export const TeamCredentialResourceDiscoverInputV1Schema = lazyZodSchema(() => z.strictObject({
  teamIds: z.array(z.string().check(z.minLength(1))),
  application: z.optional(ProviderBrokerApplicationBindingV1Schema),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(100)), 50),
}));
export type TeamCredentialResourceDiscoverInputV1 = z.infer<typeof TeamCredentialResourceDiscoverInputV1Schema>;

export const TeamCredentialResourceListFilterV1Schema = lazyZodSchema(() => z.enum([
  'all',
  'needs_attention',
  'brokered',
  'direct',
  'external_api',
]));

/** Administration-list query. Recipient catalog application selection remains
 * on the separate read input above. */
export const TeamCredentialResourceListInputV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: z.string().check(z.minLength(1)),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(100)), 50),
  search: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(120))),
  filter: z._default(TeamCredentialResourceListFilterV1Schema, 'all'),
}));

export type TeamCredentialResourceListInputV1 = z.infer<typeof TeamCredentialResourceListInputV1Schema>;

export function teamCredentialResourcesQueryKeyV1(
  input: Pick<TeamCredentialResourceListInputV1, 'teamId' | 'search' | 'filter'>,
): string {
  return `v1:credential-resources:${input.teamId}:${input.filter}:${input.search ?? ''}`;
}

export type TeamCredentialResourcesCursorV1 = Readonly<{ displayName: string; id: string }>;

export function encodeTeamCredentialResourcesCursorV1(input: Readonly<{
  queryKey: string;
  displayName: string;
  id: string;
}>): string {
  return encodeTeamKeysetCursorV1({ queryKey: input.queryKey, parts: [input.displayName, input.id] });
}

export function decodeTeamCredentialResourcesCursorV1(
  value: string,
  queryKey: string,
): Readonly<{ status: 'ok'; cursor: TeamCredentialResourcesCursorV1 }> | Readonly<{ status: 'invalid' }> {
  const decoded = decodeTeamKeysetCursorV1(value, queryKey);
  if (decoded.status !== 'ok') return { status: 'invalid' };
  const displayName = readTeamKeysetTextV1(decoded.parts[0]);
  const id = readTeamKeysetIdV1(decoded.parts[1]);
  return displayName === null || id === null
    ? { status: 'invalid' }
    : { status: 'ok', cursor: { displayName, id } };
}

export const TeamCredentialResourceGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1), z.maxLength(256)),
}));

export const TeamCredentialResourceSourcePresentationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('connected_service'),
    service: QualifiedConnectedAccountServiceRefZodSchema,
  }),
  z.strictObject({
    kind: z.literal('provider'),
    provider: TeamCredentialProviderPresentationV1Schema,
  }),
]));

export const TeamCredentialBrokerPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  selectedTarget: z.nullable(z.strictObject({ machineId: z.string().check(z.minLength(1)), displayName: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(120))), availability: z.enum(['available', 'offline', 'update_required', 'not_verified']) })),
  eligibleTargets: z.array(z.strictObject({ machineId: z.string().check(z.minLength(1)), displayName: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(120))), availability: z.enum(['available', 'offline', 'update_required', 'not_verified']) })),
  // Pool names use the canonical MachinePoolNameV1 contract and may be longer
  // than the bounded Machine-label presentation. Keep the full domain value
  // here; UI surfaces may ellipsize visually without making a valid resource
  // summary parse as resource_corrupt.
  selectedPool: z.nullable(z.strictObject({ poolId: z.string().check(z.minLength(1), z.maxLength(256)), displayName: z.nullable(MachinePoolNameV1Schema), availability: z.enum(['available', 'unavailable', 'not_verified']), availableMachineCount: z.nullable(z.number().check(z.int(), z.nonnegative())) })),
  eligiblePools: z.array(z.strictObject({ poolId: z.string().check(z.minLength(1), z.maxLength(256)), displayName: z.nullable(MachinePoolNameV1Schema), availability: z.enum(['available', 'unavailable', 'not_verified']), availableMachineCount: z.nullable(z.number().check(z.int(), z.nonnegative())) })),
}));

/**
 * Operation-specific administration authority for one resource row.
 *
 * This is projected by the Home beside the row it authorized. A client cannot
 * derive these facts from Team role, source identity, enabled state, or the
 * presence of private fields without becoming a second policy owner.
 */
export const TeamCredentialResourceAdministrationCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
  manageAudience: z.boolean(),
  managePolicy: z.boolean(),
  manageLimits: z.boolean(),
  updateBrokerPlacement: z.boolean(),
  narrowDisclosure: z.boolean(),
  /** Source custodian consent to widen `brokered_only` to `direct_allowed`.
   * Absent on an older Home is read as not permitted. */
  widenDisclosure: z._default(z.boolean(), false),
  refreshDirectMaterial: z.boolean(),
  disable: z.boolean(),
  enable: z.boolean(),
  delete: z.boolean(),
}));

export const TeamCredentialResourceSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string(), teamId: z.string(), custodianAccountId: z.string(),
  /** Human label for the source owner; the stable Account id remains above. */
  sourceOwnerDisplayName: z._default(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(120))), null),
  displayName: z.string(), enabled: z.boolean(), revision: z.number().check(z.int(), z.nonnegative()),
  disclosureCeiling: TeamCredentialDisclosureCeilingV1Schema,
  sessionUsePolicy: TeamCredentialSessionUsePolicyV1Schema,
  /** Exact source lifetime is visible only to its custodian. */
  source: z.nullable(TeamCredentialSourceBindingV1Schema),
  /** Recipient-safe source family shown to every authorized administrator. */
  sourcePresentation: z.nullable(TeamCredentialResourceSourcePresentationV1Schema),
  /** Safe source-owner projection used to keep direct choices truthful. */
  directExportSupport: z._default(z.enum(['supported', 'mixed', 'unsupported']), 'unsupported'),
  usageCapabilities: z.optional(TeamCredentialUsageCapabilitiesV1Schema),
  /** Enabled limits only; detailed evaluation remains owned by the limits API. */
  activeUsageLimitCount: z._default(z.number().check(z.int(), z.nonnegative()), 0),
  requestPolicy: z.nullable(TeamCredentialRequestPolicyV1Schema),
  brokerPlacement: z.nullable(TeamCredentialBrokerPlacementV1Schema),
  allMembersDeliveryMode: z.nullable(TeamCredentialDeliveryModeV1Schema),
  /**
   * The complete audience, projected because the audience mutation replaces it
   * whole. Without it an editor could express "add" but never "keep", so every
   * save would silently drop the grants that editor had not been shown.
   *
   * `allMembersDeliveryMode: null` is not an empty audience: it means nobody
   * holds access by default, which is a different fact from having no Group or
   * member grants.
   */
  groupGrants: z.array(TeamCredentialResourceAudienceGrantV1Schema),
  memberGrants: z.array(TeamCredentialResourceMemberGrantV1Schema),
  readiness: TeamCredentialResourceReadinessV1Schema,
  recoveryAction: z.nullable(z.enum([
    'retry',
    'source_owner_action',
    'select_broker',
    'update_required',
    'choose_another_resource',
  ])),
  brokerPresentation: TeamCredentialBrokerPresentationV1Schema,
  // Older Homes do not project operation-specific administration authority.
  // New readers must degrade to no authority rather than reject the otherwise
  // usable row or infer permissions from legacy role/source fields.
  capabilities: z._default(TeamCredentialResourceAdministrationCapabilitiesV1Schema, {
    manageAudience: false,
    managePolicy: false,
    manageLimits: false,
    updateBrokerPlacement: false,
    narrowDisclosure: false,
    widenDisclosure: false,
    refreshDirectMaterial: false,
    disable: false,
    enable: false,
    delete: false,
  }),
  createdAt: z.string(), updatedAt: z.string(),
}).check(z.superRefine((value, context) => {
  if (value.sourcePresentation === null && value.readiness.kind === 'available') {
    context.addIssue({ code: 'custom', path: ['sourcePresentation'], message: 'An available resource must have a current source presentation' });
  }
})));

/** Closed manager/source-owner projection; never use it for recipient discovery. */
export const TeamCredentialResourceAdministrationV1Schema = TeamCredentialResourceSummaryV1Schema;

/**
 * What this exact viewer may do with Team credential resources, decided by the
 * Home inside the same read that produced the rows.
 *
 * The Team V1 capability projection deliberately does not carry resource
 * authority, and a client cannot derive it: `custodianAccountId` says who owns a
 * source, not who administers the Team's resources, and a role string withdraws
 * nothing when a membership is suspended or the Team is archived. Projecting it
 * beside the rows is what lets a surface hide a management entry it would only
 * be refused, without becoming a second authority for the same question.
 */
export const TeamCredentialViewerCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
  /** May create, edit, re-audience and delete this Team's resources. */
  manageCredentials: z.boolean(),
  /** May offer one of their own owned sources to this Team. */
  offerOwnCredential: z.boolean(),
}));

/** Least-privilege selection catalog. Source and administration authority never cross this seam. */
export const TeamCredentialProviderModelSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('team_credential_provider_model'),
  resourceId: z.string().check(z.minLength(1), z.maxLength(256)),
  teamId: z.string().check(z.minLength(1)),
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema,
  deliveryMode: TeamCredentialRouteV1Schema,
}));

export const TeamCredentialProviderModelCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({
  selection: TeamCredentialProviderModelSelectionV1Schema,
  descriptor: ProviderModelDescriptorV1Schema,
  /** Exact source-owned application capable of serving this model. */
  application: ProviderBrokerApplicationBindingV1Schema,
  sourceFacts: z.optional(ProviderModelBindingSourceV1Schema),
  confirmationSource: z.optional(ProviderModelConfirmationSourceV1Schema),
  /** Source-reported state is presentation only; the worker derives admission. */
  compatibility: z.optional(z.strictObject({
    result: ProviderBindingCompatibilityV1Schema,
    compatibilityFingerprint: ProviderCompatibilityFingerprintV1Schema,
    confirmed: z.boolean(),
  })),
  /** Opaque current source/catalog identity. It contains no source-private data. */
  sourceRevision: z.string().check(z.minLength(1), z.maxLength(512)),
  /** Opaque recipient-safe witness for current private direct material. */
  direct: z.optional(z.nullable(z.strictObject({
    sourceMemberKey: z.string().check(z.minLength(1), z.maxLength(512)),
    sourceVersion: z.string().check(z.minLength(1), z.maxLength(512)),
  }))),
  availability: z.enum(['available', 'source_owner_required', 'resource_corrupt', 'policy_denied']),
}).check(z.superRefine((value, context) => {
  if (value.selection.modelId !== value.descriptor.id) {
    context.addIssue({ code: 'custom', path: ['descriptor', 'id'], message: 'Descriptor must identify the selected canonical model' });
  }
  if (value.selection.agentTargetKey !== value.application.agentTargetKey) {
    context.addIssue({ code: 'custom', path: ['application', 'agentTargetKey'], message: 'Application must target the selected Agent' });
  }
})));

export const TeamCredentialDirectMaterialStateV1Schema = lazyZodSchema(() => z.enum([
  'never_delivered',
  'preparing',
  'current',
  'stale',
  'revoked',
]));

export const TeamCredentialResourceRecoveryActionV1Schema = lazyZodSchema(() => z.enum([
  'retry',
  'source_owner_action',
  'select_broker',
  'update_required',
  'choose_another_resource',
]));

export const TeamCredentialResourceCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string(),
  teamId: z.string(),
  displayName: z.string(),
  resourceRevision: z.number().check(z.int(), z.nonnegative()),
  readiness: TeamCredentialResourceReadinessV1Schema,
  recoveryAction: z.nullable(TeamCredentialResourceRecoveryActionV1Schema),
  mayBroker: z.boolean(),
  mayReceiveDirect: z.boolean(),
  deliveryPolicy: z.optional(TeamCredentialDeliveryPolicyV1Schema),
  allowedRoutes: z.optional(TeamCredentialAllowedRoutesV1Schema),
  /** Presentation for an unavailable route when no model row can be emitted. */
  deliveryUnavailableReason: z.optional(ProviderErrorCodeV1Schema),
  directMaterialState: TeamCredentialDirectMaterialStateV1Schema,
  /**
   * Retained first-disclosure history for this viewer, separate from the
   * readiness `directMaterialState` describes: present and true only when the
   * Home has recorded a direct delivery to them. Absence means no recorded
   * disclosure, so first direct use still asks (child 06 L10D-R3).
   */
  directDeliveryRecorded: z.optional(z.boolean()),
  sessionUsePolicy: z.nullable(TeamCredentialSessionUsePolicyV1Schema),
  providerModels: z.array(TeamCredentialProviderModelCatalogEntryV1Schema),
  /** Exact, content-free direct Connected Service choices current for this recipient. */
  connectedServiceSelections: z._default(z.array(TeamResourceConnectedServiceSelectionV2Schema), []),
  sourcePresentation: z.nullable(TeamCredentialResourceSourcePresentationV1Schema),
  usageCapabilities: z.optional(TeamCredentialUsageCapabilitiesV1Schema),
  /** Current exhausted broker ceiling for this recipient, without private
   * limit/audience/member identity. */
  usageLimit: z.optional(z.nullable(TeamCredentialUsageLimitDenialV1Schema)),
}).check(z.superRefine((value, context) => {
  if (value.sourcePresentation === null && value.readiness.kind === 'available' && value.providerModels.length === 0) {
    context.addIssue({ code: 'custom', path: ['sourcePresentation'], message: 'An available catalog row must have a current source presentation' });
  }
})));

export const TeamCredentialResourcePageV1Schema = lazyZodSchema(() => z.strictObject({
  /** Administration rows: Team managers plus the viewer's own source rows only. */
  resources: z.array(TeamCredentialResourceSummaryV1Schema),
  viewer: TeamCredentialViewerCapabilitiesV1Schema,
  nextCursor: z._default(z.nullable(z.string().check(z.minLength(1), z.maxLength(512))), null),
}));

export const TeamCredentialResourceEntitledPageV1Schema = lazyZodSchema(() => z.strictObject({
  resources: z.array(TeamCredentialResourceCatalogEntryV1Schema).check(z.maxLength(100)),
  nextCursor: z._default(z.nullable(z.string().check(z.minLength(1), z.maxLength(512))), null),
}));

export const TeamCredentialResourceMutationResultV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string(), revision: z.number().check(z.int(), z.nonnegative()),
}));

export const TeamCredentialActivityKindV1Schema = lazyZodSchema(() => z.enum([
  'resource_created', 'resource_updated', 'resource_deleted', 'audience_changed',
  'direct_delivered', 'external_key_created', 'external_key_revoked', 'limits_changed',
]));
export type TeamCredentialActivityKindV1 = z.infer<typeof TeamCredentialActivityKindV1Schema>;

export const TeamCredentialResourceActivityReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1), z.maxLength(256)),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(100)), 50),
}));

export const TeamCredentialResourceActivityEventV1Schema = lazyZodSchema(() => z.strictObject({
  kind: TeamCredentialActivityKindV1Schema,
  actorDisplayName: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(120))),
  subjectDisplayName: z.string().check(z.trim(), z.minLength(1), z.maxLength(120)),
  createdAt: z.string().check(z.iso.datetime({ offset: true })),
}));

export const TeamCredentialResourceActivityPageV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(TeamCredentialResourceActivityEventV1Schema).check(z.maxLength(100)),
  nextCursor: z.nullable(z.string().check(z.minLength(1), z.maxLength(512))),
}));

/**
 * The typed refusals a credential-resource operation may answer with.
 *
 * It is a bare enum, and the reply envelope below is derived from it, so a
 * client transport can recognize this domain's vocabulary the same way it
 * already recognizes Team and Home-governance codes. Without that a real
 * refusal — a stale revision, an uncovered cost limit, a subject who left the
 * Team — reaches a surface as an anonymous failure and loses its recovery.
 */
export const TeamCredentialErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_resource_input', 'not_found_or_not_visible', 'forbidden', 'resource_changed',
  'team_authentication_required', 'team_authentication_policy_unavailable',
  'feature_disabled',
  'source_owner_required', 'source_replaced_or_missing', 'invalid_audience',
  'disclosure_not_allowed', 'broker_unavailable', 'update_required', 'resource_corrupt',
  'resource_not_found', 'resource_forbidden',
  'member_not_eligible', 'session_policy_incompatible',
  'invalid_limit', 'limit_identity_immutable', 'subject_not_in_team',
  'token_limit_unavailable', 'cost_limit_unavailable', 'team_credential_usage_limit',
]));
export type TeamCredentialErrorCodeV1 = z.infer<typeof TeamCredentialErrorCodeV1Schema>;

export const TeamCredentialResourceDiscoveryPageV1Schema = lazyZodSchema(() => z.strictObject({
  resources: z.array(TeamCredentialResourceCatalogEntryV1Schema).check(z.maxLength(100)),
  nextCursor: z.nullable(z.string().check(z.minLength(1), z.maxLength(512))),
  failures: z.array(z.strictObject({
    teamId: z.string().check(z.minLength(1)),
    error: TeamCredentialErrorCodeV1Schema,
  })),
}));
export type TeamCredentialResourceDiscoveryPageV1 = z.infer<typeof TeamCredentialResourceDiscoveryPageV1Schema>;

export const TeamCredentialResourceErrorV1Schema = lazyZodSchema(() => z.strictObject({
  error: TeamCredentialErrorCodeV1Schema,
}));

/**
 * The status each refusal is served with, owned beside the vocabulary so the
 * route that sends it and the client that reads it cannot disagree. It mirrors
 * `registerTeamCredentialResourceRoutes`, which is the one producer.
 */
export function teamCredentialErrorHttpStatusV1(code: TeamCredentialErrorCodeV1): 400 | 403 | 404 | 409 | 503 {
  switch (code) {
    case 'forbidden':
    case 'resource_forbidden':
    case 'member_not_eligible':
    case 'team_authentication_required':
      return 403;
    case 'not_found_or_not_visible':
    case 'resource_not_found':
      return 404;
    case 'resource_changed':
    case 'session_policy_incompatible':
      return 409;
    case 'team_authentication_policy_unavailable':
    case 'feature_disabled':
      return 503;
    default:
      return 400;
  }
}

export type TeamCredentialViewerCapabilitiesV1 = z.infer<typeof TeamCredentialViewerCapabilitiesV1Schema>;
export type TeamCredentialResourceAdministrationCapabilitiesV1 = z.infer<
  typeof TeamCredentialResourceAdministrationCapabilitiesV1Schema
>;
export type TeamCredentialResourceSummaryV1 = z.infer<typeof TeamCredentialResourceSummaryV1Schema>;
export type TeamCredentialResourceAdministrationV1 = z.infer<typeof TeamCredentialResourceAdministrationV1Schema>;
export type TeamCredentialProviderPresentationV1 = z.infer<typeof TeamCredentialProviderPresentationV1Schema>;
export type TeamCredentialResourceSourcePresentationV1 = z.infer<
  typeof TeamCredentialResourceSourcePresentationV1Schema
>;
export type TeamCredentialResourceRecoveryActionV1 = z.infer<typeof TeamCredentialResourceRecoveryActionV1Schema>;
export type TeamCredentialDirectMaterialStateV1 = z.infer<typeof TeamCredentialDirectMaterialStateV1Schema>;
export type TeamCredentialProviderModelSelectionV1 = z.infer<typeof TeamCredentialProviderModelSelectionV1Schema>;
export type TeamCredentialProviderModelCatalogEntryV1 = z.infer<
  typeof TeamCredentialProviderModelCatalogEntryV1Schema
>;
export type TeamCredentialResourceCatalogEntryV1 = z.infer<typeof TeamCredentialResourceCatalogEntryV1Schema>;

/** Exact resource/service identity, retaining unavailable owner facts when no choice can be offered. */
export function resolveTeamResourceConnectedServiceSelectionV1(input: Readonly<{
  resource: TeamCredentialResourceCatalogEntryV1;
  teamId: string;
  selection: TeamResourceConnectedServiceSelectionV2;
  services: readonly Readonly<{ pluginId: string; localId: string }>[];
}>): TeamResourceConnectedServiceSelectionV2 | null {
  const source = input.resource.sourcePresentation;
  if (input.resource.teamId !== input.teamId || input.resource.id !== input.selection.resourceId
    || source && (source.kind !== 'connected_service'
      || !input.services.some(service => service.pluginId === source.service.pluginId && service.localId === source.service.localId))) return null;
  if (input.selection.deliveryMode === 'direct') {
    const member = input.selection.disclosedMember.service;
    if (!input.services.some(service => service.pluginId === member.pluginId && service.localId === member.localId)
      || source?.kind === 'connected_service' && (source.service.pluginId !== member.pluginId || source.service.localId !== member.localId)) return null;
  }
  if (input.resource.readiness.kind === 'available' && !source) return null;
  const offered = input.resource.connectedServiceSelections.find(selection =>
    areTeamResourceConnectedServiceSelectionsEqual(selection, input.selection));
  // The entitled catalog deliberately omits choices for unavailable sources/corrupt resources.
  // Absence preserves their diagnosis; an explicit changed choice never matches the old binding.
  return offered ?? (input.resource.readiness.kind !== 'available' && input.resource.connectedServiceSelections.length === 0
    ? input.selection : null);
}
export type TeamCredentialResourcePageV1 = z.infer<typeof TeamCredentialResourcePageV1Schema>;
export type TeamCredentialResourceListFilterV1 = z.infer<typeof TeamCredentialResourceListFilterV1Schema>;
export type TeamCredentialResourceEntitledPageV1 = z.infer<typeof TeamCredentialResourceEntitledPageV1Schema>;
export type TeamCredentialResourceMutationResultV1 = z.infer<typeof TeamCredentialResourceMutationResultV1Schema>;
export type TeamCredentialResourceActivityEventV1 = z.infer<typeof TeamCredentialResourceActivityEventV1Schema>;
export type TeamCredentialResourceActivityPageV1 = z.infer<typeof TeamCredentialResourceActivityPageV1Schema>;
export type TeamCredentialResourceReplacementV1 = z.infer<typeof TeamCredentialResourceReplacementV1Schema>;
export type TeamCredentialResourceUpdateInputV1 = z.infer<typeof TeamCredentialResourceUpdateInputV1Schema>;
export type TeamCredentialResourceAudienceGrantV1 = z.infer<typeof TeamCredentialResourceAudienceGrantV1Schema>;
export type TeamCredentialResourceMemberGrantV1 = z.infer<typeof TeamCredentialResourceMemberGrantV1Schema>;
export type TeamCredentialResourceCreateInputV1 = z.infer<typeof TeamCredentialResourceCreateInputV1Schema>;
export type TeamCredentialResourceAudienceInputV1 = z.infer<typeof TeamCredentialResourceAudienceInputV1Schema>;
export type TeamCredentialResourceActivityReadInputV1 = z.infer<typeof TeamCredentialResourceActivityReadInputV1Schema>;
