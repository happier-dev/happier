import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { MachinePoolNameV1Schema } from '../../machines/pools/v1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';

import {
  QualifiedConnectedAccountServiceRefSchema,
} from '../../connect/qualifiedConnectedAccountProjectionsV4.js';
import {
  TeamResourceConnectedServiceSelectionV2Schema,
} from '../../connect/connectedServiceBindings.js';
import {
  ProviderAgentTargetKeySchema,
  ProviderModelIdSchema,
} from '../../providers/ids.js';
import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';
import { ProviderBrokerApplicationBindingV1Schema } from '../../providers/brokerRouteGrantV1.js';
import { ProviderWireProtocolSchema } from '../../providers/capabilities/v1.js';
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
export const TeamCredentialProviderPresentationV1Schema = lazyZodSchema(() => z.object({
  identity: PluginContributionIdentityV1ZodSchema,
  definitionRevision: z.literal(1),
}).strict());

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
  z.object({ kind: z.literal('machine'), machineId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('machine_pool'), poolId: z.string().min(1).max(256) }).strict(),
]));
export type TeamCredentialBrokerPlacementV1 = z.infer<typeof TeamCredentialBrokerPlacementV1Schema>;

/** Recipient catalog entries expose the selected usable path, never the administration-only union. */
export const TeamCredentialRouteV1Schema = lazyZodSchema(() => z.enum([
  'brokered',
  'direct',
]));
export type TeamCredentialRouteV1 = z.infer<typeof TeamCredentialRouteV1Schema>;

export const TeamCredentialRequestProtocolKindV1Schema = lazyZodSchema(() => z.enum([
  'openai_responses',
  'openai_chat_completions',
  'anthropic_messages',
]));

export const TeamCredentialRequestPolicyV1Schema = lazyZodSchema(() => z.object({
  allowedProtocolKinds: z.array(TeamCredentialRequestProtocolKindV1Schema).min(1).nullable(),
  allowedModelIds: z.array(z.string().trim().min(1).max(256)).min(1).nullable(),
  reasoningEffort: z.object({
    allowedValues: z.array(z.string().trim().min(1).max(64)).min(1),
    defaultValue: z.string().trim().min(1).max(64),
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.reasoningEffort && !value.reasoningEffort.allowedValues.includes(value.reasoningEffort.defaultValue)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasoningEffort', 'defaultValue'], message: 'defaultValue must be allowed' });
  }
  if (value.allowedProtocolKinds && new Set(value.allowedProtocolKinds).size !== value.allowedProtocolKinds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedProtocolKinds'], message: 'values must be unique' });
  }
  if (value.allowedModelIds && new Set(value.allowedModelIds).size !== value.allowedModelIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedModelIds'], message: 'values must be unique' });
  }
  if (value.reasoningEffort && new Set(value.reasoningEffort.allowedValues).size !== value.reasoningEffort.allowedValues.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasoningEffort', 'allowedValues'], message: 'values must be unique' });
  }
}));

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
export const TeamCredentialRequestPolicyModelSupportV1Schema = lazyZodSchema(() => z.object({
  descriptor: ProviderModelDescriptorV1Schema,
  application: ProviderBrokerApplicationBindingV1Schema,
  sourceRevision: z.string().trim().min(1).max(512),
  allowedProtocolKinds: z.array(TeamCredentialRequestProtocolKindV1Schema).min(1).max(3),
  reasoningEffort: z.object({
    allowedValues: z.array(z.string().trim().min(1).max(64)).min(1).max(64),
    defaultValue: z.string().trim().min(1).max(64),
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.allowedProtocolKinds).size !== value.allowedProtocolKinds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedProtocolKinds'], message: 'values must be unique' });
  }
  if (value.reasoningEffort) {
    if (new Set(value.reasoningEffort.allowedValues).size !== value.reasoningEffort.allowedValues.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasoningEffort', 'allowedValues'], message: 'values must be unique' });
    }
    if (!value.reasoningEffort.allowedValues.includes(value.reasoningEffort.defaultValue)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reasoningEffort', 'defaultValue'], message: 'defaultValue must be allowed' });
    }
  }
}));
export type TeamCredentialRequestPolicyModelSupportV1 = z.infer<
  typeof TeamCredentialRequestPolicyModelSupportV1Schema
>;

export const TeamCredentialRequestPolicySupportInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('source_draft'),
    teamId: z.string().min(1),
    source: TeamCredentialSourceBindingV1Schema,
    brokerPlacement: TeamCredentialBrokerPlacementV1Schema.nullable(),
  }).strict(),
  z.object({
    scope: z.literal('resource'),
    resourceId: z.string().min(1).max(256),
  }).strict(),
]));
export type TeamCredentialRequestPolicySupportInputV1 = z.infer<
  typeof TeamCredentialRequestPolicySupportInputV1Schema
