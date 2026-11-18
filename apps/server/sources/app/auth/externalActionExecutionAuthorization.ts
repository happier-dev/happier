import { WIDGET_CATALOG_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/widgets/instanceIdsV1';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionInputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { MACHINE_LIST_ACTION_ID_V1, EXTERNAL_SESSION_CANDIDATES_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { MACHINE_REMOVE_ACTION_ID_V1, MACHINE_REPLACEMENT_SET_ACTION_ID_V1, MACHINE_REPLACEMENT_CLEAR_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { MACHINE_REBOOT_ACTION_IDS } from '@happier-dev/protocol/machines/rebootActionIdsV1';
import { isManagedReferenceCensusActionIdV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { MachineDeploymentReferencesInputV1Schema } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { MachinePoolListInputV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { isSessionSpawnHomeDefaultsReadEffectV1 } from '@happier-dev/protocol/actions/actionIds';
import { decodeMachineStoredContent } from '@/storage/sessionMachineStoredContent';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as collectionSharingIds,
    isPluginCollectionSharingActionIdV1 } from '@happier-dev/protocol/plugins/data/collectionSharingActionIdsV1';
import { PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, PluginCollectionContractReadRequestV1Schema } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 as collectionSharingPaths,
    PluginCollectionSharingAddressV1Schema, PluginCollectionSharingGetRequestV1Schema,
    PluginCollectionSharingListRequestV1Schema, PluginCollectionSharingPutRequestV1Schema,
    PluginCollectionSharingSetGrantRequestV1Schema, PluginCollectionSharingRevokeGrantRequestV1Schema,
    PluginCollectionSharingCensusRequestV1Schema, PluginCollectionSharingCommitKeysRequestV1Schema,
} from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import { readHomeConfigEnv } from '@/app/home/settings/homeSettings';
import { isScmRunStartRpcPurpose } from '@happier-dev/protocol/actions/actionSpecs';
import { homeDomainActionHttpWireInputSchemaV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { isTeamGroupUpdateActionIdV1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { TEAM_CREDENTIAL_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/teams/credentials/actionIdsV1';
import { MachinePresetActionInputSchemasV1, MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { isMachinePresetFiniteOperationActionIdV1, MACHINE_PRESET_ARCHIVE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { MACHINE_ISOLATION_SET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineIsolationActionIdsV1';
import { WORKFLOW_RUN_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { isManagedCreationContinuationRootV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, PrivateLabelRecipientCensusRequestV1Schema }
    from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import { readSessionActionChildCreationRpcEffectV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationActionIdsV1';
import { readAdmittedManagedCreationChildInTx, hasAdmittedManagedCreationRootInTx, readSelectedManagedCreationChildAdmission, type ManagedCreationChildAdmission } from './externalActionManagedAdmission';
import { readTeamCredentialActionHttpPurposeV1 } from '@happier-dev/protocol/teams/credentials/actionHttpPurposeV1';
import { TeamCredentialDirectMaterialOpenRequestV1Schema, TeamCredentialDirectMaterialRouteParamsV1Schema } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { isSessionStopChildRootV1, isSessionStopChildEffectV1, isSessionStopPhaseRootV1 } from '@happier-dev/protocol/actions/sessionSections';
import { ExternalActionManagedControlAdmissionV1Schema, isExternalActionRequestVersionAllowedForAccountModeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { personalSavedSecretResourceMutationActionIdV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionIdsV1';
import { PROJECT_READINESS_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/projectReadinessActionIdsV1';
import { isMachineSetupCombinedRunHttpPurpose } from '@/app/auth/externalActionMachineSetupWorkflowPurpose';
import { MACHINE_RESOURCES_OUTCOMES_READ_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineResourcesActionIdsV1';
import { MACHINE_OUTCOME_SUMMARY_PREFIX } from '@happier-dev/protocol/machines/resources/machineOutcomeSummaryV1';
import { readManagedBoundSessionHttpPurpose } from './externalActionManagedSessionPurpose';
import { isExternalActionConnectedAccountInventoryHttpPurpose } from './externalActionConnectedAccountInventoryPurpose';
import { isExternalActionConnectedSubscriptionPriceHttpPurpose } from './externalActionConnectedMetadataPurpose';
import * as z from 'zod/mini';
import type { ExternalActionAuthorizationRefusalPhase } from '@happier-dev/protocol/actions/externalActionHttpError';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ArtifactReadBatchHttpInputV1Schema, ArtifactReadHeadersBatchInputV1Schema, ArtifactTemplateAcceptedVersionInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactSignedInLinkCreateRequestV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { MachineReadBatchRequestV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { isBotTemplateRestrictedPatHttpPurposeRootActionIdV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';
import { isDeploymentReadActionIdV1, isDeploymentPreparationActionIdV1,
    deploymentPreparationOperationForActionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readDeploymentReadAuthorizationInTx, readAdmittedRegistryAppUpdateScopeInTx,
    readAdmittedDeploymentReadScopeInTx, readAdmittedProjectReadinessScopeInTx } from '@/app/deployments/deploymentReadAuthorization';
import { loadDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { liveDeploymentTargetLinkWhere } from '@/app/deployments/deploymentTargetLinkReadService';
import { readDeploymentReviewedSetupHttpPurpose } from '@/app/deployments/deploymentReviewedChildAuthorization';
import { admitDeploymentMachineInTx, canDeployDeploymentEnvironment } from '@/app/deployments/deploymentAdmission';
import { readDeploymentAcceptedExecution, readAcceptedDeploymentReceiptInTx, deploymentInProgressStates, type DeploymentReceiptContinuation } from '@/app/deployments/deploymentAcceptedExecution';
import { isDeploymentWorkspaceListHttpPurpose, isDeploymentPreparationHttpPurposeInTx, readDeploymentPreparationSourceHttpPurposeInTx, readAdmittedDeploymentScopeInTx, isDeploymentReadOperandInAdmittedScopeInTx, isDeploymentEnvironmentHttpReadInAdmittedScopeInTx, readDeploymentSourceReadOperands, type DeploymentPreparationSourceRead,
    readDeploymentCreateHttpPurposeInTx, isDeploymentCreateHttpEffect, type DeploymentCreateHttpPurpose,
    readDeploymentTargetRetentionHttpPurpose, type DeploymentTargetRetentionHttpPurpose,
    readDeploymentLinkPreparationHttpPurpose,
    readDeploymentDomainPreparationHttpPurpose,
    readDeploymentEnvironmentContentPreparationHttpPurpose, readDeploymentEnvironmentSetupHttpPurpose,
    isDeploymentMoveToRepositoryHttpEffect, readDeploymentMoveToRepositoryHttpPurpose,
    readDeclaredDeploymentPreparationHttpRead, readDeploymentPreparationHttpReadPurpose, readDeploymentReferenceHttpPurpose,
    isDeploymentCandidatePublicationHttpPurposeInTx,
    isDeploymentCandidatePublicationEffect,
    isSetupDeploymentPreparationReadEffect } from '@/app/deployments/deploymentPreparationAuthorization';
import { isScmRefineInputRpcPurposeV1, verifyScmRefineSavedSessionV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ACTION_OPERATION_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { PROJECT_PREPARE_ACTION_ID_V1, PROJECT_SETUP_SET_ACTION_ID_V1, PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1, isProjectSetupSetChildActionIdV1, readProjectSetupSetChildRpcEffectV1, isProjectWorkspaceSyncOpenActionV1, isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { ProjectSetupSetInputV1Schema, isProjectSetupSetChildInputV1 } from '@happier-dev/protocol/projects/projectSetupSetV1';
import { PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/projects/projectSetupV1';
import { isProjectAccountRowActionIdV1, isSessionListActionId, isWorkspaceSyncRelationshipWriteActionId, PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { resolveManagedSessionDefaultsTeamId } from '@happier-dev/protocol/teams/managedDefaults';
import { readWorkspaceSyncSourceAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isDeploymentActionIdV1, DeploymentDeployAdmissionInputV1Schema, DeploymentRollbackAdmissionInputV1Schema,
    DeploymentDeployInputV1Schema, DeploymentRollbackInputV1Schema, DeploymentPromoteInputV1Schema,
    DeploymentPromoteAdmissionInputV1Schema, DeploymentTeardownActionAdmissionInputV1Schema,
    DeploymentTransitionInputV1Schema,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1,
    DeploymentEnvironmentGetInputV1Schema, DeploymentEnvironmentAccessInputV1Schema, DeploymentDeployIntentInputV1Schema, DeploymentActionInputSchemasV1,
    DeploymentChildRoutingV1Schema, readDeploymentChildRpcV1, projectDeploymentChildRoutingV1, doesDeploymentChildInputMatchRootV1,
    readDeploymentArchiveRpcEffectV1, type DeploymentChildRoutingV1 } from '@happier-dev/protocol';
import { deploymentOperationForRootActionV1, deploymentChildEffectActionIdForRootV1, isDeploymentDomainChildActionIdV1, isDeploymentBackupActionIdV1 } from '@happier-dev/protocol';
import { isDeploymentDomainDnsActionIdV1, isDeploymentEnvironmentMetadataReadActionIdV1, isDeploymentApprovalMetadataPreparationActionIdV1, isDeploymentObservationReadActionIdV1, isDeploymentDomainAddActionIdV1,
    isDeploymentDomainMetadataReadActionIdV1, isDeploymentReceiptReadActionIdV1, DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1,
    DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1,
    isDeploymentMembershipActionIdV1, DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1,
    DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1, DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1, DEPLOYMENT_REFERENCE_READ_CHILD_ROLE_V1,
    DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_DATA_SIZE_ACTION_ID_V1, DEPLOYMENT_PREPARE_SESSION_CHILD_ROLE_V1, DEPLOYMENT_LOGS_READ_ACTION_ID_V1, DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { EnvironmentSecretLaunchAdmissionInputV1Schema, EnvironmentSecretAdmissionRequestV1Schema, DeploymentEnvironmentUpdateStorageInputV1Schema,
    DeploymentBindingsSetStorageInputV1Schema } from '@happier-dev/deployment-protocol';
import { isMachineConnectorSecretGrantHttpPurpose } from '@/app/deployments/machineConnectorSecretGrantAuthorization';
import { ProjectSourcesReadInputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { ExternalActionActionIdV1Schema, bindExternalActionExecutionAuthorizationVerifyHttpPathV1, bindExternalActionExecutionAuthorizationHttpPathV1, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationVerifyRequestV1Schema, isExternalActionProjectSessionDefaultsReadAdmittedV1, isExternalActionResolvedTargetAllowedV1, isExternalActionWorkflowActionIdV1, isExternalActionMachineWorkflowActionIdV1, type ExternalActionExecutionAuthorizationBindingV1, type ExternalActionExecutionAuthorizationV1, type ExternalActionMachineRpcExecutionV1, type ExternalActionTargetV1, type ExternalActionServerPrincipalV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeExternalActionResolvedTargetV1, encodeExternalActionResolvedTargetV1, verifyExternalActionMachineRpcRequestV1, verifyExternalActionMachineRequestV1, isExternalActionAuthorizationBoundToEnvelope, type ExternalActionMachineRpcEventV1, type DeploymentChildExecutionProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { isDeploymentDomainNativeAdmissionV1, isDeploymentBackupConfigureNativeAdmissionV1, isDeploymentTelemetryNativeAdmissionV1, type ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { getActionSpec, resolveActionExecutionPlacementForInput, isPluginProvenanceOnlyActionId, isSessionTargetPreparationAction, isScmDiffSummaryRunAction, PublicActionIdSchema, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { ActionIdSchema, SESSION_ORGANIZATION_PIN_SET_ACTION_ID_V1,
    isMachineDeploymentEnvironmentAccessActionIdV1, isDeploymentPrepareSessionMessageEffectV1,
    SESSION_SPAWN_NEW_ACTION_ID_V1, ACTION_INVOKE_ACTION_ID_V1, getManagedBoundSetupReportActionIdsV1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { MachineAccessActionIdSchema } from '@happier-dev/protocol/actions';
import { admitSessionSpawnNewActionInputV2, SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { bindApiSessionSpawnNewInput } from '@happier-dev/protocol/actions/specs/session/lifecycle';
import type { MachineOperationRequesterContext } from '@/app/machines/machineOperationSupport';
import type { ActionRequiredAuthority } from "@happier-dev/protocol/actions/metadata";
import { SOCKET_RPC_EVENTS, resolveSocketRpcSessionAuthorization, WorkspaceSyncSourceExecutionV1Schema, type WorkspaceSyncSourceRoutingV1, type WorkspaceSyncSourceWriterTargetRoutingV1,
    type WorkspaceSyncSourceExecutionV1, type WorkspaceSyncTargetRoutingV1, type WorkspaceSyncSeedRoutingV1 } from "@happier-dev/protocol/socketRpc";
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { projectApiTokenSessionSpawnAdmissionV1, type ApiTokenSessionSpawnAdmissionV1, API_TOKEN_ENVIRONMENT_ACTION_IDS_V1, evaluateApiTokenGrantV1, isApiTokenGrantWithinV1, isApiTokenGrantTargetMemberV1, isApiTokenGrantRestrictedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { resolveCredentialActionAdmissionV1, computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { MachineSetupResolveInputV1Schema,
    MachineSetupReportInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineActionIdV1Schema, ManagedMachineActionInputSchemasV1, ManagedResourceTargetV1Schema, managedMachineActionEndpointPathV1, ManagedControllerReportV1Schema, ManagedControllerIntentReportV1Schema, ManagedControllerCredentialDeliveryReportV1Schema, isMachineSetupPlanRpcChildV1, readMachineSetupPlanChildInputV1, type ManagedControllerReportV1, type ManagedControllerIntentReportV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isManagedEnrollmentPolicyChildActionIdV1, isOrdinaryMachineSetupNativeActionIdV1, isMachineSetupPlanOrApplyActionIdV1, isManagedEnrollmentRecoveryChildV1, isManagedPowerOrDeleteActionIdV1, readSessionAgentReadinessRoleV1, SESSION_AGENT_READINESS_ROOT_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { type AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import { ActionOperationGetV2RequestSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/methodsV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { ProviderAccountUsageRecordIdSchema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SessionPendingTemplateOnboardingRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SessionLookupByTagsRequestV2Schema } from '@happier-dev/protocol/sessions/control/contract';
import { buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';
import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { buildSessionOrganizationAssignmentSnapshotHttpRequestV1 } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SessionCreateRequestSchema } from '@/app/session/create/sessionCreateRequest';
import { SessionMachineAccessKeyCreateBodySchema } from '@/app/accessKeys/sessionMachineAccessKeyRequest';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2, SessionPendingExecutionRunEnqueueByMachineRequestV2Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';
import { readSessionAgentReadinessChildActionV1, resolveMachineRpcExternalActionEffectV1, resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    ManagedActivityReadRequestV1Schema, ManagedAdmissionDrainConfirmRequestV1Schema,
    type ManagedActivityRpcRequestV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';

import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { ManagedControllerResizeReportV1Schema, type ManagedControllerResizeReportV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { requireActiveManagedResizeInTx, readManagedIntentReportAuthority } from '@/app/machines/managed/managedRows';
import { MANAGED_ACQUIRE_ACTION_ID_V1, MANAGED_RESIZE_ACTION_ID_V1, isManagedControlAdmissionActionIdV1, isManagedCreationMutationActionIdV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedAdmissionInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_MACHINE_CREATION_CHILD_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveMachineAdmission, resolveMachineAdmissionInTx } from "@/app/machines/machineAccess";
import { ManagedMachineError, hasBoundManagedLifecycle, requireCurrentManagedMachineInTx, sameManagedInput, readManagedMachineInTx, readManagedAdmissionState, readManagedEnrollmentAccountId, projectManagedMachine,
    readMachineDevcontainerWorkspaceSyncRouteInTx, readMachineDevcontainerWorkspaceSyncEndpointInTx } from '@/app/machines/managed/managedRows';
import { resolveManagedGuestActivityAdmissionInTx } from '@/app/machines/managed/managedGuestActivity';
import { initializeServerIdentityCache } from "@/app/serverIdentity/serverIdentity";
import { db } from "@/storage/db";
import { readManagedCredentialDeliveryAuthorityInTx, readManagedCredentialDeliverySubmittedAuthorityInTx } from '@/app/machines/managed/credentialDeliveryAdmission';
import { inReadSnapshot, type Tx } from "@/storage/inTx";
import { enforceLoginEligibility } from "./enforceLoginEligibility";
import { narrowCredentialAuthority } from './effectiveCredentialAuthority';
import { readExternalActionBindingAuthority } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
export { readExternalActionBindingAuthority } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { hasCurrentSessionActionRpcSourceBinding, hasCurrentSessionActionRpcSourceBindingInTx,
    hasCurrentSessionScopedMachineAccessInTx, hasCurrentMachineAccessForSessionInTx } from '@/app/api/socket/sessionScopedBinding';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowReadRequestV1Schema,
    ProjectAccountRowListRequestV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ProjectSourcesCreateInputV1Schema, ProjectSourcesUpdateInputV1Schema, ProjectSourcePublicationPatchV1Schema,
    ProjectSourcesDeleteInputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { PROJECT_SOURCE_LIST_ACTION_ID_V1, PROJECT_SOURCE_READ_ACTION_ID_V1, PROJECT_SOURCE_UPDATE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/projectSourcesActionIdsV1';
import { PROJECT_DEFINITION_INSPECT_ACTION_ID } from '@happier-dev/protocol/actions/projectDefinitionActionIdsV1';
import { PROJECT_TRUST_ROUTE_V1, ProjectTrustMutationRequestV1Schema, ProjectTrustReadRequestV1Schema,
    ProjectTrustListRequestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1, WorkspaceExecutionConfigReadRequestV1Schema,
    WorkspaceExecutionConfigMutationRequestV1Schema } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { isRequesterProjectExecutionActionV1, PROJECT_FINITE_ACTION_RPC_METHODS_V1, PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { WorkspaceSyncPrepareBetweenRequestV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { MACHINE_TERMINAL_ACTION_IDS } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { PROJECT_SOURCE_READ_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/projectSourcesActionIdsV1';
import { ExternalActionRequestEnvelopeSchema, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectServiceRelocateInputV1Schema, isProjectServiceMoveChildInputV1, readProjectServiceMoveChildEffectV1, readProjectServiceMoveChildMachineV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { readDiscussionSecondOpinionModelChildV1 } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { SessionInputSourceSessionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { isSessionInputSourceCurrentInTx, readSessionMessageReplyInTx } from '@/app/session/messages/sessionMessageReply';

import { auth, type VerifiedApiTokenPrincipal } from "./auth";
import { readExternalActionNativeCredentialSpawnChildInTx } from './externalActionNativeCredentialChild';
import { isAutomationOriginRunPublisherTx } from '@/app/automations/automationTriggerCauseChain';
import { hasCurrentDeploymentWorkflowOriginInTx, readCurrentMachineWorkflowOriginInTx, type DeploymentWorkflowOriginInput, type MachineWorkflowOriginPhase } from './deploymentWorkflowOrigin';
import { QualifiedProviderAccountUsageHistoryRequestV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { ProviderAccountUsageDaySummaryReadV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { PendingResetStartsReadInputV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { readExternalActionPendingResetStartPurpose, isExternalActionPendingResetStartReadPurpose } from './externalActionPendingResetStartPurpose';
import { isExternalActionApprovalReplyPurpose } from './externalActionApprovalReplyPurpose';
import { isExternalActionApprovalArtifactPurpose } from './externalActionApprovalArtifactPurpose';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1, isMachineSetupCombinedActionIdV1, isMachineSetupNativeCodecActionIdV1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { isArtifactSignedInLinkCreateHttpPurpose, readExternalActionArtifactSignedInLinkPurpose } from './externalActionArtifactSignedInLinkPurpose';
import { isExternalActionDeploymentPendingCancelPurpose } from './externalActionDeploymentPendingCancelPurpose';
import { SessionBoardMutationV1Schema } from '@happier-dev/protocol/sessions/board/mutations';
import { SessionSystemRecordAddressSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordAddress';
import { projectExternalActionPendingResetStartAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SCM_REVIEWED_MARKS_KV_PREFIX, buildScmReviewedMarksKey } from '@happier-dev/protocol/scm/reviewedMarks';
import { UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { accountUsageRoutePaths } from '@/app/api/routes/account/accountUsageRoutePaths';
import { isUsagePriceActionIdV1, isUsagePublicRecapActionIdV1, isUsagePrivateRecapActionIdV1 } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { KvMutationRequestSchema } from '@/app/kv/kvMutate';
import { USAGE_COACH_SUPPRESSIONS_KV_KEY } from '@happier-dev/protocol/usage/coach/coachActions';
import { bindPublicProfilePreparedHttpRequestV1, isHomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { isPublicProfilePreparationActionIdV1 } from '@happier-dev/protocol/account/publicProfileActionIds';
import { PublicProfilePreparedRequestV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { isDiscussionActionIdV1, discussionActionHttpWireInputSchemaV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { DISCUSSION_HTTP_PATHS_V1, DiscussionListQueryV1Schema, DiscussionRouteDiscussionParamsV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionListInputV1Schema, DiscussionReadInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/discussions/access';
import { isSessionFollowActionIdV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { isSessionFollowActionHttpRequestV1, resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { SessionOrganizationPinSetInputSchema } from '@happier-dev/protocol/actions/sessionOrganizationMoveAction';
import { isSessionSectionActionIdV1, isSessionSectionArchiveEffectV1, isSessionStopChildV1,
    readSessionSectionActionHttpPurposeV1 } from '@happier-dev/protocol/actions/sessionSections';
import { SessionArchiveHttpBodyV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { isSessionStateFieldActionId } from '@happier-dev/protocol/actions/sessionStateFieldActions';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { SessionReadBatchRequestV1Schema, type SessionReadBatchRequestV1 } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { isLedSubtreeSessionLifecycleActionId } from '@happier-dev/protocol/actions/executor/sessionListAccess';
import { readSessionManagedSubtreeSessionIdsInTx } from '@/app/session/follow/sessionManagerSubtree';
import { DOC_EDIT_PROPOSAL_HTTP_PATHS_V1, DocEditAcceptTransportInputV1Schema,
    DocEditDeclineTransportInputV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, DiscussionSecondOpinionPreviewInputV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { ArtifactAccessGrantSetInputV1Schema, ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactJsonUpdateHttpInputV1Schema } from '@/app/artifacts/artifactMutationHttpContract';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol';
import { bindDiscussionCandidatePeopleReadV1, projectDiscussionCandidateSessionQueryV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { UsersSearchQueryV1Schema } from '@happier-dev/protocol/social/friends';
import { SESSION_FOLLOW_RULES_ROUTE_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { isMemoryWriteActionV1 } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { warn } from '@/utils/logging/log';
import { redactHttpRequestUrlForLog } from '@/utils/logging/redactHttpRequestUrlForLog';
import { readDeploymentChildAdmissionInTx, readDeploymentChildMachineReadInTx, isDeploymentPreparationMachineReadHttpPurposeInTx,
    type DeploymentChildAdmission, type DeploymentChildMachineRead } from '@/app/deployments/deploymentChildAuthorization';
import { projectAcceptedDeploymentDomainSecretLaunchAdmission } from '@/app/deployments/deploymentDomainService';
import { readDeploymentChildHttpPurposeInTx, readDeploymentChildPeerGrantTarget } from './deploymentChildHttpPurpose';
import { isExternalActionManagedResourceAction, readExternalActionManagedAcquireResourceInTx, resolveManagedActionMachineAdmissionInTx, resolveSessionPresetActionMachineAdmissionInTx } from './externalActionManagedAdmission';
import { resolveManagedNativeCredentialActionMachineAdmissionInTx, type ExternalActionManagedAdmissionContext } from './externalActionManagedNativeAdmission';
import { hasAdmittedExternalActionHandoffScope, readAdmittedExternalActionHandoffMachineInTx, readAdmittedExternalActionMachineInTx } from './externalActionHandoffAdmission';
import { readExternalActionDeploymentDomainPurpose, type DomainHttpPurpose } from './externalActionDeploymentDomainPurpose';
import { isAcceptedDeploymentDomainTransitionInTx, readAcceptedDeploymentDomainInTx, readAcceptedDeploymentTeardownDomainContentInTx } from '@/app/deployments/deploymentDomainService';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1,
    McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

export type VerifiedExternalActionPrincipal = VerifiedApiTokenPrincipal
    | (Extract<ExternalActionServerPrincipalV1, { authentication: unknown }>
        & Readonly<{ authority: ActionRequiredAuthority; authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[] }>);

/** Original Account Project ingress still uses the canonical Action admission policy. */
export function isOriginalAccountProjectAction(actionId: string): boolean {
    return isRequesterProjectExecutionActionV1(actionId)
        || Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId);
}
export function isOriginalAccountHandoffAction(actionId: string): boolean {
    return ActionIdSchema.safeParse(actionId).success
        && (actionId === 'session.handoff' || actionId.startsWith('session.handoff.'));
}

/** Installed Session and Workflow callers propose on the Agent surface; this never grants execution authority.
 * Ingress must verify its installation proof and current source before minting.
 */
export function readExternalActionSessionProposalSurface(
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>,
): 'agent' | undefined {
    return origin?.workflowActionOrigin || origin?.sessionActionOrigin && origin.sessionActionSource ? 'agent' : undefined;
}

function isInstalledSessionClientAction(
    spec: ReturnType<typeof getActionSpec>,
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>,
): boolean {
    if (spec.executionPlacement !== 'client' && !spec.executionPlacements?.includes('client')) return false;
    if (readExternalActionSessionProposalSurface(origin) === undefined) return false;
    const caller = origin?.workflowActionOrigin ? { kind: 'workflowRun' } : origin?.sessionActionOrigin?.caller;
    return resolveActionExecutionPlacementForInput(spec, undefined, caller, 'agent') === 'client';
}

/** Interactive Account execution consumes the canonical signed-root catalog and declaration families. */
export function isOriginalAccountExecutionAction(actionId: string,
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>): boolean {
    const parsed = SignedRootActionIdSchema.safeParse(actionId);
    if (!parsed.success) return false;
    const spec = getActionSpec(parsed.data);
    if (spec.originalExecution?.accountRoot === 'separate') return false;
    // Home cannot open encrypted operands. The declaration names the variants
    // that the receiving daemon resolves after schema admission.
    const placements = spec.executionPlacements ?? [spec.executionPlacement];
    return isPluginProvenanceOnlyActionId(parsed.data)
        || placements.includes('account') || placements.includes('machine') || isInstalledSessionClientAction(spec, origin)
        || spec.executionPlacement === 'session'
            && spec.surfaces[readExternalActionSessionProposalSurface(origin) ?? 'api'] === true
            && resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null,
                surface: readExternalActionSessionProposalSurface(origin) }).ok
        || spec.originalExecution?.accountRoot === 'allowed';
}

/** Paired terminal roots consume catalog placement/policy without inventing a Session source. */
export function isOriginalTerminalExecutionAction(actionId: string,
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>): boolean {
    if (isPluginProvenanceOnlyActionId(actionId)) return false;
    const parsed = ActionIdSchema.safeParse(actionId);
    if (!parsed.success) return false;
    const spec = getActionSpec(parsed.data);
    const surface = readExternalActionSessionProposalSurface(origin);
    const placements = spec.executionPlacements ?? [spec.executionPlacement];
    return spec.originalExecution?.accountRoot !== 'separate' && SignedRootActionIdSchema.safeParse(actionId).success
            && (placements.some(placement => placement === 'machine' || placement === 'account' || placement === 'session')
                || isInstalledSessionClientAction(spec, origin))
            && (spec.executionPlacement !== 'session' || spec.surfaces[surface ?? 'api'] === true)
            && resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface }).ok
        || spec.originalExecution?.terminalRoot === 'allowed'
            && resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface }).ok
        || spec.originalExecution?.terminalRoot === 'host'
            && !origin?.sessionActionOrigin && !origin?.sessionActionSource
            && !origin?.workflowActionOrigin
            && resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface }).ok;
}

/** Home-verified retained root, forwarded only after the assigned Run is proved. */
export type WorkflowExternalActionAdmission = Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1 & Readonly<{ admittedMachineRole: 'manage' }>;
    principal: ExternalActionServerPrincipalV1 & Pick<VerifiedApiTokenPrincipal, 'authenticationEvidence'>;
}>;

/** Public spawn operands bind their destination through the existing API owner. */
export function readExternalActionSessionSpawnAdmission(
    envelope: ExternalActionRequestEnvelope,
    context: Readonly<{ serverId: string | null; target: ExternalActionTargetV1 | undefined }>,
): ApiTokenSessionSpawnAdmissionV1 | undefined {
    if (envelope.v !== 1) return envelope.sessionSpawnAdmission;
    const internal = SessionSpawnNewActionInputV2Schema.safeParse(envelope.input);
    // Only public API input binding needs the server identity.
    const canonical = internal.success ? internal.data : (() => {
        if (context.serverId === null) throw new Error('Server identity is unavailable for Session spawn input binding');
        return SessionSpawnNewActionInputV2Schema.parse(bindApiSessionSpawnNewInput(envelope.input, {
            actionId: SESSION_SPAWN_NEW_ACTION_ID_V1, surface: 'api', caller: { kind: 'host' },
            serverId: context.serverId, externalActionTarget: context.target,
        }));
    })();
    const projected = projectApiTokenSessionSpawnAdmissionV1(admitSessionSpawnNewActionInputV2(canonical), {
        managedPresetAcquisition: envelope.sessionSpawnAdmission?.managedPresetAcquisition,
    });
    if (envelope.sessionSpawnAdmission !== undefined && !sameManagedInput(projected, envelope.sessionSpawnAdmission)) {
        throw new Error('Session admission does not match its authored input');
    }
    return projected;
}

/** Native effects consume their existing admission; new work uses C41 policy. */
export async function resolveExternalActionExecutionMachineAdmissionInTx(reader: Tx,
    input: ExternalActionManagedAdmissionContext & Partial<MachineOperationRequesterContext> & Readonly<{ actorAccountId: string; machineId: string; actionId: string; requireOnline?: boolean;
        workflowAdmission?: WorkflowExternalActionAdmission;
        managedCreationAdmission?: ManagedCreationChildAdmission;
        capturedMachineAdmission?: SocketRpcMachineAdmissionContextV1;
        nativePurpose?: 'machine_npm_profile_acquisition' }>): Promise<Awaited<ReturnType<typeof resolveMachineAdmissionInTx>>
            & import('./externalActionManagedAdmission').ManagedActionMachineAdmissionFacts> {
    if (input.nativePurpose) {
        const action = SignedRootActionIdSchema.safeParse(input.actionId);
        if (!action.success || getActionSpec(action.data).originalExecution?.nativePurpose !== input.nativePurpose) {
            return { kind: 'denied', code: 'access_denied' };
        }
        // A new Machine secret acquisition is its natural admission boundary,
        // including for a retained Account Action. Public reads retain Use.
        return resolveMachineAdmissionInTx(reader, { actorAccountId: input.actorAccountId, machineId: input.machineId,
            requiredRole: 'manage', callerAuthority: input.callerAuthority ?? input.authentication?.authenticationAuthority
                ?? (input.executionBinding ? readExternalActionBindingAuthority(input.executionBinding) : undefined),
            sessionActionOrigin: input.sessionActionOrigin ?? input.executionBinding?.sessionActionOrigin,
            executionBinding: input.executionBinding,
            ...(input.requireOnline === undefined ? {} : { requireOnline: input.requireOnline }) });
    }
    if (input.workflowAdmission) {
        const binding = input.workflowAdmission.binding;
        if (input.actorAccountId !== binding.accountId || input.machineId !== binding.machineId) {
            return { kind: 'denied', code: 'machine_unavailable' };
        }
        const admitted = await readAdmittedExternalActionMachineInTx(reader, binding, input.machineId, binding.installationId);
        return admitted ? { ...admitted, role: binding.admittedMachineRole } : { kind: 'denied', code: 'machine_unavailable' };
    }
    const native = input.executionBinding;
    if (native?.managedContinuation && input.actionId === native.actionId && input.actorAccountId === native.accountId
        && input.machineId === native.machineId) {
        const admitted = input.managedCreationAdmission ? readSelectedManagedCreationChildAdmission(input.managedCreationAdmission, native)
            : (await readAdmittedManagedCreationChildInTx(reader, native))?.machineAdmission;
        return admitted ?? { kind: 'denied', code: 'machine_unavailable' };
    }
    if (native?.sessionPresetAcquisition && native.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1
        && input.actionId === native.actionId && input.actorAccountId === native.accountId && input.machineId === native.machineId
        && native.target.kind === 'machine' && native.target.machineId === native.machineId
        && native.sessionPresetAcquisition.selection.homeId === native.serverIdentityId
        && native.sessionPresetAcquisition.controller.machineId === native.machineId
        && native.sessionPresetAcquisition.controller.installationId === native.installationId) {
        // The root already admitted this preset carrier; grants are checked at the next root.
        const admitted = await readAdmittedExternalActionMachineInTx(reader, native, native.machineId, native.installationId);
        return admitted ? { ...admitted, role: native.admittedMachineRole ?? admitted.role,
            sessionPresetAcquisition: native.sessionPresetAcquisition } : { kind: 'denied', code: 'machine_unavailable' };
    }
    if (native && (isManagedControlAdmissionActionIdV1(native.actionId)
        || isExternalActionManagedResourceAction(native.actionId) && native.actionId !== 'machines.managed.credentials.install')
        && native.managedAdmission?.actionId === native.actionId && input.actionId === native.actionId
        && input.actorAccountId === native.accountId && input.machineId === native.machineId
        && native.target.kind === 'machine' && native.target.machineId === native.machineId) {
        // The signed resource scope admits its carrier. Domain admission still
        // decides new native work; later effects consume that accepted tuple.
        const admitted = await readAdmittedExternalActionMachineInTx(reader, native, native.machineId, native.installationId);
        return admitted ? { ...admitted, role: native.admittedMachineRole ?? admitted.role }
            : { kind: 'denied', code: 'machine_unavailable' };
    }
    // Exact native binding admission is mandatory even for a controller manager.
    if (input.actionId === 'machines.managed.credentials.install') return resolveManagedNativeCredentialActionMachineAdmissionInTx(reader, { ...input, actionId: input.actionId });
    const action = SignedRootActionIdSchema.safeParse(input.actionId);
    const spec = action.success ? getActionSpec(action.data) : null;
    const placements = spec?.executionPlacements ?? [];
    const accountPlaced = spec?.executionPlacement === 'account' && input.actionId !== SESSION_SPAWN_NEW_ACTION_ID_V1
        && (input.actionId === 'deployments.environments.create'
            || !placements.includes('machine') && !placements.includes('client'));
    // This Machine carries an Account Action; it does not execute its domain
    // effect. Use admits the carrier, while the Account route owns the actual
    // Session/resource permission (including managed wake's separate Manage).
    // Create's native variant opens and normalizes private definition input;
    // its existing definition owner requires Manage before preparation/effects.
    // It has no raw RPC binding, so Use admits only this Account Action carrier.
    // Other input-dependent Machine variants retain their native admission policy.
    // A declared client variant is delivered to the custodian's App on this
    // Machine, so the Action's own RPC policy decides. Home cannot tell the
    // variant from (possibly encrypted) input, so this keys on the declaration.
    let sessionSpawnAdmission: ApiTokenSessionSpawnAdmissionV1 | undefined;
    if (input.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && input.envelope) {
        try { sessionSpawnAdmission = readExternalActionSessionSpawnAdmission(input.envelope, {
            serverId: await initializeServerIdentityCache(), target: input.envelope.target }); }
        catch { return { kind: 'denied', code: 'unsupported_operation' }; }
    }
    const ordinary = await resolveMachineAdmissionInTx(reader, { actorAccountId: input.actorAccountId, machineId: input.machineId,
        callerAuthority: input.callerAuthority ?? input.authentication?.authenticationAuthority
            ?? (input.executionBinding ? readExternalActionBindingAuthority(input.executionBinding) : undefined),
        sessionActionOrigin: input.sessionActionOrigin ?? input.executionBinding?.sessionActionOrigin,
        executionBinding: input.executionBinding, sessionSpawnAdmission,
        ...(input.requireOnline === undefined ? {} : { requireOnline: input.requireOnline }),
        ...(input.actionId === 'approval.request.decide'
            ? { rpcMethod: RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED }
            : accountPlaced ? {} : { actionId: input.actionId }) });
    if (sessionSpawnAdmission?.managedPresetAcquisition) {
        if (sessionSpawnAdmission.executionTarget.serverId !== sessionSpawnAdmission.managedPresetAcquisition.selection.homeId
            || sessionSpawnAdmission.executionTarget.machineId !== input.machineId) return { kind: 'denied', code: 'access_denied' };
        return resolveSessionPresetActionMachineAdmissionInTx(reader, { ...input,
            acquisition: sessionSpawnAdmission.managedPresetAcquisition,
            ...(ordinary.kind === 'admitted' ? { ordinaryAdmission: ordinary } : {}),
        });
    }
    if (ordinary.kind === 'admitted' && ordinary.custodianAccountId !== input.actorAccountId
        && (input.actionId === 'machines.managed.acquire' || input.actionId === 'machines.managed.cancel' || input.actionId === 'machines.managed.delete')) {
        return resolveManagedActionMachineAdmissionInTx(reader, { ...input, ordinaryAdmission: ordinary });
    }
    return ordinary.kind === 'admitted' || input.actionId !== 'machines.managed.acquire'
        && !isExternalActionManagedResourceAction(input.actionId) && !isManagedControlAdmissionActionIdV1(input.actionId)
        ? ordinary : resolveManagedActionMachineAdmissionInTx(reader, input);
}

/** Existing host-private phases are effects of an accepted root, never public originators. */
function parseExternalActionEffectAction(binding: ExternalActionExecutionAuthorizationBindingV1, actionId: string) {
    return (isDocDiscussionEffect(binding.actionId, actionId) || isDocReadEffect(binding.actionId, actionId)
        || isSecondOpinionEffect(binding.actionId, actionId))
        ? SignedRootActionIdSchema.safeParse(actionId)
        : binding.handoffContinuation && binding.handoffAdmission && binding.actionId === actionId
        && isOriginalAccountHandoffAction(actionId)
        ? ActionIdSchema.safeParse(actionId)
        : 'authentication' in binding && (binding.authentication.kind === 'account'
            || binding.authentication.kind === 'terminal' && isOriginalTerminalExecutionAction(actionId, binding)
            || readExternalActionSessionProposalSurface(binding) !== undefined)
            ? SignedRootActionIdSchema.safeParse(actionId) : PublicActionIdSchema.safeParse(actionId);
}

/** Private phases spend only the original accepted handoff grant, never a fresh spawn grant. */
export function readExternalActionCredentialActionId(binding: ExternalActionExecutionAuthorizationBindingV1): string {
    return binding.handoffContinuation && binding.handoffAdmission
        && (isOriginalAccountHandoffAction(binding.actionId) || binding.actionId === 'session.spawn_new')
        ? 'session.handoff' : binding.actionId;
}

export { isExternalActionAuthorizationBoundToEnvelope };

/** The signed credential owner projects provenance once for admission and principals. */
/** Project the signed root's authority, narrowed only by the authenticated invocation ceiling. */
export function projectExternalActionBoundPrincipal(binding: ExternalActionExecutionAuthorizationBindingV1,
    current: ExternalActionServerPrincipalV1,
    authorityCeiling?: ExternalActionServerPrincipalV1['authority']): (ExternalActionServerPrincipalV1
        & Readonly<{ authority: ActionRequiredAuthority }>) | null {
    if (current.accountId !== binding.accountId) return null;
    if ('authentication' in binding) {
        if (!('authentication' in current)) return null;
        if (binding.workflowActionOrigin) return { accountId: binding.accountId, authentication: binding.authentication,
            authority: 'account_automation', workflowActionOrigin: binding.workflowActionOrigin };
        if (binding.authentication.kind === 'terminal') return { accountId: binding.accountId,
            authentication: binding.authentication, authority: 'account_automation',
            ...(binding.sessionActionOrigin ? { sessionActionOrigin: binding.sessionActionOrigin } : {}) };
        return binding.sessionActionOrigin
            ? { accountId: binding.accountId, authentication: binding.authentication,
                authority: 'account_automation', sessionActionOrigin: binding.sessionActionOrigin }
            : { accountId: binding.accountId, authentication: binding.authentication,
                authority: narrowCredentialAuthority(readExternalActionBindingAuthority(binding, current.authority), authorityCeiling) };
    }
    if ('authentication' in current) return null;
    return { accountId: binding.accountId, authority: 'account_automation', principalId: binding.principalId,
        credentialId: binding.credentialId, grant: binding.grant,
        ...(binding.workflowActionOrigin ? { workflowActionOrigin: binding.workflowActionOrigin } : {}) };
}

/** Keep verified private facts while the signed root owns immutable public provenance. */
function projectVerifiedExternalActionBoundPrincipal(binding: ExternalActionExecutionAuthorizationBindingV1,
    current: VerifiedExternalActionPrincipal): VerifiedExternalActionPrincipal | null {
    const bound = projectExternalActionBoundPrincipal(binding, current);
    if (!bound) return null;
    // Signed facts were read from this exact binding by the credential owner.
    if ('authentication' in current) return current;
    return 'authentication' in bound ? null : { ...current, ...bound };
}

/** Attribution for a signature-proved admitted job, never a fresh credential admission. */
function projectAcceptedDeploymentPrincipal(binding: ExternalActionExecutionAuthorizationBindingV1): VerifiedExternalActionPrincipal | null {
    const captured: VerifiedExternalActionPrincipal = 'authentication' in binding
        ? { accountId: binding.accountId,
            ...(binding.authentication.kind === 'terminal'
                ? { authentication: binding.authentication, authority: 'account_automation' as const }
                : { authentication: binding.authentication, authority: 'present_user' as const }),
            ...(binding.authentication.evidence ? { authenticationEvidence: binding.authentication.evidence } : {}) }
        : { accountId: binding.accountId, principalId: binding.principalId, credentialId: binding.credentialId,
            authority: 'account_automation', grant: binding.grant,
            // These credential-management facts are not consumed by finite deployment effects.
            expiresAt: null, parentTokenId: null, embedConfig: null };
    const bound = projectExternalActionBoundPrincipal(binding, captured);
    return bound ? { ...captured, ...bound } : null;
}

/**
 * Signed steps of an admitted finite native operation retain the mint's identity.
 * Receipt-backed operations consume the existing accepted-job lookup; other native
 * operations retain their signed admission and the executor's local cancel signal.
 * Every daemon-signed or person-presented root relay is new work and re-enters
 * full admission. A Workflow receipt keeps its active-Run lookup in the job owner.
 */
export function readAdmittedFiniteOperationPrincipal(binding: ExternalActionExecutionAuthorizationBindingV1,
    authorityCeiling?: ExternalActionServerPrincipalV1['authority'],
    acceptedDeployment?: NonNullable<Awaited<ReturnType<typeof readAcceptedDeploymentReceiptInTx>>>,
): VerifiedExternalActionPrincipal | null {
    const native = binding.deploymentNativeAdmission;
    const read = binding.deploymentReadAdmission;
    const finiteRead = read?.actionId === binding.actionId && read.actionId !== DEPLOYMENT_LOGS_READ_ACTION_ID_V1;
    const presetPreparation = binding.presetPreparationAdmission;
    const finitePresetPreparation = isMachinePresetFiniteOperationActionIdV1(binding.actionId) && presetPreparation !== undefined
        && presetPreparation.homeId === binding.serverIdentityId
        && (binding.actionId === MACHINE_PRESET_PREPARE_ACTION_ID_V1
            ? 'machineId' in presetPreparation && presetPreparation.machineId === binding.machineId
            : !('machineId' in presetPreparation));
    if (binding.handoffAdmission
        || presetPreparation && !finitePresetPreparation
        || !acceptedDeployment && !finitePresetPreparation && (binding.workflowActionOrigin || !native && !finiteRead && !(isDeploymentDomainDnsActionIdV1(binding.actionId) && binding.environmentId)
            || deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission) !== undefined)
        || native && (native.environmentId !== binding.environmentId
            || 'actionId' in native && binding.actionId !== native.actionId
            || 'machineId' in native && native.machineId !== binding.machineId
            || 'installationId' in native && native.installationId !== binding.installationId)
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId) return null;
    const captured = projectAcceptedDeploymentPrincipal(binding);
    const principal = captured && projectExternalActionBoundPrincipal(binding, captured, authorityCeiling);
    return captured && principal ? { ...captured, ...principal } : null;
}

/** The installed publisher transports an admitted Run; its credential never becomes the requester. */
export async function verifyWorkflowExternalActionRequesterAuthorization(input: Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1;
    origin: NonNullable<ExternalActionExecutionAuthorizationBindingV1['workflowActionOrigin']>;
    publisherAccountId: string;
    publisherCustodianAccountId: string;
    publisherMachineId: string;
    publisherInstallationId: string;
    target?: ExternalActionTargetV1;
    preparationAdmission?: ExternalActionExecutionAuthorizationBindingV1['deploymentPreparationAdmission'];
}>): Promise<WorkflowExternalActionAdmission | null> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(input.authorization.token);
    const reviewedChild = input.origin.reviewedChild;
    const combinedActionId = reviewedChild?.actionId ?? binding?.actionId;
    // The Run is the root's own Run, or a reviewed child's Run. A root's own Run
    // may carry the live Run's exact leaf proof for the receiver; it never names the Run.
    const isAdmittedRun = (actionId: typeof combinedActionId, child?: typeof reviewedChild) => !!binding && !!actionId
        && isMachineSetupCombinedActionIdV1(actionId) && deriveMachineSetupCombinedRunIdV1({ actionId,
            homeId: binding.serverIdentityId, accountId: binding.accountId, requestId: binding.requestId,
            ...(child ? { reviewedChild: child } : {}) }) === input.origin.runId;
    if (!binding || !matchesExternalActionAuthorizationBinding(binding, input.authorization.binding)
        || binding.serverIdentityId !== await initializeServerIdentityCache()
        || binding.custodianAccountId !== input.publisherCustodianAccountId
        || ('authentication' in binding ? binding.accountId : binding.custodianAccountId) !== input.publisherAccountId
        || binding.machineId !== input.publisherMachineId
        || binding.installationId !== input.publisherInstallationId
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId
        || binding.admittedMachineRole !== 'manage'
        || !isAdmittedRun(combinedActionId, reviewedChild)
            && !(reviewedChild?.actionId === binding.actionId && isAdmittedRun(binding.actionId))) return null;
    // A spawn-reviewed Setup parent admitted only its own Machine; its reviewed child digest pins the plan.
    const spawnSetupScope: Extract<NonNullable<ExternalActionExecutionAuthorizationBindingV1['deploymentPreparationAdmission']>,
        { operation: 'setup' }> | undefined = binding.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1
            ? { operation: 'setup', machineTargets: [binding.machineId], deployments: [] } : undefined;
    const scope = binding.deploymentPreparationAdmission ?? spawnSetupScope;
    const child = input.preparationAdmission;
    const target = input.target ?? binding.target;
    // Every child operand spends a reviewed parent fact, never new permission.
    if (target.kind !== 'machine' || scope?.operation !== 'setup' || child?.operation !== 'setup'
        || !child.machineTargets?.includes(target.machineId)
        || !child.machineTargets.every(machineId => scope.machineTargets?.includes(machineId))
        || !child.deployments.every(selected => scope.deployments.some(admitted => sameManagedInput(admitted, selected)))
        || !(child.catalogSources ?? []).every(selected => (scope.catalogSources ?? []).some(admitted => sameManagedInput(admitted, selected)))
        || !(child.connectorGrants ?? []).every(selected => (scope.connectorGrants ?? []).some(admitted => sameManagedInput(admitted, selected)))) return null;
    let receiverBinding = { ...binding, deploymentPreparationAdmission: child };
    if (target.machineId !== binding.machineId) {
        // The root admitted all selected Machines before any child effects.
        // Select this receiver's installation without evaluating its grants again.
        const admitted = await readAdmittedExternalActionMachineInTx(db, binding, target.machineId, undefined);
        if (!admitted) return null;
        receiverBinding = { ...receiverBinding, target, machineId: admitted.machineId,
            installationId: admitted.installationId, custodianAccountId: admitted.custodianAccountId };
    }
    const captured = projectAcceptedDeploymentPrincipal(receiverBinding);
    const principal = captured && projectExternalActionBoundPrincipal({ ...receiverBinding, workflowActionOrigin: input.origin }, captured);
    return principal ? { binding: { ...receiverBinding, admittedMachineRole: binding.admittedMachineRole }, principal } : null;
}

function readHandoffContinuationIssuanceAction(path: string): string | null {
    if (!path.startsWith(EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1) || !path.endsWith('/execution-authorization')) return null;
    try {
        const actionId = decodeURIComponent(path.slice(EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1.length).split('/')[0]);
        return (isOriginalAccountHandoffAction(actionId) && actionId !== 'session.handoff' || actionId === 'session.spawn_new')
            && path === bindExternalActionExecutionAuthorizationHttpPathV1(actionId) ? actionId : null;
    } catch { return null; }
}

/** The existing Session key and C41 admissions own both sides of one handoff. */
export async function readCurrentExternalActionHandoffBindingInTx(reader: Tx, input: Readonly<{
    accountId: string;
    requireSourceOnline?: true;
    handoffAdmission: NonNullable<ExternalActionExecutionAuthorizationBindingV1['handoffAdmission']>
        | Pick<NonNullable<ExternalActionExecutionAuthorizationBindingV1['handoffAdmission']>, 'sessionId' | 'sourceMachineId' | 'targetMachineId'>;
}> & Partial<MachineOperationRequesterContext>): Promise<NonNullable<ExternalActionExecutionAuthorizationBindingV1['handoffAdmission']> | null> {
    const { handoffAdmission: handoff } = input;
    const source = await resolveMachineAdmissionInTx(reader, { actorAccountId: input.accountId,
        machineId: handoff.sourceMachineId, ...(input.requireSourceOnline ? { requireOnline: true } : {}) });
    const target = await resolveMachineAdmissionInTx(reader, { actorAccountId: input.accountId,
        callerAuthority: input.callerAuthority, sessionActionOrigin: input.sessionActionOrigin,
        machineId: handoff.targetMachineId, actionId: 'session.open' });
    if (source.kind !== 'admitted' || target.kind !== 'admitted'
        || ('sourceInstallationId' in handoff && handoff.sourceInstallationId !== source.installationId)
        || ('targetInstallationId' in handoff && handoff.targetInstallationId !== target.installationId)
        || !await hasCurrentSessionActionRpcSourceBindingInTx(reader, { accountId: input.accountId,
            machineId: handoff.sourceMachineId, installationId: source.installationId,
            sourceSessionId: handoff.sessionId })) return null;
    return { sessionId: handoff.sessionId, sourceMachineId: handoff.sourceMachineId,
        targetMachineId: handoff.targetMachineId, sourceInstallationId: source.installationId,
        targetInstallationId: target.installationId };
}

type IssuedAcquireNativeFactPurpose = Readonly<{ kind: 'issued-managed-acquire-native-fact'; report: ManagedControllerReportV1 }>;
type IssuedIntentNativeFactPurpose = Readonly<{ kind: 'issued-managed-intent-native-fact'; report: ManagedControllerIntentReportV1 | ManagedControllerResizeReportV1 }>;
type IssuedNativeCredentialFactPurpose = Readonly<{ kind: 'issued-managed-native-credential-fact'; report: ReturnType<typeof ManagedControllerCredentialDeliveryReportV1Schema.parse> }>;
type RetainedDiscussionPublicationPurpose = Readonly<{ kind: 'retained-discussion-publication'; source: SessionInputSourceSessionV1 }>;
type ExternalActionVerificationPurpose = IssuedAcquireNativeFactPurpose | IssuedIntentNativeFactPurpose | IssuedNativeCredentialFactPurpose
    | RetainedDiscussionPublicationPurpose;

/** Consumption may end after submission; only that installed operation may report its disposition. */
async function isIssuedNativeCredentialFactReportInTx(reader: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    report: IssuedNativeCredentialFactPurpose['report']): Promise<boolean> {
    const accepted = binding.managedAdmission;
    const delivery = report.credentialDelivery;
    if (binding.actionId !== 'machines.managed.credentials.install' || accepted?.actionId !== binding.actionId
        || !('result' in delivery) || !sameManagedInput(accepted.input, delivery.request)
        || binding.serverIdentityId !== report.homeId || accepted.input.homeId !== report.homeId
        || accepted.input.managedId !== report.managedId
        || binding.machineId !== report.controller.machineId || binding.installationId !== report.controller.installationId) return false;
    try {
        const row = await requireCurrentManagedMachineInTx(reader, report,
            { requestAuthority: 'intent', allowInactiveCurrentIntent: true });
        if (row.custodianAccountId !== binding.custodianAccountId) return false;
        const current = await readManagedCredentialDeliverySubmittedAuthorityInTx(reader, {
            actorAccountId: binding.accountId, machineId: binding.machineId, request: accepted.input,
            authentication: { env: process.env, authority: readExternalActionBindingAuthority(binding),
                authenticationEvidence: 'authentication' in binding ? binding.authentication.evidence : undefined },
            continuingRequestId: binding.requestId,
            sessionActionOrigin: binding.sessionActionOrigin, sessionActionSource: binding.sessionActionSource,
        });
        return current !== null && (delivery.result.kind !== 'confirmed'
            || sameManagedInput(delivery.result.binding, current.binding.safeFacet));
    } catch (error) {
        if (!(error instanceof ManagedMachineError)) throw error;
        return false;
    }
}

/** Root verification only: final publication still opens the approved Artifact at its trusted host. */
async function isRetainedDiscussionPublicationSourceCurrentInTx(reader: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, source: SessionInputSourceSessionV1): Promise<boolean> {
    const original = binding.sessionActionOrigin;
    const installation = binding.sessionActionSource;
    if (!('authentication' in binding) || !['discussion.post', 'discussion.reply'].includes(binding.actionId)
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId
        || !original || !installation || installation.machineId !== binding.machineId
        || installation.installationId !== binding.installationId
        || !source.sourceInputId || !source.discussionAddressing
        || source.sourceSessionId !== original.caller.sessionId
        || source.sourceInputId !== original.sourceInputId || source.sourceTurnId !== original.sourceTurnId
        || source.discussionAddressing.participantSessionId !== source.sourceSessionId
        || !await isSessionInputSourceCurrentInTx(reader, binding.accountId, source)) return false;
    const retained = await readSessionMessageReplyInTx(reader, { accountId: binding.accountId,
        sessionId: source.sourceSessionId, localId: source.sourceInputId,
        authentication: { env: process.env, authority: 'account_automation', tokenEpoch: binding.authentication.tokenEpoch,
            authenticationEvidence: binding.authentication.evidence } });
    return retained.status === 'available' && retained.progress.mode === 'return' && !retained.progress.workflow
        && retained.progress.acceptedTurnId === source.sourceTurnId
        && sameStrictJsonValue(retained.progress.discussion, source.discussionAddressing);
}

/** The active resize request already admitted its actor; native facts do not re-check access or intent. */
async function isIssuedResizeNativeFactReportInTx(reader: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    report: ManagedControllerResizeReportV1): Promise<boolean> {
    if (binding.actionId !== MANAGED_RESIZE_ACTION_ID_V1 || binding.serverIdentityId !== report.homeId
        || binding.requestId !== report.requestId || binding.managedAdmission?.actionId !== binding.actionId
        || binding.managedAdmission.input.managedId !== report.managedId) return false;
    try {
        const row = await requireActiveManagedResizeInTx(reader, report);
        return row.custodianAccountId === binding.custodianAccountId;
    } catch (error) {
        if (!(error instanceof ManagedMachineError)) throw error;
        return false;
    }
}

/** Retirement closes effects, not facts of the submitted or still-current admitted command. */
async function isIssuedIntentNativeFactReportInTx(reader: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    report: ManagedControllerIntentReportV1): Promise<boolean> {
    if (!isManagedPowerOrDeleteActionIdV1(binding.actionId)
        || binding.serverIdentityId !== report.homeId || binding.requestId !== report.requestId
        || (report.controller !== undefined && (binding.machineId !== report.controller.machineId
            || binding.installationId !== report.controller.installationId))) return false;
    try {
        const row = await readManagedMachineInTx(reader, report);
        const pending = readManagedIntentReportAuthority(row, report);
        return row.custodianAccountId === binding.custodianAccountId && pending !== undefined
            && (binding.actionId === 'machines.managed.delete' ? pending.intent === 'delete' : pending.intent === 'stop' || pending.intent === 'suspend' || pending.intent === 'start' || pending.intent === 'resume');
    } catch (error) {
        if (!(error instanceof ManagedMachineError)) throw error;
        return false;
    }
}

/** A submitted purchase may still return its identity after its source stops admitting effects. */
async function isIssuedAcquireNativeFactReportInTx(reader: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    report: ManagedControllerReportV1): Promise<boolean> {
    if ((report.result.kind !== 'bound' && report.result.kind !== 'pending')
        || (binding.actionId !== 'machines.managed.acquire' && binding.actionId !== 'machines.managed.bootstrap.retry')
        || binding.serverIdentityId !== report.homeId
        || (report.controller !== undefined && (binding.machineId !== report.controller.machineId
            || binding.installationId !== report.controller.installationId))
        // Retry keeps its own signed Action correlation; its body addresses
        // the original purchase returned by the existing controller context.
        || (binding.actionId === 'machines.managed.acquire' && binding.requestId !== report.requestId)) return false;
    try {
        const row = await requireCurrentManagedMachineInTx(reader, report,
            { requestAuthority: 'creation', allowCanceledResourceReport: true });
        return row.custodianAccountId === binding.custodianAccountId
            && (row.allocation === 'may-exist' || (report.result.kind === 'bound' && row.allocation === 'bound'));
    } catch (error) {
        if (!(error instanceof ManagedMachineError)) throw error;
        return false;
    }
}

/**
 * A Machine target is placement for opaque Session input, not Session access.
 * The daemon resolves the decrypted selector and signs that Session target;
 * issuance, principal currentness and resolved-effect verification share this
 * owner and the existing exact Session/Machine access proof.
 */
export async function hasCurrentOriginalSessionActionTargetInTx(
    reader: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1,
    target: ExternalActionTargetV1 = binding.target,
): Promise<boolean> {
    const action = SignedRootActionIdSchema.safeParse(binding.actionId);
    if (!('authentication' in binding) || binding.handoffAdmission
        || !action.success || getActionSpec(action.data).executionPlacement !== 'session') return true;
    // The installed transition coordinator reads ancestry before routing the
    // incumbent. Its exact HTTP/RPC purpose owners retain ordinary Session
    // access; a pre-existing Session/Machine access key is not its root contract.
    if (binding.actionId === 'session.agent.transition' || binding.actionId === 'session.continuation.inspect') return true;
    // A Run's assigned executor signs the call, while another admitted Machine
    // may host the exact target Session. Its existing key owner proves custody.
    if (binding.workflowActionOrigin) return binding.workflowActionOrigin.sessionAuthority !== undefined
        && binding.target.kind === 'session' && target.kind === 'session' && target.sessionId === binding.target.sessionId
        && hasCurrentMachineAccessForSessionInTx({ tx: reader, accountId: binding.accountId, sessionId: target.sessionId });
    return target.kind === 'machine'
        ? target.machineId === binding.machineId
        : hasCurrentSessionScopedMachineAccessInTx({ tx: reader, accountId: binding.accountId,
            machineId: binding.machineId, sessionId: target.sessionId });
}

/** Issuance and currentness share FIN's assigned publisher and retained origin proof. */
export async function hasCurrentExternalActionWorkflowOriginInTx(reader: Tx, input: DeploymentWorkflowOriginInput,
    continuation?: DeploymentReceiptContinuation, phase: MachineWorkflowOriginPhase = 'admission'): Promise<boolean> {
    const origin = input.workflowActionOrigin;
    if (!origin || origin.requestId !== input.requestId || !isExternalActionWorkflowActionIdV1(input.actionId)) return false;
    if (origin.sessionLeaf || input.admittedMachineRole !== undefined) {
        // The installed FIN producer already admitted the exact leaf/Session.
        // Home cannot open that E2EE binding; later effects only read Run liveness.
        return await reader.automationRun.findFirst({ where: { id: origin.runId, accountId: input.accountId,
            claimedByMachineId: input.publisherMachineId ?? (origin.sessionLeaf ? input.machineId : { not: null }),
            workflowAcceptedSnapshotEnvelope: { not: null }, workflowCustodyState: 'pending',
            state: { in: ['claimed', 'running'] } }, select: { id: true } }) !== null;
    }
    const managed = ManagedMachineActionIdV1Schema.safeParse(input.actionId).success;
    if (!managed && isExternalActionMachineWorkflowActionIdV1(input.actionId)) {
        return hasCurrentDeploymentWorkflowOriginInTx(reader, input, continuation, phase);
    }
    if (managed) {
        if (input.target.kind !== 'machine') return false;
        // Preserve ordinary assigned-host effects, including retained FIN scope ends.
        if (input.target.machineId === input.machineId && await isAutomationOriginRunPublisherTx(reader, {
            accountId: input.accountId, machineId: input.machineId, runId: origin.runId, requireCurrentScopeEnd: true })) return true;
        // Reuse Deployment's accepted Run/publisher placement. Home cannot
        // decide child consent from E2EE content; the receiver owns that match.
        const target = await readCurrentMachineWorkflowOriginInTx(reader, input, phase);
        return target?.accountId === input.accountId;
    }
    const catalogAction = ActionIdSchema.safeParse(input.actionId);
    if (catalogAction.success && isInstalledSessionClientAction(getActionSpec(catalogAction.data), { workflowActionOrigin: origin })) {
        return await readCurrentMachineWorkflowOriginInTx(reader, input, phase) !== null;
    }
    const publisher = await isAutomationOriginRunPublisherTx(reader, { accountId: input.accountId, machineId: input.machineId,
        runId: origin.runId, requireCurrentScopeEnd: true });
    if (!publisher || !origin.sessionAuthority || input.target.kind !== 'session') return false;
    const run = await reader.automationRun.findUnique({ where: { id: origin.runId }, select: { originSessionId: true } });
    return run !== null && run.originSessionId === (origin.sessionAuthority.runOriginSessionId ?? null);
}

async function readCurrentExternalActionPrincipal(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    reader: Tx,
    purpose?: ExternalActionVerificationPurpose,
    deploymentContinuation?: DeploymentReceiptContinuation,
    retainedCreationAdmission?: Awaited<ReturnType<typeof hasAdmittedManagedCreationRootInTx>>,
): Promise<VerifiedExternalActionPrincipal | null> {
    // Fresh reviewer roots obey the replay owner's provenance policy at mint
    // and principal projection; local host approval waivers do not grant replay custody.
    if (binding.actionId === 'approval.request.decide'
        && resolveMachineRpcExternalActionEffectV1(RPC_METHODS.APPROVAL_REQUEST_DECIDE, binding) !== binding.actionId) return null;
    if (binding.workflowActionOrigin) {
        if (!isExternalActionWorkflowActionIdV1(binding.actionId)
            || purpose?.kind !== 'issued-managed-intent-native-fact'
                && purpose?.kind !== 'issued-managed-native-credential-fact'
                && !await hasCurrentExternalActionWorkflowOriginInTx(reader, binding, deploymentContinuation, 'execution')) return null;
        // The assigned Run already admitted its requester. Later effects retain
        // that signed identity and consult the existing active-job owner only.
        return projectAcceptedDeploymentPrincipal(binding);
    }
    if (binding.handoffAdmission) {
        if (!await readAdmittedExternalActionHandoffMachineInTx(reader, binding)) return null;
        // The signed root owns bounded work. Credential/grant withdrawal is
        // observed by the next admission; the daemon owns Stop and cancellation.
        if (!('authentication' in binding)) return { accountId: binding.accountId, principalId: binding.principalId,
            credentialId: binding.credentialId, authority: 'account_automation', grant: binding.grant,
            // These live-bearer fields do not govern a retained signed admission.
            expiresAt: null, parentTokenId: null, embedConfig: null };
        const evidence = binding.authentication.evidence ? { authenticationEvidence: binding.authentication.evidence } : {};
        // Session-origin and terminal bindings are automation by the binding-authority owner's rule.
        if (binding.sessionActionOrigin) return { accountId: binding.accountId, authentication: binding.authentication,
            authority: 'account_automation', sessionActionOrigin: binding.sessionActionOrigin, ...evidence };
        return binding.authentication.kind === 'terminal'
            ? { accountId: binding.accountId, authentication: binding.authentication, authority: 'account_automation', ...evidence }
            : { accountId: binding.accountId, authentication: binding.authentication,
                authority: readExternalActionBindingAuthority(binding), ...evidence };
    }
    if (binding.accountEncryptionMode !== undefined) {
        const account = await reader.account.findUnique({ where: { id: binding.accountId }, select: { encryptionMode: true } });
        if (account?.encryptionMode !== binding.accountEncryptionMode) return null;
    }
    if (binding.managedContinuation) {
        return await readAdmittedManagedCreationChildInTx(reader, binding) ? projectAcceptedDeploymentPrincipal(binding) : null;
    }
    const retainedCreation = retainedCreationAdmission === undefined
        ? await hasAdmittedManagedCreationRootInTx(reader, binding) : retainedCreationAdmission;
    if (retainedCreation !== null) return retainedCreation ? projectAcceptedDeploymentPrincipal(binding) : null;
    if (binding.sessionActionOrigin) {
        const nativeReleaseSourceCurrent = await readNativeCredentialReleaseSourceCurrentInTx(reader, binding);
        if (!('authentication' in binding) || !binding.sessionActionSource
            || binding.sessionActionOrigin.requestId !== binding.requestId
            || (purpose?.kind !== 'issued-managed-acquire-native-fact' && purpose?.kind !== 'issued-managed-native-credential-fact'
                && !(nativeReleaseSourceCurrent ?? await hasCurrentSessionActionRpcSourceBindingInTx(reader, { accountId: binding.accountId,
                    ...binding.sessionActionSource, sourceSessionId: binding.sessionActionOrigin.caller.sessionId })))) return null;
        const action = ActionIdSchema.safeParse(binding.actionId);
        if (action.success && getActionSpec(action.data).originalExecution?.nativePurpose === 'session_board_write' && (binding.target.kind !== 'session'
            || binding.target.sessionId !== binding.sessionActionOrigin.caller.sessionId
            || binding.machineId !== binding.sessionActionSource.machineId)) return null;
    }
    if ('authentication' in binding) {
        if (!isOriginalAccountExecutionAction(binding.actionId, binding)
            && !(binding.authentication.kind === 'terminal' && isOriginalTerminalExecutionAction(binding.actionId, binding))
            && !(MANAGED_MACHINE_CREATION_CHILD_ACTION_IDS_V1.some(id => id === binding.actionId) && binding.managedContinuation)
            && !(binding.actionId === 'session.spawn_new' && binding.handoffContinuation)
            && !(binding.handoffContinuation && isOriginalAccountHandoffAction(binding.actionId))) return null;
        if (!await hasCurrentOriginalSessionActionTargetInTx(reader, binding)) return null;
        if (!await auth.isSignedCredentialCurrent(reader, binding.accountId, binding.authentication.tokenEpoch)) return null;
        const authority = readExternalActionBindingAuthority(binding);
        const base = { accountId: binding.accountId, authentication: binding.authentication,
            ...(binding.authentication.evidence ? { authenticationEvidence: binding.authentication.evidence } : {}) };
        if (binding.authentication.kind === 'terminal') {
            if (!isOriginalTerminalExecutionAction(binding.actionId, binding)) return null;
            return { accountId: binding.accountId, authentication: binding.authentication, authority: 'account_automation',
                ...(binding.authentication.evidence ? { authenticationEvidence: binding.authentication.evidence } : {}),
                ...(binding.sessionActionOrigin ? { sessionActionOrigin: binding.sessionActionOrigin } : {}) };
        }
        return authority === 'account_automation' && binding.sessionActionOrigin
            ? { ...base, authority, sessionActionOrigin: binding.sessionActionOrigin }
            : { ...base, authentication: binding.authentication, authority: 'present_user' };
    }
    const principal = await auth.verifyCurrentApiTokenPrincipal(binding, undefined, reader);
    if (!principal || !isApiTokenGrantWithinV1(binding.grant, principal.grant)) return null;
    const qualifiedAction = parseQualifiedPluginActionId(binding.actionId);
    if (!evaluateApiTokenGrantV1({
        grant: principal.grant,
        actionId: qualifiedAction ? "action.invoke" : readExternalActionCredentialActionId(binding),
        contributedActionAdmission: 'pre_open',
        automationAdmission: 'pre_open',
        ...(qualifiedAction ? { contributedQualifiedId: binding.actionId } : {}),
        target: binding.target,
        targetMachineId: binding.machineId,
        automationId: binding.automationId,
        ...(binding.environmentId ? { environmentId: binding.environmentId,
            ...(API_TOKEN_ENVIRONMENT_ACTION_IDS_V1.some(id => id === binding.actionId) ? { environmentAdmission: 'pre_open' as const } : {}) } : {}),
    }).ok) return null;
    if (binding.actionId === 'action.operations.get' && binding.environmentId) {
        const environment = await loadDeploymentEnvironmentInTx(reader, binding.accountId, binding.serverIdentityId,
            binding.environmentId, { authenticationAuthority: 'account_automation', authenticationEvidence: principal.authenticationEvidence });
        if (!environment.ok) return null;
    }
    return principal;
}

async function verifyCurrentExternalActionPrincipalForPurpose(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    purpose?: ExternalActionVerificationPurpose,
    deploymentContinuation?: DeploymentReceiptContinuation,
    retainedCreationAdmission?: Awaited<ReturnType<typeof hasAdmittedManagedCreationRootInTx>>,
): Promise<VerifiedExternalActionPrincipal | null> {
    if (binding.handoffAdmission || binding.workflowActionOrigin?.sessionLeaf) {
        return readCurrentExternalActionPrincipal(binding, db, purpose, deploymentContinuation, retainedCreationAdmission);
    }
    const principal = await readCurrentExternalActionPrincipal(binding, db, purpose, deploymentContinuation, retainedCreationAdmission);
    if (!principal) return null;
    const eligibility = await enforceLoginEligibility({ accountId: principal.accountId, readEnv: () => readHomeConfigEnv() });
    if (!eligibility.ok && eligibility.statusCode === 503) {
        // Unavailable eligibility evidence is not a revoked signed credential.
        throw Object.assign(new Error(eligibility.error), { statusCode: 503, code: eligibility.error });
    }
    return eligibility.ok ? principal : null;
}

export async function verifyCurrentExternalActionPrincipal(
    binding: ExternalActionExecutionAuthorizationBindingV1,
): Promise<VerifiedExternalActionPrincipal | null> {
    return verifyCurrentExternalActionPrincipalForPurpose(binding);
}

/**
 * Transaction-only current-row recheck for a host invocation already admitted
 * by verifyCurrentExternalActionPrincipal before entering the transaction.
 * Never accepts a raw header as proof and never repeats provider/network I/O.
 */
export async function verifyCurrentExternalActionPrincipalInTx(
    tx: Tx,
    alreadyVerifiedInvocation: ExternalActionExecutionAuthorizationBindingV1,
): Promise<VerifiedExternalActionPrincipal | null> {
    return readCurrentExternalActionPrincipal(alreadyVerifiedInvocation, tx);
}

export type VerifiedExternalActionExecutionRequest = Readonly<{
    /** Signed Session routing scope; the router admits Session access and the exact publisher. */
    sessionRpcTarget?: Readonly<{ sessionId: string; machineId: string }>;
    /** One private acquisition admission; HTTP authentication consumes its typed result. */
    machineNpmProfileAdmission?: Awaited<ReturnType<typeof resolveMachineAdmissionInTx>>;
    /** The ordinary child Action's admission, consumed by the RPC router once. */
    sessionAgentReadinessAdmission?: Extract<Awaited<ReturnType<typeof resolveMachineAdmissionInTx>>, { kind: 'admitted' }>;
    /** Prepare's signed Session input carrier; the Pending owner admits its runtime target. */
    deploymentPrepareSessionInput?: Readonly<{ sessionId: string; targetMachineId: string }>;
    binding: ExternalActionExecutionAuthorizationBindingV1;
    effectActionId: string;
    target: ExternalActionTargetV1;
    principal: VerifiedExternalActionPrincipal;
    /** Request-local ceiling; never rewrites verified credential provenance. */
    effectiveAuthority: VerifiedExternalActionPrincipal['authority'];
    /** Home-derived private phase, never a caller-authored guest grant. */
    managedGuestActivity?: Readonly<{ machineId: string; installationId: string; encryptionMode: 'plain' | 'e2ee' }>;
    /** Exact controller qualified by the installed post-approval spawn child. */
    nativeCredentialSpawnChildAdmission?: Readonly<{ machineId: string; installationId: string; custodianAccountId: string }>;
    /** Exact snapshot operands passed the captured grant and this root's read-purpose admission. */
    sessionSnapshotBatchAdmitted?: true;
    /** The receiver spends the exact controller-signed packet, retaining the original credential. */
    deploymentChildRouting?: DeploymentChildRoutingV1;
    /** Actual finite byte requester; the original deployment principal remains separate. */
    deploymentChildSigner?: Readonly<{ machineId: string; installationId: string; custodianAccountId: string }>;
    /** Private original-requester codec authority, not the actual finite actor. */
    deploymentChildCodecAdmission?: DeploymentChildMachineRead['codecAdmission'];
    deploymentChildMachineRead?: DeploymentChildMachineRead;
    deploymentChildAdmission?: DeploymentChildAdmission;
    /** The receipt owner accepted this exact root and installed controller. */
    acceptedDeploymentReceipt?: Readonly<{ platformMaterial?: NonNullable<ReturnType<typeof readDeploymentPlatformMaterialHttpPurpose>>;
        /** The accepted receipt's Environment, which joins the admitted deployment scope. */
        environmentId?: string;
        read?: Readonly<{ environmentId?: string; deploymentId?: string;
        /** Exact finite native read, including its captured content custody. */
        contentCustody?: true }> }>;
    actionBrokerAdmission?: NonNullable<ReturnType<typeof readActionBrokerHttpPurpose>> & Readonly<{ rootActionId: string; machineId: string; admittedReviewedChildActionId?: string }>;
    /** Exact signed requester Action; Team admission decides declaration and source before disclosure. */
    actionMaterialAdmission?: NonNullable<ReturnType<typeof readActionMaterialHttpPurpose>> & Readonly<{ rootActionId: string; machineId: string; admittedReviewedChildActionId?: string }>;
    /** Exact Environment selected by an admitted finite registry update check. */
    registryAppUpdateRead?: Readonly<{ environmentId: string }>;
    deploymentChildArtifactRead?: Readonly<{ content: import('@happier-dev/protocol').DeploymentArtifactContentReferenceV1; requesterAccountId: string }>;
    deploymentDomainPurpose?: DomainHttpPurpose;
    /** One signed create-purpose result; consumers never infer scope from a raw header. */
    createPreparationAdmission?: DeploymentCreateHttpPurpose;
    /** Exact Source read produced once by the signed preparation owner. */
    deploymentPreparationSourceRead?: DeploymentPreparationSourceRead;
    /** The target-enable purpose owner consumed this exact signed managed operation. */
    deploymentTargetRetentionAdmission?: DeploymentTargetRetentionHttpPurpose;
    /** The setup role consumed only its root's admitted Environment or Link Artifact read purpose. */
    deploymentReviewedSetupRead?: true;
    reviewedChildAdmission?: ReviewedActionChildHttpProofV1;
    /** Setup catalog target that signed this read; it spends only its paired operands. */
    setupReceiverMachineId?: string;
}>;

type ExternalActionExecutionRequestProof = Readonly<{
    authorizationToken: string;
    machineSignature: string;
    effectActionId: string;
    encodedTarget: string;
    method: string;
    path: string;
    body: unknown;
    deploymentChildExecution?: DeploymentChildExecutionProofV1;
    reviewedChild?: ReviewedActionChildHttpProofV1;
    idempotencyKey?: string;
    /** Validated HTTP route operands, used only to compare with the canonical Action binding. */
    routeInput?: unknown;
    /** Session selected by the HTTP route's incumbent operation/target policy, never by a header. */
    sessionRouteTarget?: Extract<ExternalActionTargetV1, { kind: 'session' }>
        & Readonly<{ actionId?: ActionId; additionalSessionIds?: readonly string[] }>;
    resolveCurrentSessionMachine?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<string | null>;
    /** Project the owner's existing refusal; never repeat authorization at the adapter. */
    onRefusal?: (phase: ExternalActionAuthorizationRefusalPhase, failure?: ActionExecuteFailure) => void;
}>;

/** An owning installed lifetime may remove its exact rule after its ingress ends. */
async function readNativeCredentialReleaseSourceCurrentInTx(reader: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1): Promise<boolean | null> {
    const native = binding.managedAdmission;
    if (binding.sessionActionOrigin && binding.actionId === 'machines.managed.credentials.install'
        && native?.actionId === binding.actionId && native.input.operation === 'release') {
        if (!binding.sessionActionSource) return false;
        return await readManagedCredentialDeliveryAuthorityInTx(reader, { actorAccountId: binding.accountId,
            machineId: binding.machineId, request: native.input,
            authentication: { env: process.env, authority: 'account_automation',
                authenticationEvidence: 'authentication' in binding ? binding.authentication.evidence : undefined },
            continuingRequestId: binding.requestId,
            sessionActionOrigin: binding.sessionActionOrigin, sessionActionSource: binding.sessionActionSource }) !== null;
    }
    return null;
}

export async function hasCurrentExternalActionSessionSource(binding: ExternalActionExecutionAuthorizationBindingV1,
    resolveCurrentSessionMachine: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
    retainedCreationAdmission?: Awaited<ReturnType<typeof hasAdmittedManagedCreationRootInTx>>): Promise<boolean> {
    const nativeReleaseSourceCurrent = await readNativeCredentialReleaseSourceCurrentInTx(db, binding);
    if (nativeReleaseSourceCurrent !== null) return nativeReleaseSourceCurrent;
    if (binding.handoffAdmission) return hasAdmittedExternalActionHandoffScope(binding);
    if (binding.managedContinuation) return Boolean(await readAdmittedManagedCreationChildInTx(db, binding));
    if (retainedCreationAdmission === undefined
        ? await hasAdmittedManagedCreationRootInTx(db, binding) : retainedCreationAdmission) return true;
    return !binding.sessionActionOrigin || Boolean(binding.sessionActionSource
        && await hasCurrentSessionActionRpcSourceBinding({ accountId: binding.accountId,
            ...binding.sessionActionSource, sourceSessionId: binding.sessionActionOrigin.caller.sessionId,
            resolveCurrentSessionMachine }));
}

async function hasCurrentExecutionMachineAdmission(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    admittedMachine?: Readonly<{ accountId: string; kind: string; installationId: string | null;
        revokedAt: Date | null; replacedByMachineId: string | null }>,
): Promise<boolean> {
    const machine = admittedMachine ?? await db.machine.findFirst({
        where: { id: binding.machineId, accountId: binding.custodianAccountId, installationId: binding.installationId },
        select: { accountId: true, kind: true, installationId: true, revokedAt: true, replacedByMachineId: true },
    });
    if (!machine || classifyMachineAvailabilityState(machine) !== 'available'
        || machine.accountId !== binding.custodianAccountId || machine.installationId !== binding.installationId) return false;
    // This signed leaf already owns admission. The principal check reads its
    // active Run; the installation check above authenticates this later call.
    if (binding.workflowActionOrigin) return true;
    // Handoff-bound calls retain requester attribution through the authenticated
    // handoff tuple; other signed calls use their existing admission.
    if (binding.handoffAdmission) {
        return await readAdmittedExternalActionHandoffMachineInTx(db, binding) !== null;
    }
    // Restricted Runner admission is Session/credential-owned, not a persistent Machine grant.
    if (machine.kind === 'ephemeral_session_runner') return binding.accountId === machine.accountId;
    return true;
}

function isContributedActionRoot(actionId: string): boolean {
    return actionId === 'action.invoke' || parseQualifiedPluginActionId(actionId) !== null;
}

function hasMatchingExecutionEffectFamily(rootActionId: string, effectActionId: string): boolean {
    const managedRoot = ManagedMachineActionIdV1Schema.safeParse(rootActionId);
    const managedEffect = ManagedMachineActionIdV1Schema.safeParse(effectActionId);
    if (managedRoot.success || managedEffect.success) return managedRoot.success && managedEffect.success
        && managedRoot.data === managedEffect.data;
    const root = MachineAccessActionIdSchema.safeParse(rootActionId);
    const effect = MachineAccessActionIdSchema.safeParse(effectActionId);
    return !root.success && !effect.success
        || root.success && effect.success && root.data === effect.data;
}

/** Private Usage evidence reads retain their original signed Action root. */
function isPersonalUsageReadEffect(rootActionId: string, effectActionId: string): boolean {
    if (rootActionId === 'usage.calendar.export') return effectActionId === 'connectedServices.quota.get';
    return (rootActionId === 'usage.query' || rootActionId === 'usage.export'
        || isUsagePrivateRecapActionIdV1(rootActionId)
        || rootActionId === 'usage.coach.dismiss' || rootActionId === 'usage.coach.snooze'
        || rootActionId === 'usage.coach.apply' || rootActionId === 'usage.coach.undo')
        && (effectActionId === 'usage.query' || effectActionId === 'connectedServices.quota.get');
}

/** Public preparation reads its owner, eligible Usage and selected private definitions before review. */
function isPublicProfilePreparationEffect(rootActionId: string, effectActionId: string): boolean {
    if (!isPublicProfilePreparationActionIdV1(rootActionId)) return false;
    return effectActionId === 'account.public_profile.get'
        || effectActionId === 'usage.query'
        || effectActionId === 'artifact.get' && (rootActionId === 'account.public_profile.preview'
            || rootActionId === 'account.public_profile.publish' || rootActionId === 'account.public_profile.update');
}

/** The retained control admission is the only producer of a guest observation scope. */
export async function readCurrentManagedGuestActivityInTx(reader: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, machineId: string,
    target?: ManagedActivityRpcRequestV1): Promise<VerifiedExternalActionExecutionRequest['managedGuestActivity'] | null> {
    if (!isManagedPowerOrDeleteActionIdV1(binding.actionId)
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId) return null;
    try {
        if (!await verifyCurrentExternalActionPrincipalInTx(reader, binding)) return null;
        const enrolled = await reader.managedMachine.findUnique({ where: { enrolledMachineId: machineId } });
        if (!enrolled || enrolled.homeId !== binding.serverIdentityId || enrolled.custodianAccountId !== binding.custodianAccountId) return null;
        const currentTarget = target ?? { homeId: enrolled.homeId, managedId: enrolled.id, expectedRevision: enrolled.intentRevision,
            ...(enrolled.controllerMachineId === null ? {} : {
                controller: { machineId: binding.machineId, installationId: binding.installationId } }) };
        const row = await requireCurrentManagedMachineInTx(reader, { ...currentTarget,
            expectedIntentRevision: currentTarget.expectedRevision, requestId: binding.requestId });
        const admission = readManagedAdmissionState(row.admittedInput).currentAdmission;
        const accountExecutor = row.controllerMachineId === null && row.custodianAccountId === binding.accountId
            && binding.managedAccountExecutor?.enrolledMachineId === row.enrolledMachineId
            && binding.managedAdmission?.actionId === binding.actionId && admission?.kind === 'control'
            && sameManagedInput(binding.managedAdmission.input, admission.request.input);
        const guestOwner = readManagedEnrollmentAccountId(row);
        if (target === undefined && guestOwner !== row.custodianAccountId) return null;
        if (row.id !== enrolled.id || row.enrolledMachineId !== machineId || !hasBoundManagedLifecycle(row)
            || row.desiredWhen !== 'after-idle'
            || !(accountExecutor || row.controllerMachineId === binding.machineId && row.controllerInstallationId === binding.installationId)
            || admission?.kind !== 'control' || admission.request.action !== binding.actionId
            || !isManagedPowerOrDeleteActionIdV1(admission.request.action)
            || admission.request.requestId !== binding.requestId
            || admission.request.input.homeId !== row.homeId || admission.request.input.managedId !== row.id
            || admission.request.input.when !== 'after-idle'
            || admission.request.input.intent !== row.desired) return null;
        // The proved controller uses its custodian's transport for this exact
        // retained guest. The signed scope admits only this carrier; the guest
        // activity owner retains its exact bound-operation policy.
        const guest = await resolveManagedGuestActivityAdmissionInTx(reader, { actorAccountId: binding.accountId,
            machineId, rpcMethod: 'action' in currentTarget ? MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD : MANAGED_ACTIVITY_READ_RPC_METHOD,
            target: currentTarget });
        return guest?.kind === 'admitted' && guest.custodianAccountId === guestOwner && guest.installationId
            ? { machineId, installationId: guest.installationId, encryptionMode: guest.encryptionMode } : null;
    } catch (error) {
        if (error instanceof ManagedMachineError) return null;
        throw error;
    }
}

/** An admitted continuation retains its captured source signer, never its private key. */
async function readCurrentExternalActionSourceSigningPublicKey(
    binding: ExternalActionExecutionAuthorizationBindingV1,
): Promise<Uint8Array | null> {
    let source: Readonly<{ machineId: string; installationId: string }> | undefined;
    if (binding.handoffContinuation || binding.handoffPreflight) {
        const handoff = binding.handoffAdmission;
        if (!handoff || !hasAdmittedExternalActionHandoffScope(binding)) return null;
        source = { machineId: handoff.sourceMachineId, installationId: handoff.sourceInstallationId };
    } else if ('authentication' in binding && binding.sessionActionOrigin && binding.sessionActionSource) {
        source = binding.sessionActionSource;
        if (!await hasCurrentSessionActionRpcSourceBindingInTx(db, { accountId: binding.accountId,
            ...source, sourceSessionId: binding.sessionActionOrigin.caller.sessionId })) return null;
    }
    if (!source) return null;
    const machine = await db.machine.findUnique({ where: { id: source.machineId }, select: {
        installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true,
    } });
    return machine?.installationId === source.installationId
        && classifyMachineAvailabilityState(machine) === 'available' ? machine.installationPublicKey : null;
}

function isTeamCredentialUsageExportReadEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'teams.credentials.usage.export' && effectActionId === 'teams.credentials.usage.query';
}

/** Doc posting composes C3; proposal decisions and Artifact writes are never children. */
function isDocDiscussionEffect(rootActionId: string, effectActionId: string): boolean {
    return (rootActionId === 'doc.comment.reply' || rootActionId === 'doc.edit.propose')
        && (effectActionId === 'discussion.read' || effectActionId === 'discussion.post' || effectActionId === 'discussion.reply'
            || rootActionId === 'doc.comment.reply' && effectActionId === 'discussion.create');
}

/** Doc reads consume their Artifact codec and one source-scoped, batched count list. */
function isDocReadEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'doc.read' && (effectActionId === 'artifact.get' || effectActionId === 'discussion.list');
}

/** The installed composition signs these consumed owners; this is no sibling management grant. */
function isSecondOpinionEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'discussion.second_opinion.start' && [
        'discussion.create', 'discussion.post', 'discussion.invite', 'discussion.participants.list',
        'artifact.get', 'artifact.access.grants.set', 'session.access.grant.set',
    ].includes(effectActionId);
}

/** Only acceptance opens a stored proposal and its exact source before person-authorized submission. */
function isDocDecisionPreparationEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'doc.edit.accept' && (effectActionId === 'discussion.read' || effectActionId === 'artifact.get');
}

/** Run admission opens its committed C3 question through the installed requester codec. */
function isWorkflowDiscussionPreparationEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'workflow.run.start' && effectActionId === 'discussion.read';
}

/**
 * A person-started Run's steps use the accepted workflow.run.start authorization as their carrier
 * (buildWorkflowActionContext). Before each deployment step, the approval-scope owner
 * (createDeploymentApprovalScopeResolverV1) reads that step's Environment or receipt metadata as the
 * requester. Only those two metadata reads cross; a foreign custodian Machine gains no requester read.
 */
// Not the admitted read-root rule: the read effect differs from its Run root, so it crosses the effect family here.
function isWorkflowDeploymentApprovalScopeReadEffect(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string): boolean {
    return binding.actionId === WORKFLOW_RUN_START_ACTION_ID_V1 && 'authentication' in binding
        && binding.custodianAccountId === binding.accountId
        && (effectActionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1 || effectActionId === DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1);
}

/** Memory admission inspects existing exposure before proposing or performing a write. */
function isMemoryExposureReadEffect(rootActionId: string, effectActionId: string): boolean {
    return (rootActionId === 'approval.request.create' || isMemoryWriteActionV1(rootActionId))
        && effectActionId === 'artifact.access.grants.list';
}

/** Native storage phases use their existing closed admission contract. */
function deploymentNativeAdmissionInputSchema(actionId: string) {
    if (actionId === 'deployments.deploy') return DeploymentDeployAdmissionInputV1Schema;
    if (actionId === 'deployments.rollback') return DeploymentRollbackAdmissionInputV1Schema;
    if (actionId === 'deployments.promote') return DeploymentPromoteAdmissionInputV1Schema;
    if (actionId === 'deployments.teardown') return DeploymentTeardownActionAdmissionInputV1Schema;
    return null;
}

function isRegistryAppUpdateReadEffect(binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string): boolean {
    return binding.actionId === 'registries.updates.check' && binding.registryAppUpdateAdmission !== undefined
        && effectActionId === 'deployments.environments.get';
}

/** The catalog supplies transports; the mint's purposes and operand scope retain authority. */
export function isDeploymentReadPreparation(binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string): boolean {
    if (binding.actionId === effectActionId) return false;
    if (binding.deploymentPreparationAdmission && isDeploymentReceiptReadActionIdV1(effectActionId)
        && binding.deploymentChildRoot !== true) return false;
    const deploymentRoot = isDeploymentActionIdV1(binding.actionId)
        || binding.deploymentReadAdmission?.actionId === binding.actionId;
    if (deploymentRoot && effectActionId === PROJECT_SOURCE_READ_ACTION_ID_V1) return true;
    if (deploymentRoot && isDeploymentActionIdV1(effectActionId)) {
        const spec = getActionSpec(effectActionId);
        if (spec.sideEffectClass === 'read' && spec.serverTransport !== undefined) return true;
    }
    // Template writes retain their existing exact preparation/child purpose checks.
    const root = ActionIdSchema.safeParse(binding.actionId);
    return root.success && getActionSpec(root.data).deploymentPreparationScope?.(binding).storageEffects.includes(effectActionId) === true;
}

/** Archive's existing report cascade may stop an active report under its unchanged root. */
function isSessionArchiveStopEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'session.archive' && effectActionId === 'session.stop';
}

/** Log only the refusal branch and redacted request address, never proofs or content. */
export function refuseExternalActionExecutionRequest(phase: ExternalActionAuthorizationRefusalPhase,
    request: Pick<ExternalActionExecutionRequestProof, 'method' | 'path' | 'onRefusal'>
        | Readonly<{ rpc: typeof RPC_METHODS.DAEMON_DEPLOYMENT_CHILD; onRefusal?: ExternalActionExecutionRequestProof['onRefusal'] }>,
    failure?: ActionExecuteFailure,
    /**
     * Public catalog ids for attribution: rootActionId comes from the verified authorization token's binding;
     * effectActionId is the caller-supplied effect header, only schema-parsed (bounded catalog id shape) and not
     * yet covered by the machine-signature check. Neither carries tokens, inputs or content.
     */
    actionIds?: Readonly<{ rootActionId: string; effectActionId: string }>,
): null {
    warn({ module: 'external-action-authorization-refusal', phase,
        ...('rpc' in request ? { rpc: request.rpc } : { method: request.method, path: redactHttpRequestUrlForLog(request.path) }),
        ...(actionIds ? { rootActionId: actionIds.rootActionId, effectActionId: actionIds.effectActionId } : {}) });
    if ('onRefusal' in request) request.onRefusal?.(phase, failure);
    return null;
}

/** Reviewed readiness spends only a child permitted by the original credential. */
function readGrantedSessionAgentReadinessChild(binding: ExternalActionExecutionAuthorizationBindingV1,
    child: ReviewedActionChildHttpProofV1 | undefined,
    selectedTarget?: Readonly<{ machineId: string; installationId: string }>) {
    const actionId = readSessionAgentReadinessChildActionV1(binding, child, selectedTarget);
    return actionId && ('authentication' in binding || evaluateApiTokenGrantV1({ grant: binding.grant,
        actionId, target: binding.target, targetMachineId: binding.machineId }).ok) ? actionId : null;
}

/** Prepare resolves its reviewed handoff to an accessible Session; Session owners retain access decisions. */
function isAdmittedDeploymentPrepareSessionMessage(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string, target: ExternalActionTargetV1): boolean {
    return isDeploymentPrepareSessionMessageEffectV1(binding.actionId, effectActionId)
        && binding.deploymentPreparationAdmission?.operation === 'prepare'
        && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId
        && target.kind === 'session' && 'authentication' in binding;
}

function readDeploymentPrepareSessionHttpPurpose(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string, target: ExternalActionTargetV1, proof: ExternalActionExecutionRequestProof):
    Readonly<{ machineId: string } | { sessionId: string }> | null {
    if (proof.reviewedChild?.actionId !== effectActionId
        || proof.reviewedChild.role !== DEPLOYMENT_PREPARE_SESSION_CHILD_ROLE_V1
        || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return null;
    // The ordinary birth owner binds the reviewed recipe and creates the Session.
    // Its preceding codec read needs only the root's selected Machine.
    if (binding.actionId === 'deployments.prepare' && binding.deploymentPreparationAdmission?.operation === 'prepare'
        && 'authentication' in binding && binding.target.kind === 'machine'
        && binding.target.machineId === binding.machineId && target.kind === 'machine' && target.machineId === binding.machineId
        && effectActionId === SESSION_SPAWN_NEW_ACTION_ID_V1
        && proof.path === `/v1/machines/${encodeURIComponent(binding.machineId)}`) return { machineId: binding.machineId };
    if (!isAdmittedDeploymentPrepareSessionMessage(binding, effectActionId, target) || target.kind !== 'session') return null;
    const path = `/v2/sessions/${encodeURIComponent(target.sessionId)}`;
    const sessionRead = proof.sessionRouteTarget?.sessionId === target.sessionId
        && (proof.path === path || proof.path === `${path}?accessProjectionVersion=1`
            || proof.path === `${path}/pending`
            || binding.sessionActionOrigin !== undefined && proof.path === `${path}/delivery-mutes`);
    return isAccountEncryptionCurrentnessHttpRead(proof) || sessionRead ? { sessionId: target.sessionId } : null;
}

/** The installed issuer attests the exact placement child beneath its admitted creation root. */
async function isReviewedManagedAcquirePurpose(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string, proof: ExternalActionExecutionRequestProof): Promise<boolean> {
    const session = binding.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1;
    const workflow = binding.actionId === WORKFLOW_RUN_START_ACTION_ID_V1;
    if ((!session && !workflow) || effectActionId !== MANAGED_ACQUIRE_ACTION_ID_V1
        || proof.method.toUpperCase() !== 'POST'
        || !/^\/v1\/machines\/managed\/controller\/[^/]+$/u.test(proof.path)
        || proof.reviewedChild?.actionId !== MANAGED_ACQUIRE_ACTION_ID_V1
        || proof.reviewedChild.role !== (session ? 'acquire-session-sandbox' : 'acquire-workflow-placement')) return false;
    if (proof.path !== '/v1/machines/managed/controller/admit') {
        const body = proof.body !== null && typeof proof.body === 'object' && !Array.isArray(proof.body)
            ? proof.body as Readonly<Record<string, unknown>> : null;
        if (body?.homeId !== binding.serverIdentityId || typeof body.managedId !== 'string'
            || body.requestId !== undefined && typeof body.requestId !== 'string') return false;
        return await readExternalActionManagedAcquireResourceInTx(db, binding, {
            managedId: body.managedId, ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
            inputDigest: proof.reviewedChild.inputDigest,
        }) !== null;
    }
    const parsed = ManagedAdmissionInputV1Schema.safeParse(proof.body);
    if (!parsed.success) return false;
    const { input, originalActionEnvelope: root } = parsed.data;
    if (input.selection.kind !== 'preset' || input.selection.homeId !== binding.serverIdentityId
        || !input.controller || input.controller.machineId !== binding.machineId || input.controller.installationId !== binding.installationId
        || root === undefined
        || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId, machineId: binding.machineId, envelope: root })
        || proof.reviewedChild.inputDigest !== computeActionInputApprovalDigestV1(MANAGED_ACQUIRE_ACTION_ID_V1, input)) return false;
    if (session) return parsed.data.acquisitionMode === 'resource-bound' && parsed.data.continuationPresent === false
        && (binding.sessionPresetAcquisition === undefined || sameManagedInput({ selection: binding.sessionPresetAcquisition.selection,
            controller: binding.sessionPresetAcquisition.controller }, {
            selection: input.selection, controller: input.controller,
        }));
    const placement = binding.target.kind === 'machine' ? binding.target.project?.sessionPlacement : undefined;
    if (parsed.data.acquisitionMode !== undefined || !parsed.data.continuationPresent
        || placement?.kind !== 'preset' || placement.homeId !== input.selection.homeId || placement.presetId !== input.selection.id
        || binding.accountEncryptionMode === undefined || !isExternalActionRequestVersionAllowedForAccountModeV1({
            accountEncryptionMode: binding.accountEncryptionMode, envelopeVersion: root.v,
        })) return false;
    // Encrypted operands are opened and compared once by the installed host.
    // Plain roots also expose their exact retained Run and bound operand here.
    return root.v === 2 || root.input !== null && typeof root.input === 'object' && !Array.isArray(root.input)
        && root.input.runId === parsed.data.requestId
        && sameManagedInput(root.workflowPreparation?.acquisition, input);
}

/** Preparation reads its retained review under the containing Action's authority. */
function isProjectPrepareReviewEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === PROJECT_PREPARE_ACTION_ID_V1 && effectActionId === ACTION_OPERATION_GET_ACTION_ID_V1;
}

/** One signed binding decides sibling eligibility and the credential ceiling together. */
async function readSignedChildPurpose(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string, target: ExternalActionTargetV1, proof: ExternalActionExecutionRequestProof, signerAccountId: string) {
    const reviewedManagedAcquirePurpose = await isReviewedManagedAcquirePurpose(binding, effectActionId, proof);
    const domainPurpose = readExternalActionDeploymentDomainPurpose(binding, effectActionId, proof);
    const teardownDomainContinuation = binding.actionId === 'deployments.teardown' && domainPurpose?.kind === 'transition';
    const membershipDomainContinuation = isDeploymentMembershipActionIdV1(binding.actionId, binding.deploymentPreparationAdmission)
        && effectActionId === 'deployments.domains.add' && domainPurpose !== null;
    const setupPreparationRead = isSetupDeploymentPreparationReadEffect(binding, effectActionId);
    const candidatePublication = isDeploymentCandidatePublicationEffect(binding, effectActionId);
    const templateDeployEffect = binding.actionId === 'deployments.templates.instantiate' && candidatePublication
        && (proof.reviewedChild === undefined || proof.reviewedChild.role === 'template.deploy');
    const reviewedDomainEffect = isDeploymentDomainAddActionIdV1(effectActionId)
        && proof.reviewedChild?.actionId === effectActionId
        && isDeploymentDomainNativeAdmissionV1(proof.reviewedChild.deploymentNativeAdmission)
        && proof.reviewedChild.deploymentNativeAdmission.actionId === effectActionId
        && proof.reviewedChild.deploymentNativeAdmission.authoredMetadataDigest !== undefined
        && deploymentChildEffectActionIdForRootV1(binding.actionId, binding.deploymentPreparationAdmission, effectActionId)
            === effectActionId;
    const createPreparationEffect = isDeploymentCreateHttpEffect(binding, effectActionId);
    const movePreparationEffect = isDeploymentMoveToRepositoryHttpEffect(binding, effectActionId, proof.reviewedChild);
    const targetRetentionPurpose = await readDeploymentTargetRetentionHttpPurpose(db, binding, effectActionId, proof);
    const deploymentReferenceRead = await readDeploymentReferenceHttpPurpose(db, binding, effectActionId, proof, {
        isEnvironmentRead: () => isAccountActionHttpOperation(DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, proof),
        isCurrentnessRead: () => isAccountEncryptionCurrentnessHttpRead(proof),
        readArtifactId: () => readArtifactGetHttpPurpose(proof),
    }, signerAccountId);
    const machineSetupEffect = isMachineSetupPlanOrApplyActionIdV1(effectActionId)
        || isMachineSetupCombinedActionIdV1(effectActionId) || isMachineSetupNativeCodecActionIdV1(effectActionId);
    const reviewedSessionAgentReadinessChild = readGrantedSessionAgentReadinessChild(binding, proof.reviewedChild) === effectActionId;
    const prepareSession = readDeploymentPrepareSessionHttpPurpose(binding, effectActionId, target, proof);
    // A reviewed provider child spends its admitted root's finite workspace
    // preparation purpose. The native owner still decides the exact selection.
    const deploymentWorkspaceRead = proof.reviewedChild?.actionId === effectActionId
        && proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
        && isDeploymentNativeHttpPurpose({ binding, effectActionId: binding.actionId }, proof);
    const reviewedMachineSetupChild = binding.admittedMachineRole === 'manage'
        && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId
        && machineSetupEffect
        && proof.reviewedChild?.actionId === effectActionId
        && ('authentication' in binding || evaluateApiTokenGrantV1({
            grant: binding.grant, actionId: effectActionId, target, targetMachineId: binding.machineId,
        }).ok);
    const reviewedSetupRead = proof.deploymentChildExecution ? false
        : await readDeploymentReviewedSetupHttpPurpose(db, binding, effectActionId, proof,
            actionId => isAccountActionHttpOperation(actionId, proof));
    const sibling = {
        docDecision: isDocDecisionPreparationEffect(binding.actionId, effectActionId),
        docDiscussion: isDocDiscussionEffect(binding.actionId, effectActionId),
        docRead: isDocReadEffect(binding.actionId, effectActionId),
        secondOpinion: isSecondOpinionEffect(binding.actionId, effectActionId),
        workflowDiscussion: isWorkflowDiscussionPreparationEffect(binding.actionId, effectActionId),
        workflowDeploymentRead: isWorkflowDeploymentApprovalScopeReadEffect(binding, effectActionId),
        memory: isMemoryExposureReadEffect(binding.actionId, effectActionId),
        personalUsage: isPersonalUsageReadEffect(binding.actionId, effectActionId),
        personalSavedSecret: personalSavedSecretResourceMutationActionIdV1(binding.actionId) === effectActionId,
        publicProfile: isPublicProfilePreparationEffect(binding.actionId, effectActionId),
        teamUsage: isTeamCredentialUsageExportReadEffect(binding.actionId, effectActionId),
        archiveStop: isSessionArchiveStopEffect(binding.actionId, effectActionId),
        deploymentRead: isDeploymentReadPreparation(binding, effectActionId),
        projectPrepareReview: isProjectPrepareReviewEffect(binding.actionId, effectActionId),
        projectSessionDefaults: isExternalActionProjectSessionDefaultsReadAdmittedV1(binding, effectActionId),
        registryRead: isRegistryAppUpdateReadEffect(binding, effectActionId),
        sectionArchive: isSessionSectionArchiveEffectV1(binding.actionId, effectActionId),
        stopChild: isSessionStopChildEffectV1(binding.actionId, effectActionId),
        projectSetupSet: binding.actionId === PROJECT_SETUP_SET_ACTION_ID_V1 && isProjectSetupSetChildActionIdV1(effectActionId),
    };
    const configureBindings = binding.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1
        && effectActionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1
        && proof.reviewedChild?.actionId === effectActionId && proof.reviewedChild.role === 'backup.bindings'
        && isDeploymentBackupConfigureNativeAdmissionV1(binding.deploymentNativeAdmission);
    const telemetryBindings = binding.actionId === DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1
        && effectActionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1
        && proof.reviewedChild?.actionId === effectActionId && proof.reviewedChild.role === DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1
        && isDeploymentTelemetryNativeAdmissionV1(binding.deploymentNativeAdmission);
    const crossesEffectFamily = configureBindings || telemetryBindings || setupPreparationRead || createPreparationEffect || movePreparationEffect || Boolean(targetRetentionPurpose)
        || reviewedMachineSetupChild || reviewedSessionAgentReadinessChild || reviewedSetupRead || reviewedDomainEffect
        || teardownDomainContinuation || membershipDomainContinuation || prepareSession !== null || deploymentWorkspaceRead || reviewedManagedAcquirePurpose || sibling.projectPrepareReview;
    const effectFamilyAdmitted = (hasMatchingExecutionEffectFamily(binding.actionId, effectActionId) || crossesEffectFamily)
        && (binding.actionId === effectActionId || !binding.handoffContinuation && !binding.handoffPreflight
            && (isContributedActionRoot(binding.actionId)
                || !('authentication' in binding) && binding.actionId === 'approval.request.create'
                || Object.values(sibling).some(Boolean) || crossesEffectFamily || templateDeployEffect));
    const usesRootCredential = sibling.docDecision || templateDeployEffect || sibling.deploymentRead || sibling.projectSessionDefaults || movePreparationEffect
        || reviewedSetupRead || sibling.registryRead || sibling.secondOpinion || sibling.memory || reviewedManagedAcquirePurpose
        || sibling.personalUsage || sibling.personalSavedSecret || sibling.publicProfile || prepareSession !== null || deploymentWorkspaceRead || sibling.projectPrepareReview;
    const usesPublicRootCredential = sibling.teamUsage || sibling.docDiscussion || sibling.docRead;
    return { effectFamilyAdmitted, usesRootCredential, usesPublicRootCredential,
        createPreparationEffect, targetRetentionPurpose, reviewedMachineSetupChild, reviewedSessionAgentReadinessChild, reviewedManagedAcquirePurpose,
        reviewedSetupRead, candidatePublication, prepareSession, deploymentWorkspaceRead, deploymentReferenceRead, sibling,
        nativeTransition: readDeploymentNativeTransition(binding, effectActionId, proof),
        domainPurpose };
}

type VerifiedSignedChildRequest = VerifiedExternalActionExecutionRequest & Readonly<{
    /** Private request-local result; resource adapters keep consuming the existing public projection. */
    signedChildPurpose: Awaited<ReturnType<typeof readSignedChildPurpose>> & Readonly<{
        preparationRead: Awaited<ReturnType<typeof readDeploymentPreparationHttpReadPurpose>>;
    }>;
}>;

/** One exact signed finite material purpose, before consuming the accepted receipt. */
function readFiniteTeamDirectMaterialHttpPurpose(proof: ExternalActionExecutionRequestProof) {
    if (proof.method.toUpperCase() !== 'POST') return null;
    const path = /^\/v2\/teams\/([^/?#]+)\/credential-resources\/([^/?#]+)\/direct-material$/u.exec(proof.path);
    if (!path) return null;
    const body = TeamCredentialDirectMaterialOpenRequestV1Schema.safeParse(proof.body);
    if (!body.success || body.data.consumer.kind !== 'platform_operation') return null;
    try {
        const params = TeamCredentialDirectMaterialRouteParamsV1Schema.safeParse({ teamId: decodeURIComponent(path[1]!), resourceId: decodeURIComponent(path[2]!) });
        if (!params.success || params.data.resourceId !== body.data.resourceId
            || proof.path !== `/v2/teams/${encodeURIComponent(params.data.teamId)}/credential-resources/${encodeURIComponent(params.data.resourceId)}/direct-material`
            || proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, { ...params.data, ...body.data })) return null;
        return { ...params.data, consumer: body.data.consumer };
    } catch { return null; }
}

function readDeploymentPlatformMaterialHttpPurpose(proof: ExternalActionExecutionRequestProof) {
    const parsed = readFiniteTeamDirectMaterialHttpPurpose(proof);
    return parsed?.consumer.kind === 'platform_operation' ? { ...parsed, consumer: parsed.consumer } : null;
}

function readActionMaterialHttpPurpose(proof: ExternalActionExecutionRequestProof) {
    const parsed = readTeamCredentialActionHttpPurposeV1(proof);
    if (parsed?.kind !== 'direct_material'
        || proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, { teamId: parsed.teamId, ...parsed.body })
        || proof.reviewedChild && proof.reviewedChild.actionId !== parsed.consumer.actionId) return null;
    return { teamId: parsed.teamId, resourceId: parsed.resourceId, consumer: parsed.consumer };
}

function readActionBrokerHttpPurpose(proof: ExternalActionExecutionRequestProof) {
    const parsed = readTeamCredentialActionHttpPurposeV1(proof);
    if (parsed?.kind !== 'broker_action') return null;
    const { kind: _kind, ...body } = parsed;
    if (proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, body)
        || proof.reviewedChild && (proof.reviewedChild.inputDigest !== body.inputDigest
            || proof.reviewedChild.actionId !== body.consumer.actionId)) return null;
    return body;
}

async function verifyCommon(
    proof: ExternalActionExecutionRequestProof,
): Promise<VerifiedSignedChildRequest | null> {
    const effectActionId = ExternalActionActionIdV1Schema.safeParse(proof.effectActionId);
    const target = decodeExternalActionResolvedTargetV1(proof.encodedTarget);
    if (!effectActionId.success || !target) return refuseExternalActionExecutionRequest('proof_shape', proof);

    if (proof.deploymentChildExecution) {
        const packet = proof.deploymentChildExecution;
        const routing = packet.externalActionExecution.deploymentChildRouting;
        // A member's activation renders saved references: it may carry only the
        // reviewed reference read, which readDeploymentReferenceHttpPurpose decides below.
        if (proof.reviewedChild && (routing?.kind !== 'member' || proof.reviewedChild.role !== DEPLOYMENT_REFERENCE_READ_CHILD_ROLE_V1
            || effectActionId.data !== DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1)) return refuseExternalActionExecutionRequest('deployment_child_http', proof);
        if (packet.externalActionExecution.authorization.token !== proof.authorizationToken) return refuseExternalActionExecutionRequest('deployment_child_http', proof);
        const admittedReadReceiver = (routing?.kind === 'dataRole' || routing?.kind === 'domainDns') ? await db.machine.findUnique({ where: { id: routing.machineId }, select: {
            accountId: true, installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true } }) : null;
        // The installed receiver spends the source-signed admitted packet. Its
        // root binding and source signature are verified by the recursive owner.
        const admittedReadContinuation = (routing?.kind === 'dataRole' || routing?.kind === 'domainDns')
            && admittedReadReceiver?.installationPublicKey && admittedReadReceiver.installationId === routing.installationId
            && classifyMachineAvailabilityState(admittedReadReceiver) === 'available'
            && verifyExternalActionMachineRequestV1({ authorizationToken: proof.authorizationToken,
                effectActionId: effectActionId.data, target, installationId: routing.installationId,
                requestId: packet.externalActionExecution.authorization.binding.requestId,
                method: proof.method, path: proof.path, body: proof.body, deploymentChildExecution: packet,
                ...(proof.idempotencyKey === undefined ? {} : { idempotencyKey: proof.idempotencyKey }),
                publicKey: admittedReadReceiver.installationPublicKey, signature: proof.machineSignature });
        const verified = await verifyExternalActionMachineRpcExecution(packet.externalActionExecution, {
            method: packet.method, requestId: packet.requestId, paramsPresent: packet.paramsPresent, paramsDigest: packet.paramsDigest,
            ...(admittedReadContinuation ? { admittedReadContinuation: true } : {}),
            onRefusal: proof.onRefusal,
            resolveCurrentSessionMachine: proof.resolveCurrentSessionMachine });
        if (!verified || !routing || !(verified.binding.deploymentChildRoot === true)
            || effectActionId.data !== routing.actionId && !isDeploymentReadPreparation(verified.binding, effectActionId.data)
            || !sameStrictJsonValue(target, verified.target)) return refuseExternalActionExecutionRequest('deployment_child_http', proof);
        const receiver = admittedReadReceiver ?? await db.machine.findUnique({ where: { id: routing.machineId }, select: {
            accountId: true, installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true } });
        if (!receiver?.installationPublicKey || receiver.installationId !== routing.installationId
            || classifyMachineAvailabilityState(receiver) !== 'available') return refuseExternalActionExecutionRequest('deployment_child_http', proof);
        const verifySignature = (installationId: string, publicKey: Uint8Array) => verifyExternalActionMachineRequestV1({
                authorizationToken: proof.authorizationToken, effectActionId: effectActionId.data, target, installationId,
                requestId: verified.binding.requestId, method: proof.method, path: proof.path, body: proof.body,
                deploymentChildExecution: packet, ...(proof.idempotencyKey === undefined ? {} : { idempotencyKey: proof.idempotencyKey }),
                ...(proof.reviewedChild ? { reviewedChild: proof.reviewedChild } : {}),
                publicKey, signature: proof.machineSignature });
        let signer = { machineId: routing.machineId, installationId: routing.installationId, custodianAccountId: receiver.accountId };
        if (!admittedReadContinuation && !verifySignature(routing.installationId, receiver.installationPublicKey)) {
            const domainAdmission = verified.deploymentChildAdmission?.domainAdmission;
            if (!packet.archiveOrigin && effectActionId.data === routing.actionId && domainAdmission
                && proof.method.toUpperCase() === 'POST'
                && verifySignature(domainAdmission.controller.installationId, decodeBase64(domainAdmission.controller.publicKey, 'base64url'))) {
                signer = { machineId: domainAdmission.controller.machineId, installationId: domainAdmission.controller.installationId,
                    custodianAccountId: verified.binding.custodianAccountId };
            } else {
                // Before sealing the child, its already-authorized controller opens
                // only the exact recipient codec. This is not receiver/byte authority.
                if (packet.archiveOrigin || effectActionId.data !== routing.actionId
                    || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined
                    || proof.path !== `/v1/machines/${encodeURIComponent(routing.machineId)}`) return refuseExternalActionExecutionRequest('deployment_child_http', proof);
                const controller = await db.machine.findFirst({ where: { id: verified.binding.machineId,
                    accountId: verified.binding.custodianAccountId, installationId: verified.binding.installationId }, select: {
                    installationPublicKey: true, revokedAt: true, replacedByMachineId: true } });
                if (!controller?.installationPublicKey || classifyMachineAvailabilityState(controller) !== 'available'
                    || !verifySignature(verified.binding.installationId, controller.installationPublicKey)) return refuseExternalActionExecutionRequest('deployment_child_http', proof);
                signer = { machineId: verified.binding.machineId, installationId: verified.binding.installationId,
                    custodianAccountId: verified.binding.custodianAccountId };
            }
        }
        const childPurpose = await readSignedChildPurpose(verified.binding, effectActionId.data, target, proof, signer.custodianAccountId);
        if (proof.reviewedChild && childPurpose.deploymentReferenceRead !== true) return refuseExternalActionExecutionRequest('verification_purpose', proof);
        const preparationRead = childPurpose.deploymentReferenceRead === null
            ? await readDeploymentPreparationHttpReadPurpose(db, verified.binding, effectActionId.data, proof,
                actionId => isAccountActionHttpOperation(actionId, proof)) : null;
        const signedChildPurpose = { ...childPurpose, preparationRead };
        return { ...verified, effectActionId: effectActionId.data, deploymentChildRouting: routing,
            deploymentChildSigner: signer, signedChildPurpose };
    }

    const binding = await auth.verifyExternalActionExecutionAuthorization(proof.authorizationToken);
    if (!binding) return refuseExternalActionExecutionRequest('authorization_token', proof);
    const refuse =(phase: ExternalActionAuthorizationRefusalPhase) => refuseExternalActionExecutionRequest(phase, proof, undefined,
        { rootActionId: binding.actionId, effectActionId: effectActionId.data });
    if (!isExternalActionResolvedTargetAllowedV1({
        authorizedTarget: binding.target,
        resolvedTarget: target,
        selectedMachineId: binding.machineId,
    })) return refuse('resolved_target');
    if (!await hasCurrentOriginalSessionActionTargetInTx(db, binding, target)) return refuse('original_target');
    if (binding.actionId === 'session.pending.resetStart.set' && !binding.pendingResetStartAdmission) return refuse('pending_reset_admission');
    const childPurpose = await readSignedChildPurpose(binding, effectActionId.data, target, proof, binding.custodianAccountId);
    const { createPreparationEffect, targetRetentionPurpose, reviewedMachineSetupChild,
        reviewedSetupRead, nativeTransition, domainPurpose } = childPurpose;
    if (!childPurpose.effectFamilyAdmitted) return refuse('effect_family');
    if (childPurpose.deploymentReferenceRead === false) return refuse('verification_purpose');
    if (binding.serverIdentityId !== await initializeServerIdentityCache()) return refuse('server_identity');
    const currentnessBody = ExternalActionExecutionAuthorizationVerifyRequestV1Schema.safeParse(proof.body);
    const machineNpmProfilePurpose = currentnessBody.success ? currentnessBody.data.nativePurpose : undefined;
    if (machineNpmProfilePurpose && (proof.method.toUpperCase() !== 'POST'
        || proof.path !== bindExternalActionExecutionAuthorizationVerifyHttpPathV1(binding.actionId)
        || effectActionId.data !== binding.actionId)) return refuse('verification_purpose');
    if (proof.method.toUpperCase() === 'POST'
        && proof.path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1(binding.actionId)
        && (!currentnessBody.success || currentnessBody.data.admittedMachineRole !== binding.admittedMachineRole
            || (currentnessBody.data.binding !== undefined
                ? !matchesExternalActionAuthorizationBinding(binding, currentnessBody.data.binding)
                : binding.sessionPresetAcquisition?.admission !== undefined))) {
        return refuse('verification_purpose');
    }
    const retainedDiscussionSource = currentnessBody.success ? currentnessBody.data.retainedDiscussionSource : undefined;
    if (retainedDiscussionSource && (proof.method.toUpperCase() !== 'POST'
        || proof.path !== bindExternalActionExecutionAuthorizationVerifyHttpPathV1(binding.actionId)
        || effectActionId.data !== binding.actionId
        || !await isRetainedDiscussionPublicationSourceCurrentInTx(db, binding, retainedDiscussionSource))) {
        return refuse('verification_purpose');
    }
    const custodyTarget = currentnessBody.success ? currentnessBody.data.managedFiniteWakeTarget : undefined;
    if (custodyTarget && (proof.method.toUpperCase() !== 'POST'
        || proof.path !== bindExternalActionExecutionAuthorizationVerifyHttpPathV1(binding.actionId))) return refuse('custody_purpose');
    const custody = custodyTarget ? await (await import('@/app/machines/managed/managedWake')).readCurrentManagedFiniteWakeCustodyInTx(db, {
        actionOrigin: { v: 1, token: proof.authorizationToken, binding }, target: custodyTarget,
    }) : undefined;
    if (custodyTarget && !custody) return refuse('custody_before_principal');
    const report = proof.method.toUpperCase() === 'POST' && proof.path.split('?')[0] === '/v1/machines/managed/controller/report'
        ? ManagedControllerReportV1Schema.safeParse(proof.body) : null;
    const intentReport = proof.method.toUpperCase() === 'POST' && proof.path.split('?')[0] === '/v1/machines/managed/controller/report-intent'
        ? ManagedControllerIntentReportV1Schema.safeParse(proof.body) : null;
    const resizeReport = proof.method.toUpperCase() === 'POST' && proof.path.split('?')[0] === '/v1/machines/managed/controller/report-resize'
        ? ManagedControllerResizeReportV1Schema.safeParse(proof.body) : null;
    const nativeReport = proof.method.toUpperCase() === 'POST' && proof.path.split('?')[0] === '/v1/machines/managed/controller/report'
        ? ManagedControllerCredentialDeliveryReportV1Schema.safeParse(proof.body) : null;
    const purpose: ExternalActionVerificationPurpose | undefined = report?.success
        && await isIssuedAcquireNativeFactReportInTx(db, binding, report.data)
        ? { kind: 'issued-managed-acquire-native-fact', report: report.data }
        : intentReport?.success && await isIssuedIntentNativeFactReportInTx(db, binding, intentReport.data)
            ? { kind: 'issued-managed-intent-native-fact', report: intentReport.data }
            : resizeReport?.success && await isIssuedResizeNativeFactReportInTx(db, binding, resizeReport.data)
                ? { kind: 'issued-managed-intent-native-fact', report: resizeReport.data }
            : nativeReport?.success && effectActionId.data === binding.actionId
                && await isIssuedNativeCredentialFactReportInTx(db, binding, nativeReport.data)
                ? { kind: 'issued-managed-native-credential-fact', report: nativeReport.data }
            : retainedDiscussionSource ? { kind: 'retained-discussion-publication', source: retainedDiscussionSource } : undefined;
    const domainContinuation = domainPurpose && domainPurpose.kind !== 'admission' && binding.actionId !== 'deployments.domains.verify'
        ? domainPurpose : null;
    const machine = await db.machine.findFirst({
        where: { id: binding.machineId, accountId: binding.custodianAccountId, installationId: binding.installationId },
        select: {
            accountId: true,
            kind: true,
            revokedAt: true,
            replacedByMachineId: true,
            installationId: true,
            installationPublicKey: true,
        },
    });
    const verifySignature = (publicKey: Uint8Array, installationId = binding.installationId) => verifyExternalActionMachineRequestV1({
        authorizationToken: proof.authorizationToken,
        effectActionId: effectActionId.data,
        target,
        installationId,
        requestId: binding.requestId,
        method: proof.method,
        path: proof.path,
        body: proof.body,
        ...(proof.idempotencyKey === undefined ? {} : { idempotencyKey: proof.idempotencyKey }),
        ...(proof.reviewedChild ? { reviewedChild: proof.reviewedChild } : {}),
        publicKey,
        signature: proof.machineSignature,
    });
    const acquireAdmissionRequest = binding.actionId === 'machines.managed.acquire'
        && proof.method.toUpperCase() === 'POST' && proof.path.split('?')[0] === '/v1/machines/managed/controller/admit';
    // Move the existing accepted-root read before signer selection. Its result
    // also feeds source/principal projection below; an accepted acquire only
    // replays the retained identity and never admits another native effect.
    const retainedCreationAdmission = acquireAdmissionRequest
        ? await hasAdmittedManagedCreationRootInTx(db, binding) : undefined;
    let signatureCurrent = custody
        ? verifySignature(decodeBase64(custody.installationPublicKey, 'base64url'))
        : Boolean(machine?.installationPublicKey && verifySignature(machine.installationPublicKey));
    // Target currentness and the captured source both sign the exact destination
    // tuple. Only the accepted continuation survives its publisher stopping.
    const managedGuestMetadata = proof.method.toUpperCase() === 'GET'
        && isManagedPowerOrDeleteActionIdV1(binding.actionId)
        && /^\/v1\/machines\/[^/]+$/u.test(proof.path.split('?')[0]);
    const nativeControllerPurpose = binding.actionId === 'machines.managed.credentials.install'
        && proof.path.split('?')[0].startsWith('/v1/machines/managed/controller/')
        || binding.managedAcquireDelegation === true && proof.method.toUpperCase() === 'POST'
            && proof.path.split('?')[0] === '/v1/machines/managed/controller/admit' && retainedCreationAdmission !== true;
    // Guest key publication and delegated policy qualification belong to controller custody.
    if ((!signatureCurrent || binding.handoffPreflight) && !custodyTarget && !managedGuestMetadata && !nativeControllerPurpose && !reviewedMachineSetupChild) {
        const sourceKey = await readCurrentExternalActionSourceSigningPublicKey(binding);
        signatureCurrent = sourceKey !== null && verifySignature(sourceKey);
    }
    // The minted Setup root pairs each app operand with its target Machine.
    // Its admitted Plan receiver signs only reads of that paired operand.
    const setupReceiver = signatureCurrent || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined
        ? undefined : await readSetupReceiverSigner(binding, verifySignature);
    if (setupReceiver) signatureCurrent = true;
    // Retirement closes new effects. The exact purchase this installation
    // already submitted still reports its native identity, so its row can
    // be cleaned up; the retained installation key must still sign it.
    if (
        !machine
        || (purpose?.kind !== 'issued-managed-acquire-native-fact' && classifyMachineAvailabilityState(machine) !== "available")
        || !machine.installationId
        || !machine.installationPublicKey
    ) {
        return refuse('machine_identity');
    }
    if (!signatureCurrent) return refuse('machine_signature');

    // Accepted roots retain finite controller custody for every signed call.
    // A transition additionally binds the receipt identity and settlement purpose.
    const platformMaterial = effectActionId.data === binding.actionId ? readDeploymentPlatformMaterialHttpPurpose(proof) : null;
    const actionMaterialPurpose = effectActionId.data === binding.actionId ? readActionMaterialHttpPurpose(proof) : null;
    const actionMaterialAdmission = actionMaterialPurpose?.consumer.operationId === binding.requestId
        ? { ...actionMaterialPurpose, rootActionId: binding.actionId, machineId: binding.machineId,
            ...(proof.reviewedChild ? { admittedReviewedChildActionId: proof.reviewedChild.actionId } : {}) } : undefined;
    const actionBrokerPurpose = effectActionId.data === binding.actionId ? readActionBrokerHttpPurpose(proof) : null;
    const actionBrokerAdmission = actionBrokerPurpose?.consumer.operationId === binding.requestId
        && actionBrokerPurpose.initiatorMachineId === binding.machineId
        ? { ...actionBrokerPurpose, rootActionId: binding.actionId, machineId: binding.machineId,
            ...(proof.reviewedChild ? { admittedReviewedChildActionId: proof.reviewedChild.actionId } : {}) } : undefined;
    const deploymentContinuation: DeploymentReceiptContinuation | undefined = platformMaterial
        && deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission) !== undefined
        ? { deploymentId: platformMaterial.consumer.deploymentId, environmentId: platformMaterial.consumer.environmentId,
            actionOperationId: platformMaterial.consumer.operationId, installationId: binding.installationId } : nativeTransition
        && (deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission) !== undefined
            || binding.actionId === 'deployments.receipts.observe') && verifySignature(machine.installationPublicKey) ? {
        deploymentId: nativeTransition.deploymentId, actionOperationId: nativeTransition.actionOperationId,
        environmentId: nativeTransition.environmentId, installationId: binding.installationId,
        // Unknown-outcome recovery records its private reason atomically. The
        // transition owner binds that update to the existing Artifact and versions.
        ...(nativeTransition.kind === 'settle'
            && ['failed', 'cancelled', 'outcome_unknown'].includes(nativeTransition.state)
            && (nativeTransition.contentUpdate !== undefined ? nativeTransition.state === 'outcome_unknown'
                : nativeTransition.contentArtifactId === undefined && nativeTransition.contentHeaderVersion === undefined
                    && nativeTransition.contentBodyVersion === undefined)
            && nativeTransition.expectedTargetLinkRevision === undefined && nativeTransition.teardownProof === undefined
            ? { interruptedSettlement: true as const } : {}),
    } : undefined;

    // This transport candidate only selects the active-job constraint. It is
    // never returned as custody before the preparation owner binds its operands.
    const declaredPreparationRead = childPurpose.deploymentReferenceRead === null
        ? readDeclaredDeploymentPreparationHttpRead(binding, effectActionId.data, proof,
            actionId => isAccountActionHttpOperation(actionId, proof)) : null;
    const acceptedDeployment = (deploymentContinuation
        || deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission) !== undefined)
        && verifySignature(machine.installationPublicKey)
        && await readAcceptedDeploymentReceiptInTx(db, binding, deploymentContinuation, {
            // A declared read spends the job principal only while its job runs.
            ...(platformMaterial ? { cancelRequestedAt: null, state: { in: deploymentInProgressStates() } }
                : declaredPreparationRead || childPurpose.deploymentWorkspaceRead || childPurpose.deploymentReferenceRead
                    || !deploymentContinuation && isDeclaredReadActionId(effectActionId.data)
                    ? { state: { in: deploymentInProgressStates() } } : {}),
            // Prove the original job is active without constraining a pinned
            // source read to the destination Environment or current receipt.
        });
    const acceptedPreparationRead = childPurpose.deploymentReferenceRead === null
        ? await readDeploymentPreparationHttpReadPurpose(db, binding, effectActionId.data, proof,
            actionId => isAccountActionHttpOperation(actionId, proof), acceptedDeployment || undefined) : null;
    const signedChildPurpose = { ...childPurpose, preparationRead: acceptedPreparationRead };
    if (isDeploymentMembershipActionIdV1(binding.actionId, binding.deploymentPreparationAdmission)
        && isDeploymentDomainMetadataReadActionIdV1(effectActionId.data)
        && !acceptedPreparationRead) return refuse('deployment_metadata_environment');
    if (platformMaterial && !acceptedDeployment) return refuse('deployment_child_http');
    if (domainContinuation?.kind === 'secret-facts') {
        const input = domainContinuation.input;
        const materialization = domainContinuation.materialization;
        if (!verifySignature(machine.installationPublicKey)) return refuse('machine_signature');
        const domainJob = await readAcceptedDeploymentDomainInTx(db, binding, {
            environmentId: input.environmentId, domainId: materialization.domainId,
            expectedDomainRevision: materialization.expectedDomainRevision,
            actionOperationId: materialization.actionOperationId, capture: materialization.capture,
        });
        if (!domainJob) return refuse('deployment_child_admission');
        const domainAdmission = projectAcceptedDeploymentDomainSecretLaunchAdmission(domainJob,
            { machineId: binding.machineId, installationId: binding.installationId, publicKey: machine.installationPublicKey });
        if (!domainAdmission) return refuse('deployment_child_admission');
        const routing = DeploymentChildRoutingV1Schema.safeParse({ v: 1, kind: 'domain', actionId: effectActionId.data,
            input: { serverId: binding.serverIdentityId, environmentId: input.environmentId, domainId: materialization.domainId },
            machineId: domainJob.capture.placement.machineId, installationId: domainJob.capture.placement.installationId,
            expectedDomainRevision: materialization.expectedDomainRevision, actionOperationId: materialization.actionOperationId,
            capture: materialization.capture });
        if (!routing.success) return refuse('deployment_child_routing');
        const principal = projectAcceptedDeploymentPrincipal(binding);
        return principal ? { binding, signedChildPurpose, effectActionId: effectActionId.data, target, principal, effectiveAuthority: principal.authority,
            deploymentDomainPurpose: domainContinuation,
            deploymentChildSigner: { machineId: binding.machineId, installationId: binding.installationId,
                custodianAccountId: binding.custodianAccountId },
            deploymentChildAdmission: { binding, routing: routing.data, domainJob, domainAdmission },
            ...(proof.reviewedChild ? { reviewedChildAdmission: proof.reviewedChild } : {}) } : refuse('principal');
    }
    if (domainContinuation) {
        if (!verifySignature(machine.installationPublicKey)) return refuse('machine_signature');
        // Prepared content spends the accepted binding once, under the Domain CAS lock.
        // A transition continues the Domain owner's accepted native capture or provider custody.
        if (domainContinuation.kind === 'transition'
            && !await isAcceptedDeploymentDomainTransitionInTx(db, binding, domainContinuation.input)) return refuse('deployment_child_admission');
        const principal = projectAcceptedDeploymentPrincipal(binding);
        return principal ? { binding, signedChildPurpose, effectActionId: effectActionId.data, target, principal,
            effectiveAuthority: principal.authority, ...(domainPurpose ? { deploymentDomainPurpose: domainPurpose } : {}),
            ...(proof.reviewedChild ? { reviewedChildAdmission: proof.reviewedChild } : {}) } : refuse('principal');
    }

    const admittedFiniteOperation = readAdmittedFiniteOperationPrincipal(binding, undefined, acceptedDeployment || undefined);
    if (acceptedDeployment) {
        if (proof.reviewedChild && proof.reviewedChild.actionId !== effectActionId.data) return refuse('reviewed_child');
        const principal = admittedFiniteOperation;
        return principal ? { binding, signedChildPurpose, effectActionId: effectActionId.data, target, principal,
            effectiveAuthority: principal.authority,
            acceptedDeploymentReceipt: { environmentId: acceptedDeployment.environmentId,
                ...(acceptedPreparationRead ? { read: { ...acceptedPreparationRead, contentCustody: true } } : {}),
                ...(platformMaterial ? { platformMaterial } : {}) },
            ...(domainPurpose ? { deploymentDomainPurpose: domainPurpose } : {}),
            ...(targetRetentionPurpose ? { deploymentTargetRetentionAdmission: targetRetentionPurpose } : {}),
            ...(proof.reviewedChild ? { reviewedChildAdmission: proof.reviewedChild } : {}) } : refuse('principal');
    }
    // A signed deployment continuation without its accepted receipt, as for platform material above.
    if (deploymentContinuation) return refuse('deployment_child_http');
    if (!purpose && !nativeTransition && !domainContinuation && !admittedFiniteOperation && !await hasCurrentExternalActionSessionSource(binding, proof.resolveCurrentSessionMachine, retainedCreationAdmission)) return refuse('source_before_principal');

    // The installed generic issuer carries reviewed child consent on the original
    // credential. Create children consume the allocated Environment; retention
    // consumes its exact reviewed input before the managed owner's ordinary CAS.
    const deploymentPreparationSourceRead = await readDeploymentPreparationSourceHttpPurposeInTx(db, binding, effectActionId.data, proof);
    if (deploymentPreparationSourceRead === false) return refuse('deployment_preparation');
    const createPreparationAdmission: DeploymentCreateHttpPurpose | null = createPreparationEffect
        ? acceptedPreparationRead && isDeploymentDomainMetadataReadActionIdV1(acceptedPreparationRead.actionId)
            ? { rootActionId: 'deployments.environments.create', effectActionId: effectActionId.data }
            : await readDeploymentCreateHttpPurposeInTx(db, binding, effectActionId.data, proof, isReadOnlyArtifactHttpPurpose,
            (_nativeProof, readActionId) => readActionId ? isAccountActionHttpOperation(readActionId, proof)
                : isDeploymentNativeHttpPurpose({ binding, effectActionId: effectActionId.data }, proof)
                || signedChildPurpose.sibling.deploymentRead
                    && isAccountActionHttpOperation(effectActionId.data, proof)) : null;
    // Effect-family admission already decided this relationship. The signed
    // annotation identifies that admitted effect; it does not grant another one.
    if (proof.reviewedChild && proof.reviewedChild.actionId !== effectActionId.data
        && actionMaterialAdmission?.admittedReviewedChildActionId !== proof.reviewedChild.actionId
        && actionBrokerAdmission?.admittedReviewedChildActionId !== proof.reviewedChild.actionId) {
        return refuse('reviewed_child');
    }
    if (createPreparationAdmission?.child && !proof.reviewedChild) return refuse('reviewed_child');
    if (createPreparationAdmission || deploymentPreparationSourceRead || targetRetentionPurpose) {
        const principal = projectAcceptedDeploymentPrincipal(binding);
        return principal ? { binding, signedChildPurpose, effectActionId: effectActionId.data, target, principal,
            effectiveAuthority: principal.authority,
            ...(createPreparationAdmission ? { createPreparationAdmission } : {}),
            ...(deploymentPreparationSourceRead ? { deploymentPreparationSourceRead }
                : createPreparationAdmission?.source ? { deploymentPreparationSourceRead: { source: createPreparationAdmission.source, canManage: false } } : {}),
            ...(targetRetentionPurpose ? { deploymentTargetRetentionAdmission: targetRetentionPurpose } : {}),
            ...(proof.reviewedChild ? { reviewedChildAdmission: proof.reviewedChild } : {}) } : refuse('principal');
    }


    const reviewedAdmission = {
        ...(domainPurpose ? { deploymentDomainPurpose: domainPurpose } : {}),
        ...(actionMaterialAdmission ? { actionMaterialAdmission } : {}),
        ...(actionBrokerAdmission ? { actionBrokerAdmission } : {}),
        ...(proof.reviewedChild ? { reviewedChildAdmission: proof.reviewedChild } : {}),
        ...(reviewedSetupRead ? { deploymentReviewedSetupRead: true as const } : {}),
    };

    // The exact submitted native effect already admitted its requester. Its signed
    // native result must remain recordable after that credential is withdrawn.
    if (purpose?.kind === 'issued-managed-acquire-native-fact' || purpose?.kind === 'issued-managed-intent-native-fact') {
        const principal = projectAcceptedDeploymentPrincipal(binding);
        return principal ? { binding, signedChildPurpose, effectActionId: effectActionId.data, target, principal,
            effectiveAuthority: principal.authority, ...reviewedAdmission }
            : refuse('principal');
    }

    // A step of an admitted finite native operation spends its signed admission;
    // the native operation owner stops it through the executor's local signal.
    if (admittedFiniteOperation && !machineNpmProfilePurpose) return { binding, signedChildPurpose, effectActionId: effectActionId.data,
        target, principal: admittedFiniteOperation, effectiveAuthority: admittedFiniteOperation.authority, ...reviewedAdmission,
        ...(isDeploymentDomainDnsActionIdV1(binding.actionId) && acceptedPreparationRead
            ? { acceptedDeploymentReceipt: { read: acceptedPreparationRead } } : {}) };

    // One signed request admits each fact once. A change after this point applies
    // at the next request; the holder stops already-admitted work on its local signal.
    const currentPrincipal = await verifyCurrentExternalActionPrincipalForPurpose(binding, purpose, deploymentContinuation, retainedCreationAdmission);
    const principal = currentPrincipal && projectVerifiedExternalActionBoundPrincipal(binding, currentPrincipal);
    if (!principal) return refuse('principal');
    const machineNpmProfileAdmission = machineNpmProfilePurpose
        ? await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: binding.accountId,
            callerAuthority: principal.authority, sessionActionOrigin: binding.sessionActionOrigin,
            machineId: binding.machineId, actionId: binding.actionId, executionBinding: binding,
            nativePurpose: machineNpmProfilePurpose }) : undefined;
    if (!machineNpmProfileAdmission && !reviewedMachineSetupChild
        && !await hasCurrentExecutionMachineAdmission(binding, machine)) return refuse('machine_admission_after_principal');
    // A transition without accepted custody skipped the Session source check above.
    if (!purpose && nativeTransition && !await hasCurrentExternalActionSessionSource(binding, proof.resolveCurrentSessionMachine, retainedCreationAdmission)) return refuse('source_after_principal');
    return { binding, signedChildPurpose, effectActionId: effectActionId.data, target, principal, effectiveAuthority: principal.authority,
        ...(machineNpmProfileAdmission ? { machineNpmProfileAdmission } : {}),
        ...reviewedAdmission,
        ...(setupReceiver ? { setupReceiverMachineId: setupReceiver } : {}) };
}

/** Only a current installation of a Machine named by the Setup app admission. */
async function readSetupReceiverSigner(binding: ExternalActionExecutionAuthorizationBindingV1,
    verifySignature: (publicKey: Uint8Array, installationId: string) => boolean): Promise<string | undefined> {
    const admission = binding.deploymentPreparationAdmission;
    if (deploymentPreparationOperationForActionV1(binding.actionId) !== 'setup' || admission?.operation !== 'setup') return undefined;
    const ids = [...new Set([...admission.deployments, ...(admission.catalogSources ?? [])]
        .map(selected => selected.machineId))].filter(id => id !== binding.machineId);
    if (ids.length === 0) return undefined;
    const receivers = await db.machine.findMany({ where: { id: { in: ids } }, select: {
        id: true, installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true } });
    const receiver = receivers.find(candidate => candidate.installationId && candidate.installationPublicKey
        && classifyMachineAvailabilityState(candidate) === 'available'
        && verifySignature(candidate.installationPublicKey, candidate.installationId));
    if (!receiver) return undefined;
    // Mint admitted Manage for every selected receiver. This signed finite
    // preparation retains that admission and the receiver's current installation.
    return receiver.id;
}

function isMachineRebootHttpPurpose(binding: ExternalActionExecutionAuthorizationV1['binding'],
    effectActionId: string, proof: ExternalActionExecutionRequestProof): boolean {
    if (effectActionId !== binding.actionId || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    const url = new URL(proof.path, 'http://localhost');
    if (url.pathname !== '/v1/deployments/machine-references') return false;
    const selection = MachineDeploymentReferencesInputV1Schema.safeParse(Object.fromEntries(url.searchParams));
    if (!selection.success || selection.data.homeId !== binding.serverIdentityId) return false;
    return MACHINE_REBOOT_ACTION_IDS.some(id => id === binding.actionId)
        && binding.target.kind === 'machine' && selection.data.machineId === binding.target.machineId;
}

function isAccountEncryptionCurrentnessHttpRead(proof: Readonly<{ method: string; path: string; body?: unknown }>): boolean {
    return proof.method.toUpperCase() === 'GET' && proof.body === undefined
        && proof.path === '/v1/account/encryption/currentness';
}

/** A reviewed Setup spends its root at its original Home and admitted Machines. */
function readReviewedMachineSetupHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): Readonly<{ machineId?: string }> | null {
    if (isMachineSetupCombinedRunHttpPurpose(verified, proof)) return {};
    // The reviewed Setup's admitted connector grants; the route keeps proof and target access.
    if (isMachineConnectorSecretGrantHttpPurpose(verified.binding, verified.effectActionId, proof)) return {};
    if (proof.method.toUpperCase() === 'GET' && proof.body === undefined) {
        if (isAccountEncryptionCurrentnessHttpRead(proof)) return {};
        const scope = verified.binding.deploymentPreparationAdmission;
        const machineId = proof.path === `/v1/machines/${encodeURIComponent(verified.binding.machineId)}`
            ? verified.binding.machineId : scope?.operation === 'setup' ? scope.machineTargets?.find(machineId =>
                proof.path === `/v1/machines/${encodeURIComponent(machineId)}`) : undefined;
        return machineId ? { machineId } : null;
    }
    if (proof.method.toUpperCase() !== 'POST') return null;
    const input = proof.path === '/v1/machines/setup/resolve' ? MachineSetupResolveInputV1Schema.safeParse(proof.body)
        : verified.effectActionId === MACHINE_SETUP_APPLY_ACTION_ID_V1
            && proof.path === '/v1/machines/setup/report' ? MachineSetupReportInputV1Schema.safeParse(proof.body) : null;
    return input?.success === true && input.data.homeId === verified.binding.serverIdentityId
        && 'machineId' in input.data && input.data.machineId === verified.binding.machineId ? {} : null;
}

/** Canonical Artifact detail/header reads retain the Artifact owner's per-record access checks. */
function isReadOnlyArtifactHttpPurpose(proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>): boolean {
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
    if (proof.method.toUpperCase() === 'POST' && proof.path === '/v1/artifacts/read') {
        const read = ArtifactReadBatchHttpInputV1Schema.safeParse(proof.body);
        return read.success && sameManagedInput(proof.body, read.data)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, read.data));
    }
    return readArtifactGetHttpPurpose(proof) !== null;
}

function readArtifactGetHttpPurpose(proof: Readonly<{ method: string; path: string; body?: unknown; routeInput?: unknown }>): string | null {
    const match = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
    if (!match || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return null;
    try {
        const artifactId = decodeURIComponent(match[1]);
        return getActionSpec('artifact.get').inputSchema.safeParse({ artifactId }).success
            && match[1] === encodeURIComponent(artifactId)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { id: artifactId })) ? artifactId : null;
    } catch { return null; }
}

/** The incumbent Artifact codec prepares only its admitted recipient keys. */
function isArtifactRecipientKeyPreparationHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    const match = /^\/v1\/artifacts\/([^/?#]+)\/access\/(recipients|key-envelopes)$/u.exec(proof.path);
    if (!match) return false;
    try {
        const artifactId = decodeURIComponent(match[1]);
        if (!artifactId || match[1] !== encodeURIComponent(artifactId)) return false;
        if (match[2] === 'recipients') return proof.method.toUpperCase() === 'GET' && proof.body === undefined
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { id: artifactId }));
        if (proof.method.toUpperCase() !== 'POST') return false;
        const commit = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.safeParse(proof.body);
        return commit.success && commit.data.artifactId === artifactId && (proof.routeInput === undefined
            || sameManagedInput(proof.routeInput, { id: artifactId, ...commit.data }));
    } catch { return false; }
}

/** Exact roster reads share the Artifact grant-list transport grammar. */
function isArtifactGrantsReadHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    const url = new URL(proof.path, 'http://home.invalid');
    const match = /^\/v1\/artifacts\/([^/?#]+)\/access\/grants$/u.exec(url.pathname);
    if (!match || url.hash !== '' || url.searchParams.size > 1
        || (url.searchParams.size === 1 && !url.searchParams.has('requestedAudience'))) return false;
    try {
        const artifactId = decodeURIComponent(match[1]);
        const audienceQuery = url.searchParams.get('requestedAudience');
        const input = { artifactId, ...(audienceQuery === null ? {} : { requestedAudience: JSON.parse(audienceQuery) }) };
        const parsed = getActionSpec('artifact.access.grants.list').inputSchema.safeParse(input);
        return parsed.success
            && match[1] === encodeURIComponent(artifactId)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { id: artifactId,
                ...(parsed.data.requestedAudience === undefined ? {} : { requestedAudience: parsed.data.requestedAudience }) }));
    } catch { return false; }
}

/** Owner-filtered anonymous-publication roster used by the existing exposure reader. */
function isArtifactPublicShareListHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    const url = new URL(proof.path, 'http://home.invalid');
    if (url.pathname !== '/v1/public-shares') return false;
    const artifactId = url.searchParams.get('subjectId');
    return url.hash === '' && url.searchParams.size === 2
        && url.searchParams.get('subjectKind') === 'artifact'
        && url.searchParams.getAll('subjectId').length === 1
        && getActionSpec('artifact.access.grants.list').inputSchema.safeParse({ artifactId }).success
        && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { subjectKind: 'artifact', subjectId: artifactId }));
}

async function isStoredBotTemplateArtifact(artifactId: string): Promise<boolean> {
    const artifact = await db.artifact.findUnique({ where: { id: artifactId }, select: { kind: true } });
    return artifact !== null && decodeArtifactKindV1(artifact.kind).kindHint === 'bot_template.v1';
}

/** The text Artifact writer signs its revision CAS and resulting recipient-envelope commit. */
function isArtifactJsonUpdateHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    if (proof.method.toUpperCase() !== 'POST') return false;
    if (isArtifactRecipientKeyPreparationHttpPurpose(proof)) return true;
    const match = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
    if (!match) return false;
    try {
        const artifactId = decodeURIComponent(match[1]);
        if (!artifactId || match[1] !== encodeURIComponent(artifactId)) return false;
        const update = ArtifactJsonUpdateHttpInputV1Schema.safeParse(proof.body);
        return update.success && (proof.routeInput === undefined
            || sameManagedInput(proof.routeInput, { id: artifactId, ...update.data }));
    } catch { return false; }
}

/** Restricted PATs spend exact template HTTP purposes. */
async function readBotTemplateHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): Promise<boolean | null> {
    const root = verified.binding.actionId;
    if (!isBotTemplateRestrictedPatHttpPurposeRootActionIdV1(root)) return null;
    const restrictedPat = !('authentication' in verified.binding)
        && isApiTokenGrantRestrictedV1(verified.binding.grant);
    if (!restrictedPat) return null;
    if (verified.signedChildPurpose.sibling.projectSessionDefaults)
        return isProjectSessionDefaultsHttpPurpose(verified, proof);
    if (verified.effectActionId !== root || proof.reviewedChild) return false;
    const method = proof.method.toUpperCase();
    if (root === 'template.instantiate' && method === 'POST' && proof.path === '/v1/sessions') {
        const birth = SessionCreateRequestSchema.safeParse(proof.body);
        return birth.success && !('creationAuthorizationProof' in birth.data)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, birth.data));
    }
    if (root === 'template.instantiate' && method === 'POST' && proof.path === '/v2/sessions/lookup-by-tags') {
        const lookup = SessionLookupByTagsRequestV2Schema.safeParse(proof.body);
        return lookup.success && lookup.data.tags.length === 1
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, lookup.data));
    }
    if (root === 'template.instantiate' && method === 'GET' && proof.body === undefined
        && proof.path.startsWith('/v2/session-organization?')) {
        try {
            const url = new URL(proof.path, 'https://home.invalid');
            const sessionId = url.searchParams.get('assignmentSessionIds');
            if (!sessionId || sessionId.includes(',')) return false;
            const request = buildSessionOrganizationAssignmentSnapshotHttpRequestV1([sessionId]);
            return proof.path === request.path && (proof.routeInput === undefined
                || sameManagedInput(proof.routeInput, request.query));
        } catch { return false; }
    }
    if (root === 'template.instantiate') {
        const accessKeyPath = /^\/v1\/access-keys\/([^/?#]+)\/([^/?#]+)$/u.exec(proof.path);
        if (accessKeyPath) {
            try {
                const sessionId = decodeURIComponent(accessKeyPath[1]);
                const machineId = decodeURIComponent(accessKeyPath[2]);
                if (!sessionId || machineId !== verified.binding.machineId
                    || proof.path !== `/v1/access-keys/${encodeURIComponent(sessionId)}/${encodeURIComponent(machineId)}`) return false;
                if (method === 'GET' && proof.body === undefined) return proof.routeInput === undefined
                    || sameManagedInput(proof.routeInput, { sessionId, machineId });
                const key = method === 'POST' ? SessionMachineAccessKeyCreateBodySchema.safeParse(proof.body) : null;
                return !!key?.success && (proof.routeInput === undefined
                    || sameManagedInput(proof.routeInput, { sessionId, machineId, ...key.data }));
            } catch { return false; }
        }
        const onboardingPath = /^\/v2\/sessions\/([^/?#]+)\/pending\/template-onboarding$/u.exec(proof.path);
        if (onboardingPath) {
            try {
                const sessionId = decodeURIComponent(onboardingPath[1]);
                const onboarding = method === 'POST' ? SessionPendingTemplateOnboardingRequestV1Schema.safeParse(proof.body) : null;
                if (!onboarding?.success || onboardingPath[1] !== encodeURIComponent(sessionId)) return false;
                const session = await db.session.findUnique({ where: { id: sessionId }, select: { accountId: true, tag: true } });
                return session?.accountId === verified.binding.accountId
                    && onboarding.data.request.sessionId === sessionId
                    && onboarding.data.request.targetMachineId === verified.binding.machineId
                    && onboarding.data.request.localId === buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: session.tag })
                    && onboarding.data.request.requestedAction.kind === 'send_now'
                    && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { sessionId, ...onboarding.data }));
            } catch { return false; }
        }
    }
    if (method === 'GET' && proof.path === '/v1/account/encryption' && proof.body === undefined) {
        return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
    }
    const recipientRoot = root === 'template.instantiate' || root === 'template.updates.apply';
    if (recipientRoot) {
        if (isAccountEncryptionCurrentnessHttpRead(proof)) {
            return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
        }
        if (method === 'GET' && proof.body === undefined) {
            if (proof.path === '/v2/account/settings' || proof.path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1
                || proof.path === PROMPT_LIBRARY_ROWS_ROUTE_V1) {
                return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
            }
            const prefix = `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/`;
            const key = proof.path.slice(prefix.length);
            if (proof.path.startsWith(prefix) && PromptLibraryCatalogKeyV1Schema.safeParse(key).success) {
                return proof.routeInput === undefined || sameManagedInput(proof.routeInput, { key });
            }
        }
        if (method === 'POST' && proof.path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) {
            const mutation = McpServerCatalogRowMutationV1Schema.safeParse(proof.body);
            return mutation.success && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, mutation.data));
        }
        if (isReadOnlyArtifactHttpPurpose(proof) || isArtifactRecipientKeyPreparationHttpPurpose(proof)) return true;
        if (method === 'POST' && proof.path === '/v1/artifacts') {
            const create = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
            return create.success && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, create.data));
        }
        if (isArtifactJsonUpdateHttpPurpose(proof)) return true;
    }
    if (root !== 'template.updates.skip' && root !== 'template.follow.stop'
        && (isReadOnlyArtifactHttpPurpose(proof) || isArtifactGrantsReadHttpPurpose(proof)
        || root === 'template.instantiate' && isArtifactPublicShareListHttpPurpose(proof)
        || isArtifactRecipientKeyPreparationHttpPurpose(proof))) return true;
    if ((root === 'template.instantiate' || root === 'template.updates.apply')
        && method === 'GET' && proof.body === undefined
        && proof.path === `/v1/machines/${encodeURIComponent(verified.binding.machineId)}`) {
        return proof.routeInput === undefined || sameManagedInput(proof.routeInput, { id: verified.binding.machineId });
    }
    if ((root === 'template.instantiate' || root === 'template.updates.apply')
        && method === 'POST' && proof.path === '/v1/machines/read-batch') {
        const batch = MachineReadBatchRequestV1Schema.safeParse(proof.body);
        return batch.success && batch.data.machineIds.every(id => id === verified.binding.machineId)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, batch.data));
    }
    if ((root === 'template.instantiate' || root === 'template.updates.apply')
        && method === 'PUT') {
        const reportPath = /^\/v1\/artifacts\/([^/?#]+)\/access\/accepted-version$/u.exec(proof.path);
        if (reportPath) {
            try {
                const artifactId = decodeURIComponent(reportPath[1]);
                const report = ArtifactTemplateAcceptedVersionInputV1Schema.safeParse(proof.body);
                return artifactId.length > 0 && reportPath[1] === encodeURIComponent(artifactId)
                    && report.success && report.data.artifactId === artifactId
                    && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { id: artifactId, ...report.data }));
            } catch { return false; }
        }
    }
    if (method === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated') {
        return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
    }
    if (root === 'template.preview' || root === 'template.export_file') return false;
    if (root !== 'template.updates.diff' && root !== 'template.updates.skip' && root !== 'template.follow.stop'
        && method === 'POST' && proof.path === '/v1/artifacts') {
        const create = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
        return create.success && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, create.data));
    }
    if ((root === 'template.draft' || root === 'template.release') && isArtifactJsonUpdateHttpPurpose(proof)) return true;
    if (root === 'template.release' && isArtifactSignedInLinkCreateHttpPurpose(proof)) {
        const link = ArtifactSignedInLinkCreateRequestV1Schema.safeParse(proof.body);
        return link.success && await isStoredBotTemplateArtifact(link.data.artifactId);
    }
    if (root === 'template.updates.apply' && method === 'DELETE') {
        const match = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
        if (match && proof.body === undefined) {
            try {
                const id = decodeURIComponent(match[1]);
                return id.length > 0 && match[1] === encodeURIComponent(id)
                    && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { id }));
            } catch { return false; }
        }
    }
    if (root === 'template.release') {
        const match = /^\/v1\/artifacts\/([^/?#]+)\/access\/grants$/u.exec(proof.path);
        if (!match || method !== 'PUT') return false;
        try {
            const artifactId = decodeURIComponent(match[1]);
            const grant = ArtifactAccessGrantSetInputV1Schema.safeParse(proof.body);
            return grant.success && grant.data.artifactId === artifactId && match[1] === encodeURIComponent(artifactId)
                && grant.data.accessLevel === 'view'
                && await isStoredBotTemplateArtifact(artifactId)
                && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { id: artifactId, ...grant.data }));
        } catch { return false; }
    }
    // Draft's source pointer and the recipient's private instance use the incumbent metadata tuple CAS.
    // Session routes retain owner access, mode admission and revision fencing.
    if (method === 'POST' && proof.path === '/v2/sessions/read-batch') {
        const batch = readSessionSnapshotBatchHttpDemand(proof);
        return batch !== null && batch.underSessionId === undefined;
    }
    if (!proof.sessionRouteTarget) return false;
    const path = `/v2/sessions/${encodeURIComponent(proof.sessionRouteTarget.sessionId)}`;
    if (method === 'GET' && proof.body === undefined) return proof.path === path || proof.path === `${path}?accessProjectionVersion=1`;
    if (root === 'template.updates.diff' || method !== 'PATCH' || proof.path !== path) return false;
    const patch = SessionMetadataTuplePatchV1Schema.safeParse(proof.body);
    return patch.success && (patch.data.mode === 'owner' || patch.data.mode === 'owner_migration');
}

/** One readable recursive membership owner serves lifecycle operands and selected-lead observation. */
async function isInstalledSessionSubtreeMember(verified: VerifiedExternalActionExecutionRequest,
    sessionId: string): Promise<boolean> {
    const origin = verified.binding.sessionActionOrigin;
    if (!origin || !isLedSubtreeSessionLifecycleActionId(verified.binding.actionId)
        && !isSessionListActionId(verified.binding.actionId)) return false;
    const members = await inReadSnapshot(tx => readSessionManagedSubtreeSessionIdsInTx(tx, {
        accountId: verified.binding.accountId, rootSessionId: origin.caller.sessionId,
        authentication: { env: process.env, authority: verified.effectiveAuthority,
            authenticationEvidence: verified.principal.authenticationEvidence,
            ...('authentication' in verified.binding ? { tokenEpoch: verified.binding.authentication.tokenEpoch }
                : { apiTokenGrant: verified.binding.grant }) },
    }));
    return members.includes(sessionId);
}

/** Original roots retain policy reads; lifecycle cascade may select a still-led nested root. */
async function isInstalledSessionSubtreeObservationHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof, snapshotBatch: SessionReadBatchRequestV1 | null): Promise<boolean | null> {
    // Installed listing and lifecycle observations share this purpose. Other roots
    // keep their declared selector preparation; non-observations use their effect purpose.
    if (!verified.binding.sessionActionOrigin
        || !isLedSubtreeSessionLifecycleActionId(verified.binding.actionId)
            && !isSessionListActionId(verified.binding.actionId) && verified.binding.actionId !== 'session.open'
        || !snapshotBatch && proof.path !== '/v2/sessions/query') return null;
    const origin = verified.binding.sessionActionOrigin;
    if (!origin || verified.effectActionId !== verified.binding.actionId
            && !verified.signedChildPurpose.sibling.archiveStop
        || proof.method.toUpperCase() !== 'POST') return false;
    const query = proof.path === '/v2/sessions/query' ? SessionListQueryV1Schema.safeParse(proof.body) : null;
    const underSessionId = snapshotBatch?.underSessionId ?? (query?.success ? query.data.underSessionId : undefined);
    if (!underSessionId) return false;
    return underSessionId === origin.caller.sessionId
        || isInstalledSessionSubtreeMember(verified, underSessionId);
}

/** Stop retires its control projection through the canonical owner tuple writer. */
function isSessionOwnerMetadataHttpPatch(proof: ExternalActionExecutionRequestProof, sessionId: string): boolean {
    if (proof.method.toUpperCase() !== 'PATCH' || proof.path !== `/v2/sessions/${encodeURIComponent(sessionId)}`) return false;
    const patch = SessionMetadataTuplePatchV1Schema.safeParse(proof.body);
    return patch.success && patch.data.mode === 'owner';
}

/**
 * A Session-target Stop phase (a Stop root, or the admitted Stop sibling of Archive,
 * Delete or Section Archive) retires its exact Session's control projection through the
 * owner tuple writer. Archive's sibling also reads that Session; the route owns access.
 */
function isSessionStopRetirementHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    const { sibling } = verified.signedChildPurpose;
    if (verified.effectActionId !== 'session.stop' || verified.target.kind !== 'session'
        || !isSessionStopPhaseRootV1(verified.binding.actionId)) return false;
    const path = `/v2/sessions/${encodeURIComponent(verified.target.sessionId)}`;
    return isSessionOwnerMetadataHttpPatch(proof, verified.target.sessionId) || sibling.archiveStop
        && proof.method.toUpperCase() === 'GET' && proof.body === undefined
        && (proof.path === path || proof.path === `${path}?accessProjectionVersion=1`);
}

/** Original lifecycle roots consume the same readable recursive subtree as Session listing. */
async function isInstalledSessionLifecycleHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): Promise<boolean> {
    const actionId = verified.effectActionId;
    if (!isLedSubtreeSessionLifecycleActionId(actionId) && actionId !== 'session.open' && actionId !== 'session.delete'
        || actionId !== verified.binding.actionId && !verified.signedChildPurpose.sibling.archiveStop
        || !proof.sessionRouteTarget
        || verified.binding.target.kind !== 'machine' || verified.target.kind !== 'machine') return false;
    const sessionId = proof.sessionRouteTarget.sessionId;
    const path = `/v2/sessions/${encodeURIComponent(sessionId)}`;
    const reads = proof.method.toUpperCase() === 'GET' && proof.body === undefined
        && (proof.path === path || proof.path === `${path}?accessProjectionVersion=1`);
    const origin = verified.binding.sessionActionOrigin;
    if (actionId === 'session.delete') {
        // Native deletion resolves its owned Session before Stop and directory cleanup.
        // Absence reaches the existing idempotent Delete recovery; foreign content and tuple writes stay closed.
        if (!reads) return false;
        const session = await db.session.findUnique({ where: { id: sessionId }, select: { accountId: true } });
        return session === null || session.accountId === verified.binding.accountId;
    }
    if (actionId === 'session.open' || actionId === 'session.stop') {
        if (!reads && !isSessionOwnerMetadataHttpPatch(proof, sessionId)) return false;
        const session = await db.session.findUnique({ where: { id: sessionId }, select: { accountId: true } });
        if (session?.accountId !== verified.binding.accountId) return false;
        if (!origin) return verified.effectiveAuthority === 'present_user';
        if (actionId === 'session.open') return sessionId === origin.caller.sessionId;
    } else {
        const op = actionId === 'session.archive' ? 'archive' : 'unarchive';
        const mutation = proof.method.toUpperCase() === 'POST' && proof.path === `${path}/${op}`
            && proof.body !== null && typeof proof.body === 'object' && !Array.isArray(proof.body)
            && Object.keys(proof.body).length === 0;
        if (!reads && !mutation) return false;
    }
    return isInstalledSessionSubtreeMember(verified, sessionId);
}

/** Post-commit preparation signs its operand read; the Session route retains access admission. */
function isSessionSourceKeyTransportHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (!['session.spawn_new', 'session.manager.set'].includes(verified.binding.actionId)
        || verified.effectActionId !== verified.binding.actionId
        || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
    // Operands may be encrypted and may name two Sessions on different Machines.
    // As with transition ancestry reads, the installed owner signs the exact
    // selected path under the original root; it cannot mint a new Session root.
    if (!proof.sessionRouteTarget) return false;
    if (verified.target.kind === 'session' && proof.sessionRouteTarget.sessionId !== verified.target.sessionId) return false;
    const path = `/v2/sessions/${encodeURIComponent(proof.sessionRouteTarget.sessionId)}`;
    return proof.path === path || proof.path === `${path}?accessProjectionVersion=1`;
}

/** Quota reads consume B's canonical request schemas, not a generic Account read privilege. */
function isQuotaReadHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    const url = new URL(proof.path, 'http://home.invalid');
    const method = proof.method.toUpperCase();
    if (method === 'POST') {
        return url.pathname === '/v2/pending/reset-starts/read' && url.search === ''
            && PendingResetStartsReadInputV1Schema.safeParse(proof.body).success;
    }
    if (method !== 'GET' || proof.body !== undefined) return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
    if (['/v1/account/encryption', '/v2/account/settings'].includes(url.pathname)) {
        return url.search === '';
    }
    const field = url.pathname === '/v4/connect/qualified/provider-account-usage/sources/resolve' ? 'source'
        : url.pathname === '/v4/connect/qualified/provider-account-usage/record' ? 'recordId'
        : url.pathname === '/v4/connect/qualified/provider-account-usage/history'
            || url.pathname === '/v4/connect/qualified/provider-account-usage/day-summaries' ? 'query' : null;
    if (!field || Array.from(url.searchParams.keys()).length !== 1 || !url.searchParams.has(field)) return false;
    try {
        const value = url.searchParams.get(field);
        if (field === 'recordId') return ProviderAccountUsageRecordIdSchema.safeParse(value).success;
        if (field === 'source') parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedServiceUsageSourceV4Schema, value);
        else if (url.pathname === '/v4/connect/qualified/provider-account-usage/day-summaries') {
            parseQualifiedConnectedAccountV4StructuredQueryValue(ProviderAccountUsageDaySummaryReadV1Schema, value);
        } else parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema, value);
        return true;
    } catch {
        return false;
    }
}

/** Personal review Actions use the existing Account currentness and KV owners. */
function isScmReviewedMarksHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    const url = new URL(proof.path, 'http://home.invalid');
    if (url.search !== '' || url.hash !== '') return false;
    const isReviewedKey = (key: string): boolean => {
        if (!key.startsWith(SCM_REVIEWED_MARKS_KV_PREFIX)) return false;
        try {
            return buildScmReviewedMarksKey(decodeURIComponent(key.slice(SCM_REVIEWED_MARKS_KV_PREFIX.length))) === key;
        } catch { return false; }
    };
    const method = proof.method.toUpperCase();
    if (method === 'POST' && url.pathname === '/v1/kv') {
        const request = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(KvMutationRequestSchema).safeParse(proof.body);
        return request.success && request.data.mutations.every(mutation => isReviewedKey(mutation.key));
    }
    if (method !== 'GET' || proof.body !== undefined) return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
    const prefix = '/v1/kv/';
    if (!url.pathname.startsWith(prefix)) return false;
    try {
        const key = decodeURIComponent(url.pathname.slice(prefix.length));
        return url.pathname === prefix + encodeURIComponent(key) && isReviewedKey(key);
    } catch { return false; }
}

/** Native resource observers read only their retained Account-mode projection. */
function isMachineOutcomeSummaryHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
    const url = new URL(proof.path, 'http://home.invalid');
    if (url.hash !== '') return false;
    if (url.pathname === '/v1/kv') {
        const keys = [...url.searchParams.keys()];
        return new Set(keys).size === keys.length
            && keys.every(key => key === 'prefix' || key === 'limit' || key === 'afterKey')
            && url.searchParams.get('prefix') === MACHINE_OUTCOME_SUMMARY_PREFIX;
    }
    if (url.search !== '' || !url.pathname.startsWith('/v1/kv/')) return false;
    try {
        const key = decodeURIComponent(url.pathname.slice('/v1/kv/'.length));
        return url.pathname === '/v1/kv/' + encodeURIComponent(key)
            && key.startsWith(MACHINE_OUTCOME_SUMMARY_PREFIX)
            && key.length > MACHINE_OUTCOME_SUMMARY_PREFIX.length;
    } catch { return false; }
}

function isSelectedProjectSourceReadHttpPurpose(homeId: string, proof: ExternalActionExecutionRequestProof): boolean {
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    const url = new URL(proof.path, 'http://home.invalid');
    const match = /^\/v1\/projects\/sources\/([^/]+)$/u.exec(url.pathname);
    if (!match || url.hash !== '' || url.searchParams.size !== 1) return false;
    try {
        const sourceId = decodeURIComponent(match[1]);
        return match[1] === encodeURIComponent(sourceId) && ProjectSourcesReadInputV1Schema.safeParse({
            serverId: url.searchParams.get('serverId'), sourceId }).success
            && url.searchParams.get('serverId') === homeId;
    } catch { return false; }
}

/** Source publication reuses the Artifact codec's scoped reads and envelope writer, never grants. */
function isProjectSourceSetupPreparationHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
    const url = new URL(proof.path, 'http://home.invalid');
    if (url.hash !== '') return false;
    if (proof.method.toUpperCase() === 'POST' && url.search === '') {
        return proof.body !== null && typeof proof.body === 'object'
            && 'projectSourceId' in proof.body && typeof proof.body.projectSourceId === 'string'
            && proof.body.projectSourceId.length > 0 && isArtifactRecipientKeyPreparationHttpPurpose(proof);
    }
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    const query = Object.fromEntries(url.searchParams);
    if (Object.keys(query).length !== url.searchParams.size || !query.projectSourceId
        || Object.keys(query).some(key => key !== 'projectSourceId' && key !== 'projectSourcePatch')) return false;
    const census = url.pathname.endsWith('/access/recipients');
    if (query.projectSourcePatch !== undefined) {
        if (!census) return false;
        try { if (!ProjectSourcePublicationPatchV1Schema.safeParse(JSON.parse(query.projectSourcePatch)).success) return false; }
        catch { return false; }
    }
    const match = /^\/v1\/artifacts\/([^/?#]+)(?:\/access\/recipients)?$/u.exec(url.pathname);
    if (!match) return false;
    let artifactId: string;
    try { artifactId = decodeURIComponent(match[1]); } catch { return false; }
    if (proof.routeInput !== undefined && !sameManagedInput(proof.routeInput, { id: artifactId, ...query })) return false;
    const unscoped = { ...proof, path: url.pathname, routeInput: { id: artifactId } };
    return census ? isArtifactRecipientKeyPreparationHttpPurpose(unscoped) : readArtifactGetHttpPurpose(unscoped) !== null;
}

/** Metadata purposes of an original Project root; domain routes retain row/CAS/audience admission. */
function isProjectAccountMetadataHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (verified.effectActionId !== verified.binding.actionId) return false;
    const actionId = verified.binding.actionId;
    // This read has exact signed selectors; its purpose owner below must bind
    // those operands before the Account row-family transport can admit it.
    if (actionId === PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1) return false;
    const url = new URL(proof.path, 'http://home.invalid');
    const method = proof.method.toUpperCase();
    if (MACHINE_TERMINAL_ACTION_IDS.some(id => id === actionId)) {
        if (url.search !== '' || url.hash !== '' || method !== 'POST') return false;
        // Census/control revalidate the requester's accepted checkouts. They
        // confer neither row mutation nor another Account's catalog authority.
        if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return ProjectAccountRowListRequestV1Schema.safeParse(proof.body).success;
        return (actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart')
            && url.pathname === `${PROJECT_TRUST_ROUTE_V1}/read` && ProjectTrustReadRequestV1Schema.safeParse(proof.body).success;
    }
    // Preparation, including an unsigned proposal replayed inside its admitted
    // decision, spends the unchanged signed root. Reads confer no mutation authority.
    const readsExecutionConfig = actionId === 'projects.script.run' || actionId === 'projects.compute.exec'
        || actionId === 'localServices.launcher.start' || actionId === 'localServices.actions.restartManaged'
        || actionId === 'approval.request.create' || actionId === 'approval.request.decide';
    if (Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId) || actionId === PROJECT_DEFINITION_INSPECT_ACTION_ID || readsExecutionConfig) {
        if (isAccountEncryptionCurrentnessHttpRead(proof) || readArtifactGetHttpPurpose(proof) !== null) return true;
        if (actionId === PROJECT_DEFINITION_INSPECT_ACTION_ID && (isSelectedProjectSourceReadHttpPurpose(verified.binding.serverIdentityId, proof)
            || /^\/v1\/artifacts\/[^/?#]+\?/u.test(proof.path) && isProjectSourceSetupPreparationHttpPurpose(proof))) return true;
        if (url.search !== '' || url.hash !== '') return false;
        if (method === 'GET' && proof.body === undefined) return readsExecutionConfig && url.pathname === '/v1/account/encryption';
        if (method !== 'POST') return false;
        // Finite work and inspection use admitted private requester custody for
        // Account topology. A signed Project root is not a catalog credential.
        const readsAccountRows = !Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId) && actionId !== PROJECT_DEFINITION_INSPECT_ACTION_ID;
        if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) return readsAccountRows && ProjectAccountRowReadRequestV1Schema.safeParse(proof.body).success;
        if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return readsAccountRows && ProjectAccountRowListRequestV1Schema.safeParse(proof.body).success;
        if (url.pathname === `${PROJECT_TRUST_ROUTE_V1}/read`) return ProjectTrustReadRequestV1Schema.safeParse(proof.body).success;
        if (url.pathname === `${PROJECT_TRUST_ROUTE_V1}/list`) return ProjectTrustListRequestV1Schema.safeParse(proof.body).success;
        return readsExecutionConfig && url.pathname === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`
            && WorkspaceExecutionConfigReadRequestV1Schema.safeParse(proof.body).success;
    }
    const sourcePath = '/v1/projects/sources';
    if (actionId.startsWith('projects.sources.')) {
        if (actionId === PROJECT_SOURCE_UPDATE_ACTION_ID_V1 && isProjectSourceSetupPreparationHttpPurpose(proof)) return true;
        if ((actionId === PROJECT_SOURCE_READ_ACTION_ID_V1 || actionId === PROJECT_SOURCE_UPDATE_ACTION_ID_V1)
            && isSelectedProjectSourceReadHttpPurpose(verified.binding.serverIdentityId, proof)) return true;
        if (method === 'GET' && proof.body === undefined
            && url.hash === ''
            && url.searchParams.getAll('serverId').length === 1
            && url.searchParams.get('serverId') === verified.binding.serverIdentityId) {
            return actionId === PROJECT_SOURCE_LIST_ACTION_ID_V1 && url.pathname === sourcePath;
        }
        if (url.search !== '') return false;
        const create = actionId === 'projects.sources.create' && method === 'POST' && url.pathname === sourcePath
            ? ProjectSourcesCreateInputV1Schema.safeParse(proof.body) : null;
        const mutation = actionId === 'projects.sources.update' && method === 'PATCH'
            ? ProjectSourcesUpdateInputV1Schema.safeParse(proof.body)
            : actionId === 'projects.sources.delete' && method === 'DELETE'
                ? ProjectSourcesDeleteInputV1Schema.safeParse(proof.body) : null;
        return Boolean(create?.success && create.data.serverId === verified.binding.serverIdentityId
            || mutation?.success && mutation.data.serverId === verified.binding.serverIdentityId
                && url.pathname === `${sourcePath}/${encodeURIComponent(mutation.data.sourceId)}`);
    }
    if (['projects.worker.preferences.get', 'projects.worker.preferences.set', 'projects.worker.preferences.reset',
        'projects.service.placement.get', 'projects.service.placement.set', 'projects.service.relocate'].includes(actionId)) {
        if (url.search !== '') return false;
        if (method === 'GET' && proof.body === undefined) return url.pathname === '/v1/account/encryption';
        if (method !== 'POST') return false;
        if (url.pathname === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) {
            return WorkspaceExecutionConfigReadRequestV1Schema.safeParse(proof.body).success;
        }
        return !actionId.endsWith('.get') && url.pathname === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/mutate`
            && WorkspaceExecutionConfigMutationRequestV1Schema.safeParse(proof.body).success;
    }
    if (!isProjectAccountRowActionIdV1(actionId) || url.search !== '') return false;
    if (method === 'GET' && proof.body === undefined) return actionId === 'projects.list'
        && (url.pathname === '/v1/account/authoring-memory' || url.pathname === '/v1/machines');
    if (method !== 'POST') return false;
    return url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read` || url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
        || getActionSpec(actionId).sideEffectClass === 'write' && url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`;
}

/** Match the canonical schema and transport rather than a parallel route permission. */
function isAccountActionHttpOperation(actionId: string,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (isSessionFollowActionIdV1(actionId) && actionId.startsWith('follow.')) {
        return isSessionFollowActionHttpRequestV1(actionId, { method: proof.method, path: proof.path,
            body: proof.body, routeInput: proof.routeInput, sessionRouteSessionId: proof.sessionRouteTarget?.sessionId });
    }
    // Signed-root admission already decided which Action may run; this binds
    // the request to that Action's own declared Account transport for every
    // family instead of a second hand-listed family permission.
    const action = ActionIdSchema.safeParse(actionId);
    if (!action.success) return false;
    const spec = getActionSpec(action.data);
    const transport = spec.serverTransport;
    if (spec.executionPlacement !== 'account' && !spec.deploymentPreparationScope || !transport
        || proof.method.toUpperCase() !== transport.method.toUpperCase()) return false;
    if (actionId.startsWith('session.delivery.mute.')) {
        if (!isSessionFollowActionIdV1(actionId)) return false;
        const receiver = proof.sessionRouteTarget
            ? { kind: 'session' as const, sessionId: proof.sessionRouteTarget.sessionId }
            : { kind: 'account' as const };
        const body = proof.body && typeof proof.body === 'object' && !Array.isArray(proof.body) ? proof.body : {};
        const parsedMute = spec.inputSchema.safeParse({ ...body, receiver });
        if (!parsedMute.success) return false;
        const expectedMute = resolveSessionFollowActionRequest(actionId, parsedMute.data);
        return expectedMute.path === proof.path && sameManagedInput(expectedMute.body, proof.body);
    }
    const input = isUsagePriceActionIdV1(actionId)
        ? (proof.routeInput === undefined ? proof.body ?? {} : proof.routeInput)
        : proof.routeInput ?? proof.body;
    // GET binding omits the existing domain version marker from its query.
    // Restore only that marker; all values/defaults still pass the Action schema.
    // Discussion content has already been sealed by the installed host. The
    // semantic Action schema is not its strict stored-content HTTP schema.
    const inputSchema = actionId === 'deployments.environments.update' ? DeploymentEnvironmentUpdateStorageInputV1Schema
        : actionId === 'deployments.bindings.set' ? DeploymentBindingsSetStorageInputV1Schema : isDiscussionActionIdV1(actionId)
        ? discussionActionHttpWireInputSchemaV1(actionId) : isHomeDomainActionIdV1(actionId)
        ? homeDomainActionHttpWireInputSchemaV1(actionId) : spec.inputSchema;
    const parsed = inputSchema.safeParse(input);
    const versioned = !parsed.success && transport.method.toUpperCase() === 'GET'
        && input && typeof input === 'object' && !Array.isArray(input)
        ? inputSchema.safeParse({ v: 1, ...input }) : parsed;
    if (!versioned.success) return false;
    const expected = bindHomeDomainHttpRequestV1({ transport, inputSchema, input: versioned.data });
    return expected.path === proof.path && sameManagedInput(expected.body, proof.body);
}

function isDeclaredReadActionId(actionId: string): boolean {
    const parsed = ActionIdSchema.safeParse(actionId);
    return parsed.success && getActionSpec(parsed.data).sideEffectClass === 'read';
}

/** Declared read transports consume only the operands admitted with the root. */
async function isAdmittedDeclaredDeploymentReadInScope(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string,
    proof: ExternalActionExecutionRequestProof,
    acceptedEnvironmentId?: string,
): Promise<boolean> {
    if (effectActionId === 'projects.sources.read') {
        const source = readDeploymentSourceReadOperands(binding.serverIdentityId, proof);
        return source ? await isDeploymentReadOperandInAdmittedScopeInTx(db, binding, source, acceptedEnvironmentId, undefined, effectActionId) === true : false;
    }
    if (!isDeclaredReadActionId(effectActionId) || !isAccountActionHttpOperation(effectActionId, proof)) return false;
    return await isDeploymentReadOperandInAdmittedScopeInTx(db, binding, proof.routeInput ?? proof.body, acceptedEnvironmentId, undefined, effectActionId) === true;
}

/**
 * A provider-role admission host (createDeploymentTargetRoleAdmissionHost) reads the Environment a
 * contributed provider read names (a Neon project list), then opens its content Artifact and, for a
 * linked read (Neon branches), the named target link's content Artifact, with its
 * admitted contributed root; that root carries no deployment read admission. The Environment and
 * Artifact routes keep the requester's own access, as for the requester's bearer read. A foreign
 * custodian (a Team member's Machine) chose the operand itself, so it names only an Environment its own
 * Account can read, as readDeploymentReferenceHttpPurpose does.
 */
// Not the admitted read-root rule: action.invoke is not a read root, and a foreign custodian reads only its own Environments.
async function isContributedRootEnvironmentRead(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): Promise<boolean> {
    const binding = verified.binding;
    if (!isContributedActionRoot(binding.actionId) || verified.effectActionId !== binding.actionId
        || binding.deploymentReadAdmission !== undefined) return false;
    let environmentId: string;
    if (isAccountActionHttpOperation(DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, proof)) {
        const read = DeploymentEnvironmentGetInputV1Schema.safeParse(proof.routeInput);
        if (!read.success || read.data.serverId !== binding.serverIdentityId) return false;
        environmentId = read.data.environmentId;
    } else {
        // The content Artifact is the Environment's own, or a current target link's that it names.
        const artifactId = readArtifactGetHttpPurpose(proof);
        const content = artifactId === null ? null : await db.deploymentEnvironment.findFirst({ where: {
            contentArtifactId: artifactId, deletedAt: null }, select: { id: true } })
            ?? await db.deploymentTargetLink.findFirst({ where: { contentArtifactId: artifactId, ...liveDeploymentTargetLinkWhere,
                environment: { deletedAt: null } }, select: { environmentId: true } }).then(link => link && { id: link.environmentId });
        if (!content) return false;
        environmentId = content.id;
    }
    return binding.custodianAccountId === binding.accountId || (await loadDeploymentEnvironmentInTx(db,
        binding.custodianAccountId, binding.serverIdentityId, environmentId)).ok;
}

/**
 * A read-only Account root (its ActionSpec declares sideEffectClass 'read' and the effect is the
 * root itself) makes the GET reads its effect needs with the requester's own Account credential.
 * Every route still applies the requester's own access, so this equals the requester's bearer read,
 * decided once here instead of a purpose entry per route. API-token bindings keep their grant-scoped
 * purposes, and a foreign custodian Machine gains no read of the requester's resources here.
 * (A contributed provider read stays isContributedRootEnvironmentRead: action.invoke is not a read
 * root, and that read adds the custodian's own Environment access.)
 */
function isAdmittedReadRootRequesterGet(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    const binding = verified.binding;
    const root = ActionIdSchema.safeParse(binding.actionId);
    if (!root.success || verified.effectActionId !== binding.actionId || !('authentication' in binding)
        || binding.custodianAccountId !== binding.accountId) return false;
    const spec = getActionSpec(root.data);
    return spec.sideEffectClass === 'read' && spec.executionPlacement === 'account'
        && proof.method.toUpperCase() === 'GET' && proof.body === undefined;
}

/** A Discussion operation admits only its resource-codec preparation phases. */
function isDiscussionActionHttpPreparation(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    const actionId = verified.effectActionId;
    const docChild = verified.signedChildPurpose.sibling.docDiscussion
        || verified.signedChildPurpose.sibling.docDecision;
    if (!isDiscussionActionIdV1(actionId) || verified.binding.actionId !== actionId && !docChild
        && !verified.signedChildPurpose.sibling.secondOpinion
        && !verified.signedChildPurpose.sibling.workflowDiscussion) return false;
    if (actionId === 'discussion.create' && isAccountEncryptionCurrentnessHttpRead(proof)) {
        return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
    }
    const url = new URL(proof.path, 'http://home.invalid');
    if (url.hash !== '') return false;
    const method = proof.method.toUpperCase();
    if (actionId === 'discussion.create' && method === 'GET' && proof.body === undefined
        && url.pathname === DISCUSSION_HTTP_PATHS_V1.collection) {
        // Recovery is creator-qualified, never an unfiltered collection read.
        const query: Record<string, string> = {};
        for (const [key, value] of url.searchParams) {
            if (Object.hasOwn(query, key)) return false;
            query[key] = value;
        }
        const schema = z.strictObject({
            creationLocalId: DiscussionListQueryV1Schema.shape.creationLocalId,
            state: DiscussionListQueryV1Schema.shape.state,
            cursor: DiscussionListQueryV1Schema.shape.cursor,
        });
        const parsed = schema.safeParse(query);
        const route = proof.routeInput === undefined ? parsed : schema.safeParse(proof.routeInput);
        return parsed.success && route.success && parsed.data.creationLocalId !== undefined
            && parsed.data.state !== undefined && sameManagedInput(parsed.data, route.data);
    }
    const prefix = DISCUSSION_HTTP_PATHS_V1.discussion.split(':discussionId')[0];
    if (!url.pathname.startsWith(prefix)) return false;
    let discussionId: string;
    try { discussionId = decodeURIComponent(url.pathname.slice(prefix.length).split('/')[0]); }
    catch { return false; }
    const params = DiscussionRouteDiscussionParamsV1Schema.safeParse({ discussionId });
    if (!params.success) return false;
    // A direct existing-Discussion root cannot spend its signed preparation
    // authority on another Discussion. Missing metadata from an older signer
    // fails closed for these auxiliary reads and writes.
    if (verified.binding.discussionId !== undefined
        ? verified.binding.discussionId !== params.data.discussionId
        : verified.binding.actionId === actionId && actionId !== 'discussion.create') return false;
    const atDiscussion = (path: string) => path.replace(':discussionId', encodeURIComponent(params.data.discussionId));
    const matchesInput = (body?: unknown) => proof.routeInput === undefined
        || sameManagedInput(proof.routeInput, { ...params.data,
            ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}) });
    // Download decoding opens the committed reference from one exact message;
    // it does not admit a history page or another Discussion under this root.
    if (actionId === 'discussion.attachment.read' && method === 'GET' && proof.body === undefined
        && url.pathname === atDiscussion(DISCUSSION_HTTP_PATHS_V1.messages)) {
        const selection = DiscussionReadInputV1Schema.safeParse(proof.routeInput);
        return selection.success && selection.data.messageId !== undefined
            && isAccountActionHttpOperation('discussion.read', proof);
    }
    if (url.search !== '') return false;
    // Reply policy is an original-root companion read, not a separately
    // authorized participants Action or permission to change the roster.
    if (verified.binding.actionId === actionId && (actionId === 'discussion.post' || actionId === 'discussion.reply')
        && method === 'GET' && proof.body === undefined
        && url.pathname === atDiscussion(DISCUSSION_HTTP_PATHS_V1.participants)) return matchesInput();
    const preparesContent = actionId === 'discussion.read' || actionId === 'discussion.attachment.read' || actionId === 'discussion.post'
        || actionId === 'discussion.reply' || actionId === 'discussion.rename'
        || actionId === 'discussion.invite' || actionId === 'discussion.access.grants.set';
    if (preparesContent && method === 'GET' && proof.body === undefined
        && url.pathname === atDiscussion(DISCUSSION_HTTP_PATHS_V1.discussion)) return matchesInput();
    // Doc comments create no participants; their root cannot spend C3's
    // separate recipient-key publication authority.
    const preparesRecipients = !docChild && (actionId === 'discussion.create' || actionId === 'discussion.get' || actionId === 'discussion.invite'
        || actionId === 'discussion.access.grants.set');
    if (!preparesRecipients) return false;
    if (method === 'GET' && proof.body === undefined
        && url.pathname === atDiscussion(DISCUSSION_HTTP_PATHS_V1.recipientCensus)) return matchesInput();
    return method === 'PUT' && url.pathname === atDiscussion(DISCUSSION_HTTP_PATHS_V1.recipientEnvelopes)
        && DiscussionRecipientKeyEnvelopeCommitInputV1Schema.safeParse(proof.body).success && matchesInput(proof.body);
}

function isPublicProfilePreparationHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (!verified.signedChildPurpose.sibling.publicProfile) return false;
    if (verified.effectActionId === 'artifact.get') return isReadOnlyArtifactHttpPurpose(proof);
    if (verified.effectActionId === 'account.public_profile.get') {
        return isAccountActionHttpOperation(verified.effectActionId, proof);
    }
    const method = proof.method.toUpperCase();
    if (method === 'GET') {
        return proof.body === undefined
            && ['/v1/account/encryption/currentness', '/v2/account/settings', '/v1/account/profile'].includes(proof.path)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, {}));
    }
    if (method !== 'POST' || proof.path !== accountUsageRoutePaths.analyticsQuery) return false;
    const query = UsageAnalyticsQueryRequestSchema.safeParse(proof.body);
    return query.success && query.data.population === 'public_eligible_personal'
        && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, proof.body));
}

function isPublicProfilePreparedMutationHttpPurpose(rootActionId: string,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (!isPublicProfilePreparationActionIdV1(rootActionId) || rootActionId === 'account.public_profile.preview') return false;
    const operation = rootActionId.slice('account.public_profile.'.length);
    const prepared = PublicProfilePreparedRequestV1Schema.safeParse({ operation, body: proof.body });
    if (!prepared.success) return false;
    const expected = bindPublicProfilePreparedHttpRequestV1(rootActionId, prepared.data);
    return proof.method.toUpperCase() === expected.method.toUpperCase() && proof.path === expected.path
        && sameManagedInput(proof.body, expected.body)
        && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, expected.body));
}

/** Author preparation reads spend the binding root; only the incumbent CAS can write grants. */
async function isDeploymentBindingPreparationHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): Promise<boolean> {
    const root = verified.binding.actionId;
    if (root === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 && verified.effectActionId === 'deployments.receipts.get'
        && isAccountActionHttpOperation('deployments.receipts.get', proof)) {
        return isAdmittedDeclaredDeploymentReadInScope(verified.binding, verified.effectActionId, proof);
    }
    if ((root !== DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 && root !== DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1)
        || verified.effectActionId !== root && verified.effectActionId !== 'deployments.environments.get') return false;
    if (isAccountActionHttpOperation('deployments.environments.get', proof)) {
        return isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(db, verified.binding, proof);
    }
    if (verified.effectActionId !== root) return false;
    if (isReadOnlyArtifactHttpPurpose(proof)) return true;
    const url = new URL(proof.path, 'http://home.invalid');
    if (proof.method.toUpperCase() !== 'POST' || url.search !== '' || url.hash !== '') return false;
    const prepared = EnvironmentSecretAdmissionRequestV1Schema.safeParse(proof.body);
    return prepared.success
        && prepared.data.serverId === verified.binding.serverIdentityId
        && prepared.data.environmentId === verified.binding.environmentId
        && ('kind' in prepared.data
            ? root === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 || prepared.data.buildMachineId === undefined
            : prepared.data.materialization.kind === 'bindings'
                && (root === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 || prepared.data.materialization.buildMachineId === undefined)
                && prepared.data.machineId === verified.binding.machineId && prepared.data.installationId === verified.binding.installationId)
        && proof.path === `/v1/deployments/environments/${encodeURIComponent(prepared.data.environmentId)}/secret-launch-admission`
        && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, prepared.data));
}

/** The installed owner signs exact read demand; each returned fact still needs current Source admission. */
function readDeploymentEnvironmentAccessPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof) {
    if (verified.effectActionId !== verified.binding.actionId || proof.method.toUpperCase() !== 'POST'
        || proof.path !== '/v1/deployments/environments/access') return null;
    const parsed = DeploymentEnvironmentAccessInputV1Schema.safeParse(proof.body);
    return parsed.success && parsed.data.serverId === verified.binding.serverIdentityId
        && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, parsed.data)) ? parsed.data : null;
}

/**
 * The declared read a finite deployment read admission spends. A provider-role admission host
 * (createDeploymentTargetRoleAdmissionHost) signs its Environment and receipt metadata reads with the
 * admitted root, as action.invoke's does; they spend the same declared-read scope as a sibling.
 */
function readDeclaredDeploymentReadActionId(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): string | undefined {
    if (verified.signedChildPurpose.sibling.deploymentRead) return verified.effectActionId;
    if (verified.effectActionId !== verified.binding.actionId) return undefined;
    return isAccountActionHttpOperation(DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, proof) ? DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1
        : isAccountActionHttpOperation(DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1, proof) ? DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1 : undefined;
}

/** Finite reads consume their signed scope; open logs retain current access admission. */
async function readDeploymentNativeReadHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof, exactTransportPurpose: boolean): Promise<Pick<VerifiedExternalActionExecutionRequest,
        'acceptedDeploymentReceipt' | 'deploymentChildArtifactRead'> | false> {
    const admission = verified.binding.deploymentReadAdmission;
    if (!admission || admission.actionId === PROJECT_READINESS_ACTION_IDS_V1[0]
        || admission.actionId === ACTION_INVOKE_ACTION_ID_V1 || !isDeploymentReadActionIdV1(verified.binding.actionId)) return false;
    const openLogs = admission.actionId === DEPLOYMENT_LOGS_READ_ACTION_ID_V1;
    const current = openLogs ? await readDeploymentReadAuthorizationInTx(db, verified.binding, admission, {
        authenticationAuthority: verified.effectiveAuthority, authenticationEvidence: verified.principal.authenticationEvidence,
    }) : null;
    if (openLogs && !current?.ok) return false;
    if (exactTransportPurpose && (admission.actionId !== 'deployments.health.current'
        || verified.effectActionId === verified.binding.actionId)) return {};
    const access = openLogs ? readDeploymentEnvironmentAccessPurpose(verified, proof) : null;
    if (access) return access.environmentIds.length === 1 && access.environmentIds[0] === admission.environmentId ? {} : false;
    const declaredRead = readDeclaredDeploymentReadActionId(verified, proof);
    if (declaredRead) {
        if (!await isAdmittedDeclaredDeploymentReadInScope(verified.binding, declaredRead, proof)) return false;
        return openLogs ? {} : { acceptedDeploymentReceipt: { read: { environmentId: admission.environmentId,
            ...('deploymentId' in admission && declaredRead === DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1
                ? { deploymentId: admission.deploymentId } : {}), contentCustody: true } } };
    }
    if (verified.effectActionId !== verified.binding.actionId || !isReadOnlyArtifactHttpPurpose(proof)) return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return {};
    const artifact = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
    if (!artifact) return false;
    if (openLogs) return current?.artifactIds.some(id => encodeURIComponent(id) === artifact[1]) ? {} : false;
    if (!('deploymentId' in admission)) return false;
    const scope = await readAdmittedDeploymentReadScopeInTx(db, admission);
    const content = scope?.artifactContents.find(reference => encodeURIComponent(reference.contentArtifactId) === artifact[1]);
    return content ? { deploymentChildArtifactRead: { content, requesterAccountId: verified.binding.accountId } } : false;
}

/** Query retains one signed finite read admission, including its exact installed secret acquisition. */
async function readDeploymentDataQueryHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): Promise<Pick<VerifiedExternalActionExecutionRequest,
        'acceptedDeploymentReceipt' | 'deploymentChildArtifactRead'> | false> {
    const admission = verified.binding.deploymentReadAdmission;
    if (admission?.actionId !== ACTION_INVOKE_ACTION_ID_V1
        && admission?.actionId !== DEPLOYMENT_DATA_SIZE_ACTION_ID_V1) return false;
    if (verified.effectActionId === admission.actionId && proof.method.toUpperCase() === 'POST'
        && proof.path === `/v1/deployments/environments/${encodeURIComponent(admission.environmentId)}/secret-launch-admission`) {
        const secret = EnvironmentSecretLaunchAdmissionInputV1Schema.safeParse(proof.body);
        if (!secret.success || secret.data.materialization.kind !== 'dataRole') return false;
        const body = secret.data, materialization = secret.data.materialization;
        if ('targetLinkId' in materialization && materialization.role === 'write'
            && (!('databaseTarget' in admission) || admission.access !== 'write')) return false;
        if ('databaseTarget' in admission) {
            const target = admission.databaseTarget;
            if (body.serverId !== verified.binding.serverIdentityId || body.environmentId !== admission.environmentId
                || body.targetLinkId !== admission.targetLinkId || body.machineId !== verified.binding.machineId
                || body.installationId !== verified.binding.installationId
                || proof.routeInput !== undefined && !sameManagedInput(proof.routeInput, body)) return false;
            return target.kind === 'deployment_service'
                ? !('targetLinkId' in materialization) && materialization.deploymentId === target.deploymentId
                    && materialization.service === target.serviceId ? {} : false
                : 'targetLinkId' in materialization && materialization.targetLinkId === target.targetLinkId ? {} : false;
        }
        if ('targetLinkId' in materialization) return false;
        return body.serverId === verified.binding.serverIdentityId && body.environmentId === admission.environmentId
            && body.targetLinkId === admission.targetLinkId && body.machineId === admission.machineId
            && body.installationId === admission.installationId && materialization.deploymentId === admission.deploymentId
            && materialization.expectedRevision === admission.expectedRevision
            && (!('service' in admission) || materialization.service === admission.service)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, body)) ? {} : false;
    }
    const declaredRead = readDeclaredDeploymentReadActionId(verified, proof);
    if (declaredRead) {
        if (!await isAdmittedDeclaredDeploymentReadInScope(verified.binding, declaredRead, proof)) return false;
        return { acceptedDeploymentReceipt: { read: { environmentId: admission.environmentId,
            ...(declaredRead === DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1
                ? 'deploymentId' in admission ? { deploymentId: admission.deploymentId }
                    : 'databaseTarget' in admission && admission.databaseTarget.kind === 'deployment_service'
                        ? { deploymentId: admission.databaseTarget.deploymentId } : {} : {}),
            contentCustody: true } } };
    }
    if (verified.effectActionId !== admission.actionId || !isReadOnlyArtifactHttpPurpose(proof)) return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return {};
    const artifact = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
    if (!artifact) return false;
    const scope = await readAdmittedDeploymentReadScopeInTx(db, admission);
    const content = scope?.artifactContents.find(reference => encodeURIComponent(reference.contentArtifactId) === artifact[1]);
    return content ? { deploymentChildArtifactRead: { content, requesterAccountId: verified.binding.accountId } } : false;
}

/** Backup and restore spend finite native admission; resource readers retain their own content boundary. */
type DeploymentBackupHttpPurpose = Pick<VerifiedExternalActionExecutionRequest,
    'acceptedDeploymentReceipt' | 'deploymentChildArtifactRead' | 'deploymentPreparationSourceRead'>;

/** The Project composite spends its signed finite scope; Source and content were admitted at mint. */
async function readProjectReadinessHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): Promise<DeploymentBackupHttpPurpose | false> {
    const admission = verified.binding.deploymentReadAdmission;
    if (admission?.actionId !== PROJECT_READINESS_ACTION_IDS_V1[0]) return false;
    if (verified.effectActionId === 'projects.sources.read'
        && await isAdmittedDeclaredDeploymentReadInScope(verified.binding, verified.effectActionId, proof)) {
        const { readProjectSourceCustodyInTx } = await import('@/app/projects/sources/projectSourceService');
        const custody = await readProjectSourceCustodyInTx(db, admission.projectId);
        return custody ? { deploymentPreparationSourceRead: { source: custody.source, canManage: false } } : false;
    }
    if (verified.effectActionId === 'deployments.environments.get'
        || verified.effectActionId === 'deployments.domains.list' || verified.effectActionId === 'deployments.domains.get') {
        const request = DeploymentActionInputSchemasV1[verified.effectActionId].safeParse(proof.routeInput);
        if (!request.success
            || !await isAdmittedDeclaredDeploymentReadInScope(verified.binding, verified.effectActionId, proof)) return false;
        return { acceptedDeploymentReceipt: { read: { environmentId: request.data.environmentId, contentCustody: true } } };
    }
    if (verified.effectActionId !== admission.actionId || !isReadOnlyArtifactHttpPurpose(proof)) return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return {};
    const artifact = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
    if (!artifact) return false;
    const scope = await readAdmittedProjectReadinessScopeInTx(db, admission);
    const content = scope.artifactContents.find(reference => encodeURIComponent(reference.contentArtifactId) === artifact[1]);
    return content ? { deploymentChildArtifactRead: { content, requesterAccountId: verified.binding.accountId } } : false;
}

async function readDeploymentBackupHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): Promise<DeploymentBackupHttpPurpose | false> {
    const admission = verified.binding.deploymentNativeAdmission;
    if (!admission || !('kind' in admission) || admission.kind !== 'restore' && admission.kind !== 'backup') return false;
    const transition = verified.signedChildPurpose.nativeTransition;
    if (admission.kind === 'restore' && admission.mode !== 'prepare' && transition
        && verified.effectActionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1) {
        // Restore publishes changed volume bindings on the incumbent generation.
        // The receipt owner selects that Link's active generation and retains its lifecycle.
        return transition.environmentId === admission.environmentId && transition.kind === 'settle'
            && (transition.state === 'succeeded' || transition.state === 'running_unverified')
            && transition.contentUpdate !== undefined && transition.expectedTargetLinkRevision === undefined
            && transition.teardownProof === undefined ? {} : false;
    }
    const copySource = admission.kind === 'restore' && admission.source.kind === 'repository'
        ? admission.source.origin : undefined;
    const destination = { environmentId: admission.environmentId, targetLinkId: admission.targetLinkId,
        secretKind: 'deployment' as const };
    const scopes = copySource ? [{ ...copySource, secretKind: 'copySourceRead' as const }, destination] : [destination];
    if (verified.signedChildPurpose.sibling.deploymentRead) {
        if (!await isAdmittedDeclaredDeploymentReadInScope(verified.binding, verified.effectActionId, proof)) return false;
        if (!copySource) return {};
        if (verified.effectActionId === 'projects.sources.read') {
            const source = readDeploymentSourceReadOperands(verified.binding.serverIdentityId, proof)!;
            const { readProjectSourceCustodyInTx } = await import('@/app/projects/sources/projectSourceService');
            const custody = await readProjectSourceCustodyInTx(db, source.sourceId);
            return custody ? { deploymentPreparationSourceRead: { source: custody.source, canManage: false } } : false;
        }
        const read = DeploymentActionInputSchemasV1[verified.effectActionId === 'deployments.receipts.get'
            ? 'deployments.receipts.get' : 'deployments.environments.get'].parse(proof.routeInput);
        return { acceptedDeploymentReceipt: { read: { environmentId: read.environmentId!,
            ...('deploymentId' in read ? { deploymentId: read.deploymentId } : {}), contentCustody: true } } };
    }
    for (const scope of scopes) {
        const environment = await db.deploymentEnvironment.findUnique({ where: { id: scope.environmentId },
            select: { projectSourceId: true, contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } });
        const link = await db.deploymentTargetLink.findFirst({ where: { id: scope.targetLinkId,
            environmentId: scope.environmentId }, select: { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true, activeDeploymentId: true } });
        if (!environment || !link) continue;
        const receipts = await db.deployment.findMany({ where: { environmentId: scope.environmentId,
            targetLinkId: scope.targetLinkId, id: { in: [admission.deploymentId,
                ...(scope.secretKind !== 'copySourceRead' && link.activeDeploymentId ? [link.activeDeploymentId] : [])] } },
            select: { id: true, contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true, actionOperationId: true } });
        if (verified.effectActionId !== verified.binding.actionId) continue;
        if (proof.method.toUpperCase() === 'POST') {
            if (proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return isDeploymentWorkspaceListHttpPurpose(verified.binding.serverIdentityId, proof) ? {} : false;
            const secret = EnvironmentSecretLaunchAdmissionInputV1Schema.safeParse(proof.body);
            if (!secret.success) continue;
            const body = secret.data, materialization = secret.data.materialization;
            if (proof.path !== `/v1/deployments/environments/${encodeURIComponent(scope.environmentId)}/secret-launch-admission`
                || body.serverId !== verified.binding.serverIdentityId || body.environmentId !== scope.environmentId
                || body.targetLinkId !== scope.targetLinkId || body.machineId !== admission.machineId
                || body.installationId !== admission.installationId
                || proof.routeInput !== undefined && !sameManagedInput(proof.routeInput, body)) continue;
            if (materialization.kind === 'dataRole') {
                if (scope.secretKind === 'deployment' && admission.kind === 'restore' && admission.mode === 'confirm'
                    && admission.destination?.kind === 'database' && !('targetLinkId' in materialization)
                    && materialization.service === admission.destination.service
                    && receipts.some(receipt => receipt.id === link.activeDeploymentId
                        && receipt.id === materialization.deploymentId)) return {};
                continue;
            }
            if (materialization.kind !== scope.secretKind) continue;
            if (materialization.kind !== 'deployment' && materialization.kind !== 'copySourceRead') continue;
            const generation = receipts.find(receipt => receipt.id === (scope.secretKind === 'copySourceRead'
                ? admission.deploymentId : link.activeDeploymentId));
            if (generation && materialization.deploymentId === generation.id
                && materialization.actionOperationId === generation.actionOperationId) return {};
            continue;
        }
        if (!isReadOnlyArtifactHttpPurpose(proof)) return false;
        if (isAccountEncryptionCurrentnessHttpRead(proof)) return {};
        const artifact = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
        const content = artifact && [environment, link, ...receipts].find(reference => encodeURIComponent(reference.contentArtifactId) === artifact[1]);
        if (content) return copySource ? { deploymentChildArtifactRead: { content, requesterAccountId: verified.binding.accountId } } : {};
        if (!copySource && artifact) {
            let artifactId: string;
            try { artifactId = decodeURIComponent(artifact[1]); } catch { return false; }
            const admitted = await readAdmittedDeploymentScopeInTx(db, verified.binding,
                undefined, undefined, undefined, { artifactId });
            if (admitted?.artifactIds.has(artifactId)) return {};
        }
    }
    return false;
}

function readDeploymentNativeTransition(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string, proof: ExternalActionExecutionRequestProof) {
    const operation = deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission);
    const effect = binding.actionId === 'deployments.receipts.observe' || binding.actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1
        ? binding.actionId : operation ? `deployments.${operation}` : null;
    if (!effect || effectActionId !== effect
        || proof.method.toUpperCase() !== 'POST') return null;
    const transition = DeploymentTransitionInputV1Schema.safeParse(proof.body);
    if (!transition.success || transition.data.serverId !== binding.serverIdentityId
        || transition.data.machineId !== binding.machineId || transition.data.installationId !== binding.installationId) return null;
    const expectedPath = `/v1/deployments/environments/${encodeURIComponent(transition.data.environmentId)}/deployments/${encodeURIComponent(transition.data.deploymentId)}/transitions`;
    return proof.path === expectedPath && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, proof.body))
        ? transition.data : null;
}

function isApiTokenOwnContentAccessHttpPurpose(verified: Pick<VerifiedExternalActionExecutionRequest, 'binding' | 'effectActionId'>,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (!('credentialId' in verified.binding) || verified.effectActionId !== verified.binding.actionId) return false;
    const method = proof.method.toUpperCase();
    const exactSelfRead = method === 'GET' && proof.path === '/v1/auth/api-tokens/self' && proof.body === undefined;
    const exactOwnMaterial = method === 'POST' && proof.path === '/v1/auth/api-tokens/encryption-access'
        && sameManagedInput(proof.body, {});
    // Both token handlers resolve only the authenticated token, without a token selector or inventory.
    return (exactSelfRead || exactOwnMaterial)
        && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, {}));
}

export function isDeploymentNativeHttpPurpose(verified: Pick<VerifiedExternalActionExecutionRequest, 'binding' | 'effectActionId'>,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (verified.binding.actionId === DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1) {
        if (verified.effectActionId !== verified.binding.actionId) return false;
        if (isAccountActionHttpOperation('deployments.environments.get', proof)) {
            const read = DeploymentEnvironmentGetInputV1Schema.safeParse(proof.routeInput);
            return read.success && read.data.serverId === verified.binding.serverIdentityId
                && read.data.environmentId === verified.binding.environmentId;
        }
        if (isAccountActionHttpOperation('deployments.receipts.get', proof)) {
            const read = DeploymentActionInputSchemasV1['deployments.receipts.get'].safeParse(proof.routeInput);
            return read.success && read.data.serverId === verified.binding.serverIdentityId
                && read.data.environmentId === verified.binding.environmentId;
        }
        return isReadOnlyArtifactHttpPurpose(proof)
            || readDeploymentNativeTransition(verified.binding, verified.effectActionId, proof) !== null;
    }
    if (isDeploymentDomainChildActionIdV1(verified.binding.actionId)) {
        return verified.effectActionId === verified.binding.actionId && isReadOnlyArtifactHttpPurpose(proof);
    }
    const root = (verified.binding.actionId === 'deployments.templates.instantiate' || verified.binding.actionId === 'deployments.environments.create')
        && deploymentOperationForRootActionV1(verified.binding.actionId, verified.binding.deploymentPreparationAdmission) === 'deploy'
        ? 'deployments.deploy' : verified.binding.actionId;
    const schema = deploymentNativeAdmissionInputSchema(root);
    if (!schema || !isDeploymentActionIdV1(root) || verified.effectActionId !== root) return false;
    if (isReadOnlyArtifactHttpPurpose(proof)) return true;
    const url = new URL(proof.path, 'http://home.invalid');
    if (url.hash !== '') return false;
    const method = proof.method.toUpperCase();
    if (method === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated') return root !== 'deployments.teardown';
    if (method !== 'POST' || url.search !== '') return false;
    if (url.pathname === '/v1/artifacts') {
        // Native publication is admitted against its exact shared-mint scope
        // by the existing preparation owner, never by Account/kind ownership.
        return false;
    }
    if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
        return root !== 'deployments.teardown' && isDeploymentWorkspaceListHttpPurpose(verified.binding.serverIdentityId, proof);
    }
    const admission = schema.safeParse(proof.body);
    if (admission.success && admission.data.serverId === verified.binding.serverIdentityId) {
        const transport = getActionSpec(root).serverTransport;
        if (!transport) return false;
        const bound = bindHomeDomainHttpRequestV1({ transport, inputSchema: schema, input: admission.data });
        return bound.path === proof.path && sameManagedInput(bound.body, proof.body)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, proof.body));
    }
    return readDeploymentNativeTransition(verified.binding, verified.effectActionId, proof) !== null;
}

/** A signed root spends its declared operation and required preparation reads. */
async function isProjectSessionDefaultsHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): Promise<boolean> {
    const selection = verified.binding.projectSessionDefaultsAdmission;
    const effect = verified.effectActionId;
    if (isSessionSpawnHomeDefaultsReadEffectV1(verified.binding.actionId, effect)) {
        return isAccountActionHttpOperation(effect, proof)
            && sameManagedInput(proof.routeInput ?? proof.body, { projection: 'session_defaults' });
    }
    if (!selection) return false;
    if (effect === PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1 && verified.binding.actionId === PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1) {
        const read = proof.method.toUpperCase() === 'POST' && proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`
            ? ProjectAccountRowReadRequestV1Schema.safeParse(proof.body) : null;
        return Boolean(selection.projectRef && read?.success && sameManagedInput(read.data, {
            key: { kind: 'project-session-defaults', ...selection.projectRef },
        }) && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, read.data)));
    }
    if (effect === PROJECT_SOURCE_READ_ACTION_ID_V1) {
        const source = readDeploymentSourceReadOperands(verified.binding.serverIdentityId, proof);
        return Boolean(selection.sourceRef && source && sameManagedInput(source, selection.sourceRef));
    }
    if (effect === 'home.governance.get') {
        return isAccountActionHttpOperation(effect, proof)
            && sameManagedInput(proof.routeInput ?? proof.body, { projection: 'session_defaults' });
    }
    if (effect !== 'teams.get' || !isAccountActionHttpOperation(effect, proof)) return false;
    const teamRead = getActionSpec(effect).inputSchema.safeParse(proof.routeInput ?? proof.body);
    if (!teamRead.success) return false;
    // Source custody supplies only the linked owner's identity. The Source and
    // Team routes retain their existing requester admission; no policy is read here.
    const { readProjectSourceOwnerInTx } = await import('@/app/projects/sources/projectSourceService');
    const owner = selection.sourceRef && !selection.primaryTeamId
        ? await readProjectSourceOwnerInTx(db, selection.sourceRef.sourceId) : null;
    const teamId = resolveManagedSessionDefaultsTeamId({ primaryTeamId: selection.primaryTeamId,
        sharedTeamIds: selection.sharedTeamIds,
        ...(owner && selection.sourceRef ? { projectSourceDefaults: {
            sourceId: selection.sourceRef.sourceId, owner, defaults: null,
        } } : {}),
    });
    return teamId !== null && teamRead.data.teamId === teamId;
}

/** The keyholding client signs native codec phases; resource routes retain access and CAS. */
function isCollectionSharingHttpPurpose(actionId: string, proof: ExternalActionExecutionRequestProof): boolean {
    if (isAccountEncryptionCurrentnessHttpRead(proof))
        return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
    if (proof.method.toUpperCase() !== 'POST'
        || proof.routeInput !== undefined && !sameManagedInput(proof.routeInput, proof.body)) return false;
    const readsRow = actionId === collectionSharingIds.get || actionId === collectionSharingIds.put
        || actionId === collectionSharingIds.setGrant;
    const repairsRecipientKeys = actionId === collectionSharingIds.get || actionId === collectionSharingIds.list;
    const schema = proof.path === PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1 ? PluginCollectionContractReadRequestV1Schema
        : proof.path === collectionSharingPaths.get && readsRow ? PluginCollectionSharingGetRequestV1Schema
        : proof.path === collectionSharingPaths.sharedWithMe && actionId === collectionSharingIds.list ? PluginCollectionSharingListRequestV1Schema
        : proof.path === collectionSharingPaths.put && actionId === collectionSharingIds.put ? PluginCollectionSharingPutRequestV1Schema
        : proof.path === collectionSharingPaths.grants && actionId === collectionSharingIds.listGrants ? PluginCollectionSharingAddressV1Schema
        : proof.path === collectionSharingPaths.setGrant && actionId === collectionSharingIds.setGrant ? PluginCollectionSharingSetGrantRequestV1Schema
        : proof.path === collectionSharingPaths.revokeGrant && actionId === collectionSharingIds.revokeGrant ? PluginCollectionSharingRevokeGrantRequestV1Schema
        : proof.path === collectionSharingPaths.census && (repairsRecipientKeys || actionId === collectionSharingIds.setGrant)
            ? PluginCollectionSharingCensusRequestV1Schema
        // Existing E2EE editor reads repair missing recipient envelopes; this
        // grants no writer claim or permission to replace row content/shares.
        : proof.path === collectionSharingPaths.commitKeys && repairsRecipientKeys ? PluginCollectionSharingCommitKeysRequestV1Schema
        : null;
    return schema?.safeParse(proof.body).success === true;
}

async function isAccountActionHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof, snapshotBatch: SessionReadBatchRequestV1 | null): Promise<boolean | null> {
    const root = verified.binding.actionId;
    if (isPluginCollectionSharingActionIdV1(root))
        return verified.effectActionId === root && isCollectionSharingHttpPurpose(root, proof);
    if (verified.signedChildPurpose.sibling.projectSetupSet) {
        // The keyholding host checked decoded root operands once before issuing
        // this signed child. Home keeps each Source/Artifact access decision.
        const child = verified.effectActionId;
        if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
        if (child === PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.sourceRead)
            return isSelectedProjectSourceReadHttpPurpose(verified.binding.serverIdentityId, proof);
        if (child === PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.artifactRead)
            return readArtifactGetHttpPurpose(proof) !== null
                || /^\/v1\/artifacts\/[^/?#]+\?/u.test(proof.path) && isProjectSourceSetupPreparationHttpPurpose(proof);
        if (child === PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.artifactCreate) {
            if (proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/account/encryption') return true;
            if (proof.method.toUpperCase() !== 'POST' || proof.path !== '/v1/artifacts') return false;
            const create = ArtifactJsonCreateHttpInputV1Schema.safeParse(proof.body);
            return create.success && create.data.kind === PROJECT_SETUP_ARTIFACT_STORED_KIND_V1
                && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, proof.body));
        }
        return false;
    }
    if (root === PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1
        || verified.signedChildPurpose.sibling.projectSessionDefaults)
        return isProjectSessionDefaultsHttpPurpose(verified, proof);
    if (isMachinePresetFiniteOperationActionIdV1(root)) {
        const admission = verified.binding.presetPreparationAdmission;
        if (!admission || verified.effectActionId !== root) return false;
        // Archive reads the original private binding's Machine facts using the
        // same requester. The Machine reader retains its ordinary visibility.
        if (root === MACHINE_PRESET_ARCHIVE_ACTION_ID_V1 && proof.method.toUpperCase() === 'GET' && proof.body === undefined) {
            const path = /^\/v1\/machines\/([^/?#]+)$/u.exec(proof.path);
            if (path) {
                try {
                    const id = decodeURIComponent(path[1]);
                    return id.length > 0 && path[1] === encodeURIComponent(id)
                        && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { id }));
                } catch { return false; }
            }
        }
        if (isAccountActionHttpOperation('machines.presets.get', proof)) {
            const read = MachinePresetActionInputSchemasV1['machines.presets.get'].safeParse(proof.body);
            return read.success && read.data.homeId === admission.homeId && read.data.id === admission.id;
        }
        if (isAccountActionHttpOperation('machines.presets.update', proof)) {
            const write = MachinePresetActionInputSchemasV1['machines.presets.update'].safeParse(proof.body);
            return write.success && write.data.homeId === admission.homeId && write.data.id === admission.id;
        }
        if (root !== MACHINE_PRESET_ARCHIVE_ACTION_ID_V1 || !isAccountActionHttpOperation(root, proof)) return false;
        const archive = MachinePresetActionInputSchemasV1[root].safeParse(proof.body);
        return archive.success && archive.data.homeId === admission.homeId && archive.data.id === admission.id;
    }
    if (root === MACHINE_ISOLATION_SET_ACTION_ID_V1) {
        const preset = MachinePresetActionInputSchemasV1['machines.presets.get'].safeParse(proof.body);
        // The receiving installed host opens only its configured references.
        // Preset transport still owns requester Account and content access.
        return verified.effectActionId === root && preset.success
            && preset.data.homeId === verified.binding.serverIdentityId
            && isAccountActionHttpOperation('machines.presets.get', proof);
    }
    if (isTeamGroupUpdateActionIdV1(root) || root === TEAM_CREDENTIAL_CREATE_ACTION_ID_V1) {
        if (verified.effectActionId !== root) return false;
        if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
        if (proof.method.toUpperCase() === 'POST' && proof.path === PRIVATE_LABEL_RECIPIENT_CENSUS_PATH) {
            const census = PrivateLabelRecipientCensusRequestV1Schema.safeParse(proof.body);
            // The installed host derives the Team from encrypted intent; the
            // census route retains its canonical Team membership admission.
            return census.success && census.data.owner.kind === 'team'
                && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, census.data));
        }
        return isAccountActionHttpOperation(root, proof);
    }
    const movePreparation = await readDeploymentMoveToRepositoryHttpPurpose(db, verified.binding, verified.effectActionId, proof);
    if (movePreparation !== null) return movePreparation;
    if (isExternalActionConnectedAccountInventoryHttpPurpose(verified.binding, verified.effectActionId, proof)) return true;
    const preparationRead = verified.signedChildPurpose.preparationRead;
    if (preparationRead && isDeploymentDomainMetadataReadActionIdV1(preparationRead.actionId)) return true;
    if (isExternalActionConnectedSubscriptionPriceHttpPurpose(verified.binding, verified.effectActionId, proof)) return true;
    // Environment names live in private headers. Listing opens only that
    // projection; the Artifact owner retains requester per-record access.
    if (root === DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1 && verified.effectActionId === root
        && proof.method.toUpperCase() === 'POST' && proof.path === '/v1/artifacts/read') {
        const read = ArtifactReadHeadersBatchInputV1Schema.safeParse(proof.body);
        return read.success && sameManagedInput(proof.body, read.data)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, read.data));
    }
    // The native reader admits exact metadata references before opening content;
    // Artifact routes retain requester Account/content authorization as for receipt observation.
    if (isDeploymentObservationReadActionIdV1(root) && verified.effectActionId === root
        && isReadOnlyArtifactHttpPurpose(proof)) return true;
    if (root === 'deployments.receipts.get' && verified.effectActionId === root
        && verified.binding.environmentId && isReadOnlyArtifactHttpPurpose(proof)) {
        const artifact = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
        // The receipt reader signs the selected content reference in the root's
        // admitted Environment. Artifact routes retain requester content access.
        return artifact !== null && await db.deployment.findFirst({ where: {
            contentArtifactId: decodeURIComponent(artifact[1]), environmentId: verified.binding.environmentId,
        }, select: { id: true } }) !== null;
    }
    if (isDeploymentEnvironmentMetadataReadActionIdV1(root)
        && (!verified.binding.environmentId || typeof proof.routeInput !== 'object' || proof.routeInput === null
            || !('environmentId' in proof.routeInput) || proof.routeInput.environmentId !== verified.binding.environmentId)) {
        proof.onRefusal?.('deployment_metadata_environment');
        return false;
    }
    const linkPreparation = await readDeploymentLinkPreparationHttpPurpose(db, verified.binding, verified.effectActionId, proof,
        actionId => isAccountActionHttpOperation(actionId, proof));
    if (linkPreparation !== null) return linkPreparation;
    const environmentContentPreparation = await readDeploymentEnvironmentContentPreparationHttpPurpose(db, verified.binding, verified.effectActionId, proof,
        actionId => isAccountActionHttpOperation(actionId, proof));
    if (environmentContentPreparation !== null) return environmentContentPreparation;
    if (isDeploymentDomainDnsActionIdV1(root) && verified.effectActionId === root && isReadOnlyArtifactHttpPurpose(proof)) {
        if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
        const artifactId = readArtifactGetHttpPurpose(proof);
        const batch = artifactId === null && proof.method.toUpperCase() === 'POST' && proof.path === '/v1/artifacts/read'
            ? ArtifactReadBatchHttpInputV1Schema.safeParse(proof.body) : undefined;
        const artifactIds = artifactId !== null ? [artifactId] : batch?.success ? batch.data.artifactIds : [];
        if (artifactIds.length === 0) return false;
        const scope = await readAdmittedDeploymentScopeInTx(db, verified.binding, undefined, undefined, undefined,
            { artifactIds });
        return scope !== null && artifactIds.every(id => scope.artifactIds.has(id));
    }
    if (root === 'artifact.get' && verified.effectActionId === root) return isReadOnlyArtifactHttpPurpose(proof)
        || isArtifactRecipientKeyPreparationHttpPurpose(proof);
    if (root === 'action.operations.cancel') return isExternalActionDeploymentPendingCancelPurpose({
        actionId: root, effectActionId: verified.effectActionId, serverIdentityId: verified.binding.serverIdentityId,
        method: proof.method, path: proof.path, body: proof.body, routeInput: proof.routeInput,
    });
    if (isMachineDeploymentEnvironmentAccessActionIdV1(root)
        && readDeploymentEnvironmentAccessPurpose(verified, proof)) return true;
    if (root === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1) {
        if (verified.effectActionId === root && isAccountActionHttpOperation(root, proof)) {
            return typeof proof.body === 'object' && proof.body !== null && 'environmentId' in proof.body
                && proof.body.environmentId === verified.binding.environmentId;
        }
        return await isDeploymentBindingPreparationHttpPurpose(verified, proof);
    }
    if ((root === 'deployments.environments.create' || root === 'deployments.environments.update')
        && verified.effectActionId === root) {
        // Definition admission opens private Artifacts; placement-only updates
        // compare current metadata instead. Resource routes retain access/CAS.
        if (isAccountActionHttpOperation(root, proof) || isReadOnlyArtifactHttpPurpose(proof)
            || root === 'deployments.environments.update' && await isDeploymentBindingPreparationHttpPurpose(verified, proof)) return true;
        if (root !== 'deployments.environments.update' || !isAccountActionHttpOperation('deployments.environments.get', proof)) return false;
        return isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(db, verified.binding, proof);
    }
    if (verified.signedChildPurpose.sibling.deploymentRead) {
        // Sibling reads consume only operands inside the root's admitted deployment scope.
        if (!isDeclaredReadActionId(verified.effectActionId) && verified.effectActionId !== 'projects.sources.read') {
            return isAccountActionHttpOperation(verified.effectActionId, proof);
        }
        return isAdmittedDeclaredDeploymentReadInScope(verified.binding, verified.effectActionId, proof,
            verified.acceptedDeploymentReceipt?.environmentId);
    }
    if (deploymentNativeAdmissionInputSchema(root) || isDeploymentDomainChildActionIdV1(root) || root === 'deployments.receipts.observe') {
        return isDeploymentNativeHttpPurpose(verified, proof)
            || await isDeploymentPreparationMachineReadHttpPurposeInTx(db, verified.binding, verified.effectActionId, proof);
    }
    if (root === 'approval.request.decide' && verified.effectActionId === root
        && isExternalActionApprovalReplyPurpose({ actionId: root, method: proof.method, path: proof.path, body: proof.body,
            admission: verified.binding.approvalDecisionAdmission })) return true;
    if (root === 'session.transcript.get' && verified.effectActionId === root
        && verified.binding.sessionActionOrigin && verified.binding.sessionActionSource
        && verified.binding.target.kind === 'machine' && verified.target.kind === 'machine'
        && proof.method.toUpperCase() === 'GET' && proof.body === undefined) {
        // The installed Session host consumes these two reads to prove its
        // protected Discussion's source. They retain the transcript root;
        // Discussion and Session routes still enforce current resource access.
        if (isAccountActionHttpOperation('discussion.get', proof)) return true;
        const read = DiscussionReadInputV1Schema.safeParse(proof.routeInput);
        if (read.success && read.data.messageId !== undefined && read.data.throughSeq !== undefined
            && isAccountActionHttpOperation('discussion.read', proof)) return true;
    }
    if (isPublicProfilePreparationActionIdV1(root)
        && verified.signedChildPurpose.sibling.publicProfile) {
        return isPublicProfilePreparationHttpPurpose(verified, proof);
    }
    if (isPublicProfilePreparationActionIdV1(root) && root !== 'account.public_profile.preview') {
        return verified.effectActionId === root && isPublicProfilePreparedMutationHttpPurpose(root, proof);
    }
    if ((root === 'usage.coach.dismiss' || root === 'usage.coach.snooze') && verified.effectActionId === root) {
        if (proof.method.toUpperCase() === 'GET' && proof.body === undefined
            && ['/v1/account/encryption/currentness', '/v2/account/settings',
                `/v1/kv/${encodeURIComponent(USAGE_COACH_SUPPRESSIONS_KV_KEY)}`].includes(proof.path)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, {}))) return true;
        if (proof.method.toUpperCase() === 'POST' && proof.path === '/v1/kv') {
            const request = KvMutationRequestSchema.safeParse(proof.body);
            return request.success && request.data.mutations.every(item => item.key === USAGE_COACH_SUPPRESSIONS_KV_KEY)
                && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, proof.body));
        }
    }
    if (verified.signedChildPurpose.sibling.personalUsage) {
        if (verified.effectActionId === 'connectedServices.quota.get') return isQuotaReadHttpPurpose(proof);
        if (proof.method.toUpperCase() === 'POST') {
            const admitted = proof.path === accountUsageRoutePaths.analyticsQuery
                ? UsageAnalyticsQueryRequestSchema.safeParse(proof.body).success
                : proof.path === accountUsageRoutePaths.analyticsQueryBatch
                    ? UsageAnalyticsQueryBatchRequestSchema.safeParse(proof.body).success
                    : proof.path === USAGE_SESSION_EVIDENCE_PATH && UsageSessionEvidenceRequestSchema.safeParse(proof.body).success;
            return admitted && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, proof.body));
        }
        return proof.method.toUpperCase() === 'GET' && proof.body === undefined
            && ['/v1/account/encryption/currentness', '/v2/account/settings', '/v1/account/profile',
                `/v1/kv/${encodeURIComponent(USAGE_COACH_SUPPRESSIONS_KV_KEY)}`].includes(proof.path)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, {}));
    }
    if (isUsagePublicRecapActionIdV1(root)) {
        // The installed executor signs this consumed safe-view read under its
        // unchanged recap root. No owner record or private Usage grant follows.
        return verified.effectActionId === root && proof.method.toUpperCase() === 'GET'
            && proof.body === undefined && proof.path === '/v1/account/public-profile/view'
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, {}));
    }
    if (root === 'artifact.access.grants.list' && verified.effectActionId === root
        || verified.signedChildPurpose.sibling.memory) {
        if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
        if (root !== 'artifact.access.grants.list' && isArtifactPublicShareListHttpPurpose(proof)) return true;
        return isArtifactGrantsReadHttpPurpose(proof);
    }
    if (root === 'doc.read') {
        if (!verified.signedChildPurpose.sibling.docRead) return false;
        // G2 owns original-root discovery; the admitted child still needs its codec discovery.
        if (proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated') return true;
        if (verified.effectActionId === 'artifact.get') return isReadOnlyArtifactHttpPurpose(proof);
        const list = DiscussionListInputV1Schema.safeParse(proof.routeInput ?? proof.body);
        // Home retains the original envelope digest, not its opened Doc ref.
        // The installed host signs that derived filter; C3 owns exact active
        // Doc/source admission and its batched first-root projection.
        return list.success && list.data.state === 'active' && list.data.anchorDocArtifactId !== undefined
            && list.data.anchorSessionId === undefined && list.data.creationLocalId === undefined && list.data.limit === undefined
            && isAccountActionHttpOperation('discussion.list', proof);
    }
    if (root === 'discussion.second_opinion.start') {
        if (verified.effectActionId === root) {
            if (proof.method.toUpperCase() === 'POST' && proof.path === DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1) {
                const parsed = DiscussionSecondOpinionPreviewInputV1Schema.safeParse(proof.body);
                return parsed.success && (proof.routeInput === undefined || sameManagedInput(parsed.data, proof.routeInput));
            }
            // The canonical transcript reader uses the original root while the
            // authenticated route retains its actual Session read admission.
            if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
            if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
            if (proof.sessionRouteTarget?.actionId !== 'session.transcript.get') return false;
            const sourcePath = encodeURIComponent(proof.sessionRouteTarget.sessionId);
            const url = new URL(proof.path, 'http://home.invalid');
            if (url.hash !== '') return false;
            // Query filters still pass the transcript route's canonical parser;
            // a source read grants no sibling Session metadata/reply purpose.
            return url.pathname === `/v1/sessions/${sourcePath}/messages`
                || url.pathname === `/v2/sessions/${sourcePath}`
                    && (url.search === '' || url.search === '?accessProjectionVersion=1');
        }
        if (!verified.signedChildPurpose.sibling.secondOpinion) return false;
        if (verified.effectActionId === 'artifact.get' || verified.effectActionId === 'artifact.access.grants.set') {
            if (proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated') return true;
            if (isAccountEncryptionCurrentnessHttpRead(proof)) return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
            const match = /^\/v1\/artifacts\/([^/?#]+)(?:\/access\/(grants|recipients|key-envelopes))?$/u.exec(proof.path);
            if (!match) return false;
            let artifactId: string;
            try { artifactId = decodeURIComponent(match[1]); } catch { return false; }
            if (!artifactId || match[1] !== encodeURIComponent(artifactId)) return false;
            const method = proof.method.toUpperCase();
            const matchesInput = (body?: unknown) => proof.routeInput === undefined || sameManagedInput(proof.routeInput,
                { id: artifactId, ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}) });
            if (isArtifactRecipientKeyPreparationHttpPurpose(proof)) return true;
            if (method === 'GET' && proof.body === undefined && match[2] === undefined) return matchesInput();
            if (method === 'PUT' && match[2] === 'grants' && verified.effectActionId === 'artifact.access.grants.set') {
                const parsed = ArtifactAccessGrantSetInputV1Schema.safeParse(proof.body);
                return parsed.success && parsed.data.artifactId === artifactId && matchesInput(parsed.data);
            }
            return false;
        }
        return isAccountActionHttpOperation(verified.effectActionId, proof)
            || isDiscussionActionHttpPreparation(verified, proof)
            || proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated';
    }
    if (root === 'doc.edit.accept' || root === 'doc.edit.decline') {
        if (verified.effectActionId === root) {
            const path = root === 'doc.edit.accept' ? DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.accept : DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.decline;
            const schema = root === 'doc.edit.accept' ? DocEditAcceptTransportInputV1Schema : DocEditDeclineTransportInputV1Schema;
            return proof.method.toUpperCase() === 'POST' && proof.path === path && schema.safeParse(proof.body).success
                && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, proof.body));
        }
        if (!verified.signedChildPurpose.sibling.docDecision) return false;
        if (verified.effectActionId === 'discussion.read') {
            return isAccountActionHttpOperation(verified.effectActionId, proof) || isDiscussionActionHttpPreparation(verified, proof)
                || proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated';
        }
        return isReadOnlyArtifactHttpPurpose(proof);
    }
    if (verified.signedChildPurpose.sibling.docDiscussion) {
        // As with usage export, Home retains the root envelope digest while
        // the installed host derives and signs the exact child operands.
        // C3 still owns access, source disclosure and encrypted content admission.
        return isAccountActionHttpOperation(verified.effectActionId, proof)
            || isDiscussionActionHttpPreparation(verified, proof)
            || proof.method.toUpperCase() === 'GET' && proof.body === undefined
                && proof.path === '/v1/features/authenticated';
    }
    // verifyCommon owns the root/effect relationship, including admitted plugin
    // children. Here the typed transport binds the exact effect and its bytes;
    // the resource route retains Account isolation and domain authorization.
    if (isDiscussionActionIdV1(verified.binding.actionId)) {
        return verified.effectActionId === verified.binding.actionId
            && (isAccountActionHttpOperation(verified.effectActionId, proof)
                || isDiscussionActionHttpPreparation(verified, proof));
    }
    if (verified.binding.actionId === SESSION_ORGANIZATION_PIN_SET_ACTION_ID_V1
        && proof.method.toUpperCase() === 'GET' && proof.body === undefined) {
        if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
        // Rail admission opens only a named authorized Session. The existing
        // detail route retains access/projection policy; no list or Account
        // content read is granted by the pin's installed-Machine signature.
        const detail = /^\/v2\/sessions\/([^/?#]+)(\?accessProjectionVersion=1)?$/u.exec(proof.path);
        if (detail) {
            try {
                const parsed = SessionOrganizationPinSetInputSchema.safeParse({ sessionId: decodeURIComponent(detail[1]), pinned: true });
                return parsed.success && proof.path === `/v2/sessions/${encodeURIComponent(parsed.data.sessionId)}${detail[2] ?? ''}`;
            } catch { return false; }
        }
        return false;
    }
    // An unrestricted PAT carries the same Account route rights on its signed
    // original effect; the route still checks the concrete resource and bytes.
    if (!isUsagePriceActionIdV1(root) && !('authentication' in verified.binding) && !isApiTokenGrantRestrictedV1(verified.binding.grant)
        && verified.effectActionId === root && !proof.reviewedChild) return true;
    // No specialized root claimed this request. Only an admitted operation
    // consumes it here; null leaves unrelated purposes with their own owner.
    return isAccountActionHttpOperation(verified.effectActionId, proof) ? true : null;
}

/** Candidate reads compose existing directories; the root grants no content or execution effect. */
function isDiscussionCandidateReadHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof, snapshotBatch: SessionReadBatchRequestV1 | null): boolean {
    if (verified.binding.actionId !== 'discussion.candidates.list'
        || verified.effectActionId !== verified.binding.actionId || verified.target.kind !== 'machine'
        || !('authentication' in verified.binding) && verified.binding.grant.targets !== null) return false;
    if (snapshotBatch) return true;
    const url = new URL(proof.path, 'http://home.invalid');
    if (url.hash !== '') return false;
    const method = proof.method.toUpperCase();
    if (method === 'POST' && proof.path === '/v2/sessions/query') {
        const query = SessionListQueryV1Schema.safeParse(proof.body);
        return query.success && sameManagedInput(query.data, projectDiscussionCandidateSessionQueryV1({
            source: 'sessions', ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        })) && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, query.data));
    }
    if (method !== 'GET' || proof.body !== undefined) return false;
    if (proof.path === '/v1/features/authenticated') return true;
    if (url.pathname === '/v1/user/search') {
        if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) return false;
        const query = UsersSearchQueryV1Schema.safeParse(Object.fromEntries(url.searchParams));
        return query.success && query.data.purpose === 'collaboration'
            && proof.path === bindDiscussionCandidatePeopleReadV1({ source: 'people', query: query.data.query,
                ...(query.data.cursor ? { cursor: query.data.cursor } : {}) });
    }
    const match = /^\/v1\/discussions\/([^/?#]+)\/participants$/u.exec(proof.path);
    if (!match) return false;
    try {
        const params = DiscussionRouteDiscussionParamsV1Schema.safeParse({ discussionId: decodeURIComponent(match[1]) });
        return params.success && match[1] === encodeURIComponent(params.data.discussionId)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, params.data));
    } catch { return false; }
}

/** Selector preparation spends its declared root, never a Follow or Discussion child Action. */
function isSessionTargetPreparationHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof, snapshotBatch: SessionReadBatchRequestV1 | null): boolean {
    const root = SignedRootActionIdSchema.safeParse(verified.binding.actionId);
    if (!root.success || !isSessionTargetPreparationAction(root.data)
        || verified.effectActionId !== verified.binding.actionId) return false;
    // Exact selector operands retain the same per-Session captured grants as
    // individual detail reads; this does not authorize a collection census.
    if (snapshotBatch) return true;
    const method = proof.method.toUpperCase();
    if (method === 'GET' && proof.body === undefined && proof.sessionRouteTarget?.actionId === 'session.transcript.get') {
        // Exact reference/manager facts precede selection and final Action scope.
        // Per-Session grants above and ordinary route access still apply.
        const path = `/v2/sessions/${encodeURIComponent(proof.sessionRouteTarget.sessionId)}`;
        if (proof.path === path || proof.path === `${path}?accessProjectionVersion=1`) return true;
    }
    if (method === 'GET' && proof.body === undefined && proof.sessionRouteTarget?.actionId === 'follow.list'
        && isSessionFollowActionHttpRequestV1('follow.list', { method, path: proof.path, routeInput: proof.routeInput,
            sessionRouteSessionId: proof.sessionRouteTarget.sessionId })) return true;
    // Native routes retain current actor/resource admission. Collection and
    // private Account facts additionally require the root's Account-wide scope.
    if (!('authentication' in verified.binding) && verified.binding.grant.targets !== null) return false;
    if (method === 'POST' && proof.path === '/v2/sessions/query') {
        const query = SessionListQueryV1Schema.safeParse(proof.body);
        return query.success && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, query.data));
    }
    if (method === 'GET' && proof.body === undefined) {
        if (proof.path === '/v1/account/encryption/currentness' || proof.path === '/v1/features/authenticated') {
            return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
        }
        if (isAccountActionHttpOperation('discussion.participants.list', proof)) return true;
        if (proof.path === SESSION_FOLLOW_RULES_ROUTE_V1 && isSessionFollowActionHttpRequestV1('follow.list', {
            method, path: proof.path, routeInput: proof.routeInput,
        })) return true;
    }
    // Status and installed contributed Actions read accepted-workspace rows
    // by exact id or Home/kind-filtered census for path-associated Sessions.
    // Both spend the same Account-wide read authority checked above.
    if ((root.data === 'session.status.get' || root.data === 'action.invoke') && method === 'POST' && !proof.sessionRouteTarget) {
        const rows = proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`
            ? ProjectAccountRowReadRequestV1Schema.safeParse(proof.body)
            : proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
                ? ProjectAccountRowListRequestV1Schema.safeParse(proof.body) : null;
        if (rows?.success) return ('authentication' in verified.binding || !isApiTokenGrantRestrictedV1(verified.binding.grant))
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, rows.data));
    }
    // Follow's existing transport owns the closed Project/assignment fact reads.
    return isSessionFollowActionHttpRequestV1('follow.preview', { method, path: proof.path, body: proof.body,
        routeInput: proof.routeInput, sessionRouteSessionId: proof.sessionRouteTarget?.sessionId });
}

/** Collection phases have no single Session operand and require captured Account-wide resource access. */
function isSessionListHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof, snapshotBatch: SessionReadBatchRequestV1 | null): boolean {
    const preview = verified.binding.actionId === 'follow.preview';
    if ((verified.binding.actionId !== 'session.list' && !preview) || verified.effectActionId !== verified.binding.actionId
        || verified.target.kind !== 'machine'
        || !('authentication' in verified.binding) && verified.binding.grant.targets !== null) return false;
    // Installed subtree observations retain their named root below, rather
    // than acquiring the Account-wide list reader's snapshot purpose.
    if (snapshotBatch) return verified.binding.sessionActionOrigin === undefined;
    const url = new URL(proof.path, 'http://home.invalid');
    if (proof.method.toUpperCase() === 'POST') return url.pathname === '/v2/sessions/query' && url.search === ''
        && SessionListQueryV1Schema.safeParse(proof.body).success;
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    // Preview consumes the authorized corpus, not Session listing's broader
    // metadata/settings preparation. Its local predicates stay host-owned.
    if (preview) return proof.path === '/v1/account/encryption/currentness';
    return ['/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived'].includes(url.pathname)
        || url.search === '' && ['/v1/account/encryption/currentness', '/v1/account/encryption', '/v2/account/settings'].includes(url.pathname);
}

/** Metadata snapshot preparation cannot spend an admitted root on turns, messages or another POST purpose. */
function readSessionSnapshotBatchHttpDemand(proof: ExternalActionExecutionRequestProof): SessionReadBatchRequestV1 | null {
    if (proof.method.toUpperCase() !== 'POST' || proof.path !== '/v2/sessions/read-batch') return null;
    const batch = SessionReadBatchRequestV1Schema.safeParse(proof.body);
    return batch.success && batch.data.includeSnapshot === true && batch.data.includeTurns === false
        && batch.data.includeMessages === false
        && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, batch.data)) ? batch.data : null;
}

/** Every admitted Session operand retains the captured grant and current Machine relationship. */
async function isExternalActionSessionTargetWithinGrant(binding: ExternalActionExecutionAuthorizationBindingV1,
    sessionId: string): Promise<boolean> {
    if ('authentication' in binding) return true;
    if (isApiTokenGrantTargetMemberV1(binding.grant, { kind: 'session', sessionId })) return true;
    for (const machineId of binding.grant.targets?.machines ?? []) {
        if (await hasCurrentSessionScopedMachineAccessInTx({ tx: db, accountId: binding.accountId, machineId, sessionId })) return true;
    }
    return false;
}

/** The installed coordinator owns decrypted selection; Home admits only its named, signed phases. */
async function isSessionAgentTransitionHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): Promise<boolean> {
    if (verified.effectActionId !== verified.binding.actionId) return false;
    const url = new URL(proof.path, 'http://home.invalid');
    const method = proof.method.toUpperCase();
    if (method === 'GET' && proof.body === undefined) {
        if (['/v1/account/encryption/currentness', '/v1/account/encryption', '/v2/account/settings'].includes(url.pathname)) {
            return url.search === '';
        }
        if (url.pathname === `/v1/machines/${encodeURIComponent(verified.binding.machineId)}`) return url.search === '';
        if (verified.target.kind !== 'session') return false;
        const read = /^\/v(?:1\/sessions\/([^/]+)(?:\/messages)?|2\/sessions\/([^/]+)(?:\/messages\/by-local-id\/[^/]+)?)$/u.exec(url.pathname);
        if (!read) return false;
        let sessionId: string;
        try { sessionId = decodeURIComponent(read[1] ?? read[2]); } catch { return false; }
        // Replay follows existing fork ancestry. Ordinary Account Session access
        // remains handler-owned; a PAT must retain its captured scope for each
        // actual requested ancestor, not borrow the child's resolved Machine.
        return isExternalActionSessionTargetWithinGrant(verified.binding, sessionId);
    }
    if (verified.binding.actionId !== 'session.agent.transition' || verified.target.kind !== 'session') return false;
    return isSessionOwnerMetadataHttpPatch(proof, verified.target.sessionId)
        || method === 'POST' && url.search === ''
            && url.pathname === `/v2/sessions/${encodeURIComponent(verified.target.sessionId)}/agent-transition/cutover`;
}

/** No generic descendant grant: first-input custody, the transition fence, stop and same-Session resume only. */
function isSessionAgentTransitionRpcPurpose(binding: ExternalActionExecutionAuthorizationBindingV1,
    execution: ExternalActionMachineRpcExecutionV1,
    request: Readonly<{ method: string; params?: unknown; event?: ExternalActionMachineRpcEventV1 }>): boolean {
    if (binding.actionId !== 'session.agent.transition' || execution.target.kind !== 'session') return false;
    const sessionId = execution.target.sessionId;
    if (execution.effectActionId === 'session.message.send') {
        const v1 = request.event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 && request.method === request.event;
        const v2 = request.event === SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 && request.method === request.event;
        const pending = v1 ? SessionPendingEnqueueByMachineRequestV1Schema.safeParse(request.params)
            : v2 ? SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.safeParse(request.params) : null;
        return Boolean(pending?.success && pending.data.sessionId === sessionId
            && pending.data.targetMachineId === binding.machineId && pending.data.requestedAction.kind === 'send_now');
    }
    if (execution.effectActionId !== binding.actionId || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL) return false;
    const fence = request.method === `${sessionId}:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`;
    const stop = request.method === `${binding.machineId}:${RPC_METHODS.STOP_SESSION}`;
    const resume = [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE]
        .some(method => request.method === `${binding.machineId}:${method}`);
    if (!fence && !stop && !resume) return false;
    // Home cannot open E2EE RPC params. The installed signature binds the exact
    // Session/method/ciphertext; the incumbent receiver validates the opened request.
    if (typeof request.params === 'string') return true;
    if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) return false;
    const params = request.params as Readonly<Record<string, unknown>>;
    if (fence) return params.serviceId === 'session.agentTransition' && (params.action === 'enforce' || params.action === 'clear');
    return params.sessionId === sessionId && (stop || params.type === 'resume-session');
}

/** Metadata writers, including permission intent, spend only their exact Session codec/tuple phases. */
function isSessionStateFieldActionHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (!(isSessionStateFieldActionId(verified.binding.actionId) || verified.binding.actionId === 'session.permission_mode.set')
        || verified.effectActionId !== verified.binding.actionId || verified.target.kind !== 'session') return false;
    const sessionPath = `/v2/sessions/${encodeURIComponent(verified.target.sessionId)}`;
    if (proof.method.toUpperCase() === 'GET' && proof.body === undefined) {
        return isAccountEncryptionCurrentnessHttpRead(proof)
            || proof.path === sessionPath || proof.path === `${sessionPath}?accessProjectionVersion=1`;
    }
    return proof.method.toUpperCase() === 'PATCH' && proof.path === sessionPath
        && SessionMetadataTuplePatchV1Schema.safeParse(proof.body).success;
}

/** The receiving guest owner admits the exact retained row after this signed relay framing. */
function isManagedCreationChildHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (proof.method.toUpperCase() !== 'POST' || verified.effectActionId !== verified.binding.actionId) return false;
    const continuation = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(proof.body);
    return continuation.success && continuation.data.managedContinuation !== undefined
        && MANAGED_MACHINE_CREATION_CHILD_ACTION_IDS_V1.some(action =>
            isManagedCreationContinuationRootV1(verified.binding.actionId, action)
            && (proof.path === bindExternalActionExecutionAuthorizationHttpPathV1(action)
                || proof.path === `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${action}`));
}

/** The Run Action owner spends its storage phases without acquiring a worker claim. */
function isWorkflowRunActionHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (verified.signedChildPurpose.sibling.workflowDiscussion) {
        // Home retains the root envelope digest. Its installed host signs the
        // exact derived read; C3 still owns grants, current keys and disclosure.
        return proof.method.toUpperCase() === 'GET' && proof.body === undefined
            && (isAccountActionHttpOperation('discussion.read', proof)
                || isDiscussionActionHttpPreparation(verified, proof)
                || proof.path === '/v1/features/authenticated');
    }
    if (verified.signedChildPurpose.sibling.workflowDeploymentRead) {
        // The route keeps the requester's own Environment and receipt access; no content custody opens.
        if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined
            || !isAccountActionHttpOperation(verified.effectActionId, proof)) return false;
        const operands = proof.routeInput;
        return typeof operands === 'object' && operands !== null && 'serverId' in operands
            && operands.serverId === verified.binding.serverIdentityId;
    }
    if (verified.binding.actionId === WORKFLOW_RUN_START_ACTION_ID_V1 && isManagedCreationChildHttpPurpose(verified, proof)) return true;
    const reads = ['get', 'run-key.census', 'run-key.commit'];
    const invocationReads = [...reads, 'invocations.list', 'invocations.get', 'invocations.current'];
    const purposes: Readonly<Record<string, readonly string[]>> = {
        // Accepted replay / Another round reads the prior Run's exact outcomes
        // before admission. These are Account reads, not worker mutations.
        'workflow.run.start': [...invocationReads, 'admit'],
        'workflow.run.get': invocationReads,
        'workflow.run.list': ['list', 'run-key.commit'],
        'workflow.run.summaries': ['summaries'],
        // Wait reads the same invocation history as Get to reject a wait
        // that would occupy its own target conversation.
        'workflow.run.wait': [...invocationReads, 'wait'],
        'workflow.run.pause': [...reads, 'pause'],
        'workflow.run.cancel': [...reads, 'cancel'],
        'workflow.run.delete': [...reads, 'delete'],
        'workflow.run.resume': [...invocationReads, 'resume', 'invocations.recover'],
        'workflow.run.invocations.list': [...reads, 'invocations.list'],
        'workflow.run.invocations.get': invocationReads,
        'workflow.run.invocations.retry': [...invocationReads, 'invocations.recover'],
        'workflow.run.invocations.publish_draft': [...invocationReads, 'invocations.publish_draft'],
        'workflow.run.invocations.complete_review': [...invocationReads, 'invocations.complete_review'],
    };
    const allowed = Object.hasOwn(purposes, verified.binding.actionId) ? purposes[verified.binding.actionId] : undefined;
    if (!allowed || verified.effectActionId !== verified.binding.actionId || verified.target.kind !== 'machine') return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
    if (proof.method.toUpperCase() !== 'POST' || proof.path !== '/v3/automations/runs/workflow-storage'
        || !proof.body || typeof proof.body !== 'object' || Array.isArray(proof.body)) return false;
    const body = proof.body as Readonly<Record<string, unknown>>;
    const reattachFact = verified.binding.actionId === 'workflow.run.resume' && body.operation === 'invocations.fact'
        && (body.resolution === 'observed_terminal_execution' || body.resolution === 'root_list_progress')
        && Number.isSafeInteger(body.expectedRevision) && Number(body.expectedRevision) >= 0 && body.parentAttempt === undefined;
    // Signed HTTP ingress verifies external Action reads once; storage retains
    // strict parsing, resource, mode and CAS checks. Only executor operations
    // require a separate worker publisher proof.
    return typeof body.operation === 'string' && (allowed.includes(body.operation) || reattachFact)
        && body.publisherMachineId === verified.binding.machineId;
}

/** The installed host derives private operands; domain routes still own current resource access. */
async function isSessionSectionHttpPurpose(verified: VerifiedSignedChildRequest,
    proof: ExternalActionExecutionRequestProof): Promise<boolean> {
    if (isSessionSectionActionIdV1(verified.effectActionId)) {
        const purpose = readSessionSectionActionHttpPurposeV1(verified.effectActionId, {
            ...proof, sessionRouteSessionId: proof.sessionRouteTarget?.sessionId,
        });
        if (!purpose) return false;
        for (const sessionId of purpose.sessionIds) {
            if (!await isExternalActionSessionTargetWithinGrant(verified.binding, sessionId)) return false;
        }
        return true;
    }
    if (!verified.signedChildPurpose.sibling.sectionArchive
        && !verified.signedChildPurpose.sibling.stopChild) return false;
    const sessionId = proof.sessionRouteTarget?.sessionId;
    const sessionPath = sessionId ? `/v2/sessions/${encodeURIComponent(sessionId)}` : null;
    if (verified.effectActionId === 'session.archive' && proof.method.toUpperCase() === 'POST') {
        return sessionPath !== null && proof.sessionRouteTarget?.actionId === 'session.archive'
            && proof.method.toUpperCase() === 'POST' && proof.path === `${sessionPath}/archive`
            && SessionArchiveHttpBodyV1Schema.safeParse(proof.body).success;
    }
    if (isSessionStopRetirementHttpPurpose(verified, proof)) return true;
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    // These are the incumbent Stop observations, not a second Stop admission.
    return isAccountEncryptionCurrentnessHttpRead(proof)
        || sessionPath !== null && (proof.path === sessionPath || proof.path === `${sessionPath}?accessProjectionVersion=1`)
        || proof.path === `/v1/machines/${encodeURIComponent(verified.binding.machineId)}`;
}

export async function verifyExternalActionDomainExecutionRequest(
    proof: ExternalActionExecutionRequestProof,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const verified = await verifyCommon(proof);
    if (!verified) return null;
    const refuse = (phase: ExternalActionAuthorizationRefusalPhase) => refuseExternalActionExecutionRequest(phase, proof, undefined,
        { rootActionId: verified.binding.actionId, effectActionId: verified.effectActionId });
    const snapshotBatch = readSessionSnapshotBatchHttpDemand(proof);
    if (proof.path === '/v2/sessions/read-batch' && !snapshotBatch) return refuse('verification_purpose');
    // All reachable roots spend the same resolved private phase, including
    // approval/invoke wrappers. Finite preview corpus permission is separate.
    if (verified.effectActionId === 'follow.preview' && isSessionFollowActionHttpRequestV1('follow.preview', {
        method: proof.method, path: proof.path, body: proof.body, routeInput: proof.routeInput,
        sessionRouteSessionId: proof.sessionRouteTarget?.sessionId,
    })
        && !('authentication' in verified.binding) && isApiTokenGrantRestrictedV1(verified.binding.grant)) return refuse('credential_action_admission');
    const sessionIds = new Set([
        ...(proof.sessionRouteTarget ? [proof.sessionRouteTarget.sessionId, ...(proof.sessionRouteTarget.additionalSessionIds ?? [])] : []),
        ...(snapshotBatch?.sessionIds ?? []), ...(snapshotBatch?.underSessionId ? [snapshotBatch.underSessionId] : []),
    ]);
    for (const sessionId of sessionIds) {
        if (!await isExternalActionSessionTargetWithinGrant(verified.binding, sessionId)) return refuse('resolved_target');
    }
    if (verified.binding.handoffPreflight && (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined
        || proof.path !== `/v1/machines/${encodeURIComponent(verified.binding.machineId)}`)) return refuse('verification_purpose');
    const relay = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(proof.body);
    const isAdmittedRootRelay = proof.method.toUpperCase() === 'POST'
        && proof.path === `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${encodeURIComponent(verified.binding.actionId)}`
        && relay.success && relay.data.executionAuthorization?.token === proof.authorizationToken
        && sameManagedInput(relay.data.executionAuthorization.binding, verified.binding)
        && isExternalActionAuthorizationBoundToEnvelope(verified.binding, { actionId: verified.effectActionId,
            machineId: relay.data.machineId, envelope: relay.data.envelope });
    const root = SignedRootActionIdSchema.safeParse(verified.binding.actionId);
    const rootSpec = root.success ? getActionSpec(root.data) : null;
    const templateHttpPurpose = await readBotTemplateHttpPurpose(verified, proof);
    const signedLinkHttpPurpose = readExternalActionArtifactSignedInLinkPurpose(verified.binding.actionId, proof);
    const nativePurpose = rootSpec?.originalExecution?.nativePurpose;
    const rootMachineAction = MachineAccessActionIdSchema.safeParse(verified.binding.actionId);
    const effectMachineAction = MachineAccessActionIdSchema.safeParse(verified.effectActionId);
    const readsExecutionMachine = root.success
        && (((rootSpec?.executionPlacements ?? [rootSpec?.executionPlacement]).includes('machine')
                || verified.binding.sessionActionOrigin && isLedSubtreeSessionLifecycleActionId(root.data))
            && verified.binding.target.kind === 'machine' && verified.binding.target.machineId === verified.binding.machineId
            || getActionSpec(root.data).executionPlacement === 'session' && verified.target.kind === 'session')
        && (verified.effectActionId === verified.binding.actionId
            || isContributedActionRoot(verified.binding.actionId)
            || verified.signedChildPurpose.sibling.archiveStop
            || verified.signedChildPurpose.sibling.projectPrepareReview)
        && proof.method.toUpperCase() === 'GET' && proof.body === undefined
        && proof.path === `/v1/machines/${encodeURIComponent(verified.binding.machineId)}`;
    const managedRoot = ManagedMachineActionIdV1Schema.safeParse(verified.binding.actionId);
    const admittedReadRootRequesterGet = isAdmittedReadRootRequesterGet(verified, proof);
    const reviewedMachineSetupChild = verified.signedChildPurpose.reviewedMachineSetupChild
        && verified.reviewedChildAdmission?.actionId === verified.effectActionId;
    let managedGuestActivity: VerifiedExternalActionExecutionRequest['managedGuestActivity'];
    let deploymentChildMachineRead: DeploymentChildMachineRead | undefined;
    let setupMachineReadId: string | undefined;
    let managedBoundSessionPurpose: boolean | null;
    let deploymentChildArtifactRead: VerifiedExternalActionExecutionRequest['deploymentChildArtifactRead'];
    let registryAppUpdateRead: VerifiedExternalActionExecutionRequest['registryAppUpdateRead'];
    let backupHttpPurpose: DeploymentBackupHttpPurpose | undefined;
    if (verified.acceptedDeploymentReceipt && verified.binding.actionId === 'deployments.teardown'
        && verified.effectActionId === verified.binding.actionId) {
        const artifactId = readArtifactGetHttpPurpose(proof);
        const content = artifactId ? await readAcceptedDeploymentTeardownDomainContentInTx(db, verified.binding, artifactId) : null;
        if (content) deploymentChildArtifactRead = { content, requesterAccountId: verified.binding.accountId };
    }
    const nativePublication = verified.signedChildPurpose.candidatePublication
        && (proof.path === '/v1/artifacts'
            || /^\/v1\/artifacts\/[^/?#]+(?:\/access\/(?:grants|recipients|key-envelopes))?$/u.test(proof.path)
                && (proof.method.toUpperCase() !== 'GET' || proof.path.includes('/access/')));
    const domainPreparation = verified.deploymentChildRouting ? null
        : await readDeploymentDomainPreparationHttpPurpose(db, verified.binding, verified.effectActionId, proof,
        verified.deploymentDomainPurpose?.kind === 'admission' ? verified.deploymentDomainPurpose.input.environmentId : undefined,
        verified.acceptedDeploymentReceipt !== undefined, {
            artifact: isReadOnlyArtifactHttpPurpose(proof),
            environment: isAccountActionHttpOperation('deployments.environments.get', proof),
        });
    let subtreeObservationHttpPurpose: boolean | null;
    let accountHttpPurpose: boolean | null;
    let accountHttpRefusal: ExternalActionAuthorizationRefusalPhase | undefined;
    if (domainPreparation === false) return refuse('deployment_domain_preparation');
    if (isExternalActionApprovalArtifactPurpose({ binding: verified.binding, effectActionId: verified.effectActionId,
        method: proof.method, path: proof.path, body: proof.body })) {
        // The Action's deterministic Ask is its own output. Artifact ownership,
        // encryption and compare-and-set remain with the ordinary Artifact route.
    } else if (isApiTokenOwnContentAccessHttpPurpose(verified, proof)) {
        // The token handlers resolve only the verified root's own content access.
    } else if (isDeploymentApprovalMetadataPreparationActionIdV1(verified.binding.actionId)
        && verified.effectActionId === verified.binding.actionId
        && await isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(db, verified.binding, proof, true)) {
        // Mint admitted this root's exact Environment. This projection opens no content.
    } else if (verified.setupReceiverMachineId !== undefined) {
        // A Setup target's own signature admits no other root purpose.
        if (!await isDeploymentPreparationHttpPurposeInTx(db, verified.binding, verified.effectActionId, proof,
            { authenticationAuthority: verified.effectiveAuthority, authenticationEvidence: verified.principal.authenticationEvidence },
            isReadOnlyArtifactHttpPurpose, undefined, verified.setupReceiverMachineId)) return refuse('deployment_setup_receiver_purpose');
    } else if (reviewedMachineSetupChild) {
        const purpose = readReviewedMachineSetupHttpPurpose(verified, proof);
        if (!purpose) return refuse('machine_setup_purpose');
        setupMachineReadId = purpose.machineId;
    } else if (verified.signedChildPurpose.reviewedSessionAgentReadinessChild) {
        // These finite children need the existing requester Machine codec only.
        // Installation permission is consumed at the install RPC admission.
        if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined
            || !isAccountEncryptionCurrentnessHttpRead(proof)
                && proof.path !== `/v1/machines/${encodeURIComponent(verified.binding.machineId)}`) return refuse('session_agent_readiness_purpose');
    } else if (verified.signedChildPurpose.prepareSession) {
        // The signed child owner already bound these actual codec/Session reads.
        // Ordinary Session routes retain their access checks; preparation is not re-decided in P.
    } else if (verified.createPreparationAdmission || verified.deploymentPreparationSourceRead
        || verified.deploymentTargetRetentionAdmission || verified.deploymentReviewedSetupRead
        || verified.acceptedDeploymentReceipt?.read || verified.acceptedDeploymentReceipt?.platformMaterial
        || verified.acceptedDeploymentReceipt && verified.signedChildPurpose.deploymentWorkspaceRead
        || verified.signedChildPurpose.deploymentReferenceRead
        || verified.actionMaterialAdmission || verified.actionBrokerAdmission) {
        // verifyCommon already consumed the one purpose + admitted-job result.
    } else if (domainPreparation === true) {
        // The existing owner matched this exact private candidate or prepared
        // Domain operand, including its reviewed child's root Environment.
    } else if (verified.deploymentDomainPurpose) {
        // The Domain purpose owner admitted these signed bytes; its accepted
        // capture (or prepared-content CAS owner) retains the job relationship.
    } else if (nativePublication) {
        if (verified.deploymentChildRouting && verified.deploymentChildRouting.kind !== 'prepare') return refuse('deployment_publication_child_kind');
        if (!await isDeploymentCandidatePublicationHttpPurposeInTx(db, verified.binding, verified.effectActionId, proof)) return refuse('deployment_publication_purpose');
    } else if (verified.deploymentChildRouting) {
        const machinePath = /^\/v1\/machines\/([^/?#]+)$/u.exec(proof.path);
        const routing = verified.deploymentChildRouting;
        if (proof.method.toUpperCase() === 'GET' && machinePath) {
            let machineId: string;
            try { machineId = decodeURIComponent(machinePath[1]); } catch { return refuse('deployment_child_machine_path'); }
            if (proof.body !== undefined || encodeURIComponent(machineId) !== machinePath[1]
                || proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, { id: machineId })) return refuse('deployment_child_machine_request');
            if (!verified.deploymentChildAdmission) return refuse('deployment_child_machine_admission');
            deploymentChildMachineRead = await readDeploymentChildMachineReadInTx(db, verified.deploymentChildAdmission, machineId,
                { authenticationAuthority: verified.effectiveAuthority, authenticationEvidence: verified.principal.authenticationEvidence },
                proof.deploymentChildExecution?.archiveOrigin) ?? undefined;
            if (!deploymentChildMachineRead) return refuse('deployment_child_machine_read');
        } else {
            const peerGrantTarget = readDeploymentChildPeerGrantTarget(proof);
            const archiveOrigin = proof.deploymentChildExecution?.archiveOrigin;
            if (peerGrantTarget) {
                if (!archiveOrigin || !verified.deploymentChildSigner) return refuse('deployment_child_peer_proof');
                if (!verified.deploymentChildAdmission) return refuse('deployment_child_peer_admission');
                deploymentChildMachineRead = await readDeploymentChildMachineReadInTx(db, verified.deploymentChildAdmission, peerGrantTarget,
                    { authenticationAuthority: verified.effectiveAuthority, authenticationEvidence: verified.principal.authenticationEvidence }, archiveOrigin) ?? undefined;
                if (!deploymentChildMachineRead) return refuse('deployment_child_peer_read');
            } else {
                if (archiveOrigin) return refuse('deployment_child_archive_purpose');
                const purpose = await readDeploymentChildHttpPurposeInTx(db, routing, { ...proof,
                    nativeIncumbentSource: proof.deploymentChildExecution?.nativeIncumbentSource }, verified.deploymentChildAdmission)
                    // Preparation probes and reopens its issued candidate before
                    // receipt admission. Publication owns that exact identity.
                    || routing.kind === 'prepare' && proof.method.toUpperCase() === 'GET'
                        && await isDeploymentCandidatePublicationHttpPurposeInTx(db, verified.binding, verified.effectActionId, proof);
                if (!purpose) return refuse('deployment_child_http');
                if (typeof purpose === 'object') {
                    if ('artifactContentReference' in purpose) deploymentChildArtifactRead = {
                        content: purpose.artifactContentReference, requesterAccountId: verified.binding.accountId,
                    };
                    else backupHttpPurpose = { acceptedDeploymentReceipt: { read: purpose.metadataRead } };
                }
            }
        }
    } else if (verified.binding.registryAppUpdateAdmission) {
        const environmentId = verified.effectActionId === 'deployments.environments.get'
            && isAccountActionHttpOperation('deployments.environments.get', proof)
            && await isAdmittedDeclaredDeploymentReadInScope(verified.binding, verified.effectActionId, proof)
            ? DeploymentEnvironmentGetInputV1Schema.parse(proof.routeInput).environmentId : undefined;
        const current = environmentId ? undefined
            : await readAdmittedRegistryAppUpdateScopeInTx(db, verified.binding.registryAppUpdateAdmission);
        const artifact = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
        const artifactContent = artifact === null ? undefined
            : current?.artifactContents.find(reference => encodeURIComponent(reference.contentArtifactId) === artifact[1]);
        const content = verified.effectActionId === verified.binding.actionId && isReadOnlyArtifactHttpPurpose(proof)
            && (isAccountEncryptionCurrentnessHttpRead(proof) || artifactContent !== undefined);
        if (!isAdmittedRootRelay && !readsExecutionMachine && !environmentId && !content) return refuse('deployment_registry_purpose');
        if (environmentId) registryAppUpdateRead = { environmentId };
        if (content && artifactContent) deploymentChildArtifactRead = {
            content: artifactContent, requesterAccountId: verified.binding.accountId,
        };
    } else if (verified.binding.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1
        || verified.binding.actionId === DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1) {
        if (!isAdmittedRootRelay && !readsExecutionMachine
            && await readDeploymentEnvironmentSetupHttpPurpose(db, verified.binding, verified.effectActionId, proof) !== true)
            return refuse('deployment_preparation');
    } else if (verified.binding.actionId === 'deployments.backups.restore' || isDeploymentBackupActionIdV1(verified.binding.actionId)) {
        if (!isAdmittedRootRelay && !readsExecutionMachine) {
            const purpose = await readDeploymentBackupHttpPurpose(verified, proof);
            if (!purpose) return refuse('deployment_restore_purpose');
            backupHttpPurpose = purpose;
        }
    } else if (verified.binding.actionId === 'deployments.restart') {
        // Restart consumes its native handle, not Environment, receipt or Artifact
        // content. Only transport of the exact admitted root/codec remains.
        if (!isAdmittedRootRelay && !readsExecutionMachine) return refuse('deployment_restart_purpose');
    } else if (verified.binding.actionId === DEPLOYMENT_DATA_SIZE_ACTION_ID_V1
        || verified.binding.actionId === ACTION_INVOKE_ACTION_ID_V1 && verified.binding.deploymentReadAdmission?.actionId === ACTION_INVOKE_ACTION_ID_V1) {
        if (!isAdmittedRootRelay && !readsExecutionMachine) {
            const purpose = await readDeploymentDataQueryHttpPurpose(verified, proof);
            if (!purpose) return refuse('deployment_native_read_purpose');
            backupHttpPurpose = purpose;
        }
    } else if (verified.binding.actionId === PROJECT_READINESS_ACTION_IDS_V1[0]) {
        if (!isAdmittedRootRelay && !readsExecutionMachine) {
            const purpose = await readProjectReadinessHttpPurpose(verified, proof);
            if (!purpose) return refuse('deployment_native_read_purpose');
            backupHttpPurpose = purpose;
        }
    } else if (isDeploymentReadActionIdV1(verified.binding.actionId)) {
        const purpose = await readDeploymentNativeReadHttpPurpose(verified, proof, isAdmittedRootRelay || readsExecutionMachine);
        if (!purpose) return refuse('deployment_native_read_purpose');
        backupHttpPurpose = purpose;
    } else if (verified.signedChildPurpose.preparationRead
        && isDeploymentDomainMetadataReadActionIdV1(verified.signedChildPurpose.preparationRead.actionId)) {
        // The read owner already bound this membership transport to its admitted Home and Environment.
    } else if ((verified.binding.actionId === 'deployments.templates.instantiate' || verified.binding.actionId === 'deployments.environments.create')
        && verified.signedChildPurpose.nativeTransition) {
        // verifyCommon has already admitted this exact installed receipt continuation.
    } else if (verified.acceptedDeploymentReceipt && (isDeploymentPreparationActionIdV1(verified.binding.actionId)
        || verified.binding.deploymentPreparationAdmission?.operation === 'create')) {
        // Preparation finished when this root acquired its receipt. Continue
        // through the native HTTP purpose owner without admitting preparation again.
        const nativeEffect = verified.effectActionId === verified.binding.actionId ? 'deployments.deploy' : verified.effectActionId;
        if (!isAdmittedRootRelay && !readsExecutionMachine
            && !await isAdmittedDeclaredDeploymentReadInScope(verified.binding, verified.effectActionId, proof,
                verified.acceptedDeploymentReceipt.environmentId)
            && !isDeploymentNativeHttpPurpose({ binding: verified.binding, effectActionId: nativeEffect }, proof)) return refuse('deployment_preparation');
    } else if (isDeploymentPreparationActionIdV1(verified.binding.actionId)
        || verified.binding.deploymentPreparationAdmission?.operation === 'create') {
        const authentication = { authenticationAuthority: verified.effectiveAuthority,
            authenticationEvidence: verified.principal.authenticationEvidence };
        const effectSpec = ActionIdSchema.safeParse(verified.effectActionId);
        // Declared sibling reads use the admitted read scope; the root's own
        // preparation reads (such as Source defaults) stay with the preparation owner.
        const declaredRead = verified.effectActionId !== verified.binding.actionId
            && effectSpec.success && getActionSpec(effectSpec.data).sideEffectClass === 'read';
        // Mint owns preparation authority. This exact signed relay retains its
        // admitted input; it does not acquire Source, Machine or Environment access again.
        const admitted = isAdmittedRootRelay ? verified.binding.deploymentPreparationAdmission !== undefined
            : declaredRead ? await isAdmittedDeclaredDeploymentReadInScope(verified.binding, verified.effectActionId, proof)
            : await isDeploymentPreparationHttpPurposeInTx(db, verified.binding, verified.effectActionId, proof, authentication,
                isReadOnlyArtifactHttpPurpose, (_nativeProof, readActionId) => readActionId
                    ? isAccountActionHttpOperation(readActionId, proof)
                    : isDeploymentNativeHttpPurpose(verified, proof)
                    || verified.signedChildPurpose.sibling.deploymentRead
                        && isAccountActionHttpOperation(verified.effectActionId, proof));
        if (!admitted) return refuse('deployment_preparation');
    } else if (readsExecutionMachine) {
        // Native Machine and Session RPC read the exact execution Machine's content codec
        // before delivery. This is not Account read authority or a family grant.
    } else if (isSessionSectionActionIdV1(verified.binding.actionId)
        || isSessionSectionActionIdV1(verified.effectActionId)
        || verified.signedChildPurpose.sibling.sectionArchive
        || verified.signedChildPurpose.sibling.stopChild) {
        if (!await isSessionSectionHttpPurpose(verified, proof)) return refuse('session_section_purpose');
    } else if (verified.signedChildPurpose.reviewedManagedAcquirePurpose) {
        // The common signed-child owner binds new admission, then consumes the
        // retained creation's root/input/controller correspondence. The route
        // owns current submission and settlement; preset access is not re-run.
    } else if (verified.binding.actionId === 'workflow.trigger.run_now') {
        const match = /^\/v3\/automations\/([^/]+)\/run-now$/u.exec(proof.path);
        if (proof.method.toUpperCase() !== 'POST' || proof.body !== undefined || !match
            || verified.effectActionId !== verified.binding.actionId
            || proof.idempotencyKey !== verified.binding.idempotencyKey) return refuse('automation_run_now_request');
        let automationId: string;
        try { automationId = decodeURIComponent(match[1]!); } catch { return refuse('automation_run_now_request'); }
        if (verified.binding.automationId !== undefined && verified.binding.automationId !== automationId) return refuse('automation_run_now_target');
        if ('grant' in verified.principal && !evaluateApiTokenGrantV1({ grant: verified.principal.grant,
            actionId: verified.binding.actionId, automationId, target: verified.target,
            targetMachineId: verified.binding.machineId }).ok) return refuse('automation_run_now_grant');
    } else if (verified.binding.actionId.startsWith('workflow.run.')) {
        if (!isWorkflowRunActionHttpPurpose(verified, proof)) return refuse('workflow_run_purpose');
        // Direct and Session-origin Runs use the same requester storage port.
        // Automation workers retain their separate installed-publisher path.
    } else if (verified.binding.actionId === 'discussion.candidates.list') {
        // Keep this composed read out of generic read-root Session admission.
        // Native directory/roster routes still own current actor and resource access.
        if (!isDiscussionCandidateReadHttpPurpose(verified, proof, snapshotBatch)) return refuse('discussion_candidate_purpose');
    } else if (isSessionStateFieldActionHttpPurpose(verified, proof) || isSessionStopRetirementHttpPurpose(verified, proof)) {
        // The existing Session routes retain actor access, tuple CAS and publisher policy.
    } else if ((subtreeObservationHttpPurpose = await isInstalledSessionSubtreeObservationHttpPurpose(verified, proof, snapshotBatch)) !== null) {
        if (!subtreeObservationHttpPurpose) return refuse('session_subtree_observation_purpose');
    } else if (isSessionListHttpPurpose(verified, proof, snapshotBatch)
        || isSessionSourceKeyTransportHttpPurpose(verified, proof)
        || await isInstalledSessionLifecycleHttpPurpose(verified, proof)) {
        // Original-root observations and lifecycle operands (including Archive's
        // named Stop phase) retain signature, currentness and ordinary route access.
    } else if (!verified.binding.actionId.startsWith('follow.')
        && (rootSpec?.originalExecution?.accountEncryptionCurrentness === true
            || rootSpec?.executionPlacement === 'session' || verified.binding.sessionActionOrigin
            || isScmDiffSummaryRunAction(verified.binding.actionId))
        && (verified.effectActionId === verified.binding.actionId
            || verified.signedChildPurpose.sibling.archiveStop)
        && isAccountEncryptionCurrentnessHttpRead(proof)) {
        // The Session transport must admit persisted requester Account mode
        // before opening owner metadata. verifyCommon has already rechecked
        // the signed placement, Machine installation and principal.
    } else if (isAdmittedRootRelay || verified.binding.handoffPreflight) {
        // Exact root re-entry is not a family grant or a new originator.
    } else if (isManagedEnrollmentPolicyChildActionIdV1(verified.binding.actionId) && verified.binding.managedContinuation
        && verified.effectActionId === verified.binding.actionId
        && proof.method.toUpperCase() === 'POST'
        && proof.path.split('?')[0] === managedMachineActionEndpointPathV1('machines.managed.get')) {
        const request = ManagedResourceTargetV1Schema.safeParse(proof.body);
        if (!request.success || request.data.homeId !== verified.binding.serverIdentityId
            || request.data.managedId !== verified.binding.managedContinuation.managedId) return refuse('managed_enrollment_get_purpose');
    } else if (!managedRoot.success && isMachineConnectorSecretGrantHttpPurpose(verified.binding, verified.effectActionId, proof)) {
        // The signed setup scope names reviewed grants; configure retains its
        // exact-installation scope. The route owns proof and target access.
    } else if ((managedBoundSessionPurpose = await readManagedBoundSessionHttpPurpose(
        verified.binding, verified.effectActionId, proof)) !== null) {
        if (!managedBoundSessionPurpose) return refuse('managed_bound_session_setup');
    } else if (verified.binding.actionId === MACHINE_LIST_ACTION_ID_V1) {
        if (verified.effectActionId !== verified.binding.actionId || proof.method.toUpperCase() !== 'GET'
            || proof.body !== undefined || proof.path.split('?')[0] !== '/v1/machines') return refuse('verification_purpose');
    } else if (verified.binding.actionId === MACHINE_REPLACEMENT_SET_ACTION_ID_V1
        || verified.binding.actionId === MACHINE_REPLACEMENT_CLEAR_ACTION_ID_V1
        || verified.binding.actionId === MACHINE_REMOVE_ACTION_ID_V1) {
        const transport = getActionSpec(verified.binding.actionId).serverTransport;
        const target = verified.binding.target;
        const method = verified.binding.actionId === MACHINE_REMOVE_ACTION_ID_V1 ? 'POST' : transport?.method;
        const path = verified.binding.actionId === MACHINE_REMOVE_ACTION_ID_V1
            ? '/v1/machines/:machineId/revoke' : transport?.path;
        if (verified.effectActionId !== verified.binding.actionId || target.kind !== 'machine'
            || proof.method.toUpperCase() !== method
            || proof.path !== path?.replace(':machineId', encodeURIComponent(target.machineId))) return refuse('verification_purpose');
    } else if (verified.binding.actionId === WIDGET_CATALOG_LIST_ACTION_ID_V1
        && verified.effectActionId === verified.binding.actionId
        && proof.method.toUpperCase() === 'POST'
        && proof.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']
        && PluginAvailabilityMaterializationsReadActionInputV1Schema.safeParse(proof.body).success) {
        // Materializations is a POST read and remains outside the GET read-root rule.
    } else if (verified.binding.actionId === EXTERNAL_SESSION_CANDIDATES_LIST_ACTION_ID_V1) {
        const lookup = proof.method.toUpperCase() === 'POST' && proof.path === '/v2/sessions/lookup-by-tags'
            ? SessionLookupByTagsRequestV2Schema.safeParse(proof.body) : null;
        if (verified.effectActionId !== verified.binding.actionId
            || !isAccountEncryptionCurrentnessHttpRead(proof) && !(lookup?.success && lookup.data.matchExternalIdentity === true)) return refuse('verification_purpose');
    } else if (isMachineRebootHttpPurpose(verified.binding, verified.effectActionId, proof)) {
        // The native deployment read route owns requester access to each reference.
    } else if (managedRoot.success && !admittedReadRootRequesterGet) {
        const path = proof.path.split('?')[0];
        const method = proof.method.toUpperCase();
        const referencePurpose = isManagedReferenceCensusActionIdV1(verified.binding.actionId)
            && verified.effectActionId === verified.binding.actionId
            && method === 'POST' && path === machinePoolActionEndpointPathV1('machines.pools.list')
            && MachinePoolListInputV1Schema.safeParse(proof.body).success;
        const recovery = isExternalActionManagedResourceAction(verified.binding.actionId) ? verified.binding.managedAdmission : undefined;
        const parsedControl = isManagedControlAdmissionActionIdV1(verified.binding.actionId)
            ? ExternalActionManagedControlAdmissionV1Schema.safeParse(verified.binding.managedAdmission) : undefined;
        const control = parsedControl?.success ? parsedControl.data : undefined;
        const body = proof.body !== null && typeof proof.body === 'object' && !Array.isArray(proof.body)
            ? proof.body as Readonly<Record<string, unknown>> : null;
        const continuation = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(proof.body);
        const childManagedId = continuation.success ? continuation.data.managedContinuation?.managedId : undefined;
        if (control && !referencePurpose) {
            const admittedControl = method === 'POST' && path === '/v1/machines/managed/controller/admit-control';
            if (admittedControl ? body?.action !== control.actionId || body.requestId !== verified.binding.requestId
                || !sameManagedInput(body.input, control.input)
                : method === 'GET' ? false : body?.homeId !== control.input.homeId || body.managedId !== control.input.managedId) return refuse('managed_control_purpose');
        }
        if (managedRoot.data === 'machines.managed.acquire') {
            if (method === 'POST' && path === '/v1/machines/managed/controller/admit') {
                // Admission creates the row; its canonical route validates the
                // requestId, compute projection and installed controller before spend.
            } else {
                const row = await readExternalActionManagedAcquireResourceInTx(db, verified.binding);
                if (!row || !(body?.homeId === row.homeId && body.managedId === row.id
                    || childManagedId === row.id)) return refuse('managed_acquire_resource');
            }
        }
        if (recovery) {
            // A creator recovery root is not a controller-wide read/effect
            // grant, even when the installed custodian signs the request.
            if (body?.homeId !== recovery.input.homeId || body.managedId !== recovery.input.managedId) {
                if (childManagedId !== recovery.input.managedId) return refuse('managed_recovery_target');
            }
        }
        // The managed controller namespace is the incumbent native-effect
        // owner. Its handlers additionally verify their exact named effect.
        const controllerPurpose = method === 'POST' && /^\/v1\/machines\/managed\/controller\/[^/]+$/u.test(path);
        const readPurpose = method === 'POST' && path === managedMachineActionEndpointPathV1('machines.managed.get');
        const directPurpose = method === 'POST'
            && ['machines.managed.list', 'machines.managed.get', 'machines.managed.birth.get', 'machines.managed.cancel', 'machines.managed.setup.skip'].includes(managedRoot.data)
            && path === managedMachineActionEndpointPathV1(managedRoot.data);
        // A retained controller may execute only the creator's reviewed revision.
        if (directPurpose && isManagedCreationMutationActionIdV1(managedRoot.data)
            && (!recovery || !sameManagedInput(body, recovery.input))) return refuse('managed_direct_revision');
        const childPurpose = isManagedCreationChildHttpPurpose(verified, proof);
        const setupPurpose = method === 'POST' && (managedRoot.data === 'machines.setup.apply'
            && ['/v1/machines/setup/resolve', '/v1/machines/setup/report'].includes(path)
            || managedRoot.data === 'machines.setup.plan' && path === '/v1/machines/setup/resolve');
        const boundSetup = method === 'POST' && path === '/v1/machines/setup/report'
            && getManagedBoundSetupReportActionIdsV1().some(action => action === managedRoot.data)
            ? MachineSetupReportInputV1Schema.safeParse(proof.body) : undefined;
        // Acquisition/recovery above already bound this report to its exact
        // retained resource. Only that root's controller installation can run Setup.
        const boundSetupPurpose = boundSetup?.success === true && 'target' in boundSetup.data
            && boundSetup.data.homeId === verified.binding.serverIdentityId
            && boundSetup.data.target.controller.machineId === verified.binding.machineId
            && boundSetup.data.target.controller.installationId === verified.binding.installationId;
        // Combined Setup uses one finite purpose for Run storage and selected
        // receiver installation publications, including plans without apps.
        const setupWorkflowPurpose = isMachineSetupCombinedActionIdV1(managedRoot.data)
            ? readReviewedMachineSetupHttpPurpose(verified, proof) : null;
        setupMachineReadId = setupWorkflowPurpose?.machineId;
        const setupHostReviewPurpose = (method === 'GET' && proof.body === undefined && path === '/v1/machines'
            || isAccountEncryptionCurrentnessHttpRead(proof))
            && (managedRoot.data === 'machines.setup.plan' || managedRoot.data === 'machines.setup.apply')
            && verified.effectActionId === managedRoot.data;
        const setupAppReadPurpose = deploymentPreparationOperationForActionV1(managedRoot.data) === 'setup'
            && await isDeploymentPreparationHttpPurposeInTx(db, verified.binding, verified.effectActionId, proof,
                { authenticationAuthority: verified.effectiveAuthority, authenticationEvidence: verified.principal.authenticationEvidence },
                isReadOnlyArtifactHttpPurpose);
        const connectorGrantReadPurpose = isMachineConnectorSecretGrantHttpPurpose(
            verified.binding, verified.effectActionId, proof);
        const guestPath = method === 'GET' ? /^\/v1\/machines\/([^/]+)$/u.exec(path) : null;
        const guestPurpose = guestPath && await readCurrentManagedGuestActivityInTx(db, verified.binding, guestPath[1]);
        if (!referencePurpose && !controllerPurpose && !readPurpose && !directPurpose && !childPurpose && !guestPurpose && !setupPurpose && !boundSetupPurpose
            && !setupHostReviewPurpose && !setupWorkflowPurpose && !setupAppReadPurpose && !connectorGrantReadPurpose) return refuse('managed_machine_purpose');
        if (guestPurpose) managedGuestActivity = guestPurpose;
    } else if (rootMachineAction.success || effectMachineAction.success) {
        if (!rootMachineAction.success || !effectMachineAction.success
            || rootMachineAction.data !== effectMachineAction.data) return refuse('machine_access_effect');
        const path = proof.path.split('?')[0];
        const method = proof.method.toUpperCase();
        const preparesKeys = rootMachineAction.data === 'machines.access.grant.set'
            || rootMachineAction.data === 'machines.access.prepareKeys';
        const keyPreparationPath = /^\/v1\/machines\/[^/]+\/data-key-envelopes$/u.test(path);
        // Existing C40 routes own original-custodian conversion; Machine
        // audience routes independently own current Manage.
        const custodianPreparationPath = preparesKeys && (
            method === 'GET' && (path === '/v1/account/encryption' || /^\/v1\/machines\/[^/]+(?:\/content-key\/transition)?$/u.test(path))
            || method === 'POST' && /^\/v1\/machines\/[^/]+\/content-key\/transition$/u.test(path)
        );
        if (keyPreparationPath) {
            if (!preparesKeys || (method !== 'GET' && method !== 'PATCH')) return refuse('machine_access_key_preparation');
        } else if (!custodianPreparationPath) {
            const transport = getActionSpec(rootMachineAction.data).serverTransport;
            if (!transport || method !== transport.method
                || !/^\/v1\/machines\/[^/]+\/access$/u.test(path)) return refuse('machine_access_transport');
        }
    } else if (isProjectAccountMetadataHttpPurpose(verified, proof)) {
        // The installed signature spends the unchanged root as its original
        // requester, not the daemon's ambient bearer or a new Account grant.
    } else if (isOriginalAccountProjectAction(verified.binding.actionId)) {
        const actionId = verified.binding.actionId;
        const path = proof.path.split('?')[0];
        if (verified.effectActionId !== actionId) return refuse('verification_purpose');
        const readsSource = actionId === 'projects.open' && proof.method.toUpperCase() === 'GET'
            && /^\/v1\/projects\/sources\/[^/]+$/u.test(path)
            && new URL(proof.path, 'http://home.invalid').searchParams.get('serverId') === verified.binding.serverIdentityId;
        const readsTrust = path === `${PROJECT_TRUST_ROUTE_V1}/read` || path === `${PROJECT_TRUST_ROUTE_V1}/list`;
        const opensProjectRows = actionId === 'projects.open'
            && [`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`, `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`].includes(path);
        const revocation = actionId === 'projects.trust.revoke' && path === `${PROJECT_TRUST_ROUTE_V1}/mutate`
            ? ProjectTrustMutationRequestV1Schema.safeParse(proof.body) : null;
        const revokesTrust = revocation?.success && revocation.data.content === null;
        if (!readsSource && (proof.method.toUpperCase() !== 'POST' || !readsTrust && !opensProjectRows && !revokesTrust)) return refuse('verification_purpose');
    } else if (isOriginalAccountHandoffAction(verified.binding.actionId)) {
        const path = proof.path.split('?')[0];
        const child = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(proof.body);
        if (verified.binding.actionId !== 'session.handoff' || !verified.binding.handoffAdmission
            || verified.binding.handoffPreflight
            || proof.method.toUpperCase() !== 'POST' || !child.success
            || !(child.data.handoffContinuation && readHandoffContinuationIssuanceAction(path) !== null
                || child.data.handoffPreflight && path === bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'))) return refuse('verification_purpose');
    } else if (verified.binding.actionId === 'session.agent.transition' || verified.binding.actionId === 'session.continuation.inspect') {
        if (!await isSessionAgentTransitionHttpPurpose(verified, proof)) return refuse('verification_purpose');
    } else if (nativePurpose === 'quota_read') {
        if (verified.effectActionId !== verified.binding.actionId || !isQuotaReadHttpPurpose(proof)) return refuse('verification_purpose');
    } else if (verified.binding.actionId === 'agents.models.list') {
        // Automatic Summary models consume the requester's current default-auth
        // purposes row. Admit only that row and Account-mode currentness under
        // this same root; retained Settings and source maintenance are private.
        if (verified.effectActionId !== verified.binding.actionId
            || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined
            || !['/v1/account/encryption/currentness',
                `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`].includes(proof.path)) return refuse('verification_purpose');
    } else if (verified.binding.actionId === 'scm.diffSummary.reviewed.mark'
        || verified.binding.actionId === 'scm.diffSummary.reviewed.unmark'
        || verified.binding.actionId === 'scm.diffSummary.result.delete'
        || verified.binding.actionId === 'scm.diffSummary.result.clear') {
        // A collaborator cannot borrow the custodian's Account material. The
        // daemon comparison owner validates exact occurrences before this CAS;
        // the Home keeps mode admission and Account isolation authoritative.
        if (verified.effectActionId !== verified.binding.actionId
            || verified.binding.accountId !== verified.binding.custodianAccountId
            || !isScmReviewedMarksHttpPurpose(proof)) return refuse('verification_purpose');
    } else if (verified.binding.actionId === MACHINE_RESOURCES_OUTCOMES_READ_ACTION_ID_V1) {
        if (verified.effectActionId !== verified.binding.actionId
            || !isMachineOutcomeSummaryHttpPurpose(proof)) return refuse('verification_purpose');
    } else if (nativePurpose === 'session_board_write') {
        const target = verified.binding.target;
        const origin = verified.binding.sessionActionOrigin;
        if (verified.effectActionId !== verified.binding.actionId || target.kind !== 'session'
            || !origin || origin.caller.sessionId !== target.sessionId) return refuse('verification_purpose');
        const url = new URL(proof.path, 'http://home.invalid');
        const sessionPath = `/v2/sessions/${encodeURIComponent(target.sessionId)}`;
        const method = proof.method.toUpperCase();
        const mutation = method === 'PUT' && url.pathname === `${sessionPath}/board` && url.search === ''
            ? SessionBoardMutationV1Schema.safeParse(proof.body) : null;
        const query = Object.fromEntries(url.searchParams);
        const address = method === 'GET' && proof.body === undefined && url.pathname === `${sessionPath}/system-records/record`
            && Object.keys(query).length === Array.from(url.searchParams).length
            ? SessionSystemRecordAddressSchema.safeParse(query) : null;
        const readsSurface = address?.success && address.data.owner === 'host' && address.data.namespace === 'surface'
            && (address.data.kind === 'item.v1' || address.data.kind === 'layout.v1' && address.data.localId === 'layout');
        const readsSession = method === 'GET' && proof.body === undefined && url.pathname === sessionPath
            && (url.search === '' || url.search === '?accessProjectionVersion=1');
        if (!readsSession && !readsSurface && !(mutation?.success && mutation.data.operation === 'upsert_item')) return refuse('verification_purpose');
    } else if (nativePurpose === 'pending_reset_start') {
        const admission = verified.binding.pendingResetStartAdmission;
        const purpose = readExternalActionPendingResetStartPurpose({ actionId: verified.effectActionId,
            method: proof.method, path: proof.path, body: proof.body });
        const preparesReset = admission && isExternalActionPendingResetStartReadPurpose({ method: proof.method,
            path: proof.path, body: proof.body, admission });
        if (verified.effectActionId !== verified.binding.actionId
            || !preparesReset && (!purpose || (admission ? !purpose.reset || !sameManagedInput(projectExternalActionPendingResetStartAdmissionV1(purpose), admission)
                : verified.binding.target.kind !== 'session' || purpose.sessionId !== verified.binding.target.sessionId))) return refuse('verification_purpose');
    } else if (verified.binding.actionId === 'teams.credentials.usage.export') {
        // The installed executor derives this consumed read from the admitted
        // export input. Home retains only its envelope digest, not the opened
        // query: it cannot independently reconstruct parent/child input equality.
        // The native signature binds the read bytes; the existing route still
        // owns current actor, Team and resource authorization.
        if (!verified.signedChildPurpose.sibling.teamUsage
            || !isAccountActionHttpOperation(verified.effectActionId, proof)) return refuse('verification_purpose');
    } else if (isSessionFollowActionIdV1(verified.binding.actionId) && verified.binding.actionId.startsWith('follow.')) {
        // A finite Follow root cannot fall through to generic Session read
        // admission or spend a sibling Follow subaction/private census.
        if (verified.effectActionId !== verified.binding.actionId
            || !isAccountActionHttpOperation(verified.effectActionId, proof)) return refuse('verification_purpose');
    } else if (templateHttpPurpose !== null) {
        if (!templateHttpPurpose) return refuse('verification_purpose');
    } else if (signedLinkHttpPurpose !== null) {
        if (verified.effectActionId !== verified.binding.actionId
            || !(signedLinkHttpPurpose || verified.binding.actionId !== 'artifact.public_link.join'
                && isReadOnlyArtifactHttpPurpose(proof))) return refuse('verification_purpose');
    } else if (verified.binding.actionId === 'artifact.update' && verified.effectActionId === 'artifact.update'
        && isArtifactJsonUpdateHttpPurpose(proof)) {
        // The signed bytes retain approval authority; Artifact routes retain access and revision fencing.
    } else if (isSessionTargetPreparationHttpPurpose(verified, proof, snapshotBatch)) {
        // Specialized roots above retain their narrower native-purpose contract.
        // General Session operands prepare only the signed selector read phases.
    } else if (verified.binding.actionId === 'session.targets.resolve') {
        // Inspection has no final Session effect. A non-preparation read must
        // not borrow the generic read-root admission below (for example messages).
        return refuse('verification_purpose');
    } else if (verified.effectActionId === verified.binding.actionId
        && proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated') {
        // Shared transport discovery runs only after each specialized native
        // purpose has enforced its own narrower phase contract.
    } else if (await isAdmittedDeclaredDeploymentReadInScope(verified.binding, verified.effectActionId, proof)) {
        // ActionSpec transport and the one admitted deployment scope own this
        // read; no per-purpose table entry is needed.
    } else if (await isContributedRootEnvironmentRead(verified, proof)) {
        // Environment and Artifact routes retain the requester's access; this opens no content custody.
    } else if (admittedReadRootRequesterGet) {
        // Every route retains the requester's own access; a read root gains no mutation.
    } else if ((accountHttpPurpose = await isAccountActionHttpPurpose(verified, { ...proof,
        onRefusal: phase => { accountHttpRefusal = phase; } }, snapshotBatch)) !== null) {
        // A specialized refusal is terminal before generic Session reads.
        if (!accountHttpPurpose) return refuse(accountHttpRefusal ?? 'verification_purpose');
    } else if (!snapshotBatch && proof.sessionRouteTarget
        && (proof.method.toUpperCase() === 'GET' && proof.body === undefined
            || proof.sessionRouteTarget.actionId !== undefined
                && (proof.sessionRouteTarget.actionId === verified.effectActionId
                    || getActionSpec(proof.sessionRouteTarget.actionId).sideEffectClass === 'read'))
        && (verified.target.kind === 'session'
            && proof.sessionRouteTarget.sessionId === verified.target.sessionId
            && (rootSpec?.executionPlacement === 'session' && verified.effectActionId === verified.binding.actionId
                || !('authentication' in verified.binding))
            || verified.effectActionId === verified.binding.actionId && (rootSpec?.sideEffectClass === 'read'
                    || verified.binding.actionId === 'action.invoke'
                    || isScmDiffSummaryRunAction(verified.binding.actionId)
                        && !verified.binding.sessionActionOrigin && !verified.binding.sessionActionSource
                        && proof.sessionRouteTarget.actionId === 'session.transcript.get'
                    || verified.binding.sessionActionOrigin
                        && proof.sessionRouteTarget.sessionId === verified.binding.sessionActionOrigin.caller.sessionId)
                && verified.binding.target.kind === 'machine' && verified.target.kind === 'machine'
                && proof.method.toUpperCase() === 'GET' && proof.body === undefined)) {
        // The HTTP auth adapter uses the same route operation/selector owner
        // as direct Session admission. Read and installed contributed roots retain domain access checks;
        // SCM analysis also reads accessible Session evidence before admitting its Run.
        // Other mutations may prepare only the source Session the runner already reads.
        // Mutations still declare this root's actual effect on its exact Session.
    } else {
        const path = proof.path.split('?')[0];
        const childPurpose = verified.binding.actionId === 'session.spawn_new' && verified.binding.managedContinuation
            && proof.method.toUpperCase() === 'POST' && path === '/v1/sessions';
        if (!childPurpose) return refuse('verification_purpose');
    }
    // The qualified setup identity was admitted against its root's exact read
    // purpose above; the built-in credential catalog retains its root ceiling.
    const effect = parseExternalActionEffectAction(verified.binding,
        verified.deploymentReviewedSetupRead ? verified.binding.actionId : verified.effectActionId);
    const credentialAction = reviewedMachineSetupChild ? effect
        : verified.signedChildPurpose.usesRootCredential
            || verified.binding.actionId === 'template.instantiate' && verified.reviewedChildAdmission !== undefined
            ? parseExternalActionEffectAction(verified.binding, verified.binding.actionId)
        : verified.signedChildPurpose.usesPublicRootCredential ? PublicActionIdSchema.safeParse(verified.binding.actionId)
        : verified.binding.handoffContinuation
            ? PublicActionIdSchema.safeParse(readExternalActionCredentialActionId(verified.binding)) : effect;
    // All root-credential paths use their admitted root ceiling, including qualified
    // effects absent from the built-in catalog. The signed-child purpose above
    // must pin the effect and HTTP route before selecting that ceiling.
    if (!credentialAction.success || !resolveCredentialActionAdmissionV1({
        spec: getActionSpec(credentialAction.data),
        authority: verified.effectiveAuthority, grant: 'grant' in verified.binding ? verified.binding.grant : null,
        // Codec preparation retains the admitted Session proposal; it cannot
        // confer the human authority required by the actual mutation route.
        surface: isDiscussionActionHttpPreparation(verified, proof)
            ? readExternalActionSessionProposalSurface(verified.binding) : undefined }).ok) return refuse('credential_action_admission');
    if (setupMachineReadId) {
        const admitted = await readAdmittedExternalActionMachineInTx(db, verified.binding, setupMachineReadId,
            setupMachineReadId === verified.binding.machineId ? verified.binding.installationId : undefined);
        if (!admitted) return refuse('deployment_child_machine_read');
        const { kind: _kind, ...codecAdmission } = admitted;
        deploymentChildMachineRead = { machineId: admitted.machineId, installationId: admitted.installationId,
            actorAccountId: admitted.actorAccountId,
            codecAdmission: { ...codecAdmission, role: verified.binding.admittedMachineRole ?? admitted.role } };
    }
    const { signedChildPurpose: _signedChildPurpose, ...publicVerified } = verified;
    const result = { ...publicVerified, ...(deploymentChildMachineRead ? { deploymentChildMachineRead } : {}),
        ...(registryAppUpdateRead ? { registryAppUpdateRead } : {}),
        ...(deploymentChildArtifactRead ? { deploymentChildArtifactRead } : {}), ...backupHttpPurpose };
    return snapshotBatch ? { ...result, sessionSnapshotBatchAdmitted: true,
        ...(managedGuestActivity ? { managedGuestActivity } : {}) }
        : managedGuestActivity ? { ...result, managedGuestActivity } : result;
}

function matchesExternalActionAuthorizationBinding(binding: ExternalActionExecutionAuthorizationBindingV1,
    supplied: ExternalActionExecutionAuthorizationBindingV1): boolean {
    return sameManagedInput(binding, supplied);
}

/** Publication spends the original admission; the installed publisher cannot choose another recipient. */
export async function verifyExternalActionMachinePublicationRequester(input: Readonly<{
    authorizationToken: string;
    custodianAccountId: string;
    machineId: string;
    installationId: string;
    requestId?: string;
}>): Promise<string | null> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(input.authorizationToken);
    if (!binding
        || binding.serverIdentityId !== await initializeServerIdentityCache()
        || binding.custodianAccountId !== input.custodianAccountId
        || binding.machineId !== input.machineId || binding.installationId !== input.installationId
        || input.requestId !== undefined && binding.requestId !== input.requestId) return null;
    if (!await readAdmittedExternalActionMachineInTx(db, binding, input.machineId, input.installationId)) return null;
    return binding.accountId;
}

/** The installed writer proves transport; only this issuer/currentness owner proves the retained handoff root. */
export async function verifyWorkspaceSyncHandoffSourceAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1,
    routing: WorkspaceSyncSourceRoutingV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(authorization.token);
    const context = routing.sourceContext;
    const claimed = context?.machineAdmission;
    if (!binding || !matchesExternalActionAuthorizationBinding(binding, authorization.binding)
        || binding.actionId !== 'session.handoff' || binding.handoffContinuation || binding.handoffPreflight || !binding.handoffAdmission
        || routing.originalActionEnvelope || !context || !claimed
        || binding.serverIdentityId !== await initializeServerIdentityCache()
        || routing.accountServerId !== binding.serverIdentityId
        || routing.operationId !== binding.requestId
        || routing.sourceMachineId !== binding.handoffAdmission.sourceMachineId
        || routing.sourceSessionId !== binding.handoffAdmission.sessionId
        || binding.machineId !== routing.sourceMachineId
        || binding.installationId !== binding.handoffAdmission.sourceInstallationId
        || claimed.machineId !== binding.machineId || claimed.installationId !== binding.installationId
        || claimed.actorAccountId !== binding.accountId || claimed.custodianAccountId !== binding.custodianAccountId
        || !sameManagedInput(context.sessionActionOrigin, binding.sessionActionOrigin)
        || ('grant' in binding && !sameManagedInput(context.callerInputConstraints,
            { models: binding.grant.models, permissionModes: binding.grant.permissionModes }))) return null;
    return readCurrentWorkspaceSyncSourceAuthorization(binding, routing, resolveCurrentSessionMachine);
}

/** Project and handoff retain their admission; normal writes use current Machine admission. */
async function readCurrentWorkspaceSyncSourceAuthorization(binding: ExternalActionExecutionAuthorizationBindingV1,
    routing: WorkspaceSyncSourceRoutingV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine']): Promise<VerifiedExternalActionExecutionRequest | null> {
    const context = routing.sourceContext;
    const claimed = context?.machineAdmission;
    const action = PublicActionIdSchema.safeParse(binding.actionId);
    if (!action.success || !context || !claimed || claimed.machineId !== routing.sourceMachineId || claimed.actorAccountId !== binding.accountId
        || !sameManagedInput(context.sessionActionOrigin, binding.sessionActionOrigin)
        || ('grant' in binding && !sameManagedInput(context.callerInputConstraints,
            { models: binding.grant.models, permissionModes: binding.grant.permissionModes }))) return null;
    const current = await verifyCurrentExternalActionPrincipal(binding);
    const principal = current && projectVerifiedExternalActionBoundPrincipal(binding, current);
    const relationshipWrite = isWorkspaceSyncRelationshipWriteActionId(binding.actionId);
    if (!principal || narrowCredentialAuthority(principal.authority, context.callerAuthority) !== context.callerAuthority
        || !relationshipWrite && !await hasCurrentExecutionMachineAdmission(binding)
        || !binding.handoffAdmission && !resolveCredentialActionAdmissionV1({ spec: getActionSpec(action.data), authority: context.callerAuthority,
            grant: 'grant' in binding ? binding.grant : null }).ok) return null;
    if (binding.sessionActionOrigin && ((context.callerPermissionMode != null
        && context.callerPermissionMode !== binding.sessionActionOrigin.callerPermissionMode)
        || (context.causalPermissionAuthority != null
            && !sameManagedInput(context.causalPermissionAuthority, binding.sessionActionOrigin.causalPermissionAuthority))
        || context.workspaceWrites !== binding.sessionActionOrigin.workspaceWrites)) return null;
    const projectSource = !binding.handoffAdmission && binding.workspaceSyncAdmission
        ? readWorkspaceSyncSourceAdmissionV1(binding, { serverId: routing.accountServerId,
            relationshipId: binding.workspaceSyncAdmission.relationshipId, machineId: routing.sourceMachineId }) : null;
    const source = binding.handoffAdmission
        ? await readAdmittedExternalActionHandoffMachineInTx(db, binding, routing.sourceMachineId, claimed)
        : projectSource ? { kind: 'admitted' as const, ...projectSource.source }
        : relationshipWrite ? await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: binding.accountId,
            machineId: binding.machineId, actionId: binding.actionId, executionBinding: binding,
            callerAuthority: context.callerAuthority, sessionActionOrigin: binding.sessionActionOrigin }) : null;
    if (!source || source.kind !== 'admitted' || (projectSource || relationshipWrite) && source.role !== claimed.role || source.custodianAccountId !== claimed.custodianAccountId
        || source.installationId !== claimed.installationId || source.encryptionMode !== claimed.encryptionMode) return null;
    if (relationshipWrite && (source.machineId !== binding.machineId || source.installationId !== binding.installationId
        || source.custodianAccountId !== binding.custodianAccountId
        || binding.admittedMachineRole === 'manage' && source.role !== 'manage')) return null;
    if (!await hasCurrentExternalActionSessionSource(binding, resolveCurrentSessionMachine)) return null;
    return { binding, principal, effectiveAuthority: context.callerAuthority, effectActionId: binding.actionId, target: binding.target };
}

/** Capture the distinct physical role once at routed ingress, never from the child's role. */
export async function resolveReceivingMachineRpcAdmission(input: Readonly<{
    actorAccountId: string; rpcMethod: string;
    receiver: Pick<SocketRpcMachineAdmissionContextV1, 'machineId' | 'installationId'>;
    admitted?: SocketRpcMachineAdmissionContextV1;
}>): Promise<SocketRpcMachineAdmissionContextV1 | undefined> {
    if (resolveMachineRpcRoutePolicy(input.rpcMethod).requesterExecutionIsolationRequired !== true) return undefined;
    let admission = input.admitted;
    if (!admission || admission.actorAccountId !== input.actorAccountId || admission.machineId !== input.receiver.machineId
        || admission.installationId !== input.receiver.installationId) {
        const current = await resolveMachineAdmission({ actorAccountId: input.actorAccountId,
            machineId: input.receiver.machineId, requiredRole: 'use' });
        if (current.kind !== 'admitted') return undefined;
        const { kind: _kind, ...context } = current;
        admission = context;
    }
    if (admission.installationId !== input.receiver.installationId) return undefined;
    return admission;
}

/** The installed source attests its resolved root; Home binds the original purpose and admission. */
export async function readCurrentWorkspaceSyncProjectSourceAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1,
    routing: WorkspaceSyncSourceRoutingV1,
    writerMachineId: string,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<Readonly<{ verified: VerifiedExternalActionExecutionRequest;
    receivingMachineAdmission?: SocketRpcMachineAdmissionContextV1;
    route: Pick<NonNullable<Awaited<ReturnType<typeof readMachineDevcontainerWorkspaceSyncRouteInTx>>>,
        'parentMachineId' | 'parentInstallationId' | 'custodianAccountId'> }> | null> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(authorization.token);
    const envelope = routing.originalActionEnvelope;
    const relationshipWrite = binding && isWorkspaceSyncRelationshipWriteActionId(binding.actionId);
    if (!binding || !matchesExternalActionAuthorizationBinding(binding, authorization.binding)
        || !relationshipWrite && !readWorkspaceSyncProjectSourceMethod(binding.actionId) || binding.handoffAdmission || binding.handoffContinuation || binding.handoffPreflight
        || routing.phase !== 'prepare' || routing.sourceSessionId !== undefined || !envelope
        || relationshipWrite && (routing.operationId !== binding.requestId || routing.sourceMachineId !== binding.machineId)
        || binding.serverIdentityId !== await initializeServerIdentityCache() || routing.accountServerId !== binding.serverIdentityId
        || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId, machineId: binding.machineId, envelope })) return null;
    const verified = await readCurrentWorkspaceSyncSourceAuthorization(binding, routing, resolveCurrentSessionMachine);
    if (!verified) return null;
    if (relationshipWrite) return { verified, route: { parentMachineId: binding.machineId,
        parentInstallationId: binding.installationId, custodianAccountId: binding.custodianAccountId } };
    if (envelope.v === 1 && !matchesWorkspaceSyncProjectSourceInput(envelope.input, binding, routing)) return null;
    const source = binding.workspaceSyncAdmission;
    if (!source) return null;
    const endpoint = source.source;
    if (endpoint.machineId === writerMachineId) return { verified,
        ...(endpoint.machineId === source.source.machineId ? { receivingMachineAdmission: source.source } : {}),
        route: { parentMachineId: endpoint.machineId, parentInstallationId: endpoint.installationId,
            custodianAccountId: source.source.custodianAccountId } };
    // Finite preparation can run at an independently shared hub. The original
    // worker attests the selected controller; its receiver proves the current
    // topology. Home independently requires requester access to this controller.
    const controller = await resolveMachineAdmission({ actorAccountId: binding.accountId,
        callerAuthority: verified.effectiveAuthority, sessionActionOrigin: binding.sessionActionOrigin,
        operationRpcMethod: RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE,
        machineId: writerMachineId, requiredRole: 'use' });
    if (controller.kind !== 'admitted' || !await hasCurrentExternalActionSessionSource(binding, resolveCurrentSessionMachine)) return null;
    const { kind: _kind, ...receivingMachineAdmission } = controller;
    return { verified, receivingMachineAdmission, route: { parentMachineId: controller.machineId,
        parentInstallationId: controller.installationId, custodianAccountId: controller.custodianAccountId } };
}

function readWorkspaceSyncProjectSourceMethod(actionId: string): string | null {
    return isProjectWorkspaceSyncOpenActionV1(actionId) ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN
        : isProjectWorkspaceSyncPreparationActionV1(actionId)
            ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN : null;
}

function matchesWorkspaceSyncProjectSourceInput(value: unknown,
    binding: ExternalActionExecutionAuthorizationBindingV1, routing: WorkspaceSyncSourceRoutingV1): boolean {
    const actionId = binding.actionId;
    if (isProjectWorkspaceSyncOpenActionV1(actionId)) {
        const input = OpenProjectInputV1Schema.safeParse(value);
        return input.success && input.data.serverId === binding.serverIdentityId && input.data.machineId === binding.machineId
            && input.data.materialization.kind === 'sync' && (input.data.source.kind === 'workspace' || input.data.source.kind === 'source')
            && input.data.source.checkout?.machineId === routing.sourceMachineId && input.data.source.checkout.rootPath === routing.sourceRootPath;
    }
    if (!isProjectWorkspaceSyncPreparationActionV1(actionId)) return false;
    if (actionId === 'projects.service.relocate') {
        const input = ProjectServiceRelocateInputV1Schema.safeParse(value);
        return input.success && input.data.workspace.serverId === binding.serverIdentityId
            && input.data.sourceMachineId === routing.sourceMachineId;
    }
    const input = actionId === 'localServices.launcher.start'
        ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(value)
        : PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(value);
    return input.success && !!input.data.workspace && input.data.workspace.serverId === binding.serverIdentityId
        && input.data.workspace.machineId === routing.sourceMachineId && input.data.workspace.rootPath === routing.sourceRootPath;
}

/** The current installed D's original packet attests verified decryption; P1 never signs as D. */
export async function verifyWorkspaceSyncProjectSourceAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1, routing: WorkspaceSyncSourceRoutingV1,
    execution: WorkspaceSyncSourceExecutionV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<Awaited<ReturnType<typeof readCurrentWorkspaceSyncProjectSourceAuthorization>>> {
    const method = readWorkspaceSyncProjectSourceMethod(authorization.binding.actionId);
    if (!method) return null;
    const suffix = `:${method}`;
    if (!execution.method.endsWith(suffix)) return null;
    const admitted = await readCurrentWorkspaceSyncProjectSourceAuthorization(authorization, routing,
        execution.method.slice(0, -suffix.length), resolveCurrentSessionMachine);
    if (!admitted) return null;
    const { binding } = admitted.verified;
    const actionId = binding.actionId;
    const envelope = routing.originalActionEnvelope;
    const packet = execution.externalActionExecution;
    if (!envelope || packet.authorization.token !== authorization.token
        || !matchesExternalActionAuthorizationBinding(binding, packet.authorization.binding)
        || packet.effectActionId !== binding.actionId || packet.installationId !== binding.installationId
        || encodeExternalActionResolvedTargetV1(packet.target) !== encodeExternalActionResolvedTargetV1(binding.target)) return null;
    // Plain decoded packets can also be checked against their canonical input.
    // For opaque transport params, the same installed D signature binds the
    // unchanged envelope and exact Source facts after D's verified decryption.
    if (typeof execution.params !== 'string') {
        if (binding.actionId === 'projects.open') {
            if (!matchesWorkspaceSyncProjectSourceInput(execution.params, binding, routing)
                || envelope.v === 1 && !sameManagedInput(envelope.input, execution.params)) return null;
        } else {
            const request = WorkspaceSyncPrepareBetweenRequestV1Schema.safeParse(execution.params);
            if (!request.success) return null;
            if (envelope.v === 1 && binding.actionId === 'projects.service.relocate') {
                const input = ProjectServiceRelocateInputV1Schema.safeParse(envelope.input);
                if (!input.success || request.data.sourceWorkspaceRefId !== input.data.workspace.refId) return null;
            }
            if (envelope.v === 1 && isProjectWorkspaceSyncPreparationActionV1(actionId)
                && actionId !== 'projects.service.relocate') {
                const input = actionId === 'localServices.launcher.start'
                    ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(envelope.input)
                    : PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(envelope.input);
                if (!input.success || !input.data.workspace || request.data.sourceWorkspaceRefId !== input.data.workspace.workspaceId) return null;
            }
        }
    }
    const rootMachine = await db.machine.findUnique({ where: { id: binding.machineId } }).then(decodeMachineStoredContent);
    if (!rootMachine?.installationPublicKey || rootMachine.installationId !== binding.installationId
        || classifyMachineAvailabilityState(rootMachine) !== 'available'
        || !verifyExternalActionMachineRpcRequestV1({ reviewedChild: packet.reviewedChild, authorizationToken: authorization.token,
            requesterAccountContext: packet.authorization.requesterAccountContext,
            effectActionId: packet.effectActionId, target: packet.target, installationId: packet.installationId,
            event: SOCKET_RPC_EVENTS.CALL, method: execution.method, requestId: execution.requestId,
            ...(execution.params === undefined ? {} : { params: execution.params }), workspaceSyncSourceRouting: routing,
            publicKey: rootMachine.installationPublicKey, signature: packet.machineSignature })) return null;
    return await hasCurrentExternalActionSessionSource(binding, resolveCurrentSessionMachine) ? admitted : null;
}

/** Reviewed cleanup spends the current SOURCE root without admitting the physical target again. */
export async function readCurrentWorkspaceSyncCopyRetirementAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1,
    routing: WorkspaceSyncSourceWriterTargetRoutingV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(authorization.token);
    if (!binding || !matchesExternalActionAuthorizationBinding(binding, authorization.binding)
        || binding.serverIdentityId !== await initializeServerIdentityCache()
        || !doesWorkspaceSyncCopyRetirementRootMatchV1(authorization, routing)
        || !await hasCurrentExternalActionSessionSource(binding, resolveCurrentSessionMachine)) return null;
    const current = await verifyCurrentExternalActionPrincipal(binding);
    const principal = current && projectVerifiedExternalActionBoundPrincipal(binding, current);
    const machine = await db.machine.findUnique({ where: { id: binding.machineId } }).then(decodeMachineStoredContent);
    const action = PublicActionIdSchema.safeParse(binding.actionId);
        if (!principal || !machine || !action.success || !await hasCurrentExecutionMachineAdmission(binding, machine)
        || !resolveCredentialActionAdmissionV1({ spec: getActionSpec(action.data), authority: principal.authority,
            grant: 'grant' in binding ? binding.grant : null }).ok) return null;
    return { binding, effectActionId: binding.actionId, target: binding.target, principal, effectiveAuthority: principal.authority };
}

/** One currentness decision for the original handoff's installed source writer and chosen target. */
export async function readCurrentWorkspaceSyncHandoffWriterTarget(
    authorization: ExternalActionExecutionAuthorizationV1,
    routing: WorkspaceSyncSourceWriterTargetRoutingV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
    targetReceiver?: Readonly<{ routing: WorkspaceSyncTargetRoutingV1; machineId?: string }>,
    sourceExecution?: WorkspaceSyncSourceExecutionV1,
): Promise<Readonly<{ verified: VerifiedExternalActionExecutionRequest;
    writer: Extract<Awaited<ReturnType<typeof resolveMachineAdmission>>, { kind: 'admitted' }>;
    target: Extract<Awaited<ReturnType<typeof resolveMachineAdmission>>, { kind: 'admitted' }>;
    physicalTarget: NonNullable<Awaited<ReturnType<typeof readMachineDevcontainerWorkspaceSyncEndpointInTx>>>;
    targetRoute?: NonNullable<Awaited<ReturnType<typeof readMachineDevcontainerWorkspaceSyncRouteInTx>>>;
    receivingMachineAdmission?: SocketRpcMachineAdmissionContextV1 }> | null> {
    if (routing.target.phase === 'release') return null;
    const project = authorization.binding.actionId === 'projects.open';
    const relationshipWrite = isWorkspaceSyncRelationshipWriteActionId(authorization.binding.actionId);
    const projectSource = project && sourceExecution
        ? await verifyWorkspaceSyncProjectSourceAuthorization(authorization, routing.source, sourceExecution, resolveCurrentSessionMachine) : null;
    const relationshipSource = relationshipWrite && !sourceExecution
        ? await readCurrentWorkspaceSyncProjectSourceAuthorization(authorization, routing.source, routing.sourceWriter.machineId,
            resolveCurrentSessionMachine) : null;
    const verified = project ? projectSource?.verified
        : relationshipWrite ? relationshipSource?.verified
        : !sourceExecution && await verifyWorkspaceSyncHandoffSourceAuthorization(authorization, routing.source, resolveCurrentSessionMachine);
    if (!verified || !relationshipWrite && (project ? verified.binding.machineId : verified.binding.handoffAdmission?.targetMachineId) !== routing.target.targetMachineId) return null;
    const originalEnvelope = routing.source.originalActionEnvelope;
    if (relationshipWrite && originalEnvelope?.v === 1) {
        const action = PublicActionIdSchema.safeParse(verified.binding.actionId);
        if (!action.success) return null;
        const input = getActionSpec(action.data).inputSchema.safeParse(originalEnvelope.input);
        if (!input.success || !input.data || typeof input.data !== 'object'
            || !('targetMachineId' in input.data) || input.data.targetMachineId !== routing.target.targetMachineId
            || !('targetPath' in input.data) || input.data.targetPath !== routing.target.targetRootPath) return null;
    }
    if (project && (originalEnvelope?.v === 1 || sourceExecution && typeof sourceExecution.params !== 'string')) {
        // A readable original Root remains authoritative even when the installed
        // SOURCE packet is sealed. V2 decryption belongs to the actual D owner.
        const input = OpenProjectInputV1Schema.safeParse(originalEnvelope?.v === 1 ? originalEnvelope.input : sourceExecution?.params);
        if (!input.success || input.data.materialization.kind !== 'sync'
            || input.data.materialization.targetPath !== routing.target.targetRootPath) return null;
    }
    const writer = await resolveMachineAdmission({ actorAccountId: routing.source.sourceContext.machineAdmission.custodianAccountId,
        machineId: routing.sourceWriter.machineId, requiredRole: 'manage' });
    if (writer.kind !== 'admitted' || writer.installationId !== routing.sourceWriter.installationId) return null;
    if (routing.sourceWriter.machineId !== routing.source.sourceMachineId) {
        const route = project ? projectSource?.route : await readMachineDevcontainerWorkspaceSyncRouteInTx(db, { accountServerId: routing.source.accountServerId,
            operation: { actorAccountId: verified.binding.accountId, callerAuthority: verified.effectiveAuthority,
                sessionActionOrigin: verified.binding.sessionActionOrigin, rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE },
            childMachineId: routing.source.sourceMachineId, childRootPath: routing.source.sourceRootPath,
            parentMachineId: writer.machineId, releaseOnly: false });
        if (!route || route.parentMachineId !== writer.machineId || route.parentInstallationId !== writer.installationId) return null;
    } else if (writer.installationId !== routing.source.sourceContext.machineAdmission.installationId) return null;
    const target = !project && !relationshipWrite ? await readAdmittedExternalActionHandoffMachineInTx(db, verified.binding, routing.target.targetMachineId,
        targetReceiver?.routing.targetContext.machineAdmission) : await resolveMachineAdmission({ actorAccountId: verified.binding.accountId,
        callerAuthority: verified.effectiveAuthority, sessionActionOrigin: verified.binding.sessionActionOrigin,
        machineId: routing.target.targetMachineId,
        ...(relationshipWrite ? { rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT }
            : { requiredRole: 'use', operationRpcMethod: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE }) });
    if (!target || target.kind !== 'admitted' || !relationshipWrite && target.installationId !== (project
        ? verified.binding.installationId : verified.binding.handoffAdmission?.targetInstallationId)) return null;
    const physicalTarget = await readMachineDevcontainerWorkspaceSyncEndpointInTx(db, { accountServerId: routing.target.accountServerId,
        machineId: target.machineId, rootPath: routing.target.targetRootPath,
        operation: { actorAccountId: verified.binding.accountId, callerAuthority: verified.effectiveAuthority,
            sessionActionOrigin: verified.binding.sessionActionOrigin, rpcMethod: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE } });
    if (!physicalTarget) return null;
    let targetRoute: NonNullable<Awaited<ReturnType<typeof readMachineDevcontainerWorkspaceSyncRouteInTx>>> | undefined;
    if (targetReceiver) {
        const { targetContext, ...phase } = targetReceiver.routing;
        const { kind: _kind, ...targetAdmission } = target;
        if (!sameManagedInput(phase, routing.target) || !sameManagedInput(targetContext.machineAdmission, targetAdmission)
            || !sameManagedInput({ ...targetContext, machineAdmission: routing.source.sourceContext.machineAdmission }, routing.source.sourceContext)) return null;
        if (targetReceiver.machineId !== undefined && physicalTarget.machineId !== targetReceiver.machineId) return null;
        if (physicalTarget.machineId !== target.machineId) targetRoute = { custodianAccountId: physicalTarget.custodianAccountId,
            parentMachineId: physicalTarget.machineId, parentInstallationId: physicalTarget.installationId };
    }
    if (!await hasCurrentExternalActionSessionSource(verified.binding, resolveCurrentSessionMachine)) return null;
    return { verified, writer, target, physicalTarget, ...(targetRoute ? { targetRoute } : {}),
        ...(projectSource?.receivingMachineAdmission ? { receivingMachineAdmission: projectSource.receivingMachineAdmission } : {}) };
}

/** Seed transport spends the same admitted source/target root; the source fence owns export effects. */
export async function readCurrentWorkspaceSyncSeedAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1, routing: WorkspaceSyncSeedRoutingV1,
    execution: WorkspaceSyncSourceExecutionV1 | undefined,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<Awaited<ReturnType<typeof readCurrentWorkspaceSyncHandoffWriterTarget>>> {
    if (authorization.binding.actionId !== 'projects.open' && !isWorkspaceSyncRelationshipWriteActionId(authorization.binding.actionId)
        || routing.target.phase !== 'prepare') return null;
    return readCurrentWorkspaceSyncHandoffWriterTarget(authorization, routing.sourceWriterTarget, resolveCurrentSessionMachine,
        { routing: routing.target }, execution);
}

export async function verifyExternalActionMachineRpcExecution(
    execution: ExternalActionMachineRpcExecutionV1,
    request: Readonly<{ method: string; requestId?: string; params?: unknown; event?: ExternalActionMachineRpcEventV1;
        /** Verification-only projection of an already source-signed child, never accepted from generic socket fields. */
        paramsPresent?: boolean; paramsDigest?: string;
        /** Host-only issuer purpose: a spawn proof never directly dispatches a credential effect. */
        nativeCredentialSpawnChildIssuance?: true;
        /** Host-only: verifyCommon has authenticated the installed data-role receiver's continuation signature. */
        admittedReadContinuation?: true;
        workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
        workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
        workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
        workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
        workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
        originalActionEnvelope?: ExternalActionRequestEnvelope;
        onRefusal?: ExternalActionExecutionRequestProof['onRefusal'];
        resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'] }>,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    if (!request.requestId) return null;
    const binding = await auth.verifyExternalActionExecutionAuthorization(execution.authorization.token);
    if (!binding || binding.serverIdentityId !== await initializeServerIdentityCache()
        || !execution.deploymentChildRouting && !execution.deploymentChildExecution
            && !await hasCurrentExternalActionSessionSource(binding, request.resolveCurrentSessionMachine)
        || !matchesExternalActionAuthorizationBinding(binding, execution.authorization.binding)
        || !isExternalActionResolvedTargetAllowedV1({ authorizedTarget: binding.target,
            resolvedTarget: execution.target, selectedMachineId: binding.machineId })) return null;

    const separator = request.method.indexOf(':');
    if (execution.managedAdmission !== undefined) {
        if (request.nativeCredentialSpawnChildIssuance !== true || binding.actionId !== 'session.spawn_new'
            || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL
            || request.paramsPresent !== undefined || request.paramsDigest !== undefined
            || execution.deploymentChildRouting || execution.deploymentChildExecution
            || request.workspaceSyncSourceRouting || request.workspaceSyncTargetRouting
            || request.workspaceSyncSourceWriterTargetRouting || request.workspaceSyncSeedRouting
            || request.workspaceSyncSourceExecution) return null;
        const current = await verifyCurrentExternalActionPrincipal(binding);
        const principal = current && projectVerifiedExternalActionBoundPrincipal(binding, current);
        if (!principal || !await hasCurrentExecutionMachineAdmission(binding)
            || !resolveCredentialActionAdmissionV1({ spec: getActionSpec(binding.actionId), authority: principal.authority,
                grant: 'grant' in binding ? binding.grant : null }).ok) return null;
        const native = await readExternalActionNativeCredentialSpawnChildInTx(db, {
            binding, execution, request: { ...request, requestId: request.requestId },
            authentication: { env: process.env, authority: principal.authority,
                authenticationEvidence: principal.authenticationEvidence },
        });
        if (!native) return null;
        return { binding, effectActionId: execution.effectActionId, target: execution.target, principal,
            effectiveAuthority: principal.authority, nativeCredentialSpawnChildAdmission: {
                machineId: native.machineId, installationId: native.installationId, custodianAccountId: native.custodianAccountId,
            } };
    }
    if (execution.deploymentChildExecution) {
        const packet = execution.deploymentChildExecution;
        const method = request.method.slice(separator + 1);
        const effect = readDeploymentArchiveRpcEffectV1(method);
        if (separator < 1 || !effect || effect !== execution.effectActionId || !packet.archiveOrigin
            || method === RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD && request.method.slice(0, separator) !== packet.archiveOrigin.holderMachineId
            || execution.deploymentChildRouting || request.paramsPresent !== undefined || request.paramsDigest !== undefined
            || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL
            || request.workspaceSyncSourceRouting || request.workspaceSyncTargetRouting || request.workspaceSyncSourceWriterTargetRouting
            || request.workspaceSyncSeedRouting || request.workspaceSyncSourceExecution
            || packet.externalActionExecution.authorization.token !== execution.authorization.token) return null;
        const source = await verifyExternalActionMachineRpcExecution(packet.externalActionExecution, {
            method: packet.method, requestId: packet.requestId, paramsPresent: packet.paramsPresent, paramsDigest: packet.paramsDigest,
            resolveCurrentSessionMachine: request.resolveCurrentSessionMachine });
        const routing = packet.externalActionExecution.deploymentChildRouting;
        if (!source || !routing || (routing.kind !== 'member' && routing.kind !== 'build')
            || routing.kind === 'member' && routing.phase === 'cleanup'
            || execution.installationId !== routing.installationId || !sameStrictJsonValue(execution.target, source.target)
            || request.originalActionEnvelope && !isExternalActionAuthorizationBoundToEnvelope(binding, {
                actionId: binding.actionId, machineId: binding.machineId, envelope: request.originalActionEnvelope })) return null;
        const receiver = await db.machine.findUnique({ where: { id: routing.machineId }, select: {
            accountId: true, installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true } });
        if (!receiver?.installationPublicKey || receiver.installationId !== routing.installationId
            || classifyMachineAvailabilityState(receiver) !== 'available'
            || !verifyExternalActionMachineRpcRequestV1({ reviewedChild: execution.reviewedChild, authorizationToken: execution.authorization.token,
                requesterAccountContext: execution.authorization.requesterAccountContext, effectActionId: execution.effectActionId,
                target: execution.target, installationId: execution.installationId, event: request.event ?? SOCKET_RPC_EVENTS.CALL,
                method: request.method, requestId: request.requestId, ...(request.params === undefined ? {} : { params: request.params }),
                deploymentChildExecution: packet, publicKey: receiver.installationPublicKey, signature: execution.machineSignature })) return null;
        // The Source grants this exact holder to the original requester. Installed
        // custody signs the finite phase, without borrowing that requester's identity.
        if (!source.deploymentChildAdmission) return null;
        const destination = await readDeploymentChildMachineReadInTx(db, source.deploymentChildAdmission, request.method.slice(0, separator), {
            authenticationAuthority: source.effectiveAuthority, authenticationEvidence: source.principal.authenticationEvidence }, packet.archiveOrigin);
        if (!destination) return null;
        return { ...source, effectActionId: effect, deploymentChildCodecAdmission: destination.codecAdmission, deploymentChildSigner: { machineId: routing.machineId,
            installationId: routing.installationId, custodianAccountId: receiver.accountId } };
    }
    if (execution.deploymentChildRouting || request.method.slice(separator + 1) === RPC_METHODS.DAEMON_DEPLOYMENT_CHILD) {
        const digestOnly = request.paramsPresent === true && request.paramsDigest !== undefined && request.params === undefined;
        const routing = DeploymentChildRoutingV1Schema.safeParse(execution.deploymentChildRouting);
        const envelope = ExternalActionRequestEnvelopeSchema.safeParse(request.originalActionEnvelope);
        const effect = deploymentChildEffectActionIdForRootV1(binding.actionId, binding.deploymentPreparationAdmission, execution.effectActionId);
        if (!routing.success || !digestOnly && !envelope.success || !(binding.deploymentChildRoot === true)
            || !digestOnly && (request.paramsPresent !== undefined || request.paramsDigest !== undefined)
            || execution.effectActionId !== effect || routing.data.actionId !== execution.effectActionId
            || request.method !== `${routing.data.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`
            || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL
            || request.workspaceSyncSourceRouting || request.workspaceSyncTargetRouting || request.workspaceSyncSourceWriterTargetRouting
            || request.workspaceSyncSeedRouting || request.workspaceSyncSourceExecution
            || execution.installationId !== binding.installationId
            || !digestOnly && envelope.success && !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId,
                machineId: binding.machineId, envelope: envelope.data })) return refuseExternalActionExecutionRequest('deployment_child_routing', { rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD });
        // Domain discovery routing contains its exact typed operand even when
        // params stay encrypted. Consume the reviewed input once for every carrier.
        if ((binding.actionId === 'deployments.environments.create' && routing.data.kind === 'domain'
            || routing.data.kind === 'domainDiscover')
            && !doesDeploymentChildInputMatchRootV1({ rootInput: undefined, rootActionId: binding.actionId,
                rootBinding: binding,
                child: routing.data, rootPreparationAdmission: binding.deploymentPreparationAdmission,
                reviewedChild: execution.reviewedChild })) return refuseExternalActionExecutionRequest('deployment_child_root_input', { rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD });
        if (!digestOnly && typeof request.params !== 'string') {
            const job = readDeploymentChildRpcV1({ deploymentChildRoot: binding.deploymentChildRoot, rootActionId: binding.actionId, effectActionId: execution.effectActionId,
                rootPreparationAdmission: binding.deploymentPreparationAdmission, reviewedChild: execution.reviewedChild,
                method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: request.params });
            if (!job || !sameStrictJsonValue(projectDeploymentChildRoutingV1(job), routing.data)) return refuseExternalActionExecutionRequest('deployment_child_routing', { rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD });
            if (envelope.success && envelope.data.v === 1 && job.kind !== 'domainDiscover'
                && (binding.actionId !== 'deployments.environments.create' || job.actionId === 'deployments.deploy')
                && !doesDeploymentChildInputMatchRootV1({ rootInput: envelope.data.v === 1 ? envelope.data.input : undefined, rootActionId: binding.actionId, child: job,
                    rootRequestId: binding.requestId,
                    rootPreparationAdmission: binding.deploymentPreparationAdmission, reviewedChild: execution.reviewedChild })) return refuseExternalActionExecutionRequest('deployment_child_root_input', { rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD });
        }
        const machine = await db.machine.findUnique({ where: { id: binding.machineId } }).then(decodeMachineStoredContent);
        // Mint owns root permission admission; this finite child proves the captured installation and exact routing.
        const principal = projectAcceptedDeploymentPrincipal(binding);
        if (!machine?.installationPublicKey || machine.installationId !== binding.installationId
            || classifyMachineAvailabilityState(machine) !== 'available' || !principal
            || !verifyExternalActionMachineRpcRequestV1({ reviewedChild: execution.reviewedChild, authorizationToken: execution.authorization.token,
                requesterAccountContext: execution.authorization.requesterAccountContext, effectActionId: execution.effectActionId,
                target: execution.target, installationId: execution.installationId, event: request.event ?? SOCKET_RPC_EVENTS.CALL,
                method: request.method, requestId: request.requestId,
                ...(digestOnly ? { paramsPresent: request.paramsPresent, paramsDigest: request.paramsDigest } : { params: request.params }),
                deploymentChildRouting: routing.data, publicKey: machine.installationPublicKey, signature: execution.machineSignature })) return refuseExternalActionExecutionRequest('deployment_child_signature', { rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD });
        let deploymentChildAdmission = await readDeploymentChildAdmissionInTx(db, binding, routing.data, {
            authenticationAuthority: principal.authority, authenticationEvidence: principal.authenticationEvidence },
        request.admittedReadContinuation);
        if (!deploymentChildAdmission || 'ok' in deploymentChildAdmission) {
            return refuseExternalActionExecutionRequest('deployment_child_admission', {
                rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, onRefusal: request.onRefusal,
            }, deploymentChildAdmission ?? undefined);
        }
        if (deploymentChildAdmission.domainJob) {
            const domainAdmission = projectAcceptedDeploymentDomainSecretLaunchAdmission(deploymentChildAdmission.domainJob,
                { machineId: binding.machineId, installationId: binding.installationId, publicKey: machine.installationPublicKey });
            if (!domainAdmission) return refuseExternalActionExecutionRequest('deployment_child_routing', { rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD });
            deploymentChildAdmission = { ...deploymentChildAdmission, domainAdmission };
        }
        const destinationCodec = deploymentChildAdmission.destinationCodecAdmission
            ?? (await readDeploymentChildMachineReadInTx(db, deploymentChildAdmission, routing.data.machineId))?.codecAdmission;
        if (!destinationCodec) return refuseExternalActionExecutionRequest('deployment_child_destination', { rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD });
        return { binding, effectActionId: execution.effectActionId, target: execution.target, principal,
            effectiveAuthority: principal.authority, deploymentChildAdmission, deploymentChildCodecAdmission: destinationCodec };
    }
    if (request.paramsPresent !== undefined || request.paramsDigest !== undefined) return null;

    const setupPlanChild = isMachineSetupPlanRpcChildV1({ rootActionId: binding.actionId,
        effectActionId: execution.effectActionId, method: request.method.slice(separator + 1) });
    const setupSetChild = readProjectSetupSetChildRpcEffectV1(binding.actionId, request.method.slice(separator + 1)) === execution.effectActionId;
    if (setupSetChild && !request.originalActionEnvelope) return null;
    const creationEffect = readSessionActionChildCreationRpcEffectV1(request.method.slice(separator + 1), binding,
        { machineId: request.method.slice(0, separator), installationId: execution.installationId }, execution.reviewedChild);
    if ((binding.actionId === 'projects.service.relocate' || creationEffect !== null
        || isSessionStopChildRootV1(binding.actionId) || setupPlanChild || setupSetChild) && request.originalActionEnvelope) {
        const envelope = ExternalActionRequestEnvelopeSchema.safeParse(request.originalActionEnvelope);
        const separator = request.method.indexOf(':');
        const machineId = request.method.slice(0, separator);
        const opinionChild = binding.actionId === 'discussion.second_opinion.start';
        const stopChild = isSessionStopChildRootV1(binding.actionId);
        const effect = stopChild ? isSessionStopChildV1({ rootActionId: binding.actionId,
            effectActionId: execution.effectActionId, method: request.method.slice(separator + 1), target: execution.target,
            params: request.params, ...(envelope.success && envelope.data.v === 1 ? { rootInput: envelope.data.input } : {}) }) ? 'session.stop' : null
            : setupPlanChild ? 'machines.setup.plan'
            : setupSetChild ? PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.inspect
            : creationEffect !== null ? creationEffect
            : readProjectServiceMoveChildEffectV1(request.method.slice(separator + 1));
        if (!envelope.success || separator < 1 || effect !== execution.effectActionId
            || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL
            || request.workspaceSyncSourceRouting || request.workspaceSyncTargetRouting || request.workspaceSyncSourceWriterTargetRouting
            || request.workspaceSyncSeedRouting || request.workspaceSyncSourceExecution
            || execution.installationId !== binding.installationId
            || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId,
                machineId: binding.machineId, envelope: envelope.data })
            || creationEffect === null && !stopChild && !setupPlanChild && !setupSetChild && envelope.data.v === 1 && readProjectServiceMoveChildMachineV1(envelope.data.input, effect) !== machineId
            || creationEffect === null && !stopChild && !setupPlanChild && !setupSetChild && envelope.data.v === 1 && typeof request.params !== 'string'
                && !isProjectServiceMoveChildInputV1(envelope.data.input, effect, machineId, request.params)) return null;
        if (setupSetChild && envelope.data.v === 1) {
            const root = ProjectSetupSetInputV1Schema.safeParse(envelope.data.input);
            const wrapper = TargetedActionRpcRequestV1Schema.safeParse(request.params);
            if (!root.success || root.data.workspace.machineId !== machineId
                || typeof request.params !== 'string' && !isProjectSetupSetChildInputV1(root.data,
                    execution.effectActionId, wrapper.success ? wrapper.data.input : request.params, binding.serverIdentityId)) return null;
        }
        if (setupPlanChild && envelope.data.v === 1 && (typeof envelope.data.input !== 'object'
            || envelope.data.input === null || !('homeId' in envelope.data.input)
            || envelope.data.input.homeId !== binding.serverIdentityId
            || typeof request.params !== 'string' && !readMachineSetupPlanChildInputV1({ rootActionId: binding.actionId,
                rootInput: envelope.data.input, machineId, input: request.params }))) return null;
        if (stopChild && (execution.target.kind !== 'session'
            || !await isExternalActionSessionTargetWithinGrant(binding, execution.target.sessionId)
            || !await hasCurrentSessionScopedMachineAccessInTx({ tx: db, accountId: binding.accountId,
                machineId, sessionId: execution.target.sessionId }))) return null;
        if (opinionChild && envelope.data.v === 1 && typeof request.params !== 'string') {
            const wrapper = TargetedActionRpcRequestV1Schema.safeParse(request.params);
            const derived = readDiscussionSecondOpinionModelChildV1(envelope.data.input, machineId,
                wrapper.success ? wrapper.data.input : request.params, request.method.slice(separator + 1));
            if (!derived) return null;
            const discussion = derived.spawn ? null : await db.discussion.findUnique({ where: {
                createdByAccountId_creationLocalId: { createdByAccountId: binding.accountId, creationLocalId: derived.root.retry.creationLocalId } }, select: { id: true } });
            const ref = derived.spawn?.discussionParticipant ?? (discussion ? { discussionId: discussion.id,
                participantSlotId: derived.reviewer.participantSlotId! } : null);
            if (!ref) return null;
            const slot = await db.discussionParticipant.findUnique({ where: { discussionId_participantSlotId: ref },
                include: { discussion: { select: { ownerAccountId: true, creationLocalId: true, archivedAt: true } } } });
            if (!slot || slot.removedAt || slot.answerPolicy !== 'when_addressed'
                || slot.discussion.archivedAt || slot.discussion.ownerAccountId !== binding.accountId
                || slot.discussion.creationLocalId !== derived.root.retry.creationLocalId
                || !sameStrictJsonValue(slot.modelLaunch, derived.launch)) return null;
        }
        const machine = await db.machine.findUnique({ where: { id: binding.machineId } }).then(decodeMachineStoredContent);
        const destination = await resolveMachineAdmission({ actorAccountId: binding.accountId, machineId, requiredRole: setupPlanChild ? 'manage' : 'use' });
        const current = await verifyCurrentExternalActionPrincipal(binding);
        const principal = current && projectVerifiedExternalActionBoundPrincipal(binding, current);
        const bindingAction = ActionIdSchema.safeParse(binding.actionId);
        if (!machine?.installationPublicKey || machine.installationId !== binding.installationId
            || classifyMachineAvailabilityState(machine) !== 'available' || destination.kind !== 'admitted'
            || !principal || !await hasCurrentExecutionMachineAdmission(binding) || !bindingAction.success
            || !resolveCredentialActionAdmissionV1({ spec: getActionSpec(bindingAction.data), authority: principal.authority,
                grant: 'grant' in binding ? binding.grant : null }).ok
            || !verifyExternalActionMachineRpcRequestV1({ reviewedChild: execution.reviewedChild, authorizationToken: execution.authorization.token,
                requesterAccountContext: execution.authorization.requesterAccountContext, effectActionId: execution.effectActionId,
                target: execution.target, installationId: execution.installationId, event: request.event ?? SOCKET_RPC_EVENTS.CALL,
                method: request.method, requestId: request.requestId, ...(request.params === undefined ? {} : { params: request.params }),
                publicKey: machine.installationPublicKey, signature: execution.machineSignature })) return null;
        // Opaque original/child input is opened and compared by the admitted receiver;
        // the SOURCE signature attests derivation, never permission on the destination.
        return { binding, effectActionId: effect, target: execution.target, principal, effectiveAuthority: principal.authority };
    }

    if (request.workspaceSyncSeedRouting) {
        if (request.workspaceSyncSourceRouting
            || request.workspaceSyncSourceWriterTargetRouting || request.workspaceSyncTargetRouting
            || execution.effectActionId !== execution.authorization.binding.actionId
            || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL) return null;
        const admitted = await readCurrentWorkspaceSyncSeedAuthorization(execution.authorization, request.workspaceSyncSeedRouting,
            request.workspaceSyncSourceExecution, request.resolveCurrentSessionMachine);
        const route = admitted?.physicalTarget;
        if (!admitted || !route || request.method !== `${admitted.writer.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`
            || execution.installationId !== route.installationId) return null;
        const signer = await db.machine.findUnique({ where: { id: route.machineId }, select: { installationPublicKey: true } });
        if (!signer?.installationPublicKey || !verifyExternalActionMachineRpcRequestV1({ reviewedChild: execution.reviewedChild, authorizationToken: execution.authorization.token,
            requesterAccountContext: execution.authorization.requesterAccountContext,
            effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
            event: request.event ?? SOCKET_RPC_EVENTS.CALL, method: request.method, requestId: request.requestId,
            ...(request.params === undefined ? {} : { params: request.params }), workspaceSyncSeedRouting: request.workspaceSyncSeedRouting,
            publicKey: signer.installationPublicKey, signature: execution.machineSignature })) return null;
        return await hasCurrentExternalActionSessionSource(admitted.verified.binding, request.resolveCurrentSessionMachine) ? admitted.verified : null;
    }

    if (request.workspaceSyncSourceRouting?.originalActionEnvelope) {
        if (request.workspaceSyncSourceWriterTargetRouting
            || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL) return null;
        const parsed = WorkspaceSyncSourceExecutionV1Schema.safeParse({
            method: request.method, requestId: request.requestId,
            ...(request.params === undefined ? {} : { params: request.params }), externalActionExecution: execution });
        return parsed.success ? (await verifyWorkspaceSyncProjectSourceAuthorization(execution.authorization,
            request.workspaceSyncSourceRouting, parsed.data, request.resolveCurrentSessionMachine))?.verified ?? null : null;
    }

    if (request.workspaceSyncSourceWriterTargetRouting) {
        const routing = request.workspaceSyncSourceWriterTargetRouting;
        if (routing.target.phase === 'inspect' || routing.target.phase === 'remove') {
            if (request.workspaceSyncTargetRouting || request.workspaceSyncSourceExecution
                || execution.effectActionId !== binding.actionId || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL
                || request.method.slice(request.method.indexOf(':') + 1) !== readWorkspaceSyncTargetMethodV1(routing.target.phase)) return null;
            const verified = await readCurrentWorkspaceSyncCopyRetirementAuthorization(execution.authorization, routing, request.resolveCurrentSessionMachine);
            const writer = await db.machine.findUnique({ where: { id: routing.sourceWriter.machineId } }).then(decodeMachineStoredContent);
            if (!verified || !writer?.installationPublicKey || writer.accountId !== routing.source.sourceContext.machineAdmission.custodianAccountId
                || writer.installationId !== routing.sourceWriter.installationId || execution.installationId !== writer.installationId
                || classifyMachineAvailabilityState(writer) !== 'available'
                || !verifyExternalActionMachineRpcRequestV1({ reviewedChild: execution.reviewedChild,
                    authorizationToken: execution.authorization.token, effectActionId: execution.effectActionId, target: execution.target,
                    requesterAccountContext: execution.authorization.requesterAccountContext, installationId: execution.installationId,
                    event: request.event ?? SOCKET_RPC_EVENTS.CALL, method: request.method, requestId: request.requestId,
                    ...(request.params === undefined ? {} : { params: request.params }), workspaceSyncSourceWriterTargetRouting: routing,
                    publicKey: writer.installationPublicKey, signature: execution.machineSignature })) return null;
            return verified;
        }
        const admitted = await readCurrentWorkspaceSyncHandoffWriterTarget(execution.authorization, routing, request.resolveCurrentSessionMachine,
            request.workspaceSyncTargetRouting ? { routing: request.workspaceSyncTargetRouting,
                machineId: request.method.slice(0, request.method.indexOf(':')) } : undefined, request.workspaceSyncSourceExecution);
        const phaseMethod = routing.target.phase === 'preflight' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT
            : routing.target.phase === 'prepare' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE : null;
        if (!admitted || execution.effectActionId !== admitted.verified.effectActionId || !phaseMethod
            || request.method !== `${admitted.targetRoute?.parentMachineId ?? routing.target.targetMachineId}:${phaseMethod}`) return null;
        const signer = request.workspaceSyncTargetRouting ? admitted.target : admitted.writer;
        if (execution.installationId !== signer.installationId) return null;
        const writer = await db.machine.findUnique({ where: { id: signer.machineId }, select: { installationPublicKey: true } });
        if (!writer?.installationPublicKey || !verifyExternalActionMachineRpcRequestV1({ reviewedChild: execution.reviewedChild,
            authorizationToken: execution.authorization.token, effectActionId: execution.effectActionId, target: execution.target,
            requesterAccountContext: execution.authorization.requesterAccountContext,
            installationId: execution.installationId, event: request.event ?? SOCKET_RPC_EVENTS.CALL,
            method: request.method, requestId: request.requestId, ...(request.params === undefined ? {} : { params: request.params }),
            workspaceSyncSourceWriterTargetRouting: routing, publicKey: writer.installationPublicKey,
            signature: execution.machineSignature })) return null;
        if (!await hasCurrentExternalActionSessionSource(admitted.verified.binding, request.resolveCurrentSessionMachine)) return null;
        return admitted.verified;
    }

    const scmRunStartPurpose = isScmRunStartRpcPurpose(binding.actionId, execution.effectActionId, request.method)
        && (request.event === undefined || request.event === SOCKET_RPC_EVENTS.CALL);
    // Any Session-routed method spends its own signed root at the addressed
    // Session; the router admits that Session's access and current publisher.
    const sessionRule = resolveSocketRpcSessionAuthorization(request.method);
    const scopedSessionId = separator > 0 && request.method.slice(0, separator) !== binding.machineId
        && sessionRule?.routeToSessionOwnerDaemon
        && (binding.actionId === execution.effectActionId || scmRunStartPurpose)
        && resolveMachineRpcExternalActionEffectV1(sessionRule.method, binding) === execution.effectActionId
        ? request.method.slice(0, separator) : null;
    const sessionRpcTarget = scopedSessionId ? { sessionId: scopedSessionId, machineId: binding.machineId } : null;
    const isTransitionRoot = binding.actionId === 'session.agent.transition';
    const transitionPurpose = isTransitionRoot && isSessionAgentTransitionRpcPurpose(binding, execution, request);
    if (isTransitionRoot && !transitionPurpose) return null;
    const isRefineInput = binding.actionId === 'scm.diffSummary.refine' && execution.effectActionId === 'session.message.send';
    const refineInputPurpose = isScmRefineInputRpcPurposeV1(execution, request);
    if (isRefineInput && !refineInputPurpose) return null;
    const readinessChild = readGrantedSessionAgentReadinessChild(binding, execution.reviewedChild,
        { machineId: request.method.slice(0, separator), installationId: execution.installationId });
    const readinessPurpose = readinessChild !== null && readinessChild === execution.effectActionId
        && resolveMachineRpcExternalActionEffectV1(request.method.slice(separator + 1), binding,
            { machineId: request.method.slice(0, separator), installationId: execution.installationId }, execution.reviewedChild) === readinessChild;
    if (binding.actionId === SESSION_AGENT_READINESS_ROOT_ACTION_ID_V1 && readSessionAgentReadinessRoleV1(execution.effectActionId)
        && (!readinessPurpose || request.originalActionEnvelope && !isExternalActionAuthorizationBoundToEnvelope(binding, {
            actionId: binding.actionId, machineId: binding.machineId, envelope: request.originalActionEnvelope }))) return null;
    if (readinessChild && (!readinessPurpose || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL
        || request.workspaceSyncSourceRouting || request.workspaceSyncTargetRouting || request.workspaceSyncSourceWriterTargetRouting
        || request.workspaceSyncSeedRouting || request.workspaceSyncSourceExecution)) return null;
    // Pending input has no general descendant grant, including under PAT roots.
    const pendingEvent = request.event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1
        || request.event === SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2;
    const preparePending = isAdmittedDeploymentPrepareSessionMessage(binding, execution.effectActionId, execution.target)
        && request.event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 && request.method === request.event
        ? SessionPendingEnqueueByMachineRequestV1Schema.safeParse(request.params) : null;
    // ApiMachine signs this root/effect/Session/payload carrier directly, without an HTTP reviewed-child field.
    const prepareInputPurpose = preparePending?.success && execution.target.kind === 'session'
        && preparePending.data.sessionId === execution.target.sessionId
        && (preparePending.data.requestedAction.kind === 'enqueue'
            || preparePending.data.requestedAction.kind === 'steer_if_active'
            || preparePending.data.requestedAction.kind === 'send_now')
        ? { sessionId: preparePending.data.sessionId, targetMachineId: preparePending.data.targetMachineId } : null;
    if (pendingEvent && binding.actionId !== 'session.message.send' && !transitionPurpose && !refineInputPurpose && !prepareInputPurpose) return null;
    const projectPrepareReviewPurpose = isProjectPrepareReviewEffect(binding.actionId, execution.effectActionId)
        && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId
        && execution.target.kind === 'machine' && execution.target.machineId === binding.machineId
        && request.method === `${binding.machineId}:${ACTION_OPERATION_RPC_METHODS_V2.get}`;
    const effect = parseExternalActionEffectAction(binding, execution.effectActionId);
    if (!effect.success
        || binding.actionId === PROJECT_PREPARE_ACTION_ID_V1 && binding.actionId !== execution.effectActionId && !projectPrepareReviewPurpose
        || !hasMatchingExecutionEffectFamily(binding.actionId, execution.effectActionId) && !readinessPurpose && !prepareInputPurpose && !projectPrepareReviewPurpose
        || (binding.handoffContinuation || binding.handoffPreflight) && binding.actionId !== execution.effectActionId) return null;
    if (binding.managedAdmission?.actionId === 'action.operations.get' && typeof request.params !== 'string') {
        // Encrypted input is compared at the reached daemon. Visible ordinary
        // input must also spend the exact operation named by this signed root.
        const operation = ActionOperationGetV2RequestSchema.safeParse(request.params);
        if (!operation.success || operation.data.operationId !== binding.managedAdmission.input.operationId) return null;
    }
    const guestMethod = [MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD]
        .find(method => request.method.endsWith(`:${method}`));
    const guestTarget = guestMethod === MANAGED_ACTIVITY_READ_RPC_METHOD
        ? ManagedActivityReadRequestV1Schema.safeParse(request.params)
        : guestMethod === MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD
            ? ManagedAdmissionDrainConfirmRequestV1Schema.safeParse(request.params) : null;
    const guestMachineId = guestMethod ? request.method.slice(0, -(guestMethod.length + 1)) : null;
    const encryptedGuestParams = typeof request.params === 'string';
    const managedGuestActivity = guestMachineId && (guestTarget?.success || encryptedGuestParams)
        ? await readCurrentManagedGuestActivityInTx(db, binding, guestMachineId, guestTarget?.success ? guestTarget.data : undefined) : null;
    // Home cannot open encrypted payloads. The signed root identifies the
    // exact retained current row; the guest decrypts and validates its target
    // revision/controller before observing activity or beginning a drain.
    if (guestMethod && encryptedGuestParams && managedGuestActivity?.encryptionMode !== 'e2ee') return null;
    // A managed root's ordinary RPC phases stay on its selected controller.
    // Only the proved private guest phase may cross that target boundary.
    if (ManagedMachineActionIdV1Schema.safeParse(binding.actionId).success
        && (guestMethod && !managedGuestActivity || !request.method.startsWith(`${binding.machineId}:`) && !managedGuestActivity)) return null;
    if (!('authentication' in binding) && isOrdinaryMachineSetupNativeActionIdV1(binding.actionId)
        && resolveMachineRpcExternalActionEffectV1(request.method.slice(separator + 1), binding,
            { machineId: binding.machineId, installationId: binding.installationId }) !== execution.effectActionId) return null;
    if ('authentication' in binding || binding.handoffContinuation || binding.handoffPreflight) {
        const workflowSessionTarget = binding.workflowActionOrigin && binding.target.kind === 'session' ? binding.target : null;
        const prefix = `${sessionRpcTarget?.sessionId ?? workflowSessionTarget?.sessionId ?? binding.machineId}:`;
        const method = managedGuestActivity && guestMethod ? guestMethod
            : request.method.startsWith(prefix) ? request.method.slice(prefix.length) : request.method;
        // Pending admission has its own signed socket event, not a Machine RPC
        // method. Preserve both existing epochs and their exact carrier name.
        const effectActionId = workflowSessionTarget
            ? request.method.startsWith(prefix) && (method === binding.actionId
                || binding.actionId === 'session.roles.apply_to_reports' && method === SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET)
                ? binding.actionId : null
            : pendingEvent
            ? request.method === request.event ? 'session.message.send' : null
            : resolveMachineRpcExternalActionEffectV1(method, binding);
        if (!transitionPurpose && !refineInputPurpose && !readinessPurpose && !prepareInputPurpose && !scmRunStartPurpose && !projectPrepareReviewPurpose && (binding.actionId !== execution.effectActionId
                && !isContributedActionRoot(binding.actionId)
                && !isSessionArchiveStopEffect(binding.actionId, execution.effectActionId)
            || effectActionId !== execution.effectActionId)) return null;
    }
    // Home proves the original Session or accepted handoff source. RPC effects
    // cannot substitute the destination signer for that original authority.
    const requiresSource = !managedGuestActivity && Boolean(binding.handoffContinuation || binding.handoffPreflight
        || 'authentication' in binding && binding.sessionActionOrigin);
    const sourceKey = requiresSource ? await readCurrentExternalActionSourceSigningPublicKey(binding) : null;
    if (requiresSource && !sourceKey) return null;
    const machine = await db.machine.findFirst({
        where: { id: binding.machineId, accountId: binding.custodianAccountId, installationId: binding.installationId },
        select: {
            accountId: true,
            kind: true,
            revokedAt: true,
            replacedByMachineId: true,
            installationId: true,
            installationPublicKey: true,
        },
    });
    const signingPublicKey = requiresSource ? sourceKey : machine?.installationPublicKey;
    if (refineInputPurpose && (!signingPublicKey
        || !verifyScmRefineSavedSessionV1(execution.authorization, signingPublicKey))) return null;
    if (
        !machine
        || classifyMachineAvailabilityState(machine) !== "available"
        || machine.installationId !== execution.installationId
        || binding.installationId !== execution.installationId
        || !signingPublicKey
        || !verifyExternalActionMachineRpcRequestV1({ reviewedChild: execution.reviewedChild,
            authorizationToken: execution.authorization.token,
            requesterAccountContext: execution.authorization.requesterAccountContext,
            effectActionId: execution.effectActionId,
            target: execution.target,
            installationId: execution.installationId,
            event: request.event ?? SOCKET_RPC_EVENTS.CALL,
            method: request.method,
            requestId: request.requestId,
            ...(request.params === undefined ? {} : { params: request.params }),
            publicKey: signingPublicKey,
            signature: execution.machineSignature,
        })
    ) return null;
    const currentPrincipal = await verifyCurrentExternalActionPrincipal(binding);
    const principal = currentPrincipal && projectVerifiedExternalActionBoundPrincipal(binding, currentPrincipal);
    if (!principal) return null;
    const credentialAction = isTransitionRoot || refineInputPurpose || prepareInputPurpose || scmRunStartPurpose || projectPrepareReviewPurpose ? parseExternalActionEffectAction(binding, binding.actionId) : binding.handoffContinuation
        ? PublicActionIdSchema.safeParse(readExternalActionCredentialActionId(binding)) : effect;
    if (!credentialAction.success || !readinessPurpose && !await hasCurrentExecutionMachineAdmission(binding, machine)
        || !binding.handoffAdmission && !resolveCredentialActionAdmissionV1({ spec: getActionSpec(credentialAction.data),
            authority: principal.authority, grant: 'grant' in binding ? binding.grant : null }).ok) return null;
    const readinessAdmission = readinessPurpose ? await resolveMachineAdmissionInTx(db, {
        actorAccountId: binding.accountId, machineId: binding.machineId, rpcMethod: request.method.slice(separator + 1),
        callerAuthority: principal.authority, executionBinding: binding,
    }) : null;
    if (readinessPurpose && readinessAdmission?.kind !== 'admitted') return null;
    return { binding, effectActionId: execution.effectActionId, target: execution.target, principal, effectiveAuthority: principal.authority,
        ...(sessionRpcTarget ? { sessionRpcTarget } : {}),
        ...(readinessAdmission?.kind === 'admitted' ? { sessionAgentReadinessAdmission: readinessAdmission } : {}),
        ...(prepareInputPurpose ? { deploymentPrepareSessionInput: prepareInputPurpose } : {}),
        ...(managedGuestActivity ? { managedGuestActivity } : {}) };
}

export async function verifyExternalActionExecutionAuthorizationCurrentness(
    proof: ExternalActionExecutionRequestProof & Readonly<{ outerActionId: string }>,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const verified = await verifyCommon(proof);
    if (!verified) return null;
    if (verified.binding.actionId !== proof.outerActionId) return refuseExternalActionExecutionRequest('outer_action', proof);
    if (
        proof.method.toUpperCase() !== "POST"
        || proof.path !== bindExternalActionExecutionAuthorizationVerifyHttpPathV1(proof.outerActionId)
    ) {
        return refuseExternalActionExecutionRequest('verification_purpose', proof);
    }
    const effect = parseExternalActionEffectAction(verified.binding, verified.effectActionId);
    const credentialAction = verified.binding.handoffContinuation
        ? PublicActionIdSchema.safeParse(readExternalActionCredentialActionId(verified.binding)) : effect;
    if (!effect.success || !credentialAction.success || !resolveCredentialActionAdmissionV1({
        spec: getActionSpec(credentialAction.data),
        authority: verified.effectiveAuthority, grant: 'grant' in verified.binding ? verified.binding.grant : null,
        // This verifies the admitted proposal, not a native effect. Human
        // execution floors remain enforced by the domain and RPC owners.
        surface: readExternalActionSessionProposalSurface(verified.binding) }).ok) return refuseExternalActionExecutionRequest('credential_action_admission', proof);
    const { signedChildPurpose: _signedChildPurpose, ...publicVerified } = verified;
    return publicVerified;
}
import { doesWorkspaceSyncCopyRetirementRootMatchV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';
import { readWorkspaceSyncTargetMethodV1 } from '@happier-dev/protocol/socketRpc';
