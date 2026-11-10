import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { WorkspaceExecutionConfigAddressV1Schema } from '../../workspaces/projectWorkerPreferencesV1.js';
import { ProjectMemoryDemandV1Schema } from '../../workspaces/projectSetup/projectMemoryDemandV1.js';
import { ManagedControllerV1Schema, ManagedControllerAccessV1Schema } from '../managed/managedMachineV1.js';
import { ManagedConfigurationFactsV1Schema } from '../managed/managedConfigurationV1.js';
import { MachineProvisionerContributionV1Schema } from '../../plugins/contributions/machineProvisioners.js';
import { ManagedRefusalCodeV1Schema } from '../managed/providerFactsV1.js';

/** Closed purpose model: automation and Boards remain own-Machine destinations. */
export const MachineDestinationPurposeV1Schema = lazyZodSchema(() => z.enum([
  'session', 'finite', 'service-start', 'workflow', 'trigger', 'background', 'boards',
]));
export type MachineDestinationPurposeV1 = z.infer<typeof MachineDestinationPurposeV1Schema>;

export const MachinePoolPlacementPurposeV1Schema = lazyZodSchema(() => z.enum(['session', 'finite', 'service-start']));
export type MachinePoolPlacementPurposeV1 = z.infer<typeof MachinePoolPlacementPurposeV1Schema>;

/**
 * Machine Pool wire model.
 *
 * A pool is a reusable named set of its custodian's persistent Machines on one Home. It confers
 * no Session, Machine or credential authority: sharing exposes metadata to its Team. Membership
 * is a saved preference that later exact dispatch revalidates at its own canonical owners.
 * Creation derives custody from the authenticated Account, never a caller-supplied owner field.
 * No candidate list, request key, score or selection result is part of the persisted definition.
 */

/** The stable pool identity. The authoring host mints it once and reuses it for retry. */
export const MachinePoolIdV1Schema = lazyZodSchema(() => z.string().check(z.uuid()));
export type MachinePoolIdV1 = z.infer<typeof MachinePoolIdV1Schema>;

/** Sharing permits preset discovery; it never grants access to a controller Machine. */
export const MachinePoolAudienceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('private') }),
  z.strictObject({ kind: z.literal('team'), teamId: z.string().check(z.minLength(1)) }),
]));
export type MachinePoolAudienceV1 = z.infer<typeof MachinePoolAudienceV1Schema>;

/** The pool owner projects these permissions once; consumers do not infer them from audience. */
export const MachinePoolAccessV1Schema = lazyZodSchema(() => z.strictObject({
  canManage: z.boolean(),
  canResolve: z.boolean(),
  canViewMembers: z.boolean(),
}));
export type MachinePoolAccessV1 = z.infer<typeof MachinePoolAccessV1Schema>;

/** Informational provenance retained after a pool has resolved to an exact Machine. */
export const MachinePoolSelectionOriginV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('machine_pool'),
  poolId: MachinePoolIdV1Schema,
}));
export type MachinePoolSelectionOriginV1 = z.infer<typeof MachinePoolSelectionOriginV1Schema>;

/**
 * Trimmed nonempty display text. Duplicate names are permitted: identity is the pool ID, never the
 * name, so no case-folding policy or unique-name index approximates identity here.
 */
export const MachinePoolNameV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

/** Empty description text normalizes to null at the domain owner. */
export const MachinePoolDescriptionV1Schema = lazyZodSchema(() => z.string().check(z.trim()));

/**
 * A nonnegative ordinal compared by numeric order. The editor serializes contiguous ordinals; the
 * server accepts valid sparse ones. Equal-tier membership is unordered.
 */
export const MachinePoolPriorityTierV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(2_147_483_647)));

/** One saved member. Duplicate Machine IDs are invalid, never silently deduplicated. */
export const MachinePoolMemberInputV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  priorityTier: MachinePoolPriorityTierV1Schema,
  enabled: z.boolean(),
}));
export type MachinePoolMemberInputV1 = z.infer<typeof MachinePoolMemberInputV1Schema>;

const MachinePoolMembersInputV1Schema = lazyZodSchema(() => z.array(MachinePoolMemberInputV1Schema).check(z.superRefine((members, context) => {
  const seen = new Set<string>();
  members.forEach((member, index) => {
    if (seen.has(member.machineId)) {
      context.addIssue({
        code: "custom",
        path: [index, 'machineId'],
        message: 'A Machine can appear only once in a pool.',
      });
      return;
    }
    seen.add(member.machineId);
  });
})));

