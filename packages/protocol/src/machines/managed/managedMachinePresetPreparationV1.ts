import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createValidatedLaunchSnapshotV1Schema } from './managedMachineV1.js';
import { MachineSetupV1Schema } from './machineSetupV1.js';
import { ManagedNativeOperationReferenceV1Schema } from './providerFactsV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));

export const ManagedMachinePresetPreparationV1Schema = lazyZodSchema(() =>
  z.strictObject({ enabled: z.boolean() }));

/** Names and operational writes do not alter the image's authored configuration. */
export const ManagedMachinePresetPreparationConfigurationV1Schema = lazyZodSchema(() => {
  const { name: _name, ...launch } = createValidatedLaunchSnapshotV1Schema(PluginJsonValueV2Schema).shape;
  return z.strictObject({ launch: z.strictObject(launch), setup: z.optional(MachineSetupV1Schema) });
});

/** Supplier and credential owners supply identities; preparation never selects or hashes them. */
export const ManagedMachinePresetPreparationBindingV1Schema = lazyZodSchema(() => z.strictObject({
  presetRevision: z.number().check(z.int(), z.positive()),
  configuration: ManagedMachinePresetPreparationConfigurationV1Schema,
  cliIdentity: id(),
  credentialIdentity: z.nullable(id()),
}));
export type ManagedMachinePresetPreparationBindingV1 = Readonly<
  z.infer<typeof ManagedMachinePresetPreparationBindingV1Schema>>;

/** Private preset state retains native identity on failure or cancellation. */
export const ManagedMachinePresetPreparedV1Schema = lazyZodSchema(() => z.strictObject({
  operationId: id(),
  binding: ManagedMachinePresetPreparationBindingV1Schema,
  status: z.enum(['building', 'ready', 'failed', 'cancelled', 'stale']),
  artifact: z.optional(ManagedNativeOperationReferenceV1Schema),
  nativeOperationRef: z.optional(ManagedNativeOperationReferenceV1Schema),
  /** Exact credential-free setup completed by this build; omitted for a CLI-only image. */
  bakedSetup: z.optional(MachineSetupV1Schema),
  code: z.optional(id()),
}).check(z.refine(value => value.status !== 'ready' || value.artifact !== undefined,
  { message: 'Ready preparation requires a native artifact.' }))
  .check(z.refine(value => [value.artifact, value.nativeOperationRef].every(reference => reference === undefined
    || reference.contributionRef.pluginId === value.binding.configuration.launch.provider.pluginId
      && reference.contributionRef.localId === value.binding.configuration.launch.provider.localId
      && reference.schemaVersion === value.binding.configuration.launch.schemaVersion),
  { message: 'Prepared references must belong to the bound provider.' })));
export type ManagedMachinePresetPreparedV1 = Readonly<z.infer<typeof ManagedMachinePresetPreparedV1Schema>>;
