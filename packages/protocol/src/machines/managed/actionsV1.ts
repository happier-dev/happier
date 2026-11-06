import { MachineInstallationPublicKeySchema } from '../identity/installationKeySchemas.js';
import { MachineSetupExclusionsV1Schema } from '../setup/machineSetupSourcesV1.js';
import { ManagedCredentialInstallInputV1Schema, ManagedCredentialDeliveryResultV1Schema, ManagedNativeCredentialBindingV1Schema } from './credentialDeliveryV1.js';
import { ManagedMachineEnrollmentIdentityV1Schema } from './enrollmentIdentityV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';

import { MachineSetupExclusionV1Schema } from '../setup/machineSetupSourcesV1.js';
import { MachineSetupSourceFactsMapV1Schema } from '../setup/machineSetupSourcesV1.js';
import { MachineSetupAppOriginV1Schema } from '../setup/machineSetupSourcesV1.js';
import { MachineRecipeSelectionV1Schema } from '../setup/machineRecipeV1.js';
import { MachineRecipeReferenceV1Schema } from '../setup/machineRecipeReferenceV1.js';
import { PluginLocalizedStringV2Schema } from '../../plugins/contributions/publicTypes.js';
import { MachineSetupObservationStatusV1Schema } from '../setup/machineSetupObservationV1.js';
import { MachineSetupUpdatesObservationV1Schema, MachineSetupObservationReasonV1Schema } from '../setup/machineSetupObservationV1.js';
import { DeploymentTemplateInstantiationReviewV1Schema } from '../../deployments/deploymentTemplateInstantiationV1.js';
import { WorkflowCombinedActionHostReviewV1Schema } from '../../workflows/workflowStartPreparationV1.js';
import { z } from 'zod/mini';
import { MachineSetupSourceV1Schema } from '../setup/machineSetupSourcesV1.js';
import { MachineSetupEffectPlanV1Schema } from '../setup/machineRecipeV1.js';
import { DeploymentEnvironmentCreateInputV1Schema, DeploymentDeployInputV1Schema } from '../../deployments/deploymentActionsV1.js';
import { DeploymentTemplateInstantiateInputV1Schema } from '../../deployments/deploymentTemplateInstantiationV1.js';
import * as mini from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { MachineProvisionersListResultV1Schema, MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema } from '../../plugins/contributions/machineProvisioners.js';
import { ActionOperationGetV1RequestSchema } from '../../actions/operations/v1.js';
import { SharedSavedSecretCreateInputV1Schema } from '../../account/settings/savedSecretResourceActionsV1.js';
import { ManagedAcquireAgentStartV1Schema } from './agentStartV1.js';
import { ManagedControllerV1Schema, ManagedCredentialSelectionsV1Schema, RetainedManagedCredentialSelectionsV1Schema, ManagedMachineV1Schema, RetentionV1Schema, ValidatedLaunchSnapshotV1Schema } from './managedMachineV1.js';
import { AcquireResultV1Schema, ManagedRefusalCodeV1Schema, ManagedResourceV1Schema, ProviderObservationV1Schema } from './providerFactsV1.js';
import { MANAGED_MACHINE_ACTION_IDS_V1, type ManagedMachineActionIdV1 } from './actionIdsV1.js';
import { ManagedConfigurationFactsV1Schema, ManagedOneOffSelectionV1Schema, ManagedPresetSelectionV1Schema } from './managedConfigurationV1.js';
import { DevcontainerRebuildIntentV1Schema, ManagedIntentInputSchema, ManagedIntentResultSchema, ManagedActivityReadRequestV1Schema, ManagedActivityRpcRequestV1Schema } from './managedIntentV1.js';
import { MachineInstallationProofV1Schema } from '../identity/installationIdentity.js';
import { SocketRpcMachineAdmissionContextV1Schema } from '../machineAccessV1.js';
import { MachineProvisionerDestroyResultV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerRebuildResultV1Schema } from '../../plugins/contributions/machineProvisioners.js';
import { MachineReferenceCensusV1Schema } from '../machineReferenceCensusV1.js';
import { MachineEnvironmentV1Schema } from './machineEnvironmentV1.js';
export { MANAGED_MACHINE_ACTION_IDS_V1, type ManagedMachineActionIdV1 } from './actionIdsV1.js';
export { isManagedRetainedControlInvocation } from './actionIdsV1.js';

