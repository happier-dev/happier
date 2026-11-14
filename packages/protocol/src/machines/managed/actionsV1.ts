import { z } from '../../zodRuntimePolicy.js';
export * from './managedInstallationV1.js';
export { waitForMachineSetupOperationV1 } from '../setup/waitForMachineSetupOperationV1.js';
import * as mini from '../../zodRuntimePolicy.js';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { PluginLocalizedStringV2Schema } from '../../plugins/contributions/publicTypes.js';
import { MachineProvisionersListResultV1Schema, MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema, MachineProvisionerContributionV1Schema, MachineProvisionerResizeResultV1Schema } from '../../plugins/contributions/machineProvisioners.js';
import * as actionOperations from '../../actions/operations/v1.js';
import { BugReportMachineDiagnosticsSnapshotSchema } from '../../bugs/reports/machineDiagnostics.js';
import { SharedSavedSecretCreateInputV1Schema } from '../../account/settings/savedSecretResourceActionsV1.js';
import { MachineRetentionPolicyV1Schema } from '../../account/settings/machineRetentionDefaultsV1.js';
import { ManagedAcquireAgentStartV1Schema } from './agentStartV1.js';
import { isManagedOpaquePresetMachineV1, ManagedControllerV1Schema, ManagedCredentialSelectionsV1Schema, RetainedManagedCredentialSelectionsV1Schema, ManagedMachinePublicFullV1Schema, ManagedMachineV1Schema, ManagedOpaquePresetMachineV1Schema, RetentionV1Schema, ValidatedLaunchSnapshotV1Schema, type ManagedMachineV1 } from './managedMachineV1.js';
import { AcquireResultV1Schema, ManagedOpaquePresetObservationV1Schema, ManagedRefusalCodeV1Schema, ManagedResourceV1Schema, ProviderObservationV1Schema, MachineProvisionerSizeV1Schema, type AcquireResultV1 } from './providerFactsV1.js';
import { MANAGED_MACHINE_ACTION_IDS_V1, type ManagedMachineActionIdV1 } from './actionIdsV1.js';
export { MANAGED_CONTROL_ACTION_IDS_V1, type ManagedControlActionIdV1 } from './actionIdsV1.js';
import { ManagedConfigurationFactsV1Schema, ManagedOneOffSelectionV1Schema, ManagedPresetSelectionV1Schema } from './managedConfigurationV1.js';
import { DevcontainerRebuildIntentV1Schema, ManagedIntentInputSchema, ManagedIntentResultSchema, ManagedActivityReadRequestV1Schema } from './managedIntentV1.js';
import { MachineInstallationProofV1Schema, MachineInstallationPublicKeySchema } from '../identity/installationKeySchemas.js';
import { SocketRpcMachineAdmissionContextV1Schema } from '../machineAccessV1.js';
import { MachineProvisionerDestroyResultV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerRebuildResultV1Schema } from '../../plugins/contributions/machineProvisioners.js';
import { MachineReferenceCensusV1Schema } from '../machineReferenceCensusV1.js';
import { MachineSetupNonAccountPresetSourceEntryV1Schema, machineSetupSourceOriginKeyV1, MachineSetupExclusionV1Schema,
  MachineSetupExclusionsV1Schema, MachineSetupSourceFactsMapV1Schema, MachineSetupAppOriginV1Schema } from '../setup/machineSetupSourcesV1.js';
import { MachineSetupObservationStatusV1Schema, MachineSetupObservationReasonV1Schema, MachineSetupUpdatesObservationV1Schema } from '../setup/machineSetupObservationV1.js';
import { MachineSetupEffectPlanV1Schema, MachineRecipeSelectionV1Schema } from '../setup/machineRecipeV1.js';
import { MachineRecipeReferenceV1Schema } from '../setup/machineRecipeReferenceV1.js';
import { MachineSetupBackupReceiverResultV1Schema } from '../setup/backupReceiverV1.js';
import { MachineSetupApplyResultV1Schema } from '../setup/machineSetupOperationV1.js';
export { MachineSetupApplyResultV1Schema } from '../setup/machineSetupOperationV1.js';
import { ManagedMachineEnrollmentIdentityV1Schema } from './enrollmentIdentityV1.js';
import * as workflowDefinitions from '../../workflows/workflowV1.js';
import * as deploymentActions from '../../deployments/deploymentActionsV1.js';
import * as deploymentTemplates from '../../deployments/deploymentTemplateInstantiationV1.js';
import { WorkflowCombinedActionHostReviewV1Schema } from '../../workflows/workflowStartPreparationV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { ExternalActionManagedContinuationV1Schema, ExternalActionRequestEnvelopeSchema } from '../../actions/externalActionApi.js';
import { ManagedCredentialInstallInputV1Schema, ManagedCredentialDeliveryResultV1Schema, ManagedNativeCredentialBindingV1Schema } from './credentialDeliveryV1.js';
import { ManagedCreationScopeRetentionChoiceV1Schema } from './managedMachineV1.js';
import { ManagedMachineBirthResultV1Schema } from './birthSourceV1.js';
import { ManagedMachinePresetLaunchNameOverrideV1Schema, ManagedMachinePresetRecipientProjectionV1Schema, ManagedMachinePresetStoredContentCarrierV1Schema, ManagedMachinePresetRecipientsV1Schema } from './managedMachinePresetContentV1.js';
import { AccountEncryptionModeSchema } from '../../features/payload/capabilities/encryptionCapabilities.js';
export { ManagedMachineBirthResultV1Schema } from './birthSourceV1.js';
export * from './credentialDeliveryV1.js';
export { MANAGED_MACHINE_ACTION_IDS_V1, type ManagedMachineActionIdV1 } from './actionIdsV1.js';

export { isMachineSetupPlanRpcChildV1,
  SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from './actionIdsV1.js';

export { isManagedRetainedControlInvocation } from './actionIdsV1.js';

const id = () => mini.string().check(mini.trim(), mini.minLength(1));
const revision = () => mini.int().check(mini.gte(0));
const actionOperationSchema = lazyZodSchema(() => actionOperations.ActionOperationGetV1RequestSchema);
export const ManagedMachineActionIdV1Schema = lazyDefinition(() => mini.enum(MANAGED_MACHINE_ACTION_IDS_V1));
const target = () => ({ homeId: id(), managedId: id() });
const current = () => ({ ...target(), expectedIntentRevision: revision(), requestId: id(), controller: z.optional(ManagedControllerV1Schema) });
/** Exact creation origin fields used by Report, not an online Apply envelope. */
export const MachineSetupPresetApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), presetId: id(), presetRevision: revision(),
}));
export type MachineSetupPresetApplyInputV1 = z.infer<typeof MachineSetupPresetApplyInputV1Schema>;

/** A saved encrypted preset crosses Home by address only; its setup stays with the keyholding target. */
export const MachineSetupOpaquePresetSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('accountPresetOpaque'), presetId: id(), presetRevision: revision(),
  /** Persisted author mode, verified by the server against the saved Preset. */
  contentEncryptionMode: AccountEncryptionModeSchema,
  /** Optional keyholder-sealed setup edit for this exact preset snapshot. */
  presetContentOverride: z.optional(ManagedMachinePresetLaunchNameOverrideV1Schema),
}));
export type MachineSetupOpaquePresetSourceV1 = z.infer<typeof MachineSetupOpaquePresetSourceV1Schema>;