/**
 * Observed current state of one member, as actually determined. `unknown` is used when the socket
 * inventory could not be observed; it is never reported as `offline`, which would falsely assert
 * that the Machine is disconnected.
 */
export const MachinePoolMemberStateV1Schema = lazyZodSchema(() => z.enum([
  'connected',
  'offline',
  'revoked',
  'replaced',
  'temporary',
  'unknown',
]));
export type MachinePoolMemberStateV1 = z.infer<typeof MachinePoolMemberStateV1Schema>;

/** A member projection: saved definition plus its safe current state. No Machine metadata leaks. */
export const MachinePoolMemberV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  priorityTier: MachinePoolPriorityTierV1Schema,
  enabled: z.boolean(),
  state: MachinePoolMemberStateV1Schema,
}));
export type MachinePoolMemberV1 = z.infer<typeof MachinePoolMemberV1Schema>;

/** The saved definition plus its current member projection. */
export const MachinePoolSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  id: MachinePoolIdV1Schema,
  name: MachinePoolNameV1Schema,
  description: z.nullable(z.string()),
  revision: z.number().check(z.int(), z.nonnegative()),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
  audience: z.optional(MachinePoolAudienceV1Schema),
  members: z.array(MachinePoolMemberV1Schema),
}));
export type MachinePoolSummaryV1 = z.infer<typeof MachinePoolSummaryV1Schema>;

/**
 * Reachability is an observation, not stored state. `connectedCount` counts enabled, current,
 * generically eligible members with an exact live socket; it never promises Agent, provider, path
 * or broker readiness, and no `full`, `busy` or `draining` count is synthesized.
 */
export const MachinePoolAvailabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('known'),
    connectedCount: z.number().check(z.int(), z.nonnegative()),
    enabledCount: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({ state: z.literal('unknown') }),
]));
export type MachinePoolAvailabilityV1 = z.infer<typeof MachinePoolAvailabilityV1Schema>;

/** What a client renders: one definition and its separately observed availability. */
export const MachinePoolViewV1Schema = lazyZodSchema(() => z.strictObject({
  pool: MachinePoolSummaryV1Schema,
  availability: MachinePoolAvailabilityV1Schema,
  access: z.optional(MachinePoolAccessV1Schema),
}));
export type MachinePoolViewV1 = z.infer<typeof MachinePoolViewV1Schema>;

/**
 * The Home-local selection result. `machineId` alone is returned; the caller binds its own captured
 * `serverId`, because a server cannot manufacture the client's configured Home identity.
 */
export const MachinePoolResolveResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('resolved'),
    poolId: MachinePoolIdV1Schema,
    machineId: z.string().check(z.minLength(1)),
    priorityTier: MachinePoolPriorityTierV1Schema,
    managedPreset: z.optional(z.strictObject({ controller: ManagedControllerV1Schema,
      controllerAccess: ManagedControllerAccessV1Schema, provisioner: MachineProvisionerContributionV1Schema,
      reviewedFacts: ManagedConfigurationFactsV1Schema })),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    poolId: MachinePoolIdV1Schema,
    reason: z.enum(['empty', 'no_available_machine', 'presence_unavailable', 'worker_status_unavailable', 'managed_preset_unavailable']),
    code: z.optional(ManagedRefusalCodeV1Schema),
  }),
]));
export type MachinePoolResolveResultV1 = z.infer<typeof MachinePoolResolveResultV1Schema>;

/**
 * Stable domain errors. `pool_not_found` is deliberately non-disclosing: a nonexistent pool and
 * another Account's pool are indistinguishable. `member_machine_not_eligible` echoes only Machine
 * IDs the authorized owner already supplied, never hidden foreign Machine metadata.
 */
export const MachinePoolErrorV1Schema = lazyZodSchema(() => z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('invalid_request'), message: z.string().check(z.minLength(1)) }),
  z.strictObject({ code: z.literal('pool_not_found') }),
  z.strictObject({ code: z.literal('pool_changed'), current: z.optional(MachinePoolViewV1Schema) }),
  z.strictObject({
    code: z.literal('member_machine_not_eligible'),
    machineIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
  }),
]));
export type MachinePoolErrorV1 = z.infer<typeof MachinePoolErrorV1Schema>;