const id = () => mini.string().check(mini.trim(), mini.minLength(1));
const revision = () => mini.int().check(mini.gte(0));
export const ManagedMachineActionIdV1Schema = lazyDefinition(() => mini.enum(MANAGED_MACHINE_ACTION_IDS_V1));
const target = () => ({ homeId: id(), managedId: id() });
const current = () => ({ ...target(), expectedIntentRevision: revision(), requestId: id(), controller: z.optional(ManagedControllerV1Schema) });
export const MachineSetupSourcesApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), sources: MachineSetupSourceV1Schema,
}));
export type MachineSetupSourcesApplyInputV1 = z.infer<typeof MachineSetupSourcesApplyInputV1Schema>;
export const MachineSetupRecipePlanV1Schema = lazyZodSchema(() => z.strictObject({
  sourceIndex: revision(), itemIndex: revision(), plan: MachineSetupEffectPlanV1Schema,
}));
export const MachineSetupAppChildV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  z.strictObject({ sourceIndex: revision(), itemIndex: revision(), actionId: z.literal('deployments.environments.create'),
    input: DeploymentEnvironmentCreateInputV1Schema }),
  z.strictObject({ sourceIndex: revision(), itemIndex: revision(), actionId: z.literal('deployments.templates.instantiate'),
    input: DeploymentTemplateInstantiateInputV1Schema }),
  z.strictObject({ sourceIndex: revision(), itemIndex: revision(), actionId: z.literal('deployments.deploy'),
    input: DeploymentDeployInputV1Schema }),
]));
export type MachineSetupAppChildV1 = z.infer<typeof MachineSetupAppChildV1Schema>;
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
export const MachineEnvironmentApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), presetId: id(), presetRevision: revision(),
}));
export type MachineEnvironmentApplyInputV1 = z.infer<typeof MachineEnvironmentApplyInputV1Schema>;
export const MachineEnvironmentApplyResultV1Schema = lazyZodSchema(() => z.strictObject({ operationId: id(), terminalId: mini.optional(id()) }));
export const MachineEnvironmentResolveResultV1Schema = lazyZodSchema(() => z.strictObject({ environment: MachineEnvironmentV1Schema, managedId: mini.optional(id()) }));
export const MachineEnvironmentReportInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineEnvironmentApplyInputV1Schema, {
  managedId: id(), state: z.enum(['running', 'succeeded', 'failed']),
  operation: z.strictObject({ operationId: id() }), errorCode: z.optional(z.string().check(z.minLength(1))),
})));
export type MachineEnvironmentReportInputV1 = z.infer<typeof MachineEnvironmentReportInputV1Schema>;