/** Input sources are carried through Actions. Only the daemon's local source model carries preset setup bytes. */
export const MachineSetupSourceApplyEntryV1Schema = lazyZodSchema(() => z.union([
  MachineSetupNonAccountPresetSourceEntryV1Schema,
  MachineSetupOpaquePresetSourceV1Schema,
]));
export type MachineSetupSourceApplyEntryV1 = z.infer<typeof MachineSetupSourceApplyEntryV1Schema>;
/** Canonical Action-wire identity for a setup source, including opaque saved presets. */
export function machineSetupSourceApplyOriginKeyV1(source: MachineSetupSourceApplyEntryV1): string {
  return source.kind === 'accountPresetOpaque' ? `account:${source.presetId}` : machineSetupSourceOriginKeyV1(source);
}
export const MachineSetupSourceApplyV1Schema = lazyZodSchema(() => z.array(MachineSetupSourceApplyEntryV1Schema).check(
  z.refine(sources => sources.filter(source => source.kind === 'direct').length === 1,
    { message: 'Setup has exactly one implicit direct source.' }),
  z.refine(sources => new Set(sources.map(machineSetupSourceApplyOriginKeyV1)).size === sources.length,
    { message: 'Each setup source is attached once.' }),
));
export type MachineSetupSourceApplyV1 = z.infer<typeof MachineSetupSourceApplyV1Schema>;

/** Only the authenticated target receives its own envelope for an opaque preset source. */
export const MachineSetupResolvedOpaquePresetSourceV1Schema = lazyZodSchema(() => z.extend(
  MachineSetupOpaquePresetSourceV1Schema,
  { presetContent: ManagedMachinePresetRecipientProjectionV1Schema },
));
export type MachineSetupResolvedOpaquePresetSourceV1 = z.infer<typeof MachineSetupResolvedOpaquePresetSourceV1Schema>;
export const MachineSetupResolvedSourceEntryV1Schema = lazyZodSchema(() => z.union([
  MachineSetupNonAccountPresetSourceEntryV1Schema,
  MachineSetupResolvedOpaquePresetSourceV1Schema,
]));
export type MachineSetupResolvedSourceEntryV1 = z.infer<typeof MachineSetupResolvedSourceEntryV1Schema>;
function readMachineSetupResolvedSourceOriginKeyV1(source: MachineSetupResolvedSourceEntryV1): string {
  return source.kind === 'accountPresetOpaque' ? `account:${source.presetId}` : machineSetupSourceOriginKeyV1(source);
}
export const MachineSetupResolvedSourceV1Schema = lazyZodSchema(() => z.array(MachineSetupResolvedSourceEntryV1Schema).check(
  z.refine(sources => sources.filter(source => source.kind === 'direct').length === 1,
    { message: 'Setup has exactly one implicit direct source.' }),
  z.refine(sources => new Set(sources.map(readMachineSetupResolvedSourceOriginKeyV1)).size === sources.length,
    { message: 'Each setup source is attached once.' }),
));
export type MachineSetupResolvedSourceV1 = z.infer<typeof MachineSetupResolvedSourceV1Schema>;

export const MachineSetupSourcesApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), sources: MachineSetupSourceApplyV1Schema,
}));
export type MachineSetupSourcesApplyInputV1 = z.infer<typeof MachineSetupSourcesApplyInputV1Schema>;
export const MachineSetupRecipePlanV1Schema = lazyZodSchema(() => z.strictObject({
  sourceIndex: revision(), itemIndex: revision(), plan: MachineSetupEffectPlanV1Schema,
}));
const removalKeys = () => z.array(id()).check(z.refine(keys => new Set(keys).size === keys.length));
/** Transient review data, never a persisted eligibility decision. */
export const MachineSetupRemovalOfferV1Schema = lazyZodSchema(() => {
  const item = { itemKey: id(), item: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('setupRecipe'), selection: MachineRecipeSelectionV1Schema }),
    z.strictObject({ kind: z.literal('softwareRecipe'), selection: MachineRecipeSelectionV1Schema }),
  ]) };
  return z.discriminatedUnion('status', [
    z.strictObject({ ...item, status: z.literal('eligible'), selected: z.boolean() }),
    z.strictObject({ ...item, status: z.literal('notEligible'), selected: z.literal(false),
      reason: z.enum(['preExisting', 'unknownOrigin', 'needsCheck', 'unsupported']) }),
  ]);
});
export type MachineSetupRemovalOfferV1 = z.infer<typeof MachineSetupRemovalOfferV1Schema>;
export const MachineSetupRemovalPlanV1Schema = lazyZodSchema(() => z.strictObject({
  itemKey: id(), plan: MachineSetupEffectPlanV1Schema,
}));
export type MachineSetupRemovalPlanV1 = z.infer<typeof MachineSetupRemovalPlanV1Schema>;
/** Prepared app operands retain their existing owners and are attributed to one saved app intent.
 * Read the cyclic deployment exports lazily: Metro snapshots named imports before
 * deploymentActionsV1 has initialized when it loads Machine setup back.
 */
export const MachineSetupAppChildV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  z.strictObject({ sourceIndex: revision(), itemIndex: revision(), actionId: z.literal('deployments.environments.create'),
    input: deploymentActions.DeploymentEnvironmentCreateInputV1Schema }),
  z.strictObject({ sourceIndex: revision(), itemIndex: revision(), actionId: z.literal('deployments.templates.instantiate'),
    input: deploymentTemplates.DeploymentTemplateInstantiateInputV1Schema }),
  z.strictObject({ sourceIndex: revision(), itemIndex: revision(), actionId: z.literal('deployments.deploy'),
    input: deploymentActions.DeploymentDeployInputV1Schema }),
]));
export type MachineSetupAppChildV1 = z.infer<typeof MachineSetupAppChildV1Schema>;
/** The target's existing P45 preparation review; no executable or persisted second format. */
export const MachineSetupAppReviewV1Schema = lazyZodSchema(() => z.strictObject({
  sourceIndex: revision(), itemIndex: revision(), actionId: z.literal('deployments.templates.instantiate'),
  review: deploymentTemplates.DeploymentTemplateInstantiationReviewV1Schema,
}));
export type MachineSetupAppReviewV1 = z.infer<typeof MachineSetupAppReviewV1Schema>;
export const MachineSetupApplyTargetV1Schema = lazyZodSchema(() => z.extend(MachineSetupSourcesApplyInputV1Schema, {
  desiredRevision: revision(), recipePlans: z.array(MachineSetupRecipePlanV1Schema),
  exclusions: z.optional(MachineSetupExclusionsV1Schema), removeItemKeys: z.optional(removalKeys()),
  removalPlans: z.optional(z.array(MachineSetupRemovalPlanV1Schema)),
  appChildren: z.optional(z.array(MachineSetupAppChildV1Schema)),
}));
export type MachineSetupApplyTargetV1 = z.infer<typeof MachineSetupApplyTargetV1Schema>;
export const MachineSetupApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), targets: z.array(MachineSetupApplyTargetV1Schema).check(z.minLength(1)),
}).check(z.refine(input => new Set(input.targets.map(target => JSON.stringify([target.homeId, target.machineId]))).size === input.targets.length,
  { message: 'Setup targets must be unique.' })));
