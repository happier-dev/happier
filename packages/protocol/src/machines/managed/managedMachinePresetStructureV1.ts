import { ResourceTeamShareScopeV1Schema } from '../../teams/resourceGrantAccessV1.js';
import { z } from '../../zodRuntimePolicy.js';
import * as mini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema } from '../../teams/principal.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { ManagedControllerV1Schema, ReusableRetentionV1Schema } from './managedMachineV1.js';
import { MachinePoolIdV1Schema } from '../pools/v1.js';
import { AccountEncryptionModeSchema } from '../../features/payload/capabilities/encryptionCapabilities.js';
import { ManagedMachinePresetStoredContentCarrierV1Schema, ManagedMachinePresetRecipientsV1Schema } from './managedMachinePresetContentCarrierV1.js';
import { ManagedMachinePresetIdentityV1Schema } from './managedMachinePresetIdentityV1.js';
const revision = () => z.number().check(z.int(), z.nonnegative());
export const ManagedMachinePresetOwnerV1Schema = lazyZodSchema(() => z.union([
  AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema,
]));
export const ManagedMachinePresetLimitV1Schema = lazyZodSchema(() => z.strictObject({ maximum: z.number().check(z.int(), z.positive()) }));
/** Structural fields only; semantic creation/delegation checks belong to the refined schema below. */
export function createManagedMachinePresetV1BaseShape<Choices extends z.core.$ZodType>(_choices: Choices) {
  return {
    ...ManagedMachinePresetIdentityV1Schema.shape, revision: revision(),
    sharedWithTeamScope: z.optional(ResourceTeamShareScopeV1Schema),
    /** Client-maintained launch/setup change counter; absent legacy rows mean zero. */
    configurationRevision: z.optional(revision()),
    /** Author-owned setup-only counter; metadata and launch edits leave it unchanged. */
    setupRevision: z.optional(revision()),
    owner: ManagedMachinePresetOwnerV1Schema,
    /** Persisted owner mode: readers must never substitute the viewer's Account mode. */
    contentEncryptionMode: AccountEncryptionModeSchema,
    content: ManagedMachinePresetStoredContentCarrierV1Schema,
    recipients: ManagedMachinePresetRecipientsV1Schema,
    controller: z.optional(ManagedControllerV1Schema),
    controllerPoolId: z.optional(MachinePoolIdV1Schema),
    retention: mini.optional(ReusableRetentionV1Schema),
    wakeOnAcceptedMessage: z.optional(z.boolean()),
    /** Explicit opt-in; visibility alone never grants Team acquire authority. */
    teamAcquireDelegated: z.optional(z.boolean()),
    simultaneousLimit: z.optional(ManagedMachinePresetLimitV1Schema),
    archivedAt: z.optional(z.number().check(z.nonnegative())),
    lastUsedAt: z.optional(z.number().check(z.nonnegative())),
  };
}

/** Unrefined structural schema for owner-local persistence/projection code. */
export function createManagedMachinePresetV1BaseSchema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject(createManagedMachinePresetV1BaseShape(choices));
}

export const ManagedMachinePresetV1BaseSchema = lazyZodSchema(() =>
  createManagedMachinePresetV1BaseSchema(PluginJsonValueV2Schema));
