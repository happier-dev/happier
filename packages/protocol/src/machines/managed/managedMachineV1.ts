import * as z from '../../zodRuntimePolicy.js';
export { classifyManagedMachineAllocationV1, type ManagedMachineAllocationPresentationV1 } from './managedAllocationPresentationV1.js';
import { ManagedMachineBirthSourceV1Schema } from './birthSourceV1.js';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema, type ConnectedAccountActionFormSelectionV1 } from '../../connect/connectedAccountPurposeBindings.js';
import { createManagedConfigurationFactsV1Schema } from './managedConfigurationV1.js';
import { ManagedResourceV1Schema, ManagedNativeOperationReferenceV1Schema, ManagedOpaquePresetObservationV1Schema, ManagedRecoveryHintV1Schema, ProviderObservationV1Schema, SharedSavedSecretRefV1Schema, SupportedNativeIntentSchema } from './providerFactsV1.js';
import { DevcontainerChildProjectionV1Schema, deriveManagedDevcontainerChildProjectionV1, managedDevcontainerChildProjectionsEqualV1 } from './devcontainerV1.js';
import { MachineSetupV1Schema } from './machineSetupV1.js';
import { MachineSetupSourceFactsMapV1Schema } from '../setup/machineSetupSourceFactsV1.js';
import { ManagedMachineEnrollmentIdentityV1Schema } from './enrollmentIdentityV1.js';
import { MachineInstallationPublicKeySchema } from '../identity/installationKeySchemas.js';
import { AccountEncryptionModeSchema } from '../../features/payload/capabilities/encryptionCapabilities.js';
export { ManagedMachineEnrollmentIdentityV1Schema, resolveManagedMachineEnrollmentAdminAccessV1, matchesManagedMachineEnrollmentAdminAccessV1,
  MANAGED_MACHINE_CREATION_CHILD_ACTION_IDS_V1, resolveManagedMachineEnrollmentAgentIsolationV1, matchesManagedMachineEnrollmentAgentIsolationV1,
  type ManagedMachineEnrollmentIdentityV1 } from './enrollmentIdentityV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
/** Home's exact enrolled resource identity; absence is an observed null on Machine projections. */
export const ManagedMachineRefV1Schema = lazyDefinition(() => z.strictObject({ homeId: id(), managedId: id() }));
export type ManagedMachineRefV1 = z.infer<typeof ManagedMachineRefV1Schema>;
/** Recipient-safe accepted-input wake presentation; it grants no manual power authority. */
export const ManagedMachineInputWakeV1Schema = lazyDefinition(() => z.enum(['asleep', 'starting']));
export type ManagedMachineInputWakeV1 = z.infer<typeof ManagedMachineInputWakeV1Schema>;

/** Current finite wake transport readiness; this grants no Action or controller custody. */
export const ManagedMachineNewSessionWakeV1Schema = lazyDefinition(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('available') }),
    z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['no_controller', 'controller_unavailable']) }),
]));
export type ManagedMachineNewSessionWakeV1 = z.infer<typeof ManagedMachineNewSessionWakeV1Schema>;