export type MachineSetupApplyInputV1 = z.infer<typeof MachineSetupApplyInputV1Schema>;
export const MachineSetupPlanInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), sources: z.optional(MachineSetupSourceApplyV1Schema),
  exclusions: z.optional(MachineSetupExclusionsV1Schema), removeItemKeys: z.optional(removalKeys()),
  mode: z.optional(z.enum(['check', 'effects'])),
  appChildren: z.optional(z.array(MachineSetupAppChildV1Schema)),
  updates: z.optional(z.strictObject({ scope: z.enum(['security', 'all']) })),
}).check(z.refine(input => input.updates === undefined || input.sources === undefined && input.exclusions === undefined
  && input.removeItemKeys === undefined && input.appChildren === undefined,
{ message: 'Updates cannot include setup source changes or app operands.' })));
export type MachineSetupPlanInputV1 = z.infer<typeof MachineSetupPlanInputV1Schema>;
export const MachineSetupUpdatesApplyInputV1BaseSchema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), scope: z.enum(['security', 'all']), plan: MachineSetupEffectPlanV1Schema,
}));
const exactUpdatesInput = (input: z.infer<typeof MachineSetupUpdatesApplyInputV1BaseSchema>) =>
  input.plan.basis.kind === 'updates' && input.plan.basis.machineId === input.machineId && input.plan.basis.scope === input.scope;
export const MachineSetupUpdatesApplyInputV1Schema = lazyZodSchema(() => MachineSetupUpdatesApplyInputV1BaseSchema.check(
  z.refine(exactUpdatesInput, { message: 'Updates require the exact reviewed target and scope.' })));
export const MachineSetupUpdatesRolloutTargetV1BaseSchema = lazyZodSchema(() => z.extend(MachineSetupUpdatesApplyInputV1BaseSchema, {
  reboot: z.optional(z.strictObject({ expectedInstallationId: id() })),
}));
export const MachineSetupUpdatesRolloutTargetV1Schema = lazyZodSchema(() => MachineSetupUpdatesRolloutTargetV1BaseSchema.check(
  z.refine(exactUpdatesInput, { message: 'Updates require the exact reviewed target and scope.' })));
export const MachineSetupUpdatesRolloutInputV1BaseSchema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(),
  batches: z.array(z.array(MachineSetupUpdatesRolloutTargetV1Schema).check(z.minLength(1))).check(z.minLength(1)),
  failurePolicy: workflowDefinitions.WorkflowParallelBlockFieldsSchema.shape.failurePolicy,
}));
export const MachineSetupUpdatesRolloutInputV1Schema = lazyZodSchema(() => MachineSetupUpdatesRolloutInputV1BaseSchema.check(z.refine(input => {
  const targets = input.batches.flat();
  return targets.every(target => target.homeId === input.homeId)
    && new Set(targets.map(target => target.machineId)).size === targets.length;
}, { message: 'Rollouts require distinct exact Machines on the reviewed Home.' })));
export type MachineSetupUpdatesRolloutInputV1 = z.infer<typeof MachineSetupUpdatesRolloutInputV1Schema>;
export type MachineSetupUpdatesApplyInputV1 = z.infer<typeof MachineSetupUpdatesApplyInputV1Schema>;
/** Removal carries full review context but no executable app/script/toolchain operands. */
export const MachineSetupRemoveInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), sources: MachineSetupSourceApplyV1Schema,
  desiredRevision: revision(), removeItemKeys: removalKeys(), removalPlans: z.array(MachineSetupRemovalPlanV1Schema),
  exclusions: z.optional(MachineSetupExclusionsV1Schema),
}));
export type MachineSetupRemoveInputV1 = z.infer<typeof MachineSetupRemoveInputV1Schema>;
/** A visible recovery step, never an instruction Apply executes implicitly. */
export const MachineSetupSessionRefreshV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('requiresSessionRefresh'), username: id(),
  scope: z.enum(['userServices', 'daemonService', 'loginSession']),
  requiresAdministrator: z.boolean(),
  command: z.optional(z.strictObject({ executable: id(), args: z.array(z.string()) })),
}));
export type MachineSetupSessionRefreshV1 = z.infer<typeof MachineSetupSessionRefreshV1Schema>;
export const MachineSetupPlanReviewV1Schema = lazyZodSchema(() => z.strictObject({
  target: z.strictObject({ homeId: id(), machineId: id() }),
  administratorRequired: z.nullable(z.boolean()),
  /** The receiving Plan's known prerequisite; presentation only, never an Apply operand. */
  administratorUnavailable: z.optional(z.strictObject({ reasonCode: z.literal('mode_none') })),
  downtime: z.enum(['none', 'possible', 'unknown']),
  requiresSessionRefresh: z.optional(MachineSetupSessionRefreshV1Schema),
  apps: z.optional(z.array(z.strictObject({ sourceIndex: revision(), itemIndex: revision(),
    kind: z.enum(['new', 'completed', 'not_completed', 'failed', 'unknown']), environmentId: z.optional(id()),
  }))),
  host: z.optional(WorkflowCombinedActionHostReviewV1Schema),
}));
export type MachineSetupPlanReviewV1 = z.infer<typeof MachineSetupPlanReviewV1Schema>;

/** A daemon may expose the exact Home-resolved opaque source beside its Plan. */
function sameMachineSetupPlanResolvedSourceV1(
  source: MachineSetupSourceApplyEntryV1,
  resolved: MachineSetupResolvedSourceEntryV1,
): boolean {
  if (source.kind !== resolved.kind) return false;
  if (source.kind !== 'accountPresetOpaque') return sameStrictJsonValue(source, resolved);
  if (resolved.kind !== 'accountPresetOpaque') return false;
  if (source.presetId !== resolved.presetId
    || source.presetRevision !== resolved.presetRevision
    || source.contentEncryptionMode !== resolved.contentEncryptionMode) return false;
  if (source.presetContentOverride === undefined || resolved.presetContentOverride === undefined) {
    return source.presetContentOverride === resolved.presetContentOverride;
  }
  return sameStrictJsonValue(source.presetContentOverride, resolved.presetContentOverride);
}

