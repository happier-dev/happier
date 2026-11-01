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
import { DevcontainerRebuildIntentV1Schema, ManagedIntentInputSchema, ManagedIntentResultSchema, ManagedActivityReadRequestV1Schema } from './managedIntentV1.js';
import { MachineInstallationProofV1Schema } from '../identity/installationIdentity.js';
import { SocketRpcMachineAdmissionContextV1Schema } from '../machineAccessV1.js';
import { MachineProvisionerDestroyResultV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerRebuildResultV1Schema } from '../../plugins/contributions/machineProvisioners.js';
import { MachineReferenceCensusV1Schema } from '../machineReferenceCensusV1.js';
import { MachineEnvironmentV1Schema } from './machineEnvironmentV1.js';
export { MANAGED_MACHINE_ACTION_IDS_V1, type ManagedMachineActionIdV1 } from './actionIdsV1.js';

const id = () => mini.string().check(mini.trim(), mini.minLength(1));
const revision = () => mini.int().check(mini.gte(0));
export const ManagedMachineActionIdV1Schema = lazyDefinition(() => mini.enum(MANAGED_MACHINE_ACTION_IDS_V1));
const target = () => ({ homeId: id(), managedId: id() });
const current = () => ({ ...target(), expectedIntentRevision: revision(), requestId: id(), controller: ManagedControllerV1Schema });
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
  z.strictObject({ selection: ManagedOneOffSelectionV1Schema, agentStart: z.optional(ManagedAcquireAgentStartV1Schema),
    reviewedFacts: z.optional(ManagedConfigurationFactsV1Schema) }),
  z.strictObject({ selection: ManagedPresetSelectionV1Schema, controller: ManagedControllerV1Schema,
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
export const ManagedListInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), archived: mini.optional(mini.boolean()) }));
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
export const ManagedControllerUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision(), controller: ManagedControllerV1Schema, reviewedPendingEffects: z.literal(true) }));
export const ManagedRetireInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision(), manualResponsibility: z.literal(true) }));
export const ManagedCancelInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision() }));
export const ManagedInspectOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, operation: z.optional(ActionOperationGetV1RequestSchema) }));
export const ManagedCancelOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, operation: z.optional(ActionOperationGetV1RequestSchema) }));
export const ManagedErrorV1Schema = lazyZodSchema(() => z.strictObject({ code: ManagedRefusalCodeV1Schema }));
export const ManagedControllerCurrentnessV1Schema = lazyZodSchema(() => z.strictObject(current()));
export const ManagedControllerCurrentInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ManagedControllerCurrentnessV1Schema, { nativeRole: z.optional(z.literal('inspect')) })));
export const ManagedGuestCurrentInputV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1),
  context: SocketRpcMachineAdmissionContextV1Schema, method: z.string().check(z.minLength(1)),
  managedTarget: z.lazy(() => ManagedActivityReadRequestV1Schema), proof: MachineInstallationProofV1Schema,
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
export const ManagedEnrollmentCorrelationV1Schema = lazyZodSchema(() => z.strictObject({ ...current(), resource: ManagedResourceV1Schema }));
/** Controller admission never receives ordinary composer text or startup instructions. */
export const ManagedAdmissionComputeInputV1Schema = lazyZodSchema(() => z.union([
  z.omit(ManagedAcquireInputV1Schema._zod.def.options[0], { agentStart: true }),
  z.omit(ManagedAcquireInputV1Schema._zod.def.options[1], { agentStart: true }),
]));
export const ManagedAdmissionInputV1Schema = lazyZodSchema(() => z.strictObject({ input: ManagedAdmissionComputeInputV1Schema, requestId: id(), continuationPresent: mini.boolean() }));
export const ManagedAdmissionOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, replayed: mini.boolean() }));
export const ManagedControllerContextInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), expectedIntentRevision: revision(), controller: ManagedControllerV1Schema }));
export const ManagedControllerContextOutputV1Schema = lazyZodSchema(() => z.strictObject({ machine: ManagedMachineV1Schema, requestId: id() }));
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

export const ManagedMachineActionInputSchemasV1 = {
  'machines.provisioners.list': ProvisionersListInputV1Schema,
  'machines.provisioners.check': ProvisionerProbeInputV1Schema,
  'machines.provisioners.options': ProvisionerOptionsInputV1Schema,
  'machines.managed.acquire': ManagedAcquireInputV1Schema,
  'machines.managed.list': ManagedListInputV1Schema,
  'machines.managed.get': ManagedGetInputV1Schema,
  'machines.managed.references.get': ManagedGetInputV1Schema,
  'machines.managed.inspect': ManagedGetInputV1Schema,
  'machines.managed.bootstrap.retry': ManagedMutationInputV1Schema,
  'machines.managed.setup.skip': ManagedMutationInputV1Schema,
  'machines.environment.apply': MachineEnvironmentApplyInputV1Schema,
  'machines.managed.cancel': ManagedCancelInputV1Schema,
  'machines.managed.power.set': ManagedPowerInputV1Schema,
  'machines.managed.rebuild': ManagedRebuildInputV1Schema,
  'machines.managed.retention.update': ManagedRetentionUpdateInputV1Schema,
  'machines.managed.delete': ManagedDeleteInputV1Schema,
  'machines.managed.controller.update': ManagedControllerUpdateInputV1Schema,
  'machines.managed.retire': ManagedRetireInputV1Schema,
} as const;
export const ManagedMachineActionOutputSchemasV1 = {
  'machines.provisioners.list': MachineProvisionersListResultV1Schema,
  'machines.provisioners.check': lazyZodSchema(() => z.lazy(() => MachineProvisionerCheckResultV1Schema)),
  'machines.provisioners.options': lazyZodSchema(() => z.lazy(() => MachineProvisionerOptionsResultV1Schema)),
  'machines.managed.acquire': ManagedAcceptedV1Schema,
  'machines.managed.list': ManagedListOutputV1Schema,
  'machines.managed.get': ManagedGetOutputV1Schema,
  'machines.managed.references.get': lazyZodSchema(() => z.lazy(() => MachineReferenceCensusV1Schema)),
  'machines.managed.inspect': ManagedInspectOutputV1Schema,
  'machines.managed.bootstrap.retry': ManagedAcceptedV1Schema,
  'machines.managed.setup.skip': ManagedGetOutputV1Schema,
  'machines.environment.apply': MachineEnvironmentApplyResultV1Schema,
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
