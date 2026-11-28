import { DeploymentEnvironmentTelemetrySetInputV1Schema, DeploymentEnvironmentTelemetrySetSuccessV1Schema,
  DeploymentTelemetryTokenHashV1Schema } from './deploymentTelemetryV1.js';
export * from './deploymentTelemetryV1.js';
import {
  DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1,
  DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, DEPLOYMENT_PREPARE_ACTION_ID_V1,
  DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1, DEPLOYMENT_RESTART_ACTION_ID_V1,
  DEPLOYMENT_TEARDOWN_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1,
  isDeploymentAccountMachineTransportActionIdV1, isDeploymentActionIdV1,
  isDeploymentBackupActionIdV1, isDeploymentChildRootActionIdV1, isDeploymentReadActionIdV1, type DeploymentActionIdV1,
} from './deploymentActionIdsV1.js';
import type { ActionExecutionPlacement } from '../actions/actionSpecs.js';
import { DeploymentDomainDnsInputV1Schema, DeploymentDomainDnsResultV1Schema } from './deploymentDomainDnsV1.js';
import { DeploymentDomainIdInUseFailureV1Schema } from './deploymentDomainFailureV1.js';
import { DeploymentDomainTunnelDispositionV1Schema } from './deploymentDomainProviderResultV1.js';
export * from './deploymentDomainDnsV1.js';
export { isDeploymentDomainDnsActionIdV1, isDeploymentDomainDnsVerifyActionIdV1, DEPLOYMENT_DOMAIN_DNS_CREATE_ACTION_ID_V1, DEPLOYMENT_DOMAIN_DNS_VERIFY_ACTION_ID_V1 } from './deploymentActionIdsV1.js';
import { DeploymentBindingsSetInputV1Schema } from './deploymentBindingPatchV1.js';
export { DeploymentBindingsPreparedInputV1Schema, DeploymentBindingsSetInputV1Schema, type DeploymentBindingsPreparedInputV1, type DeploymentBindingsSetInputV1 } from './deploymentBindingPatchV1.js';
import { DeploymentDeployInputV1Schema, DeploymentDeployActionInputV1Schema, DeploymentRollbackInputV1Schema, DeploymentRollbackActionInputV1Schema } from './deploymentDeployIntentV1.js';
export { DeploymentDeployInputV1Schema, DeploymentDeployActionInputV1Schema, DeploymentRollbackInputV1Schema, DeploymentRollbackIntentInputV1Schema, DeploymentRollbackActionInputV1Schema, type DeploymentDeployInputV1, type DeploymentDeployActionInputV1, type DeploymentRollbackInputV1, type DeploymentRollbackIntentInputV1, type DeploymentRollbackActionInputV1 } from './deploymentDeployIntentV1.js';
import { DeploymentPromoteInputV1Schema, DeploymentPromoteActionInputV1Schema } from './deploymentPromoteIntentV1.js';
export { DeploymentPromoteInputV1Schema, DeploymentPromoteActionInputV1Schema, type DeploymentPromoteActionInputV1, type DeploymentPromoteInputV1 } from './deploymentPromoteIntentV1.js';
import { DeploymentTargetUnlinkInputV1Schema, DeploymentTeardownDispositionV1Schema, DeploymentTeardownActionInputV1Schema } from './deploymentTeardownRequestV1.js';
export { DEPLOYMENT_TEARDOWN_STEPS_V1, DeploymentTeardownStepV1Schema, DeploymentTargetUnlinkInputV1Schema, DeploymentTeardownReasonV1Schema, DeploymentTeardownDispositionV1Schema, DeploymentTeardownInputV1Schema, DeploymentDataCreationReferenceV1Schema, DeploymentTeardownIntentInputV1Schema, DeploymentTeardownDetachInputV1Schema, DeploymentTeardownNothingDeployedInputV1Schema, DeploymentTeardownPreparedInputV1Schema, DeploymentTeardownAuthoredInputV1Schema, DeploymentTeardownActionInputV1Schema, DeploymentTeardownAdmissionInputV1Schema, DeploymentTeardownActionAdmissionInputV1Schema, type DeploymentTargetUnlinkInputV1, type DeploymentDataCreationReferenceV1, type DeploymentTeardownIntentInputV1, type DeploymentTeardownNothingDeployedInputV1, type DeploymentTeardownPreparedInputV1, type DeploymentTeardownAuthoredInputV1, type DeploymentTeardownActionInputV1, type DeploymentTeardownInputV1, type DeploymentTeardownAdmissionInputV1 } from './deploymentTeardownRequestV1.js';
import { DeploymentEnvironmentCreateIntentInputV1Schema } from './deploymentTemplateInstantiationV1.js';
export { DeploymentEnvironmentCreateIntentInputV1Schema, type DeploymentEnvironmentCreateIntentInputV1 } from './deploymentTemplateInstantiationV1.js';
import { DeploymentFolderReviewRevisionV1Schema } from './deploymentFolderReviewRevisionV1.js';
import { z } from '../zodRuntimePolicy.js';
import { DeploymentTargetVariablesReadResultV1Schema, DeploymentTargetVariablesSyncResultV1Schema } from '../plugins/contributions/deploymentTargetVariablesV1.js';
import { DeploymentCreationDefaultsV1Schema, ResolvedDeploymentCreationDefaultsV1Schema, DeploymentConfigurationDefaultsForV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { DeploymentControllerAvailabilityV1Schema } from './deploymentControllerAvailabilityV1.js';
import { DeploymentPreviewForkEligibilityV1Schema } from './deploymentPreviewTemplateV1.js';
import { ConnectedAccountActionFormSelectionV1Schema } from '../connect/connectedAccountPurposeBindings.js';
import { DeploymentTextV1Schema, EnvironmentVariableBindingInputV1Schema } from './storedAppInputV1.js';
export * from './deploymentControllerAvailabilityV1.js';
import { ActionExecuteFailureSchema, ActionFailureCauseV1Schema, type ActionExecuteFailure } from '../actions/actionExecutionResult.js';
export { buildDeploymentTargetLinkInputV1 } from './targetLinkInput.js';
export { buildDeploymentTeardownInputV1, selectDeploymentTeardownDomainScopeV1 } from './teardownInput.js';
import { DeploymentTeardownRequestInputV1Schema } from './deploymentTeardownRequestV1.js';
import { DeploymentTeardownVolumesV1Schema, DeploymentTeardownPreviewV1Schema } from './deploymentTeardownVolumesV1.js';
export * from './deploymentTeardownVolumesV1.js';
export { DeploymentTeardownRequestInputV1Schema, type DeploymentTeardownRequestInputV1 } from './deploymentTeardownRequestV1.js';
import { DeploymentInvalidV1Schema } from './deploymentInvalidV1.js';
export { DeploymentInvalidV1Schema, type DeploymentInvalidV1 } from './deploymentInvalidV1.js';
export { buildDeploymentPromoteInputV1 } from './promoteInput.js';
export * from './deploymentReceiptEventsV1.js';
import { DeploymentReceiptFailureSummaryV1Schema, DeploymentReceiptInvestigationV1Schema, PlatformFailureEnrollmentReadBackV1Schema, PlatformFailureEnrollmentV1Schema } from './deploymentReceiptEventsV1.js';

import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentReceiptAcceptedResultV1Schema } from './deploymentReceiptResultV1.js';
import { DeploymentFailureRecoveryV1Schema, DeploymentRuntimeReinstallV1Schema } from './deploymentFailureRecoveryV1.js';
import { DeploymentBackupRestoreInputV1Schema, DeploymentBackupRestoreResultV1Schema } from './deploymentBackupRestoreV1.js';
export * from './deploymentBackupRestoreV1.js';
import { DeploymentBackupActionInputSchemasV1, DeploymentBackupActionResultSchemasV1, DeploymentBackupSourceV1Schema,
  DeploymentBackupPolicyV1Schema, DeploymentBackupRunInputV1Schema } from './deploymentBackupActionsV1.js';
export * from './deploymentBackupActionsV1.js';
import { DeploymentBackupConfigureInputV1Schema, DeploymentBackupConfigureResultV1Schema } from './deploymentBackupConfigureV1.js';
export * from './deploymentBackupConfigureV1.js';
export { DEPLOYMENT_BACKUP_ACTION_IDS_V1, isDeploymentBackupActionIdV1, type DeploymentBackupActionIdV1,
  DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1, DEPLOYMENT_BACKUP_INVENTORY_ACTION_ID_V1, DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1,
  DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1, DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1, DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
} from './deploymentActionIdsV1.js';
import { DeploymentRestartInputV1Schema } from './deploymentRestartV1.js';
import { MachineServiceControlResultV1Schema } from '../actions/specs/machine/services.js';
export { DeploymentRestartInputV1Schema, type DeploymentRestartInputV1 } from './deploymentRestartV1.js';
export { DeploymentReceiptAcceptedResultV1Schema, type DeploymentReceiptAcceptedResultV1 } from './deploymentReceiptResultV1.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { MachineInstallationProofV1Schema } from '../machines/identity/installationKeySchemas.js';
import { MachineAvailabilityDiagnosticV1Schema } from '../machines/machineAccessV1.js';
import { QualifiedConnectedAccountRefSchema } from '../connect/qualifiedConnectedAccountPersistence.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { withStrictJsonInput } from '../json/strictJsonValue.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ProjectSourceOwnerV1Schema, ProjectSourceV1Schema, ProjectSourcesListInputV1Schema } from '../projects/sources/projectSourceV1.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { ArtifactJsonUpdateHttpInputV1Schema } from '../artifacts/artifactMutationHttpV1.js';
import { ArtifactHttpReadV1Schema } from '../artifacts/artifactAccessV1.js';
import { ArtifactQuotaExceededV1Schema } from '../artifacts/artifactActionsV1.js';
import { isDeploymentChildEffectActionIdV1, isDeploymentTargetLinkActionIdV1, type DeploymentTransportActionIdV1 } from './deploymentActionIdsV1.js';
import { DeploymentEnvironmentRefV1Schema } from './deploymentEnvironmentRefV1.js';
import { DeploymentDeployIntentInputV1Schema } from './deploymentDeployIntentV1.js';