/** Native qualification is independent of the exact guest's live reachability. */
export const ManagedMachineInputRuntimeV1Schema = lazyDefinition(() => z.strictObject({
    nativeReady: z.boolean(),
    wakeState: z.nullable(ManagedMachineInputWakeV1Schema),
    /** Native wake placement only; the Home Pending record retains input ownership. */
    acceptedInputWakeOwner: z.optional(z.enum(['home', 'caller'])),
    newSessionWake: z.optional(ManagedMachineNewSessionWakeV1Schema),
    /** Current lifecycle only; automatic wake eligibility stays in wakeState. Older Homes omit it. */
    state: z.optional(z.nullable(z.union([ManagedMachineInputWakeV1Schema, z.literal('stopping')]))),
}));
export type ManagedMachineInputRuntimeV1 = z.infer<typeof ManagedMachineInputRuntimeV1Schema>;
/** Released 0.2 Home rows omit this projection; explicit invalid references still fail. */
export const ManagedMachineRefReadV1Schema = lazyDefinition(() => z._default(z.nullable(ManagedMachineRefV1Schema), null));
/** Setup belongs to the immutable admitted preset snapshot, independently of Join. */
export const ManagedMachineSetupV1Schema = lazyDefinition(() => z.strictObject({
  setup: MachineSetupV1Schema,
  sourceFacts: z.optional(MachineSetupSourceFactsMapV1Schema),
  state: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
  operation: z.optional(z.strictObject({ operationId: id() })),
  /** Server settlement clock; replay never substitutes a reader's clock. */
  settledAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  errorCode: z.optional(id()),
}).check(z.superRefine((value, context) => {
  if (value.state !== 'failed' && value.errorCode !== undefined) context.addIssue({ code: 'custom', path: ['errorCode'], message: 'Only failed setup retains an error.' });
})));
export type ManagedMachineSetupV1 = z.infer<typeof ManagedMachineSetupV1Schema>;
export const RetentionV1Schema = lazyDefinition(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('until-delete') }),
  z.strictObject({ kind: z.literal('unused'), afterMs: z.number().check(z.gte(0)), effect: z.enum(['stop', 'delete']) }),
  z.strictObject({ kind: z.literal('deadline'), at: z.number().check(z.gte(0)), effect: z.enum(['stop', 'delete']) }),
]));
/** Reusable choices cannot carry an absolute time from another allocation. */
export const ReusableRetentionV1Schema = lazyDefinition(() => z.discriminatedUnion('kind', [
  RetentionV1Schema.def.options[0],
  z.strictObject({ ...RetentionV1Schema.def.options[1].def.shape, afterMs: z.number().check(z.gt(0)) }),
]));
/** Chosen with acquisition; the existing birth owner binds its exact source once. */
export const ManagedCreationScopeRetentionChoiceV1Schema = lazyDefinition(() => z.strictObject({ effect: z.enum(['stop', 'delete']) }));
export const ManagedCreationScopeRetentionV1Schema = lazyDefinition(() => z.strictObject({
  ...ManagedCreationScopeRetentionChoiceV1Schema.def.shape,
  afterMs: z.optional(z.number().check(z.gt(0))),
  source: z.optional(ManagedMachineBirthSourceV1Schema),
  /** The source lifecycle selected this policy; this is not effect settlement. */
  endedAt: z.optional(z.number().check(z.gte(0))),
}));
export type ManagedCreationScopeRetentionV1 = z.infer<typeof ManagedCreationScopeRetentionV1Schema>;
export const ManagedControllerV1Schema = lazyDefinition(() => z.strictObject({ machineId: id(), installationId: id() }));
/** Public carrier for one admitted preset/resource, never ordinary Machine access. */
export const ManagedControllerAccessV1Schema = lazyDefinition(() => z.strictObject({
  installationPublicKey: MachineInstallationPublicKeySchema,
  custodian: z.strictObject({ accountId: id() }),
}));
export type ManagedControllerAccessV1 = z.infer<typeof ManagedControllerAccessV1Schema>;
/** A host submission fact, independently displayed from native power observations. */
export const SubmittedNativeEffectV1Schema = lazyDefinition(() => z.strictObject({
  intentRevision: z.int().check(z.gte(0)), requestId: id(), intent: SupportedNativeIntentSchema, controller: z.optional(ManagedControllerV1Schema),
  reviewedEffectDigest: z.optional(id()),
}));
const ManagedAccountCredentialSelectionV1Schema = lazyDefinition(() => z.strictObject({ purpose: QualifiedConnectedAccountPurposeV1Schema, account: asProtocolZod(QualifiedConnectedAccountRefSchema) }));
export const ManagedCredentialSelectionV1Schema = lazyDefinition(() => z.union([
  ManagedAccountCredentialSelectionV1Schema, QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema,
]));
export type ManagedCredentialSelectionV1 = z.infer<typeof ManagedCredentialSelectionV1Schema>;
export function readManagedCredentialSelectionValueV1(credential: ManagedCredentialSelectionV1): ConnectedAccountActionFormSelectionV1 {
  return 'account' in credential ? credential.account : { teamId: credential.teamId, selection: credential.selection };
}
export function createManagedCredentialSelectionV1(purpose: ManagedCredentialSelectionV1['purpose'], value: ConnectedAccountActionFormSelectionV1): ManagedCredentialSelectionV1 {
  return 'accountId' in value ? { purpose, account: value } : { purpose, ...value };
}
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
export const RetainedManagedCredentialSelectionsV1Schema = lazyDefinition(() => credentialSelections(z.union([z.strictObject({
  ...ManagedAccountCredentialSelectionV1Schema.shape, configurationRevision: z.optional(z.nullable(id())),
}), QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema])));
/** A retained selection's controller-captured basis is not a chooser input; native reads take the plain selection. */
export function projectRetainedManagedCredentialSelectionsV1(
  credentials: z.infer<typeof RetainedManagedCredentialSelectionsV1Schema>,
): ManagedCredentialSelectionV1[] {
  return credentials.map(credential => {
    if (!('configurationRevision' in credential)) return credential;
    const { configurationRevision: _basis, ...selection } = credential;
    return selection;
  });
}
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
/**
 * Unrefined field owner shared by admission-only structural projections.
 * Consumers may omit private leaves from this shape; cross-field invariants
 * remain owned exclusively by `createManagedMachineV1Schema` below.
 */