// Classic roots are the actual public Action-spec consumer seam. Internal
// fields remain one Mini tree; stored projections derive from these owners.
export const ManagedAcquireInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ selection: ManagedOneOffSelectionV1Schema, enrollmentIdentity: ManagedMachineEnrollmentIdentityV1Schema, agentStart: z.optional(ManagedAcquireAgentStartV1Schema),
    reviewedFacts: z.optional(ManagedConfigurationFactsV1Schema) }),
  z.strictObject({ selection: ManagedPresetSelectionV1Schema, enrollmentIdentity: ManagedMachineEnrollmentIdentityV1Schema, controller: ManagedControllerV1Schema,
    retention: RetentionV1Schema, wakeOnAcceptedMessage: mini.boolean(),
    agentStart: z.optional(ManagedAcquireAgentStartV1Schema), reviewedFacts: z.optional(ManagedConfigurationFactsV1Schema) }),
]));
/** One-off effects live in the selection; preset requests carry the separately reviewed policy. */
export function resolveManagedAcquireReviewV1(input: ManagedAcquireInputV1) {
  if ('controller' in input) return { homeId: input.selection.homeId, controller: input.controller,
    retention: input.retention, wakeOnAcceptedMessage: input.wakeOnAcceptedMessage };
  return { homeId: input.selection.homeId, controller: input.selection.controller,
    retention: input.selection.retention, wakeOnAcceptedMessage: input.selection.wakeOnAcceptedMessage };
}
export const ManagedAcceptedV1Schema = lazyZodSchema(() => z.strictObject({ managedId: id(), operation: z.optional(ActionOperationGetV1RequestSchema) }));
export const ManagedListInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), archived: mini.optional(mini.boolean()),
  presetId: mini.optional(id()), enrolledMachineId: mini.optional(id()),
}));
export const ManagedListOutputV1Schema = lazyZodSchema(() => z.strictObject({ machines: mini.array(ManagedMachineV1Schema) }));
export const ManagedGetOutputV1Schema = lazyZodSchema(() => z.lazy(() => ManagedMachineV1Schema));
export const ManagedGetInputV1Schema = lazyZodSchema(() => z.strictObject(target()));
export const ManagedMutationInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision() }));
export const ManagedRebuildInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), ...DevcontainerRebuildIntentV1Schema.def.shape }));
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
export const ManagedRetentionUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision(), retention: RetentionV1Schema, wakeOnAcceptedMessage: mini.boolean() }));
export const ManagedControllerUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision(), controller: z.nullable(ManagedControllerV1Schema), reviewedPendingEffects: z.literal(true) }));
export const ManagedRetireInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision(), manualResponsibility: z.literal(true) }));
export const ManagedCancelInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision() }));
export const ManagedInspectOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, operation: z.optional(ActionOperationGetV1RequestSchema) }));
export const ManagedCancelOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, operation: z.optional(ActionOperationGetV1RequestSchema) }));
export const ManagedErrorV1Schema = lazyZodSchema(() => z.strictObject({ code: ManagedRefusalCodeV1Schema }));
export const ManagedControllerCurrentnessV1Schema = lazyZodSchema(() => z.strictObject(current()));
export const ManagedControllerCurrentInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ManagedControllerCurrentnessV1Schema, { nativeRole: z.optional(z.literal('inspect')) })));
export const ManagedGuestCurrentInputV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1),
  context: SocketRpcMachineAdmissionContextV1Schema, method: z.string().check(z.minLength(1)),
  managedTarget: z.lazy(() => ManagedActivityRpcRequestV1Schema), proof: MachineInstallationProofV1Schema,
}));
export const ManagedGuestCurrentOutputV1Schema = lazyZodSchema(() => z.strictObject({ current: z.boolean() }));
/** Signed only by the current guest after its real admission drain commits idle. */
export const ManagedCommittedIdleEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  context: SocketRpcMachineAdmissionContextV1Schema, method: z.string().check(z.minLength(1)),
  managedTarget: z.lazy(() => ManagedActivityReadRequestV1Schema),
  decision: z.strictObject({ kind: z.literal('idle'), since: z.number().check(z.nonnegative()), confirmedAt: z.number().check(z.nonnegative()) }),
  proof: MachineInstallationProofV1Schema,
}));
export type ManagedCommittedIdleEvidenceV1 = z.infer<typeof ManagedCommittedIdleEvidenceV1Schema>;
export const ManagedControllerReportV1Schema = lazyZodSchema(() => z.strictObject({ ...current(), result: AcquireResultV1Schema,
  configurationFacts: mini.optional(ManagedConfigurationFactsV1Schema),
  bootstrapInstalled: z.optional(z.literal(true)), observation: mini.optional(ProviderObservationV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.bootstrapInstalled && value.result.kind !== 'bound') context.addIssue({ code: 'custom', path: ['bootstrapInstalled'], message: 'Installation completes on a bound resource.' });
})));
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
export const ManagedEnrollmentCorrelationV1Schema = lazyZodSchema(() => z.strictObject({ ...current(), resource: ManagedResourceV1Schema }));
/** Controller admission never receives ordinary composer text or startup instructions. */
export const ManagedAdmissionComputeInputV1Schema = lazyZodSchema(() => z.union([
  z.omit(ManagedAcquireInputV1Schema._zod.def.options[0], { agentStart: true }),
  z.omit(ManagedAcquireInputV1Schema._zod.def.options[1], { agentStart: true }),
]));
export const ManagedAdmissionInputV1Schema = lazyZodSchema(() => z.strictObject({ input: ManagedAdmissionComputeInputV1Schema, requestId: id(), continuationPresent: mini.boolean() }));
export const ManagedAdmissionOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, replayed: mini.boolean() }));
export const ManagedControllerContextInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision(), controller: z.optional(ManagedControllerV1Schema),
  requestId: z.optional(id()),
  includeNativeCredentialBindings: z.optional(z.literal(true)),
  includeEnrollmentInstallation: z.optional(z.literal(true)),
}));
/** The admitted creation's exact enrolled installation, never guest Account content. */
export const ManagedEnrollmentInstallationV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: id(), installationId: id(), installationPublicKey: MachineInstallationPublicKeySchema,
}));
export const ManagedControllerContextOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, requestId: id(),
  nativeCredentialBindings: z.optional(z.array(ManagedNativeCredentialBindingV1Schema)),
  nativeCredentialDesiredBindingKeys: z.optional(z.array(id())),
  enrollmentInstallation: z.optional(ManagedEnrollmentInstallationV1Schema),
}));
export const ManagedControllerMachineOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema }));
export const ManagedControllerSubmitOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, submitted: mini.boolean() }));
/** Only the admitted controller captures this source-owned metadata before native spend. */
export const ManagedControllerSubmitInputV1Schema = lazyZodSchema(() => z.strictObject({ ...current(),
  credentials: mini.optional(RetainedManagedCredentialSelectionsV1Schema),
}));
export const ManagedBootstrapCredentialCreateV1Schema = lazyZodSchema(() => z.strictObject({ ...current(), credential: SharedSavedSecretCreateInputV1Schema }));