export const MachineSetupPlanResultV1Schema = lazyZodSchema(() => z.strictObject({
  desiredRevision: revision(), sources: MachineSetupSourceApplyV1Schema, exclusions: z.array(MachineSetupExclusionV1Schema),
  /** Presentation-only caller-relative ciphertext from the exact controller resolve. */
  resolvedSources: z.optional(MachineSetupResolvedSourceV1Schema),
  sourceFacts: z.optional(MachineSetupSourceFactsMapV1Schema),
  appOrigins: z.optional(z.array(MachineSetupAppOriginV1Schema)),
  removeItemKeys: z.optional(removalKeys()), removalOffers: z.optional(z.array(MachineSetupRemovalOfferV1Schema)),
  removalPlans: z.optional(z.array(MachineSetupRemovalPlanV1Schema)),
  /** Presentation only: exact referenced declarations already read by this target Plan. */
  recipeTitles: z.optional(z.array(z.strictObject({ ref: MachineRecipeReferenceV1Schema, title: PluginLocalizedStringV2Schema }))),
  support: z.array(z.strictObject({ sourceIndex: revision(), itemIndex: revision(),
    status: MachineSetupObservationStatusV1Schema, reason: z.optional(MachineSetupObservationReasonV1Schema),
    requiredFact: z.optional(id()) })),
  recipePlans: z.optional(z.array(MachineSetupRecipePlanV1Schema)),
  backupReceivers: z.optional(z.array(MachineSetupBackupReceiverResultV1Schema)),
  appChildren: z.optional(z.array(MachineSetupAppChildV1Schema)),
  appReviews: z.optional(z.array(MachineSetupAppReviewV1Schema)),
  review: z.optional(MachineSetupPlanReviewV1Schema),
  updates: z.optional(z.strictObject({ observation: MachineSetupUpdatesObservationV1Schema, plan: z.optional(MachineSetupEffectPlanV1Schema) })),
}).check(z.superRefine((value, context) => {
  if (value.resolvedSources === undefined) return;
  if (value.resolvedSources.length !== value.sources.length) {
    context.addIssue({ code: 'custom', path: ['resolvedSources'],
      message: 'Resolved setup source projections must align with the Plan sources' });
    return;
  }
  value.sources.forEach((source, index) => {
    const resolved = value.resolvedSources![index]!;
    if (!sameMachineSetupPlanResolvedSourceV1(source, resolved)) {
      context.addIssue({ code: 'custom', path: ['resolvedSources', index],
        message: 'Resolved setup source projection must match the Plan source' });
    }
  });
})));
export type MachineSetupPlanResultV1 = z.infer<typeof MachineSetupPlanResultV1Schema>;
/** Keep the target owner's executable Plan fields; presentation facts never enter Apply. */
export function machineSetupApplyTargetFromPlanV1(
  target: Pick<MachineSetupApplyTargetV1, 'homeId' | 'machineId'>,
  plan: MachineSetupPlanResultV1,
): MachineSetupApplyTargetV1 {
  return MachineSetupApplyTargetV1Schema.parse({ homeId: target.homeId, machineId: target.machineId,
    desiredRevision: plan.desiredRevision, sources: plan.sources, exclusions: plan.exclusions,
    recipePlans: plan.recipePlans,
    ...(plan.removeItemKeys === undefined ? {} : { removeItemKeys: plan.removeItemKeys }),
    ...(plan.removalPlans === undefined ? {} : { removalPlans: plan.removalPlans }),
    ...(plan.appChildren === undefined ? {} : { appChildren: plan.appChildren }),
  });
}

/** A single exact native target remains an ordinary canonical Apply operand. */
export function buildMachineSetupTargetApplyInput(target: MachineSetupApplyTargetV1): MachineSetupApplyInputV1 {
  return { homeId: target.homeId, machineId: target.machineId, targets: [target] };
}

export const MachineSetupCombinedPlanInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), selectedMachineId: z.optional(id()), targets: z.array(MachineSetupPlanInputV1Schema).check(z.minLength(1)),
}).check(z.refine(input => new Set(input.targets.map(target => JSON.stringify([target.homeId, target.machineId]))).size === input.targets.length,
  { message: 'Setup targets must be unique.' })));
export type MachineSetupCombinedPlanInputV1 = z.infer<typeof MachineSetupCombinedPlanInputV1Schema>;
/** Finite read-only target projection of an unchanged combined setup root. */
export function readMachineSetupPlanChildInputV1(params: Readonly<{
  rootActionId: string; rootInput: unknown; machineId: string; input: unknown;
}>): MachineSetupPlanInputV1 | null {
  const child = MachineSetupPlanInputV1Schema.safeParse(params.input);
  if (!child.success || child.data.machineId !== params.machineId) return null;
  if (params.rootActionId === 'machines.setup.plan') {
    const root = MachineSetupCombinedPlanInputV1Schema.safeParse(params.rootInput);
    const target = root.success && root.data.targets.find(target => target.machineId === params.machineId
      && target.homeId === child.data.homeId);
    if (!target) return null;
    return sameStrictJsonValue(target, child.data) ? child.data : null;
  }
  if (params.rootActionId === 'machines.setup.apply') {
    const root = MachineSetupApplyInputV1Schema.safeParse(params.rootInput);
    const target = root.success && root.data.targets.find(target => target.machineId === params.machineId
      && target.homeId === child.data.homeId);
    return target && sameStrictJsonValue(child.data, { homeId: target.homeId, machineId: target.machineId,
      sources: target.sources, ...(target.exclusions === undefined ? {} : { exclusions: target.exclusions }),
      ...(target.appChildren === undefined ? {} : { appChildren: target.appChildren }),
      ...(target.removeItemKeys === undefined ? {} : { removeItemKeys: target.removeItemKeys }), mode: 'effects' }) ? child.data : null;
  }
  if (params.rootActionId === 'machines.setup.remove') {
    const root = MachineSetupRemoveInputV1Schema.safeParse(params.rootInput);
    return root.success && root.data.machineId === params.machineId && sameStrictJsonValue(child.data, {
      homeId: root.data.homeId, machineId: root.data.machineId, sources: root.data.sources,
      removeItemKeys: root.data.removeItemKeys, ...(root.data.exclusions === undefined ? {} : { exclusions: root.data.exclusions }),
      mode: 'effects',
    }) ? child.data : null;
  }
  return null;
}
export const MachineSetupPlanUnavailableTargetV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), status: z.literal('unavailable'), reason: z.literal('offline'), errorCode: z.literal('machine_offline'),
}));
export type MachineSetupPlanUnavailableTargetV1 = z.infer<typeof MachineSetupPlanUnavailableTargetV1Schema>;
export const MachineSetupCombinedPlanResultV1Schema = lazyZodSchema(() => z.strictObject({
  targets: z.array(z.union([z.strictObject({ homeId: id(), machineId: id(), plan: MachineSetupPlanResultV1Schema,
    appChildren: z.optional(z.array(MachineSetupAppChildV1Schema)) }), MachineSetupPlanUnavailableTargetV1Schema])).check(
      z.refine(targets => new Set(targets.map(target => JSON.stringify([target.homeId, target.machineId]))).size === targets.length,
        { message: 'Each selected setup target has one result.' })),
  review: WorkflowCombinedActionHostReviewV1Schema,
}));
export type MachineSetupCombinedPlanResultV1 = z.infer<typeof MachineSetupCombinedPlanResultV1Schema>;
const MachineSetupCreationOriginV1Schema = lazyZodSchema(() => z.strictObject({ managedId: id(),
  preset: z.strictObject({ id: id(), revision: revision() }),
}));
/** Private Home read purpose: origin matching never certifies attachment copies. */
export const MachineSetupResolveInputV1Schema = lazyZodSchema(() => z.union([
  MachineSetupSourcesApplyInputV1Schema,
  z.strictObject({ homeId: id(), machineId: id(), purpose: z.literal('creationOrigin'),
    candidates: z.array(MachineSetupSourceApplyEntryV1Schema).check(z.refine(
      candidates => candidates.every(candidate => candidate.kind === 'accountPresetOpaque'),
      { message: 'Creation origin candidates are Account Preset copies.' })),
  }),
]));
export type MachineSetupResolveInputV1 = z.infer<typeof MachineSetupResolveInputV1Schema>;
export const MachineSetupResolveResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ sources: MachineSetupResolvedSourceV1Schema, creation: z.optional(MachineSetupCreationOriginV1Schema) }),
  z.strictObject({ purpose: z.literal('creationOrigin'), creation: z.optional(MachineSetupCreationOriginV1Schema) }),
]));
export const MachineSetupReportInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineSetupPresetApplyInputV1Schema, {
  managedId: id(), state: z.enum(['running', 'succeeded', 'failed']),
  operation: z.strictObject({ operationId: id() }), errorCode: z.optional(z.string().check(z.minLength(1))),
})));
export type MachineSetupReportInputV1 = z.infer<typeof MachineSetupReportInputV1Schema>;

