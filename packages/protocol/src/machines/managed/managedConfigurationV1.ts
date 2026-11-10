import { z } from '../../zodRuntimePolicy.js';
import * as mini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import type { MachineRetentionDefaultsV1, MachineRetentionOverrideV1 } from '../../account/settings/machineRetentionDefaultsV1.js';
import {
  createValidatedLaunchSnapshotV1Schema, ManagedControllerV1Schema, RetentionV1Schema,
  type ManagedControllerV1,
} from './managedMachineV1.js';
import {
  ProviderPriceV1Schema, BillingCapabilitiesV1Schema, RetentionCapabilitiesV1Schema,
  ManagedPrerequisiteV1Schema, ManagedLocalResourceFactsV1Schema,
  ProviderNativeOptionFactsV1Schema,
  type BillingCapabilitiesV1, type RetentionCapabilitiesV1, type ManagedPrerequisiteV1,
  type ManagedLocalResourceFactsV1,
  type ProviderNativeOptionFactsV1,
} from './providerFactsV1.js';
import { resolveMachineRetentionPolicyV1 } from './resolveMachineRetentionPolicyV1.js';
import { MachineSetupV1Schema, type MachineSetupV1 } from './machineSetupV1.js';
import { MachineProvisionerContributionV1Schema, type MachineProvisionerContributionV1,
  type MachineProvisionerSelectionProjectionV1 } from '../../plugins/contributions/machineProvisioners.js';
import { pluginJsonValuesEqual } from '../../plugins/contributions/jsonSchemaValues.js';

export { resolveManagedConfigurationCost, formatProviderAmount, formatPriceUnit, presentManagedCost, presentManagedAcquireStep,
  formatRetentionDuration, describeRetention, formatManagedSizeBytes, managedSizeDimensions, describeManagedSize,
  type ManagedCost, type ManagedPriceLabels, type ManagedDurationLabels, type ManagedRetentionLabels } from './configurationPresentation.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative());
export const ManagedPresetSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('preset'), homeId: id(), id: id(), revision: revision(),
  /** This Machine's own name; without it the Machine takes its provider's default name, not the preset's. */
  name: z.optional(id()),
}));

export function createManagedOneOffSelectionV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject({
    kind: z.literal('one-off'), homeId: id(), launch: createValidatedLaunchSnapshotV1Schema(choices),
    controller: z.optional(ManagedControllerV1Schema), retention: RetentionV1Schema, wakeOnAcceptedMessage: z.boolean(),
  });
}
export const ManagedOneOffSelectionV1Schema = lazyZodSchema(() => createManagedOneOffSelectionV1Schema(PluginJsonValueV2Schema));
export function createManagedCreationSelectionV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.discriminatedUnion('kind', [ManagedPresetSelectionV1Schema, createManagedOneOffSelectionV1Schema(choices)]);
}
export const ManagedCreationSelectionV1Schema = lazyZodSchema(() => createManagedCreationSelectionV1Schema(PluginJsonValueV2Schema));
export type ManagedCreationSelectionV1 = z.infer<typeof ManagedCreationSelectionV1Schema>;

/** Reviewed facts retain the selected declaration; Account admission owns authority. */
export function createManagedConfigurationFactsV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject({
    launch: createValidatedLaunchSnapshotV1Schema(choices), controller: z.optional(ManagedControllerV1Schema),
    provisioner: z.optional(z.lazy(() => MachineProvisionerContributionV1Schema)),
    optionStatus: z.enum(['current', 'loading', 'unavailable']),
    prices: mini.optional(mini.array(ProviderPriceV1Schema)),
    billing: BillingCapabilitiesV1Schema,
    localResources: mini.optional(ManagedLocalResourceFactsV1Schema),
    nativeFacts: mini.optional(ProviderNativeOptionFactsV1Schema),
    prerequisites: z.array(ManagedPrerequisiteV1Schema), retentionCapabilities: RetentionCapabilitiesV1Schema,
    retention: RetentionV1Schema, wakeOnAcceptedMessage: z.boolean(),
    setup: z.optional(MachineSetupV1Schema),
    preset: z.optional(z.strictObject({ id: id(), revision: revision(), name: z.optional(id()) })),
  });
}
export const ManagedConfigurationFactsV1Schema = lazyZodSchema(() => createManagedConfigurationFactsV1Schema(PluginJsonValueV2Schema));
export const ManagedConfigurationFactsV1ReadSchema = createStoredReadSchema(ManagedConfigurationFactsV1Schema);
export const ProviderPriceFactV1Schema = ProviderPriceV1Schema;
export type ProviderPriceFactV1 = z.infer<typeof ProviderPriceV1Schema>;
export type ManagedConfigurationFactsV1 = z.infer<typeof ManagedConfigurationFactsV1Schema>;