import { DeploymentPromoteIntentInputV1Schema } from './deploymentPromoteIntentV1.js';
export { DeploymentPromoteIntentInputV1Schema, type DeploymentPromoteIntentInputV1 } from './deploymentPromoteIntentV1.js';
import { DeploymentEnvironmentCopyReviewV1Schema } from './deploymentEnvironmentCopyV1.js';
export * from './deploymentEnvironmentCopyV1.js';
export { DeploymentDeployIntentInputV1Schema, type DeploymentDeployIntentInputV1 } from './deploymentDeployIntentV1.js';
export { DeploymentDeploySemanticInputV1Schema, type DeploymentDeploySemanticInputV1 } from './deploymentDeployIntentV1.js';
export { DeploymentEnvironmentRefV1Schema, type DeploymentEnvironmentRefV1 } from './deploymentEnvironmentRefV1.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema, DeploymentTimestampV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema, DeploymentEnvironmentContentCasV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { DeploymentPreviewPullRequestIdV1Schema as deploymentPreviewPullRequestIdV1Schema,
  DeploymentPreviewReferenceV1Schema } from './deploymentPreviewReferenceV1.js';


import { DeploymentTargetCredentialPrincipalV1Schema, DeploymentTargetLinkProviderContentV1Schema, DeploymentTargetCreateInputV1Schema, DeploymentTargetProductionBranchOutcomeV1Schema, DeploymentTargetProviderIdentityV1Schema } from '../plugins/contributions/deploymentTargetRolesV1.js';
import { DeploymentBindingSavedSecretRevisionsV1Schema, DeploymentEnvironmentSecretScopeV1Schema } from './deploymentBindingPatchV1.js';
export { DeploymentBindingsPatchInputV1Schema, type DeploymentBindingsPatchInputV1,
  DeploymentEnvironmentSecretScopeV1Schema, type DeploymentEnvironmentSecretScopeV1 } from './deploymentBindingPatchV1.js';
export * from './deploymentDomainV1.js';
import { DeploymentDomainHeaderV1Schema, DeploymentDomainAddInputV1Schema, DeploymentDomainRemoveInputV1Schema,
  DeploymentDomainVerifyInputV1Schema, DeploymentDomainDnsPreviewResultV1Schema, DeploymentDomainGetInputV1Schema, DeploymentDomainListInputV1Schema } from './deploymentDomainV1.js';
import { DeploymentPendingAdmissionV1Schema } from './deploymentPendingAdmissionV1.js';
export { DeploymentPendingAdmissionV1Schema, type DeploymentPendingAdmissionV1 } from './deploymentPendingAdmissionV1.js';
export { DeploymentAcceptedExecutionV1Schema, type DeploymentAcceptedExecutionV1 } from './deploymentAcceptedExecutionV1.js';
import { DeploymentEnvironmentCreateInputV1Schema, DeploymentTargetMachinesV1Schema, DeploymentTargetLinkMachineV1Schema } from './deploymentEnvironmentCreateV1.js';
export { DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema,
  DeploymentTargetLinkMachineV1Schema, DeploymentOwnServerTargetMachinesV1Schema } from './deploymentEnvironmentCreateV1.js';
export type { DeploymentEnvironmentCreateInputV1, DeploymentEnvironmentCreateStorageInputV1 } from './deploymentEnvironmentCreateV1.js';
import { DatabaseAgentAccessV1Schema, DatabaseAgentLevelV1Schema, DeploymentEnvironmentDataEditorModeV1Schema, DeploymentEnvironmentPeopleModeV1Schema,
  DeploymentEnvironmentPrincipalsV1Schema } from './deploymentEnvironmentDeployerV1.js';
export { DeploymentEnvironmentPeopleModeV1Schema, DeploymentEnvironmentPrincipalsV1Schema, deploymentEnvironmentPrincipalKeyV1,
  DeploymentEnvironmentDataEditorModeV1Schema, DatabaseAgentAccessV1Schema, DatabaseAgentLevelV1Schema,
  type DeploymentEnvironmentPeopleModeV1, type DeploymentEnvironmentDataEditorModeV1, type DatabaseAgentAccessV1,
  type DatabaseAgentLevelV1 } from './deploymentEnvironmentDeployerV1.js';
import { DeploymentPendingDeployV1Schema } from './storedAppInputV1.js';
import { DeploymentStoredDefinitionInputV1Schema, DeploymentNewProjectV1Schema } from './storedAppInputV1.js';
import { DeploymentRetainPreviousDeploymentsV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { DeploymentEnvironmentContentPatchV1Schema } from './deploymentEnvironmentContentPatchV1.js';
export { DeploymentEnvironmentContentPatchV1Schema, hasDeploymentEnvironmentContentPatchV1,
    deploymentEnvironmentPrivateContentPatchFieldsV1, omitDeploymentEnvironmentPrivateContentPatchV1 } from './deploymentEnvironmentContentPatchV1.js';
export { DeploymentPreviewTemplateV1Schema, DeploymentPreviewDataSelectionV1Schema,
  type DeploymentPreviewTemplateV1, type DeploymentPreviewDataSelectionV1 } from './deploymentPreviewTemplateV1.js';
export { DeploymentIngressV1Schema, type DeploymentIngressV1 } from './storedAppInputV1.js';
import { DeploymentTargetManagedRetentionV1Schema } from './storedAppInputV1.js';
import { DeploymentStoredDefinitionV1Schema, DeploymentSourceMethodV1Schema, DeploymentSourceIntentV1Schema, DeploymentRepositorySourceIntentV1Schema } from './storedAppInputV1.js';
import { DeploymentPrepareInputV1Schema, DeploymentPrepareResultV1Schema } from './deploymentPreparationV1.js';
import { DeploymentMoveToRepositoryInputV1Schema, DeploymentMoveToRepositoryResultV1Schema } from './deploymentMoveToRepositoryV1.js';
export * from './deploymentMoveToRepositoryV1.js';
export { ScmRepositoryFilesPullRequestPartialV1Schema, type ScmRepositoryFilesPullRequestPartialV1,
  ScmRepositoryFilesPullRequestSuccessV1Schema, type ScmRepositoryFilesPullRequestSuccessV1,
  ScmRepositoryFilesPullRequestResultV1Schema, type ScmRepositoryFilesPullRequestResultV1 } from '../scm/repositoryFilesPullRequest.js';
export { deploymentMoveToRepositoryReviewedChildrenV1, deploymentMoveToRepositoryChildRoleV1, DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1,
  type DeploymentMoveToRepositoryChildActionIdV1 } from '../scm/repositoryFilesPullRequestActionIds.js';
import * as deploymentTemplates from './deploymentTemplateInstantiationV1.js';
import { DeploymentPublishPrepareInputV1Schema, DeploymentPublishPrepareResultV1Schema } from './deploymentPublishPreparationV1.js';
export * from './deploymentPublishPreparationV1.js';
import { DeploymentHealthCurrentInputV1Schema, DeploymentHealthCurrentSuccessV1Schema,
  DeploymentHealthReadInputV1Schema, DeploymentDriftReadInputV1Schema, DeploymentLogsReadInputV1Schema,
  DeploymentHealthReadSuccessV1Schema, DeploymentDriftReadSuccessV1Schema, DeploymentLogsReadSuccessV1Schema } from './deploymentReadsV1.js';
import { DeploymentDataSizeInputV1Schema, DeploymentDataSizeSuccessV1Schema } from './deploymentReadsV1.js';
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

import { DeploymentEnvironmentHeaderV1Schema, DeploymentReceiptHeaderV1Schema, DeploymentReceiptMetadataV1Schema,
  type DeploymentEnvironmentHeaderV1 } from './deploymentHeadersV1.js';
import { DeploymentStateV1Schema, DeploymentCancellationConsequenceV1Schema } from './deploymentStateV1.js';

/** Storage transport leaves. Private deployment records remain deployment-protocol owned. */
export * from './deploymentHeadersV1.js';
export { DeploymentStateV1Schema, deploymentInProgressStates } from './deploymentStateV1.js';

const home = { serverId: DeploymentIdentifierV1Schema };
const environment = { ...home, environmentId: DeploymentIdentifierV1Schema, expectedRevision: DeploymentRevisionV1Schema };
const intent = { requestKey: DeploymentIdentifierV1Schema };

export const DeploymentEnvironmentCreateActionInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema,
]));
/** One owning patch shape serves authored inputs and the prepared storage projection. */
export const DeploymentEnvironmentUpdatePatchV1Schema = lazyZodSchema(() => z.strictObject({
    buildMachineId: z.optional(DeploymentIdentifierV1Schema),
    ...DeploymentEnvironmentContentPatchV1Schema.shape,
    protection: z.optional(DeploymentEnvironmentHeaderV1Schema.shape.protection),
    deployerMode: z.optional(DeploymentEnvironmentPeopleModeV1Schema),
    deployerPrincipals: z.optional(DeploymentEnvironmentPrincipalsV1Schema),
    dataEditorMode: z.optional(DeploymentEnvironmentDataEditorModeV1Schema),
    dataEditors: z.optional(DeploymentEnvironmentPrincipalsV1Schema),
    dataAgentAccess: z.optional(DatabaseAgentLevelV1Schema),
}));
/** Content CAS and reviewed build/ingress placement share one manager-owned update. */
export const DeploymentEnvironmentUpdateInputV1BaseSchema = lazyZodSchema(() => z.strictObject({
  ...DeploymentEnvironmentContentCasV1Schema.shape,
  patch: z.optional(DeploymentEnvironmentUpdatePatchV1Schema),
  /** First setup reads the same owner preparation for UI and agents; it writes no content. */
  mode: z.optional(z.literal('preview')),
  /** Read the watcher choices, or submit one exact choice. Neither is Environment content. */
  previewWatcher: z.optional(z.union([z.literal('options'), ConnectedAccountActionFormSelectionV1Schema])),
  defaultsFor: z.optional(DeploymentConfigurationDefaultsForV1Schema),
  creationDefaults: z.optional(DeploymentCreationDefaultsV1Schema),
}));
export const DeploymentEnvironmentUpdateInputV1Schema = lazyZodSchema(() => DeploymentEnvironmentUpdateInputV1BaseSchema.check(z.refine(input => input.previewWatcher !== undefined
  && (!input.patch?.previewTemplate?.enabled || (input.mode === 'preview') !== (input.previewWatcher === 'options'))
  ? false : input.mode === 'preview'
  ? input.defaultsFor !== undefined && input.patch === undefined
    || input.defaultsFor === undefined && input.creationDefaults === undefined && input.patch?.previewTemplate != null
      && Object.keys(input.patch).every(key => key === 'previewTemplate' || key === 'buildMachineId')
  : input.defaultsFor === undefined && input.creationDefaults === undefined,
{ message: 'Defaults preparation is a preview without an Environment patch.' })));
/** Manager-owned controller reassignment changes records and future assignments, never workload content. */
export const DeploymentEnvironmentControllerSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, controllerMachineId: DeploymentIdentifierV1Schema,
}));
export const DeploymentEnvironmentDeleteInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, ...intent,
  detachKeepRunning: z.optional(z.boolean()),
  teardownDeploymentIds: z.optional(z.array(DeploymentIdentifierV1Schema).check(
    z.refine(ids => new Set(ids).size === ids.length, { message: 'Teardown receipts must be unique.' }))),
}).check(z.refine(input => input.detachKeepRunning !== true || input.teardownDeploymentIds === undefined,
  { message: 'Choose teardown receipts or explicit detach.' })));