export const ProvisionersListInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), controller: mini.optional(ManagedControllerV1Schema),
  contribution: mini.optional(asProtocolZod(PluginContributionIdentityV1Schema)) }));
export const ProvisionerProbeInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), controller: ManagedControllerV1Schema, contribution: asProtocolZod(PluginContributionIdentityV1Schema), credentials: mini.optional(ManagedCredentialSelectionsV1Schema) }));
export const ProvisionerOptionsInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), controller: ManagedControllerV1Schema, contribution: asProtocolZod(PluginContributionIdentityV1Schema), credentials: mini.optional(ManagedCredentialSelectionsV1Schema), selectors: PluginJsonValueV2Schema }));

export const MachineSetupUpdatesApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), scope: z.enum(['security', 'all']), plan: MachineSetupEffectPlanV1Schema,
}).check(z.refine(input => input.plan.basis.kind === 'updates' && input.plan.basis.machineId === input.machineId
  && input.plan.basis.scope === input.scope, { message: 'Updates require the exact reviewed target and scope.' })));
export type MachineSetupUpdatesApplyInputV1 = z.infer<typeof MachineSetupUpdatesApplyInputV1Schema>;
export const MachineSetupRemoveInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), sources: MachineSetupSourceV1Schema,
  desiredRevision: revision(), removeItemKeys: removalKeys(), removalPlans: z.array(MachineSetupRemovalPlanV1Schema),
  exclusions: z.optional(MachineSetupExclusionsV1Schema),
}));
export const MachineSetupApplyResultV1Schema = lazyZodSchema(() => z.strictObject({ operationId: id(), terminalId: mini.optional(id()), runId: mini.optional(id()) }));
export const ManagedMachineActionInputSchemasV1 = {
'machines.environment.apply': MachineEnvironmentApplyInputV1Schema,

  'machines.provisioners.list': ProvisionersListInputV1Schema,
  'machines.provisioners.check': ProvisionerProbeInputV1Schema,
  'machines.provisioners.options': ProvisionerOptionsInputV1Schema,
  'machines.managed.acquire': ManagedAcquireInputV1Schema,
  'machines.managed.credentials.install': ManagedCredentialInstallInputV1Schema,
  'machines.managed.list': ManagedListInputV1Schema,
  'machines.managed.get': ManagedGetInputV1Schema,
  'machines.managed.references.get': ManagedGetInputV1Schema,
  'machines.managed.inspect': ManagedGetInputV1Schema,
  'machines.managed.bootstrap.retry': ManagedMutationInputV1Schema,
  'machines.managed.setup.skip': ManagedMutationInputV1Schema,
  'machines.setup.plan': lazyZodSchema(() => z.union([MachineSetupPlanInputV1Schema, MachineSetupCombinedPlanInputV1Schema])),
  'machines.setup.apply': MachineSetupApplyInputV1Schema,
  'machines.setup.remove': MachineSetupRemoveInputV1Schema,
  'machines.setup.updates.apply': MachineSetupUpdatesApplyInputV1Schema,
  'machines.managed.cancel': ManagedCancelInputV1Schema,
  'machines.managed.power.set': ManagedPowerInputV1Schema,
  'machines.managed.rebuild': ManagedRebuildInputV1Schema,
  'machines.managed.retention.update': ManagedRetentionUpdateInputV1Schema,
  'machines.managed.delete': ManagedDeleteInputV1Schema,
  'machines.managed.controller.update': ManagedControllerUpdateInputV1Schema,
  'machines.managed.retire': ManagedRetireInputV1Schema,
} as const;
export const ManagedMachineActionOutputSchemasV1 = {
'machines.environment.apply': MachineEnvironmentApplyResultV1Schema,

  'machines.provisioners.list': lazyZodSchema(() => z.lazy(() => MachineProvisionersListResultV1Schema)),
  'machines.provisioners.check': lazyZodSchema(() => z.lazy(() => MachineProvisionerCheckResultV1Schema)),
  'machines.provisioners.options': lazyZodSchema(() => z.lazy(() => MachineProvisionerOptionsResultV1Schema)),
  'machines.managed.acquire': ManagedAcceptedV1Schema,
  'machines.managed.credentials.install': ManagedCredentialDeliveryResultV1Schema,
  'machines.managed.list': ManagedListOutputV1Schema,
  'machines.managed.get': ManagedGetOutputV1Schema,
  'machines.managed.references.get': lazyZodSchema(() => z.lazy(() => MachineReferenceCensusV1Schema)),
  'machines.managed.inspect': ManagedInspectOutputV1Schema,
  'machines.managed.bootstrap.retry': ManagedAcceptedV1Schema,
  'machines.managed.setup.skip': ManagedGetOutputV1Schema,
  'machines.setup.plan': lazyZodSchema(() => z.union([MachineSetupPlanResultV1Schema, MachineSetupCombinedPlanResultV1Schema])),
  'machines.setup.apply': MachineSetupApplyResultV1Schema,
  'machines.setup.remove': MachineSetupApplyResultV1Schema,
  'machines.setup.updates.apply': MachineSetupApplyResultV1Schema,
  'machines.managed.cancel': ManagedCancelOutputV1Schema,
  'machines.managed.power.set': lazyZodSchema(() => z.lazy(() => ManagedIntentResultSchema)),
  'machines.managed.rebuild': lazyZodSchema(() => z.lazy(() => ManagedIntentResultSchema)),
  'machines.managed.retention.update': ManagedGetOutputV1Schema,
  'machines.managed.delete': ManagedDeleteOutputV1Schema,
  'machines.managed.controller.update': ManagedGetOutputV1Schema,
  'machines.managed.retire': ManagedGetOutputV1Schema,
} as const;
export const MANAGED_CONTROL_ACTION_IDS_V1 = ['machines.managed.power.set', 'machines.managed.rebuild', 'machines.managed.retention.update', 'machines.managed.delete', 'machines.managed.controller.update', 'machines.managed.retire'] as const;
export type ManagedControlActionIdV1 = typeof MANAGED_CONTROL_ACTION_IDS_V1[number];
export const ManagedControlAdmissionInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('machines.managed.power.set'), input: ManagedPowerInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.rebuild'), input: ManagedRebuildInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.delete'), input: ManagedDeleteInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.retention.update'), input: ManagedRetentionUpdateInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.controller.update'), input: ManagedControllerUpdateInputV1Schema, requestId: id() }),
  z.strictObject({ action: z.literal('machines.managed.retire'), input: ManagedRetireInputV1Schema, requestId: id() }),
]));
export type ManagedControlAdmissionInputV1 = z.infer<typeof ManagedControlAdmissionInputV1Schema>;
export const ManagedControllerIntentReportV1Schema = lazyZodSchema(() => z.strictObject({ ...current(), result: z.union([asProtocolZod(MachineProvisionerDestroyResultV1Schema), asProtocolZod(MachineProvisionerRebuildResultV1Schema)]), observation: mini.optional(ProviderObservationV1Schema) }));
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

export const MachineSetupCombinedPlanInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), selectedMachineId: z.optional(id()), targets: z.array(MachineSetupPlanInputV1Schema).check(z.minLength(1)),
}).check(z.refine(input => new Set(input.targets.map(target => JSON.stringify([target.homeId, target.machineId]))).size === input.targets.length,
  { message: 'Setup targets must be unique.' })));

const removalKeys = () => z.array(id()).check(z.refine(keys => new Set(keys).size === keys.length));

export const MachineSetupPlanInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), sources: z.optional(MachineSetupSourceV1Schema),
  exclusions: z.optional(MachineSetupExclusionsV1Schema), removeItemKeys: z.optional(removalKeys()),
  mode: z.optional(z.enum(['check', 'effects'])),
  appChildren: z.optional(z.array(MachineSetupAppChildV1Schema)),
  updates: z.optional(z.strictObject({ scope: z.enum(['security', 'all']) })),
}).check(z.refine(input => input.updates === undefined || input.sources === undefined && input.exclusions === undefined
  && input.removeItemKeys === undefined && input.appChildren === undefined,
{ message: 'Updates cannot include setup source changes or app operands.' })));


export const MachineSetupPlanResultV1Schema = lazyZodSchema(() => z.strictObject({
  desiredRevision: revision(), sources: MachineSetupSourceV1Schema, exclusions: z.array(MachineSetupExclusionV1Schema),
  sourceFacts: z.optional(MachineSetupSourceFactsMapV1Schema),
  appOrigins: z.optional(z.array(MachineSetupAppOriginV1Schema)),
  removeItemKeys: z.optional(removalKeys()), removalOffers: z.optional(z.array(MachineSetupRemovalOfferV1Schema)),
  removalPlans: z.optional(z.array(MachineSetupRemovalPlanV1Schema)),
  /** Presentation only: exact referenced declarations already read by this target Plan. */
  recipeTitles: z.optional(z.array(z.strictObject({ ref: MachineRecipeReferenceV1Schema, title: PluginLocalizedStringV2Schema }))),
  support: z.array(z.strictObject({ sourceIndex: revision(), itemIndex: revision(),
    status: MachineSetupObservationStatusV1Schema, reason: z.optional(MachineSetupObservationReasonV1Schema) })),
  recipePlans: z.optional(z.array(MachineSetupRecipePlanV1Schema)),
  appChildren: z.optional(z.array(MachineSetupAppChildV1Schema)),
  appReviews: z.optional(z.array(MachineSetupAppReviewV1Schema)),
  review: z.optional(MachineSetupPlanReviewV1Schema),
  updates: z.optional(z.strictObject({ observation: MachineSetupUpdatesObservationV1Schema, plan: z.optional(MachineSetupEffectPlanV1Schema) })),
}));

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