>;

export const TeamCredentialRequestPolicySupportOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    models: z.array(TeamCredentialRequestPolicyModelSupportV1Schema),
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum([
      'broker_unavailable',
      'source_unavailable',
      'update_required',
      'unsupported_application',
      'model_catalog_unavailable',
    ]),
  }).strict(),
]));
export type TeamCredentialRequestPolicySupportOutputV1 = z.infer<
  typeof TeamCredentialRequestPolicySupportOutputV1Schema
>;

export const TeamCredentialResourceCreateInputV1Schema = lazyZodSchema(() => z.object({
  teamId: z.string().min(1), resourceId: z.string().min(1).max(256),
  displayName: z.string().trim().min(1).max(120),
  source: TeamCredentialSourceBindingV1Schema,
  disclosureCeiling: TeamCredentialDisclosureCeilingV1Schema,
  sessionUsePolicy: TeamCredentialSessionUsePolicyV1Schema,
  brokerPlacement: TeamCredentialBrokerPlacementV1Schema.nullable(),
  requestPolicy: TeamCredentialRequestPolicyV1Schema.nullable(),
  allMembersDeliveryMode: TeamCredentialDeliveryModeV1Schema.nullable(),
  groupGrants: z.array(z.object({
    teamGroupId: z.string().min(1),
    deliveryMode: TeamCredentialDeliveryModeV1Schema,
  }).strict()),
  memberGrants: z.array(z.object({
    teamMembershipId: z.string().min(1),
    deliveryMode: TeamCredentialDeliveryModeV1Schema,
  }).strict()),
  usageLimits: z.array(TeamCredentialUsageLimitDefinitionV1Schema),
}).strict());


export const TeamCredentialResourceAudienceGrantV1Schema = lazyZodSchema(() => z.object({
  teamGroupId: z.string().min(1),
  deliveryMode: TeamCredentialDeliveryModeV1Schema,
}).strict());

export const TeamCredentialResourceMemberGrantV1Schema = lazyZodSchema(() => z.object({
  teamMembershipId: z.string().min(1),
  deliveryMode: TeamCredentialDeliveryModeV1Schema,
}).strict());

export const TeamCredentialResourceAudienceInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
  allMembersDeliveryMode: TeamCredentialDeliveryModeV1Schema.nullable(),
  groupGrants: z.array(TeamCredentialResourceAudienceGrantV1Schema),
  memberGrants: z.array(TeamCredentialResourceMemberGrantV1Schema),
}).strict());

export const TeamCredentialResourceDeleteInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
}).strict());

export const TeamCredentialResourceReplacementV1Schema = lazyZodSchema(() => z.object({
  enabled: z.boolean(),
  displayName: z.string().trim().min(1).max(120),
  sessionUsePolicy: TeamCredentialSessionUsePolicyV1Schema,
  requestPolicy: TeamCredentialRequestPolicyV1Schema.nullable(),
  allMembersDeliveryMode: TeamCredentialDeliveryModeV1Schema.nullable(),
  groupGrants: z.array(TeamCredentialResourceAudienceGrantV1Schema),
  memberGrants: z.array(TeamCredentialResourceMemberGrantV1Schema),
  /** Present only when the source custodian intentionally edits their private authority. */
  custodian: z.object({
    source: TeamCredentialSourceBindingV1Schema,
    disclosureCeiling: TeamCredentialDisclosureCeilingV1Schema,
    brokerPlacement: TeamCredentialBrokerPlacementV1Schema.nullable(),
  }).strict().optional(),
  /** Bounded edits preserve limit rows omitted by paginated administration reads. */
  usageLimitDelta: z.object({
    upserts: z.array(TeamCredentialUsageLimitDefinitionV1Schema.extend({
      id: z.string().min(1).optional(),
    })),
    deleteIds: z.array(z.string().min(1)),
  }).strict().superRefine((value, context) => {
    if (new Set(value.deleteIds).size !== value.deleteIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['deleteIds'], message: 'values must be unique' });
    }
  }),
}).strict());

export const TeamCredentialResourceUpdateInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
  enabled: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  disclosureCeiling: TeamCredentialDisclosureCeilingV1Schema.optional(),
  sessionUsePolicy: TeamCredentialSessionUsePolicyV1Schema.optional(),
  brokerPlacement: TeamCredentialBrokerPlacementV1Schema.nullable().optional(),
  requestPolicy: TeamCredentialRequestPolicyV1Schema.nullable().optional(),
  replacement: TeamCredentialResourceReplacementV1Schema.optional(),
}).strict().superRefine((value, context) => {
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
      context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'legacy patch fields cannot be mixed with replacement' });
    }
  }
}));

export const TeamCredentialResourceReadInputV1Schema = lazyZodSchema(() => z.object({
  teamId: z.string().min(1),
  /** Exact Agent/Provider application whose current models are requested. */
  application: ProviderBrokerApplicationBindingV1Schema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict());

export const TeamCredentialResourceListFilterV1Schema = lazyZodSchema(() => z.enum([
  'all',
  'needs_attention',
  'brokered',
  'direct',
  'external_api',
]));

/** Administration-list query. Recipient catalog application selection remains
 * on the separate read input above. */
export const TeamCredentialResourceListInputV1Schema = lazyZodSchema(() => z.object({
  teamId: z.string().min(1),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  search: z.string().trim().min(1).max(120).optional(),
  filter: TeamCredentialResourceListFilterV1Schema.default('all'),
}).strict());

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

export const TeamCredentialResourceGetInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1).max(256),
}).strict());

export const TeamCredentialResourceSourcePresentationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('connected_service'),
    service: QualifiedConnectedAccountServiceRefZodSchema,
  }).strict(),
  z.object({
    kind: z.literal('provider'),
    provider: TeamCredentialProviderPresentationV1Schema,
  }).strict(),
]));

export const TeamCredentialBrokerPresentationV1Schema = lazyZodSchema(() => z.object({
  selectedTarget: z.object({ machineId: z.string().min(1), displayName: z.string().trim().min(1).max(120).nullable(), availability: z.enum(['available', 'offline', 'update_required']) }).strict().nullable(),
  eligibleTargets: z.array(z.object({ machineId: z.string().min(1), displayName: z.string().trim().min(1).max(120).nullable(), availability: z.enum(['available', 'offline', 'update_required']) }).strict()),
  // Pool names use the canonical MachinePoolNameV1 contract and may be longer
  // than the bounded Machine-label presentation. Keep the full domain value
  // here; UI surfaces may ellipsize visually without making a valid resource
  // summary parse as resource_corrupt.
  selectedPool: z.object({ poolId: z.string().min(1).max(256), displayName: MachinePoolNameV1Schema.nullable(), availability: z.enum(['available', 'unavailable', 'not_verified']), availableMachineCount: z.number().int().nonnegative().nullable() }).strict().nullable(),
  eligiblePools: z.array(z.object({ poolId: z.string().min(1).max(256), displayName: MachinePoolNameV1Schema.nullable(), availability: z.enum(['available', 'unavailable', 'not_verified']), availableMachineCount: z.number().int().nonnegative().nullable() }).strict()),
}).strict());

/**
 * Operation-specific administration authority for one resource row.
 *
 * This is projected by the Home beside the row it authorized. A client cannot
 * derive these facts from Team role, source identity, enabled state, or the
 * presence of private fields without becoming a second policy owner.
 */
export const TeamCredentialResourceAdministrationCapabilitiesV1Schema = lazyZodSchema(() => z.object({
  manageAudience: z.boolean(),
  managePolicy: z.boolean(),
  manageLimits: z.boolean(),
  updateBrokerPlacement: z.boolean(),
  narrowDisclosure: z.boolean(),
  /** Source custodian consent to widen `brokered_only` to `direct_allowed`.
   * Absent on an older Home is read as not permitted. */
  widenDisclosure: z.boolean().default(false),
  refreshDirectMaterial: z.boolean(),
  disable: z.boolean(),
  enable: z.boolean(),
  delete: z.boolean(),
}).strict());