export type DeploymentEnvironmentDeleteInputV1 = z.infer<typeof DeploymentEnvironmentDeleteInputV1Schema>;
const deploymentHostTargetSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('host'), id: DeploymentIdentifierV1Schema,
}));
const deploymentPluginTargetSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('plugin'), contribution: z.strictObject({
    pluginId: DeploymentIdentifierV1Schema, localId: DeploymentIdentifierV1Schema,
  }),
}));
export const DeploymentTargetSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  deploymentHostTargetSourceV1Schema,
  deploymentPluginTargetSourceV1Schema,
]));
export const DeploymentTargetLinkMemberV1Schema = lazyZodSchema(() => z.extend(DeploymentTargetLinkMachineV1Schema, {
  state: z.enum(['joining', 'active']),
}));
export const DeploymentTargetLinkMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), id: DeploymentIdentifierV1Schema, environmentId: DeploymentIdentifierV1Schema,
  revision: DeploymentRevisionV1Schema, role: z.enum(['runtime', 'data']), source: DeploymentTargetSourceV1Schema,
  targetKind: DeploymentIdentifierV1Schema, state: z.enum(['none', 'configured', 'provisioned', 'deployed', 'detached']),
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
export const DeploymentTargetLinkIntentInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, ...intent,
  /** The same reviewed target-enable choice as first-target Create. */
  managedRetention: z.optional(DeploymentTargetManagedRetentionV1Schema),
  targetId: DeploymentIdentifierV1Schema, role: z.enum(['runtime', 'data']),
  /** Native creation was acknowledged before this exact association attempt. */
  provisioned: z.optional(z.literal(true)),
  source: z.optional(DeploymentTargetSourceV1Schema), targetKind: z.optional(DeploymentIdentifierV1Schema),
  machineId: z.optional(DeploymentIdentifierV1Schema), installationId: z.optional(DeploymentIdentifierV1Schema),
  replacesLinkId: z.optional(DeploymentIdentifierV1Schema),
  /** Successful native teardown receipt proving the installations removed by this replacement. */
  drainedDeploymentId: z.optional(DeploymentIdentifierV1Schema),
  expectedTargetLinkRevision: z.optional(DeploymentRevisionV1Schema),
  machines: DeploymentTargetMachinesV1Schema,
}).check(z.refine(link => (link.replacesLinkId === undefined) === (link.expectedTargetLinkRevision === undefined),
{ message: 'Replacing a target link requires its exact current revision.' }),
z.refine(link => link.drainedDeploymentId === undefined || link.replacesLinkId !== undefined,
{ message: 'A drain receipt belongs to a target-link replacement.' }), z.refine(link => link.source?.kind === 'plugin'
  ? link.targetKind !== undefined && link.machines.length === 0
    && (link.machineId === undefined) === (link.installationId === undefined)
  : link.role === 'runtime' && (link.targetKind === undefined || link.targetKind === 'ownServer')
    && link.machines.length > 0 && link.machineId === undefined && link.installationId === undefined
    && (link.source === undefined || link.source.id === link.targetId),
{ message: 'A link selects one host membership or plugin identity and placement arm.' }),
z.refine(link => link.provisioned !== true || link.source?.kind === 'plugin' && link.role === 'runtime',
{ message: 'Only a created runtime provider resource is provisioned.' })));
/** Storage always receives prepared content; the public Action may author it in host custody. */
export const DeploymentTargetLinkInputV1Schema = lazyZodSchema(() => z.safeExtend(
  DeploymentTargetLinkIntentInputV1Schema, DeploymentArtifactContentReferenceV1Schema.shape,
));
/** Private provider operands are authored into an Artifact by the admitted Action host. */
export const DeploymentTargetLinkProviderIntentInputV1Schema = lazyZodSchema(() => z.safeExtend(
  DeploymentTargetLinkIntentInputV1Schema, {
    source: deploymentPluginTargetSourceV1Schema,
    targetKind: DeploymentIdentifierV1Schema,
    provider: DeploymentTargetLinkProviderContentV1Schema,
    /** Selected resource presentation, written only to the private TargetLink Artifact header. */
    title: z.optional(z.string()),
  },
));
export type DeploymentTargetLinkProviderIntentInputV1 = z.infer<typeof DeploymentTargetLinkProviderIntentInputV1Schema>;
/** A reviewed create has an Account and requested name, never a guessed native resource id. */
export const DeploymentTargetLinkCreateIntentInputV1Schema = lazyZodSchema(() => z.safeExtend(
  DeploymentTargetLinkIntentInputV1Schema, {
    source: deploymentPluginTargetSourceV1Schema, targetKind: DeploymentIdentifierV1Schema,
    role: z.literal('runtime'),
    providerCreate: z.omit(DeploymentTargetCreateInputV1Schema, {
      v: true, serverId: true, environmentId: true, expectedRevision: true, requestKey: true,
    }),
    title: z.optional(z.string()),
  },
));
export type DeploymentTargetLinkCreateIntentInputV1 = z.infer<typeof DeploymentTargetLinkCreateIntentInputV1Schema>;
export const DeploymentTargetLinkActionInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentTargetLinkInputV1Schema,
  z.safeExtend(DeploymentTargetLinkIntentInputV1Schema, { source: z.optional(deploymentHostTargetSourceV1Schema) }),
  DeploymentTargetLinkProviderIntentInputV1Schema,
  DeploymentTargetLinkCreateIntentInputV1Schema,
]));
/** Native admission may refuse teardown before a receipt exists. */
export const DeploymentTeardownRefusalDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  reason: DeploymentIdentifierV1Schema,
  remedy: z.string().check(z.minLength(1)),
  requiredFact: z.optional(z.string().check(z.minLength(1))),
}));
export type DeploymentTeardownRefusalDetailsV1 = z.infer<typeof DeploymentTeardownRefusalDetailsV1Schema>;
/** Native retirement completed, but final Home removal failed or is unverified. */
export const DeploymentTeardownEnvironmentPartialDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  environmentId: DeploymentIdentifierV1Schema,
  step: z.literal('removeEnvironment'),
  partial: z.literal(true),
  requiredFact: z.literal('environmentRemoval'),
  remedy: z.string().check(z.minLength(1)),
}));
export type DeploymentTeardownEnvironmentPartialDetailsV1 = z.infer<typeof DeploymentTeardownEnvironmentPartialDetailsV1Schema>;
/** Only the installation-signed settlement writer can assert owned-resource absence. */
export const DeploymentTeardownProofV1Schema = lazyZodSchema(() => z.strictObject({
  removeEnvironment: z.optional(DeploymentTeardownDispositionV1Schema.shape.removeEnvironment),
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
export const DEPLOYMENT_STOP_ACCEPTED_HEADER_V1 = "x-happier-deployment-stop-accepted";
export const DeploymentCancelTransitionInputV1Schema = lazyZodSchema(() => z.extend(DeploymentCancelInputV1Schema, {
  kind: z.literal('cancel'),
}));
export type DeploymentCancelInputV1 = z.infer<typeof DeploymentCancelInputV1Schema>;

/** Explicit pre-delivery absence can still record Stop at Home. An uncertain delivered request never re-enters. */
export function canRecordDeploymentStopWithoutControllerV1(result: ActionExecuteFailure): boolean {
  return result.effectAttempted === false && (result.errorCode === 'machine_unavailable'
    || result.errorCode === 'target_unavailable' || result.errorCode === 'machine_offline'
    || result.errorCode === 'machine_not_found' || result.errorCode === 'access_denied'
    || result.errorCode === 'machine_inventory_unavailable');
}
export type DeploymentCancelTransitionInputV1 = z.infer<typeof DeploymentCancelTransitionInputV1Schema>;
/** Private cleanup transport of the existing Action-operation cancellation owner. */
export const DeploymentPendingCancelInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, actionOperationId: DeploymentIdentifierV1Schema, pendingDeploy: DeploymentPendingDeployV1Schema,
}));
export type DeploymentPendingCancelInputV1 = z.infer<typeof DeploymentPendingCancelInputV1Schema>;
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
export const DeploymentMachinePlacementDiagnosticV1Schema = lazyZodSchema(() => z.union([
  MachineAvailabilityDiagnosticV1Schema,
  z.strictObject({ reason: z.literal('source_machine_access_missing'), requiredFact: z.literal('source_machine_use'),
    remedy: z.literal('share_machine_with_source_owner') }),
]));
export type DeploymentMachinePlacementDiagnosticV1 = z.infer<typeof DeploymentMachinePlacementDiagnosticV1Schema>;
export const DeploymentMachineUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false), error: z.literal('machine_unavailable'),
  role: z.enum(['controller', 'build', 'target', 'telemetry']), machineIds: z.array(DeploymentIdentifierV1Schema).check(z.minLength(1)),
  nextActions: z.array(z.enum(['start', 'chooseAnother', 'removeFromEnvironment'])).check(z.minLength(1)),
  diagnostic: z.optional(DeploymentMachinePlacementDiagnosticV1Schema), effectAttempted: z.optional(z.literal(false)),
}));
export type DeploymentMachineUnavailableV1 = z.infer<typeof DeploymentMachineUnavailableV1Schema>;
export const DeploymentActionFailureV1Schema = lazyZodSchema(() => z.union([
  z.extend(ArtifactQuotaExceededV1Schema, { ok: z.literal(false) }),
  DeploymentInvalidV1Schema,
  z.strictObject({ ...ActionExecuteFailureSchema.shape,
    errorCode: z.literal('unsupported_action'), error: z.literal('unsupported_action'),
    effectAttempted: z.literal(false), details: DeploymentTeardownRefusalDetailsV1Schema,
    failureCause: ActionFailureCauseV1Schema }),
  z.strictObject({ ok: z.literal(false), error: z.enum(['deployment_unavailable',
    'deployment_access_denied', 'deployment_conflict', 'telemetry_bearer_in_use', 'deployment_content_unavailable',
    'deployment_teardown_required', 'unsupported_action', 'client_required']) }),
  z.strictObject({ ok: z.literal(false), error: z.literal('deployment_in_progress'),
    deploymentId: DeploymentIdentifierV1Schema, href: DeploymentIdentifierV1Schema }),
  DeploymentMachineUnavailableV1Schema,
]));
export type DeploymentActionFailureV1 = z.infer<typeof DeploymentActionFailureV1Schema>;
const result = { ok: z.literal(true), environmentId: DeploymentIdentifierV1Schema, revision: DeploymentRevisionV1Schema };
export const DeploymentDomainMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, domain: DeploymentDomainHeaderV1Schema, tunnel: z.optional(DeploymentDomainTunnelDispositionV1Schema) }),
  DeploymentDomainIdInUseFailureV1Schema, DeploymentActionFailureV1Schema,
]));
export const DeploymentDomainListResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, domains: z.array(DeploymentDomainHeaderV1Schema), nextCursor: z.nullable(DeploymentIdentifierV1Schema) }),
  DeploymentActionFailureV1Schema,
]));
export type DeploymentDomainMutationResultV1 = z.infer<typeof DeploymentDomainMutationResultV1Schema>;
export const DeploymentTargetUnlinkResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, targetLinkId: DeploymentIdentifierV1Schema,
    targetLinkRevision: DeploymentRevisionV1Schema, detached: z.boolean() }), DeploymentActionFailureV1Schema,
]));
export const DeploymentEnvironmentDeleteResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, detached: z.boolean() }), DeploymentActionFailureV1Schema,
]));
export type DeploymentTargetUnlinkResultV1 = z.infer<typeof DeploymentTargetUnlinkResultV1Schema>;
export type DeploymentEnvironmentDeleteResultV1 = z.infer<typeof DeploymentEnvironmentDeleteResultV1Schema>;
export const DeploymentPreviewDataTargetsV1Schema = lazyZodSchema(() => z.array(z.strictObject({
  templateDataTargetLinkId: DeploymentIdentifierV1Schema, targetLinkId: DeploymentIdentifierV1Schema,
  targetLinkRevision: DeploymentRevisionV1Schema,
})));
export const DeploymentEnvironmentCreateResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, projectSourceId: z.optional(DeploymentIdentifierV1Schema),
    replayed: z.optional(z.boolean()),
    runtimeTargetLinkId: z.optional(DeploymentIdentifierV1Schema),
    previewDataTargets: z.optional(DeploymentPreviewDataTargetsV1Schema),
    previewCompanionRequired: z.optional(z.literal(true)),
    // Authored companion bindings; the bindings.set writer assigns grant addresses.
    previewNativeBindings: z.optional(z.array(EnvironmentVariableBindingInputV1Schema)),
    previewNativeData: z.optional(z.array(z.strictObject({ service: DeploymentIdentifierV1Schema,
      database: DeploymentIdentifierV1Schema }))),
  }), DeploymentActionFailureV1Schema,
  z.strictObject({ ok: z.literal(false), error: z.literal('deployment_preview_not_enrolled') }),
]));
export type DeploymentEnvironmentCreateResultV1 = z.infer<typeof DeploymentEnvironmentCreateResultV1Schema>;
export const DeploymentPreviewEnrollmentV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('enrolled') }),
  z.strictObject({ status: z.literal('disabled') }),
  z.strictObject({ status: z.literal('unavailable'), errorCode: z.string(), failureCause: z.optional(ActionFailureCauseV1Schema) }),
]));
export type DeploymentPreviewEnrollmentV1 = z.infer<typeof DeploymentPreviewEnrollmentV1Schema>;
/** Enrollment follows the persisted edit; a source refusal cannot undo that edit. */
export const DeploymentEnvironmentUpdateResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, projectSourceId: z.optional(DeploymentIdentifierV1Schema),
    preparedArtifact: z.optional(DeploymentArtifactContentReferenceV1Schema),
    creationDefaults: z.optional(ResolvedDeploymentCreationDefaultsV1Schema),
    backupSourceChoices: z.optional(z.array(DeploymentBackupSourceV1Schema)),
    forkEligibility: z.optional(DeploymentPreviewForkEligibilityV1Schema),
    previewWatcher: z.optional(z.strictObject({
      service: asProtocolZod(PluginContributionIdentityV1Schema),
      options: z.array(z.strictObject({ value: ConnectedAccountActionFormSelectionV1Schema, label: z.string() })),
    })),
    previewEnrollment: z.optional(DeploymentPreviewEnrollmentV1Schema) }), DeploymentActionFailureV1Schema,
]));
/** The preparing host returns its exact candidate for the Team Move sharing consumer. */
export const DeploymentBindingsSetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, preparedArtifact: z.optional(DeploymentArtifactContentReferenceV1Schema),
    providerVariables: z.optional(z.strictObject({ v: z.literal(1),
        variables: DeploymentTargetVariablesReadResultV1Schema.shape.variables,
        failures: DeploymentTargetVariablesSyncResultV1Schema.shape.failures,
        telemetryDestination: DeploymentTargetVariablesSyncResultV1Schema.shape.telemetryDestination, persisted: z.boolean() })) }),
  DeploymentActionFailureV1Schema,
]));
export type DeploymentBindingsSetResultV1 = z.infer<typeof DeploymentBindingsSetResultV1Schema>;
export const DeploymentTargetLinkAlreadyLinkedResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false), error: z.literal('provider_scope_already_linked'),
  environment: DeploymentEnvironmentRefV1Schema, targetLinkId: DeploymentIdentifierV1Schema,
}));
export type DeploymentTargetLinkAlreadyLinkedResultV1 = z.infer<typeof DeploymentTargetLinkAlreadyLinkedResultV1Schema>;