export const MachineSetupRemovalPlanV1Schema = lazyZodSchema(() => z.strictObject({
  itemKey: id(), plan: MachineSetupEffectPlanV1Schema,
}));

export const MachineSetupAppReviewV1Schema = lazyZodSchema(() => z.strictObject({
  sourceIndex: revision(), itemIndex: revision(), actionId: z.literal('deployments.templates.instantiate'),
  review: DeploymentTemplateInstantiationReviewV1Schema,
}));

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
  downtime: z.enum(['none', 'possible', 'unknown']),
  requiresSessionRefresh: z.optional(MachineSetupSessionRefreshV1Schema),
  apps: z.optional(z.array(z.strictObject({ sourceIndex: revision(), itemIndex: revision(),
    kind: z.enum(['new', 'completed', 'not_completed', 'failed', 'unknown']), environmentId: z.optional(id()),
  }))),
  host: z.optional(WorkflowCombinedActionHostReviewV1Schema),
}));

export type MachineSetupPlanInputV1 = z.infer<typeof MachineSetupPlanInputV1Schema>;

export type MachineSetupPlanResultV1 = z.infer<typeof MachineSetupPlanResultV1Schema>;

export type MachineSetupRemovalOfferV1 = z.infer<typeof MachineSetupRemovalOfferV1Schema>;

