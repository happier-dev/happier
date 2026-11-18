import { plainPrivateLabel, prepareE2eeAccountApiTokenLabel, preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import Fastify from "fastify";
import axios from 'axios';
import { SessionArchiveHttpBodyV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { z } from 'zod/mini';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { maxHeaderSize } from 'node:http';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server as SocketServer } from 'socket.io';
import { io as connectSocket } from 'socket.io-client';
import type { FastifyRequest, InjectOptions } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { encodeBase64 as encodeProtocolBase64 } from '@happier-dev/protocol/crypto/base64';
import type { Server, Socket } from "socket.io";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as cliPersistence from '../../../../../../cli/src/persistence';
import { logger as cliLogger } from '../../../../../../cli/src/ui/logger';
import { bootstrapAccountSettingsContext } from '../../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';

import {
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    ExternalActionExecutionAuthorizationV1Schema,
    externalActionExecutionAuthorizationRequestSchemaForActionV1,
    ExternalActionRequestEnvelopeV1Schema,
    ExternalActionResponseEnvelopeV1Schema,
    computeExternalActionRequestEnvelopeDigestV1,
    bindExternalActionExecutionAuthorizationHttpPathV1,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    getActionSpec,
    SignedRootActionIdSchema,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
    signExternalActionMachineRpcRequestV1,
    createExternalActionDaemonDispatchResponseV1,
    createExternalActionDaemonDispatchResponse,
    prepareExternalActionResponseEnvelopeV1,
    type ExternalActionRequestEnvelopeV1,
    type ExternalActionServerPrincipalV1,
    type ExternalActionDaemonDispatchRequest,
    type ExternalActionEncryptionBindingV2,
    type ExternalActionExecutionAuthorizationV1,
} from "@happier-dev/protocol/actions";
import { EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2, ExternalActionExecutionAuthorizationRequestV1Schema,
    createDeploymentCandidatePublicationV1, readWorkspaceSyncSourceAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1, MACHINE_PLAIN_DATA_KEY_MARKER, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, encodePlainMachineStoredContent, encodePasswordCredentialFieldV1, type AccountPasswordCredentialV1 } from "@happier-dev/protocol";
import { buildSessionOrganizationAssignmentSnapshotHttpRequestV1 } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SessionSectionV1Schema } from '@happier-dev/protocol/sessions/organization/folders';
import type { SessionSectionActionIdV1 } from '@happier-dev/protocol/actions/sessionSections';
import { SOCKET_RPC_EVENTS, SessionActionRpcOriginV1Schema, WorkspaceSyncSourceContextV1Schema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema } from "@happier-dev/protocol/socketRpc";
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AGENT_SIGN_IN_STATUS_RPC_METHOD } from '@happier-dev/protocol/daemon/agentSignIn';
import { readMachineSetupPlanChildInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { MachineInstallationProofPayloadV1Schema, signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { registerMachineAdmissionRoutes } from '@/app/api/routes/machines/registerMachineAdmissionRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { SessionRequesterHandoffBootstrapRpcRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { HandoffTargetReplacementPreflightV1Schema, WorkspaceContentPolicyV1Schema,
    computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { createMachineDataEncryptionKeyV1, decodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { projectSessionSpawnNewActionResultV1, SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { wrapApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import { buildEmbedParentGrantV1 } from '@happier-dev/protocol/embed';
import { packSessionDataKeyBundleV0, serializeSessionDataKeyValue, SESSION_DATA_KEY_NONCE_BYTES } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { buildWorkspaceSyncDestinationOpenInputV1 } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1, PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { sealExternalActionRequestV2, openExternalActionRequestV2, prepareExternalActionResponseV2,
    openExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { deriveBoxPublicKeyFromEd25519PublicKey, deriveBoxPublicKeyFromSeed, deriveBoxSecretKeyFromSeed,
    openBoxBundleWithSecretKey, sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';

import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";
import { requirePresentUser } from "@/app/api/utils/requirePresentUser";
import { registerAccountEncryptionRoutes } from "@/app/api/routes/account/registerAccountEncryptionRoutes";
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant } from '@/app/discussions/accessService';
import { createSessionInputReplyProgressInTx } from '@/app/session/messages/sessionMessageReply';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { registerAccountSettingsRoutes } from "@/app/api/routes/account/registerAccountSettingsRoutes";
import { kvRoutes } from '@/app/api/routes/kv/kvRoutes';
import { SCM_REVIEWED_MARKS_KV_PREFIX, buildScmReviewedMarksKey } from '@happier-dev/protocol/scm/reviewedMarks';
import { USAGE_COACH_SUPPRESSIONS_KV_KEY } from '@happier-dev/protocol/usage/coach/coachActions';
import { USAGE_COACH_ACTION_IDS } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { SETTINGS_DECLARATION_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/settingsDeclarationActionIdsV1';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from '@/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4';
import { mutateQualifiedConnectedServiceCredential } from '@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { registerConnectedAccountConfigurationRowsRoutes } from '@/app/account/connectedAccounts/registerConfigurationRowsRoutes';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { writeQualifiedProviderAccountUsageRecord } from '@/app/api/routes/connect/qualifiedConnectedAccounts/usageRepository';
import { createUsageSnapshot } from '@/app/api/routes/connect/providerAccountUsageTestkit';
import { homeGovernanceRoutes } from "@/app/api/routes/home/homeGovernanceRoutes";
import { featuresRoutes } from "@/app/api/routes/features/featuresRoutes";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";
import { registerSessionReadBatchRoute } from "@/app/api/routes/session/registerSessionReadBatchRoute";
import { registerSessionCreateOrLoadRoute } from "@/app/api/routes/session/registerSessionCreateOrLoadRoute";
import { buildSessionListServerQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { projectSessionListFilterHomeQueriesV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterQueryV1';
import { registerSessionMessageRoutes } from "@/app/api/routes/session/registerSessionMessageRoutes";
import { registerSessionFollowSourceRoutes } from "@/app/api/routes/session/registerSessionFollowSourceRoutes";
import { registerSessionManagerRoutes } from "@/app/api/routes/session/registerSessionManagerRoutes";
import { registerSessionAccessGrantRoutes } from "@/app/api/routes/session/registerSessionAccessGrantRoutes";
import { registerSessionResponsibilityRoutes } from "@/app/api/routes/session/registerSessionResponsibilityRoutes";
import { registerPublicShareOwnerRoutes } from "@/app/api/routes/share/registerPublicShareOwnerRoutes";
import { registerProjectAccountRowRoutes } from '@/app/api/routes/projects/registerProjectAccountRowRoutes';
import { registerWorkspaceExecutionConfigRoutes } from '@/app/projects/execution/registerWorkspaceExecutionConfigRoutes';
import { registerProjectTrustRoutes } from '@/app/projects/trust/registerProjectTrustRoutes';
import { WorkspaceExecutionConfigReadRequestV1Schema, WorkspaceExecutionConfigReadResponseV1Schema } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { ProjectTrustReadResponseV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { createLocalServiceActionConfirmationNonceV1, createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { ProjectServiceRelocateInputV1Schema, ProjectServiceRelocateResultV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createProjectServiceRelocationRoute } from '../../../../../../cli/src/daemon/local/services/actions/projectServiceRelocationRoute';
import { createLocalServicesDaemonRuntimeActionExecutor } from '../../../../../../cli/src/daemon/local/services/actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '../../../../../../cli/src/daemon/local/services/featureGate';
import { createProjectServiceDeclarationStarter } from '../../../../../../cli/src/daemon/local/services/launch/projectDeclarations';
import { createLocalServiceLauncherFeed } from '../../../../../../cli/src/daemon/local/services/launch/feed';
import { createLocalServiceLauncherRoutes } from '../../../../../../cli/src/daemon/local/services/launch/routes';
import { createLocalServiceInventoryRegistry } from '../../../../../../cli/src/daemon/local/services/inventory/registry';
import { createLocalServicePreviewRegistry } from '../../../../../../cli/src/daemon/local/services/preview/registry';
import { createLocalServiceActionRoutes } from '../../../../../../cli/src/daemon/local/services/actions/routes';
import { createCliActionExecutor } from '../../../../../../cli/src/session/actions/createCliActionExecutor';
import { createProjectWorkerAction } from '../../../../../../cli/src/workspaces/execution/projectWorkerAction';
import { createProjectWorkerAdmission } from '../../../../../../cli/src/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '../../../../../../cli/src/daemon/lifecycle/admissionDrain';
import { createInstalledProjectFiniteRuntime } from '../../../../../../cli/src/daemon/startup/createInstalledProjectFiniteRuntime';
import { createProjectNativeIo } from '../../../../../../cli/src/workspaces/projectSetup/projectNativeIo';
import { createHostActionOperationRuntime } from '../../../../../../cli/src/daemon/actionOperations/createHostActionOperationRuntime';
import { createTerminalPtySessionManager } from '../../../../../../cli/src/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '../../../../../../cli/src/terminal/pty/config';
import { prepareWorkspaceSyncBetween } from '../../../../../../cli/src/workspaces/sync/workspaceSyncPreparation';
import { createWorkspaceSyncHandoffAdapter } from '../../../../../../cli/src/workspaces/sync/workspaceSyncHandoffAdapter';
import { readProjectAccountRows } from '../../../../../../cli/src/workspaces/projectAccountRows';
import { prepareInstalledRequesterAccountActionContext, prepareRequesterAccountActionContext, type RequesterAccountActionContext } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { registerDaemonLocalServicesMachineRpcHandlers } from '../../../../../../cli/src/rpc/handlers/daemonLocalServices';
import { registerActionSpecRpcHandlers } from '../../../../../../cli/src/rpc/handlers/registerActionSpecRpcHandlers';
import { registerSessionLifecycleRpcHandlers } from '../../../../../../cli/src/rpc/handlers/sessionLifecycle';
import { MACHINE_SESSION_STOP_RPC_SCOPES } from '../../../../../../cli/src/rpc/handlers/actionSpecRpcRegistration';
import { createMachineSessionStopLifecycleActionExecutor } from '../../../../../../cli/src/session/actions/lifecycle/createStopSessionLifecycleActionExecutor';
import { ApiClient } from '../../../../../../cli/src/api/api';
import * as installationStore from '../../../../../../cli/src/daemon/identity/store';
import * as currentMachineInstallation from '../../../../../../cli/src/daemon/identity/currentMachineInstallation';
import type { RpcHandlerContext } from '../../../../../../cli/src/api/rpc/types';
import type { RpcActionExecutorContext } from '../../../../../../cli/src/rpc/handlers/_actionDispatchAdapter';
import { createManagedServicesOwner } from '../../../../../../cli/src/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '../../../../../../cli/src/plugins/runtime/invocation/services/managedProcessSupervisor';
import { installAxiosFastifyAdapter } from '../../../../../../cli/src/testkit/http/axiosAdapter';
import { serializeMachineRow } from '@/app/machines/machineSerialization';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowListResponseV1Schema, ProjectAccountRowMutationRequestV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { hasCurrentSessionScopedMachineAccessInTx } from '@/app/api/socket/sessionScopedBinding';
import { auth } from "@/app/auth/auth";
import { verifyExternalActionMachineRpcExecution, verifyCurrentExternalActionPrincipal, verifyWorkspaceSyncHandoffSourceAuthorization, readCurrentWorkspaceSyncProjectSourceAuthorization, verifyExternalActionDomainExecutionRequest, isOriginalAccountExecutionAction, isOriginalTerminalExecutionAction } from "@/app/auth/externalActionExecutionAuthorization";
import { qualifyTeamAuthenticationInTx } from "@/app/auth/entry/qualifyTeamAuthentication";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { registerTeamRoutes } from "@/app/teams/registerTeamRoutes";
import { registerAccountApiTokenManagementRoutes } from '@/app/api/routes/auth/registerAccountApiTokenManagementRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { encryptString } from '@/modules/encrypt';
import { currentAccountStoredContentCompatibilityHeaders, currentAccountStoredContentCompatibilitySocketAuth,
    qualifyCurrentAccountStoredContentSocket } from "@/app/api/testkit/accountStoredContentCompatibility";
import { createExternalActionDaemonDispatcher, resolveCurrentSessionMachineFromServer,
    type ExternalActionDaemonDispatcher } from "@/app/api/socket/externalActionDispatcher";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { getAccountSessionSocketRoom, getMachineSocketRoom } from "@/app/api/socketRooms";
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1,
    type ExternalActionRequesterAccountContextPurposeV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { registerAccountProfileRoute } from '@/app/api/routes/account/registerAccountProfileRoute';
import { machineUpdateHandler } from "@/app/api/socket/machineUpdateHandler";
import { createAuthenticatedFakeSocket, createFakeSocket, getSocketHandler, createSocketRoomDiscoveryHarness } from "@/app/api/testkit/socketHarness";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveMachineAccess, resolveMachineAdmission, removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { readMachineDevcontainerWorkspaceSyncRouteInTx } from '@/app/machines/managed/managedRows';
import { enqueuePendingMessage, deletePendingMessage } from '@/app/session/pending/pendingMessageService';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { admitManagedAcquire } from '@/app/machines/managed/managedAcquire';
import { cancelManagedCreation } from '@/app/machines/managed/managedRead';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import { reportManagedAcquire, submitManagedAcquire } from '@/app/machines/managed/managedMutations';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { PluginManifestV2Schema, TeamPolicySetInputV1Schema } from '@happier-dev/protocol';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

import { registerExternalActionRoutes } from "./registerExternalActionRoutes";
import { executeExternalAction } from '../../../../../../cli/src/daemon/externalActions/executeExternalAction';
import { createHarness as createInstalledProjectApprovalHarness, resetFilesystemApprovalSocketBoundary } from '../../../../../../cli/src/daemon/externalActions/executeExternalAction.filesystemApprovals.testkit';
import { createAccountServerWorkspaceWorkerPreferenceClient } from '../../../../../../cli/src/api/workspaces/workspaceWorkerPreferences';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ACTION_OPERATION_RPC_METHODS_V2, ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/methodsV1';
import { createDaemonExternalActionTargetResolver } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { resolveExternalActionRootInvocationAuthority, verifyExternalActionExecutionAuthorizationCurrent } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { registerSessionArchiveRoutes } from '@/app/api/routes/session/registerSessionArchiveRoutes';
import { registerSessionOrganizationRoutes } from '@/app/api/routes/session/registerSessionOrganizationRoutes';
import { registerSessionBoardRoutes } from '@/app/api/routes/session/registerSessionBoardRoutes';
import { registerSessionSystemRecordRoutes } from '@/app/api/routes/session/registerSessionSystemRecordRoutes';
import { registerSessionDataKeyEnvelopeRoutes } from '@/app/api/routes/session/registerSessionDataKeyEnvelopeRoutes';
import { registerSessionSubagentCustodyRoutes } from '@/app/api/routes/session/registerSessionSubagentCustodyRoutes';
import { registerSessionFollowRoutes } from '@/app/api/routes/session/registerSessionFollowRoutes';
import { SessionFollowRuleDefinitionV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { registerSessionDeleteRoute } from '@/app/api/routes/session/registerSessionDeleteRoute';
import { registerSessionReadStateRoutes } from '@/app/api/routes/session/registerSessionReadStateRoutes';
import { registerStoredContentPublicShareRoutes } from '@/app/api/routes/share/registerStoredContentPublicShareRoutes';
import { SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { SessionBoardMutationV1Schema } from '@happier-dev/protocol/sessions/board/mutations';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';
import { readSessionSystemRecordV1 } from '@/app/session/systemRecords/sessionSystemRecordService';
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol';
import { createAutomationSessionLifecycleFixtureFields } from "@/testkit/automationSessionLifecycleFixture";
import { deleteAutomationTrigger } from '@/app/automations/automationCrudService';
import { registerWorkflowRunStorageRoutes } from '@/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { startSocket } from '@/app/api/socket';
import { createSignedPluginInstallationPublisherHeader } from '@/testkit/pluginInstallationPublisherTestkit';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createWorkflowActionExecutor } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { createWorkflowRunActionOwner } from '../../../../../../cli/src/session/actions/workflowRunActions';
import { createWorkflowRunStorageClient } from '../../../../../../cli/src/daemon/workflows/workflowRunStorageClient';
import { createUnavailableActionTransportDeps } from '../../../../../../cli/src/testkit/actionTransportDeps';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createDaemonSessionAccountActionExecutor } from '../../../../../../cli/src/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createExternalActionAuthorizedRequestHeaders, prepareExternalActionRequesterAccountAuthorization, projectExternalActionRequesterHttpAuthorization, resolveExternalActionServerRequestHeaders } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { admitRequesterAccountActionContext, projectRequesterAccountActionAuthorization } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { createCliApprovalsArtifactStore } from '../../../../../../cli/src/session/actions/approvals/artifactStore';
import { createAccountServerActionDeps } from '../../../../../../cli/src/api/accountServerActionDeps';
import { fetchAccountProfile } from '../../../../../../cli/src/api/accountProfile';
import { createSessionSubagentCustodyKeyV1 } from '@happier-dev/protocol/sessions/subagents/durableCustodyV1';
import { createDaemonApprovalExecutionOriginCurrentness } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { resolveAvailableAccountSettings } from '../../../../../../cli/src/settings/accountSettings/resolveAvailableAccountSettings';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { SESSION_DATA_KEY_ENVELOPE_BYTES_V1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { encrypt as encryptRpc, decrypt as decryptRpc, encodeBase64 as encodeRpcBase64 } from '../../../../../../cli/src/api/encryption';
import { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '../../../../../../cli/src/api/machine/machineRpcAuthorization';
import { projectMachineRpcTransportAcknowledgement } from '../../../../../../cli/src/api/machine/projectMachineRpcTransportAcknowledgement';
import { registerMachinePromptAssetTransferRpcHandlers } from '../../../../../../cli/src/api/machine/rpcHandlers.promptAssetTransfers';
import { createFoundSkillBundleReader } from '../../../../../../cli/src/cli/actions/foundSkillBundleReader';
import { scanNativeSkillRoots } from '../../../../../../cli/src/prompts/skills/native/scanNativeSkillRoots';
import { createCliActionDeps } from '../../../../../../cli/src/session/actions/createCliActionDeps';
import { createTestMetadata } from '../../../../../../cli/src/testkit/backends/sessionMetadata';
import { createRequesterCurrentnessSocketHarness } from '../../../../../../cli/src/testkit/backends/requesterCurrentnessSocketHarness';
import { buildSessionMetadataEnvelopeCreateFields } from '../../../../../../cli/src/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { fetchSessionById } from '../../../../../../cli/src/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '../../../../../../cli/src/session/transport/encryption/sessionEncryptionContext';
import { registerSessionPatchRoute } from '@/app/api/routes/session/registerSessionPatchRoute';
import { FoundSkillBundleV1Schema } from '@happier-dev/protocol/prompts/library/skills/foundSkillTransferV1';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { createTransferRecipientKeyPair } from '@happier-dev/transfers/node';
import { resolveVerifiedMachineSocketInstallationId } from '@/app/api/socket/machineSocketInstallationProof';
import { eventRouter } from '@/app/events/eventRouter';
import { readFoundSkillBundle } from '../../../../../../cli/src/prompts/skills/native/resolveFoundSkillDownloadSource';
import { createDirectTransferServerLifecycle } from '../../../../../../cli/src/machines/transfer/directTransferServerLifecycle';
import { registerMachinePreparedTransferRpcHandlers } from '../../../../../../cli/src/api/machine/rpcHandlers.preparedTransfers';
import { buildDirectPeerTransferEndpointPath, requestDirectPeerTransferToFile } from '../../../../../../cli/src/machines/transfer/directPeerTransport';
import { DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER } from '../../../../../../cli/src/machines/transfer/directPeerTransport/protocol';
import { PreparedTransferRpcRequestV1Schema, PreparedTransferRpcResponseV1Schema,
    resolvePreparedTransferRpcPhaseV1 } from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { prepareWorkspaceFileExport } from '../../../../../../cli/src/machines/transfer/prepareWorkspaceFileExport';
import { registerPromptLibraryRoutes } from '@/app/account/prompts/registerPromptLibraryRoutes';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowReadResponseV1Schema,
    openPromptLibraryContentV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { prepareFoundSkillExport } from '../../../../../../cli/src/machines/transfer/prepareFoundSkillExport';
import { registerMachineDirectTransferExportRpcHandlers } from '../../../../../../cli/src/api/machine/rpcHandlers.directTransferExports';
import { TransferEndpointCandidateSchema } from '@happier-dev/protocol/machines/transfer/transferStream';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema,
    DeploymentBindingsPreparedInputV1Schema } from '@happier-dev/protocol';
import { DeploymentBindingsSetStorageInputV1Schema } from '@happier-dev/deployment-protocol';
import { COPY_ENVIRONMENT_BINDINGS_ROLE } from '../../../../../../cli/src/deployments/copyEnvironmentForHost';

import { machineOperationSupportForTest } from '@/testkit/machineOperationSupport.testkit';

const ACTION_ID = "teams.policy.set" as const;
function createTeamPolicyInput(teamId: string) {
    return TeamPolicySetInputV1Schema.parse({ v: 1, teamId, externalSharingPolicy: 'allowed' });
}
const authorizationRequests = new Map<string, Readonly<{
    target: NonNullable<ExternalActionRequestEnvelopeV1["target"]>;
    installationId: string;
    requestId: string;
}>>();

function createFixtureCopyOnceWorkspaceAction() {
    const policyInput = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    return { kind: 'copy_once' as const, contentPolicy: WorkspaceContentPolicyV1Schema.parse({
        ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput),
    }) };
}

function expectForwardedSeedRoot(request: unknown, root: ExternalActionExecutionAuthorizationV1) {
    const forwarded = ExternalActionExecutionAuthorizationV1Schema.safeParse(
        request !== null && typeof request === 'object' ? Reflect.get(request, 'callerInputAuthorization') : undefined);
    expect(forwarded.success).toBe(true);
    if (!forwarded.success) return;
    expect(forwarded.data.binding).toEqual(root.binding);
    expect(forwarded.data.token === root.token).toBe(true);
}

async function importTestModule<T>(specifier: string): Promise<T> {
    // Existing cross-program integration pattern: Vitest executes real CLI
    // source while this package's compiler stays rooted in server source.
    return import(specifier) as Promise<T>;
}

type TestStoredCredentials = Readonly<{ token: string; encryption: null | Readonly<{ type: 'legacy'; secret: Uint8Array }> }>;
type TestRequesterPreparation = Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1;
    purpose?: ExternalActionRequesterAccountContextPurposeV1;
    signal?: AbortSignal;
}>;
type TestAdmittedRequester = Readonly<{
    credentials: TestStoredCredentials;
    accountSettingsContext: Readonly<{ settings: Record<string, unknown> }>;
    isCurrent(): Promise<boolean>;
}>;


describe("external Action managed sandbox member admission", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-external-action-execution-authorization-",
            initAuth: true,
            initEncrypt: true,
            initFiles: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "true",
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "true",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED: "1",
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
            },
        });
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
    }, 300_000);

    afterEach(async () => {
        vi.restoreAllMocks();
        resetFilesystemApprovalSocketBoundary();
        await db.accountApiToken.deleteMany();
        await db.accessKey.deleteMany();
        await db.automationRun.deleteMany();
        await db.automation.deleteMany();
        await db.deploymentEnvironment.updateMany({ data: { runtimeTargetLinkId: null } });
        await db.deploymentTargetLink.updateMany({ data: { activeDeploymentId: null } });
        await db.deployment.deleteMany();
        await db.deploymentTargetLinkMachine.deleteMany();
        await db.deploymentTargetLink.deleteMany();
        await db.deploymentEnvironment.deleteMany();
        await db.projectSource.deleteMany();
        await db.managedMachine.deleteMany();
        await db.pluginMachineMaterialization.deleteMany();
        await db.accountPluginIntent.deleteMany();
        await db.machine.deleteMany();
        await db.teamMembership.deleteMany();
        await db.team.deleteMany();
        await db.sessionMessage.deleteMany();
        await db.session.deleteMany();
        await db.artifact.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        if (harness) await harness.close();
    });

    async function createFixture(input: Readonly<{ qualifiedPat: boolean }>) {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
        });
        const passwordCredential: AccountPasswordCredentialV1 = {
            v: 1,
            kind: "plain_password_hash",
            hash: {
                v: 1,
                algorithm: "scrypt",
                parameters: { n: 16_384, r: 8, p: 5, keyLength: 32 },
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
                digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
            },
        };
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "email",
                providerUserId: `${account.id}@external-action.test`,
                profile: {},
            },
        });
        await db.accountPasswordCredential.create({
            data: { accountId: account.id, credential: passwordCredential },
        });
        const keyPair = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({
            data: {
                id: crypto.randomUUID(),
                accountId: account.id,
                metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
                dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                installationId: crypto.randomUUID(),
                installationPublicKey: new Uint8Array(keyPair.publicKey),
            },
        });
        expect(await resolveMachineAccess({ actorAccountId: account.id, machineId: machine.id }),
            'Auth fixture must be ready under the real persisted Machine-mode owner').toMatchObject({
            owned: true, role: 'manage', encryptionMode: 'plain', accessState: 'ready', installationId: machine.installationId,
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: plainPrivateLabel(input.qualifiedPat ? "qualified" : "ordinary"),
            ...(input.qualifiedPat
                ? {
                    authenticationEvidence: [{ kind: "home_method" as const, methodId: "email_password" }],
                }
                : {}),
        });
        const team = await db.team.create({
            data: {
                name: "Restricted Team",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "email_password" }],
                },
            },
        });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: account.id, role: "owner" },
        });
        const envelope: ExternalActionRequestEnvelopeV1 = {
            v: 1,
            requestId: crypto.randomUUID(),
            target: { kind: "machine", machineId: machine.id },
            input: createTeamPolicyInput(team.id),
        };
        return { account, machine, pat, team, envelope, keyPair };
    }

    async function createApp(teamId: string, semanticWithdraw = false,
        resolveCurrentSessionMachine?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<string | null>,
        daemonTransport?: ExternalActionDaemonDispatcher, usageReads = false,
        configure?: (app: Parameters<typeof artifactsRoutes>[0]) => void, machineReads = false) {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as any;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        if (resolveCurrentSessionMachine) app.decorate('resolveCurrentSessionMachine', resolveCurrentSessionMachine);
        enableAuthentication(app);
        const dispatchedPrincipals: ExternalActionServerPrincipalV1[] = [];
        registerExternalActionRoutes(app, {
            dispatch: async (request, options) => {
                // The daemon network transport is external; ingress and root projection stay real.
                dispatchedPrincipals.push(request.principal);
                if (daemonTransport) return await daemonTransport(request, options);
                return { kind: "placement_error", code: "target_unavailable" };
            },
        });
        featuresRoutes(app);
        registerAccountEncryptionRoutes(app);
        registerAccountSettingsRoutes(app);
        kvRoutes(app);
        if (usageReads) registerQualifiedConnectedAccountCredentialRoutesV4(app);
        registerAccountProfileRoute(app);
        registerSessionListingRoutes(app);
        registerSessionReadBatchRoute(app);
        registerSessionMessageRoutes(app);
        registerSessionFollowSourceRoutes(app);
        registerSessionArchiveRoutes(app);
        registerSessionBoardRoutes(app);
        registerProjectAccountRowRoutes(app);
        registerWorkspaceExecutionConfigRoutes(app);
        registerProjectTrustRoutes(app);
        projectSourceRoutes(app);
        if (machineReads) machinesRoutes(app);
        else registerMachineAdmissionRoutes(app);
        registerWorkflowRunStorageRoutes(app);
        if (semanticWithdraw) {
            // HTTP authentication is the boundary under test; accepted custody/removal use their real domain owner.
            app.post('/v2/sessions/:sessionId/pending/:localId/withdraw', {
                preHandler: app.authenticate,
                config: { apiTokenSessionAction: 'session.pending.withdraw',
                    requiredExternalActionEffectActionId: 'session.pending.withdraw',
                    restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
            }, async (request: FastifyRequest<{ Params: { sessionId: string; localId: string } }>) => deletePendingMessage({
                actorUserId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request),
                sessionId: request.params.sessionId, localId: request.params.localId, withdraw: true,
            }));
        }

        const transport = getActionSpec(ACTION_ID).serverTransport;
        if (!transport) throw new Error("test Action has no server transport");
        app.post(transport.path, { preHandler: app.authenticate, config: { allowApiToken: true } }, async (request: any) => {
            const qualification = await inTx((tx) => qualifyTeamAuthenticationInTx(tx, {
                env: process.env,
                team: {
                    id: teamId,
                    authenticationPolicy: {
                        v: 1,
                        mode: "restricted",
                        accepted: [{ kind: "home_method", methodId: "email_password" }],
                    },
                },
                accountId: request.userId,
                verifiedCredentialEvidence: request.authTokenAuthenticationEvidence,
                operationContext: { kind: request.authAuthority },
            }));
            return {
                qualification: qualification.status,
                principal: request.apiTokenPrincipal,
                rootActionId: request.externalActionRootActionId,
                effectActionId: request.externalActionEffectActionId,
                target: request.externalActionExecutionTarget,
            };
        });
        app.post("/v1/sessions/:sessionId/discussions", { preHandler: app.authenticate }, async () => ({ ok: true }));
        app.post("/test/present-user-only", { preHandler: [app.authenticate, requirePresentUser] }, async () => ({ ok: true }));
        configure?.(app);
        await app.ready();
        return { app, transport, dispatchedPrincipals };
    }

    async function createRealTeamApp() {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as any;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerExternalActionRoutes(app, {
            dispatch: async () => ({ kind: "placement_error", code: "target_unavailable" }),
        });
        registerTeamRoutes(app);
        await app.ready();
        return app;
    }

    async function createRealLane03App() {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as any;
        const duplicateExternalActionAdmissionRoutes: string[] = [];
        app.addHook("onRoute", (routeOptions: {
            method: string | readonly string[];
            url: string;
            config?: Readonly<Record<string, unknown>>;
        }) => {
            if (!("allowExternalActionApiTokenForActionIds" in (routeOptions.config ?? {}))) return;
            const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
            for (const method of methods) {
                duplicateExternalActionAdmissionRoutes.push(`${method} ${routeOptions.url}`);
            }
        });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerExternalActionRoutes(app, {
            dispatch: async () => ({ kind: "placement_error", code: "target_unavailable" }),
        });
        homeGovernanceRoutes(app);
        registerTeamRoutes(app, {
            ...process.env,
            HAPPIER_FEATURE_TEAMS__ENABLED: "1",
        });
        await app.ready();
        return { app, duplicateExternalActionAdmissionRoutes };
    }

    async function mint(
        app: Awaited<ReturnType<typeof createApp>>["app"],
        fixture: Awaited<ReturnType<typeof createFixture>>,
        actionId: string = ACTION_ID,
        envelope: ExternalActionRequestEnvelopeV1 = fixture.envelope,
        credentialToken: string = fixture.pat.token,
    ) {
        const response = await app.inject({
            method: "POST",
            url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${credentialToken}` },
            payload: { v: 1, machineId: fixture.machine.id, envelope },
        });
        expect(response.statusCode, response.body).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
        authorizationRequests.set(authorization.token, {
            target: authorization.binding.target,
            installationId: fixture.machine.installationId!,
            requestId: authorization.binding.requestId,
        });
        return authorization;
    }

    function machineHeaders(input: Readonly<{
        authorizationToken: string;
        method: string;
        path: string;
        body: unknown;
        privateKey: Uint8Array;
        effectActionId?: string;
        target?: ExternalActionRequestEnvelopeV1["target"];
        installationId?: string;
    }>): Record<string, string> {
        const effectActionId = input.effectActionId ?? ACTION_ID;
        const request = authorizationRequests.get(input.authorizationToken);
        const target = input.target ?? request?.target;
        if (!target) throw new Error("test machine request requires a target");
        if (!request) throw new Error("test machine request requires authorization identity");
        return {
            // The production CLI declares its current stored-content reader on every
            // Session request. Without this declaration the server correctly projects
            // the legacy-compatible corpus and omits current metadata-layout rows.
            ...currentAccountStoredContentCompatibilityHeaders,
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: input.authorizationToken,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                ...input,
                effectActionId,
                target,
                installationId: input.installationId ?? request.installationId,
                requestId: request.requestId,
            }),
        };
    }


    async function createManagedNativeAuthFixture(rebuild = false) {
        const fixture = await createFixture({ qualifiedPat: false });
        const homeId = await getOrCreateServerIdentityId();
        const controller = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const nativeOperation = rebuild ? native : defineProtocolObject({ requestId: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
        const reconciliation = defineMachineProvisionerReconciliationSchemas({ launch: native, resource: native, nativeOperation });
        const definitions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: reconciliation.result.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'destroy', inputSchema: reconciliation.destroyInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            { id: 'power', inputSchema: roles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            { id: 'reconcile', inputSchema: reconciliation.input.jsonSchema, resultSchema: reconciliation.result.jsonSchema },
            ...(rebuild ? [{ id: 'rebuild', inputSchema: roles.rebuildInput.jsonSchema, resultSchema: roles.rebuildResult.jsonSchema }] : []),
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.pending-auth', version: '1.0.0',
            displayName: 'Pending native authentication fixture', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Guest', icon: 'machine', resourceKind: rebuild ? 'devcontainer' : 'vm', schemaVersion: 1,
                    launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: rebuild ? ['delete', 'rebuild'] : ['start', 'stop', 'delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy', power: 'power', ...(rebuild ? { rebuild: 'rebuild' } : {}) },
                    reconciliation: { action: 'reconcile', nativeOperationSchema: nativeOperation.jsonSchema } }],
                actions: definitions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' },
                    surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
            } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.machine.update({ where: { id: fixture.machine.id }, data: { pluginMaterializationRevision: BigInt(1) } });
        await db.accountPluginIntent.create({ data: { accountId: fixture.account.id, pluginId: manifest.id, enabled: true,
            writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: fixture.account.id, serverIdentityId: homeId,
            machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id, version: manifest.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const input = { enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const }, selection: { kind: 'one-off' as const, homeId, controller,
            launch: { provider: { pluginId: manifest.id, localId: 'compute' }, schemaVersion: 1, name: 'Reviewed', choices: { id: 'reviewed' } },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        return { fixture, homeId, controller, input };
    }

    it.each(['owner', 'member'] as const)('admits the exact reviewed Session sandbox through real Home HTTP (%s)', async relationship => {
        const { fixture, homeId, controller, input: oneOff } = await createManagedNativeAuthFixture();
        await db.machine.update({ where: { id: controller.machineId }, data: {
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                requesterExecutionIsolation: { protocolVersions: [1] } },
        } });
        const { storeOpaquePresetLaunch } = await import('@/app/machines/managed/managedRows');
        const { ManagedAcquireInputV1Schema } = await import('@happier-dev/protocol/machines/managed/actionsV1');
        const preset = await db.managedMachinePreset.create({ data: { homeId, custodianAccountId: fixture.account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            name: '', launch: storeOpaquePresetLaunch({ contentEncryptionMode: 'plain', recipients: [],
                content: { t: 'plain', v: { v: 1, name: 'Session sandbox', launch: oneOff.selection.launch } } }) } });
        const acquisition = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId,
            id: preset.id, revision: preset.revision }, controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const rootInput = SessionSpawnNewInputV2Schema.parse({ creationKey: crypto.randomUUID(),
            executionTarget: { serverId: homeId, machineId: controller.machineId }, directory: { kind: 'path', path: '/workspace' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
        const actionId = 'session.spawn_new';
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
            target: { kind: 'machine', machineId: controller.machineId }, input: rootInput });
        const requester = relationship === 'owner' ? fixture.account : await db.account.create({ data: { encryptionMode: 'plain' } });
        const token = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const { registerMachinePresetRoutes } = await import('@/app/api/routes/machines/managed/registerMachinePresetRoutes');
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, instance => {
            registerManagedMachineRoutes(instance);
            registerMachinePresetRoutes(instance);
        });
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            if (relationship === 'member') {
                const denied = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId, envelope } });
                expect(denied.statusCode).toBeGreaterThanOrEqual(400);
                expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: fixture.account.id,
                    machineId: controller.machineId, principal: { kind: 'account', accountId: requester.id }, level: 'view' })))
                    .toMatchObject({ kind: 'saved' });
                const privatePreset = await app.inject({ method: 'POST', url: '/v1/machines/presets/get',
                    headers: { authorization: `Bearer ${token}` }, payload: { homeId, id: preset.id } });
                expect(privatePreset.statusCode).toBe(404);
                expect(privatePreset.json()).toEqual({ kind: 'refused', code: 'preset_not_found' });
            }
            const authorization = await mint(app, fixture, actionId, envelope, token);
            expect(authorization.binding).toMatchObject({ accountId: requester.id, custodianAccountId: fixture.account.id });
            if (relationship === 'member') expect(authorization.binding.admittedMachineRole).toBe('use');
            expect(authorization.binding.sessionPresetAcquisition).toBeUndefined();
            const projected = await projectExternalActionRequesterHttpAuthorization({ authorization,
                serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: origin, target: authorization.binding.target,
                installationId: controller.installationId, privateKey: fixture.keyPair.secretKey, isCurrent: async () => true });
            if (!projected) throw new Error('session_acquire_http_projection_required');
            const result = await invokeHostReviewedChildV1({ parent: { actionId, input: rootInput },
                context: { surface: 'cli', serverId: homeId, runtimeAccountId: requester.id,
                    externalActionTarget: authorization.binding.target, externalActionExecutionAuthorization: projected },
                child: { action: 'machines.managed.acquire', role: 'acquire-session-sandbox', input: acquisition },
                admittedReview: { action: 'machines.managed.acquire', role: 'acquire-session-sandbox', surface: 'cli' },
                execute: async (_input, context) => {
                    const port = context.externalActionExecutionAuthorization?.requesterHttpProjection;
                    if (!port) throw new Error('session_acquire_child_http_required');
                    const path = '/v1/machines/managed/controller/admit';
                    const body = { input: acquisition, requestId: crypto.randomUUID(), continuationPresent: false, acquisitionMode: 'resource-bound',
                        presetPolicy: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }, originalActionEnvelope: envelope };
                    const { acquisitionMode: _resourceBoundMode, ...ordinaryEnrollmentBody } = body;
                    for (const [changed, expectedStatus] of [
                        [ordinaryEnrollmentBody, 401],
                        [{ ...body, input: { ...acquisition, selection: { ...acquisition.selection, revision: preset.revision + 1 } } }, 401],
                        [{ ...body, input: { ...acquisition, controller: { ...controller, installationId: crypto.randomUUID() } } }, 401],
                        [{ ...body, originalActionEnvelope: { ...envelope, requestId: crypto.randomUUID() } }, 401],
                        ...(relationship === 'owner' ? [
                            [{ ...body, presetPolicy: { ...body.presetPolicy, wakeOnAcceptedMessage: true } }, 403] as const,
                        ] : []),
                    ] as const) {
                        const changedHeaders = await port.createRequestHeaders({ effectActionId: 'machines.managed.acquire', method: 'POST', path, body: changed });
                        if (!changedHeaders) throw new Error('session_acquire_negative_headers_required');
                        const refused = await app.inject({ method: 'POST', url: path, payload: changed, headers: changedHeaders });
                        expect(refused.statusCode, refused.body).toBe(expectedStatus);
                    }
                    const headers = await port.createRequestHeaders({ effectActionId: 'machines.managed.acquire', method: 'POST', path, body });
                    if (!headers) throw new Error('session_acquire_child_headers_required');
                    const otherAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
                    const otherToken = await auth.createToken(otherAccount.id, undefined, { kind: 'account', authority: 'present_user' });
                    for (const changedHeaders of [
                        { ...headers, [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: 'invalid-installation-signature' },
                        { ...headers, [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: otherToken },
                        { ...headers, [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1({ kind: 'machine', machineId: crypto.randomUUID() }) },
                    ]) {
                        const refused = await app.inject({ method: 'POST', url: path, payload: body, headers: changedHeaders });
                        expect(refused.statusCode, refused.body).toBe(401);
                    }
                    const wrongRole = await invokeHostReviewedChildV1({ parent: { actionId, input: rootInput },
                        context: { surface: 'cli', serverId: homeId, runtimeAccountId: requester.id,
                            externalActionTarget: authorization.binding.target, externalActionExecutionAuthorization: projected },
                        child: { action: 'machines.managed.acquire', role: 'unrelated-placement', input: acquisition },
                        admittedReview: { action: 'machines.managed.acquire', role: 'unrelated-placement', surface: 'cli' },
                        execute: async (_input, childContext) => {
                            const signed = await childContext.externalActionExecutionAuthorization?.requesterHttpProjection
                                ?.createRequestHeaders({ effectActionId: 'machines.managed.acquire', method: 'POST', path, body });
                            if (!signed) throw new Error('wrong_role_headers_required');
                            const refused = await app.inject({ method: 'POST', url: path, payload: body, headers: signed });
                            expect(refused.statusCode, refused.body).toBe(401);
                            return { ok: true, result: null };
                        } });
                    expect(wrongRole).toMatchObject({ ok: true });
                    const admitted = await app.inject({ method: 'POST', url: path, payload: body, headers });
                    expect(admitted.statusCode, admitted.body).toBe(200);
                    expect(admitted.json()).toMatchObject({ machine: { preset: { id: preset.id, revision: preset.revision },
                        controller, custodianAccountId: fixture.account.id, enrollmentAccountId: requester.id,
                        acquisitionMode: 'resource-bound', allocation: 'unsubmitted' }, replayed: false });
                    const correlation = { homeId, managedId: admitted.json().machine.id, expectedIntentRevision: 0,
                        requestId: body.requestId, controller };
                    const submitPath = '/v1/machines/managed/controller/submit';
                    const submitHeaders = await port.createRequestHeaders({ effectActionId: 'machines.managed.acquire',
                        method: 'POST', path: submitPath, body: correlation });
                    if (!submitHeaders) throw new Error('session_acquire_submit_headers_required');
                    const submitted = await app.inject({ method: 'POST', url: submitPath, payload: correlation, headers: submitHeaders });
                    expect(submitted.statusCode, submitted.body).toBe(200);
                    const reportPath = '/v1/machines/managed/controller/report';
                    const resource = { contributionRef: oneOff.selection.launch.provider, schemaVersion: 1, value: { id: 'session-resource' } };
                    const report = { ...correlation, result: { kind: 'bound' }, presetContent: { t: 'plain', v: {
                        v: 1, name: 'Session sandbox', launch: oneOff.selection.launch, nativeResult: { kind: 'bound', resource } } } };
                    for (const changed of [{ ...report, managedId: crypto.randomUUID() }, { ...report, requestId: crypto.randomUUID() }]) {
                        const signed = await port.createRequestHeaders({ effectActionId: 'machines.managed.acquire', method: 'POST', path: reportPath, body: changed });
                        if (!signed) throw new Error('session_acquire_report_negative_headers_required');
                        const refused = await app.inject({ method: 'POST', url: reportPath, payload: changed, headers: signed });
                        expect(refused.statusCode, refused.body).toBe(401);
                    }
                    const reportHeaders = await port.createRequestHeaders({ effectActionId: 'machines.managed.acquire', method: 'POST', path: reportPath, body: report });
                    if (!reportHeaders) throw new Error('session_acquire_report_headers_required');
                    const settled = await app.inject({ method: 'POST', url: reportPath, payload: report, headers: reportHeaders });
                    expect(settled.statusCode, settled.body).toBe(200);
                    expect(settled.json()).toMatchObject({ machine: { allocation: 'bound', acquisitionMode: 'resource-bound' } });
                    const refuseAnotherRoot = async (rootAction: string, rootEnvelope: ExternalActionRequestEnvelopeV1,
                        rootToken = token, rootAccountId = requester.id, childInput = acquisition) => {
                        const otherAuthorization = await mint(app, fixture, rootAction, rootEnvelope, rootToken);
                        const otherProjection = await projectExternalActionRequesterHttpAuthorization({ authorization: otherAuthorization,
                            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: origin, target: otherAuthorization.binding.target,
                            installationId: controller.installationId, privateKey: fixture.keyPair.secretKey, isCurrent: async () => true });
                        if (!otherProjection) throw new Error('other_root_projection_required');
                        const child = await invokeHostReviewedChildV1({ parent: { actionId: rootAction, input: rootEnvelope.input },
                            context: { surface: 'cli', serverId: homeId, runtimeAccountId: rootAccountId,
                                externalActionTarget: otherAuthorization.binding.target, externalActionExecutionAuthorization: otherProjection },
                            child: { action: 'machines.managed.acquire', role: 'acquire-session-sandbox', input: childInput },
                            admittedReview: { action: 'machines.managed.acquire', role: 'acquire-session-sandbox', surface: 'cli' },
                            execute: async (_input, childContext) => {
                                const signed = await childContext.externalActionExecutionAuthorization?.requesterHttpProjection
                                    ?.createRequestHeaders({ effectActionId: 'machines.managed.acquire', method: 'POST', path: reportPath, body: report });
                                if (!signed) throw new Error('other_root_report_headers_required');
                                const refused = await app.inject({ method: 'POST', url: reportPath, payload: report, headers: signed });
                                expect(refused.statusCode, refused.body).toBe(401);
                                return { ok: true, result: null };
                            } });
                        expect(child).toMatchObject({ ok: true });
                    };
                    // A freshly issued token for the same root still cannot
                    // substitute a different reviewed child operand.
                    await refuseAnotherRoot(actionId, envelope, token, requester.id, {
                        ...acquisition, selection: { ...acquisition.selection, revision: preset.revision + 1 } });
                    await refuseAnotherRoot(actionId, { ...envelope, requestId: crypto.randomUUID() });
                    await refuseAnotherRoot('machines.managed.inspect', ExternalActionRequestEnvelopeV1Schema.parse({
                        v: 1, requestId: crypto.randomUUID(), target: envelope.target, input: { homeId, managedId: correlation.managedId } }));
                    expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: fixture.account.id,
                        machineId: controller.machineId, principal: { kind: 'account', accountId: otherAccount.id }, level: 'view' })))
                        .toMatchObject({ kind: 'saved' });
                    expect(await resolveMachineAdmission({ actorAccountId: otherAccount.id, machineId: controller.machineId, requiredRole: 'use' }))
                        .toMatchObject({ kind: 'admitted' });
                    await refuseAnotherRoot(actionId, { ...envelope, requestId: crypto.randomUUID() }, otherToken, otherAccount.id);
                    return { ok: true, result: null };
                } });
            expect(result).toMatchObject({ ok: true });
        } finally { await app.close(); }
    });


});