export function createManagedMachineV1BaseShape<Launch extends z.core.$ZodType, Native extends z.core.$ZodType, Operation extends z.core.$ZodType = typeof PluginJsonValueV2Schema>(launch: Launch, native: Native, nativeOperation?: Operation) {
  return {
    id: id(), homeId: id(), custodianAccountId: id(),
    enrollmentAccountId: z.optional(id()),
    /** Installed-controller admission provenance for a local Session sandbox. */
    acquisitionMode: z.optional(z.literal('resource-bound')),
    /** Captured author mode for a preset snapshot; readers must not use their own Account mode. */
    preset: z.optional(z.strictObject({ id: id(), revision: z.int().check(z.gte(0)), contentEncryptionMode: AccountEncryptionModeSchema })),
    launch: createRetainedManagedLaunchSnapshotV1Schema(launch), controller: z.optional(ManagedControllerV1Schema),
    controllerAccess: z.optional(ManagedControllerAccessV1Schema),
    enrollmentIdentity: z.optional(ManagedMachineEnrollmentIdentityV1Schema),
    reviewedFacts: z.optional(createManagedConfigurationFactsV1Schema(launch)),
    machineSetup: z.optional(ManagedMachineSetupV1Schema),
    allocation: z.enum(['unsubmitted', 'may-exist', 'bound', 'confirmed-absent']),
    creationState: z.enum(['active', 'canceled']),
    nativeOperationRef: z.optional(z.strictObject({ ...ManagedNativeOperationReferenceV1Schema.shape, value: nativeOperation ?? PluginJsonValueV2Schema })),
    recovery: z.optional(ManagedRecoveryHintV1Schema),
    bootstrapCredentialRef: z.optional(SharedSavedSecretRefV1Schema),
    /** Successful CLI installation on the retained resource; absence is unknown. */
    bootstrapInstalled: z.optional(z.literal(true)),
    resource: z.optional(z.strictObject({ ...ManagedResourceV1Schema.shape, value: native })),
    devcontainerChild: z.optional(DevcontainerChildProjectionV1Schema),
    enrolledMachineId: z.optional(id()), desired: SupportedNativeIntentSchema,
    desiredWhen: z.enum(['now', 'after-idle']), desiredAfterMs: z.optional(z.number().check(z.gt(0))),
    intentRevision: z.int().check(z.gte(0)), archivedAt: z.optional(z.number().check(z.gte(0))),
    submittedNativeEffect: z.optional(SubmittedNativeEffectV1Schema),
    retention: RetentionV1Schema, wakeOnAcceptedMessage: z.boolean(),
    creationScopeRetention: z.optional(ManagedCreationScopeRetentionV1Schema), observation: z.optional(ProviderObservationV1Schema),
    cleanup: z.optional(z.strictObject({ disposition: z.enum(['pending', 'unavailable']), reason: id() })),
  };
}
export function createManagedMachineV1Schema<Launch extends z.core.$ZodType, Native extends z.core.$ZodType, Operation extends z.core.$ZodType = typeof PluginJsonValueV2Schema>(
  launch: Launch,
  native: Native,
  nativeOperation?: Operation,
) {
  const base = createManagedMachineV1BaseShape(launch, native, nativeOperation);
  return z.strictObject({
    ...base,
  }).check(z.superRefine((value, context) => {
    if (value.machineSetup && !value.preset) {
      context.addIssue({ code: 'custom', path: ['machineSetup'], message: 'Setup requires its admitted preset.' });
    }
    if ((value.resource?.devcontainerObservation || value.devcontainerChild) && !value.controller) {
      context.addIssue({ code: 'custom', path: ['controller'], message: 'A local child requires its physical controller.' });
    }
    if (value.devcontainerChild && !managedDevcontainerChildProjectionsEqualV1(value.devcontainerChild,
      deriveManagedDevcontainerChildProjectionV1({ managedMachineId: value.id, controllerMachineId: value.controller?.machineId,
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
/** The established branch retains a Home-readable launch snapshot. */
export const ManagedMachineFullV1Schema = lazyDefinition(() => createManagedMachineV1Schema(PluginJsonValueV2Schema, PluginJsonValueV2Schema));
export type ManagedMachineFullV1 = z.infer<typeof ManagedMachineFullV1Schema>;
/** Legacy raw preset snapshots remain readable as Plain until a normal save seals them. */
export const ManagedMachinePublicFullV1Schema = lazyDefinition(() => createManagedMachineV1Schema(
  PluginJsonValueV2Schema,
  PluginJsonValueV2Schema,
).check(z.superRefine((value, context) => {
  if (value.preset && value.preset.contentEncryptionMode !== 'plain') {
    context.addIssue({ code: 'custom', path: ['preset'], message: 'Encrypted presets require an opaque carrier.' });
  }
})));
export type ManagedMachinePublicFullV1 = z.infer<typeof ManagedMachinePublicFullV1Schema>;

/** Opaque preset setup keeps lifecycle progress without retaining private setup content. */
export const ManagedOpaqueMachineSetupStateV1Schema = lazyDefinition(() => z.strictObject({
  state: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
  operation: z.optional(z.strictObject({ operationId: id() })),
  settledAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  errorCode: z.optional(id()),
}).check(z.superRefine((value, context) => {
  if (value.state !== 'failed' && value.errorCode !== undefined) {
    context.addIssue({ code: 'custom', path: ['errorCode'], message: 'Only failed setup retains an error.' });
  }
})));
export type ManagedOpaqueMachineSetupStateV1 = z.infer<typeof ManagedOpaqueMachineSetupStateV1Schema>;

/**
 * E2EE preset rows retain only server-owned allocation/lifecycle fields. Their
 * private launch, reviewed facts and setup remain inside the preset envelope.
 */
export const ManagedOpaquePresetMachineV1Schema = lazyDefinition(() => {
  const base = createManagedMachineV1BaseShape(PluginJsonValueV2Schema, PluginJsonValueV2Schema);
  const {
    launch: _launch,
    reviewedFacts: _reviewedFacts,
    machineSetup: _machineSetup,
    resource: _resource,
    nativeOperationRef: _nativeOperationRef,
    recovery: _recovery,
    devcontainerChild: _devcontainerChild,
    enrollmentIdentity: _enrollmentIdentity,
    observation: _observation,
    preset,
    ...structural
  } = base;
  return z.strictObject({
    ...structural,
    // Keep the union's absent private leaves readable as `undefined` for
    // structural consumers while rejecting every supplied wire value.
    launch: z.optional(z.never()),
    enrollmentIdentity: z.optional(z.never()),
    reviewedFacts: z.optional(z.never()),
    resource: z.optional(z.never()),
    nativeOperationRef: z.optional(z.never()),
    recovery: z.optional(z.never()),
    devcontainerChild: z.optional(z.never()),
    preset: z.nonoptional(preset),
    machineSetup: z.optional(ManagedOpaqueMachineSetupStateV1Schema),
    observation: z.optional(ManagedOpaquePresetObservationV1Schema),
  }).check(z.superRefine((value, context) => {
    if (value.enrolledMachineId && value.creationState !== 'active') {
      context.addIssue({ code: 'custom', path: ['enrolledMachineId'], message: 'Retired enrollment cannot bind a Machine.' });
    }
    if (value.desiredWhen !== 'after-idle' && value.desiredAfterMs !== undefined) {
      context.addIssue({ code: 'custom', path: ['desiredAfterMs'], message: 'An idle duration cannot accompany an immediate intent.' });
    }
    if (value.allocation === 'confirmed-absent' && value.observation?.availability === 'unavailable') {
      context.addIssue({ code: 'custom', path: ['allocation'], message: 'Unavailability is not confirmed absence.' });
    }
  }));
});
export type ManagedOpaquePresetMachineV1 = z.infer<typeof ManagedOpaquePresetMachineV1Schema>;

/** Public rows retain legacy full reads alongside the current opaque preset projection. */
export const ManagedMachineV1Schema = lazyDefinition(() => z.union([
  ManagedMachinePublicFullV1Schema,
  ManagedOpaquePresetMachineV1Schema,
]));
export type ManagedMachineV1 = z.infer<typeof ManagedMachineV1Schema>;

/** Account-local read views may include opened E2EE content; never use this schema for Home responses. */
export const ManagedMachineReadSnapshotV1Schema = lazyDefinition(() => z.union([
  ManagedMachineFullV1Schema,
  ManagedOpaquePresetMachineV1Schema,
]));
export type ManagedMachineReadSnapshotV1 = z.infer<typeof ManagedMachineReadSnapshotV1Schema>;

export function isManagedOpaquePresetMachineV1(machine: ManagedMachineReadSnapshotV1): machine is ManagedOpaquePresetMachineV1 {
  return machine.launch === undefined;
}
export type RetentionV1 = z.infer<typeof RetentionV1Schema>;
export type ManagedControllerV1 = z.infer<typeof ManagedControllerV1Schema>;
export type ValidatedLaunchSnapshotV1 = z.infer<typeof ValidatedLaunchSnapshotV1Schema>;
export type RetainedManagedLaunchSnapshotV1 = z.infer<typeof RetainedManagedLaunchSnapshotV1Schema>;

/** Public creator output never carries the custodian's connection or bootstrap selectors. */
export function redactManagedMachineCredentialReferences(machine: ManagedMachineV1): ManagedMachineV1 {
  if (isManagedOpaquePresetMachineV1(machine)) {
    const { bootstrapCredentialRef: _bootstrap, ...publicMachine } = machine;
    return publicMachine;
  }
  const { bootstrapCredentialRef: _bootstrap, ...publicMachine } = machine;
  const { credentials: _credentials, ...launch } = machine.launch;
  const facts = machine.reviewedFacts;
  if (!facts) return { ...publicMachine, launch };
  const { credentials: _factCredentials, ...reviewedLaunch } = facts.launch;
  return { ...publicMachine, launch, reviewedFacts: { ...facts, launch: reviewedLaunch } };
}