/** Call the sole category-policy owner once, then snapshot its concrete output. */
export function buildManagedConfigurationFactsV1<Choices extends z.core.$ZodType>(input: Readonly<{
  choicesSchema: Choices;
  launch: z.infer<ReturnType<typeof createValidatedLaunchSnapshotV1Schema<Choices>>> & { choices: z.output<Choices> };
  controller?: ManagedControllerV1; optionStatus: ManagedConfigurationFactsV1['optionStatus'];
  provisioner?: MachineProvisionerContributionV1;
  prerequisites: readonly ManagedPrerequisiteV1[]; billing: BillingCapabilitiesV1;
  retentionCapabilities: RetentionCapabilitiesV1;
  prices?: readonly ProviderPriceFactV1[];
  localResources?: ManagedLocalResourceFactsV1;
  nativeFacts?: ProviderNativeOptionFactsV1;
  optionProjection?: MachineProvisionerSelectionProjectionV1;
  setup?: MachineSetupV1;
  preset?: Readonly<{ id: string; revision: number; name?: string }> & MachineRetentionOverrideV1;
  machineOverride?: MachineRetentionOverrideV1; categoryPreferences?: MachineRetentionDefaultsV1;
}>): ManagedConfigurationFactsV1 & z.infer<ReturnType<typeof createManagedConfigurationFactsV1Schema<Choices>>> {
  const projection = input.optionProjection;
  const selected = projection?.kind === 'ready' && pluginJsonValuesEqual(projection.launch, input.launch.choices) ? projection : undefined;
  const billing = selected?.billing ?? input.billing;
  const retentionCapabilities = selected?.retention ?? input.retentionCapabilities;
  const prices = selected ? selected.prices.length ? selected.prices : undefined : input.prices;
  const nativeFacts = selected?.nativeFacts ?? input.nativeFacts;
  const policy = resolveMachineRetentionPolicyV1({ billing,
    nativeCapabilities: retentionCapabilities, presetOverride: input.preset,
    machineOverride: input.machineOverride, categoryPreferences: input.categoryPreferences });
  const facts = createManagedConfigurationFactsV1Schema(input.choicesSchema).parse({
    launch: input.launch, ...(input.controller === undefined ? {} : { controller: input.controller }),
    optionStatus: input.optionStatus === 'current' && projection && !selected ? 'unavailable' : input.optionStatus,
    ...(input.provisioner === undefined ? {} : { provisioner: input.provisioner }),
    prerequisites: input.prerequisites, billing, retentionCapabilities,
    retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage,
    ...(prices !== undefined ? { prices } : {}),
    ...(input.localResources !== undefined ? { localResources: input.localResources } : {}),
    ...(nativeFacts !== undefined ? { nativeFacts } : {}),
    ...(input.setup !== undefined ? { setup: input.setup } : {}),
    ...(input.preset ? { preset: { id: input.preset.id, revision: input.preset.revision,
      ...(input.preset.name !== undefined ? { name: input.preset.name } : {}) } } : {}),
  });
  // Native adapters may retain frozen choices. Project the admitted JSON receipt
  // without another validation or a runtime-specific structuredClone global.
  return JSON.parse(JSON.stringify(facts)) as ManagedConfigurationFactsV1 & typeof facts;
}