export const DeploymentTargetCheckInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentIdentifierV1Schema,
  projectSourceId: DeploymentIdentifierV1Schema,
  environmentId: z.optional(DeploymentIdentifierV1Schema),
  controllerMachineId: z.optional(DeploymentIdentifierV1Schema),
  target: asProtocolZod(PluginContributionIdentityV1Schema),
  credentialRef: asProtocolZod(QualifiedConnectedAccountRefSchema),
  fields: withStrictJsonInput(z.record(z.string(), z.json())),
}));
export type DeploymentTargetCheckInputV1 = z.infer<typeof DeploymentTargetCheckInputV1Schema>;
export const DeploymentTargetCheckResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), provider: DeploymentTargetLinkProviderContentV1Schema }),
  z.strictObject({ kind: z.literal('needsGitAccess'), provider: DeploymentTargetLinkProviderContentV1Schema,
    grantUrl: z.nullable(z.string()) }),
  z.strictObject({ kind: z.literal('alreadyLinked'), association: DeploymentTargetLinkAlreadyLinkedResultV1Schema }),
]));
export type DeploymentTargetCheckResultV1 = z.infer<typeof DeploymentTargetCheckResultV1Schema>;

/** The native resource exists; retry only this retained exact association, never create again. */
export const DeploymentTargetLinkProvisionedResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false), error: z.literal('deployment_link_incomplete'),
  recovery: DeploymentTargetLinkProviderIntentInputV1Schema,
  failure: z.optional(ActionExecuteFailureSchema),
}));
export type DeploymentTargetLinkProvisionedResultV1 = z.infer<typeof DeploymentTargetLinkProvisionedResultV1Schema>;

/** Direct execution and retained operation reads expose the same acknowledged-resource recovery. */
export function projectDeploymentTargetLinkFailureV1(actionId: string, value: unknown): ActionExecuteFailure | null {
  if (!isDeploymentTargetLinkActionIdV1(actionId)) return null;
  const retained = DeploymentTargetLinkProvisionedResultV1Schema.safeParse(value);
  if (!retained.success) return null;
  return { ok: false, errorCode: retained.data.error, error: retained.data.error, details: retained.data,
    ...(retained.data.recovery.provider.providerResourceOrigin === 'created' ? { effectAttempted: true } : {}),
    ...(retained.data.failure?.failureCause ? { failureCause: retained.data.failure.failureCause } : {}) };
}

