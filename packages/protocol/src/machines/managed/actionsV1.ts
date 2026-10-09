import { z } from 'zod';
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
import { MachineProvisionerPowerResultV1Schema, MachineProvisionerRebuildResultV1Schema } from '../../plugins/contributions/machineProvisioners.js';
import { MachineReferenceCensusV1Schema } from '../machineReferenceCensusV1.js';
export { MANAGED_MACHINE_ACTION_IDS_V1, type ManagedMachineActionIdV1 } from './actionIdsV1.js';

const id = () => mini.string().check(mini.trim(), mini.minLength(1));
const revision = () => mini.int().check(mini.gte(0));
export const ManagedMachineActionIdV1Schema = lazyDefinition(() => mini.enum(MANAGED_MACHINE_ACTION_IDS_V1));
const target = () => ({ homeId: id(), managedId: id() });
const current = () => ({ ...target(), expectedIntentRevision: revision(), requestId: id(), controller: ManagedControllerV1Schema });

// Classic roots are the actual public Action-spec consumer seam. Internal
// fields remain one Mini tree; stored projections derive from these owners.
export const ManagedAcquireInputV1Schema = lazyZodSchema(() => z.union([
  z.object({ selection: ManagedOneOffSelectionV1Schema, agentStart: ManagedAcquireAgentStartV1Schema.optional(),
    reviewedFacts: ManagedConfigurationFactsV1Schema.optional() }).strict(),
  z.object({ selection: ManagedPresetSelectionV1Schema, controller: ManagedControllerV1Schema,
    retention: RetentionV1Schema, wakeOnAcceptedMessage: mini.boolean(),
    agentStart: ManagedAcquireAgentStartV1Schema.optional(), reviewedFacts: ManagedConfigurationFactsV1Schema.optional() }).strict(),
]));
/** One-off effects live in the selection; preset requests carry the separately reviewed policy. */
export function resolveManagedAcquireReviewV1(input: ManagedAcquireInputV1) {
  if ('controller' in input) return { homeId: input.selection.homeId, controller: input.controller,
    retention: input.retention, wakeOnAcceptedMessage: input.wakeOnAcceptedMessage };
  return { homeId: input.selection.homeId, controller: input.selection.controller,
    retention: input.selection.retention, wakeOnAcceptedMessage: input.selection.wakeOnAcceptedMessage };
}
export const ManagedAcceptedV1Schema = lazyZodSchema(() => z.object({ managedId: id(), operation: ActionOperationGetV1RequestSchema.optional() }).strict());
export const ManagedListInputV1Schema = lazyZodSchema(() => z.object({ homeId: id(), archived: mini.optional(mini.boolean()) }).strict());
export const ManagedListOutputV1Schema = lazyZodSchema(() => z.object({ machines: mini.array(ManagedMachineV1Schema) }).strict());
export const ManagedGetOutputV1Schema = lazyZodSchema(() => z.lazy(() => ManagedMachineV1Schema));
export const ManagedGetInputV1Schema = lazyZodSchema(() => z.object(target()).strict());
export const ManagedMutationInputV1Schema = lazyZodSchema(() => z.object({ ...target(), expectedIntentRevision: revision() }).strict());
export const ManagedRebuildInputV1Schema = lazyZodSchema(() => z.object({ homeId: id(), ...DevcontainerRebuildIntentV1Schema.def.shape }).strict());
export const ManagedPowerInputV1Schema = lazyZodSchema(() => z.union([
  z.object({ ...ManagedIntentInputSchema.def.options[0].def.shape, intent: z.enum(['start', 'stop', 'suspend', 'resume']) }).strict(),
  z.object({ ...ManagedIntentInputSchema.def.options[1].def.shape, intent: z.literal('stop') }).strict(),
]));
export const ManagedDeleteInputV1Schema = lazyZodSchema(() => z.union([
  z.object({ ...ManagedIntentInputSchema.def.options[0].def.shape, intent: z.literal('delete'), reviewedDependencies: z.literal(true) }).strict(),
  z.object({ ...ManagedIntentInputSchema.def.options[1].def.shape, intent: z.literal('delete'), reviewedDependencies: z.literal(true) }).strict(),
]));
/** Delete discloses its captured census on every semantic outcome; native intent facts stay unchanged. */
export const ManagedDeleteOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ ...ManagedIntentResultSchema.def.options[0].def.shape, machineReferences: MachineReferenceCensusV1Schema }).strict(),
  z.object({ ...ManagedIntentResultSchema.def.options[1].def.shape, machineReferences: MachineReferenceCensusV1Schema }).strict(),
  z.object({ ...ManagedIntentResultSchema.def.options[2].def.shape, machineReferences: MachineReferenceCensusV1Schema }).strict(),
]));
export const ManagedRetentionUpdateInputV1Schema = lazyZodSchema(() => z.object({ ...target(), expectedIntentRevision: revision(), retention: RetentionV1Schema, wakeOnAcceptedMessage: mini.boolean() }).strict());
export const ManagedControllerUpdateInputV1Schema = lazyZodSchema(() => z.object({ ...target(), expectedIntentRevision: revision(), controller: ManagedControllerV1Schema, reviewedPendingEffects: z.literal(true) }).strict());
export const ManagedRetireInputV1Schema = lazyZodSchema(() => z.object({ ...target(), expectedIntentRevision: revision(), manualResponsibility: z.literal(true) }).strict());
export const ManagedCancelInputV1Schema = lazyZodSchema(() => z.object({ ...target(), expectedIntentRevision: revision() }).strict());
export const ManagedInspectOutputV1Schema = lazyZodSchema(() => z.object({ machine: ManagedMachineV1Schema, operation: ActionOperationGetV1RequestSchema.optional() }).strict());
export const ManagedCancelOutputV1Schema = lazyZodSchema(() => z.object({ machine: ManagedMachineV1Schema, operation: ActionOperationGetV1RequestSchema.optional() }).strict());
export const ManagedErrorV1Schema = lazyZodSchema(() => z.object({ code: ManagedRefusalCodeV1Schema }).strict());
export const ManagedControllerCurrentnessV1Schema = lazyZodSchema(() => z.object(current()).strict());
export const ManagedControllerCurrentInputV1Schema = lazyZodSchema(() => ManagedControllerCurrentnessV1Schema.extend({ nativeRole: z.literal('inspect').optional() }).strict());
export const ManagedGuestCurrentInputV1Schema = lazyZodSchema(() => z.object({ v: z.literal(1),
  context: SocketRpcMachineAdmissionContextV1Schema, method: z.string().min(1),
  managedTarget: z.lazy(() => ManagedActivityReadRequestV1Schema), proof: MachineInstallationProofV1Schema,
}).strict());
export const ManagedGuestCurrentOutputV1Schema = lazyZodSchema(() => z.object({ current: z.boolean() }).strict());
/** Signed only by the current guest after its real admission drain commits idle. */
export const ManagedCommittedIdleEvidenceV1Schema = lazyZodSchema(() => z.object({
  context: SocketRpcMachineAdmissionContextV1Schema, method: z.string().min(1),
  managedTarget: z.lazy(() => ManagedActivityReadRequestV1Schema),
  decision: z.object({ kind: z.literal('idle'), since: z.number().nonnegative(), confirmedAt: z.number().nonnegative() }).strict(),
  proof: MachineInstallationProofV1Schema,
}).strict());
export type ManagedCommittedIdleEvidenceV1 = z.infer<typeof ManagedCommittedIdleEvidenceV1Schema>;
export const ManagedControllerReportV1Schema = lazyZodSchema(() => z.object({ ...current(), result: AcquireResultV1Schema, observation: mini.optional(ProviderObservationV1Schema) }).strict());
export const ManagedEnrollmentCorrelationV1Schema = lazyZodSchema(() => z.object({ ...current(), resource: ManagedResourceV1Schema }).strict());
/** Controller admission never receives ordinary composer text or startup instructions. */
export const ManagedAdmissionComputeInputV1Schema = lazyZodSchema(() => z.union([
  ManagedAcquireInputV1Schema.options[0].omit({ agentStart: true }),
  ManagedAcquireInputV1Schema.options[1].omit({ agentStart: true }),
]));
export const ManagedAdmissionInputV1Schema = lazyZodSchema(() => z.object({ input: ManagedAdmissionComputeInputV1Schema, requestId: id(), continuationPresent: mini.boolean() }).strict());
export const ManagedAdmissionOutputV1Schema = lazyZodSchema(() => z.object({ machine: ManagedMachineV1Schema, replayed: mini.boolean() }).strict());
export const ManagedControllerContextInputV1Schema = lazyZodSchema(() => z.object({ ...target(), expectedIntentRevision: revision(), controller: ManagedControllerV1Schema }).strict());
export const ManagedControllerContextOutputV1Schema = lazyZodSchema(() => z.object({ machine: ManagedMachineV1Schema, requestId: id() }).strict());
export const ManagedControllerMachineOutputV1Schema = lazyZodSchema(() => z.object({ machine: ManagedMachineV1Schema }).strict());
export const ManagedControllerSubmitOutputV1Schema = lazyZodSchema(() => z.object({ machine: ManagedMachineV1Schema, submitted: mini.boolean() }).strict());
/** Only the admitted controller captures this source-owned metadata before native spend. */
export const ManagedControllerSubmitInputV1Schema = lazyZodSchema(() => z.object({ ...current(),
  credentials: mini.optional(RetainedManagedCredentialSelectionsV1Schema),
}).strict());
export const ManagedBootstrapCredentialCreateV1Schema = lazyZodSchema(() => z.object({ ...current(), credential: SharedSavedSecretCreateInputV1Schema }).strict());