export const TeamCredentialResourceSummaryV1Schema = lazyZodSchema(() => z.object({
  id: z.string(), teamId: z.string(), custodianAccountId: z.string(),
  /** Human label for the source owner; the stable Account id remains above. */
  sourceOwnerDisplayName: z.string().trim().min(1).max(120).nullable().default(null),
  displayName: z.string(), enabled: z.boolean(), revision: z.number().int().nonnegative(),
  disclosureCeiling: TeamCredentialDisclosureCeilingV1Schema,
  sessionUsePolicy: TeamCredentialSessionUsePolicyV1Schema,
  /** Exact source lifetime is visible only to its custodian. */
  source: TeamCredentialSourceBindingV1Schema.nullable(),
  /** Recipient-safe source family shown to every authorized administrator. */
  sourcePresentation: TeamCredentialResourceSourcePresentationV1Schema.nullable(),
  /** Safe source-owner projection used to keep direct choices truthful. */
  directExportSupport: z.enum(['supported', 'mixed', 'unsupported']).default('unsupported'),
  usageCapabilities: TeamCredentialUsageCapabilitiesV1Schema.optional(),
  /** Enabled limits only; detailed evaluation remains owned by the limits API. */
  activeUsageLimitCount: z.number().int().nonnegative().default(0),
  requestPolicy: TeamCredentialRequestPolicyV1Schema.nullable(),
  brokerPlacement: TeamCredentialBrokerPlacementV1Schema.nullable(),
  allMembersDeliveryMode: TeamCredentialDeliveryModeV1Schema.nullable(),
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
  recoveryAction: z.enum([
    'retry',
    'source_owner_action',
    'select_broker',
    'update_required',
    'choose_another_resource',
  ]).nullable(),
  brokerPresentation: TeamCredentialBrokerPresentationV1Schema,
  // Older Homes do not project operation-specific administration authority.
  // New readers must degrade to no authority rather than reject the otherwise
  // usable row or infer permissions from legacy role/source fields.
  capabilities: TeamCredentialResourceAdministrationCapabilitiesV1Schema.default({
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
}).strict().superRefine((value, context) => {
  if (value.sourcePresentation === null && value.readiness.kind === 'available') {
    context.addIssue({ code: 'custom', path: ['sourcePresentation'], message: 'An available resource must have a current source presentation' });
  }
}));

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
export const TeamCredentialViewerCapabilitiesV1Schema = lazyZodSchema(() => z.object({
  /** May create, edit, re-audience and delete this Team's resources. */
  manageCredentials: z.boolean(),
  /** May offer one of their own owned sources to this Team. */
  offerOwnCredential: z.boolean(),
}).strict());

/** Least-privilege selection catalog. Source and administration authority never cross this seam. */
export const TeamCredentialProviderModelSelectionV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('team_credential_provider_model'),
  resourceId: z.string().min(1).max(256),
  teamId: z.string().min(1),
  expectedResourceRevision: z.number().int().nonnegative(),
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema,
  deliveryMode: TeamCredentialRouteV1Schema,
}).strict());

export const TeamCredentialProviderModelCatalogEntryV1Schema = lazyZodSchema(() => z.object({
  selection: TeamCredentialProviderModelSelectionV1Schema,
  descriptor: ProviderModelDescriptorV1Schema,
  /** Exact source-owned application capable of serving this model. */
  application: ProviderBrokerApplicationBindingV1Schema,
  /** Opaque current source/catalog identity. It contains no source-private data. */
  sourceRevision: z.string().min(1).max(512),
  /** Opaque recipient-safe witness for current private direct material. */
  direct: z.object({
    sourceMemberKey: z.string().min(1).max(512),
    sourceVersion: z.string().min(1).max(512),
  }).strict().nullable().optional(),
  availability: z.enum(['available', 'source_owner_required', 'resource_corrupt', 'policy_denied']),
}).strict().superRefine((value, context) => {
  if (value.selection.modelId !== value.descriptor.id) {
    context.addIssue({ code: 'custom', path: ['descriptor', 'id'], message: 'Descriptor must identify the selected canonical model' });
  }
  if (value.selection.agentTargetKey !== value.application.agentTargetKey) {
    context.addIssue({ code: 'custom', path: ['application', 'agentTargetKey'], message: 'Application must target the selected Agent' });
  }
}));

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

