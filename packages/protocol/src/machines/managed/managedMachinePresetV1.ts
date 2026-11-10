import { z } from '../../zodRuntimePolicy.js';
import * as mini from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema } from '../../teams/principal.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { ManagedRefusalCodeV1Schema } from './providerFactsV1.js';
import { ManagedControllerV1Schema, ManagedControllerAccessV1Schema, ReusableRetentionV1Schema, createValidatedLaunchSnapshotV1Schema } from './managedMachineV1.js';
import { MachineSetupV1Schema } from './machineSetupV1.js';
import { ManagedConfigurationFactsV1Schema } from './managedConfigurationV1.js';
import { MachineProvisionerContributionV1Schema } from '../../plugins/contributions/machineProvisioners.js';
import { MachinePoolIdV1Schema } from '../pools/v1.js';
export { MachineSetupV1Schema, MachineSetupV1ReadSchema, MachineSetupScriptV1Schema, mergeMachineSetupsV1, type MachineSetupV1, type MachineSetupScriptV1 } from './machineSetupV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative());

/** Existing Account-change routing for saved preset content, including newly created records. */
export const MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'machine-presets' as const;

export const ManagedMachinePresetOwnerV1Schema = lazyZodSchema(() => z.union([
  AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema,
]));
export const ManagedMachinePresetLimitV1Schema = lazyZodSchema(() => z.strictObject({ maximum: z.number().check(z.int(), z.positive()) }));
export const ManagedMachinePresetDelegatedAcquireV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), controller: z.optional(ManagedControllerAccessV1Schema),
    provisioner: MachineProvisionerContributionV1Schema, reviewedFacts: ManagedConfigurationFactsV1Schema
      .check(z.refine(facts => facts.launch.credentials === undefined, { message: 'Delegated review never exposes credential selections.' })) }),
  z.strictObject({ kind: z.literal('unavailable'), code: ManagedRefusalCodeV1Schema }),
]));
export type ManagedMachinePresetDelegatedAcquireV1 = z.infer<typeof ManagedMachinePresetDelegatedAcquireV1Schema>;

/** Launch snapshots carry future choices. The contributed validator owns the native choice shape. */
function createManagedMachinePresetShapeV1<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject({
    id: id(), homeId: id(), revision: revision(), name: id(),
    owner: ManagedMachinePresetOwnerV1Schema,
    launch: z.optional(createValidatedLaunchSnapshotV1Schema(choices)),
    controller: z.optional(ManagedControllerV1Schema),
    controllerPoolId: z.optional(MachinePoolIdV1Schema),
    /** Author-saved presentation content; never grants access to the controller's metadata. */
    controllerDisplayName: z.optional(id()),
    setup: z.optional(MachineSetupV1Schema),
    retention: mini.optional(ReusableRetentionV1Schema),
    wakeOnAcceptedMessage: z.optional(z.boolean()),
    /** Explicit opt-in; visibility alone never grants Team acquire authority. */
    teamAcquireDelegated: z.optional(z.boolean()),
    delegatedAcquire: z.optional(ManagedMachinePresetDelegatedAcquireV1Schema),
    simultaneousLimit: z.optional(ManagedMachinePresetLimitV1Schema),
    archivedAt: z.optional(z.number().check(z.nonnegative())),
  });
}

/** Account creation may be portable; explicit delegation retains its installed controller. */
function hasValidPresetParts(preset: { launch?: unknown; controller?: unknown; controllerPoolId?: unknown; setup?: unknown;
  teamAcquireDelegated?: boolean; delegatedAcquire?: unknown }): boolean {
  return (!(preset.controller !== undefined && preset.controllerPoolId !== undefined))
    && (preset.controller === undefined && preset.controllerPoolId === undefined || preset.launch !== undefined)
    && (preset.launch !== undefined || preset.setup !== undefined)
    && (!(preset.teamAcquireDelegated || preset.delegatedAcquire !== undefined)
      || preset.controller !== undefined || preset.controllerPoolId !== undefined);
}

export function createManagedMachinePresetV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return createManagedMachinePresetShapeV1(choices).check(z.refine(hasValidPresetParts,
    { message: 'A Preset requires complete creation or setup.' }));
}

/** Transport validates the envelope; save/use additionally validate the selected contribution. */
export const ManagedMachinePresetV1Schema = lazyZodSchema(() => createManagedMachinePresetV1Schema(PluginJsonValueV2Schema));
export const ManagedMachinePresetV1ReadSchema = createStoredReadSchema(ManagedMachinePresetV1Schema);
export type ManagedMachinePresetV1 = z.infer<typeof ManagedMachinePresetV1Schema>;

