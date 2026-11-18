import { lazyZodSchema } from '../../lazyZodSchema.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createValidatedLaunchSnapshotV1Schema } from './managedMachineV1.js';
import { MachineSetupV1Schema } from './machineSetupV1.js';
import { DevcontainerEffectReviewV1Schema } from './devcontainerV1.js';
import { MachineProvisionerNativeCauseV1Schema, ManagedNativeOperationReferenceV1Schema } from './providerFactsV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));

export const ManagedMachinePresetPreparationV1Schema = lazyZodSchema(() =>
  z.strictObject({ enabled: z.boolean(),
    /** Absent means update at start; rebuilding is an explicit author's cost-bearing choice. */
    whenHappierUpdates: z.optional(z.enum(['update-at-start', 'rebuild-automatically'])),
  }));

/** Physical execution selected once for an admitted Machine, separate from its authored source. */
export function createManagedMachinePresetPreparationExecutionV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject({
    launch: createValidatedLaunchSnapshotV1Schema(choices),
    binaryPath: id(),
    /** Current supplier differs from the image; keep its launch and install the CLI at start. */
    updateCli: z.optional(z.literal(true)),
    deferredSetup: z.optional(MachineSetupV1Schema),
  });
}
export const ManagedMachinePresetPreparationExecutionV1Schema = lazyZodSchema(() =>
  createManagedMachinePresetPreparationExecutionV1Schema(PluginJsonValueV2Schema));
export type ManagedMachinePresetPreparationExecutionV1 = Readonly<
  z.infer<typeof ManagedMachinePresetPreparationExecutionV1Schema>>;

/** Names and operational writes do not alter the image's authored configuration. */
export const ManagedMachinePresetPreparationConfigurationV1Schema = lazyZodSchema(() => {
  const { name: _name, ...launch } = createValidatedLaunchSnapshotV1Schema(PluginJsonValueV2Schema).shape;
  return z.strictObject({ launch: z.strictObject(launch), setup: z.optional(MachineSetupV1Schema),
    /** Source contents may change while the authored file path remains identical. */
    reviewedEffectDigest: z.optional(DevcontainerEffectReviewV1Schema.shape.reviewedEffectDigest) });
});

/** Credential selections remain in the canonical launch; the supplier supplies its CLI identity. */
export const ManagedMachinePresetPreparationBindingV1Schema = lazyZodSchema(() => z.pipe(z.strictObject({
  /** Read retained development images; new bindings omit this retired freshness input. */
  presetRevision: z.optional(z.number().check(z.int(), z.positive())),
  configuration: ManagedMachinePresetPreparationConfigurationV1Schema,
  cliIdentity: id(),
  /** Original Prepare host; legacy images omit it and cannot select a local cleanup host. */
  machineId: z.optional(id()),
  credentialConfigurations: z.array(z.strictObject({
    account: asProtocolZod(QualifiedConnectedAccountRefSchema),
    revision: z.nullable(id()),
  })),
}), z.transform(({ presetRevision: _retiredRevision, ...binding }) => binding)));
export type ManagedMachinePresetPreparationBindingV1 = Readonly<
  z.infer<typeof ManagedMachinePresetPreparationBindingV1Schema>>;

/** Private preset state retains native identity on failure or cancellation. */
export const ManagedMachinePresetPreparedV1Schema = lazyZodSchema(() => z.strictObject({
  operationId: id(),
  binding: ManagedMachinePresetPreparationBindingV1Schema,
  status: z.enum(['building', 'ready', 'failed', 'cancelled']),
  /** Historical source revision, independent of the configuration freshness binding. */
  builtFromRevision: z.optional(z.number().check(z.int(), z.positive())),
  /** First confirmed native readiness, retained in the same private envelope. */
  builtAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  artifact: z.optional(ManagedNativeOperationReferenceV1Schema),
  /** Native inspection of this artifact; absence means the provider did not report size. */
  artifactSizeBytes: z.optional(z.number().check(z.int(), z.gte(0))),
  nativeOperationRef: z.optional(ManagedNativeOperationReferenceV1Schema),
  /** Supplier-selected image install path; it is usable only with a ready artifact. */
  cliBinaryPath: z.optional(id()),
  /** Original build's intended setup subset; promoted only after native readiness. */
  buildSetup: z.optional(MachineSetupV1Schema),
  /** Exact credential-free setup completed by this build; omitted for a CLI-only image. */
  bakedSetup: z.optional(MachineSetupV1Schema),
  code: z.optional(id()),
  nativeCause: z.optional(MachineProvisionerNativeCauseV1Schema),
}).check(z.refine(value => value.status !== 'ready' || value.artifact !== undefined,
  { message: 'Ready preparation requires a native artifact.' }))
  .check(z.refine(value => [value.artifact, value.nativeOperationRef].every(reference => reference === undefined
    || reference.contributionRef.pluginId === value.binding.configuration.launch.provider.pluginId
      && reference.contributionRef.localId === value.binding.configuration.launch.provider.localId
      && reference.schemaVersion === value.binding.configuration.launch.schemaVersion),
  { message: 'Prepared references must belong to the bound provider.' })));
export type ManagedMachinePresetPreparedV1 = Readonly<z.infer<typeof ManagedMachinePresetPreparedV1Schema>>;