export const TeamCredentialResourceCatalogEntryV1Schema = lazyZodSchema(() => z.object({
  id: z.string(),
  teamId: z.string(),
  displayName: z.string(),
  resourceRevision: z.number().int().nonnegative(),
  readiness: TeamCredentialResourceReadinessV1Schema,
  recoveryAction: TeamCredentialResourceRecoveryActionV1Schema.nullable(),
  mayBroker: z.boolean(),
  mayReceiveDirect: z.boolean(),
  directMaterialState: TeamCredentialDirectMaterialStateV1Schema,
  /**
   * Retained first-disclosure history for this viewer, separate from the
   * readiness `directMaterialState` describes: present and true only when the
   * Home has recorded a direct delivery to them. Absence means no recorded
   * disclosure, so first direct use still asks (child 06 L10D-R3).
   */
  directDeliveryRecorded: z.boolean().optional(),
  sessionUsePolicy: TeamCredentialSessionUsePolicyV1Schema.nullable(),
  providerModels: z.array(TeamCredentialProviderModelCatalogEntryV1Schema),
  /** Exact, content-free direct Connected Service choices current for this recipient. */
  connectedServiceSelections: z.array(TeamResourceConnectedServiceSelectionV2Schema).default([]),
  sourcePresentation: TeamCredentialResourceSourcePresentationV1Schema.nullable(),
  usageCapabilities: TeamCredentialUsageCapabilitiesV1Schema.optional(),
  /** Current exhausted broker ceiling for this recipient, without private
   * limit/audience/member identity. */
  usageLimit: TeamCredentialUsageLimitDenialV1Schema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.sourcePresentation === null && value.readiness.kind === 'available' && value.providerModels.length === 0) {
    context.addIssue({ code: 'custom', path: ['sourcePresentation'], message: 'An available catalog row must have a current source presentation' });
  }
}));

export const TeamCredentialResourcePageV1Schema = lazyZodSchema(() => z.object({
  /** Administration rows: Team managers plus the viewer's own source rows only. */
  resources: z.array(TeamCredentialResourceSummaryV1Schema),
  viewer: TeamCredentialViewerCapabilitiesV1Schema,
  nextCursor: z.string().min(1).max(512).nullable().default(null),
}).strict());

export const TeamCredentialResourceEntitledPageV1Schema = lazyZodSchema(() => z.object({
  resources: z.array(TeamCredentialResourceCatalogEntryV1Schema).max(100),
  nextCursor: z.string().min(1).max(512).nullable().default(null),
}).strict());

export const TeamCredentialResourceMutationResultV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string(), revision: z.number().int().nonnegative(),
}).strict());

export const TeamCredentialActivityKindV1Schema = lazyZodSchema(() => z.enum([
  'resource_created', 'resource_updated', 'resource_deleted', 'audience_changed',
  'direct_delivered', 'external_key_created', 'external_key_revoked', 'limits_changed',
]));
export type TeamCredentialActivityKindV1 = z.infer<typeof TeamCredentialActivityKindV1Schema>;

export const TeamCredentialResourceActivityReadInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1).max(256),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict());

export const TeamCredentialResourceActivityEventV1Schema = lazyZodSchema(() => z.object({
  kind: TeamCredentialActivityKindV1Schema,
  actorDisplayName: z.string().trim().min(1).max(120).nullable(),
  subjectDisplayName: z.string().trim().min(1).max(120),
  createdAt: z.string().datetime({ offset: true }),
}).strict());

export const TeamCredentialResourceActivityPageV1Schema = lazyZodSchema(() => z.object({
  items: z.array(TeamCredentialResourceActivityEventV1Schema).max(100),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict());

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

export const TeamCredentialResourceErrorV1Schema = lazyZodSchema(() => z.object({
  error: TeamCredentialErrorCodeV1Schema,
}).strict());

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
