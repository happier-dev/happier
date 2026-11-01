import { z } from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { ActionOperationAddressV1Schema } from '../actions/operations/addressV1.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { MachineInstallationProofV1Schema } from '../machines/identity/installationKeySchemas.js';
import { ProjectSourceOwnerV1Schema, ProjectSourcesListInputV1Schema } from '../projects/sources/projectSourceV1.js';
import { ArtifactJsonUpdateHttpInputV1Schema } from '../artifacts/artifactMutationHttpV1.js';
import { ArtifactQuotaExceededV1Schema } from '../artifacts/artifactActionsV1.js';
import type { DeploymentTransportActionIdV1 } from './deploymentActionIdsV1.js';
import { DeploymentEnvironmentRefV1Schema } from './deploymentEnvironmentRefV1.js';
import { DeploymentDeployIntentInputV1Schema } from './deploymentDeployIntentV1.js';
export { DeploymentDeployIntentInputV1Schema, type DeploymentDeployIntentInputV1 } from './deploymentDeployIntentV1.js';
export { DeploymentDeploySemanticInputV1Schema, type DeploymentDeploySemanticInputV1 } from './deploymentDeployIntentV1.js';
export { DeploymentEnvironmentRefV1Schema, type DeploymentEnvironmentRefV1 } from './deploymentEnvironmentRefV1.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema, DeploymentTimestampV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
export { DeploymentDomainHeaderV1Schema, DeploymentDomainStateV1Schema,
  type DeploymentDomainHeaderV1 } from './deploymentDomainV1.js';
import { DeploymentAcceptedExecutionV1Schema } from './deploymentAcceptedExecutionV1.js';
import { DeploymentPendingAdmissionV1Schema } from './deploymentPendingAdmissionV1.js';
export { DeploymentPendingAdmissionV1Schema, type DeploymentPendingAdmissionV1 } from './deploymentPendingAdmissionV1.js';
export { DeploymentAcceptedExecutionV1Schema, type DeploymentAcceptedExecutionV1 } from './deploymentAcceptedExecutionV1.js';
import { DeploymentEnvironmentDeployerPrincipalsV1Schema } from './deploymentEnvironmentDeployerV1.js';
export { DeploymentEnvironmentDeployerPrincipalV1Schema, DeploymentEnvironmentDeployerPrincipalsV1Schema, type DeploymentEnvironmentDeployerPrincipalV1 } from './deploymentEnvironmentDeployerV1.js';
import { DeploymentPendingDeployV1Schema, EnvironmentSecretBindingInputV1Schema,
  EnvironmentSecretBindingIdentityV1Schema, environmentSecretBindingIdentityV1 } from './storedAppInputV1.js';
import { DeploymentStoredDefinitionInputV1Schema, DeploymentTextV1Schema } from './storedAppInputV1.js';
import { DeploymentRetainPreviousDeploymentsV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { DeploymentRepositoryComposeV1Schema, DeploymentStoredDefinitionV1Schema, DeploymentSourceMethodV1Schema,
  DeploymentSourceIntentV1Schema } from './storedAppInputV1.js';
import { ProjectSourcesCreateInputV1Schema } from '../projects/sources/projectSourceV1.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';
import { ProjectAccountWorkspaceRefKeyV1Schema } from '../projects/workspaceRefKeyV1.js';
import { ManagedAcquireInputV1Schema, ManagedRetentionUpdateInputV1Schema, MachineSetupApplyInputV1Schema } from '../machines/managed/actionsV1.js';
import { DeploymentPrepareInputV1Schema, DeploymentPrepareResultV1Schema, DeploymentPublishResultV1Schema } from './deploymentPreparationV1.js';
import { DeploymentTemplateInstantiateInputV1Schema, DeploymentTemplateInstantiateResultV1Schema,
  DeploymentTemplateInstantiationReviewV1Schema } from './deploymentTemplateInstantiationV1.js';
import { DeploymentPublishPrepareInputV1Schema, DeploymentPublishPrepareResultV1Schema } from './deploymentPublishPreparationV1.js';
export * from './deploymentPublishPreparationV1.js';
import { DeploymentHealthReadInputV1Schema, DeploymentDriftReadInputV1Schema, DeploymentLogsReadInputV1Schema,
  DeploymentHealthReadSuccessV1Schema, DeploymentDriftReadSuccessV1Schema, DeploymentLogsReadSuccessV1Schema } from './deploymentReadsV1.js';
export * from './deploymentReadsV1.js';
export * from './deploymentPreparationV1.js';
export * from './deploymentPreviewProvenanceV1.js';
export { DeploymentSourceIntentV1ProtocolSchema, type DeploymentSourceIntentV1 } from './storedAppInputV1.js';
export { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '../artifacts/deploymentArtifactKindsV1.js';
export * from './deploymentTemplateInstantiationV1.js';
export { DeploymentArtifactContentReferenceV1Schema, readDeploymentArtifactHeaderV1, readDeploymentArtifactJsonBodyV1,
  type DeploymentArtifactContentReferenceV1, type OpenedDeploymentArtifactV1, type DeploymentArtifactReadFailureV1 } from './deploymentArtifactContentReferenceV1.js';
export { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema, DeploymentTimestampV1Schema } from './deploymentIdentifiersV1.js';
export { DEPLOYMENT_ACTION_IDS_V1, isDeploymentActionIdV1, type DeploymentActionIdV1, type DeploymentTransportActionIdV1 } from './deploymentActionIdsV1.js';

/** Storage transport leaves. Private deployment records remain deployment-protocol owned. */
export const DeploymentStateV1Schema = lazyZodSchema(() => z.enum([
  'queued', 'waitingApproval', 'running', 'running_unverified', 'succeeded', 'failed', 'cancelled', 'outcome_unknown',
]));
export const DeploymentEnvironmentOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account'), accountId: DeploymentIdentifierV1Schema }),
  z.strictObject({ kind: z.literal('team'), teamId: DeploymentIdentifierV1Schema }),
]));
export const DeploymentEnvironmentCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
  role: z.enum(['reader', 'deployer', 'manager']), read: z.boolean(), deploy: z.boolean(), manage: z.boolean(),
  manageBindings: z.boolean(), manageTargets: z.boolean(), delete: z.boolean(),
}));
/** Multi-server ingress intent. Source/placement admission validates the referenced edge. */
export const DeploymentIngressV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cloudflareTunnel') }),
  z.strictObject({ kind: z.literal('edgeCaddy'), edgeMachineId: DeploymentIdentifierV1Schema }),
]));
export type DeploymentIngressV1 = z.infer<typeof DeploymentIngressV1Schema>;
/** The live four-part preview key uses MySQL VARCHAR(191) columns within its 3072-byte utf8mb4 index budget. */
const deploymentPreviewPullRequestIdV1Schema = lazyZodSchema(() => DeploymentIdentifierV1Schema.check(
  z.refine(value => Array.from(value).length <= 191,
    { message: 'Preview pull request identity exceeds its portable storage character boundary.' }),
));
/** Preview relation validation is shared by transport headers and opened Environment records. */
export function hasCompleteDeploymentPreviewRelationV1(environment: Readonly<{
  purpose: 'standard' | 'preview'; previewTemplateEnvironmentId?: string | undefined; previewRepositoryId?: string | undefined;
  previewPullRequestId?: string | undefined; previewTargetLinkId?: string | undefined;
}>): boolean {
  const relations = [environment.previewTemplateEnvironmentId, environment.previewRepositoryId,
    environment.previewPullRequestId, environment.previewTargetLinkId];
  return environment.purpose === 'standard' ? relations.every(value => value === undefined)
    : relations.every(value => value !== undefined);
}
export const DeploymentEnvironmentHeaderV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), id: DeploymentIdentifierV1Schema, serverId: DeploymentIdentifierV1Schema,
  projectSourceId: DeploymentIdentifierV1Schema, revision: DeploymentRevisionV1Schema,
  owner: DeploymentEnvironmentOwnerV1Schema, protection: z.enum(['production', 'nonProduction']),
  purpose: z.enum(['standard', 'preview']), deployerMode: z.enum(['managers', 'members', 'chosen']),
  deployerPrincipals: z.optional(DeploymentEnvironmentDeployerPrincipalsV1Schema),
  controllerMachineId: DeploymentIdentifierV1Schema, buildMachineId: z.optional(DeploymentIdentifierV1Schema),
  ingress: z.optional(DeploymentIngressV1Schema),
  runtimeTargetLinkId: z.optional(DeploymentIdentifierV1Schema),
  previewTemplateEnvironmentId: z.optional(DeploymentIdentifierV1Schema),
  previewRepositoryId: z.optional(DeploymentIdentifierV1Schema),
  previewPullRequestId: z.optional(deploymentPreviewPullRequestIdV1Schema),
  previewTargetLinkId: z.optional(DeploymentIdentifierV1Schema),
  ...DeploymentArtifactContentReferenceV1Schema.shape, capabilities: DeploymentEnvironmentCapabilitiesV1Schema,
  createdByAccountId: DeploymentIdentifierV1Schema,
  createdAtMs: DeploymentTimestampV1Schema, updatedAtMs: DeploymentTimestampV1Schema,
  deletedAtMs: z.optional(DeploymentTimestampV1Schema),
}).check(z.refine(hasCompleteDeploymentPreviewRelationV1,
  { message: 'Preview relationships are complete and absent on standard Environments.' })));
