import * as z from 'zod/mini';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { createManagedConfigurationFactsV1Schema } from './managedConfigurationV1.js';
import { ManagedNativeOperationReferenceV1Schema, ManagedRecoveryHintV1Schema, ProviderObservationV1Schema, SharedSavedSecretRefV1Schema, SupportedNativeIntentSchema } from './providerFactsV1.js';
import { DevcontainerChildProjectionV1Schema, DevcontainerNativeObservationV1Schema, deriveManagedDevcontainerChildProjectionV1, managedDevcontainerChildProjectionsEqualV1 } from './devcontainerV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
export const RetentionV1Schema = lazyDefinition(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('until-delete') }),
  z.strictObject({ kind: z.literal('unused'), afterMs: z.number().check(z.gt(0)), effect: z.enum(['stop', 'delete']) }),
  z.strictObject({ kind: z.literal('deadline'), at: z.number().check(z.gte(0)), effect: z.enum(['stop', 'delete']), interrupts: z.literal(true) }),
]));
export const ManagedControllerV1Schema = lazyDefinition(() => z.strictObject({ machineId: id(), installationId: id() }));
/** A host submission fact, independently displayed from native power observations. */
export const SubmittedNativeEffectV1Schema = lazyDefinition(() => z.strictObject({
  intentRevision: z.int().check(z.gte(0)), requestId: id(), intent: SupportedNativeIntentSchema, controller: ManagedControllerV1Schema,
  reviewedEffectDigest: z.optional(id()),
}));
export const ManagedCredentialSelectionV1Schema = lazyDefinition(() => z.strictObject({ purpose: QualifiedConnectedAccountPurposeV1Schema, account: asProtocolZod(QualifiedConnectedAccountRefSchema) }));
function credentialSelections<T extends z.core.$ZodType<z.infer<typeof ManagedCredentialSelectionV1Schema>>>(schema: T) {
  return z.array(schema).check(z.superRefine((credentials, context) => {
    const seen = new Set<string>();
    credentials.forEach((credential, index) => {
      const key = JSON.stringify([credential.purpose.consumer.pluginId, credential.purpose.consumer.localId, credential.purpose.purpose]);
      if (seen.has(key)) context.addIssue({ code: 'custom', path: [index, 'purpose'], message: 'Each credential purpose is selected once.' });
      seen.add(key);
    });
  }));
}
export const ManagedCredentialSelectionsV1Schema = lazyDefinition(() => credentialSelections(ManagedCredentialSelectionV1Schema));
export const RetainedManagedCredentialSelectionsV1Schema = lazyDefinition(() => credentialSelections(z.strictObject({
  ...ManagedCredentialSelectionV1Schema.shape, configurationRevision: z.optional(z.nullable(id())),
})));
export function createValidatedLaunchSnapshotV1Schema<T extends z.core.$ZodType>(choices: T) {
  return z.strictObject({ provider: asProtocolZod(PluginContributionIdentityV1Schema), schemaVersion: z.int().check(z.gt(0)), name: id(), choices, credentials: z.optional(ManagedCredentialSelectionsV1Schema) });
}
export const ValidatedLaunchSnapshotV1Schema = lazyDefinition(() => createValidatedLaunchSnapshotV1Schema(PluginJsonValueV2Schema));
/** Controller-captured connection basis; never admitted as a chooser/preset input. */
export function createRetainedManagedLaunchSnapshotV1Schema<T extends z.core.$ZodType>(choices: T) {
  return z.strictObject({ ...createValidatedLaunchSnapshotV1Schema(choices).shape,
    credentials: z.optional(RetainedManagedCredentialSelectionsV1Schema) });
}
export const RetainedManagedLaunchSnapshotV1Schema = lazyDefinition(() => createRetainedManagedLaunchSnapshotV1Schema(PluginJsonValueV2Schema));
export function createManagedMachineV1Schema<Launch extends z.core.$ZodType, Native extends z.core.$ZodType, Operation extends z.core.$ZodType = typeof PluginJsonValueV2Schema>(launch: Launch, native: Native, nativeOperation?: Operation) {
  return z.strictObject({
    id: id(), homeId: id(), custodianAccountId: id(),
    preset: z.optional(z.strictObject({ id: id(), revision: z.int().check(z.gte(0)) })),
    launch: createRetainedManagedLaunchSnapshotV1Schema(launch), controller: ManagedControllerV1Schema,
    reviewedFacts: z.optional(createManagedConfigurationFactsV1Schema(launch)),
    allocation: z.enum(['unsubmitted', 'may-exist', 'bound', 'confirmed-absent']),
    creationState: z.enum(['active', 'canceled', 'retired']),
    nativeOperationRef: z.optional(z.strictObject({ ...ManagedNativeOperationReferenceV1Schema.shape, value: nativeOperation ?? PluginJsonValueV2Schema })),
    recovery: z.optional(ManagedRecoveryHintV1Schema),
    bootstrapCredentialRef: z.optional(SharedSavedSecretRefV1Schema),
    resource: z.optional(z.strictObject({ contributionRef: asProtocolZod(PluginContributionIdentityV1Schema), schemaVersion: z.int().check(z.gt(0)), value: native,
      devcontainerObservation: z.optional(DevcontainerNativeObservationV1Schema) })),
    devcontainerChild: z.optional(DevcontainerChildProjectionV1Schema),
    enrolledMachineId: z.optional(id()), desired: SupportedNativeIntentSchema,
    desiredWhen: z.enum(['now', 'after-idle']), desiredAfterMs: z.optional(z.number().check(z.gt(0))),
    intentRevision: z.int().check(z.gte(0)), archivedAt: z.optional(z.number().check(z.gte(0))),
    submittedNativeEffect: z.optional(SubmittedNativeEffectV1Schema),
    retention: RetentionV1Schema, wakeOnAcceptedMessage: z.boolean(), observation: z.optional(ProviderObservationV1Schema),
    cleanup: z.optional(z.strictObject({ disposition: z.enum(['pending', 'unavailable']), reason: id() })),
  }).check(z.superRefine((value, context) => {
    if (value.devcontainerChild && !managedDevcontainerChildProjectionsEqualV1(value.devcontainerChild,
      deriveManagedDevcontainerChildProjectionV1({ managedMachineId: value.id, controllerMachineId: value.controller.machineId,
        enrolledMachineId: value.enrolledMachineId, resource: value.resource }))) {
      context.addIssue({ code: 'custom', path: ['devcontainerChild'], message: 'Child relation must project the current enrolled resource and controller.' });
    }
    if (value.allocation === 'bound' && !value.resource) context.addIssue({ code: 'custom', path: ['resource'], message: 'Bound allocation requires native identity.' });
    if (value.resource && (value.resource.contributionRef.pluginId !== value.launch.provider.pluginId
      || value.resource.contributionRef.localId !== value.launch.provider.localId
      || value.resource.schemaVersion !== value.launch.schemaVersion)) {
      context.addIssue({ code: 'custom', path: ['resource'], message: 'Native identity must belong to the reviewed provisioner schema.' });
    }
    if (value.nativeOperationRef && (value.nativeOperationRef.contributionRef.pluginId !== value.launch.provider.pluginId
      || value.nativeOperationRef.contributionRef.localId !== value.launch.provider.localId
      || value.nativeOperationRef.schemaVersion !== value.launch.schemaVersion)) {
      context.addIssue({ code: 'custom', path: ['nativeOperationRef'], message: 'Native operation must belong to the reviewed provisioner schema.' });
    }
    if (value.enrolledMachineId && value.creationState !== 'active') context.addIssue({ code: 'custom', path: ['enrolledMachineId'], message: 'Retired enrollment cannot bind a Machine.' });
    // Omission retains the category-default selection accepted by plan 52.
    // An explicitly resolved duration remains a positive persisted snapshot.
    if (value.desiredWhen !== 'after-idle' && value.desiredAfterMs !== undefined) context.addIssue({ code: 'custom', path: ['desiredAfterMs'], message: 'An idle duration cannot accompany an immediate intent.' });
    if (value.allocation === 'confirmed-absent' && value.observation?.availability === 'unavailable') context.addIssue({ code: 'custom', path: ['allocation'], message: 'Unavailability is not confirmed absence.' });
  }));
}
export const ManagedMachineV1Schema = lazyDefinition(() => createManagedMachineV1Schema(PluginJsonValueV2Schema, PluginJsonValueV2Schema));
export type ManagedMachineV1 = z.infer<typeof ManagedMachineV1Schema>;
export type RetentionV1 = z.infer<typeof RetentionV1Schema>;
export type ManagedControllerV1 = z.infer<typeof ManagedControllerV1Schema>;
export type ValidatedLaunchSnapshotV1 = z.infer<typeof ValidatedLaunchSnapshotV1Schema>;
export type RetainedManagedLaunchSnapshotV1 = z.infer<typeof RetainedManagedLaunchSnapshotV1Schema>;