export const DeploymentTargetLinkResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...result, targetLinkId: DeploymentIdentifierV1Schema, targetLinkRevision: DeploymentRevisionV1Schema,
    productionBranchOutcome: z.optional(DeploymentTargetProductionBranchOutcomeV1Schema),
    failureObserver: z.optional(z.union([
      z.strictObject({ status: z.literal('unavailable'),
        errorCode: z.optional(ActionExecuteFailureSchema.shape.errorCode), failureCause: ActionFailureCauseV1Schema,
        requiredFact: z.optional(DeploymentFailureRecoveryV1Schema.shape.requiredFact),
        remedy: z.optional(DeploymentFailureRecoveryV1Schema.shape.remedy),
        readBack: z.optional(PlatformFailureEnrollmentReadBackV1Schema) }),
      PlatformFailureEnrollmentV1Schema,
    ])),
  }),
  DeploymentTargetLinkAlreadyLinkedResultV1Schema,
  DeploymentTargetLinkProvisionedResultV1Schema,
  DeploymentActionFailureV1Schema,
]));
export const DeploymentReceiptResultV1Schema = lazyZodSchema(() => z.union([
  ...DeploymentReceiptAcceptedResultV1Schema._zod.def.options,
  DeploymentActionFailureV1Schema,
]));
export const DeploymentTeardownResultV1Schema = lazyZodSchema(() => z.union([
  DeploymentTeardownPreviewV1Schema,
  z.strictObject({ ...result, nothingDeployed: z.literal(true), environmentRemoved: z.literal(true) }),
  DeploymentReceiptResultV1Schema, DeploymentTargetUnlinkResultV1Schema,
]));
const deploymentEnvironmentReadAddress = {
  ...home, environmentId: DeploymentIdentifierV1Schema,
};
export const DeploymentEnvironmentGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...deploymentEnvironmentReadAddress, includeRetainedTargetLinkCleanup: z.optional(z.literal(true)),
  /** Account-host-only demand for the selected plugin's live Links in this Environment. */
  linkCoordinatesForPlugin: z.optional(asProtocolZod(PluginIdSchema)),
  backupPolicy: z.optional(DeploymentBackupPolicyV1Schema),
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
/**
 * Content-free routing for one deploy submission (plan 40 §6.8): the Environment's
 * current controller, read before an encrypted request seals its target. Success
 * also confirms the authenticated Home identity. Home still admits the deploy itself.
 */
export const DEPLOYMENT_ENVIRONMENT_CONTROLLER_HTTP_PATH_TEMPLATE_V1 = '/v1/deployments/environments/:environmentId/controller';
export const DeploymentEnvironmentControllerInputV1Schema = lazyZodSchema(() => z.strictObject({ ...home }));
export const DeploymentEnvironmentControllerResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), serverId: DeploymentIdentifierV1Schema, environmentId: DeploymentIdentifierV1Schema,
    controllerMachineId: DeploymentIdentifierV1Schema }),
  DeploymentActionFailureV1Schema,
]));
export type DeploymentEnvironmentControllerResultV1 = z.infer<typeof DeploymentEnvironmentControllerResultV1Schema>;
export const DeploymentReceiptGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, environmentId: z.optional(DeploymentIdentifierV1Schema), deploymentId: DeploymentIdentifierV1Schema,
  /** Open exact private evidence on the Account host; never forwarded to metadata storage. */
  projection: z.optional(z.enum(['investigation', 'previewHead'])),
}));
/** Observe an already-issued provider deployment; the host reads its retained identity and custody. */
export const DeploymentReceiptObserveInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...deploymentEnvironmentReadAddress, deploymentId: DeploymentIdentifierV1Schema,
}));
/** Native projection of private deployment observation facts; never an Artifact reader. */
export const DeploymentObservationGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...deploymentEnvironmentReadAddress, targetLinkId: DeploymentIdentifierV1Schema,
  deploymentId: z.optional(DeploymentIdentifierV1Schema), variables: z.optional(z.literal(true)),
}));
export const DeploymentObservationGetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), environment: DeploymentEnvironmentHeaderV1Schema,
    targetLink: DeploymentTargetLinkHeaderV1Schema, credentialPrincipal: DeploymentTargetCredentialPrincipalV1Schema,
    providerVariables: z.optional(DeploymentTargetVariablesReadResultV1Schema),
    receipt: z.optional(z.strictObject({ deployment: DeploymentReceiptHeaderV1Schema,
      providerDeploymentId: DeploymentIdentifierV1Schema })) }), DeploymentActionFailureV1Schema,
]));
export const DeploymentEnvironmentGetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), environment: DeploymentEnvironmentHeaderV1Schema,
    backupTarget: z.optional(DeploymentBackupRunInputV1Schema), backupPolicy: z.optional(DeploymentBackupPolicyV1Schema),
    savedSecretRevisions: z.optional(DeploymentBindingSavedSecretRevisionsV1Schema),
    secretScope: z.optional(DeploymentEnvironmentSecretScopeV1Schema),
    /** Present only while a runtime Machine was reinstalled since the Environment last deployed there. */
    runtimeReinstall: z.optional(DeploymentRuntimeReinstallV1Schema),
    controller: z.optional(DeploymentControllerAvailabilityV1Schema),
    targetLinks: z.array(DeploymentTargetLinkHeaderV1Schema), pendingDeploy: z.optional(DeploymentPendingDeployV1Schema),
    /** Opened by the Account host after the exact Environment read. */
    targetLinkCoordinates: z.optional(z.array(z.strictObject({
      targetLinkId: DeploymentIdentifierV1Schema, providerIdentity: DeploymentTargetProviderIdentityV1Schema,
    }))),
    retainedTargetLinkCleanupCompleteIds: z.optional(z.array(DeploymentIdentifierV1Schema)),
    pendingAdmission: z.optional(DeploymentPendingAdmissionV1Schema) }), DeploymentActionFailureV1Schema,
]));
export const DeploymentEnvironmentGetResultV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(DeploymentEnvironmentGetResultV1Schema));
export type DeploymentEnvironmentGetResultV1 = z.infer<typeof DeploymentEnvironmentGetResultV1Schema>;
export const DeploymentReceiptGetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), deployment: DeploymentReceiptHeaderV1Schema,
    failureSummary: z.optional(z.nullable(DeploymentReceiptFailureSummaryV1Schema)),
    /** Account-opened native evidence; absent from server metadata reads. */
    investigation: z.optional(DeploymentReceiptInvestigationV1Schema),
    /** Exact live Preview facts opened by the Account host with its admitted read. */
    previewHead: z.optional(z.strictObject({
      templateEnvironmentId: DeploymentIdentifierV1Schema,
      repository: ScmHostingRepositoryIdentityV1Schema,
      pullRequestId: DeploymentIdentifierV1Schema,
      pullRequestNumber: z.number().check(z.int(), z.positive()),
      deployedSha: DeploymentRepositorySourceIntentV1Schema.shape.sha,
    })),
    cancellationConsequence: z.optional(DeploymentCancellationConsequenceV1Schema),
    /** Admitted read-time presentation fact. Absent on older readers, never inferred by clients. */
    cancellable: z.optional(z.boolean()) }), DeploymentActionFailureV1Schema,
]));
export const DeploymentEnvironmentListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, projectSourceId: z.optional(DeploymentIdentifierV1Schema), machineId: z.optional(DeploymentIdentifierV1Schema),
  // Source moves and one exact PR's retained previews need history; ordinary inventory stays live-only.
  includeDeleted: z.optional(z.literal(true)),
  /** Explicit full-selection header census; ordinary pages do not request it. */
  includeTotal: z.optional(z.literal(true)),
  /** Metadata-only Account/Source summary, independent of inventory continuation. */
  projection: z.optional(z.literal('activity')),
  /** Move destination choice: the page's live data links this requester may read, admitted like the exact reader. */
  dataTargetLinks: z.optional(z.literal(true)),
  // Exact visible owner headers, not an inventory crawl. All inventory omits
  // this field; an empty public vector must not disappear in GET encoding.
  environmentIds: z.optional(z.array(DeploymentIdentifierV1Schema).check(z.minLength(1))),
  previewRepositoryId: z.optional(DeploymentIdentifierV1Schema),
  previewRepository: z.optional(ScmHostingRepositoryIdentityV1Schema),
  previewPullRequestIds: z.optional(z.array(deploymentPreviewPullRequestIdV1Schema).check(z.minLength(1))),
  previewTemplateEnvironmentId: z.optional(DeploymentIdentifierV1Schema),
  previewCompanionOfEnvironmentId: z.optional(DeploymentIdentifierV1Schema),
  cursor: ProjectSourcesListInputV1Schema.shape.cursor, limit: ProjectSourcesListInputV1Schema.shape.limit,
}).check(z.refine(input => input.includeDeleted !== true || input.projectSourceId !== undefined
    || input.previewRepository !== undefined && input.previewPullRequestIds !== undefined
    || input.previewCompanionOfEnvironmentId !== undefined),
  z.refine(input => (input.previewRepositoryId !== undefined || input.previewRepository !== undefined) === (input.previewPullRequestIds !== undefined)
    && !(input.previewRepositoryId !== undefined && input.previewRepository !== undefined),
    { message: 'Preview reads select one repository relation or identity and exact pull request ids together.' }),
  z.refine(input => input.projection !== 'activity' || (input.machineId === undefined && input.environmentIds === undefined
    && input.previewRepositoryId === undefined && input.previewRepository === undefined && input.previewTemplateEnvironmentId === undefined
    && input.previewCompanionOfEnvironmentId === undefined
    && input.cursor === undefined && input.limit === undefined && input.includeDeleted === undefined && input.includeTotal === undefined
    && input.dataTargetLinks === undefined),
    { message: 'Activity selects one Home or Source, without an inventory page or Machine filter.' })));