export const DeploymentReceiptMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), id: DeploymentIdentifierV1Schema, environmentId: DeploymentIdentifierV1Schema,
  targetLinkId: DeploymentIdentifierV1Schema, revision: DeploymentRevisionV1Schema,
  operation: z.enum(['deploy', 'rollback', 'promote', 'teardown']), state: DeploymentStateV1Schema,
  requestKey: DeploymentIdentifierV1Schema, requestedByAccountId: DeploymentIdentifierV1Schema,
  actionOperationId: DeploymentIdentifierV1Schema,
  acceptedExecution: z.optional(DeploymentAcceptedExecutionV1Schema),
  predecessorDeploymentId: z.optional(DeploymentIdentifierV1Schema), rollbackOfDeploymentId: z.optional(DeploymentIdentifierV1Schema),
  promotedFromDeploymentId: z.optional(DeploymentIdentifierV1Schema), approvalId: z.optional(DeploymentIdentifierV1Schema),
  cancelRequestedAtMs: z.optional(DeploymentTimestampV1Schema),
  requestedAtMs: DeploymentTimestampV1Schema, startedAtMs: z.optional(DeploymentTimestampV1Schema), settledAtMs: z.optional(DeploymentTimestampV1Schema),
}).check(z.refine(receipt => receipt.state !== 'waitingApproval' || receipt.approvalId !== undefined,
  { message: 'Waiting approval requires the existing Happier approval id.' }),
  z.refine(receipt => (receipt.startedAtMs === undefined || receipt.startedAtMs >= receipt.requestedAtMs)
    && (receipt.settledAtMs === undefined || receipt.settledAtMs >= (receipt.startedAtMs ?? receipt.requestedAtMs))
    && [receipt.predecessorDeploymentId, receipt.rollbackOfDeploymentId, receipt.promotedFromDeploymentId]
      .every(parentId => parentId !== receipt.id),
  { message: 'Receipt chronology and lineage must refer to earlier work.' })));
export const DeploymentReceiptHeaderV1Schema = lazyZodSchema(() => z.extend(DeploymentReceiptMetadataV1Schema,
  DeploymentArtifactContentReferenceV1Schema.shape));
export type DeploymentEnvironmentHeaderV1 = z.infer<typeof DeploymentEnvironmentHeaderV1Schema>;
export type DeploymentReceiptHeaderV1 = z.infer<typeof DeploymentReceiptHeaderV1Schema>;
const home = { serverId: DeploymentIdentifierV1Schema };
const environment = { ...home, environmentId: DeploymentIdentifierV1Schema, expectedRevision: DeploymentRevisionV1Schema };
const intent = { requestKey: DeploymentIdentifierV1Schema };

const deploymentEnvironmentCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, ...intent, ...DeploymentArtifactContentReferenceV1Schema.shape,
  projectSourceId: DeploymentIdentifierV1Schema,
  protection: z.enum(['production', 'nonProduction']), purpose: z.enum(['standard', 'preview']),
  deployerMode: z.enum(['managers', 'members', 'chosen']),
  deployerPrincipals: z.optional(DeploymentEnvironmentDeployerPrincipalsV1Schema),
  controllerMachineId: DeploymentIdentifierV1Schema,
  buildMachineId: z.optional(DeploymentIdentifierV1Schema),
  /** Prepared storage relation only; copying and SCM admission remain host-owned. */
  preview: z.optional(z.strictObject({
    templateEnvironmentId: DeploymentIdentifierV1Schema,
    expectedTemplateRevision: DeploymentRevisionV1Schema,
    pullRequestId: deploymentPreviewPullRequestIdV1Schema,
    runtimeTargetLinkId: DeploymentIdentifierV1Schema,
  })),
  /** The first own-server runtime link shares this create intent and approval. */
  firstTargetLink: z.optional(z.strictObject({
    ...DeploymentArtifactContentReferenceV1Schema.shape,
    machines: DeploymentOwnServerTargetMachinesV1Schema,
  })),
}));
export const DeploymentEnvironmentCreateInputV1Schema = lazyZodSchema(() => deploymentEnvironmentCreateInputV1Schema.check(
  z.refine(input => input.purpose === 'preview' ? input.preview !== undefined : input.preview === undefined,
  { message: 'Only preview children carry a prepared template relationship.' })));