// Classic roots are the actual public Action-spec consumer seam. Internal
// fields remain one Mini tree; stored projections derive from these owners.
export const ManagedAcquireInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ selection: ManagedOneOffSelectionV1Schema, creationScopeRetention: z.optional(ManagedCreationScopeRetentionChoiceV1Schema), enrollmentIdentity: ManagedMachineEnrollmentIdentityV1Schema, agentStart: z.optional(ManagedAcquireAgentStartV1Schema),
    reviewedFacts: z.optional(ManagedConfigurationFactsV1Schema) }),
  z.strictObject({ selection: ManagedPresetSelectionV1Schema, creationScopeRetention: z.optional(ManagedCreationScopeRetentionChoiceV1Schema), controller: z.optional(ManagedControllerV1Schema),
    retention: z.optional(RetentionV1Schema), wakeOnAcceptedMessage: mini.optional(mini.boolean()),
    /** Same-DEK private admission delta (including enrollment identity); Home stores only this tagged carrier. */
    presetContentOverride: z.optional(ManagedMachinePresetLaunchNameOverrideV1Schema),
    agentStart: z.optional(ManagedAcquireAgentStartV1Schema) }),
]));
/** Selection kind owns the branch; optional policy and sealed deltas do not identify it. */
export function isManagedPresetAcquireInputV1(input: ManagedAcquireInputV1): input is Extract<ManagedAcquireInputV1, { selection: { kind: 'preset' } }> {
  return input.selection.kind === 'preset';
}
/** One-off effects live in the selection; preset requests carry the separately reviewed policy. */
export function resolveManagedAcquireReviewV1(input: ManagedAcquireInputV1) {
  if (isManagedPresetAcquireInputV1(input)) return { homeId: input.selection.homeId, ...(input.controller === undefined ? {} : { controller: input.controller }),
    retention: input.retention, wakeOnAcceptedMessage: input.wakeOnAcceptedMessage };
  return { homeId: input.selection.homeId, ...(input.selection.controller === undefined ? {} : { controller: input.selection.controller }),
    retention: input.selection.retention, wakeOnAcceptedMessage: input.selection.wakeOnAcceptedMessage };
}
export const ManagedAcceptedV1Schema = lazyZodSchema(() => z.strictObject({ managedId: id(), operation: z.optional(actionOperationSchema) }));
export const ManagedListInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), archived: mini.optional(mini.boolean()),
  presetId: mini.optional(id()), enrolledMachineId: mini.optional(id()),
}));
/** An Account read of an opaque row carries the exact stored ciphertext and only that Account's envelope. */
export const ManagedOpaquePresetReadV1Schema = lazyZodSchema(() => z.strictObject({
  machine: ManagedOpaquePresetMachineV1Schema,
  presetContent: ManagedMachinePresetRecipientProjectionV1Schema,
}));
export type ManagedOpaquePresetReadV1 = z.infer<typeof ManagedOpaquePresetReadV1Schema>;
export const ManagedMachineReadV1Schema = lazyZodSchema(() => z.union([
  ManagedMachinePublicFullV1Schema,
  ManagedOpaquePresetReadV1Schema,
]));
export type ManagedMachineReadV1 = z.infer<typeof ManagedMachineReadV1Schema>;
/** Normalizes the two validated public read shapes before structural consumers inspect a Machine. */
export function unwrapManagedMachineReadV1(read: ManagedMachineReadV1): ManagedMachineV1 {
  return 'machine' in read ? read.machine : read;
}
export function isManagedOpaquePresetReadV1(value: unknown): value is ManagedOpaquePresetReadV1 {
  return ManagedOpaquePresetReadV1Schema.safeParse(value).success;
}
export const ManagedListOutputV1Schema = lazyZodSchema(() => z.strictObject({ machines: mini.array(ManagedMachineReadV1Schema) }));
export const ManagedGetOutputV1Schema = lazyZodSchema(() => z.lazy(() => ManagedMachineReadV1Schema));
export const ManagedGetInputV1Schema = lazyZodSchema(() => z.strictObject(target()));
export const ManagedMutationInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision() }));
export const ManagedRebuildInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), ...DevcontainerRebuildIntentV1Schema.def.shape }));
/** A preset resize carries its private requested size in an existing sealed-content override. */
export const ManagedOpaquePresetResizeInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), presetContentOverride: ManagedMachinePresetLaunchNameOverrideV1Schema,
}));
export type ManagedOpaquePresetResizeInputV1 = z.infer<typeof ManagedOpaquePresetResizeInputV1Schema>;
export const ManagedResizeInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...target(), size: MachineProvisionerSizeV1Schema }),
  ManagedOpaquePresetResizeInputV1Schema,
]));
/** Opaque preset resize reports retain outcome state only; native details remain in sealed content. */
export const ManagedOpaquePresetResizeResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('confirmed') }),
  z.strictObject({ kind: z.literal('unknown') }),
  z.strictObject({ kind: z.literal('refused') }),
  z.strictObject({ kind: z.literal('unsupported') }),
]));
export type ManagedOpaquePresetResizeResultV1 = z.infer<typeof ManagedOpaquePresetResizeResultV1Schema>;
export function projectManagedOpaquePresetResizeResultV1(
  result: Readonly<{ kind: string }>,
): ManagedOpaquePresetResizeResultV1 {
  switch (result.kind) {
    case 'confirmed':
    case 'unknown':
    case 'refused':
    case 'unsupported':
      return { kind: result.kind };
    default:
      throw new Error(`Unsupported opaque managed resize result: ${result.kind}`);
  }
}
export const ManagedResizeOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ result: asProtocolZod(MachineProvisionerResizeResultV1Schema), observation: z.optional(ProviderObservationV1Schema) }),
  z.strictObject({ result: ManagedOpaquePresetResizeResultV1Schema,
    presetContent: ManagedMachinePresetStoredContentCarrierV1Schema,
    observation: z.optional(ManagedOpaquePresetObservationV1Schema) }),
]));
export const ManagedControllerResizeReportV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...target(), requestId: id(), result: asProtocolZod(MachineProvisionerResizeResultV1Schema), observation: z.optional(ProviderObservationV1Schema) }),
  z.strictObject({ ...target(), requestId: id(), result: ManagedOpaquePresetResizeResultV1Schema,
    presetContent: ManagedMachinePresetStoredContentCarrierV1Schema,
    observation: z.optional(ManagedOpaquePresetObservationV1Schema) }),
]));
export type ManagedControllerResizeReportV1 = z.infer<typeof ManagedControllerResizeReportV1Schema>;
export const ManagedPowerInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...ManagedIntentInputSchema.def.options[0].def.shape, intent: z.enum(['start', 'stop', 'suspend', 'resume']) }),
  z.strictObject({ ...ManagedIntentInputSchema.def.options[1].def.shape, intent: z.enum(['stop', 'suspend']) }),
]));
export const ManagedDeleteInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...ManagedIntentInputSchema.def.options[0].def.shape, intent: z.literal('delete'), reviewedDependencies: z.literal(true) }),
  z.strictObject({ ...ManagedIntentInputSchema.def.options[1].def.shape, intent: z.literal('delete'), reviewedDependencies: z.literal(true) }),
]));
/** Delete discloses its captured census on every semantic outcome; native intent facts stay unchanged. */
export const ManagedDeleteOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ...ManagedIntentResultSchema.def.options[0].def.shape, machineReferences: MachineReferenceCensusV1Schema }),
  z.strictObject({ ...ManagedIntentResultSchema.def.options[1].def.shape, machineReferences: MachineReferenceCensusV1Schema }),
  z.strictObject({ ...ManagedIntentResultSchema.def.options[2].def.shape, machineReferences: MachineReferenceCensusV1Schema }),
]));
export const ManagedRetentionUpdateInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...target(), expectedIntentRevision: revision(), retention: RetentionV1Schema, wakeOnAcceptedMessage: mini.boolean() }),
  z.strictObject({ ...target(), expectedIntentRevision: revision(), creationScopeRetention: z.nullable(ManagedCreationScopeRetentionChoiceV1Schema) }),
]));
export const ManagedControllerUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision(), controller: z.nullable(ManagedControllerV1Schema), reviewedPendingEffects: z.literal(true) }));
export const ManagedRetireInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision(), manualResponsibility: z.literal(true) }));
export const ManagedCancelInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision() }));
export const ManagedInspectInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), includeGuestDiagnostics: z.optional(z.literal(true)) }));
/** The existing diagnostics owner supplies only daemon facts and selected, redacted log tails. */
export const ManagedGuestDiagnosticsV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('collected'), snapshot: z.pick(BugReportMachineDiagnosticsSnapshotSchema,
    { daemonState: true, sessionDiagnostics: true }) }),
  z.strictObject({ status: z.literal('unavailable'), code: id(), phase: z.optional(id()), requestId: z.optional(id()),
    exitCode: z.optional(z.int()) }),
]));
export type ManagedGuestDiagnosticsV1 = z.infer<typeof ManagedGuestDiagnosticsV1Schema>;
export const ManagedInspectOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema,
  operation: z.optional(actionOperationSchema), guestDiagnostics: z.optional(ManagedGuestDiagnosticsV1Schema) }));