export const ProvisionersListInputV1Schema = lazyZodSchema(() => z.object({ homeId: id(), controller: mini.optional(ManagedControllerV1Schema) }).strict());
export const ProvisionerProbeInputV1Schema = lazyZodSchema(() => z.object({ homeId: id(), controller: ManagedControllerV1Schema, contribution: asProtocolZod(PluginContributionIdentityV1Schema), credentials: mini.optional(ManagedCredentialSelectionsV1Schema) }).strict());
export const ProvisionerOptionsInputV1Schema = lazyZodSchema(() => z.object({ homeId: id(), controller: ManagedControllerV1Schema, contribution: asProtocolZod(PluginContributionIdentityV1Schema), credentials: mini.optional(ManagedCredentialSelectionsV1Schema), selectors: PluginJsonValueV2Schema }).strict());

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
  z.object({ action: z.literal('machines.managed.power.set'), input: ManagedPowerInputV1Schema, requestId: id() }).strict(),
  z.object({ action: z.literal('machines.managed.rebuild'), input: ManagedRebuildInputV1Schema, requestId: id() }).strict(),
  z.object({ action: z.literal('machines.managed.delete'), input: ManagedDeleteInputV1Schema, requestId: id() }).strict(),
  z.object({ action: z.literal('machines.managed.retention.update'), input: ManagedRetentionUpdateInputV1Schema, requestId: id() }).strict(),
  z.object({ action: z.literal('machines.managed.controller.update'), input: ManagedControllerUpdateInputV1Schema, requestId: id() }).strict(),
  z.object({ action: z.literal('machines.managed.retire'), input: ManagedRetireInputV1Schema, requestId: id() }).strict(),
]));
export type ManagedControlAdmissionInputV1 = z.infer<typeof ManagedControlAdmissionInputV1Schema>;
export const ManagedControllerIntentReportV1Schema = lazyZodSchema(() => z.object({ ...current(), result: z.union([asProtocolZod(MachineProvisionerPowerResultV1Schema), asProtocolZod(MachineProvisionerRebuildResultV1Schema)]), observation: mini.optional(ProviderObservationV1Schema) }).strict());
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