export const DeploymentTargetLinkMachineV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: DeploymentIdentifierV1Schema, installationId: DeploymentIdentifierV1Schema,
}));
const deploymentTargetMachinesV1Schema = lazyZodSchema(() => z.array(DeploymentTargetLinkMachineV1Schema).check(
  z.refine(machines => new Set(machines.map(machine => machine.machineId)).size === machines.length,
    { message: 'Runtime Machines must be unique.' })));
/** Own-server callers retain their nonempty membership contract when other target arms have no members. */
export const DeploymentOwnServerTargetMachinesV1Schema = lazyZodSchema(() => deploymentTargetMachinesV1Schema.check(z.minLength(1)));
/** Authored create is resolved for review by the host; Home still accepts only the prepared CreateInput. */
export const DeploymentEnvironmentCreateIntentInputV1Schema = lazyZodSchema(() => z.extend(z.omit(deploymentEnvironmentCreateInputV1Schema, {
  contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true, firstTargetLink: true,
  controllerMachineId: true, buildMachineId: true,
  preview: true,
}), {
  name: DeploymentTextV1Schema,
  mode: z.optional(z.enum(['preview', 'apply'])),
  definition: z.union([DeploymentStoredDefinitionInputV1Schema,
    z.strictObject({ from: z.literal('repository'), ref: DeploymentTextV1Schema, compose: DeploymentRepositoryComposeV1Schema })]),
  controllerMachineId: z.optional(DeploymentIdentifierV1Schema), buildMachineId: z.optional(DeploymentIdentifierV1Schema),
  retainPreviousDeployments: z.optional(DeploymentRetainPreviousDeploymentsV1Schema),
  firstTargetLink: z.optional(z.strictObject({ machines: DeploymentOwnServerTargetMachinesV1Schema })),
}));
export const DeploymentEnvironmentCreateActionInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema,
]));
/** Content CAS and future build placement share one manager-owned update. */
export const DeploymentEnvironmentUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, ...DeploymentArtifactContentReferenceV1Schema.shape,
  patch: z.optional(z.strictObject({
    buildMachineId: z.optional(DeploymentIdentifierV1Schema),
    protection: z.optional(DeploymentEnvironmentHeaderV1Schema.shape.protection),
    deployerMode: z.optional(z.enum(['managers', 'members', 'chosen'])),
    deployerPrincipals: z.optional(DeploymentEnvironmentDeployerPrincipalsV1Schema),
  })),
}));
/** Manager-owned controller reassignment changes records and future assignments, never workload content. */
export const DeploymentEnvironmentControllerSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, controllerMachineId: DeploymentIdentifierV1Schema,
}));
/** Record-only final disposition. Native cleanup remains the signed teardown owner's effect. */
export const DeploymentTargetUnlinkInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, ...intent,
  targetLinkId: DeploymentIdentifierV1Schema, expectedTargetLinkRevision: DeploymentRevisionV1Schema,
  detachKeepRunning: z.optional(z.boolean()), teardownDeploymentId: z.optional(DeploymentIdentifierV1Schema),
}).check(z.refine(input => input.detachKeepRunning !== true || input.teardownDeploymentId === undefined,
  { message: 'Choose a teardown receipt or explicit detach.' })));
export const DeploymentEnvironmentDeleteInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, ...intent,
  detachKeepRunning: z.optional(z.boolean()),
  teardownDeploymentIds: z.optional(z.array(DeploymentIdentifierV1Schema).check(
    z.refine(ids => new Set(ids).size === ids.length, { message: 'Teardown receipts must be unique.' }))),
}).check(z.refine(input => input.detachKeepRunning !== true || input.teardownDeploymentIds === undefined,
  { message: 'Choose teardown receipts or explicit detach.' })));
export type DeploymentTargetUnlinkInputV1 = z.infer<typeof DeploymentTargetUnlinkInputV1Schema>;
export type DeploymentEnvironmentDeleteInputV1 = z.infer<typeof DeploymentEnvironmentDeleteInputV1Schema>;
export const DeploymentTargetSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host'), id: DeploymentIdentifierV1Schema }),
  z.strictObject({ kind: z.literal('plugin'), contribution: z.strictObject({
    pluginId: DeploymentIdentifierV1Schema, localId: DeploymentIdentifierV1Schema }) }),
]));
export const DeploymentTargetLinkMemberV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetLinkMachineV1Schema, {
  state: z.enum(['joining', 'active']),
}));
export const DeploymentTargetLinkMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), id: DeploymentIdentifierV1Schema, environmentId: DeploymentIdentifierV1Schema,
  revision: DeploymentRevisionV1Schema, role: z.enum(['runtime', 'data']), source: DeploymentTargetSourceV1Schema,
  targetKind: DeploymentIdentifierV1Schema, state: z.enum(['none', 'configured', 'provisioned', 'deployed']),
  machines: z.array(DeploymentIdentifierV1Schema),
  members: z.array(DeploymentTargetLinkMemberV1Schema),
  machineId: z.optional(DeploymentIdentifierV1Schema), installationId: z.optional(DeploymentIdentifierV1Schema),
  activeDeploymentId: z.optional(DeploymentIdentifierV1Schema), predecessorTargetLinkId: z.optional(DeploymentIdentifierV1Schema),
  createdByAccountId: DeploymentIdentifierV1Schema,
  createdAtMs: DeploymentTimestampV1Schema, updatedAtMs: DeploymentTimestampV1Schema,
  deletedAtMs: z.optional(DeploymentTimestampV1Schema), detachedAtMs: z.optional(DeploymentTimestampV1Schema),
}).check(z.refine(link => new Set(link.machines).size === link.machines.length
  && link.machines.length === link.members.length
  && link.members.every((member, index) => member.machineId === link.machines[index]),
  { message: 'Runtime membership must project one ordered unique relation.' }),
  z.refine(link => link.source.kind === 'host'
    ? link.role === 'runtime' && link.targetKind === 'ownServer' && link.machines.length > 0
      && link.machineId === undefined && link.installationId === undefined
    : link.machines.length === 0 && link.members.length === 0
      && (link.machineId === undefined) === (link.installationId === undefined),
  { message: 'Own-server membership and plugin scalar placement are distinct target arms.' })));