export type MachineSetupRemovalPlanV1 = z.infer<typeof MachineSetupRemovalPlanV1Schema>;

export const MachineSetupCombinedPlanResultV1Schema = lazyZodSchema(() => z.strictObject({
  targets: z.array(z.union([z.strictObject({ homeId: id(), machineId: id(), plan: MachineSetupPlanResultV1Schema,
    appChildren: z.optional(z.array(MachineSetupAppChildV1Schema)) }), MachineSetupPlanUnavailableTargetV1Schema])).check(
      z.refine(targets => new Set(targets.map(target => JSON.stringify([target.homeId, target.machineId]))).size === targets.length,
        { message: 'Each selected setup target has one result.' })),
  review: WorkflowCombinedActionHostReviewV1Schema,
}));

export const MachineSetupPlanUnavailableTargetV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), status: z.literal('unavailable'), reason: z.literal('offline'), errorCode: z.literal('machine_offline'),
}));
export type MachineSetupPlanUnavailableTargetV1 = z.infer<typeof MachineSetupPlanUnavailableTargetV1Schema>;

export type MachineSetupCombinedPlanResultV1 = z.infer<typeof MachineSetupCombinedPlanResultV1Schema>;

export type MachineSetupPlanReviewV1 = z.infer<typeof MachineSetupPlanReviewV1Schema>;

export * from './credentialDeliveryV1.js';

export type MachineSetupCombinedPlanInputV1 = z.infer<typeof MachineSetupCombinedPlanInputV1Schema>;

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

export const MachineSetupResolveResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ sources: MachineSetupSourceV1Schema, creation: z.optional(MachineSetupCreationOriginV1Schema) }),
  z.strictObject({ purpose: z.literal('creationOrigin'), creation: z.optional(MachineSetupCreationOriginV1Schema) }),
]));

const MachineSetupCreationOriginV1Schema = lazyZodSchema(() => z.strictObject({ managedId: id(),
  preset: z.strictObject({ id: id(), revision: revision() }),
}));

export const MachineSetupReportInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineSetupPresetApplyInputV1Schema, {
  managedId: id(), state: z.enum(['running', 'succeeded', 'failed']),
  operation: z.strictObject({ operationId: id() }), errorCode: z.optional(z.string().check(z.minLength(1))),
})));

export const MachineSetupPresetApplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), machineId: id(), presetId: id(), presetRevision: revision(),
}));

export type MachineSetupRemoveInputV1 = z.infer<typeof MachineSetupRemoveInputV1Schema>;

export type MachineSetupAppReviewV1 = z.infer<typeof MachineSetupAppReviewV1Schema>;

export { isMachineSetupPlanRpcChildV1 } from './actionIdsV1.js';

export { ManagedInstallationServerOriginV1Schema } from './managedInstallationV1.js';

export { ManagedTerminalPairingContextV1Schema } from './managedInstallationV1.js';

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