export const ManagedCancelOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, operation: z.optional(actionOperationSchema) }));
export const ManagedErrorV1Schema = lazyZodSchema(() => z.strictObject({ code: ManagedRefusalCodeV1Schema }));
export const ManagedControllerCurrentnessV1Schema = lazyZodSchema(() => z.strictObject(current()));
export const ManagedControllerCurrentInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ManagedControllerCurrentnessV1Schema, { nativeRole: z.optional(z.literal('inspect')) })));
/** Signed only by the current guest after its real admission drain commits idle. */
export const ManagedCommittedIdleEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  context: SocketRpcMachineAdmissionContextV1Schema, method: z.string().check(z.minLength(1)),
  managedTarget: z.lazy(() => ManagedActivityReadRequestV1Schema),
  decision: z.strictObject({ kind: z.literal('idle'), since: z.number().check(z.nonnegative()), confirmedAt: z.number().check(z.nonnegative()) }),
  proof: MachineInstallationProofV1Schema,
}));
export type ManagedCommittedIdleEvidenceV1 = z.infer<typeof ManagedCommittedIdleEvidenceV1Schema>;
/**
 * A controller may replace only an opaque preset's private content snapshot
 * after applying a per-Machine name. Recipient envelopes remain admission
 * authority and never travel on this report path.
 */
export const ManagedControllerPresetContentV1Schema = lazyZodSchema(() =>
  ManagedMachinePresetStoredContentCarrierV1Schema,
);
export type ManagedControllerPresetContentV1 = z.infer<typeof ManagedControllerPresetContentV1Schema>;
/** Opaque preset reports retain outcome state only; native provider values stay in sealed preset content. */
export const ManagedOpaquePresetAcquireResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bound') }),
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({ kind: z.literal('unknown') }),
  z.strictObject({ kind: z.literal('rejected') }),
]));
export type ManagedOpaquePresetAcquireResultV1 = z.infer<typeof ManagedOpaquePresetAcquireResultV1Schema>;

/** Canonical report projection; native provider values remain in sealed preset content. */
export function projectManagedOpaquePresetAcquireResultV1(result: AcquireResultV1): ManagedOpaquePresetAcquireResultV1 {
  return { kind: result.kind };
}

/** Opaque preset reports retain outcome state only; native provider values stay in sealed preset content. */
export const ManagedOpaquePresetIntentResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted') }),
  z.strictObject({ kind: z.literal('bound') }),
  z.strictObject({ kind: z.literal('confirmed') }),
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({ kind: z.literal('unknown') }),
  z.strictObject({ kind: z.literal('refused') }),
]));
export type ManagedOpaquePresetIntentResultV1 = z.infer<typeof ManagedOpaquePresetIntentResultV1Schema>;

/** Canonical report projection for destroy/rebuild results. */
export function projectManagedOpaquePresetIntentResultV1(
  result: Readonly<{ kind: string }>,
): ManagedOpaquePresetIntentResultV1 {
  switch (result.kind) {
    case 'accepted':
    case 'bound':
    case 'confirmed':
    case 'pending':
    case 'unknown':
    case 'refused':
      return { kind: result.kind };
    default:
      throw new Error(`Unsupported opaque managed intent result: ${result.kind}`);
  }
}