export const DeploymentTargetLinkHeaderV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetLinkMetadataV1Schema,
  DeploymentArtifactContentReferenceV1Schema.shape));
export type DeploymentTargetLinkHeaderV1 = z.infer<typeof DeploymentTargetLinkHeaderV1Schema>;
export const DeploymentTargetLinkInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, ...intent, ...DeploymentArtifactContentReferenceV1Schema.shape,
  targetId: DeploymentIdentifierV1Schema, role: z.enum(['runtime', 'data']),
  source: z.optional(DeploymentTargetSourceV1Schema), targetKind: z.optional(DeploymentIdentifierV1Schema),
  machineId: z.optional(DeploymentIdentifierV1Schema), installationId: z.optional(DeploymentIdentifierV1Schema),
  replacesLinkId: z.optional(DeploymentIdentifierV1Schema),
  expectedTargetLinkRevision: z.optional(DeploymentRevisionV1Schema),
  machines: deploymentTargetMachinesV1Schema,
}).check(z.refine(link => (link.replacesLinkId === undefined) === (link.expectedTargetLinkRevision === undefined),
{ message: 'Replacing a target link requires its exact current revision.' }), z.refine(link => link.source?.kind === 'plugin'
  ? link.targetKind !== undefined && link.machines.length === 0
    && (link.machineId === undefined) === (link.installationId === undefined)
  : link.role === 'runtime' && (link.targetKind === undefined || link.targetKind === 'ownServer')
    && link.machines.length > 0 && link.machineId === undefined && link.installationId === undefined
    && (link.source === undefined || link.source.id === link.targetId),
{ message: 'A link selects one host membership or plugin identity and placement arm.' })));
const deploymentIntent = {
  ...environment, ...intent,
  targetLinkId: DeploymentIdentifierV1Schema, expectedTargetLinkRevision: DeploymentRevisionV1Schema,
};
export const DeploymentDeployInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...deploymentIntent, ...DeploymentArtifactContentReferenceV1Schema.shape,
  whenBusy: z.optional(z.enum(['refuse', 'supersede'])),
  pendingDeploy: z.optional(DeploymentPendingDeployV1Schema),
}).check(z.refine(input => input.pendingDeploy === undefined || input.whenBusy === 'supersede',
  { message: 'Retaining a pending intent requires explicit supersession.' }),
  z.refine(input => input.pendingDeploy?.t !== 'plain'
    || (input.pendingDeploy.v.requestKey === input.requestKey && input.pendingDeploy.v.targetLinkId === input.targetLinkId),
  { message: 'Pending intent must match the admitted deploy identity.' })));