export const DeploymentReceiptListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...deploymentEnvironmentReadAddress,
  teardownRequestKey: z.optional(DeploymentReceiptMetadataV1Schema.shape.requestKey),
  state: z.optional(DeploymentReceiptMetadataV1Schema.shape.state),
  actorAccountId: z.optional(DeploymentIdentifierV1Schema),
  requestedAtFromMs: z.optional(DeploymentTimestampV1Schema),
  requestedAtToMs: z.optional(DeploymentTimestampV1Schema),
  operation: z.optional(DeploymentReceiptMetadataV1Schema.shape.operation),
  inProgressOnly: z.optional(z.literal(true)),
  cursor: ProjectSourcesListInputV1Schema.shape.cursor, limit: ProjectSourcesListInputV1Schema.shape.limit,
}));
const deploymentProjectSourcePresentationV1Schema = lazyZodSchema(() => z.pick(ProjectSourceV1Schema, { id: true, name: true }));
export const DeploymentEnvironmentListResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), items: z.array(z.extend(DeploymentEnvironmentHeaderV1Schema, {
    /** Private display title opened by the Action host; never plaintext Home metadata. */
    name: z.optional(z.string()),
  })),
    /** Exact admitted Source presentation; its existing metadata contract owns name disclosure. */
    projectSources: z.optional(z.array(deploymentProjectSourcePresentationV1Schema)),
    /** Authorized header total for this query, independent of cursor and page size. */
    totalCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    runtimeTargetLinks: z.optional(z.array(DeploymentTargetLinkHeaderV1Schema)),
    /** Present only when demanded: live data links on this page whose content the requester may read. */
    dataTargetLinks: z.optional(z.array(DeploymentTargetLinkHeaderV1Schema)),
    /** Current runtime custody, independent of the latest attempt. Private bytes stay in Artifacts. */
    servingDeployments: z.optional(z.array(DeploymentReceiptHeaderV1Schema)),
    liveAddressDomains: z.optional(z.array(DeploymentDomainHeaderV1Schema)),
    currentDeployments: z.optional(z.array(DeploymentReceiptHeaderV1Schema)), nextCursor: z.nullable(DeploymentIdentifierV1Schema),
    activity: z.optional(z.strictObject({ running: z.boolean(), failed: z.boolean(),
      /** Number of readable Environments whose latest attempt is running or failed. */
      attentionCount: z.optional(z.number().check(z.int(), z.nonnegative())),
      /** Number of readable Environments with at least one deploy attempt (the rail's "has deployments" fact). */
      environmentCount: z.optional(z.number().check(z.int(), z.nonnegative())),
    })),
    coverage: z.optional(z.enum(['complete', 'partial'])) }),
  DeploymentActionFailureV1Schema,
]));
export const DeploymentReceiptListResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), items: z.array(z.union([
    z.extend(DeploymentReceiptHeaderV1Schema, DeploymentFailureRecoveryV1Schema.shape),
    DeploymentReceiptHeaderV1Schema,
  ])), nextCursor: z.nullable(DeploymentIdentifierV1Schema),
  /** Archive-retirement executor only: page receipts a deployment in another live Environment descends from. */
  liveReferencedDeploymentIds: z.optional(z.array(DeploymentIdentifierV1Schema)) }),
  DeploymentActionFailureV1Schema,
]));

/** Admit an entire Home history page before a reader consumes any of its rows. */
export function decodeDeploymentReceiptHistoryPageV1(value: unknown, environmentId: string) {
  const parsed = DeploymentReceiptListResultV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'invalid_response' } as const;
  const page = parsed.data;
  if (page.ok && page.items.some(row => row.environmentId !== environmentId)) {
    return { ok: false, error: 'deployment_invalid' } as const;
  }
  return page;
}