/** New-reference admission only; saved unavailable references retain their edit semantics. */
export const MachinePoolMemberEligibilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('eligible', [
  z.strictObject({ machineId: z.string(), eligible: z.literal(true) }),
  z.strictObject({
    machineId: z.string(),
    eligible: z.literal(false),
    reason: z.enum(['not_owned_or_missing', 'temporary', 'revoked', 'replaced']),
  }),
]));
export type MachinePoolMemberEligibilityV1 = z.infer<typeof MachinePoolMemberEligibilityV1Schema>;

export const MachinePoolListInputV1Schema = lazyZodSchema(() => z.strictObject({
  memberMachineIds: z.optional(z.array(z.string().check(z.minLength(1)))),
}));
export type MachinePoolListInputV1 = z.infer<typeof MachinePoolListInputV1Schema>;

export const MachinePoolListOutputV1Schema = lazyZodSchema(() => z.strictObject({
  pools: z.array(MachinePoolViewV1Schema),
  memberEligibility: z.optional(z.array(MachinePoolMemberEligibilityV1Schema)),
}));
export type MachinePoolListOutputV1 = z.infer<typeof MachinePoolListOutputV1Schema>;

export const MachinePoolGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  poolId: MachinePoolIdV1Schema,
}));
export type MachinePoolGetInputV1 = z.infer<typeof MachinePoolGetInputV1Schema>;

/**
 * The authoring host supplies the pool ID so a lost response can be reconciled by replaying the
 * same submission: an identical normalized aggregate at that ID returns unchanged, a different one
 * conflicts, and another owner's ID answers with the same nondisclosing conflict without current data.
 */
export const MachinePoolCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  poolId: MachinePoolIdV1Schema,
  name: MachinePoolNameV1Schema,
  description: z.optional(z.nullable(MachinePoolDescriptionV1Schema)),
  audience: z.optional(MachinePoolAudienceV1Schema),
  members: MachinePoolMembersInputV1Schema,
}));
export type MachinePoolCreateInputV1 = z.infer<typeof MachinePoolCreateInputV1Schema>;

/** One complete replacement of the definition; there is no per-member Action. */
export const MachinePoolUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  poolId: MachinePoolIdV1Schema,
  expectedRevision: z.number().check(z.int(), z.nonnegative()),
  name: MachinePoolNameV1Schema,
  description: z.optional(z.nullable(MachinePoolDescriptionV1Schema)),
  audience: z.optional(MachinePoolAudienceV1Schema),
  members: MachinePoolMembersInputV1Schema,
}));
export type MachinePoolUpdateInputV1 = z.infer<typeof MachinePoolUpdateInputV1Schema>;

export const MachinePoolDeleteInputV1Schema = lazyZodSchema(() => z.strictObject({
  poolId: MachinePoolIdV1Schema,
  expectedRevision: z.number().check(z.int(), z.nonnegative()),
}));
export type MachinePoolDeleteInputV1 = z.infer<typeof MachinePoolDeleteInputV1Schema>;

export const MachinePoolDeleteOutputV1Schema = lazyZodSchema(() => z.strictObject({
  poolId: MachinePoolIdV1Schema,
  deleted: z.literal(true),
}));
export type MachinePoolDeleteOutputV1 = z.infer<typeof MachinePoolDeleteOutputV1Schema>;

/**
 * `requestKey` is required: the caller's existing selection identity spreads independent requests
 * across equal-tier Machines and makes transport retry of one selection deterministic. It is never
 * persisted, and reopening an already resolved draft keeps its exact target instead of re-resolving.
 */
export const MachinePoolResolveInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    poolId: MachinePoolIdV1Schema,
    requestKey: z.string().check(z.minLength(1)),
    purpose: z.literal('managed-preset'),
    preset: z.strictObject({ homeId: z.string().check(z.minLength(1)), id: z.string().check(z.minLength(1)),
      revision: z.number().check(z.int(), z.nonnegative()) }),
  }),
  z.strictObject({
    poolId: MachinePoolIdV1Schema,
    requestKey: z.string().check(z.minLength(1)),
    purpose: z.optional(z.literal('session')),
  }),
  z.strictObject({
    poolId: MachinePoolIdV1Schema,
    requestKey: z.string().check(z.minLength(1)),
    purpose: z.enum(['finite', 'service-start']),
    workspace: WorkspaceExecutionConfigAddressV1Schema,
    memoryDemand: z.optional(ProjectMemoryDemandV1Schema),
  }),
]));
export type MachinePoolResolveInputV1 = z.infer<typeof MachinePoolResolveInputV1Schema>;