export const DeploymentDeployActionInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentDeployInputV1Schema, DeploymentDeployIntentInputV1Schema,
]));
export const DeploymentRollbackInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...deploymentIntent, ...DeploymentArtifactContentReferenceV1Schema.shape,
  deploymentId: DeploymentIdentifierV1Schema,
  restoreBackupId: z.optional(DeploymentIdentifierV1Schema),
}));
export const DEPLOYMENT_TEARDOWN_STEPS_V1 = ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] as const;
export const DeploymentTeardownStepV1Schema = lazyZodSchema(() => z.enum(DEPLOYMENT_TEARDOWN_STEPS_V1));
export const DeploymentTeardownReasonV1Schema = lazyZodSchema(() => z.enum(['manual', 'previewClosed', 'move', 'decommission']));
export const DeploymentTeardownInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...deploymentIntent, ...DeploymentArtifactContentReferenceV1Schema.shape,
  reason: DeploymentTeardownReasonV1Schema,
  machines: z.optional(z.array(DeploymentIdentifierV1Schema).check(z.minLength(1),
    z.refine(values => new Set(values).size === values.length, { message: 'Teardown Machines must be unique.' }))),
}));
export const DeploymentTeardownAdmissionInputV1Schema = lazyZodSchema(() => z.extend(DeploymentTeardownInputV1Schema, {
  actionOperationId: DeploymentIdentifierV1Schema,
}));
export type DeploymentTeardownInputV1 = z.infer<typeof DeploymentTeardownInputV1Schema>;
export type DeploymentTeardownAdmissionInputV1 = z.infer<typeof DeploymentTeardownAdmissionInputV1Schema>;
/** Only the installation-signed settlement writer can assert owned-resource absence. */
export const DeploymentTeardownProofV1Schema = lazyZodSchema(() => z.strictObject({
  targetLinkRevision: DeploymentRevisionV1Schema,
  machines: z.array(DeploymentTargetLinkMachineV1Schema).check(z.minLength(1),
    z.refine(values => new Set(values.map(value => value.machineId)).size === values.length,
      { message: 'Teardown proofs require unique Machines.' })),
  workloadAbsent: z.literal(true), retainedProviderResource: z.boolean(),
  steps: z.tuple([z.literal('admit'), z.literal('settleDeploy'), z.literal('removeTarget'), z.literal('removeDomain'),
    z.literal('removeRelease'), z.literal('withdrawBindings'), z.literal('verify')]),
}));
export type DeploymentTeardownProofV1 = z.infer<typeof DeploymentTeardownProofV1Schema>;
/** Cancellation needs only current receipt custody; it never authors native member facts. */
export const DeploymentCancelInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, environmentId: DeploymentIdentifierV1Schema, deploymentId: DeploymentIdentifierV1Schema,
  expectedReceiptRevision: DeploymentRevisionV1Schema,
}));
export const DeploymentCancelTransitionInputV1Schema = lazyZodSchema(() => z.extend(DeploymentCancelInputV1Schema, {
  kind: z.literal('cancel'),
}));
export type DeploymentCancelInputV1 = z.infer<typeof DeploymentCancelInputV1Schema>;
export type DeploymentCancelTransitionInputV1 = z.infer<typeof DeploymentCancelTransitionInputV1Schema>;
/** Private cleanup transport of the existing Action-operation cancellation owner. */
export const DeploymentPendingCancelInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, actionOperationId: DeploymentIdentifierV1Schema, pendingDeploy: DeploymentPendingDeployV1Schema,
}));
export type DeploymentPendingCancelInputV1 = z.infer<typeof DeploymentPendingCancelInputV1Schema>;
/** The prepared destination content is committed by the sole Environment writer before admission. */
export const DeploymentPromoteInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...deploymentIntent, ...DeploymentArtifactContentReferenceV1Schema.shape,
  sourceEnvironmentId: DeploymentIdentifierV1Schema, sourceDeploymentId: DeploymentIdentifierV1Schema,
  sourceExpectedRevision: DeploymentRevisionV1Schema, sourceExpectedDeploymentRevision: DeploymentRevisionV1Schema,
  artifact: z.enum(['image', 'rebuild']), destinationContent: DeploymentArtifactContentReferenceV1Schema,
}));
/** Only the installed host can supply an operation association to storage admission. */
export const DeploymentDeployAdmissionInputV1Schema = lazyZodSchema(() => z.extend(DeploymentDeployInputV1Schema, {
  actionOperationId: DeploymentIdentifierV1Schema,
}).check(z.refine(input => input.pendingDeploy?.t !== 'plain'
  || input.pendingDeploy.v.actionOperationId === input.actionOperationId,
{ message: 'Pending intent belongs to the accepted Action operation.' })));
export const DeploymentRollbackAdmissionInputV1Schema = lazyZodSchema(() => z.extend(DeploymentRollbackInputV1Schema, {
  actionOperationId: DeploymentIdentifierV1Schema,
}));
export const DeploymentPromoteAdmissionInputV1Schema = lazyZodSchema(() => z.extend(DeploymentPromoteInputV1Schema, {
  actionOperationId: DeploymentIdentifierV1Schema,
}));
export type DeploymentPromoteAdmissionInputV1 = z.infer<typeof DeploymentPromoteAdmissionInputV1Schema>;
export type DeploymentDeployAdmissionInputV1 = z.infer<typeof DeploymentDeployAdmissionInputV1Schema>;
export type DeploymentRollbackAdmissionInputV1 = z.infer<typeof DeploymentRollbackAdmissionInputV1Schema>;
export const DeploymentActionFailureV1Schema = lazyZodSchema(() => z.union([
  z.extend(ArtifactQuotaExceededV1Schema, { ok: z.literal(false) }),
  z.strictObject({ ok: z.literal(false), error: z.enum(['deployment_invalid', 'deployment_unavailable',
    'deployment_access_denied', 'deployment_conflict', 'deployment_content_unavailable', 'deployment_teardown_required', 'unsupported_action', 'client_required']) }),
  z.strictObject({ ok: z.literal(false), error: z.literal('deployment_in_progress'),
    deploymentId: DeploymentIdentifierV1Schema, href: DeploymentIdentifierV1Schema }),
  z.strictObject({ ok: z.literal(false), error: z.literal('machine_unavailable'),
    role: z.enum(['controller', 'build', 'target']), machineIds: z.array(DeploymentIdentifierV1Schema).check(z.minLength(1)),
    nextActions: z.array(z.enum(['start', 'chooseAnother', 'removeFromEnvironment'])).check(z.minLength(1)) }),
]));
const result = { ok: z.literal(true), environmentId: DeploymentIdentifierV1Schema, revision: DeploymentRevisionV1Schema };
export const DeploymentTargetUnlinkResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, targetLinkId: DeploymentIdentifierV1Schema,
    targetLinkRevision: DeploymentRevisionV1Schema, detached: z.boolean() }), DeploymentActionFailureV1Schema,
]));
export const DeploymentEnvironmentDeleteResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, detached: z.boolean() }), DeploymentActionFailureV1Schema,
]));
export type DeploymentTargetUnlinkResultV1 = z.infer<typeof DeploymentTargetUnlinkResultV1Schema>;
export type DeploymentEnvironmentDeleteResultV1 = z.infer<typeof DeploymentEnvironmentDeleteResultV1Schema>;
export const DeploymentEnvironmentCreateResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, projectSourceId: z.optional(DeploymentIdentifierV1Schema) }), DeploymentActionFailureV1Schema,
]));
export const DeploymentTargetLinkAlreadyLinkedResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false), error: z.literal('provider_scope_already_linked'),
  environment: DeploymentEnvironmentRefV1Schema, targetLinkId: DeploymentIdentifierV1Schema,
}));
export type DeploymentTargetLinkAlreadyLinkedResultV1 = z.infer<typeof DeploymentTargetLinkAlreadyLinkedResultV1Schema>;
export const DeploymentTargetLinkResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, targetLinkId: DeploymentIdentifierV1Schema, targetLinkRevision: DeploymentRevisionV1Schema }),
  DeploymentTargetLinkAlreadyLinkedResultV1Schema,
  DeploymentActionFailureV1Schema,
]));
export const DeploymentReceiptResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, deploymentId: DeploymentIdentifierV1Schema,
    deploymentRevision: DeploymentRevisionV1Schema, state: DeploymentStateV1Schema }),
  z.strictObject({ ...result, kind: z.literal('pending'), actionOperationId: DeploymentIdentifierV1Schema,
    operation: z.optional(ActionOperationAddressV1Schema) }),
  DeploymentActionFailureV1Schema,
]));
export const DeploymentEnvironmentGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, environmentId: DeploymentIdentifierV1Schema,
}));
/** Host-private authority projection; no content availability or native-effect authority is implied. */
export const DeploymentEnvironmentAccessInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, environmentIds: z.array(DeploymentIdentifierV1Schema),
}));
export const DeploymentEnvironmentAccessResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), items: z.array(z.strictObject({
    environmentId: DeploymentIdentifierV1Schema, read: z.literal(true), deploy: z.boolean(),
  })) }),
  DeploymentActionFailureV1Schema,
]));
export type DeploymentEnvironmentAccessInputV1 = z.infer<typeof DeploymentEnvironmentAccessInputV1Schema>;
export type DeploymentEnvironmentAccessResultV1 = z.infer<typeof DeploymentEnvironmentAccessResultV1Schema>;
export const DeploymentReceiptGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, environmentId: z.optional(DeploymentIdentifierV1Schema), deploymentId: DeploymentIdentifierV1Schema,
}));
export const DeploymentEnvironmentGetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), environment: DeploymentEnvironmentHeaderV1Schema,
    targetLinks: z.array(DeploymentTargetLinkHeaderV1Schema), pendingDeploy: z.optional(DeploymentPendingDeployV1Schema),
    pendingAdmission: z.optional(DeploymentPendingAdmissionV1Schema) }), DeploymentActionFailureV1Schema,
]));
export const DeploymentEnvironmentGetResultV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(DeploymentEnvironmentGetResultV1Schema));
export const DeploymentReceiptGetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), deployment: DeploymentReceiptHeaderV1Schema }), DeploymentActionFailureV1Schema,
]));
export const DeploymentEnvironmentListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, projectSourceId: z.optional(DeploymentIdentifierV1Schema), machineId: z.optional(DeploymentIdentifierV1Schema),
  cursor: ProjectSourcesListInputV1Schema.shape.cursor, limit: ProjectSourcesListInputV1Schema.shape.limit,
}));
export const DeploymentReceiptListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DeploymentEnvironmentGetInputV1Schema.shape,
  cursor: ProjectSourcesListInputV1Schema.shape.cursor, limit: ProjectSourcesListInputV1Schema.shape.limit,
}));
export const DeploymentEnvironmentListResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), items: z.array(DeploymentEnvironmentHeaderV1Schema),
    runtimeTargetLinks: z.optional(z.array(DeploymentTargetLinkHeaderV1Schema)),
    currentDeployments: z.optional(z.array(DeploymentReceiptHeaderV1Schema)), nextCursor: z.nullable(DeploymentIdentifierV1Schema),
    coverage: z.optional(z.enum(['complete', 'partial'])) }),
  DeploymentActionFailureV1Schema,
]));
export const DeploymentReceiptListResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), items: z.array(DeploymentReceiptHeaderV1Schema), nextCursor: z.nullable(DeploymentIdentifierV1Schema) }),
  DeploymentActionFailureV1Schema,
]));
/** Header-only storage demand used by the existing target-link preparation. */
export const DeploymentTargetScopeV1Schema = ProjectSourceOwnerV1Schema;
export type DeploymentTargetScopeV1 = z.infer<typeof DeploymentTargetScopeV1Schema>;
export const DeploymentTargetLinksListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, scope: DeploymentTargetScopeV1Schema,
  cursor: ProjectSourcesListInputV1Schema.shape.cursor, limit: ProjectSourcesListInputV1Schema.shape.limit,
}));
export type DeploymentTargetLinksListInputV1 = z.infer<typeof DeploymentTargetLinksListInputV1Schema>;
export const DeploymentTargetLinksListResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true),
    items: z.array(z.strictObject({ environment: DeploymentEnvironmentHeaderV1Schema,
      targetLink: DeploymentTargetLinkHeaderV1Schema }).check(z.refine(item => item.targetLink.environmentId === item.environment.id,
      { message: 'Readable target links retain their admitted Environment identity.' }))),
    nextCursor: z.nullable(DeploymentIdentifierV1Schema), coverage: z.enum(['complete', 'partial']),
  }), DeploymentActionFailureV1Schema,
]));
export type DeploymentTargetLinksListResultV1 = z.infer<typeof DeploymentTargetLinksListResultV1Schema>;
/** Prepared callers retain the complete Artifact/capture contract. */
export const DeploymentBindingsPreparedInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, ...DeploymentArtifactContentReferenceV1Schema.shape,
  referencedSavedSecretRevisions: z.array(z.strictObject({ resourceId: DeploymentIdentifierV1Schema, revision: DeploymentRevisionV1Schema }))
    .check(z.refine(refs => new Set(refs.map(ref => ref.resourceId)).size === refs.length,
      { message: 'Saved Secret captures must have unique resource identities.' })),
}));
export type DeploymentBindingsPreparedInputV1 = z.infer<typeof DeploymentBindingsPreparedInputV1Schema>;
/** Authored intent stays ref-only; pending person choices never enter stored content. */
export const DeploymentBindingsPatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, set: z.array(EnvironmentSecretBindingInputV1Schema), remove: z.array(EnvironmentSecretBindingIdentityV1Schema),
}).check(z.refine(input => {
  const identities = [...input.set, ...input.remove].map(environmentSecretBindingIdentityV1);
  return new Set(identities).size === identities.length;
}, { message: 'Each binding identity may occur once in a patch.' })));
export type DeploymentBindingsPatchInputV1 = z.infer<typeof DeploymentBindingsPatchInputV1Schema>;
export const DeploymentBindingsSetInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentBindingsPreparedInputV1Schema, DeploymentBindingsPatchInputV1Schema,
]));
/** Reviewed owner operands, not arbitrary Actions or executable code. P60 alone composes them. */
export const DeploymentPublishInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, requestKey: DeploymentIdentifierV1Schema,
  hostMachineId: z.nullable(DeploymentIdentifierV1Schema),
  project: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('existing'), projectSourceId: DeploymentIdentifierV1Schema, sourceRevision: DeploymentRevisionV1Schema }),
    z.strictObject({ kind: z.literal('create'), input: ProjectSourcesCreateInputV1Schema }),
  ]),
  definition: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('repository'), repository: ScmHostingRepositoryIdentityV1Schema,
      commit: ScmCommitOidSchema, compose: DeploymentRepositoryComposeV1Schema, workspace: ProjectAccountWorkspaceRefKeyV1Schema }),
    z.pick(DeploymentStoredDefinitionV1Schema, { kind: true, contentRevision: true, composeDigest: true }),
  ]),
  destination: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('ownServer'), machines: DeploymentOwnServerTargetMachinesV1Schema,
      controllerMachineId: DeploymentIdentifierV1Schema, buildMachineId: DeploymentIdentifierV1Schema }),
    z.strictObject({ kind: z.literal('platform'), targetId: DeploymentIdentifierV1Schema,
      targetKind: DeploymentIdentifierV1Schema, source: DeploymentTargetSourceV1Schema,
      controllerMachineId: DeploymentIdentifierV1Schema, sourceMethod: DeploymentSourceMethodV1Schema }),
  ]),
  environment: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('existing'), environmentId: DeploymentIdentifierV1Schema, expectedRevision: DeploymentRevisionV1Schema }),
    z.strictObject({ kind: z.literal('create'), input: DeploymentEnvironmentCreateInputV1Schema }),
  ]),
  preparedChildren: z.strictObject({
    acquire: z.optional(z.array(ManagedAcquireInputV1Schema)),
    retention: z.optional(z.array(ManagedRetentionUpdateInputV1Schema)),
    setup: z.optional(z.array(MachineSetupApplyInputV1Schema)),
    runtimeLink: z.optional(DeploymentTargetLinkInputV1Schema),
    dataLinks: z.optional(z.array(DeploymentTargetLinkInputV1Schema)),
    bindings: z.optional(DeploymentBindingsSetInputV1Schema),
    deploy: DeploymentDeployInputV1Schema,
  }),
}).check(z.refine(input => input.destination.kind !== 'ownServer' || input.hostMachineId !== null,
  { message: 'Own-server Publish requires an existing reviewed Workflow host.' })));