export type ManagedMachinePresetCreationV1 = {
  launch: NonNullable<ManagedMachinePresetV1['launch']>;
  controller?: NonNullable<ManagedMachinePresetV1['controller']>;
  controllerPoolId?: NonNullable<ManagedMachinePresetV1['controllerPoolId']>;
};

/** Presence guard for typed Preset values and drafts; boundary schemas own validation. */
export function hasManagedMachinePresetCreationV1<T extends Readonly<{
  launch?: ManagedMachinePresetCreationV1['launch'] | null;
  controller?: ManagedMachinePresetCreationV1['controller'] | null;
}>>(preset: T | null | undefined): preset is T & ManagedMachinePresetCreationV1 {
  return preset?.launch != null && preset.controller !== null;
}

export const ManagedMachinePresetCreateInputV1Schema = lazyZodSchema(() => z.omit(
  createManagedMachinePresetShapeV1(PluginJsonValueV2Schema), { revision: true, archivedAt: true, delegatedAcquire: true },
).check(z.refine(hasValidPresetParts, { message: 'A Preset requires complete creation or setup.' })));
export const ManagedMachinePresetGetInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), id: id() }));
export const ManagedMachinePresetListInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), owner: z.optional(ManagedMachinePresetOwnerV1Schema), search: z.optional(z.string()),
  includeArchived: z.optional(z.boolean()), cursor: z.optional(id()),
}));
export const ManagedMachinePresetUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), id: id(), expectedRevision: revision(),
  patch: z.strictObject({
    name: z.optional(id()),
    launch: mini.optional(mini.nullable(createValidatedLaunchSnapshotV1Schema(PluginJsonValueV2Schema))),
    controller: mini.optional(mini.nullable(ManagedControllerV1Schema)),
    controllerPoolId: mini.optional(mini.nullable(MachinePoolIdV1Schema)),
    controllerDisplayName: z.optional(z.nullable(id())),
    setup: z.optional(z.nullable(MachineSetupV1Schema)),
    retention: mini.optional(mini.nullable(ReusableRetentionV1Schema)),
    wakeOnAcceptedMessage: z.optional(z.nullable(z.boolean())),
    teamAcquireDelegated: z.optional(z.boolean()),
    simultaneousLimit: z.optional(z.nullable(ManagedMachinePresetLimitV1Schema)),
  }),
}));
export const ManagedMachinePresetRevisionInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), id: id(), expectedRevision: revision(),
}));
export const ManagedMachinePresetRefusalCodeV1Schema = ManagedRefusalCodeV1Schema;
export const ManagedMachinePresetRefusedV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('refused'), code: ManagedMachinePresetRefusalCodeV1Schema,
}));
export const PresetMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('saved'), preset: ManagedMachinePresetV1Schema }),
  z.strictObject({ kind: z.literal('conflict'), currentRevision: revision() }),
  ManagedMachinePresetRefusedV1Schema,
]));
export const ManagedMachinePresetGetResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('found'), preset: ManagedMachinePresetV1Schema }),
  ManagedMachinePresetRefusedV1Schema,
]));
export const ManagedMachinePresetListResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('listed'), presets: z.array(ManagedMachinePresetV1Schema), cursor: z.optional(id()) }),
  ManagedMachinePresetRefusedV1Schema,
]));
export type ManagedMachinePresetCreateInputV1 = z.infer<typeof ManagedMachinePresetCreateInputV1Schema>;
export type ManagedMachinePresetUpdateInputV1 = z.infer<typeof ManagedMachinePresetUpdateInputV1Schema>;
export type ManagedMachinePresetGetInputV1 = z.infer<typeof ManagedMachinePresetGetInputV1Schema>;
export type ManagedMachinePresetListInputV1 = z.infer<typeof ManagedMachinePresetListInputV1Schema>;
export type ManagedMachinePresetRevisionInputV1 = z.infer<typeof ManagedMachinePresetRevisionInputV1Schema>;
export type PresetMutationResultV1 = z.infer<typeof PresetMutationResultV1Schema>;
export type ManagedMachinePresetGetResultV1 = z.infer<typeof ManagedMachinePresetGetResultV1Schema>;
export type ManagedMachinePresetListResultV1 = z.infer<typeof ManagedMachinePresetListResultV1Schema>;