/** One admitted Account page; private Artifact content remains opaque on the Home. */
export const DeploymentDomainPageInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, projectSourceId: z.optional(DeploymentIdentifierV1Schema),
  cursor: ProjectSourcesListInputV1Schema.shape.cursor, limit: ProjectSourcesListInputV1Schema.shape.limit,
}));
export const DeploymentDataPageInputV1Schema = DeploymentDomainPageInputV1Schema;
export type DeploymentDomainPageInputV1 = z.infer<typeof DeploymentDomainPageInputV1Schema>;
export type DeploymentDataPageInputV1 = z.infer<typeof DeploymentDataPageInputV1Schema>;
export const DeploymentDomainPageSuccessV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), items: z.array(z.strictObject({
    domain: DeploymentDomainHeaderV1Schema, environment: DeploymentEnvironmentHeaderV1Schema,
  })), artifacts: z.array(ArtifactHttpReadV1Schema), nextCursor: z.nullable(DeploymentIdentifierV1Schema),
  projectSources: z.optional(z.array(deploymentProjectSourcePresentationV1Schema)),
  coverage: z.optional(z.enum(['complete', 'partial'])),
}));
export const DeploymentDataPageSuccessV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), items: z.array(z.strictObject({ environment: DeploymentEnvironmentHeaderV1Schema })),
  artifacts: z.array(ArtifactHttpReadV1Schema), nextCursor: z.nullable(DeploymentIdentifierV1Schema),
  projectSources: z.optional(z.array(deploymentProjectSourcePresentationV1Schema)),
  coverage: z.optional(z.enum(['complete', 'partial'])),
}));
export type DeploymentDomainPageSuccessV1 = z.infer<typeof DeploymentDomainPageSuccessV1Schema>;
export type DeploymentDataPageSuccessV1 = z.infer<typeof DeploymentDataPageSuccessV1Schema>;
export const DeploymentDomainPageResultV1Schema = lazyZodSchema(() => z.union([
  DeploymentDomainPageSuccessV1Schema, DeploymentActionFailureV1Schema,
]));
export const DeploymentDataPageResultV1Schema = lazyZodSchema(() => z.union([
  DeploymentDataPageSuccessV1Schema, DeploymentActionFailureV1Schema,
]));
export type DeploymentDomainPageResultV1 = z.infer<typeof DeploymentDomainPageResultV1Schema>;
export type DeploymentDataPageResultV1 = z.infer<typeof DeploymentDataPageResultV1Schema>;
/** Header-only storage demand used by the existing target-link preparation. */
export const DeploymentTargetScopeV1Schema = lazyZodSchema(() => ProjectSourceOwnerV1Schema);
export type DeploymentTargetScopeV1 = z.infer<typeof DeploymentTargetScopeV1Schema>;
export const DeploymentTargetLinksListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...home, scope: DeploymentTargetScopeV1Schema,
  selection: z.optional(z.strictObject({ source: DeploymentTargetSourceV1Schema, targetKind: DeploymentIdentifierV1Schema })),
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
export const DeploymentHealthCurrentResultV1Schema = lazyZodSchema(() => z.union([DeploymentHealthCurrentSuccessV1Schema, DeploymentActionFailureV1Schema]));
export type DeploymentHealthCurrentResultV1 = z.infer<typeof DeploymentHealthCurrentResultV1Schema>;
export const DeploymentHealthReadResultV1Schema = lazyZodSchema(() => z.union([DeploymentHealthReadSuccessV1Schema, DeploymentActionFailureV1Schema]));
export const DeploymentDriftReadResultV1Schema = lazyZodSchema(() => z.union([DeploymentDriftReadSuccessV1Schema, DeploymentActionFailureV1Schema]));
export const DeploymentLogsReadResultV1Schema = lazyZodSchema(() => z.union([DeploymentLogsReadSuccessV1Schema, DeploymentActionFailureV1Schema]));
export type DeploymentHealthReadResultV1 = z.infer<typeof DeploymentHealthReadResultV1Schema>;
export type DeploymentDriftReadResultV1 = z.infer<typeof DeploymentDriftReadResultV1Schema>;
export type DeploymentLogsReadResultV1 = z.infer<typeof DeploymentLogsReadResultV1Schema>;
export const DeploymentDataSizeResultV1Schema = lazyZodSchema(() => z.union([DeploymentDataSizeSuccessV1Schema, DeploymentActionFailureV1Schema]));
export type DeploymentDataSizeResultV1 = z.infer<typeof DeploymentDataSizeResultV1Schema>;
// Domain leaf imports legitimately reach this catalog through installation and
// access-provider contracts. Admit catalog bindings on first use, not ESM load.
// Reading a sibling Action can admit the map while templates are still loading;
// keep their forwarded schemas deferred for that whole cyclic load.
export const DeploymentActionInputSchemasV1 = lazyDefinition(() => ({
  'deployments.environments.telemetry.set': DeploymentEnvironmentTelemetrySetInputV1Schema,
  ...DeploymentBackupActionInputSchemasV1,
  'deployments.backups.configure': DeploymentBackupConfigureInputV1Schema,
  'deployments.domains.dns.create': DeploymentDomainDnsInputV1Schema,
  'deployments.domains.dns.verify': DeploymentDomainDnsInputV1Schema,
  'deployments.domains.add': DeploymentDomainAddInputV1Schema,
  'deployments.domains.remove': DeploymentDomainRemoveInputV1Schema,
  'deployments.domains.verify': DeploymentDomainVerifyInputV1Schema,
  'deployments.domains.get': DeploymentDomainGetInputV1Schema,
  'deployments.domains.list': DeploymentDomainListInputV1Schema,
  'deployments.domains.page': DeploymentDomainPageInputV1Schema,
  'deployments.data.page': DeploymentDataPageInputV1Schema,
  'deployments.publish.prepare': DeploymentPublishPrepareInputV1Schema,
  'deployments.templates.instantiate': lazyZodSchema(() => deploymentTemplates.DeploymentTemplateInstantiateInputV1Schema),
  'deployments.environments.moveToRepository': DeploymentMoveToRepositoryInputV1Schema,
  'deployments.health.read': DeploymentHealthReadInputV1Schema,
  'deployments.health.current': DeploymentHealthCurrentInputV1Schema,
  'deployments.drift.read': DeploymentDriftReadInputV1Schema,
  'deployments.logs.read': DeploymentLogsReadInputV1Schema,
  'deployments.data.size': DeploymentDataSizeInputV1Schema,
  'deployments.prepare': DeploymentPrepareInputV1Schema,
  'deployments.environments.create': DeploymentEnvironmentCreateActionInputV1Schema,
  'deployments.environments.update': DeploymentEnvironmentUpdateInputV1Schema,
  'deployments.environments.controller.set': DeploymentEnvironmentControllerSetInputV1Schema,
  'deployments.targets.link': DeploymentTargetLinkActionInputV1Schema,
  'deployments.targets.unlink': DeploymentTargetUnlinkInputV1Schema,
  'deployments.environments.delete': DeploymentEnvironmentDeleteInputV1Schema,
  'deployments.deploy': DeploymentDeployActionInputV1Schema,
  'deployments.rollback': DeploymentRollbackActionInputV1Schema,
  'deployments.restart': DeploymentRestartInputV1Schema,
  'deployments.backups.restore': DeploymentBackupRestoreInputV1Schema,
  'deployments.teardown': DeploymentTeardownActionInputV1Schema,
  'deployments.cancel': DeploymentCancelInputV1Schema,
  'deployments.promote': DeploymentPromoteActionInputV1Schema,
  'deployments.environments.get': DeploymentEnvironmentGetInputV1Schema,
  'deployments.receipts.get': DeploymentReceiptGetInputV1Schema,
  'deployments.receipts.observe': DeploymentReceiptObserveInputV1Schema,
  'deployments.observation.get': DeploymentObservationGetInputV1Schema,
  'deployments.bindings.set': DeploymentBindingsSetInputV1Schema,
  'deployments.environments.list': DeploymentEnvironmentListInputV1Schema,
  'deployments.receipts.list': DeploymentReceiptListInputV1Schema,
} as const));
/** One-shot values and their review-only origin; no default pointer is saved on the Environment. */
export const DeploymentEnvironmentCreationReviewV1Schema = lazyZodSchema(() => z.extend(z.pick(
  deploymentTemplates.DeploymentTemplateInstantiationReviewV1Schema, { creationDefaultsBasis: true }), {
  creationDefaults: z.nonoptional(deploymentTemplates.DeploymentTemplateInstantiationReviewV1Schema.shape.creationDefaults),
  definitionCommitment: DeploymentEnvironmentCreateInputV1Schema.shape.copyIntentCommitment,
  template: z.optional(deploymentTemplates.DeploymentTemplateInstantiationReviewV1Schema),
  copy: z.optional(DeploymentEnvironmentCopyReviewV1Schema),
  folder: z.optional(DeploymentFolderReviewRevisionV1Schema),
  previewCreate: z.optional(z.strictObject({
    projectName: DeploymentTextV1Schema, environmentName: DeploymentTextV1Schema,
    pullRequestNumber: z.number().check(z.int(), z.positive()),
    pullRequestTitle: z.optional(DeploymentTextV1Schema),
  })),
}));
export type DeploymentEnvironmentCreationReviewV1 = z.infer<typeof DeploymentEnvironmentCreationReviewV1Schema>;
export const DeploymentEnvironmentCreatePreviewV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('preview'), input: z.union([DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema]), review: DeploymentEnvironmentCreationReviewV1Schema,
}));
export type DeploymentEnvironmentCreatePreviewV1 = z.infer<typeof DeploymentEnvironmentCreatePreviewV1Schema>;
export const DeploymentEnvironmentCreateActionResultV1Schema = lazyZodSchema(() => z.union([
  DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentCreatePreviewV1Schema,
]));
export const DeploymentActionOutputSchemasV1 = lazyDefinition(() => ({
  'deployments.environments.telemetry.set': lazyZodSchema(() => z.union([DeploymentEnvironmentTelemetrySetSuccessV1Schema, DeploymentActionFailureV1Schema])),
  ...DeploymentBackupActionResultSchemasV1,
  'deployments.backups.configure': DeploymentBackupConfigureResultV1Schema,
  'deployments.domains.dns.create': DeploymentDomainDnsResultV1Schema,
  'deployments.domains.dns.verify': DeploymentDomainDnsResultV1Schema,
  'deployments.domains.add': DeploymentDomainMutationResultV1Schema,
  'deployments.domains.remove': DeploymentDomainMutationResultV1Schema,
  'deployments.domains.verify': lazyZodSchema(() => z.union([DeploymentDomainMutationResultV1Schema, DeploymentDomainDnsPreviewResultV1Schema])),
  'deployments.domains.get': DeploymentDomainMutationResultV1Schema,
  'deployments.domains.list': DeploymentDomainListResultV1Schema,
  'deployments.domains.page': DeploymentDomainPageResultV1Schema,
  'deployments.data.page': DeploymentDataPageResultV1Schema,
  'deployments.publish.prepare': DeploymentPublishPrepareResultV1Schema,
  'deployments.templates.instantiate': lazyZodSchema(() => deploymentTemplates.DeploymentTemplateInstantiateResultV1Schema),
  'deployments.environments.moveToRepository': DeploymentMoveToRepositoryResultV1Schema,
  'deployments.health.read': DeploymentHealthReadResultV1Schema,
  'deployments.health.current': DeploymentHealthCurrentResultV1Schema,
  'deployments.drift.read': DeploymentDriftReadResultV1Schema,
  'deployments.logs.read': DeploymentLogsReadResultV1Schema,
  'deployments.data.size': DeploymentDataSizeResultV1Schema,
  'deployments.prepare': DeploymentPrepareResultV1Schema,
  'deployments.environments.create': DeploymentEnvironmentCreateActionResultV1Schema,
  'deployments.environments.update': DeploymentEnvironmentUpdateResultV1Schema,
  'deployments.environments.controller.set': DeploymentEnvironmentCreateResultV1Schema,
  'deployments.targets.link': DeploymentTargetLinkResultV1Schema,
  'deployments.targets.unlink': DeploymentTargetUnlinkResultV1Schema,
  'deployments.environments.delete': DeploymentEnvironmentDeleteResultV1Schema,
  'deployments.deploy': DeploymentReceiptResultV1Schema,
  'deployments.rollback': DeploymentReceiptResultV1Schema,
  'deployments.restart': MachineServiceControlResultV1Schema,
  'deployments.backups.restore': DeploymentBackupRestoreResultV1Schema,
  'deployments.teardown': DeploymentTeardownResultV1Schema,
  'deployments.cancel': DeploymentReceiptResultV1Schema,
  'deployments.promote': DeploymentReceiptResultV1Schema,
  'deployments.environments.get': DeploymentEnvironmentGetResultV1Schema,
  'deployments.receipts.get': DeploymentReceiptGetResultV1Schema,
  'deployments.receipts.observe': DeploymentReceiptResultV1Schema,
  'deployments.observation.get': DeploymentObservationGetResultV1Schema,
  'deployments.bindings.set': DeploymentBindingsSetResultV1Schema,
  'deployments.environments.list': DeploymentEnvironmentListResultV1Schema,
  'deployments.receipts.list': DeploymentReceiptListResultV1Schema,
} as const));
export type DeploymentEnvironmentCreateActionInputV1 = z.infer<typeof DeploymentEnvironmentCreateActionInputV1Schema>;
export type DeploymentEnvironmentUpdateInputV1 = z.infer<typeof DeploymentEnvironmentUpdateInputV1Schema>;
export type DeploymentEnvironmentControllerSetInputV1 = z.infer<typeof DeploymentEnvironmentControllerSetInputV1Schema>;
export type DeploymentTargetLinkInputV1 = z.infer<typeof DeploymentTargetLinkInputV1Schema>;
export type DeploymentTargetLinkIntentInputV1 = z.infer<typeof DeploymentTargetLinkIntentInputV1Schema>;
export type DeploymentTargetLinkActionInputV1 = z.infer<typeof DeploymentTargetLinkActionInputV1Schema>;
export type DeploymentReceiptResultV1 = z.infer<typeof DeploymentReceiptResultV1Schema>;
export type DeploymentEnvironmentGetInputV1 = z.infer<typeof DeploymentEnvironmentGetInputV1Schema>;
export type DeploymentReceiptGetInputV1 = z.infer<typeof DeploymentReceiptGetInputV1Schema>;
export type DeploymentEnvironmentListInputV1 = z.infer<typeof DeploymentEnvironmentListInputV1Schema>;
/** Metadata selects the existing preview controller before original Action mint.
 * Admission still owns provenance, eligibility and authority on that controller. */
export async function resolveDeploymentPreviewExecutionMachineIdV1(
  input: Pick<z.infer<typeof DeploymentEnvironmentCreateIntentInputV1Schema>,
    'serverId' | 'projectSourceId' | 'preview' | 'controllerMachineId'>,
  read: Readonly<{
    listEnvironments(input: DeploymentEnvironmentListInputV1): Promise<unknown>;
    readTemplateController(): Promise<Readonly<{ ok: true; machineId: string }> | z.infer<typeof ActionExecuteFailureSchema>>;
  }>,
): Promise<Readonly<{ ok: true; machineId: string; environment?: DeploymentEnvironmentHeaderV1 }>
  | z.infer<typeof ActionExecuteFailureSchema>> {
  const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
  const preview = input.preview;
  if (!preview) return failure('invalid_parameters');
  let environment: DeploymentEnvironmentHeaderV1 | undefined;
  let cursor: string | null = null;
  do {
    const loaded = await read.listEnvironments({ serverId: input.serverId,
      ...(input.projectSourceId ? { projectSourceId: input.projectSourceId } : {}),
      previewRepository: preview.provenance.repository,
      previewPullRequestIds: [preview.pullRequestId], previewTemplateEnvironmentId: preview.templateEnvironmentId,
      ...(cursor ? { cursor } : {}) });
    const refused = ActionExecuteFailureSchema.safeParse(loaded);
    if (refused.success) return refused.data;
    const page = DeploymentEnvironmentListResultV1Schema.parse(loaded);
    if (!page.ok) return failure(page.error);
    if (page.coverage !== 'complete') return failure('deployment_access_denied');
    for (const row of page.items) {
      if (row.previewTargetLinkId !== preview.provenance.runtimeTargetLinkId) continue;
      if (environment) return failure('deployment_conflict');
      environment = row;
    }
    cursor = page.nextCursor;
  } while (cursor);
  const selected = environment ? { ok: true as const, machineId: environment.controllerMachineId }
    : await read.readTemplateController();
  if (!selected.ok) return selected;
  if (input.controllerMachineId !== undefined && input.controllerMachineId !== selected.machineId)
    return failure('target_mismatch');
  return { ok: true, machineId: selected.machineId, ...(environment ? { environment } : {}) };
}