export type DeploymentPublishInputV1 = z.infer<typeof DeploymentPublishInputV1Schema>;
export const DeploymentHealthReadResultV1Schema = lazyZodSchema(() => z.union([DeploymentHealthReadSuccessV1Schema, DeploymentActionFailureV1Schema]));
export const DeploymentDriftReadResultV1Schema = lazyZodSchema(() => z.union([DeploymentDriftReadSuccessV1Schema, DeploymentActionFailureV1Schema]));
export const DeploymentLogsReadResultV1Schema = lazyZodSchema(() => z.union([DeploymentLogsReadSuccessV1Schema, DeploymentActionFailureV1Schema]));
export type DeploymentHealthReadResultV1 = z.infer<typeof DeploymentHealthReadResultV1Schema>;
export type DeploymentDriftReadResultV1 = z.infer<typeof DeploymentDriftReadResultV1Schema>;
export type DeploymentLogsReadResultV1 = z.infer<typeof DeploymentLogsReadResultV1Schema>;
export const DeploymentActionInputSchemasV1 = {
  'deployments.publish.prepare': DeploymentPublishPrepareInputV1Schema,
  'deployments.templates.instantiate': DeploymentTemplateInstantiateInputV1Schema,
  'deployments.health.read': DeploymentHealthReadInputV1Schema,
  'deployments.drift.read': DeploymentDriftReadInputV1Schema,
  'deployments.logs.read': DeploymentLogsReadInputV1Schema,
  'deployments.publish': DeploymentPublishInputV1Schema,
  'deployments.prepare': DeploymentPrepareInputV1Schema,
  'deployments.environments.create': DeploymentEnvironmentCreateActionInputV1Schema,
  'deployments.environments.update': DeploymentEnvironmentUpdateInputV1Schema,
  'deployments.environments.controller.set': DeploymentEnvironmentControllerSetInputV1Schema,
  'deployments.targets.link': DeploymentTargetLinkInputV1Schema,
  'deployments.targets.unlink': DeploymentTargetUnlinkInputV1Schema,
  'deployments.environments.delete': DeploymentEnvironmentDeleteInputV1Schema,
  'deployments.deploy': DeploymentDeployActionInputV1Schema,
  'deployments.rollback': DeploymentRollbackInputV1Schema,
  'deployments.teardown': DeploymentTeardownInputV1Schema,
  'deployments.cancel': DeploymentCancelInputV1Schema,
  'deployments.promote': DeploymentPromoteInputV1Schema,
  'deployments.environments.get': DeploymentEnvironmentGetInputV1Schema,
  'deployments.receipts.get': DeploymentReceiptGetInputV1Schema,
  'deployments.bindings.set': DeploymentBindingsSetInputV1Schema,
  'deployments.environments.list': DeploymentEnvironmentListInputV1Schema,
  'deployments.receipts.list': DeploymentReceiptListInputV1Schema,
} as const;
/** One-shot values and their review-only origin; no default pointer is saved on the Environment. */
export const DeploymentEnvironmentCreationReviewV1Schema = lazyZodSchema(() => z.required(z.pick(
  DeploymentTemplateInstantiationReviewV1Schema, { creationDefaults: true, creationDefaultsBasis: true })));