export const ManagedControllerReportV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...current(), result: AcquireResultV1Schema,
    configurationFacts: mini.optional(ManagedConfigurationFactsV1Schema),
    bootstrapInstalled: z.optional(z.literal(true)), observation: mini.optional(ProviderObservationV1Schema),
  }).check(z.superRefine((value, context) => {
    if (value.bootstrapInstalled && value.result.kind !== 'bound') context.addIssue({ code: 'custom', path: ['bootstrapInstalled'], message: 'Installation completes on a bound resource.' });
  })),
  z.strictObject({ ...current(), result: ManagedOpaquePresetAcquireResultV1Schema,
    presetContent: ManagedControllerPresetContentV1Schema,
    bootstrapInstalled: z.optional(z.literal(true)), observation: mini.optional(ManagedOpaquePresetObservationV1Schema),
  }).check(z.superRefine((value, context) => {
    if (value.bootstrapInstalled && value.result.kind !== 'bound') context.addIssue({ code: 'custom', path: ['bootstrapInstalled'], message: 'Installation completes on a bound resource.' });
  })),
]));
export const ManagedControllerCredentialDeliveryReportV1Schema = lazyZodSchema(() => z.strictObject({ ...current(), controller: ManagedControllerV1Schema,
  credentialDelivery: z.union([
    z.strictObject({ request: ManagedCredentialInstallInputV1Schema, phase: z.literal('submitted') }),
    z.strictObject({ request: ManagedCredentialInstallInputV1Schema, result: ManagedCredentialDeliveryResultV1Schema,
      appliedPolicy: mini.optional(z.strictObject({ ownedBindingKeys: z.array(id()), desiredBindingKeys: z.array(id()) })),
    }),
  ]),
}));
export const ManagedControllerCredentialDeliveryReportOutputV1Schema = lazyZodSchema(() => z.strictObject({
  machine: ManagedMachineV1Schema, credentialDeliveryResult: ManagedCredentialDeliveryResultV1Schema,
}));
/** Opaque preset enrollment proves only the admitted bound lifecycle; its native identity stays sealed. */
export const ManagedEnrollmentFullCorrelationV1Schema = lazyZodSchema(() => z.strictObject({ ...current(), resource: ManagedResourceV1Schema }));
export type ManagedEnrollmentFullCorrelationV1 = z.infer<typeof ManagedEnrollmentFullCorrelationV1Schema>;
export const ManagedEnrollmentCorrelationV1Schema = lazyZodSchema(() => z.union([
  ManagedEnrollmentFullCorrelationV1Schema,
  z.strictObject({ ...current() }),
]));
/** Project from the original Home row; opening a private snapshot never makes its native resource public. */
export function projectManagedEnrollmentCorrelationV1<T extends Pick<ManagedEnrollmentFullCorrelationV1, 'resource'>>(
  machine: ManagedMachineV1, correlation: T,
): T | Omit<T, 'resource'> {
  if (!isManagedOpaquePresetMachineV1(machine)) return correlation;
  const { resource: _resource, ...structural } = correlation;
  return structural;
}
/** Controller admission never receives ordinary composer text or startup instructions. */
export const ManagedAdmissionComputeInputV1Schema = lazyZodSchema(() => z.union([
  z.omit(ManagedAcquireInputV1Schema._zod.def.options[0], { agentStart: true }),
  z.omit(ManagedAcquireInputV1Schema._zod.def.options[1], { agentStart: true }),
]));
export const ManagedAdmissionInputV1Schema = lazyZodSchema(() => z.strictObject({ input: ManagedAdmissionComputeInputV1Schema, requestId: id(), continuationPresent: mini.boolean(),
  requestEnvelopeDigest: z.optional(ExternalActionManagedContinuationV1Schema.shape.acquireRequestEnvelopeDigest),
  /** Native-qualified defaults are separate from the unchanged signed requester input. */
  presetPolicy: z.optional(MachineRetentionPolicyV1Schema),
  originalActionEnvelope: z.optional(ExternalActionRequestEnvelopeSchema),
}));
/**
 * An opaque preset admission carries only the structural allocation row.  The
 * private launch/setup snapshot is opened by the installed custodian daemon
 * with its Account key before native reconciliation.
 */
export const ManagedAdmissionPresetContentV1Schema = lazyZodSchema(() => z.strictObject({
  content: ManagedMachinePresetStoredContentCarrierV1Schema,
  recipients: ManagedMachinePresetRecipientsV1Schema,
}));
export type ManagedAdmissionPresetContentV1 = z.infer<typeof ManagedAdmissionPresetContentV1Schema>;
/** @deprecated Use the canonical opaque managed-machine projection. */
export const ManagedAdmissionStructuralMachineV1Schema = lazyZodSchema(() => ManagedOpaquePresetMachineV1Schema);
export type ManagedAdmissionStructuralMachineV1 = z.infer<typeof ManagedAdmissionStructuralMachineV1Schema>;
export const ManagedAdmissionMachineV1Schema = lazyZodSchema(() => ManagedMachineV1Schema);
export type ManagedAdmissionMachineV1 = z.infer<typeof ManagedAdmissionMachineV1Schema>;
export const ManagedAdmissionOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ machine: ManagedMachinePublicFullV1Schema, replayed: mini.boolean(), resizeProvisioner: z.optional(MachineProvisionerContributionV1Schema) }),
  z.strictObject({ machine: ManagedAdmissionStructuralMachineV1Schema, presetContent: ManagedAdmissionPresetContentV1Schema,
    /** Retained opaque launch-name replacement for the admitted allocation only. */
    presetContentOverride: z.optional(ManagedMachinePresetLaunchNameOverrideV1Schema),
    replayed: mini.boolean(), resizeProvisioner: z.optional(MachineProvisionerContributionV1Schema) }),
]));
export type ManagedAdmissionOutputV1 = z.infer<typeof ManagedAdmissionOutputV1Schema>;
export const ManagedControllerContextInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision(), controller: z.optional(ManagedControllerV1Schema),
  requestId: z.optional(id()),
  includeEnrollmentInstallation: z.optional(z.literal(true)),
  includeNativeCredentialBindings: z.optional(z.literal(true)),
}));
/** The admitted creation's exact enrolled installation, never guest Account content. */
export const ManagedEnrollmentInstallationV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: id(), installationId: id(), installationPublicKey: MachineInstallationPublicKeySchema,
}));
const managedControllerContextOutputFields = () => ({
  requestId: id(),
  nativeCredentialBindings: z.optional(z.array(ManagedNativeCredentialBindingV1Schema)),
  nativeCredentialDesiredBindingKeys: z.optional(z.array(id())),
  enrollmentInstallation: z.optional(ManagedEnrollmentInstallationV1Schema),
});
const managedControllerContextOutputVariants = <Fields extends Record<string, z.ZodMiniType>>(fields: Fields) => [
  z.strictObject({ machine: ManagedMachinePublicFullV1Schema, ...managedControllerContextOutputFields(), ...fields }),
  z.strictObject({ machine: ManagedOpaquePresetMachineV1Schema, presetContent: ManagedAdmissionPresetContentV1Schema,
    presetContentOverride: z.optional(ManagedMachinePresetLaunchNameOverrideV1Schema),
    ...managedControllerContextOutputFields(), ...fields }),
] as const;
/** Context is the restart-safe delivery edge for opaque preset content. */
export const ManagedControllerContextOutputV1Schema = lazyZodSchema(() => z.union(managedControllerContextOutputVariants({})));
/** Policy admission retains the same strict context variants and their restart-safe delivery. */
export const ManagedPolicyAdmissionOutputV1Schema = lazyZodSchema(() => z.union(managedControllerContextOutputVariants({ replayed: z.boolean() })));
export const ManagedControllerMachineOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema }));
export const ManagedControllerSubmitOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, submitted: mini.boolean() }));
/** Only the admitted controller captures this source-owned metadata before native spend. */
export const ManagedControllerSubmitInputV1Schema = lazyZodSchema(() => z.strictObject({ ...current(),
  credentials: mini.optional(RetainedManagedCredentialSelectionsV1Schema),
}));
export const ManagedBootstrapCredentialCreateV1Schema = lazyZodSchema(() => z.strictObject({ ...current(), credential: SharedSavedSecretCreateInputV1Schema }));

export const ProvisionersListInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), controller: mini.optional(ManagedControllerV1Schema),
  contribution: mini.optional(asProtocolZod(PluginContributionIdentityV1Schema)) }));
export const ProvisionerProbeInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), controller: z.optional(ManagedControllerV1Schema), contribution: asProtocolZod(PluginContributionIdentityV1Schema), credentials: mini.optional(ManagedCredentialSelectionsV1Schema), selectors: mini.optional(PluginJsonValueV2Schema) }));
export const ProvisionerOptionsInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), controller: z.optional(ManagedControllerV1Schema), contribution: asProtocolZod(PluginContributionIdentityV1Schema), credentials: mini.optional(ManagedCredentialSelectionsV1Schema), selectors: PluginJsonValueV2Schema }));

