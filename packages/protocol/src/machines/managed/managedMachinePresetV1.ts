import { z } from 'zod';
import * as mini from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema } from '../../teams/principal.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { ManagedRefusalCodeV1Schema } from './providerFactsV1.js';
import { ManagedControllerV1Schema, RetentionV1Schema, createValidatedLaunchSnapshotV1Schema } from './managedMachineV1.js';
import { MachineEnvironmentV1Schema } from './machineEnvironmentV1.js';
export { MachineEnvironmentV1Schema, MachineEnvironmentV1ReadSchema, type MachineEnvironmentV1 } from './machineEnvironmentV1.js';

const id = () => z.string().trim().min(1);
const revision = () => z.number().int().nonnegative();

export const ManagedMachinePresetOwnerV1Schema = lazyZodSchema(() => z.union([
  AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema,
]));
export const ManagedMachinePresetLimitV1Schema = lazyZodSchema(() => z.object({ maximum: z.number().int().positive() }).strict());

/** Recipes are future choices. The contributed validator owns the native choice shape. */
export function createManagedMachinePresetV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.object({
    id: id(), homeId: id(), revision: revision(), name: id(),
    owner: ManagedMachinePresetOwnerV1Schema,
    recipe: createValidatedLaunchSnapshotV1Schema(choices),
    controller: ManagedControllerV1Schema,
    environment: MachineEnvironmentV1Schema.optional(),
    retention: mini.optional(RetentionV1Schema),
    wakeOnAcceptedMessage: z.boolean().optional(),
    simultaneousLimit: ManagedMachinePresetLimitV1Schema.optional(),
    archivedAt: z.number().nonnegative().optional(),
  }).strict();
}

/** Transport validates the envelope; save/use additionally validate the selected contribution. */
export const ManagedMachinePresetV1Schema = lazyZodSchema(() => createManagedMachinePresetV1Schema(PluginJsonValueV2Schema));
export const ManagedMachinePresetV1ReadSchema = createStoredReadSchema(ManagedMachinePresetV1Schema);
export type ManagedMachinePresetV1 = z.infer<typeof ManagedMachinePresetV1Schema>;

export const ManagedMachinePresetCreateInputV1Schema = lazyZodSchema(() => ManagedMachinePresetV1Schema
  .omit({ revision: true, archivedAt: true }));
export const ManagedMachinePresetGetInputV1Schema = lazyZodSchema(() => z.object({ homeId: id(), id: id() }).strict());
export const ManagedMachinePresetListInputV1Schema = lazyZodSchema(() => z.object({
  homeId: id(), owner: ManagedMachinePresetOwnerV1Schema.optional(), search: z.string().optional(),
  includeArchived: z.boolean().optional(), cursor: id().optional(),
}).strict());
export const ManagedMachinePresetUpdateInputV1Schema = lazyZodSchema(() => z.object({
  homeId: id(), id: id(), expectedRevision: revision(),
  patch: z.object({
    name: id().optional(),
    recipe: mini.optional(createValidatedLaunchSnapshotV1Schema(PluginJsonValueV2Schema)),
    controller: mini.optional(ManagedControllerV1Schema),
    environment: MachineEnvironmentV1Schema.nullable().optional(),
    retention: mini.optional(mini.nullable(RetentionV1Schema)),
    wakeOnAcceptedMessage: z.boolean().nullable().optional(),
    simultaneousLimit: ManagedMachinePresetLimitV1Schema.nullable().optional(),
  }).strict(),
}).strict());
export const ManagedMachinePresetRevisionInputV1Schema = lazyZodSchema(() => z.object({
  homeId: id(), id: id(), expectedRevision: revision(),
}).strict());
export const ManagedMachinePresetRefusalCodeV1Schema = ManagedRefusalCodeV1Schema;
export const ManagedMachinePresetRefusedV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('refused'), code: ManagedMachinePresetRefusalCodeV1Schema,
}).strict());
export const PresetMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved'), preset: ManagedMachinePresetV1Schema }).strict(),
  z.object({ kind: z.literal('conflict'), currentRevision: revision() }).strict(),
  ManagedMachinePresetRefusedV1Schema,
]));
export const ManagedMachinePresetGetResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('found'), preset: ManagedMachinePresetV1Schema }).strict(),
  ManagedMachinePresetRefusedV1Schema,
]));
export const ManagedMachinePresetListResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('listed'), presets: z.array(ManagedMachinePresetV1Schema), cursor: id().optional() }).strict(),
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