export type DeploymentEnvironmentCreationReviewV1 = z.infer<typeof DeploymentEnvironmentCreationReviewV1Schema>;
export const DeploymentEnvironmentCreatePreviewV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('preview'), input: DeploymentEnvironmentCreateInputV1Schema, review: DeploymentEnvironmentCreationReviewV1Schema,
}));
export type DeploymentEnvironmentCreatePreviewV1 = z.infer<typeof DeploymentEnvironmentCreatePreviewV1Schema>;
export const DeploymentEnvironmentCreateActionResultV1Schema = lazyZodSchema(() => z.union([
  DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentCreatePreviewV1Schema,
]));
export const DeploymentActionOutputSchemasV1 = {
  'deployments.publish.prepare': DeploymentPublishPrepareResultV1Schema,
  'deployments.templates.instantiate': DeploymentTemplateInstantiateResultV1Schema,
  'deployments.health.read': DeploymentHealthReadResultV1Schema,
  'deployments.drift.read': DeploymentDriftReadResultV1Schema,
  'deployments.logs.read': DeploymentLogsReadResultV1Schema,
  'deployments.publish': DeploymentPublishResultV1Schema,
  'deployments.prepare': DeploymentPrepareResultV1Schema,
  'deployments.environments.create': DeploymentEnvironmentCreateActionResultV1Schema,
  'deployments.environments.update': DeploymentEnvironmentCreateResultV1Schema,
  'deployments.environments.controller.set': DeploymentEnvironmentCreateResultV1Schema,
  'deployments.targets.link': DeploymentTargetLinkResultV1Schema,
  'deployments.targets.unlink': DeploymentTargetUnlinkResultV1Schema,
  'deployments.environments.delete': DeploymentEnvironmentDeleteResultV1Schema,
  'deployments.deploy': DeploymentReceiptResultV1Schema,
  'deployments.rollback': DeploymentReceiptResultV1Schema,
  'deployments.teardown': DeploymentReceiptResultV1Schema,
  'deployments.cancel': DeploymentReceiptResultV1Schema,
  'deployments.promote': DeploymentReceiptResultV1Schema,
  'deployments.environments.get': DeploymentEnvironmentGetResultV1Schema,
  'deployments.receipts.get': DeploymentReceiptGetResultV1Schema,
  'deployments.bindings.set': DeploymentEnvironmentCreateResultV1Schema,
  'deployments.environments.list': DeploymentEnvironmentListResultV1Schema,
  'deployments.receipts.list': DeploymentReceiptListResultV1Schema,
} as const;
export type DeploymentEnvironmentCreateInputV1 = z.infer<typeof DeploymentEnvironmentCreateInputV1Schema>;
export type DeploymentEnvironmentCreateIntentInputV1 = z.infer<typeof DeploymentEnvironmentCreateIntentInputV1Schema>;
export type DeploymentEnvironmentCreateActionInputV1 = z.infer<typeof DeploymentEnvironmentCreateActionInputV1Schema>;
export type DeploymentEnvironmentUpdateInputV1 = z.infer<typeof DeploymentEnvironmentUpdateInputV1Schema>;
export type DeploymentEnvironmentControllerSetInputV1 = z.infer<typeof DeploymentEnvironmentControllerSetInputV1Schema>;
export type DeploymentTargetLinkInputV1 = z.infer<typeof DeploymentTargetLinkInputV1Schema>;
export type DeploymentDeployInputV1 = z.infer<typeof DeploymentDeployInputV1Schema>;
export type DeploymentDeployActionInputV1 = z.infer<typeof DeploymentDeployActionInputV1Schema>;
export type DeploymentRollbackInputV1 = z.infer<typeof DeploymentRollbackInputV1Schema>;
export type DeploymentPromoteInputV1 = z.infer<typeof DeploymentPromoteInputV1Schema>;
export type DeploymentReceiptResultV1 = z.infer<typeof DeploymentReceiptResultV1Schema>;
export type DeploymentEnvironmentGetInputV1 = z.infer<typeof DeploymentEnvironmentGetInputV1Schema>;
export type DeploymentReceiptGetInputV1 = z.infer<typeof DeploymentReceiptGetInputV1Schema>;
export type DeploymentBindingsSetInputV1 = z.infer<typeof DeploymentBindingsSetInputV1Schema>;
export type DeploymentEnvironmentListInputV1 = z.infer<typeof DeploymentEnvironmentListInputV1Schema>;
export type DeploymentReceiptListInputV1 = z.infer<typeof DeploymentReceiptListInputV1Schema>;
export type DeploymentActionInputV1 = z.infer<typeof DeploymentActionInputSchemasV1[DeploymentTransportActionIdV1]>;
export type DeploymentActionOutputV1 = z.infer<typeof DeploymentActionOutputSchemasV1[DeploymentTransportActionIdV1]>;

