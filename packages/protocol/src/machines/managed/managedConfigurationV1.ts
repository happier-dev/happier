import { z } from 'zod/mini';
import * as mini from 'zod/mini';
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
import { MachineEnvironmentV1Schema, type MachineEnvironmentV1 } from './machineEnvironmentV1.js';

export { resolveManagedConfigurationCost, formatProviderAmount, formatPriceUnit, presentManagedCost, presentManagedAcquireStep,
  formatRetentionDuration, describeRetention, formatManagedSizeBytes, managedSizeDimensions, describeManagedSize,
  type ManagedCost, type ManagedPriceLabels, type ManagedDurationLabels, type ManagedRetentionLabels } from './configurationPresentation.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative());
export const ManagedPresetSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('preset'), homeId: id(), id: id(), revision: revision(),
}));

export function createManagedOneOffSelectionV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject({
    kind: z.literal('one-off'), homeId: id(), launch: createValidatedLaunchSnapshotV1Schema(choices),
    controller: ManagedControllerV1Schema, retention: RetentionV1Schema, wakeOnAcceptedMessage: z.boolean(),
  });
}
export const ManagedOneOffSelectionV1Schema = lazyZodSchema(() => createManagedOneOffSelectionV1Schema(PluginJsonValueV2Schema));
export function createManagedCreationSelectionV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.discriminatedUnion('kind', [ManagedPresetSelectionV1Schema, createManagedOneOffSelectionV1Schema(choices)]);
}
export const ManagedCreationSelectionV1Schema = lazyZodSchema(() => createManagedCreationSelectionV1Schema(PluginJsonValueV2Schema));
export type ManagedCreationSelectionV1 = z.infer<typeof ManagedCreationSelectionV1Schema>;

/** Presentation facts never become an acquisition or credential authority. */
export function createManagedConfigurationFactsV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject({
    launch: createValidatedLaunchSnapshotV1Schema(choices), controller: ManagedControllerV1Schema,
    optionStatus: z.enum(['current', 'loading', 'unavailable']),
    prices: mini.optional(mini.array(ProviderPriceV1Schema)),
    billing: BillingCapabilitiesV1Schema,
    localResources: mini.optional(ManagedLocalResourceFactsV1Schema),
    nativeFacts: mini.optional(ProviderNativeOptionFactsV1Schema),
    prerequisites: z.array(ManagedPrerequisiteV1Schema), retentionCapabilities: RetentionCapabilitiesV1Schema,
    retention: RetentionV1Schema, wakeOnAcceptedMessage: z.boolean(),
    environment: z.optional(MachineEnvironmentV1Schema),
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
  launch: z.infer<ReturnType<typeof createValidatedLaunchSnapshotV1Schema<Choices>>>;
  controller: ManagedControllerV1; optionStatus: ManagedConfigurationFactsV1['optionStatus'];
  prerequisites: readonly ManagedPrerequisiteV1[]; billing: BillingCapabilitiesV1;
  retentionCapabilities: RetentionCapabilitiesV1;
  prices?: readonly ProviderPriceFactV1[];
  localResources?: ManagedLocalResourceFactsV1;
  nativeFacts?: ProviderNativeOptionFactsV1;
  environment?: MachineEnvironmentV1;
  preset?: Readonly<{ id: string; revision: number; name?: string }> & MachineRetentionOverrideV1;
  machineOverride?: MachineRetentionOverrideV1; categoryPreferences?: MachineRetentionDefaultsV1;
}>): z.infer<ReturnType<typeof createManagedConfigurationFactsV1Schema<Choices>>> {
  const policy = resolveMachineRetentionPolicyV1({ billing: input.billing,
    nativeCapabilities: input.retentionCapabilities, presetOverride: input.preset,
    machineOverride: input.machineOverride, categoryPreferences: input.categoryPreferences });
  return createManagedConfigurationFactsV1Schema(input.choicesSchema).parse({
    launch: input.launch, controller: input.controller, optionStatus: input.optionStatus,
    prerequisites: input.prerequisites, billing: input.billing, retentionCapabilities: input.retentionCapabilities,
    retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage,
    ...(input.prices !== undefined ? { prices: input.prices } : {}),
    ...(input.localResources !== undefined ? { localResources: input.localResources } : {}),
    ...(input.nativeFacts !== undefined ? { nativeFacts: input.nativeFacts } : {}),
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    ...(input.preset ? { preset: { id: input.preset.id, revision: input.preset.revision,
      ...(input.preset.name !== undefined ? { name: input.preset.name } : {}) } } : {}),
  });
}