export const ManagedMachineActionInputSchemasV1 = {

  'machines.provisioners.list': ProvisionersListInputV1Schema,
  'machines.provisioners.check': ProvisionerProbeInputV1Schema,
  'machines.provisioners.options': ProvisionerOptionsInputV1Schema,
  'machines.managed.acquire': ManagedAcquireInputV1Schema,
  'machines.managed.credentials.install': lazyZodSchema(() => ManagedCredentialInstallInputV1Schema),
  'machines.managed.list': ManagedListInputV1Schema,
  'machines.managed.get': ManagedGetInputV1Schema,
  'machines.managed.birth.get': ManagedGetInputV1Schema,
  'machines.managed.references.get': ManagedGetInputV1Schema,
  'machines.managed.inspect': ManagedInspectInputV1Schema,
  'machines.managed.bootstrap.retry': ManagedMutationInputV1Schema,
  'machines.managed.setup.skip': ManagedMutationInputV1Schema,
  'machines.setup.plan': lazyZodSchema(() => z.union([MachineSetupPlanInputV1Schema, MachineSetupCombinedPlanInputV1Schema])),
  'machines.setup.apply': MachineSetupApplyInputV1Schema,
  'machines.setup.remove': MachineSetupRemoveInputV1Schema,
  'machines.setup.updates.apply': MachineSetupUpdatesApplyInputV1Schema,
  'machines.setup.updates.rollout': MachineSetupUpdatesRolloutInputV1Schema,
  'machines.managed.cancel': ManagedCancelInputV1Schema,
  'machines.managed.power.set': ManagedPowerInputV1Schema,
  'machines.managed.rebuild': ManagedRebuildInputV1Schema,
  'machines.managed.resize': ManagedResizeInputV1Schema,
  'machines.managed.retention.update': ManagedRetentionUpdateInputV1Schema,
  'machines.managed.delete': ManagedDeleteInputV1Schema,
  'machines.managed.controller.update': ManagedControllerUpdateInputV1Schema,
  'machines.managed.retire': ManagedRetireInputV1Schema,
} as const;
export const ManagedMachineActionOutputSchemasV1 = {

  'machines.provisioners.list': lazyZodSchema(() => z.lazy(() => MachineProvisionersListResultV1Schema)),
  'machines.provisioners.check': lazyZodSchema(() => z.lazy(() => MachineProvisionerCheckResultV1Schema)),
  'machines.provisioners.options': lazyZodSchema(() => z.lazy(() => MachineProvisionerOptionsResultV1Schema)),
  'machines.managed.acquire': ManagedAcceptedV1Schema,
  'machines.managed.credentials.install': lazyZodSchema(() => ManagedCredentialDeliveryResultV1Schema),
  'machines.managed.list': ManagedListOutputV1Schema,
  'machines.managed.get': ManagedGetOutputV1Schema,
  'machines.managed.birth.get': ManagedMachineBirthResultV1Schema,
  'machines.managed.references.get': lazyZodSchema(() => z.lazy(() => MachineReferenceCensusV1Schema)),
  'machines.managed.inspect': ManagedInspectOutputV1Schema,
  'machines.managed.bootstrap.retry': ManagedAcceptedV1Schema,
  'machines.managed.setup.skip': ManagedGetOutputV1Schema,
  'machines.setup.plan': lazyZodSchema(() => z.union([MachineSetupPlanResultV1Schema, MachineSetupCombinedPlanResultV1Schema])),
  'machines.setup.apply': MachineSetupApplyResultV1Schema,
  'machines.setup.remove': MachineSetupApplyResultV1Schema,
  'machines.setup.updates.apply': MachineSetupApplyResultV1Schema,
  'machines.setup.updates.rollout': MachineSetupApplyResultV1Schema,
  'machines.managed.cancel': ManagedCancelOutputV1Schema,
  'machines.managed.power.set': lazyZodSchema(() => z.lazy(() => ManagedIntentResultSchema)),
  'machines.managed.rebuild': lazyZodSchema(() => z.lazy(() => ManagedIntentResultSchema)),
  'machines.managed.resize': ManagedResizeOutputV1Schema,
  'machines.managed.retention.update': ManagedGetOutputV1Schema,
  'machines.managed.delete': ManagedDeleteOutputV1Schema,
  'machines.managed.controller.update': ManagedGetOutputV1Schema,
  'machines.managed.retire': ManagedGetOutputV1Schema,
} as const;
export const ManagedControlAdmissionInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('machines.managed.power.set'), input: ManagedPowerInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.rebuild'), input: ManagedRebuildInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.resize'), input: ManagedResizeInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.delete'), input: ManagedDeleteInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.retention.update'), input: ManagedRetentionUpdateInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.controller.update'), input: ManagedControllerUpdateInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.retire'), input: ManagedRetireInputV1Schema, requestId: id() }),
]));
export type ManagedControlAdmissionInputV1 = z.infer<typeof ManagedControlAdmissionInputV1Schema>;
export const ManagedControllerIntentReportV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...current(), result: z.union([asProtocolZod(MachineProvisionerDestroyResultV1Schema), asProtocolZod(MachineProvisionerRebuildResultV1Schema)]),
    observation: mini.optional(ProviderObservationV1Schema) }),
  z.strictObject({ ...current(), result: ManagedOpaquePresetIntentResultV1Schema,
    presetContent: ManagedControllerPresetContentV1Schema,
    observation: mini.optional(ManagedOpaquePresetObservationV1Schema) }),
]));
export type ManagedControllerIntentReportV1 = z.infer<typeof ManagedControllerIntentReportV1Schema>;
export function managedMachineActionEndpointPathV1(action: ManagedMachineActionIdV1): string {
  const suffix = action.startsWith('machines.managed.') ? action.slice('machines.managed.'.length) : action;
  return `/v1/machines/managed/actions/${suffix}`;
}
export type ManagedAcquireInputV1 = z.infer<typeof ManagedAcquireInputV1Schema>;
export type ManagedAcceptedV1 = z.infer<typeof ManagedAcceptedV1Schema>;
export type ManagedEnrollmentCorrelationV1 = z.infer<typeof ManagedEnrollmentCorrelationV1Schema>;
export type ManagedControllerCurrentnessV1 = z.infer<typeof ManagedControllerCurrentnessV1Schema>;
export type ManagedControllerSubmitInputV1 = z.infer<typeof ManagedControllerSubmitInputV1Schema>;
export type ManagedControllerReportV1 = z.infer<typeof ManagedControllerReportV1Schema>;
export type ManagedAdmissionInputV1 = z.infer<typeof ManagedAdmissionInputV1Schema>;
export type ManagedBootstrapCredentialCreateV1 = z.infer<typeof ManagedBootstrapCredentialCreateV1Schema>;
export type ManagedMachineActionInputV1<T extends ManagedMachineActionIdV1> = z.infer<(typeof ManagedMachineActionInputSchemasV1)[T]>;
export type ManagedMachineActionOutputV1<T extends keyof typeof ManagedMachineActionOutputSchemasV1> = z.infer<(typeof ManagedMachineActionOutputSchemasV1)[T]>;