export const DeploymentTransitionInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, deploymentId: DeploymentIdentifierV1Schema, actionOperationId: DeploymentIdentifierV1Schema,
  machineId: DeploymentIdentifierV1Schema, installationId: DeploymentIdentifierV1Schema,
  proof: MachineInstallationProofV1Schema,
  kind: z.enum(['stage', 'settle']), state: DeploymentStateV1Schema,
  contentUpdate: z.optional(ArtifactJsonUpdateHttpInputV1Schema),
  contentArtifactId: z.optional(DeploymentIdentifierV1Schema),
  contentHeaderVersion: z.optional(DeploymentRevisionV1Schema), contentBodyVersion: z.optional(DeploymentRevisionV1Schema),
  uniformProof: z.optional(z.strictObject({ targetLinkRevision: DeploymentRevisionV1Schema,
    machines: z.array(DeploymentTargetLinkMachineV1Schema).check(z.minLength(1)) })),
  teardownProof: z.optional(DeploymentTeardownProofV1Schema),
}).check(z.superRefine((input, context) => {
  const content = [input.contentArtifactId, input.contentHeaderVersion, input.contentBodyVersion];
  if (content.some(value => value !== undefined) && !content.every(value => value !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Content transitions require the complete Artifact reference.' });
  }
  const terminal = ['running_unverified', 'succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(input.state);
  if ((input.kind === 'settle') !== terminal) context.addIssue({ code: 'custom', path: ['state'], message: 'Transition kind must match settlement.' });
  if (input.uniformProof && (input.kind !== 'settle' || !['succeeded', 'running_unverified'].includes(input.state))) {
    context.addIssue({ code: 'custom', path: ['uniformProof'], message: 'Only a successful settlement can prove a uniform release.' });
  }
  if (input.teardownProof && (input.kind !== 'settle' || input.state !== 'succeeded' || input.uniformProof)) {
    context.addIssue({ code: 'custom', path: ['teardownProof'], message: 'Only a complete successful teardown can prove removal.' });
  }
})));
export type DeploymentTransitionInputV1 = z.infer<typeof DeploymentTransitionInputV1Schema>;

/** The signer and Home derive the same body binding; the proof itself is never part of its digest. */
export function computeDeploymentTransitionRequestDigestV1(input: Omit<DeploymentTransitionInputV1, 'proof'>): string {
  return computeCanonicalDomainSeparatedDigest('happier-deployment-transition-v1', [createCanonicalJsonSigningInput(input)]);
}

export const DeploymentAccountChangeHintV1Schema = lazyZodSchema(() => z.strictObject({
  deployment: z.strictObject({ projectSourceId: z.optional(DeploymentIdentifierV1Schema), environmentId: DeploymentIdentifierV1Schema,
    deploymentId: z.optional(DeploymentIdentifierV1Schema), revision: DeploymentRevisionV1Schema }),
}));
export type DeploymentAccountChangeIdentityV1 = Readonly<{ projectSourceId?: string; environmentId: string; deploymentId?: string }>;

/** Producer-known Source routing survives both durable hints and content-free socket wakes. */
export function buildDeploymentAccountChangeV1(input: DeploymentAccountChangeIdentityV1 & Readonly<{ revision: number }>) {
  const hint = DeploymentAccountChangeHintV1Schema.parse({ deployment: input });
  const environment = encodeURIComponent(hint.deployment.environmentId);
  const identity = hint.deployment.deploymentId === undefined ? `deployment-environment:${environment}`
    : `deployment-receipt:${environment}:${encodeURIComponent(hint.deployment.deploymentId)}`;
  const entityId = hint.deployment.projectSourceId === undefined ? identity
    : `${identity}:${encodeURIComponent(hint.deployment.projectSourceId)}`;
  return { kind: 'account' as const, entityId, hint };
}

/** Reads both durable hints and the existing content-free socket entity-id wake. */
export function readDeploymentAccountChangeV1(change: Readonly<{ kind: string; entityId: string; hint?: unknown }>): DeploymentAccountChangeIdentityV1 | null {
  if (change.kind !== 'account') return null;
  try {
    const parts = change.entityId.split(':');
    const receipt = parts[0] === 'deployment-receipt';
    const legacyLength = receipt ? 3 : 2;
    if ((!receipt && parts[0] !== 'deployment-environment') || (parts.length !== legacyLength && parts.length !== legacyLength + 1)) return null;
    const environmentId = DeploymentIdentifierV1Schema.parse(decodeURIComponent(parts[1]!));
    const deploymentId = receipt ? DeploymentIdentifierV1Schema.parse(decodeURIComponent(parts[2]!)) : undefined;
    // Retained unqualified feed rows stay conservative; no consumer guesses their Source.
    const projectSourceId = parts.length === legacyLength ? undefined
      : DeploymentIdentifierV1Schema.parse(decodeURIComponent(parts[legacyLength]!));
    if (change.hint !== undefined) {
      const hint = DeploymentAccountChangeHintV1Schema.safeParse(change.hint);
      if (!hint.success || hint.data.deployment.environmentId !== environmentId
        || hint.data.deployment.deploymentId !== deploymentId
        || hint.data.deployment.projectSourceId !== projectSourceId) return null;
    }
    return { environmentId, ...(deploymentId === undefined ? {} : { deploymentId }),
      ...(projectSourceId === undefined ? {} : { projectSourceId }) };
  } catch { return null; }
}