/** Data-role writes that change installed credentials prepare on the Environment controller. */
export function isDeploymentDataRoleBindingWriteV1(input: unknown): boolean {
  const parsed = DeploymentActionInputSchemasV1[DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1].safeParse(input);
  return parsed.success && 'set' in parsed.data
    && (parsed.data.set.some(binding => binding.purpose === 'dataRole')
      || parsed.data.remove.some(binding => binding.purpose === 'dataRole' && 'targetLinkId' in binding));
}

/** Identifies existing Environment Actions that use installed deployment placement. */
export function isDeploymentEnvironmentPlacementActionV1(
  actionId: string, input: unknown, placement: ActionExecutionPlacement,
  options?: Readonly<{ canPrepareAccountBindings?: boolean }>,
): actionId is DeploymentActionIdV1 {
  if (!isDeploymentActionIdV1(actionId) || !input || typeof input !== 'object'
    || !('environmentId' in input) || typeof input.environmentId !== 'string') return false;
  if (actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1) return placement === 'machine';
  if (actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 && options?.canPrepareAccountBindings) {
    return isDeploymentDataRoleBindingWriteV1(input);
  }
  // Create and workspace-based roots have their own selectors.
  if (actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 || actionId === DEPLOYMENT_PREPARE_ACTION_ID_V1
    || actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
    || actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1) return false;
  return placement === 'machine' || isDeploymentChildRootActionIdV1(actionId) || isDeploymentAccountMachineTransportActionIdV1(actionId)
    || isDeploymentReadActionIdV1(actionId);
}

/** A schema-admitted receiver operand. A linked resource's Machine is not the Action receiver. */
export function readDeploymentExecutionMachineOperandV1(actionId: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1
    && 'controllerMachineId' in input && typeof input.controllerMachineId === 'string') {
    return input.controllerMachineId;
  }
  if ((actionId === DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 || actionId === DEPLOYMENT_RESTART_ACTION_ID_V1
    || actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || isDeploymentBackupActionIdV1(actionId)
    || isDeploymentReadActionIdV1(actionId)) && 'machineId' in input && typeof input.machineId === 'string') {
    return input.machineId;
  }
  return undefined;
}

/** Places a validated Action operand. Home still authorizes the selected receiver. */
export async function resolveDeploymentEnvironmentExecutionMachineIdV1(
  actionId: string,
  input: unknown,
  options: Readonly<{
    readEnvironmentController(input: Readonly<{ serverId: string; environmentId: string }>):
      Promise<Readonly<{ ok: true; machineId: string }> | ActionExecuteFailure>;
    explicitMachineId?: string;
    knownControllerMachineId?: string;
  }>,
): Promise<Readonly<{ ok: true; machineId: string }> | ActionExecuteFailure> {
  if (options.explicitMachineId) return { ok: true, machineId: options.explicitMachineId };
  if (!input || typeof input !== 'object') return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  if (options.knownControllerMachineId) return { ok: true, machineId: options.knownControllerMachineId };
  const authoredMachineId = readDeploymentExecutionMachineOperandV1(actionId, input);
  if (authoredMachineId && !isDeploymentReadActionIdV1(actionId)) {
    return { ok: true, machineId: authoredMachineId };
  }
  if (!('serverId' in input) || typeof input.serverId !== 'string'
    || !('environmentId' in input) || typeof input.environmentId !== 'string') {
    return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  }
  const controller = await options.readEnvironmentController({ serverId: input.serverId, environmentId: input.environmentId });
  if (!controller.ok) return controller;
  // Selected native reads may be served by a member of the Environment.
  return authoredMachineId ? { ok: true, machineId: authoredMachineId } : controller;
}

export type DeploymentReceiptListInputV1 = z.infer<typeof DeploymentReceiptListInputV1Schema>;
export type DeploymentActionInputV1 = z.infer<typeof DeploymentActionInputSchemasV1[DeploymentTransportActionIdV1]>;
export type DeploymentActionOutputV1 = z.infer<typeof DeploymentActionOutputSchemasV1[DeploymentTransportActionIdV1]>;

export const DeploymentTransitionInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...environment, deploymentId: DeploymentIdentifierV1Schema, actionOperationId: DeploymentIdentifierV1Schema,
  machineId: DeploymentIdentifierV1Schema, installationId: DeploymentIdentifierV1Schema,
  proof: MachineInstallationProofV1Schema,
  kind: z.enum(['stage', 'settle']), state: DeploymentStateV1Schema,
  telemetryTokenHash: z.optional(z.nullable(DeploymentTelemetryTokenHashV1Schema)),
  telemetryMachineId: z.optional(z.nullable(DeploymentIdentifierV1Schema)),
  contentUpdate: z.optional(ArtifactJsonUpdateHttpInputV1Schema),
  contentArtifactId: z.optional(DeploymentIdentifierV1Schema),
  contentHeaderVersion: z.optional(DeploymentRevisionV1Schema), contentBodyVersion: z.optional(DeploymentRevisionV1Schema),
  expectedTargetLinkRevision: z.optional(DeploymentRevisionV1Schema),
  /** Successful membership enrollment may retain the current immutable release. */
  servingDeploymentId: z.optional(DeploymentIdentifierV1Schema),
  teardownProof: z.optional(DeploymentTeardownProofV1Schema),
}).check(z.superRefine((input, context) => {
  if ((input.telemetryTokenHash === undefined) !== (input.telemetryMachineId === undefined)) {
    context.addIssue({ code: 'custom', path: ['telemetryTokenHash'], message: 'Delivered telemetry identifies both collector and token hash.' });
  }
  const content = [input.contentArtifactId, input.contentHeaderVersion, input.contentBodyVersion];
  if (content.some(value => value !== undefined) && !content.every(value => value !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Content transitions require the complete Artifact reference.' });
  }
  const terminal = ['running_unverified', 'succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(input.state);
  if ((input.kind === 'settle') !== terminal) context.addIssue({ code: 'custom', path: ['state'], message: 'Transition kind must match settlement.' });
  if (input.expectedTargetLinkRevision !== undefined && (input.kind !== 'settle' || !['succeeded', 'running_unverified'].includes(input.state))) {
    context.addIssue({ code: 'custom', path: ['expectedTargetLinkRevision'], message: 'Only a successful settlement can advance the uniform link.' });
  }
  if (input.servingDeploymentId !== undefined && input.expectedTargetLinkRevision === undefined) {
    context.addIssue({ code: 'custom', path: ['servingDeploymentId'], message: 'Retaining a serving release requires a successful uniform settlement.' });
  }
  if (input.teardownProof && (input.kind !== 'settle' || input.state !== 'succeeded' || input.expectedTargetLinkRevision !== undefined)) {
    context.addIssue({ code: 'custom', path: ['teardownProof'], message: 'Only a complete successful teardown can prove removal.' });
  }
})));
export type DeploymentTransitionInputV1 = z.infer<typeof DeploymentTransitionInputV1Schema>;

/** Native receipt intents retain this identity across distinct HTTP envelopes. */
export function readDeploymentEnvironmentOperationRequestIdV1(input: Readonly<{
  serverId: string; environmentId: string; requestKey?: string;
}>): string | undefined {
  return input.requestKey === undefined ? undefined
    : computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
      input.serverId, input.environmentId, input.requestKey,
    ]);
}

/** The host producer and reconnecting caller observe the same native intent,
 * independently of the transport envelope that carried it. */
export function readDeploymentActionOperationRequestIdV1(actionId: string, input: unknown): string | undefined {
  if (actionId === 'deployments.targets.link') {
    const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
    // Native creation must never replay after response loss. Association already has
    // Home request-key idempotency and each visible retry may make a fresh attempt.
    return parsed.success && 'providerCreate' in parsed.data
      ? computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
        'target-link-create', parsed.data.serverId, parsed.data.environmentId, parsed.data.requestKey,
      ]) : undefined;
  }

  if (actionId === 'deployments.backups.restore') {
    const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
    if (!parsed.success || parsed.data.mode !== 'confirm') return undefined;
    return computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
      'restore', parsed.data.prepareOperationId,
    ]);
  }
  if (actionId === 'deployments.templates.instantiate') {
    const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
    return parsed.success ? deploymentTemplates.readDeploymentTemplateCreationOperationRequestIdV1(parsed.data) : undefined;
  }
  if (!isDeploymentChildEffectActionIdV1(actionId) && actionId !== 'deployments.teardown') return undefined;
  const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
  if (!parsed.success || !('requestKey' in parsed.data)) return undefined;
  return readDeploymentEnvironmentOperationRequestIdV1(parsed.data);
}

/** Only the catalog Apply continuation owns a finite Create operation on the Machine. */
export function isDeploymentCatalogCreateApplyV1(input: unknown): boolean {
  const parsed = DeploymentEnvironmentCreateIntentInputV1Schema.safeParse(input);
  return parsed.success && parsed.data.mode !== 'preview' && parsed.data.definition?.from === 'catalogApp';
}

/** Template preview has an operation declaration but never creates a host receipt. */
export function isDeploymentTemplatePreviewInputV1(actionId: string, input: unknown): boolean {
  if (actionId !== 'deployments.templates.instantiate') return false;
  const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
  return parsed.success && parsed.data.mode === 'preview';
}

/** The signer and Home derive the same body binding; the proof itself is never part of its digest. */
export function computeDeploymentTransitionRequestDigestV1(input: Omit<DeploymentTransitionInputV1, 'proof'>): string {
  return computeCanonicalDomainSeparatedDigest('happier-deployment-transition-v1', [createCanonicalJsonSigningInput(input)]);
}
