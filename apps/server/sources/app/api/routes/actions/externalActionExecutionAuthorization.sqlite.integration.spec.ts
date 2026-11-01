import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createWorkflowActionExecutor } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { createWorkflowRunActionOwner } from '../../../../../../cli/src/session/actions/workflowRunActions';
import { createWorkflowRunStorageTestkit } from '../../../../../../cli/src/daemon/workflows/workflowRunStorage.testkit';
import { createUnavailableActionTransportDeps } from '../../../../../../cli/src/testkit/actionTransportDeps';
import Fastify from "fastify";
import axios from 'axios';
import * as sqliteStorage from '@/storage/prisma';
import { z } from 'zod/mini';
import { createCipheriv, randomBytes } from 'node:crypto';
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
import type { Server, Socket } from "socket.io";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as cliPersistence from '../../../../../../cli/src/persistence';
import { bootstrapAccountSettingsContext } from '../../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';

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
    type ExternalActionExecutionAuthorizationV1,
} from "@happier-dev/protocol/actions";
import { EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1, MACHINE_PLAIN_DATA_KEY_MARKER, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, encodePlainMachineStoredContent, encodePasswordCredentialFieldV1, type AccountPasswordCredentialV1 } from "@happier-dev/protocol";
import { buildSessionOrganizationAssignmentSnapshotHttpRequestV1 } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SOCKET_RPC_EVENTS, SessionActionRpcOriginV1Schema, WorkspaceSyncSourceContextV1Schema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema } from "@happier-dev/protocol/socketRpc";
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachineInstallationProofPayloadV1Schema, signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { registerMachineAdmissionRoutes } from '@/app/api/routes/machines/registerMachineAdmissionRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { SessionRequesterHandoffBootstrapRpcRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { HandoffTargetReplacementPreflightV1Schema, WorkspaceContentPolicyV1Schema,
    computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { createMachineDataEncryptionKeyV1, decodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { packSessionDataKeyBundleV0, serializeSessionDataKeyValue, SESSION_DATA_KEY_NONCE_BYTES } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
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
import { createDiscussion } from '@/app/discussions/mutations';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { registerAccountSettingsRoutes } from "@/app/api/routes/account/registerAccountSettingsRoutes";
import { kvRoutes } from '@/app/api/routes/kv/kvRoutes';
import { SCM_REVIEWED_MARKS_KV_PREFIX, buildScmReviewedMarksKey } from '@happier-dev/protocol/scm/reviewedMarks';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from '@/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4';
import { mutateQualifiedConnectedServiceCredential } from '@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { registerConnectedAccountConfigurationRowsRoutes } from '@/app/account/connectedAccounts/registerConfigurationRowsRoutes';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { writeQualifiedProviderAccountUsageRecord } from '@/app/api/routes/connect/qualifiedConnectedAccounts/usageRepository';
import { createUsageSnapshot } from '@/app/api/routes/connect/providerAccountUsageTestkit';
import { homeGovernanceRoutes } from "@/app/api/routes/home/homeGovernanceRoutes";
import { featuresRoutes } from "@/app/api/routes/features/featuresRoutes";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";
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
import { prepareInstalledRequesterAccountActionContext, prepareRequesterAccountActionContext } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { registerDaemonLocalServicesMachineRpcHandlers } from '../../../../../../cli/src/rpc/handlers/daemonLocalServices';
import { registerActionSpecRpcHandlers } from '../../../../../../cli/src/rpc/handlers/registerActionSpecRpcHandlers';
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
import { registerAccountProfileRoute } from '@/app/api/routes/account/registerAccountProfileRoute';
import { machineUpdateHandler } from "@/app/api/socket/machineUpdateHandler";
import { createAuthenticatedFakeSocket, createFakeSocket, getSocketHandler, createSocketRoomDiscoveryHarness } from "@/app/api/testkit/socketHarness";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveMachineAccess, resolveMachineAdmission, setMachineAccessGrantInTx, removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { readMachineDevcontainerWorkspaceSyncRouteInTx } from '@/app/machines/managed/managedRows';
import { enqueuePendingMessage, deletePendingMessage } from '@/app/session/pending/pendingMessageService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
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
import { encodeAutomationSessionLifecycleConfiguration } from '@/app/automations/automationSessionLifecycleConfigurationCodec';
import { deleteAutomationTrigger } from '@/app/automations/automationCrudService';
import { registerWorkflowRunStorageRoutes } from '@/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { startSocket } from '@/app/api/socket';
import { createSignedPluginInstallationPublisherHeader } from '@/testkit/pluginInstallationPublisherTestkit';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createDaemonSessionAccountActionExecutor } from '../../../../../../cli/src/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createExternalActionAuthorizedRequestHeaders, prepareExternalActionRequesterAccountAuthorization } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { createCliApprovalsArtifactStore } from '../../../../../../cli/src/session/actions/approvals/artifactStore';
import { createAccountServerActionDeps } from '../../../../../../cli/src/api/accountServerActionDeps';
import { fetchAccountProfile } from '../../../../../../cli/src/api/accountProfile';
import { createSessionSubagentCustodyKeyV1 } from '@happier-dev/protocol/sessions/subagents/durableCustodyV1';
import { createDaemonApprovalExecutionOriginCurrentness } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { resolveAvailableAccountSettings } from '../../../../../../cli/src/settings/accountSettings/resolveAvailableAccountSettings';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { encrypt as encryptRpc, decrypt as decryptRpc, encodeBase64 as encodeRpcBase64 } from '../../../../../../cli/src/api/encryption';
import { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '../../../../../../cli/src/api/machine/machineRpcAuthorization';
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

describe("external Action execution authorization", () => {
    let harness: LightSqliteHarness;

    it('keeps an eligibility database outage at 503 through signed-root HTTP admission and accepts the same root after recovery', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const actionId = 'browser.diagnostics.snapshot';
        const envelope = { ...fixture.envelope, input: { browserSessionId: 'browser-session', viewId: 'browser-view' } };
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, app => enableErrorHandlers(app));
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId });
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const body = { v: 1 };
            const request = { method: 'POST' as const, url: path, payload: body,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }) };
            // Fail database IO only; real signed-root admission, eligibility and
            // HTTP failure handling decide whether this is rejection or outage.
            // SQLite snapshot IO uses its own connection, outside the main db
            // proxy. Fail only that persistent-database boundary before reads.
            const readSnapshot = sqliteStorage.withSqliteReadSnapshot;
            const snapshot = vi.spyOn(sqliteStorage, 'withSqliteReadSnapshot')
                .mockImplementationOnce(readSnapshot) // Home environment read precedes signed principal eligibility.
                .mockRejectedValueOnce(Object.assign(new Error('private connection details'), { code: 'P2024' }));
            try {
                const failed = await app.inject(request);
                expect(failed.statusCode).toBe(503);
                expect(JSON.stringify(failed.json())).not.toContain('private connection details');
            } finally { snapshot.mockRestore(); }
            const recovered = await app.inject(request);
            expect(recovered.statusCode).toBe(200);
        } finally { await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('verifies an original Browser Machine root before opening content (%s)', async kind => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, {
            kind, authority: kind === 'account' ? 'present_user' : 'account_automation',
        });
        const actionId = 'browser.diagnostics.snapshot';
        const envelope = { ...fixture.envelope, input: { browserSessionId: 'browser-session', viewId: 'browser-view' } };
        const { app } = await createApp(fixture.team.id);
        const socket = new SocketServer(app.server, { path: '/v1/updates' });
        let prepared: Awaited<ReturnType<typeof prepareRequesterAccountActionContext>> = null;
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId });
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const body = { v: 1 };
            const response = await app.inject({ method: 'POST', url: path, payload: body,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }) });
            expect(response.statusCode).toBe(200);
            const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
            prepared = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                machineId: fixture.machine.id, installationId: fixture.machine.installationId!, installationPrivateKey: fixture.keyPair.secretKey,
                serverId: 'browser-verification', serverIdentityId: authorization.binding.serverIdentityId, serverHttpBaseUrl,
                ownCredentials: { token, encryption: null },
                isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization, effectActionId: actionId,
                    target: authorization.binding.target, installationId: fixture.machine.installationId!,
                    privateKey: fixture.keyPair.secretKey, serverHttpBaseUrl }),
                createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'diagnostic-only', error: 'diagnostic-only' }) }),
            });
            expect(prepared).not.toBeNull();
        } finally {
            await prepared?.dispose();
            await new Promise<void>(resolve => socket.close(() => resolve()));
            await app.close();
        }
    });

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
            label: input.qualifiedPat ? "qualified" : "ordinary",
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
        expect(response.statusCode).toBe(200);
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
                installationId: request.installationId,
                requestId: request.requestId,
            }),
        };
    }

    it('admits retained registry installation through the signed Account root and real target executor without exposing RPC', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const actionId = 'prompt_registry.install';
        // Installation-local Settings are an OS persistence boundary. They
        // identify this receiver, not an Action-input-selected destination.
        const installationSettings = vi.spyOn(cliPersistence, 'readSettings').mockResolvedValue({
            schemaVersion: cliPersistence.SUPPORTED_SCHEMA_VERSION, onboardingCompleted: true, machineId: fixture.machine.id,
        });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: null } as const;
        const homeId = await getOrCreateServerIdentityId();
        await db.machine.update({ where: { id: fixture.machine.id }, data: { active: true, lastActiveAt: new Date(),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        let serverHttpBaseUrl = '';
        let targetExecutor: ReturnType<typeof createCliActionExecutorFromCredentials> | null = null;
        const reached: string[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io: createSocketRoomDiscoveryHarness(async () => []),
            forwardRpc: async ({ callParams }) => {
                // Substitute the daemon network only. Issuance, installation proof,
                // target/currentness admission and the CLI Action host remain real.
                const request = callParams as ExternalActionDaemonDispatchRequest;
                if (!targetExecutor) throw new Error('Real target executor is not initialized');
                reached.push(request.actionId);
                const result = await executeExternalAction({ actionId: request.actionId, envelope: request.envelope,
                    principal: request.principal, executionAuthorization: request.executionAuthorization,
                    currentMachineId: fixture.machine.id, currentInstallationId: fixture.machine.installationId!,
                    currentServerId: 'registry-admission-profile', currentAccountId: fixture.account.id,
                    currentServerHttpBaseUrl: serverHttpBaseUrl, externalActionMachineRequestPrivateKey: fixture.keyPair.secretKey,
                    verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
                        privateKey: fixture.keyPair.secretKey, installationId: fixture.machine.installationId!, serverHttpBaseUrl }),
                    resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
                    executor: targetExecutor,
                });
                if (result.kind !== 'response') throw new Error(`Signed root target refused: ${JSON.stringify(result)}`);
                return { ok: true, result: createExternalActionDaemonDispatchResponse(result.prepared) };
            } });
        const { app } = await createApp(fixture.team.id, false, undefined, dispatch, false, routes => registerPromptLibraryRoutes(routes));
        try {
            serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
            const settings = await app.inject({ method: 'POST', url: '/v2/account/settings',
                headers: { authorization: `Bearer ${token}`, ...currentAccountStoredContentCompatibilityHeaders }, payload: { expectedVersion: 0,
                    content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
                        approvalWaivedSurfaces: { [actionId]: ['ui'] } } } } } });
            expect(settings.statusCode, settings.body).toBe(200);
            await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking' }));
            targetExecutor = createCliActionExecutorFromCredentials({ credentials, serverId: 'registry-admission-profile',
                serverApiUrl: serverHttpBaseUrl, serverIdentityId: homeId, readCredentials: async () => credentials,
                machineId: fixture.machine.id,
                externalActionMachineRequestPrivateKey: fixture.keyPair.secretKey,
                externalActionMachineInstallationId: fixture.machine.installationId!,
                pluginActionExecutionOwner: 'current_process' });
            const input = getActionSpec(actionId).inputSchema.parse({ machineId: fixture.machine.id,
                sourceId: 'missing-registry-source', itemId: 'missing-registry-item' });
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ ...fixture.envelope, input });
            const response = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(envelope) });
            expect(response.statusCode, response.body).toBe(200);
            const produced = ExternalActionResponseEnvelopeV1Schema.parse(response.json());
            expect(reached).toEqual([actionId]);
            // The missing source is a domain refusal after the UI-enabled
            // Action executes, not a surface/catalog/transport admission denial.
            expect(produced.execution).toMatchObject({ ok: false, errorCode: 'invalid_source',
                details: { registryStatus: { state: 'invalid_source' } } });
            expect(getActionSpec(actionId).surfaces.rpc).toBe(false);
        } finally { installationSettings.mockRestore(); await app.close(); }
    });

    it('runs unsigned UI setup approval through exact-daemon replay and real Home preparation admission', async () => {
        await db.account.create({ data: { id: 'account', publicKey: null, encryptionMode: 'plain' } });
        const token = await auth.createToken('account', undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const { app } = await createApp('unused-team');
        const httpReads: Array<{ root: string | null; effect: string; path: string; status: number }> = [];
        const h = await createInstalledProjectApprovalHarness('projects.script.run', 'allowed', true, homeId, {
            token,
            mintAuthorization: async (actionId, envelope) => {
                const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: 'machine', envelope } });
                expect(issued.statusCode, issued.body).toBe(200);
                return ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            },
            request: async input => {
                const response = await app.inject({ method: input.method, url: input.path, headers: input.headers,
                    ...(input.body === undefined ? {} : { payload: JSON.stringify(input.body) }) });
                const binding = await auth.verifyExternalActionExecutionAuthorization(input.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]!);
                httpReads.push({ root: binding?.actionId ?? null, effect: input.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]!,
                    path: input.path, status: response.statusCode });
                return { status: response.statusCode, data: response.json() };
            },
        });
        let operationId: string | undefined;
        try {
            await db.machine.create({ data: { id: 'machine', accountId: 'account',
                metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
                dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), metadataVersion: 1,
                installationId: h.installation.installationId,
                installationPublicKey: new Uint8Array(Buffer.from(h.installation.publicKey, 'base64url')) } });
            const key = { kind: 'workspace-ref', serverId: homeId, id: h.ref.id } as const;
            const graphKey = { kind: 'relationship-graph' } as const;
            const seeded = await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate',
                headers: { authorization: `Bearer ${token}` }, payload: ProjectAccountRowMutationRequestV1Schema.parse({ mutations: [
                    { key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: h.ref } } },
                    { key: graphKey, expectedRevision: 'absent', content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } },
                ], expectedRefs: [], topologyChange: true }) });
            expect(seeded.statusCode, seeded.body).toBe(200);
            const workspace = { serverId: homeId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath };
            const reviewed = await h.reviewSetup();
            expect(reviewed.kind).toBe('reviewed');
            if (reviewed.kind !== 'reviewed') throw new Error('Setup review unavailable');
            const setup = await h.run({ workspace, phase: 'setup', expectedEffectDigest: reviewed.plan.reviewedEffectDigest,
                consentScope: 'thisTime' }, 'ui', 'unsigned-ui', 'present_user', 'projects.prepare', 'this-time-setup');
            expect(setup).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'projects.prepare' } });
            expect((await h.approval()).preview).toMatchObject({ setupReview: {
                reviewedEffectDigest: reviewed.plan.reviewedEffectDigest,
                reviewedEffect: { commands: [{ kind: 'command', command: 'echo setup-reviewed' }] },
            } });
            expect(await h.decide('approve')).toMatchObject({ ok: true });
            const execution = (await h.approval()).execution;
            expect(execution, JSON.stringify({ execution, httpReads: httpReads.filter(read => !read.path.endsWith('/verify')) }))
                .toMatchObject({ ok: true, result: { operation: { actionId: 'projects.prepare' } } });
            if (!execution?.ok) throw new Error('Setup replay refused');
            const setupOperation = ProjectCommandActionOutputV1Schema.parse(execution.result).operation;
            operationId = setupOperation.operationId;
            (await h.waitForSpawn(0)).exit(0);
            expect(await h.waitForTerminal(setupOperation.operationId)).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
            expect(httpReads).toContainEqual({ root: 'approval.request.decide', effect: 'approval.request.decide',
                path: '/v1/account/project-rows/list', status: 200 });
            expect(h.networkPaths).not.toContain('POST /v1/account/project-trust/mutate');
        } finally {
            if (operationId) await h.cancelOperation(operationId);
            await h.close();
            await app.close();
        }
    });

    it('admits only the reviewed Move destination status under its unchanged SOURCE root and current access', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const workerKey = tweetnacl.sign.keyPair();
        const worker = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(workerKey.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: worker.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const workspace = { serverId: homeId, refId: 'reviewed-source' };
        const request = ProjectServiceRelocateInputV1Schema.parse({ workspace, serviceName: 'api', requestId: 'reviewed-move',
            currentTarget: { kind: 'managed_service', machineId: fixture.machine.id, managedServiceId: 'exact-native-instance',
                workspaceId: workspace.refId, cwd: '/source', declaration: { workspaceRefId: workspace.refId,
                    selection: { kind: 'manifest', name: 'api' } } },
            destination: { kind: 'workers', destination: { kind: 'machine', machineId: worker.id } }, selectedTarget: { machineId: worker.id },
            desiredPlacement: { workspace, serviceName: 'api', expectedRevision: 'absent', expected: { kind: 'absent' },
                value: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: worker.id } }, unavailable: 'fail' } } });
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ ...fixture.envelope, input: request });
        const { app } = await createApp(fixture.team.id);
        try {
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('projects.service.relocate'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const spec = getActionSpec('projects.worker.status');
            const params = spec.inputSchema.parse({ workspace, destination: { kind: 'machine', machineId: worker.id }, purpose: 'service-start' });
            const method = `${worker.id}:${spec.bindings!.rpcMethod}`;
            const verify = (overrides: { params?: unknown; method?: string; effectActionId?: string; privateKey?: Uint8Array } = {}) => {
                const actualMethod = overrides.method ?? method;
                const actualParams = overrides.params ?? params;
                const effectActionId = overrides.effectActionId ?? 'projects.worker.status';
                const execution = { v: 1 as const, authorization, effectActionId, target: authorization.binding.target,
                    installationId: authorization.binding.installationId, machineSignature: signExternalActionMachineRpcRequestV1({
                        authorizationToken: authorization.token, effectActionId, target: authorization.binding.target,
                        installationId: authorization.binding.installationId, method: actualMethod, requestId: 'move-child', params: actualParams,
                        privateKey: overrides.privateKey ?? fixture.keyPair.secretKey }) };
                const proof = { method: actualMethod, params: actualParams, requestId: 'move-child', originalActionEnvelope: envelope };
                return verifyExternalActionMachineRpcExecution(execution, proof);
            };
            expect(await verify()).toMatchObject({ binding: authorization.binding, effectActionId: 'projects.worker.status' });
            expect(await verify({ method: `unrelated:${spec.bindings!.rpcMethod}` })).toBeNull();
            expect(await verify({ effectActionId: 'projects.worker.copy.retire' })).toBeNull();
            expect(await verify({ params: { ...params, workspace: { ...workspace, refId: 'other-service-workspace' } } })).toBeNull();
            expect(await verify({ privateKey: workerKey.secretKey })).toBeNull();
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: worker.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            expect(await verify()).toBeNull();
        } finally { await app.close(); }
    });

    it('settles signed same-Machine Move placement through the real daemon route and Home CAS before returning unchanged', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const credentials = { token, encryption: null };
        const workspace = { id: 'move-source', serverId: homeId, machineId: fixture.machine.id,
            rootPath: '/workspace/project', projectKey: 'project', createdAtMs: 1 };
        const key = { kind: 'workspace-ref', serverId: homeId, id: workspace.id } as const;
        const graphKey = { kind: 'relationship-graph' } as const;
        const http: Array<{ method: string; path: string; status: number }> = [];
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, app => {
            app.addHook('onResponse', async (request, reply) => { http.push({ method: request.method,
                path: request.url, status: reply.statusCode }); });
        });
        const owner = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            // Literal native lifecycle below never requests plugin dependencies.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope });
        let stops = 0;
        let restoreHttp: (() => void) | undefined;
        const network = await createRequesterCurrentnessSocketHarness();
        let requesterContext: Awaited<ReturnType<typeof prepareRequesterAccountActionContext>> = null;
        try {
            const seeded = await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate',
                headers: { authorization: `Bearer ${token}` }, payload: ProjectAccountRowMutationRequestV1Schema.parse({ mutations: [
                    { key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: workspace } } },
                    { key: graphKey, expectedRevision: 'absent', content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } },
                ], expectedRefs: [], topologyChange: true }) });
            expect(seeded.statusCode, seeded.body).toBe(200);
            expect(seeded.json()).toMatchObject({ status: 'updated' });
            const handle = await owner.superviseProject({ workspace, declaration: { workspaceRefId: workspace.id,
                selection: { kind: 'manifest', name: 'api' } }, cwd: workspace.rootPath, serviceId: 'api', specIdentity: 'api',
                execution: 'portable', isCurrent: () => true,
                requester: { serverId: homeId, accountId: fixture.account.id, machineId: fixture.machine.id,
                    installationId: fixture.machine.installationId! },
                processSpec: { mode: { kind: 'native', instance: { adapter: { pluginId: 'fixture.plugin', localId: 'api' },
                    nativeResourceId: 'existing-api' }, lifecycle: {
                    inspect: async () => ({ phase: 'running', readiness: 'not_reported', endpoint: null }),
                    stop: async () => { stops++; return { status: 'stopped' }; },
                } } }, authorizeLaunch: async () => ({ command: process.execPath, args: [], env: {}, release: async () => {} }) });
            const request = ProjectServiceRelocateInputV1Schema.parse({ workspace: { serverId: homeId, refId: workspace.id },
                serviceName: 'api', requestId: 'same-machine-move', currentTarget: { kind: 'managed_service',
                    managedServiceId: handle.instanceId, machineId: workspace.machineId, workspaceId: workspace.id,
                    cwd: handle.cwd, declaration: handle.declaration }, destination: { kind: 'primary' },
                selectedTarget: { machineId: workspace.machineId }, desiredPlacement: {
                    workspace: { serverId: homeId, refId: workspace.id }, serviceName: 'api', expectedRevision: 'absent',
                    expected: { kind: 'absent' }, value: { runsOn: { kind: 'primary' }, unavailable: 'fail' } } });
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ ...fixture.envelope, input: request });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('projects.service.relocate'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: workspace.machineId, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId });
            restoreHttp = installAxiosFastifyAdapter({ app, origin: 'https://move-home.test' });
            // The Machine HTTP boundary supplies this exact registered plain Machine;
            // all signed mode/config requests use the real Home authentication/routes/DB.
            const get = axios.get.bind(axios);
            const publishedMachine = serializeMachineRow(fixture.machine, { storageMode: 'plain' });
            vi.spyOn(axios, 'get').mockImplementation((url, config) => new URL(String(url)).pathname.startsWith('/v1/machines/')
                ? Promise.resolve({ status: 200, data: { machine: publishedMachine } }) : get(url, config));
            const gate = createLocalServicesDaemonFeatureGate({ env: {}, onError: error => { throw error; }, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
                features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                    managed: { enabled: true }, launcher: { enabled: true }, actions: { enabled: true } },
                    browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
            await gate.refresh();
            const executor = createActionExecutor({ ...createAccountServerActionDeps({ token, credentials,
                serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'https://move-home.test',
                externalActionMachineRequestPrivateKey: fixture.keyPair.secretKey,
                externalActionMachineInstallationId: fixture.machine.installationId! }),
                runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate: gate,
                    ingress: { signal: new AbortController().signal }, routes: {
                        relocateService: createProjectServiceRelocationRoute({ serverBaseUrl: 'https://move-home.test', credentials,
                            projectManagedServices: owner, resolveWorkspaceSyncHandoffAdapter: () => null }),
                    } }),
            });
            requesterContext = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                machineId: fixture.machine.id, installationId: fixture.machine.installationId!, installationPrivateKey: fixture.keyPair.secretKey,
                ownCredentials: credentials, serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'https://move-home.test',
                isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization, effectActionId: authorization.binding.actionId,
                    target: authorization.binding.target, installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey,
                    serverHttpBaseUrl: 'https://move-home.test' }), createExecutor: () => executor });
            expect(requesterContext, 'Original SOURCE requester custody must be admitted by real Home').not.toBeNull();
            if (!requesterContext) throw new Error('SOURCE requester custody unavailable');
            // Already-approved Move replay, preserving its exact signed root for children.
            const context = { surface: 'ui' as const, authority: 'present_user' as const, bypassApprovals: true,
                serverId: homeId, runtimeAccountId: fixture.account.id, actionRequestId: envelope.requestId,
                externalActionExecutionAuthorization: requesterContext.authorization, externalActionTarget: envelope.target,
                presentUserConfirmation: { actionId: 'projects.service.relocate' as const } };
            const result = await executor.execute('projects.service.relocate', request, context);
            expect(result, JSON.stringify({ result, http })).toMatchObject({ ok: true, result: { status: 'unchanged', currentTarget: request.currentTarget } });
            if (!result.ok) throw new Error('Move refused');
            expect(ProjectServiceRelocateResultV1Schema.parse(result.result)).toEqual({ status: 'unchanged', currentTarget: request.currentTarget });
            expect(await executor.execute('projects.service.relocate', request, context)).toEqual(result);
            expect(http.filter(row => row.path === '/v1/projects/execution/config/mutate')).toEqual([
                { method: 'POST', path: '/v1/projects/execution/config/mutate', status: 200 },
            ]);
            expect(stops).toBe(0);
            expect(handle.snapshot().state).not.toBe('stopped');
            // Move's config transport is not another effect, arbitrary Account
            // metadata mutation, or authority to accept a different installation key.
            const signed = (path: string, method: 'GET' | 'POST', body: unknown, effectActionId = 'projects.service.relocate',
                privateKey = fixture.keyPair.secretKey) => app.inject({ method, url: path,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId, method, path, body, privateKey }),
                ...(body === undefined ? {} : { payload: body }) });
            expect((await signed('/v1/account/encryption', 'GET', undefined, 'projects.service.placement.set')).statusCode).toBe(401);
            // An exact SOURCE Move root does not grant a destination worker effect.
            // Both a different effect on SOURCE and a remote Machine with the root
            // effect remain closed; changing dispatch cannot manufacture this grant.
            expect((await signed('/v1/account/encryption', 'GET', undefined, 'projects.worker.status')).statusCode).toBe(401);
            const remoteMachineRead = await app.inject({ method: 'GET', url: '/v1/account/encryption',
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: 'projects.service.relocate',
                    method: 'GET', path: '/v1/account/encryption', body: undefined, privateKey: fixture.keyPair.secretKey,
                    target: { kind: 'machine', machineId: 'different-worker' } }) });
            expect(remoteMachineRead.statusCode, remoteMachineRead.body).toBe(401);
            const workerMethod = `${'different-worker'}:${getActionSpec('projects.worker.status').bindings!.rpcMethod}`;
            const workerParams = getActionSpec('projects.worker.status').inputSchema.parse({ workspace: request.workspace,
                destination: { kind: 'machine', machineId: 'different-worker' }, purpose: 'service-start' });
            for (const target of [authorization.binding.target, { kind: 'machine' as const, machineId: 'different-worker' }]) {
                const effectActionId = 'projects.worker.status';
                const execution = { v: 1 as const, authorization, effectActionId, target,
                    installationId: fixture.machine.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                        authorizationToken: authorization.token, effectActionId, target, installationId: fixture.machine.installationId!,
                        method: workerMethod, requestId: envelope.requestId, params: workerParams, privateKey: fixture.keyPair.secretKey }) };
                expect(await verifyExternalActionMachineRpcExecution(execution, { method: workerMethod,
                    requestId: envelope.requestId, params: workerParams })).toBeNull();
            }
            expect((await signed('/v1/account/encryption', 'GET', undefined, 'projects.service.relocate',
                tweetnacl.sign.keyPair().secretKey)).statusCode).toBe(401);
            const unrelatedMutation = await signed('/v1/account/project-rows/mutate', 'POST', {
                mutations: [{ key, expectedRevision: 1, content: { t: 'plain', v: { key, value: workspace } } }],
                expectedRefs: [], topologyChange: false,
            });
            expect(unrelatedMutation.statusCode, unrelatedMutation.body).toBe(401);
        } finally {
            await requesterContext?.dispose();
            await network.close();
            restoreHttp?.();
            await owner.dispose();
            await app.close();
        }
    });

    it.each([['SOURCE-to-worker', 'account', 'current'], ['worker-to-SOURCE', 'account', 'current'],
        ['SOURCE-to-worker', 'terminal', 'current'], ['SOURCE-to-worker', 'account', 'revoked-after-placement']] as const)(
        'moves the reviewed Service %s through two installed executors and signed Home transport (%s requester; %s)', async (direction, requesterKind, currentness) => {
        const fixture = await createFixture({ qualifiedPat: false });
        const homeId = await getOrCreateServerIdentityId();
        const accountToken = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const token = requesterKind === 'account' ? accountToken
            : await auth.createToken(fixture.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const credentials = { token, encryption: null } as const;
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const workerKeys = tweetnacl.sign.keyPair();
        const worker = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            active: true, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(workerKeys.publicKey) } });
        await db.machine.update({ where: { id: fixture.machine.id }, data: { active: true } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: worker.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const workerToken = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        const directory = await mkdtemp(join(tmpdir(), 'happier-signed-service-move-'));
        const sourceRoot = join(directory, 'source');
        const workerRoot = join(directory, 'worker');
        await Promise.all([mkdir(join(sourceRoot, '.happier'), { recursive: true }), mkdir(workerRoot)]);
        await writeFile(join(sourceRoot, '.happier/project.json'), JSON.stringify({ version: 1, services: { api: {
            execution: 'portable', source: { kind: 'command', command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"` },
        } } }));
        await cp(join(sourceRoot, '.happier'), join(workerRoot, '.happier'), { recursive: true });
        const sourceRef = { id: 'reviewed-source-ref', serverId: homeId, machineId: fixture.machine.id,
            rootPath: sourceRoot, projectKey: 'move-project', createdAtMs: 1 };
        const workerRef = { ...sourceRef, id: 'reviewed-worker-ref', machineId: worker.id, rootPath: workerRoot };
        const refs = [sourceRef, workerRef];
        const basePolicy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const relationship = { v: 1 as const, relationshipId: 'reviewed-service-copy', controllerMachineId: fixture.machine.id,
            alphaWorkspaceRefId: sourceRef.id, betaWorkspaceRefId: workerRef.id, mode: 'keep_synced' as const, enabled: true,
            provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: sourceRef.id, targetWorkspaceRefId: workerRef.id },
            contentPolicy: { ...basePolicy, policyDigest: computeWorkspaceSyncPolicyDigest(basePolicy) }, createdAtMs: 1, updatedAtMs: 1 };
        const effects: string[] = [];
        const phases: string[] = [];
        let incumbentSnapshot: (() => Readonly<{ state: string }>) | undefined;
        const preparationObservations: Array<{ oldState?: string; liveDestinations: number }> = [];
        const admittedPackets: SocketRpcRequestPayload[] = [];
        const homeResponses: Array<{ path: string; status: number }> = [];
        const relayRequests: string[] = [];
        const outgoingPackets: SocketRpcRequestPayload[] = [];
        let receiversAtPlacement: number | undefined;
        const receiverDiagnostics: Array<{ method?: unknown; outcome?: unknown; admission?: unknown }> = [];
        const startObservations: Array<{ machineId: string; status?: unknown; reason?: unknown; context: unknown }> = [];
        const operationObservations: unknown[] = [];
        const network = await createRequesterCurrentnessSocketHarness();
        const localInstallation = new AsyncLocalStorage<ReturnType<typeof installationStore.readInstallationIdentityIfExistsSync>>();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(() => localInstallation.getStore() ?? null);
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, routes => {
            routes.addHook('onResponse', async (request, reply) => { homeResponses.push({ path: request.url, status: reply.statusCode }); });
            routes.addHook('onSend', async (request, reply, payload) => {
                if (currentness === 'revoked-after-placement' && request.url === '/v1/projects/execution/config/mutate' && reply.statusCode === 200) {
                    receiversAtPlacement = admittedPackets.length;
                    await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
                }
                return payload;
            });
        }, true);
        const origin = 'https://signed-move-home.test';
        const restoreHttp = installAxiosFastifyAdapter({ app, origin });
        const owners: ReturnType<typeof createManagedServicesOwner>[] = [];
        const terminals: ReturnType<typeof createTerminalPtySessionManager>[] = [];
        const privateContexts: Array<{ dispose(): Promise<void> }> = [];
        try {
            const graphKey = { kind: 'relationship-graph' } as const;
            const seeded = await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate',
                headers: { authorization: `Bearer ${accountToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                payload: ProjectAccountRowMutationRequestV1Schema.parse({ mutations: [
                    ...refs.map(value => { const key = { kind: 'workspace-ref' as const, serverId: homeId, id: value.id };
                        return { key, expectedRevision: 'absent' as const, content: { t: 'plain' as const, v: { key, value } } }; }),
                    { key: graphKey, expectedRevision: 'absent', content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } },
                ], expectedRefs: [], topologyChange: true }) });
            expect(seeded.statusCode, seeded.body).toBe(200);
            const nativeIo = createProjectNativeIo();
            const machines = [{ machine: fixture.machine, keys: fixture.keyPair, daemonToken: accountToken, ref: sourceRef },
                { machine: worker, keys: workerKeys, daemonToken: workerToken, ref: workerRef }];
            const installed = [];
            for (const member of machines) {
                const { machine, keys, daemonToken, ref } = member;
                const identity = { version: 1 as const, installationId: machine.installationId!, createdAt: 1,
                    publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') };
                const owner = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
                    dependencies: Object.freeze({}) as never, resolveScope: scope => scope });
                owners.push(owner);
                const terminalSessions = createTerminalPtySessionManager({ config: readDaemonTerminalPtyConfig({}).sessionManager,
                    // This manifest has no setup and never requests a PTY.
                    ptyProvider: { spawn() { throw new Error('Unexpected setup process'); } }, env: {}, platform: 'linux' });
                terminals.push(terminalSessions);
                const operationRuntime = createHostActionOperationRuntime({ machineId: machine.id,
                    publishSnapshot: snapshot => operationObservations.push({ machineId: machine.id,
                        actionId: snapshot.actionId, state: snapshot.state, observation: snapshot.observation }),
                    custodyBinding: { serverId: homeId, installationId: machine.installationId! }, resolveAccountId: async () => fixture.account.id });
                const admission = createProjectWorkerAdmission({ machineId: machine.id, admissionDrain: createDaemonAdmissionDrain(),
                    readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) });
                const prepareBetween: NonNullable<Parameters<typeof createWorkspaceSyncHandoffAdapter>[0]['prepareBetween']> = (request, signal) => {
                    effects.push('prepare');
                    const newOwner = direction === 'SOURCE-to-worker' ? owners[1] : owners[0];
                    preparationObservations.push({ oldState: incumbentSnapshot?.().state,
                        liveDestinations: newOwner?.listProjectServices().length ?? 0 });
                    return prepareWorkspaceSyncBetween({ ...request, signal, serverId: homeId,
                        readCurrent: () => runWithServerHttpBaseUrl(origin, () => readProjectAccountRows({ credentials,
                            serverId: homeId, signal })),
                        // Filesystem/native Sync-engine boundary only. The real preparation
                        // owner resolves, rechecks and observes clean route completion.
                        flush: async () => {
                            await cp(join(sourceRoot, '.happier'), join(workerRoot, '.happier'), { recursive: true });
                            return { relationshipId: relationship.relationshipId, controllerMachineId: fixture.machine.id,
                                state: 'watching', alphaPath: sourceRoot, betaPath: workerRoot, mode: relationship.mode,
                                endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                                    beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
                                conflictCount: 0, lastCycleObservedAtMs: null };
                        } });
                };
                const adapter = createWorkspaceSyncHandoffAdapter({
                    // Only the incumbent prepareBetween port is reached by Move.
                    sync: Object.freeze({}) as never, prepareBetween,
                    bootstrap: async () => { throw new Error('Move must not bootstrap a relationship'); },
                });
                const api = await runWithServerHttpBaseUrl(origin, () => ApiClient.create({ token: daemonToken, encryption: null }));
                const runtime = createInstalledProjectFiniteRuntime({ api, credentials: { token: daemonToken, encryption: null },
                    externalActionAccountId: machine.accountId, finiteServerId: homeId, finiteServerHttpBaseUrl: origin,
                    registeredMachineId: machine.id, admission, nativeIo, successHomeDir: join(directory, machine.id, 'success'),
                    isCurrent: async () => true, prepareBetween,
                    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: machine.id }) });
                const starter = createProjectServiceDeclarationStarter({
                    resolveRuntime: ingress => runtime({ operationRuntime, terminalSessions }, ingress),
                    acquirePluginRuntime: async () => ({ registry: { projectManagedServices: owner }, release: async () => {} }),
                });
                const inventory = createLocalServiceInventoryRegistry();
                const launcher = createLocalServiceLauncherRoutes({ ...starter, feed: createLocalServiceLauncherFeed({ machineId: machine.id,
                    inventoryRegistry: inventory, previewRegistry: createLocalServicePreviewRegistry(), projectManagedServices: owner }) });
                const actions = createLocalServiceActionRoutes({ machineId: machine.id, projectManagedServices: owner,
                    inventoryRegistry: inventory,
                    verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
                const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
                    features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                        managed: { enabled: true }, launcher: { enabled: true }, actions: { enabled: true } },
                        browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
                await gate.refresh();
                const buildExecutor = (ingress: RpcHandlerContext) => createCliActionExecutor({ token, credentials,
                    serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: origin, sessionId: 'cli-global', mode: 'plain', ctx: null,
                    runtimeActionMachineId: machine.id, externalActionMachineInstallationId: machine.installationId!,
                    externalActionMachineRequestPrivateKey: keys.secretKey, pluginActionExecutionOwner: 'current_process',
                    accountServerActionDeps: createAccountServerActionDeps({ token, credentials, serverId: homeId, serverIdentityId: homeId,
                        serverHttpBaseUrl: origin, externalActionMachineRequestPrivateKey: keys.secretKey,
                        externalActionMachineInstallationId: machine.installationId! }),
                    projectWorkerAction: createProjectWorkerAction({ machineId: machine.id, serverId: homeId, serverHttpBaseUrl: origin,
                        credentials, accountId: fixture.account.id, admission, isFiniteExecutionLive: () => true, isServiceExecutionLive: () => true }),
                    runtimeActionExecute: async args => {
                        if (args.actionId === 'localServices.launcher.start') startObservations.push({ machineId: machine.id,
                            status: 'entered', context: { surface: args.context.surface, authority: args.context.authority,
                                bypassApprovals: args.context.bypassApprovals, confirmation: args.context.presentUserConfirmation?.actionId,
                                rootActionId: args.context.externalActionExecutionAuthorization?.binding.actionId } });
                        const result = await createLocalServicesDaemonRuntimeActionExecutor({ featureGate: gate,
                        ingress: { ...ingress, ...args.context as RpcActionExecutorContext,
                            signal: args.context.signal ?? ingress.signal },
                        routes: { launcherRoutes: launcher, actionRoutes: actions,
                            relocateService: createProjectServiceRelocationRoute({ serverBaseUrl: origin, credentials,
                                projectManagedServices: owner, resolveWorkspaceSyncHandoffAdapter: () => adapter }) } })(args);
                        if (args.actionId === 'localServices.launcher.start' && result && typeof result === 'object') {
                            startObservations.push({ machineId: machine.id, status: Reflect.get(result, 'status'),
                                reason: Reflect.get(result, 'reasonCode'), context: { surface: args.context.surface,
                                    authority: args.context.authority, bypassApprovals: args.context.bypassApprovals,
                                    confirmation: args.context.presentUserConfirmation?.actionId,
                                    rootActionId: args.context.externalActionExecutionAuthorization?.binding.actionId } });
                        }
                        return result;
                    },
                });
                const rpc = new RpcHandlerManager({ scopePrefix: machine.id, localMachineId: machine.id, encryptionMode: 'plain',
                    logger: (message, data) => {
                        if (message === '[RPC] Request completed' && data && typeof data === 'object') {
                            receiverDiagnostics.push({ method: Reflect.get(data, 'method'), outcome: Reflect.get(data, 'outcomeCode'),
                                admission: Reflect.get(data, 'admissionPredicate') });
                        }
                    },
                    authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: machine.id,
                        resolveCustodianAccountId: async () => machine.accountId, resolveInstallationId: () => machine.installationId,
                        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: keys.secretKey,
                            daemonToken, serverHttpBaseUrl: origin }) }),
                    prepareRequesterAccountContext: async request => {
                        if (!request.verifyServiceMoveChildCurrent) return null;
                        return await prepareInstalledRequesterAccountActionContext({ ...request,
                            purpose: request.purpose ?? { kind: 'external_action' }, machineId: machine.id,
                            serverId: homeId, serverHttpBaseUrl: origin,
                            resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: machine.id, serverIdentityId: homeId }),
                            createExecutor: () => buildExecutor({ signal: request.signal ?? new AbortController().signal }),
                        });
                    },
                });
                registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId: machine.id, serverId: homeId, accountId: machine.accountId,
                    projectManagedServices: owner, localServicesLauncher: launcher, localServicesActions: actions,
                    resolveLauncherActionExecutor: request => {
                        if (!request.ingress) throw new Error('Receiving transport ingress required');
                        return buildExecutor(request.ingress);
                    } });
                registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionIds: ['projects.worker.status'],
                    targetMachineId: machine.id, defaultMachineTarget: true, resolveActionExecutor: request => {
                        if (!request.ingress) throw new Error('Receiving transport ingress required');
                        return buildExecutor(request.ingress);
                    } });
                const receiver = { id: `move-receiver-${machine.id}`, data: { clientType: 'machine-scoped', machineId: machine.id,
                    verifiedMachineInstallationId: machine.installationId }, timeout: () => ({
                    emitWithAck: async (_event: string, packet: SocketRpcRequestPayload) => {
                        admittedPackets.push(packet);
                        return await localInstallation.run(identity, () => rpc.handleRequest(packet));
                    },
                }) };
                qualifyCurrentAccountStoredContentSocket(receiver);
                installed.push({ ...member, identity, owner, rpc, receiver, buildExecutor });
            }
            const io = createSocketRoomDiscoveryHarness(async room => installed.filter(member => room === member.receiver.id
                || room.startsWith(`rpc:${member.machine.accountId}:${member.machine.id}:`)).map(member => member.receiver));
            network.server.on('connection', socket => {
                socket.data = { clientType: 'user-scoped', authTokenKind: requesterKind,
                    authAuthority: requesterKind === 'account' ? 'present_user' : 'account_automation' };
                qualifyCurrentAccountStoredContentSocket(socket);
                socket.on(SOCKET_RPC_EVENTS.CALL, (packet: SocketRpcRequestPayload) => {
                    relayRequests.push(String(packet?.method));
                    outgoingPackets.push(packet);
                });
                registerSocketRpcHandlers({ userId: fixture.account.id, socket, io });
            });
            const old = installed[direction === 'SOURCE-to-worker' ? 0 : 1]!;
            const destination = installed[direction === 'SOURCE-to-worker' ? 1 : 0]!;
            let phase: 'running' | 'stopped' = 'running';
            const incumbent = await old.owner.superviseProject({ workspace: old.ref,
                declaration: { workspaceRefId: old.ref.id, selection: { kind: 'manifest', name: 'api' } }, cwd: old.ref.rootPath,
                serviceId: 'api', specIdentity: 'api', execution: 'portable', isCurrent: () => true,
                requester: { serverId: homeId, accountId: fixture.account.id, machineId: old.machine.id, installationId: old.machine.installationId! },
                processSpec: { mode: { kind: 'native', instance: { adapter: { pluginId: 'fixture.plugin', localId: 'api' }, nativeResourceId: 'incumbent-api' },
                    lifecycle: { inspect: async () => ({ phase, readiness: 'not_reported', endpoint: null }),
                        stop: async () => { effects.push('stop'); phase = 'stopped'; return { status: 'stopped' }; } } } },
                authorizeLaunch: async () => ({ command: process.execPath, args: [], env: {}, release: async () => {} }) });
            incumbentSnapshot = () => incumbent.snapshot();
            const workspace = { serverId: homeId, refId: sourceRef.id };
            const placement = direction === 'SOURCE-to-worker'
                ? { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: worker.id } } : { kind: 'primary' as const };
            const request = ProjectServiceRelocateInputV1Schema.parse({ workspace, serviceName: 'api', requestId: `move-${direction}`,
                currentTarget: { kind: 'managed_service', machineId: old.machine.id, managedServiceId: incumbent.instanceId,
                    workspaceId: old.ref.id, cwd: incumbent.cwd, declaration: incumbent.declaration },
                destination: placement, selectedTarget: { machineId: destination.machine.id }, desiredPlacement: { workspace, serviceName: 'api',
                    expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: placement, unavailable: 'fail' } } });
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ ...fixture.envelope, input: request });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('projects.service.relocate'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const sender = Object.assign(createFakeSocket({ id: 'reviewed-move-sender', data: { clientType: 'machine-scoped',
                machineId: fixture.machine.id, verifiedMachineInstallationId: fixture.machine.installationId,
                authTokenKind: requesterKind, authAuthority: requesterKind === 'account' ? 'present_user' : 'account_automation' } }),
                { handshake: { auth: { token } } });
            qualifyCurrentAccountStoredContentSocket(sender);
            registerSocketRpcHandlers({ userId: fixture.account.id, socket: sender as unknown as Socket, io });
            const tryChild = async (effectActionId: string, machineId: string, params: unknown) => {
                const method = `${machineId}:${getActionSpec(effectActionId).bindings!.rpcMethod}`;
                const requestId = 'reviewed-move-negative';
                const externalActionExecution = { v: 1 as const, authorization: root, effectActionId, target: root.binding.target,
                    installationId: root.binding.installationId, machineSignature: signExternalActionMachineRpcRequestV1({
                        authorizationToken: root.token, effectActionId, target: root.binding.target, installationId: root.binding.installationId,
                        method, requestId, params, privateKey: fixture.keyPair.secretKey }) };
                let response: unknown;
                await getSocketHandler(sender, SOCKET_RPC_EVENTS.CALL)({ method, requestId, params, externalActionExecution,
                    originalActionEnvelope: envelope }, (value: unknown) => { response = value; });
                return response;
            };
            const statusParams = getActionSpec('projects.worker.status').inputSchema.parse({ workspace,
                destination: { kind: 'machine', machineId: destination.machine.id }, purpose: 'service-start' });
            for (const refused of [
                () => tryChild('projects.worker.status', 'unreviewed-machine', { ...statusParams,
                    destination: { kind: 'machine', machineId: 'unreviewed-machine' } }),
                () => tryChild('projects.worker.copy.retire', fixture.machine.id,
                    getActionSpec('projects.worker.copy.retire').inputSchema.parse({ workspace, machineId: fixture.machine.id,
                        expectedRelationship: relationship })),
                () => tryChild('localServices.actions.stopManaged', old.machine.id, createTargetedActionRpcRequestV1(
                    getActionSpec('localServices.actions.stopManaged').inputSchema.parse({ requestId: 'other-service-stop',
                        action: 'stop_managed', force: false, target: { ...request.currentTarget, managedServiceId: 'another-service' } }),
                    { kind: 'machine', machineId: old.machine.id })),
            ]) {
                const before = admittedPackets.length;
                expect(await refused()).toMatchObject({ ok: false });
                expect(admittedPackets).toHaveLength(before);
                expect(incumbent.snapshot().state).toBe('running');
            }
            const prepared = await prepareRequesterAccountActionContext({ authorization: root, purpose: { kind: 'external_action' },
                machineId: fixture.machine.id, installationId: fixture.machine.installationId!, installationPrivateKey: fixture.keyPair.secretKey,
                ownCredentials: credentials, serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: origin,
                isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: root, effectActionId: root.binding.actionId,
                    target: root.binding.target, installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey, serverHttpBaseUrl: origin }),
                createExecutor: () => installed[0]!.buildExecutor({ signal: new AbortController().signal }) });
            expect(prepared, 'Original SOURCE requester custody must be admitted by real Home').not.toBeNull();
            if (!prepared) throw new Error('SOURCE requester custody unavailable');
            privateContexts.push(prepared);
            const sourceAuthority = resolveExternalActionRootInvocationAuthority(prepared.authorization);
            const sourceAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: fixture.machine.id, requiredRole: 'use' });
            if (sourceAdmission.kind !== 'admitted') throw new Error('SOURCE admission unavailable');
            const { kind: _kind, ...machineAdmission } = sourceAdmission;
            const ingress: RpcHandlerContext = { signal: new AbortController().signal, machineAdmission,
                callerAuthority: sourceAuthority, callerInputAuthorization: prepared.authorization,
                originalActionEnvelope: envelope, verifyMachineAdmissionCurrent: async () => true };
            const result = await localInstallation.run(installed[0]!.identity, () => installed[0]!.buildExecutor(ingress).execute(
                'projects.service.relocate', request, { surface: requesterKind === 'account' ? 'ui' : 'cli',
                    authority: sourceAuthority, bypassApprovals: true, serverId: homeId,
                    runtimeAccountId: fixture.account.id, actionRequestId: envelope.requestId, originalActionEnvelope: envelope,
                    externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: root.binding.target,
                    presentUserConfirmation: { actionId: 'projects.service.relocate' }, operationProgress: { update(update) {
                        if (update.phase) phases.push(update.phase);
                    } } }));
            if (currentness === 'revoked-after-placement') {
                expect(receiversAtPlacement, 'Actual Home placement mutation must precede credential revocation').toBeDefined();
                expect(effects, JSON.stringify({ result, effects, phases, startObservations })).toEqual([]);
                expect(incumbent.snapshot().state).toBe('running');
                expect(admittedPackets).toHaveLength(receiversAtPlacement!);
                expect(destination.owner.listProjectServices()).toEqual([]);
                expect(result).not.toMatchObject({ ok: true, result: { status: 'moved' } });
                return;
            }
            expect(result, JSON.stringify({ result, phases, effects, preparationObservations,
                failedHome: homeResponses.filter(response => response.status >= 400), relayRequests, receiverDiagnostics, startObservations, operationObservations,
                packets: admittedPackets.map(packet => packet.method) }))
                .toMatchObject({ ok: true, result: { status: 'moved', currentTarget: { machineId: destination.machine.id } } });
            if (!result.ok) throw new Error('Reviewed Move refused');
            const moved = ProjectServiceRelocateResultV1Schema.parse(result.result);
            expect(moved.status).toBe('moved');
            expect(effects).toEqual(['stop', 'prepare']);
            expect(preparationObservations).toEqual([{ oldState: 'stopped', liveDestinations: 0 }]);
            expect(incumbent.snapshot().state).toBe('stopped');
            expect(destination.owner.listProjectServices().some(handle => handle.snapshot().state === 'running')).toBe(true);
            expect(phases.indexOf('stopped')).toBeLessThan(phases.indexOf('copying'));
            expect(phases.indexOf('copying')).toBeLessThan(phases.indexOf('starting'));
            const movePackets = admittedPackets.filter(packet => packet.workspaceSyncSourceExecution?.originalActionEnvelope);
            expect(movePackets.length).toBeGreaterThan(0);
            for (const packet of movePackets) expect(packet.callerInputAuthorization?.binding).toMatchObject({
                actionId: 'projects.service.relocate', machineId: fixture.machine.id, installationId: fixture.machine.installationId,
                target: root.binding.target, requestEnvelopeDigest: root.binding.requestEnvelopeDigest,
            });
            for (const packet of movePackets) expect(packet.callerAuthority).toBe(sourceAuthority);
            const beforeRevokedReplay = admittedPackets.length;
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: worker.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            const replayMethod = direction === 'SOURCE-to-worker' ? getActionSpec('projects.worker.status').bindings!.rpcMethod
                : getActionSpec('localServices.launcher.snapshot').bindings!.rpcMethod;
            const replay = outgoingPackets.find(packet => packet.method === `${worker.id}:${replayMethod}`);
            if (!replay) throw new Error('Original signed worker packet required for revocation replay');
            let replayResponse: unknown;
            await getSocketHandler(sender, SOCKET_RPC_EVENTS.CALL)(replay, (value: unknown) => { replayResponse = value; });
            expect(replayResponse).toMatchObject({ ok: false });
            expect(admittedPackets).toHaveLength(beforeRevokedReplay);
        } finally {
            await Promise.all(privateContexts.map(context => context.dispose()));
            await Promise.all(owners.map(owner => owner.dispose()));
            terminals.forEach(terminal => terminal.dispose());
            restoreHttp();
            await network.close();
            await app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.each(['projects.prepare', 'projects.script.run', 'projects.compute.exec', 'projects.inspect', 'projects.worker.status', 'localServices.launcher.start',
        'localServices.actions.restartManaged', 'approval.request.decide',
        'machines.terminal.open', 'machines.terminal.list', 'machines.terminal.read', 'machines.terminal.write',
        'machines.terminal.close', 'machines.terminal.restart'] as const)(
        'confines Project rows to requester read custody for %s without granting row mutation', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const privateRows = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId)
            || actionId === 'projects.inspect' || actionId === 'projects.worker.status';
        const actionToken = actionId === 'projects.worker.status' ? (await auth.createApiToken({ accountId: fixture.account.id,
            tokenId: crypto.randomUUID(), label: 'Status only', grant: { ...API_TOKEN_FULL_GRANT_V1,
                actions: { families: [], ids: [actionId] }, targets: { sessions: [], machines: [fixture.machine.id] } } })).token : token;
        const homeId = await getOrCreateServerIdentityId();
        const workspace = { serverId: homeId, workspaceId: 'accepted', machineId: fixture.machine.id, rootPath: '/workspace/project' };
        const key = { kind: 'workspace-ref', serverId: homeId, id: workspace.workspaceId } as const;
        const ref = { id: workspace.workspaceId, serverId: homeId, machineId: fixture.machine.id, rootPath: workspace.rootPath,
            projectKey: 'project', createdAtMs: 1 };
        const graphKey = { kind: 'relationship-graph' } as const;
        const unrelatedKeys = [
            { kind: 'workspace-ref', serverId: homeId, id: 'unrelated-project' },
            { kind: 'workspace-ref', serverId: 'unrelated-home', id: 'unrelated-home-ref' },
            { kind: 'project-organization', serverId: homeId, projectKey: 'unrelated-project' },
        ] as const;
        const mutation = ProjectAccountRowMutationRequestV1Schema.parse({ mutations: [
            { key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: ref } } },
            { key: graphKey, expectedRevision: 'absent', content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } },
            ...unrelatedKeys.map(key => ({ key, expectedRevision: 'absent', content: { t: 'plain', v: { key,
                value: key.kind === 'workspace-ref' ? { ...ref, id: key.id, serverId: key.serverId,
                    machineId: 'unreviewed-machine', projectKey: 'unrelated-project', rootPath: '/private/unrelated' }
                    : { label: 'Private unrelated organization' } } } })),
        ], expectedRefs: [], topologyChange: true });
        const input = getActionSpec(actionId).inputSchema.parse(actionId === 'projects.prepare' ? { workspace, phase: 'setup' }
            : actionId === 'projects.worker.status' ? { workspace: { serverId: homeId, refId: ref.id },
                destination: { kind: 'machine', machineId: fixture.machine.id }, purpose: 'finite' }
            : actionId === 'approval.request.decide' ? { artifactId: 'setup-approval', decision: 'approve' }
            : actionId === 'localServices.actions.restartManaged' ? { requestId: 'restart-review', action: 'restart_managed',
                target: { kind: 'managed_service', managedServiceId: 'service', machineId: fixture.machine.id },
                confirmationNonce: 'reviewed-service', force: false }
            : actionId === 'projects.script.run' ? { workspace, selection: { kind: 'named', name: 'lint' } }
            : actionId === 'projects.compute.exec' ? { workspace, executable: '/managed/node', argv: ['scripts/lint.mjs'], cwd: workspace.rootPath }
            : actionId === 'localServices.launcher.start' ? { workspace, machineId: fixture.machine.id,
                targetId: createProjectServiceDeclarationTargetIdV1(ref, { kind: 'manifest', name: 'api' }),
                declaration: { workspaceRefId: ref.id, selection: { kind: 'manifest', name: 'api' } } }
            : actionId.startsWith('machines.terminal.') ? { serverId: homeId, machineId: fixture.machine.id,
                ...(actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart'
                    ? { workspace, terminalKey: 'requester-shell' }
                    : actionId === 'machines.terminal.list' ? { workspace }
                    : { terminalId: 'requester-pty', ...(actionId === 'machines.terminal.read' ? { byteOffset: 0 }
                        : actionId === 'machines.terminal.write' ? { event: { t: 'text', text: 'pwd\r' } } : {}) }) }
            : { workspace });
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ ...fixture.envelope, input });
        const { app } = await createApp(fixture.team.id);
        try {
            const seeded = await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate',
                headers: { authorization: `Bearer ${token}` }, payload: mutation });
            expect(seeded.statusCode, seeded.body).toBe(200);
            expect(seeded.json()).toMatchObject({ status: 'updated' });
            const catalog = await app.inject({ method: 'POST', url: '/v1/account/project-rows/list',
                headers: { authorization: `Bearer ${token}` }, payload: {} });
            expect(catalog.statusCode, catalog.body).toBe(200);
            expect(ProjectAccountRowListResponseV1Schema.parse(catalog.json())).toMatchObject({ status: 'listed',
                rows: expect.arrayContaining(unrelatedKeys.map(key => expect.objectContaining({ key }))) });
            if (actionId === 'projects.worker.status') expect((await app.inject({ method: 'POST', url: '/v1/account/project-rows/list',
                headers: { authorization: `Bearer ${actionToken}` }, payload: {} })).statusCode).toBe(403);
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${actionToken}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId });
            const send = (path: string, body: unknown, privateKey = fixture.keyPair.secretKey) => app.inject({ method: 'POST', url: path,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path, body, privateKey }), payload: body });
            if (actionId === 'projects.script.run' || actionId === 'projects.compute.exec' || actionId === 'localServices.launcher.start'
                || actionId === 'localServices.actions.restartManaged' || actionId === 'approval.request.decide') {
                const path = '/v1/account/encryption';
                const mode = await app.inject({ method: 'GET', url: path, headers: machineHeaders({ authorizationToken: authorization.token,
                    effectActionId: actionId, method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey }) });
                expect.soft(mode.statusCode, mode.body).toBe(200);
                const configBody = WorkspaceExecutionConfigReadRequestV1Schema.parse({ address: { serverId: homeId, refId: ref.id } });
                const config = await send('/v1/projects/execution/config/read', configBody);
                expect.soft(config.statusCode, config.body).toBe(200);
                if (config.statusCode === 200) expect(WorkspaceExecutionConfigReadResponseV1Schema.parse(config.json())).toEqual({ status: 'absent' });
                expect((await send('/v1/projects/execution/config/mutate', { ...configBody, expectedRevision: 'absent', content: null })).statusCode).toBe(401);
                if (actionId === 'approval.request.decide') {
                    // Replay keeps the decision root; the real preparation reader
                    // must spend that root rather than claim a different effect.
                    const request = vi.spyOn(axios, 'request').mockImplementation(async config => {
                        if (config.method !== 'GET' && config.method !== 'POST') throw new Error('Unexpected preparation method');
                        const response = await app.inject({ method: config.method,
                            url: new URL(config.url!).pathname, headers: Object.fromEntries(Object.entries(config.headers ?? {})
                                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
                            ...(config.data === undefined ? {} : { payload: JSON.stringify(config.data) }) });
                        return { status: response.statusCode, data: response.json() };
                    });
                    try {
                        const client = await createAccountServerWorkspaceWorkerPreferenceClient({ token,
                            credentials: { token, encryption: null }, serverHttpBaseUrl: 'https://home.example.test',
                            context: { surface: 'ui', externalActionExecutionAuthorization: authorization }, actionId: 'projects.script.run',
                            resolveRequestHeaders: args => machineHeaders({ authorizationToken: authorization.token,
                                effectActionId: args.effectActionId, method: args.method, path: args.path, body: args.body,
                                privateKey: fixture.keyPair.secretKey }) });
                        expect(client).not.toBeNull();
                        expect(await client?.get({ workspace: { serverId: homeId, refId: ref.id } })).toMatchObject({ status: 'ready' });
                    } finally { request.mockRestore(); }
                }
            }
            const listed = await send('/v1/account/project-rows/list', {});
            expect.soft(listed.statusCode, listed.body).toBe(privateRows ? 401 : 200);
            if (!privateRows) {
                const rows = ProjectAccountRowListResponseV1Schema.parse(listed.json());
                expect(rows.status).toBe('listed');
                if (rows.status !== 'listed') throw new Error('Project rows were not listed');
                const refs = rows.rows.flatMap(row => row.content?.t === 'plain' && 'id' in row.content.v.value ? [row.content.v.value] : []);
                expect(resolveWorkspaceRefV1(refs, workspace)).toEqual({ kind: 'resolved', ref });
            }
            if (privateRows) for (const unrelatedKey of unrelatedKeys) {
                expect.soft((await send('/v1/account/project-rows/read', { key: unrelatedKey })).statusCode).toBe(401);
            }
            const singleRow = await send('/v1/account/project-rows/read', { key });
            if (privateRows || actionId.startsWith('machines.terminal.')) expect.soft(singleRow.statusCode).toBe(401);
            else expect(singleRow.json()).toMatchObject({ status: 'present', row: { key } });
            const trust = await send('/v1/account/project-trust/read', { project: { serverId: homeId, projectId: ref.projectKey } });
            const readsTrust = actionId !== 'projects.worker.status' && (!actionId.startsWith('machines.terminal.')
                || actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart');
            expect(trust.statusCode, trust.body).toBe(readsTrust ? 200 : 401);
            if (readsTrust) expect(ProjectTrustReadResponseV1Schema.parse(trust.json())).toEqual({ status: 'absent' });
            if (actionId === 'projects.worker.status') {
                const configBody = WorkspaceExecutionConfigReadRequestV1Schema.parse({ address: { serverId: homeId, refId: ref.id } });
                expect((await send('/v1/projects/execution/config/read', configBody)).statusCode).toBe(401);
            }
            expect((await send('/v1/account/project-rows/list', {}, tweetnacl.sign.keyPair().secretKey)).statusCode).toBe(401);
            const foreignEffect = await app.inject({ method: 'POST', url: '/v1/account/project-rows/list', payload: {},
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId === 'projects.prepare'
                    ? 'projects.script.run' : 'projects.prepare', method: 'POST', path: '/v1/account/project-rows/list', body: {},
                    privateKey: fixture.keyPair.secretKey }) });
            expect(foreignEffect.statusCode).toBe(401);
            expect((await send('/v1/account/project-rows/mutate', mutation)).statusCode).toBe(401);
            expect((await send('/v1/account/project-trust/mutate', { project: { serverId: homeId, projectId: ref.projectKey },
                expectedRevision: 'absent', content: null })).statusCode).toBe(401);
            expect((await send('/v1/account/project-rows/list', { unauthorizedField: true })).statusCode).not.toBe(200);
            await db.machine.update({ where: { id: fixture.machine.id }, data: { revokedAt: new Date() } });
            expect((await send('/v1/account/project-rows/list', {})).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('spends the Team usage export root grant on its canonical read without requiring a query grant', async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const actionId = 'teams.credentials.usage.export';
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(),
            label: 'Usage export', grant: { ...API_TOKEN_FULL_GRANT_V1,
                actions: { families: [], ids: [actionId] }, targets: { sessions: [], machines: [fixture.machine.id] } } });
        const { app } = await createApp(fixture.team.id);
        const query = { resourceId: 'resource', startMs: 0, endMs: 1000, granularity: 'day', costMode: 'auto' };
        try {
            const authorization = await mint(app, { ...fixture, pat }, actionId, { ...fixture.envelope,
                input: { query, resourceName: 'Shared model' } });
            const read = bindHomeDomainActionHttpRequestV1('teams.credentials.usage.query', query);
            const headers = machineHeaders({ authorizationToken: authorization.token, method: read.method,
                path: read.path, body: read.body, privateKey: fixture.keyPair.secretKey, effectActionId: 'teams.credentials.usage.query' });
            const verify = () => verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                machineSignature: headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]!,
                encodedTarget: headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]!,
                effectActionId: 'teams.credentials.usage.query', method: read.method, path: read.path, body: read.body });
            expect(Boolean(await verify())).toBe(true);
            for (const purpose of [
                { method: read.method, path: '/v1/teams/archive', body: read.body, effectActionId: 'teams.credentials.usage.query' },
                { method: read.method, path: read.path, body: read.body, effectActionId: 'teams.credentials.get' },
                { method: 'GET', path: read.path, body: read.body, effectActionId: 'teams.credentials.usage.query' },
                { method: read.method, path: read.path, body: { ...query, credential: 'not-a-query-field' }, effectActionId: 'teams.credentials.usage.query' },
            ]) {
                const deniedHeaders = machineHeaders({ authorizationToken: authorization.token, ...purpose,
                    privateKey: fixture.keyPair.secretKey });
                expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                    machineSignature: deniedHeaders[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]!,
                    encodedTarget: deniedHeaders[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]!, ...purpose })).toBeNull();
            }
            await auth.updateApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId,
                grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
                    targets: { sessions: [], machines: ['other-machine'] } } });
            expect(await verify()).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['session', 'host'] as const)('admits only the exact Workflow storage purposes of an authenticated %s root', async caller => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: new Date() } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'source-key' } });
        // Session publisher discovery is an external socket boundary. Persisted
        // source custody, issuance, both signatures and route admission stay real.
        let publisherCurrent = true;
        let onWaitRead: (() => void) | undefined;
        const { app } = await createApp(fixture.team.id, false, async () => publisherCurrent ? fixture.machine.id : null,
            undefined, false, routes => {
                registerDiscussionRoutes(routes);
                registerSessionCreateOrLoadRoute(routes);
                if (caller === 'session') {
                    startSocket(routes);
                    // The parent Session publisher is the external boundary;
                    // keep this test's incumbent presence witness. Account
                    // socket authentication and connection admission stay real.
                    routes.resolveCurrentSessionMachine = async () => publisherCurrent ? fixture.machine.id : null;
                }
                routes.addHook('onResponse', async request => {
                    if (request.url === '/v3/automations/runs/workflow-storage'
                        && request.body && typeof request.body === 'object' && 'operation' in request.body
                        && request.body.operation === 'wait') onWaitRead?.();
                });
            });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const runId = crypto.randomUUID();
        const target = { kind: 'machine' as const, machineId: fixture.machine.id,
            project: { machineId: fixture.machine.id, directory: '/repo' } };
        const issue = async (actionId: 'workflow.run.start' | 'workflow.run.get' | 'workflow.run.wait' | 'session.list', timeoutSeconds = 300) => {
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                sourceTurnId: 'workflow-turn', callerPermissionMode: 'default', causalPermissionAuthority: null,
                requestId: crypto.randomUUID() });
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId, target,
                input: actionId === 'session.list' ? { underSessionId: session.id, view: 'summary', limit: 20 }
                    : actionId === 'workflow.run.start' ? { runId,
                    source: { kind: 'inline', definition: { version: 1, blocks: ['work'] } } }
                    : actionId === 'workflow.run.wait' ? { runId, conditions: ['terminal'], timeoutSeconds } : { runId } });
            const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
            const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: {
                    homeId, actionId, requestId: origin.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin,
                } } });
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id,
                    envelope, ...(caller === 'session' ? { sessionActionOrigin: origin, sessionActionSource: source, installationProof } : {}) } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(authorization.binding).toMatchObject({ authentication: { kind: 'account' },
                ...(caller === 'session' ? { sessionActionOrigin: origin } : {}) });
            expect(await auth.verifyExternalActionExecutionAuthorization(authorization.token) !== null,
                'The real issuer must create a verifiable Workflow root').toBe(true);
            authorizationRequests.set(authorization.token, { target, installationId: source.installationId, requestId: origin.requestId });
            return authorization;
        };
        const path = '/v3/automations/runs/workflow-storage';
        const post = (authorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>,
            body: Record<string, unknown>, overrides: { effectActionId?: string; target?: ExternalActionRequestEnvelopeV1['target']; publisher?: boolean } = {}) => {
            const headers = machineHeaders({ authorizationToken: authorization.token, effectActionId: overrides.effectActionId ?? authorization.binding.actionId,
                method: 'POST', path, body, privateKey: fixture.keyPair.secretKey, ...(overrides.target ? { target: overrides.target } : {}) });
            if (overrides.publisher !== false) headers[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1] = createSignedPluginInstallationPublisherHeader({
                keyPair: fixture.keyPair, machineId: fixture.machine.id, installationId: fixture.machine.installationId!, path, body,
            });
            return app.inject({ method: 'POST', url: path, headers, payload: body });
        };
        try {
            const start = await issue('workflow.run.start');
            const createdDiscussion = await createDiscussion({ actorAccountId: fixture.account.id,
                authentication: createPresentUserSessionAccessAuthentication(), request: {
                    creationLocalId: crypto.randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Workflow question' } },
                    firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: { v: 1,
                        parts: [{ t: 'text', text: 'Compare the proposed approach' }] } }, mentionedAccountIds: [] },
                } });
            if (!createdDiscussion.ok) throw new Error(createdDiscussion.error);
            const discussionPath = `/v1/discussions/${createdDiscussion.value.discussion.id}/messages`;
            const discussionDetailsPath = `/v1/discussions/${createdDiscussion.value.discussion.id}`;
            const discussionDetails = await app.inject({ method: 'GET', url: discussionDetailsPath,
                headers: machineHeaders({ authorizationToken: start.token, effectActionId: 'discussion.read',
                    method: 'GET', path: discussionDetailsPath, body: undefined, privateKey: fixture.keyPair.secretKey }) });
            expect(discussionDetails.statusCode, discussionDetails.body).toBe(200);
            const discussionRead = await app.inject({ method: 'GET', url: discussionPath,
                headers: machineHeaders({ authorizationToken: start.token, effectActionId: 'discussion.read',
                    method: 'GET', path: discussionPath, body: undefined, privateKey: fixture.keyPair.secretKey }) });
            expect(discussionRead.statusCode, discussionRead.body).toBe(200);
            expect(discussionRead.json()).toMatchObject({ messages: [{ id: createdDiscussion.value.firstMessage.id }] });
            const deniedPost = { localId: crypto.randomUUID(), content: { t: 'plain', v: { v: 1,
                parts: [{ t: 'text', text: 'Not admitted by a preparatory read' }] } }, mentionedAccountIds: [] };
            expect((await app.inject({ method: 'POST', url: discussionPath, payload: deniedPost,
                headers: machineHeaders({ authorizationToken: start.token, effectActionId: 'discussion.post',
                    method: 'POST', path: discussionPath, body: deniedPost, privateKey: fixture.keyPair.secretKey }) })).statusCode).toBe(401);
            const read = { operation: 'get', publisherMachineId: fixture.machine.id, runId };
            // A missing Run is a domain 404, rather than a refused storage read.
            const missing = await post(start, read);
            expect(missing.statusCode, missing.body).toBe(404);
            expect(missing.json()).toEqual({ error: 'run_not_found' });
            const currentnessPath = '/v1/account/encryption/currentness';
            const currentness = await app.inject({ method: 'GET', url: currentnessPath,
                headers: machineHeaders({ authorizationToken: start.token, effectActionId: 'workflow.run.start',
                    method: 'GET', path: currentnessPath, body: undefined, privateKey: fixture.keyPair.secretKey }) });
            expect(currentness.statusCode, currentness.body).toBe(200);
            const snapshot = await materializeWorkflowAcceptedSnapshotFixture({ definition: { version: 1,
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: ['work'] },
                context: { source: { kind: 'inline' }, inputs: {}, machineId: fixture.machine.id,
                    executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: fixture.machine.id,
                        directory: '/repo', checkoutRootPath: '/repo' } }, origin: { kind: 'direct', originSessionId: session.id },
                    authorization: { principal: caller === 'session' ? { kind: 'session', sessionId: session.id } : { kind: 'host' } } } });
            const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: fixture.account.id, runId },
                acceptedSnapshot: caller === 'session' ? { ...snapshot, startedBy: 'agent', workDepth: 1 } : snapshot,
            }));
            const admitted = await post(start, { operation: 'admit', publisherMachineId: fixture.machine.id, machineId: fixture.machine.id,
                runId, origin: { kind: 'direct', originSessionId: session.id }, acceptedEnvelope,
                accountCurrentness: { mode: 'plain', version: currentness.json().version, contentKeyFingerprint: null } });
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(admitted.json()).toMatchObject({ kind: 'created', run: { id: runId, state: 'queued' } });
            expect((await post(start, read)).json()).toMatchObject({ run: { id: runId, state: 'queued' } });
            expect((await post(start, { operation: 'run-key.census', publisherMachineId: fixture.machine.id, runId })).statusCode).toBe(200);
            // Another round reads the accepted source's invocation history under
            // the original Start authorization, before admitting the next Run.
            const history = { operation: 'invocations.list', publisherMachineId: fixture.machine.id, runId, pageByteLimit: 4096 };
            const listed = await post(start, history);
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json()).toMatchObject({ invocations: [], parentRevision: 0 });
            const invocationRead = { operation: 'invocations.get', publisherMachineId: fixture.machine.id,
                runId, invocationId: crypto.randomUUID() };
            const missingInvocation = await post(start, invocationRead);
            expect(missingInvocation.statusCode, missingInvocation.body).toBe(404);
            expect(missingInvocation.json()).toEqual({ error: 'run_not_found' });
            // Wait checks active invocations for a self-dependency before and
            // after observation. It must spend the same read authority as Get.
            for (const actionId of caller === 'session' ? ['workflow.run.get', 'workflow.run.wait'] as const : []) {
                const reader = await issue(actionId);
                expect((await post(reader, read)).statusCode).toBe(200);
                const invocations = await post(reader, history);
                expect(invocations.statusCode, `${actionId}: ${invocations.body}`).toBe(200);
                const invocation = await post(reader, invocationRead);
                expect(invocation.statusCode, invocation.body).toBe(404);
                expect(invocation.json()).toEqual({ error: 'run_not_found' });
                if (actionId === 'workflow.run.wait') {
                    const waited = await post(reader, { operation: 'wait', publisherMachineId: fixture.machine.id,
                        runId, timeoutSeconds: 0 });
                    expect(waited.statusCode, waited.body).toBe(200);
                    expect(waited.json()).toMatchObject({ run: { id: runId, state: 'queued' } });
                }
                expect((await post(reader, { operation: 'cancel', publisherMachineId: fixture.machine.id,
                    runId, expectedRevision: 0 })).statusCode).toBe(401);
                expect((await post(reader, history, { publisher: false })).statusCode).toBe(401);
                expect((await post(reader, { ...history, publisherMachineId: crypto.randomUUID() })).statusCode).toBe(401);
            }
            expect((await post(start, history, { publisher: false })).statusCode).toBe(401);
            expect((await post(start, { ...history, publisherMachineId: crypto.randomUUID() })).statusCode).toBe(401);
            expect((await post(start, history, { effectActionId: 'workflow.run.cancel' })).statusCode).toBe(401);
            expect((await post(start, read, { publisher: false })).statusCode).toBe(401);
            expect((await post(start, { ...read, publisherMachineId: crypto.randomUUID() })).statusCode).toBe(401);
            expect((await post(start, read, { effectActionId: 'workflow.run.cancel' })).statusCode).toBe(401);
            expect((await post(start, read, { effectActionId: 'workflow.definition.get' })).statusCode).toBe(401);
            expect((await post(start, read, { target: { kind: 'machine', machineId: crypto.randomUUID() } })).statusCode).toBe(401);
            expect((await post(start, { operation: 'cancel', publisherMachineId: fixture.machine.id, runId, expectedRevision: 0 })).statusCode).toBe(401);
            expect((await post(start, { operation: 'initialize', publisherMachineId: fixture.machine.id, runId,
                parentAttempt: 0, expectedRevision: 0, accountCurrentness: { mode: 'plain', version: currentness.json().version,
                    contentKeyFingerprint: null }, checkpointEnvelope: 'not-an-executor-claim',
                rootInvocation: { id: crypto.randomUUID(), contentEnvelope: 'not-an-executor-fact' } })).statusCode).toBe(401);
            const unrelatedCurrentnessPath = '/v1/account/encryption/currentness?accountId=other';
            expect((await app.inject({ method: 'GET', url: unrelatedCurrentnessPath,
                headers: machineHeaders({ authorizationToken: start.token, effectActionId: 'workflow.run.start',
                    method: 'GET', path: unrelatedCurrentnessPath, body: undefined,
                    privateKey: fixture.keyPair.secretKey }) })).statusCode).toBe(401);
            if (caller === 'host') {
                // Human read Actions stay on the incumbent Account transport;
                // they do not mint a Machine root merely to observe a Run.
                const observed = await app.inject({ method: 'POST', url: path,
                    headers: { authorization: `Bearer ${token}` }, payload: { operation: 'get', runId } });
                expect(observed.statusCode, observed.body).toBe(200);
                expect(observed.json()).toMatchObject({ run: { id: runId, state: 'queued' } });
            }
            if (caller === 'session') {
                // Exercise the real CLI composition, signed HTTP purposes and
                // Account feed while a native wait outlives its first read.
                const invocationId = crypto.randomUUID();
                await db.workflowRunInvocation.create({ data: { id: invocationId, runId, sequence: 1n,
                    parentRecordId: null, memberOrdinal: 0n, lifecycle: 'running',
                    contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
                        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: fixture.account.id,
                            runId, recordId: invocationId, sequence: '1', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
                        progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step',
                            invocationPath: { blockId: snapshot.definition.blocks[0]!.id, scope: [] },
                            attempt: '0', logicalInvocationRecordId: invocationId,
                            execution: { kind: 'session', sessionId: 'another-workflow-session', localInputId: 'leaf-input' } },
                    })) } });
                await db.automationRun.update({ where: { id: runId }, data: { state: 'running', revision: 1 } });
                const socket = app.machineDaemonPresence;
                if (!(socket instanceof SocketServer)) throw new Error('Expected the production Socket.IO server');
                const installation = vi.spyOn(currentMachineInstallation, 'readCurrentMachineInstallation').mockResolvedValue({
                    machineId: fixture.machine.id, identity: { version: 1, installationId: fixture.machine.installationId!, createdAt: 1,
                        publicKey: encodeBase64(fixture.keyPair.publicKey, 'base64url'),
                        privateKey: encodeBase64(fixture.keyPair.secretKey, 'base64url') },
                });
                const controller = new AbortController();
                try {
                    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
                    const cli = createCliActionExecutor({ token, credentials: { token, encryption: null }, sessionId: 'cli-global',
                        mode: 'plain', ctx: null, serverId: 'workflow-wait-home', serverIdentityId: homeId, serverHttpBaseUrl: origin,
                        pluginActionExecutionOwner: 'current_process',
                        externalActionMachineInstallationId: fixture.machine.installationId!, externalActionMachineRequestPrivateKey: fixture.keyPair.secretKey,
                        resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
                            features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {},
                        }) }),
                    });
                    // The Workflow creator supplies an ordinary manager at
                    // birth. Origin provenance alone must not grant membership.
                    const createLeaf = (managed: boolean) => app.inject({ method: 'POST', url: '/v1/sessions',
                        headers: { authorization: `Bearer ${token}`, ...currentAccountStoredContentCompatibilityHeaders },
                        payload: { tag: crypto.randomUUID(), metadataLayoutVersion: 1,
                            sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) }, ownerMetadata: { t: 'plain', v: { v: 1 } },
                            dataEncryptionKey: null, encryptionMode: 'plain', originKind: 'run_step', originRunId: runId,
                            originSessionId: session.id, workDepth: 1, ...(managed ? { manager: { sessionId: session.id } } : {}) } });
                    const managedLeaf = await createLeaf(true);
                    const unlinkedLeaf = await createLeaf(false);
                    expect(managedLeaf.statusCode, managedLeaf.body).toBe(200);
                    expect(unlinkedLeaf.statusCode, unlinkedLeaf.body).toBe(200);
                    expect(managedLeaf.json()).toMatchObject({ session: { manager: { sessionId: session.id },
                        origin: { kind: 'run_step', runId } } });
                    const listAuthorization = await issue('session.list');
                    const listed = await cli.execute('session.list', { underSessionId: session.id, view: 'summary', limit: 20 }, {
                        surface: 'agent', authority: 'account_automation', defaultSessionId: session.id,
                        actionCaller: { kind: 'session', sessionId: session.id },
                        externalActionTarget: target, externalActionExecutionAuthorization: listAuthorization,
                    });
                    expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
                    if (!listed.ok) throw new Error('Signed Agent list was refused');
                    const listedIds = (listed.result as { sessions: { id: string }[] }).sessions.map(row => row.id);
                    expect(listedIds).toContain(managedLeaf.json().session.id);
                    expect(listedIds).not.toContain(unlinkedLeaf.json().session.id);
                    const authorization = await issue('workflow.run.wait');
                    const connected = new Promise<void>(resolve => socket.once('connection', () => resolve()));
                    let resolveRead: (() => void) | undefined;
                    const nextRead = () => new Promise<void>(resolve => { resolveRead = resolve; });
                    onWaitRead = () => resolveRead?.();
                    const firstRead = nextRead();
                    const initialTime = Date.now();
                    vi.useFakeTimers({ toFake: ['Date'] });
                    const context = { surface: 'agent' as const, authority: 'account_automation' as const, defaultSessionId: session.id,
                        externalActionTarget: target, externalActionExecutionAuthorization: authorization, signal: controller.signal };
                    const pending = cli.execute('workflow.run.wait', { runId, conditions: ['terminal'], timeoutSeconds: 300 }, context);
                    void pending.catch(() => {});
                    await Promise.race([Promise.all([connected, firstRead]), pending.then(result => {
                        throw new Error(`Native wait settled before its first observation: ${JSON.stringify(result)}`);
                    })]);
                    await vi.waitFor(() => expect(socket.sockets.adapter.rooms.has(`account-stored-content-v3:${fixture.account.id}`)).toBe(true));
                    const concurrentGet = await issue('workflow.run.get');
                    await expect(cli.execute('workflow.run.get', { runId }, { ...context,
                        externalActionExecutionAuthorization: concurrentGet })).resolves.toMatchObject({ ok: true,
                        result: { run: { id: runId, state: 'running' } } });
                    vi.setSystemTime(initialTime + 149_000);
                    await db.automationRun.update({ where: { id: runId }, data: { state: 'interrupted', revision: 2 } });
                    await db.workflowRunInvocation.update({ where: { id: invocationId }, data: { lifecycle: 'failed' } });
                    const interruptedRead = nextRead();
                    await eventRouter.emitUpdate({ userId: fixture.account.id, recipientFilter: { type: 'account-stored-content-v3' }, payload: {
                        id: 'workflow-interrupted', seq: 1, createdAt: Date.now(), body: { t: 'account-change' },
                    } });
                    await interruptedRead;
                    // Interrupted is nonterminal. Only the caller's authored
                    // deadline ends this terminal-only observation.
                    vi.setSystemTime(initialTime + 301_000);
                    await eventRouter.emitUpdate({ userId: fixture.account.id, recipientFilter: { type: 'account-stored-content-v3' }, payload: {
                        id: 'workflow-deadline', seq: 2, createdAt: Date.now(), body: { t: 'account-change' },
                    } });
                    const activeWaitResult = await pending;
                    expect(activeWaitResult, JSON.stringify(activeWaitResult)).toMatchObject({ ok: true, result: { observation: 'timeout',
                        run: { id: runId, state: 'interrupted' } } });
                    // Cross the publisher proof's five-minute lifetime in real
                    // time. Advancing Date while a signed request is in flight
                    // tests an expired individual request, not proof reuse by
                    // a parked observation. No midpoint wake refreshes this wait.
                    vi.useRealTimers();
                    const interruptedStartedAt = Date.now();
                    const interruptedAuthorization = await issue('workflow.run.wait', 301);
                    const connectedAgain = new Promise<void>(resolve => socket.once('connection', () => resolve()));
                    const initiallyInterruptedRead = nextRead();
                    const initiallyInterrupted = cli.execute('workflow.run.wait', { runId, conditions: ['terminal'], timeoutSeconds: 301 }, {
                        ...context, externalActionExecutionAuthorization: interruptedAuthorization,
                    });
                    void initiallyInterrupted.catch(() => {});
                    await Promise.race([Promise.all([connectedAgain, initiallyInterruptedRead]), initiallyInterrupted.then(result => {
                        throw new Error(`Interrupted wait settled before its first observation: ${JSON.stringify(result)}`);
                    })]);
                    await vi.waitFor(() => expect(socket.sockets.adapter.rooms.has(`account-stored-content-v3:${fixture.account.id}`)).toBe(true));
                    const concurrentInterruptedGet = await issue('workflow.run.get');
                    await expect(cli.execute('workflow.run.get', { runId }, { ...context,
                        externalActionExecutionAuthorization: concurrentInterruptedGet })).resolves.toMatchObject({ ok: true,
                        result: { run: { id: runId, state: 'interrupted' } } });
                    const interruptedWaitResult = await initiallyInterrupted;
                    expect(Date.now() - interruptedStartedAt).toBeGreaterThanOrEqual(301_000);
                    expect(interruptedWaitResult, JSON.stringify(interruptedWaitResult)).toMatchObject({ ok: true, result: { observation: 'timeout',
                        run: { id: runId, state: 'interrupted' } } });
                    const getAuthorization = await issue('workflow.run.get');
                    await expect(cli.execute('workflow.run.get', { runId }, { ...context,
                        externalActionExecutionAuthorization: getAuthorization })).resolves.toMatchObject({ ok: true,
                        result: { run: { id: runId, state: 'interrupted' } } });
                    await vi.waitFor(() => expect(socket.sockets.sockets.size).toBe(0));
                } finally {
                    controller.abort();
                    vi.useRealTimers();
                    onWaitRead = undefined;
                    installation.mockRestore();
                    await new Promise<void>(resolve => socket.close(() => resolve()));
                    eventRouter.clearIo();
                }
            }
            if (caller === 'session') publisherCurrent = false;
            else await db.machine.update({ where: { id: fixture.machine.id }, data: { revokedAt: new Date() } });
            expect((await post(start, read)).statusCode).toBe(401);
        } finally { await app.close(); }
    }, 420_000);

    it.each(['scm.diffSummary.reviewed.mark', 'scm.diffSummary.reviewed.unmark',
        'scm.diffSummary.result.delete', 'scm.diffSummary.result.clear'] as const)(
    'admits personal reviewed-mark currentness and CAS without granting unrelated Account access for %s', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const { app } = await createApp(fixture.team.id);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const comparisonId = 'a'.repeat(64);
        const reference = { cwd: '/workspace', resultId: 'saved-result', expectedRevision: 0 };
        const input = actionId === 'scm.diffSummary.result.clear' ? { results: [{ ...reference, comparisonId }] }
            : actionId === 'scm.diffSummary.result.delete' ? reference
                : { v: 2, cwd: '/workspace', comparisonId, source: { kind: 'workingTree' }, changeRefs: ['captured-change'] };
        const envelope = { ...fixture.envelope, input };
        try {
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId });
            const request = (method: 'GET' | 'POST', path: string, body?: unknown, effectActionId: string = actionId) => app.inject({
                method, url: path, ...(body === undefined ? {} : { payload: body }),
                headers: machineHeaders({ authorizationToken: authorization.token, method, path, body,
                    effectActionId, privateKey: fixture.keyPair.secretKey }),
            });
            const currentness = await request('GET', '/v1/account/encryption/currentness');
            expect(currentness.statusCode, currentness.body).toBe(200);
            expect(currentness.json()).toMatchObject({ mode: 'plain' });
            const key = buildScmReviewedMarksKey(comparisonId);
            const path = `/v1/kv/${encodeURIComponent(key)}`;
            expect((await request('GET', path)).statusCode).toBe(404);
            const value = Buffer.from(JSON.stringify({ t: 'plain', v: { v: 1, scopeId: comparisonId,
                reviewedChangeKeys: ['content-change'] } })).toString('base64');
            const mutation = { mutations: [{ key, value, version: -1 }] };
            const saved = await request('POST', '/v1/kv', mutation);
            expect(saved.statusCode, saved.body).toBe(200);
            expect(saved.json()).toEqual({ success: true, results: [{ key, version: 0 }] });
            expect((await request('GET', path)).json()).toEqual({ key, value, version: 0 });
            expect((await request('POST', '/v1/kv', { mutations: [{ key, value: Buffer.from('stale-ciphertext').toString('base64'), version: 0 }] })).statusCode).toBe(400);
            for (const [method, deniedPath, body] of [
                ['GET', '/v1/account/encryption', undefined],
                ['GET', '/v2/account/settings', undefined],
                ['GET', '/v1/account/encryption/currentness?accountId=other', undefined],
                ['GET', '/v1/kv', undefined],
                ['GET', '/v1/kv/other', undefined],
                ['GET', `${path}?accountId=other`, undefined],
                ['POST', '/v1/kv', { mutations: [{ key: 'other', value, version: -1 }] }],
                ['POST', '/v1/kv', { mutations: [...mutation.mutations, { key: 'other', value, version: -1 }] }],
                ['POST', '/v1/kv', { mutations: [{ key: SCM_REVIEWED_MARKS_KV_PREFIX, value, version: -1 }] }],
                ['POST', '/v1/kv', { mutations: [{ key: SCM_REVIEWED_MARKS_KV_PREFIX + '%61', value, version: -1 }] }],
                ['POST', '/v1/kv', { mutations: [{ key: SCM_REVIEWED_MARKS_KV_PREFIX + '%gg', value, version: -1 }] }],
                ['POST', '/v1/kv', { ...mutation, accountId: 'other' }],
                ['POST', '/v1/kv?accountId=other', mutation],
            ] as const) expect((await request(method, deniedPath, body)).statusCode, `${deniedPath} ${JSON.stringify(body)}`).toBe(401);
            // Malformed bodies are rejected by HTTP validation before its auth
            // hook. Exercise native-purpose admission directly for these proofs.
            for (const [method, deniedPath, body] of [
                ['POST', '/v1/kv', { mutations: [] }],
                ['GET', '/v1/account/encryption/currentness', {}],
                ['PUT', '/v1/kv', mutation],
            ] as const) {
                expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token, effectActionId: actionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target), method, path: deniedPath, body,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
                        target: authorization.binding.target, installationId: fixture.machine.installationId!,
                        requestId: authorization.binding.requestId, method, path: deniedPath, body, privateKey: fixture.keyPair.secretKey }) })).toBeNull();
            }
            const differentEffect = actionId === 'scm.diffSummary.reviewed.unmark' ? 'scm.diffSummary.reviewed.mark' : 'scm.diffSummary.reviewed.unmark';
            expect((await request('GET', path, undefined, differentEffect)).statusCode).toBe(401);
            await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: 'e2ee' } });
            // Incompatible Account/Machine mode retires the signed origin;
            // direct Account admission independently rejects its unknown mode.
            expect((await request('GET', '/v1/account/encryption/currentness')).statusCode).toBe(401);
            expect((await request('POST', '/v1/kv', { mutations: [{ key, value, version: 0 }] })).statusCode).toBe(401);
            const inconsistent = await app.inject({ method: 'GET', url: '/v1/account/encryption/currentness',
                headers: { authorization: `Bearer ${token}` } });
            expect(inconsistent.statusCode, inconsistent.body).toBe(400);
            expect(inconsistent.json()).toMatchObject({ error: 'migration-required' });
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await request('GET', '/v1/account/encryption/currentness')).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('does not lend a custodian Account to a Machine collaborator for personal review Actions', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: fixture.machine.id }, data: { accountId: custodian.id } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: fixture.machine.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'admin' }));
        expect(await resolveMachineAccess({ actorAccountId: fixture.account.id, machineId: fixture.machine.id }))
            .toMatchObject({ owned: false, role: 'manage', custodianAccountId: custodian.id, accessState: 'ready' });
        for (const actionId of ['scm.diffSummary.reviewed.mark', 'scm.diffSummary.reviewed.unmark',
            'scm.diffSummary.result.delete', 'scm.diffSummary.result.clear'] as const) {
            expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: fixture.machine.id, actionId }))
                .toMatchObject({ kind: 'denied' });
        }
    });

    it('admits only the Summary model catalog metadata reads under an authenticated Account root', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const retainedSettings = { preferredLanguage: 'fr', secrets: [{ id: 'unrelated-secret', name: 'Unrelated credential', kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, encryptedValue: 'synthetic-retained-secret-carrier' }, createdAt: 1, updatedAt: 1 }] };
        await db.account.update({ where: { id: fixture.account.id }, data: {
            settings: JSON.stringify({ t: 'plain', v: retainedSettings }), settingsVersion: 1,
        } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerConnectedAccountConfigurationRowsRoutes);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const actionId = 'agents.models.list';
        const envelope = { ...fixture.envelope, input: { purpose: 'scm_diff_summary', machineId: fixture.machine.id } };
        try {
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId });
            const verify = async (method: string, path: string, body?: unknown, effectActionId = actionId) =>
                verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token, effectActionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target), method, path, body,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId,
                        target: authorization.binding.target, installationId: fixture.machine.installationId!,
                        requestId: authorization.binding.requestId, method, path, body, privateKey: fixture.keyPair.secretKey }) });
            const catalogPath = `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`;
            for (const path of ['/v1/account/encryption/currentness', catalogPath]) {
                expect(await verify('GET', path), path).toMatchObject({ effectActionId: actionId, binding: { accountId: fixture.account.id } });
                const response = await app.inject({ method: 'GET', url: path, headers: machineHeaders({
                    authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey,
                }) });
                expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
                expect(response.body).not.toContain('synthetic-retained-secret-carrier');
            }
            const ownSettings = await app.inject({ method: 'GET', url: '/v2/account/settings', headers: { authorization: `Bearer ${token}` } });
            expect(ownSettings.statusCode, ownSettings.body).toBe(200);
            expect(ownSettings.json()).toMatchObject({ content: { t: 'plain', v: retainedSettings } });
            for (const path of ['/v2/account/settings', '/v1/account/encryption']) {
                const response = await app.inject({ method: 'GET', url: path, headers: machineHeaders({
                    authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey,
                }) });
                expect(response.statusCode, `${path}: ${response.body}`).toBe(401);
                expect(response.body).not.toContain('synthetic-retained-secret-carrier');
                expect(await verify('GET', path), path).toBeNull();
            }
            for (const [method, path, body] of [
                ['POST', catalogPath, {}],
                ['GET', `${catalogPath}?accountId=other`, undefined],
                ['GET', `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`, undefined],
                ['GET', '/v1/account/encryption/currentness?accountId=other', undefined],
                ['GET', '/v1/account/profile', undefined],
                ['GET', '/v2/account/settings', {}],
            ] as const) expect(await verify(method, path, body), path).toBeNull();
            expect(await verify('GET', catalogPath, undefined, 'agents.backends.list')).toBeNull();
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect(await verify('GET', catalogPath)).toBeNull();
        } finally { await app.close(); }
    });

    it('admits only the native quota read purposes under the captured U3 root', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const { app } = await createApp(fixture.team.id);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const actionId = 'connectedServices.quota.get';
        const source = { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'connected-account' }, bindingKind: 'account' };
        const envelope = { ...fixture.envelope, input: { source } };
        try {
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(issued.statusCode, JSON.stringify({ body: issued.body, signedRoot: SignedRootActionIdSchema.safeParse(actionId).success,
                resultSchemaAvailable: getActionSpec(actionId).outputSchema !== undefined })).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const verify = async (method: string, path: string, body?: unknown, effectActionId = actionId) =>
                verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token, effectActionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target), method, path, body,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId,
                        target: authorization.binding.target, installationId: fixture.machine.installationId!,
                        requestId: authorization.binding.requestId, method, path, body, privateKey: fixture.keyPair.secretKey }) });
            const sourcePath = `/v4/connect/qualified/provider-account-usage/sources/resolve?${new URLSearchParams({ source: JSON.stringify(source) })}`;
            const recordId = 'paug_v1_abcdefgh';
            const historyPath = `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query: JSON.stringify({ recordId, history: { range: { startAtMs: 0, endAtMs: 100 }, pageSize: 10 } }) })}`;
            for (const path of [sourcePath, `/v4/connect/qualified/provider-account-usage/record?recordId=${recordId}`, historyPath,
                '/v1/account/encryption/currentness', '/v1/account/encryption', '/v2/account/settings']) {
                expect(await verify('GET', path), path).toMatchObject({ effectActionId: actionId, binding: { accountId: fixture.account.id } });
            }
            expect(await verify('POST', '/v2/pending/reset-starts/read', { source })).not.toBeNull();
            for (const [method, path, body] of [
                ['GET', '/v1/features/authenticated', undefined],
                ['GET', '/v4/connect/qualified/provider-account-usage/sources/resolve?source={}', undefined],
                ['GET', '/v4/connect/qualified/provider-account-usage/record?recordId=invalid', undefined],
                ['GET', `${sourcePath}&source=${encodeURIComponent(JSON.stringify(source))}`, undefined],
                ['GET', `${historyPath}&accountId=other`, undefined],
                ['GET', '/v1/account/encryption/currentness?accountId=other', undefined],
                ['POST', '/v4/connect/qualified/provider-account-usage/record/refresh', { recordId }],
                ['POST', '/v2/pending/reset-starts/read', { source, accountId: 'other' }],
                ['POST', '/v2/pending/reset-starts/read', { source: { ...source, bindingKind: 'unknown' } }],
            ] as const) expect(await verify(method, path, body), path).toBeNull();
            expect(await verify('GET', sourcePath, undefined, 'connectedServices.quota.refresh')).toBeNull();
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect(await verify('GET', sourcePath)).toBeNull();
        } finally { await app.close(); }
    });

    it.each([
        { actionId: 'session.pending.resetStart.set' as const, mode: 'plain' as const, carrier: 'session' as const },
        { actionId: 'session.pending.resetStart.cancel' as const, mode: 'plain' as const, carrier: 'session' as const },
        { actionId: 'session.pending.resetStart.set' as const, mode: 'e2ee' as const, carrier: 'session' as const },
        { actionId: 'session.pending.resetStart.set' as const, mode: 'plain' as const, carrier: 'machine' as const },
        { actionId: 'session.pending.resetStart.set' as const, mode: 'e2ee' as const, carrier: 'machine' as const },
    ])('admits only the exact Session mutation purpose under U3 root $actionId ($mode $carrier)', async ({ actionId, mode, carrier }) => {
        const fixture = await createFixture({ qualifiedPat: false });
        const material = mode === 'e2ee' ? { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) } : undefined;
        if (material) {
            const signing = tweetnacl.sign.keyPair();
            const contentPublicKey = Uint8Array.from(tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey);
            await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: 'e2ee',
                publicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey,
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey }) } });
            const machineKey = createMachineDataEncryptionKeyV1({ material, dataKeyPublicKey: contentPublicKey, randomBytes: tweetnacl.randomBytes });
            const nonce = tweetnacl.randomBytes(SESSION_DATA_KEY_NONCE_BYTES);
            const cipher = createCipheriv('aes-256-gcm', machineKey.encryptionKey, nonce);
            const ciphertext = Buffer.concat([cipher.update(serializeSessionDataKeyValue(decodePlainMachineStoredContent(fixture.machine.metadata))), cipher.final()]);
            await db.machine.update({ where: { id: fixture.machine.id }, data: {
                metadata: encodeBase64(Uint8Array.from(packSessionDataKeyBundleV0({ nonce, ciphertext, authTag: cipher.getAuthTag() }))),
                dataEncryptionKey: Uint8Array.from(machineKey.dataEncryptionKey) } });
        }
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, true);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const target = carrier === 'machine' ? { kind: 'machine' as const, machineId: fixture.machine.id }
            : { kind: 'session' as const, sessionId: session.id };
        const reset = { source: { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'connected-account' }, bindingKind: 'account' },
            recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { observedAtMs: 100, id: 'accepted-history' } };
        const plainEnvelope = { v: 1 as const, requestId: crypto.randomUUID(), target,
            input: { sessionId: session.id, localId: 'queued-work', ...(actionId.endsWith('.set') ? { reset } : {}) } };
        const envelope = material ? sealExternalActionRequestV2({ binding: { serverIdentityId: await getOrCreateServerIdentityId(),
            accountId: fixture.account.id, authentication: { kind: 'account', tokenEpoch: fixture.account.tokenEpoch },
            actionId, requestId: plainEnvelope.requestId, target }, input: plainEnvelope.input, material, randomBytes: tweetnacl.randomBytes }) : plainEnvelope;
        try {
            if (envelope.v === 2) {
                const unprotected = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope: plainEnvelope } });
                expect(unprotected.statusCode).toBe(400);
                const { pendingResetStartAdmission: _admission, ...missing } = envelope;
                const unbound = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope: missing } });
                expect(unbound.statusCode).toBe(400);
            }
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(issued.statusCode, JSON.stringify({ body: issued.body, signedRoot: SignedRootActionIdSchema.safeParse(actionId).success,
                resultSchemaAvailable: getActionSpec(actionId).outputSchema !== undefined })).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const method = actionId.endsWith('.set') ? 'PATCH' : 'POST';
            const path = `/v2/sessions/${session.id}/pending/queued-work${actionId.endsWith('.cancel') ? '/withdraw' : '/action'}`;
            const body = actionId.endsWith('.set') ? { requestedAction: { v: 1, kind: 'reset_start', reset } } : {};
            const verify = (requestMethod: string, requestPath: string, requestBody: unknown,
                proofAuthorization = authorization) => verifyExternalActionDomainExecutionRequest({
                authorizationToken: proofAuthorization.token, effectActionId: actionId, encodedTarget: encodeExternalActionResolvedTargetV1(target),
                method: requestMethod, path: requestPath, body: requestBody,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: proofAuthorization.token, effectActionId: actionId,
                    target, installationId: fixture.machine.installationId!, requestId: proofAuthorization.binding.requestId,
                    method: requestMethod, path: requestPath, body: requestBody, privateKey: fixture.keyPair.secretKey }) });
            expect(await verify(method, path, body)).not.toBeNull();
            if (actionId.endsWith('.set')) {
                // Direct internal issuance can still create an unbound token;
                // execution must reject it at the common verifier before any Session fallback.
                const { pendingResetStartAdmission: _admission, ...unboundBinding } = authorization.binding;
                const unbound = await auth.mintExternalActionExecutionAuthorization(unboundBinding);
                expect(await auth.verifyExternalActionExecutionAuthorization(unbound.token)).not.toBeNull();
                expect(await verify(method, path, body, unbound)).toBeNull();
                expect(await verify('GET', '/v1/account/encryption/currentness', undefined, unbound)).toBeNull();
            }
            expect(await verify(method, path.replace(session.id, 'another-session'), body)).toBeNull();
            expect(await verify('DELETE', path, body)).toBeNull();
            if (actionId.endsWith('.set')) expect(await verify(method, path.slice(0, -'/action'.length), body)).toBeNull();
            expect(await verify(method, path, { requestedAction: { v: 1, kind: 'send_now' } })).toBeNull();
            expect(await verify(method, path, { ...body, resumeWhenAvailable: true })).toBeNull();
            if (actionId.endsWith('.set')) {
                const initial = { localId: 'queued-work', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hold' } } }, requestedAction: { v: 1, kind: 'reset_start', reset } };
                const initialPath = `/v2/sessions/${session.id}/pending`;
                expect(await verify('POST', initialPath, initial)).not.toBeNull();
                expect(await verify('POST', initialPath, { ...initial, resumeWhenAvailable: true })).toBeNull();
                expect(await verify('GET', '/v1/account/encryption/currentness', undefined)).not.toBeNull();
                const sourcePath = `/v4/connect/qualified/provider-account-usage/sources/resolve?${new URLSearchParams({ source: JSON.stringify(reset.source) })}`;
                const historyPath = (query: unknown) => `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query: JSON.stringify(query) })}`;
                expect(await verify('GET', sourcePath, undefined)).not.toBeNull();
                expect(await verify('GET', `/v4/connect/qualified/provider-account-usage/record?recordId=${reset.recordId}`, undefined)).not.toBeNull();
                expect(await verify('GET', historyPath({ recordId: reset.recordId, witness: reset.witness }), undefined)).not.toBeNull();
                for (const requestPath of [
                    sourcePath.replace('connected-account', 'another-account'),
                    `/v4/connect/qualified/provider-account-usage/record?recordId=paug_v1_otherrecord`,
                    historyPath({ recordId: reset.recordId, witness: { ...reset.witness, id: 'another' } }),
                    historyPath({ recordId: reset.recordId, witness: { ...reset.witness, observedAtMs: 101 } }),
                    historyPath({ recordId: reset.recordId, history: { range: { startAtMs: 0, endAtMs: 100 } } }),
                    `${sourcePath}&source=${encodeURIComponent(JSON.stringify(reset.source))}`,
                    '/v2/account/settings', '/v1/account/encryption', '/v1/account/encryption/currentness?accountId=other',
                ]) expect(await verify('GET', requestPath, undefined), requestPath).toBeNull();
                expect(await verify('PATCH', path.replace('queued-work', 'other-input'), body)).toBeNull();
                expect(await verify('PATCH', path, { requestedAction: { v: 1, kind: 'reset_start', reset: { ...reset, meterId: 'other-window' } } })).toBeNull();
                expect(await verify('POST', '/v2/pending/reset-starts/read', { source: reset.source })).toBeNull();
                expect(await verify('POST', '/v4/connect/qualified/provider-account-usage/record', initial)).toBeNull();
            } else expect(await verify('GET', '/v1/account/encryption/currentness', undefined)).toBeNull();
            await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: mode === 'e2ee' ? 'plain' : 'e2ee' } });
            expect(await verify(method, path, body)).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['plain', 'e2ee'] as const)('issues usable input-bound fresh-reset roots through ordinary public dispatch (%s)', async mode => {
        const fixture = await createFixture({ qualifiedPat: false });
        const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
        if (mode === 'e2ee') {
            const signing = tweetnacl.sign.keyPair();
            const contentPublicKey = Uint8Array.from(tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey);
            await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: 'e2ee',
                publicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey,
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey }) } });
            const machineKey = createMachineDataEncryptionKeyV1({ material, dataKeyPublicKey: contentPublicKey, randomBytes: tweetnacl.randomBytes });
            const nonce = tweetnacl.randomBytes(SESSION_DATA_KEY_NONCE_BYTES);
            const cipher = createCipheriv('aes-256-gcm', machineKey.encryptionKey, nonce);
            const ciphertext = Buffer.concat([cipher.update(serializeSessionDataKeyValue(decodePlainMachineStoredContent(fixture.machine.metadata))), cipher.final()]);
            await db.machine.update({ where: { id: fixture.machine.id }, data: {
                metadata: encodeBase64(Uint8Array.from(packSessionDataKeyBundleV0({ nonce, ciphertext, authTag: cipher.getAuthTag() }))),
                dataEncryptionKey: Uint8Array.from(machineKey.dataEncryptionKey) } });
        }
        await db.machine.update({ where: { id: fixture.machine.id }, data: { active: true, lastActiveAt: new Date(),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const actionId = 'session.pending.resetStart.set';
        const target = { kind: 'machine' as const, machineId: fixture.machine.id };
        const reset = { source: { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'connected-account' }, bindingKind: 'account' },
            recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { observedAtMs: 100, id: 'accepted-history' } };
        const plain = { v: 1 as const, requestId: crypto.randomUUID(), target, input: { sessionId: session.id, localId: 'queued-work', reset } };
        const binding = { serverIdentityId: await getOrCreateServerIdentityId(), accountId: fixture.account.id,
            authentication: { kind: 'account' as const, tokenEpoch: fixture.account.tokenEpoch }, actionId, requestId: plain.requestId, target };
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ binding, input: plain.input, material, randomBytes: tweetnacl.randomBytes }) : plain;
        const forwarded: ExternalActionDaemonDispatchRequest[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io: createSocketRoomDiscoveryHarness(async () => []),
            forwardRpc: async ({ callParams }) => {
                // This is the genuine daemon network boundary; issuer, database and signed verification remain real.
                const request = callParams as ExternalActionDaemonDispatchRequest;
                forwarded.push(request);
                const execution = { ok: true, result: { accepted: true } };
                const prepared = request.envelope.v === 2 ? prepareExternalActionResponseV2({ binding, request: request.envelope,
                    executedMachineId: fixture.machine.id, execution, material, randomBytes: tweetnacl.randomBytes })
                    : prepareExternalActionResponseEnvelopeV1({ v: 1, actionId, requestId: request.envelope.requestId, execution });
                return { ok: true, result: createExternalActionDaemonDispatchResponse(prepared) };
            } });
        const { app } = await createApp(fixture.team.id, false, undefined, dispatch);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const relay = (payload: unknown) => app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
        try {
            const response = await relay(envelope);
            expect(response.statusCode, response.body).toBe(200);
            const authorization = forwarded[0]?.executionAuthorization;
            if (!authorization) throw new Error('No signed daemon request forwarded');
            const verify = (method: string, path: string, body?: unknown) => verifyExternalActionDomainExecutionRequest({
                authorizationToken: authorization.token, effectActionId: actionId, encodedTarget: encodeExternalActionResolvedTargetV1(target), method, path, body,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId, target,
                    installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId, method, path, body, privateKey: fixture.keyPair.secretKey }) });
            expect(await verify('GET', '/v1/account/encryption/currentness')).not.toBeNull();
            const path = `/v2/sessions/${session.id}/pending/queued-work/action`;
            expect(await verify('PATCH', path, { requestedAction: { v: 1, kind: 'reset_start', reset } })).not.toBeNull();
            expect(await verify('PATCH', path, { requestedAction: { v: 1, kind: 'reset_start', reset: { ...reset, meterId: 'other' } } })).toBeNull();
            expect(await verify('GET', '/v2/account/settings')).toBeNull();
            const invalid = envelope.v === 2 ? (() => { const { pendingResetStartAdmission: _admission, ...missing } = envelope; return missing; })()
                : { ...plain, input: { sessionId: session.id, localId: 'queued-work' } };
            expect((await relay(invalid)).statusCode).toBe(400);
            if (mode === 'e2ee') expect((await relay(plain)).statusCode).toBe(400);
            expect(forwarded).toHaveLength(1);
        } finally { await app.close(); }
    });

    it('admits signed fresh-reset preparation through the real qualified B HTTP readers without general Account reads', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const ref = { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'connected-account' };
        const credential = await mutateQualifiedConnectedServiceCredential({ accountId: fixture.account.id, ref,
            expectedCredentialRevision: null, authenticationModeId: 'api-key', content: { t: 'plain', v: { token: 'credential' } },
            metadata: { scopes: [], providerIdentity: { accountId: 'provider-subject' } } });
        if (credential.status !== 'written') throw new Error('Credential fixture rejected');
        const source = { ref, bindingKind: 'account' as const };
        const snapshotBase = createUsageSnapshot({ fetchedAt: Date.now(), recordKey: { providerId: 'codex', accountSubjectId: 'provider-subject', subjectKind: 'account', quotaScope: 'account' } });
        // B accepts provider meter identities independently of the HTTP header carrier.
        const meterId = 'm'.repeat(maxHeaderSize);
        const snapshot = { ...snapshotBase, meters: snapshotBase.meters.map(meter => ({ ...meter, meterId })) };
        await writeQualifiedProviderAccountUsageRecord({ accountId: fixture.account.id, source,
            expectedCredentialRevision: credential.credentialRevision, expectedConfigurationRevision: null,
            recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok', snapshot,
            fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
        const accepted = await db.providerAccountUsageHistory.findFirstOrThrow({ where: { accountId: fixture.account.id, recordId: snapshot.recordId } });
        const reset = { source, recordId: snapshot.recordId, meterId, witness: { id: accepted.id, observedAtMs: accepted.observedAt.getTime() } };
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const target = { kind: 'machine' as const, machineId: fixture.machine.id };
        const actionId = 'session.pending.resetStart.set';
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: { sessionId: session.id, localId: 'fresh-input', reset } };
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, true);
        try {
            const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const headers = (path: string) => ({
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: fixture.machine.installationId!, requestId: envelope.requestId,
                    method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey }),
            });
            const read = (path: string) => app.inject({ method: 'GET', url: path, headers: headers(path) });
            const address = await app.listen({ host: '127.0.0.1', port: 0 });
            const currentnessPath = '/v1/account/encryption/currentness';
            const networkResponse = await fetch(`${address}${currentnessPath}`, { headers: headers(currentnessPath) });
            expect(networkResponse.status, `header ceiling ${maxHeaderSize}; signed token bytes ${Buffer.byteLength(authorization.token)}`).toBe(200);
            const sourcePath = `/v4/connect/qualified/provider-account-usage/sources/resolve?${new URLSearchParams({ source: JSON.stringify(source) })}`;
            const recordPath = `/v4/connect/qualified/provider-account-usage/record?recordId=${snapshot.recordId}`;
            const witnessPath = `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query: JSON.stringify({ recordId: snapshot.recordId, witness: reset.witness }) })}`;
            for (const path of ['/v1/account/encryption/currentness', sourcePath, recordPath, witnessPath]) {
                const response = await read(path);
                expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
                if (path === witnessPath) expect(response.json()).toMatchObject({ entries: [{ id: accepted.id, observedAtMs: reset.witness.observedAtMs }] });
            }
            for (const path of [sourcePath.replace('connected-account', 'different-account'), `${recordPath}x`,
                witnessPath.replace(encodeURIComponent(accepted.id), 'different-witness'), '/v2/account/settings', '/v1/account/encryption']) {
                expect((await read(path)).statusCode, path).toBe(401);
            }
        } finally { await app.close(); }
    });

    it('executes a signed Account metadata title through the real writer and exact Session HTTP purpose', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: null };
        const metadataFields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain',
            storedContentMode: 'plain', metadata: createTestMetadata({ machineId: fixture.machine.id }), agentState: null });
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain',
            metadataLayoutVersion: metadataFields.metadataLayoutVersion, metadata: metadataFields.sharedMetadata.ciphertext,
            ownerMetadata: JSON.stringify(metadataFields.ownerMetadata), agentState: metadataFields.agentState } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-source-key' } });
        const { app } = await createApp(fixture.team.id, false, async () => fixture.machine.id, undefined, false,
            routes => registerSessionPatchRoute(routes));
        const actionId = 'session.title.set';
        const input = getActionSpec(actionId).inputSchema.parse({ sessionId: session.id, title: 'Signed metadata title' });
        const envelope: ExternalActionRequestEnvelopeV1 = { v: 1, requestId: crypto.randomUUID(),
            target: { kind: 'machine', machineId: fixture.machine.id }, input };
        try {
            const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
            const homeId = await getOrCreateServerIdentityId();
            let preparedToken: string | undefined;
            await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
                await bootstrapAccountSettingsContext({ credentials, mode: 'blocking' });
                const execute = createDaemonSessionAccountActionExecutor({ credentials, token, serverId: 'metadata-home',
                    serverHttpBaseUrl, machineId: fixture.machine.id,
                    prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin, isCallerCurrent }) => {
                        const target = { kind: 'machine' as const, machineId: fixture.machine.id };
                        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId: operation.actionId,
                            input: operation.input, requestId: operation.requestId, target, machineId: fixture.machine.id,
                            sourceMachineId: fixture.machine.id, accountId: fixture.account.id, accountEncryptionMode: 'plain',
                            tokenEpochHint: fixture.account.tokenEpoch, token, serverId: 'metadata-home', serverIdentityId: homeId,
                            serverHttpBaseUrl, installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey,
                            sessionActionOrigin, isCurrent: isCallerCurrent });
                        if (!authorization) return null;
                        preparedToken = authorization.token;
                        authorizationRequests.set(authorization.token, { target,
                            installationId: fixture.machine.installationId!, requestId: operation.requestId });
                        return { authorization, target };
                    },
                    createExecutor: () => createCliActionExecutorFromCredentials({ credentials, serverId: 'metadata-home',
                        serverApiUrl: serverHttpBaseUrl, serverIdentityId: homeId, machineId: fixture.machine.id,
                        externalActionMachineRequestPrivateKey: fixture.keyPair.secretKey,
                        externalActionMachineInstallationId: fixture.machine.installationId!, pluginActionExecutionOwner: 'current_process' }),
                });
                const result = await execute({ kind: 'action.execute', actionId, input, requestId: envelope.requestId!,
                    witness: { turnId: 'metadata-turn', inputId: crypto.randomUUID(), userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
                        agentStartCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 } } },
                    { sessionId: session.id, isCurrent: async () => true });
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                const raw = await fetchSessionById({ token, serverUrl: serverHttpBaseUrl, sessionId: session.id });
                expect(raw).not.toBeNull();
                expect(tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: 'plain', rawSession: raw! }))
                    .toMatchObject({ summary: { text: 'Signed metadata title' } });
                const target = { kind: 'session' as const, sessionId: session.id };
                for (const path of [`/v2/sessions/${session.id}x`, '/v2/account/settings', '/v1/account/encryption/currentness?accountId=other']) {
                    const refused = await app.inject({ method: 'GET', url: path, headers: machineHeaders({
                        authorizationToken: preparedToken!, effectActionId: actionId, target,
                        method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey }) });
                    expect(refused.statusCode, path).toBe(401);
                }
                for (const [method, path, body, effectActionId] of [
                    ['PATCH', `/v2/sessions/${session.id}`, { metadata: 'legacy-write', expectedVersion: 0 }, actionId],
                    ['GET', `/v1/account/encryption/currentness`, undefined, 'session.bot.set'],
                ] as const) {
                    const refused = await app.inject({ method, url: path, payload: body, headers: machineHeaders({
                        authorizationToken: preparedToken!, effectActionId, target,
                        method, path, body, privateKey: fixture.keyPair.secretKey }) });
                    expect(refused.statusCode).toBe(401);
                }
                await db.machine.update({ where: { id: fixture.machine.id }, data: { revokedAt: new Date() } });
                const path = '/v1/account/encryption/currentness';
                expect((await app.inject({ method: 'GET', url: path, headers: machineHeaders({
                    authorizationToken: preparedToken!, effectActionId: actionId, target,
                    method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey }) })).statusCode).toBe(401);
            });
        } finally { await app.close(); }
    });

    it.each(['settings.list', 'settings.get', 'settings.set', 'settings.invoke'] as const)(
        'admits %s through the exact signed Account ingress and retains its credential authority', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const { app, dispatchedPrincipals } = await createApp(fixture.team.id);
        const envelope = { ...fixture.envelope, input: actionId === 'settings.list' ? {}
            : actionId === 'settings.set' ? { anchor: 'delegation.workDepthLimit', value: 3 } : { anchor: 'delegation.workDepthLimit' } };
        try {
            const response = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(response.statusCode, response.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                accountId: fixture.account.id, authority: 'present_user',
                authentication: { kind: 'account', tokenEpoch: fixture.account.tokenEpoch },
            });
            const relay = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` }, payload: envelope });
            expect(relay.statusCode, relay.body).toBe(200);
            expect(dispatchedPrincipals).toEqual([expect.objectContaining({
                accountId: fixture.account.id, authority: 'present_user', authentication: { kind: 'account', tokenEpoch: fixture.account.tokenEpoch },
            })]);
            const otherAccount = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const otherToken = await auth.createToken(otherAccount.id, undefined, { kind: 'account', authority: 'present_user' });
            const substituted = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${otherToken}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope, executionAuthorization: authorization } });
            expect(substituted.statusCode).toBe(401);
            expect(dispatchedPrincipals).toHaveLength(1);
            const terminal = await auth.createToken(fixture.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
            const terminalIssued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${terminal}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(terminalIssued.statusCode, terminalIssued.body).toBe(200);
            const terminalAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(terminalIssued.json());
            expect(await verifyCurrentExternalActionPrincipal(terminalAuthorization.binding)).toMatchObject({
                accountId: fixture.account.id, authority: 'account_automation',
                authentication: { kind: 'terminal', tokenEpoch: fixture.account.tokenEpoch },
            });
            const terminalRelay = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${terminal}` }, payload: envelope });
            expect(terminalRelay.statusCode, terminalRelay.body).toBe(200);
            expect(dispatchedPrincipals[1]).toMatchObject({ accountId: fixture.account.id, authority: 'account_automation',
                authentication: { kind: 'terminal', tokenEpoch: fixture.account.tokenEpoch } });
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toBeNull();
            expect(await verifyCurrentExternalActionPrincipal(terminalAuthorization.binding)).toBeNull();
        } finally { await app.close(); }
    });

    it('admits connected Session name set and clear, persists approval custody, and executes each decision once', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-source-key' } });
        // Socket publisher discovery is the external boundary; HTTP, installed
        // signatures, admission, approval codecs/CAS and SQLite remain real.
        let publisher: string | null = fixture.machine.id;
        let effects = 0;
        const { app } = await createApp(fixture.team.id, false, async () => publisher, undefined, false, routes => {
            artifactsRoutes(routes);
            registerAccountApiTokenManagementRoutes(routes);
            routes.addHook('onRequest', async (request) => {
                if (request.method === 'POST' && request.url === '/v1/account/profile') effects += 1;
            });
        });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: null };
        const homeId = await getOrCreateServerIdentityId();
        const serverId = 'name-clear-profile';
        const target = { kind: 'machine' as const, machineId: fixture.machine.id };
        try {
            const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
            await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
                await bootstrapAccountSettingsContext({ credentials, mode: 'blocking' });
                const artifacts = createCliApprovalsArtifactStore({ credentials, serverId });
                const accountDeps = createAccountServerActionDeps({ token, credentials, serverId, serverHttpBaseUrl,
                    serverIdentityId: homeId });
                const current = createDaemonApprovalExecutionOriginCurrentness({ accountId: fixture.account.id,
                    machineId: fixture.machine.id, serverId,
                    isAccountCurrent: async signal => (await fetchAccountProfile({ token, signal })).id === fixture.account.id,
                    resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: fixture.machine.id, serverIdentityId: homeId }),
                    resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
                    listAccountApiTokens: async () => {
                        const result = await accountDeps.accountApiTokensListAction!({ input: {},
                            context: { surface: 'ui', authority: 'present_user', serverId } });
                        if ('ok' in result) throw new Error(result.errorCode);
                        return result;
                    },
                    externalActionMachinePublicKey: fixture.keyPair.publicKey,
                    verifyExternalExecutionAuthorization: args => verifyExternalActionExecutionAuthorizationCurrent({ ...args,
                        privateKey: fixture.keyPair.secretKey, installationId: fixture.machine.installationId!, serverHttpBaseUrl }),
                    isSessionCallerCurrent: async () => publisher === fixture.machine.id,
                    resolveCurrentPermissionMode: async () => 'default',
                    resolveCurrentSessionAgentSpawnPolicyV1: async () =>
                        (await resolveAvailableAccountSettings({ credentials }))?.sessionAgentSpawnPolicyV1 ?? null,
                });
                // This family consumes the real Home/Artifact ports; unused transports are absent.
                const executor = createActionExecutor({ ...accountDeps, ...artifacts,
                    isApprovalExecutionOriginCurrent: ({ origin, request, signal }) => current({ origin, request, signal }),
                } as ActionExecutorDeps);
                const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl, token,
                    machineId: fixture.machine.id,
                    prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin, isCallerCurrent }) => {
                        const authorization = await prepareExternalActionRequesterAccountAuthorization({
                            actionId: operation.actionId, input: operation.input, requestId: operation.requestId,
                            target, machineId: fixture.machine.id, sourceMachineId: fixture.machine.id,
                            accountId: fixture.account.id, accountEncryptionMode: 'plain', tokenEpochHint: fixture.account.tokenEpoch,
                            token, serverId, serverIdentityId: homeId, serverHttpBaseUrl,
                            installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey,
                            sessionActionOrigin, isCurrent: isCallerCurrent,
                        });
                        return authorization ? { authorization, target } : null;
                    },
                    createExecutor: () => ({ execute: (actionId, input, context) => executor.execute(actionId, input, {
                        ...context, serverIdentityId: homeId, runtimeAccountId: fixture.account.id,
                        signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({
                            authorizationToken: args.authorization.token, actionId: args.actionId, input: args.input,
                            target: args.target, privateKey: fixture.keyPair.secretKey,
                        }),
                    }) }),
                });
                for (const name of ['Morgan Reed', '']) {
                    const requestFromInput = bindHomeDomainActionHttpRequestV1('account.name.set', { name });
                    expect(bindHomeDomainActionHttpRequestV1('account.name.set', requestFromInput.body)).toEqual(requestFromInput);
                    const before = effects;
                    const pending = await execute({ kind: 'action.execute', actionId: 'account.name.set', input: { name },
                        requestId: crypto.randomUUID(), witness: { turnId: 'name-turn', inputId: crypto.randomUUID(), callerPermissionMode: 'default',
                            userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
                            agentStartCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 } } },
                        { sessionId: session.id, isCurrent: async () => true });
                    expect(pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                    if (!pending.ok || !pending.result || typeof pending.result !== 'object' || !('artifactId' in pending.result)
                        || typeof pending.result.artifactId !== 'string') throw new Error('Expected durable approval reference');
                    const artifactId = pending.result.artifactId;
                    const request = ApprovalRequestV2Schema.parse(await artifacts.approvalsGet({ artifactId, serverId }));
                    expect(request.actionArgs).toEqual({ name: name || null });
                    expect(effects).toBe(before);
                    const decide = () => executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
                        { surface: 'ui', authority: 'present_user', serverId, serverIdentityId: homeId,
                            runtimeAccountId: fixture.account.id, actionCaller: { kind: 'host' } });
                    const decided = await decide();
                    const settled = ApprovalRequestV2Schema.parse(await artifacts.approvalsGet({ artifactId, serverId }));
                    expect(settled.execution?.errorCode, name === '' ? 'clear name replay' : 'set name replay').toBeUndefined();
                    expect(decided).toMatchObject({ ok: true, result: { status: 'executed' } });
                    expect((await db.account.findUniqueOrThrow({ where: { id: fixture.account.id } })).name).toBe(name || null);
                    expect(effects).toBe(before + 1);
                    expect(await decide()).toMatchObject({ ok: true });
                    expect(effects).toBe(before + 1);
                }
                publisher = null;
                // Mis-binding the actual source prevents admission even for a
                // canonical clear; no reference or profile effect may escape.
                expect(await execute({ kind: 'action.execute', actionId: 'account.name.set', input: { name: '' },
                    requestId: crypto.randomUUID(), witness: { turnId: 'name-turn', inputId: crypto.randomUUID(), callerPermissionMode: 'default',
                        userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
                        agentStartCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 } } },
                    { sessionId: session.id, isCurrent: async () => true })).toMatchObject({ ok: false,
                        errorCode: 'target_unavailable', details: { reason: 'external_authorization_refused' } });
                expect(effects).toBe(2);
            });
        } finally { await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('binds supplied Session publisher provenance on client and Account reads with %s credentials', async kind => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-source-key' } });
        let publisher: string | null = fixture.machine.id;
        const { app } = await createApp(fixture.team.id, false, async () => publisher);
        const token = await auth.createToken(fixture.account.id, undefined, kind === 'account'
            ? { kind, authority: 'present_user' } : { kind, authority: 'account_automation' });
        const homeId = await getOrCreateServerIdentityId();
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        try {
            for (const actionId of ['search.conversations', 'ui.find', 'workspace.tabs.list',
                'workflow.definition.list', 'workflow.definition.get', 'boards.list',
                'workflow.run.list', 'workflow.starters.list']) {
                const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                    caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                    sourceTurnId: 'client-read-turn', callerPermissionMode: null, requestId: crypto.randomUUID() });
                const input = actionId === 'search.conversations'
                    ? { query: { v: 1, query: 'session_handoff', scope: { type: 'global' }, mode: 'hints' },
                        machineIds: [fixture.machine.id], mode: 'indexed' }
                    : actionId === 'ui.find' ? { op: 'read' }
                    : actionId === 'workflow.definition.get' ? { definitionId: crypto.randomUUID() } : {};
                const envelope = { v: 1, requestId: origin.requestId,
                    target: { kind: 'machine', machineId: fixture.machine.id }, input } satisfies ExternalActionRequestEnvelopeV1;
                const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                    payload: { version: 1, accountId: fixture.account.id, ...source,
                        externalActionOrigin: { homeId, actionId, requestId: origin.requestId,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
                const body = { v: 1, machineId: fixture.machine.id, envelope,
                    sessionActionOrigin: origin, sessionActionSource: source, installationProof };
                const mint = (payload: unknown = body) => app.inject({ method: 'POST',
                    url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${token}` }, payload });
                const minted = await mint();
                expect(minted.statusCode, minted.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                expect(authorization.binding).toMatchObject({ actionId,
                    sessionActionOrigin: origin, sessionActionSource: source });
                expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                    accountId: fixture.account.id, authority: 'account_automation', sessionActionOrigin: origin });
                authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                    installationId: fixture.machine.installationId!, requestId: origin.requestId });
                const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
                const proofBody = { v: 1 };
                const verify = await app.inject({ method: 'POST', url: path, payload: proofBody,
                    headers: machineHeaders({ authorizationToken: authorization.token, method: 'POST', path,
                        body: proofBody, privateKey: fixture.keyPair.secretKey, effectActionId: actionId }) });
                expect(verify.statusCode, `${actionId}: ${verify.body}`).toBe(200);
                const missingProof = await mint({ ...body, installationProof: undefined });
                // Paired origin/proof validation may reject before credential
                // admission; neither refusal may mint an authorization token.
                expect([400, 401]).toContain(missingProof.statusCode);
                expect(missingProof.json()).toMatchObject(missingProof.statusCode === 400
                    ? { error: 'invalid_request', code: 'invalid_envelope' }
                    : { error: 'invalid_token' });
                expect(missingProof.json()).not.toHaveProperty('token');
                expect((await mint({ ...body, sessionActionOrigin: { ...origin, sourceTurnId: 'forged-turn' } })).statusCode).toBe(401);
                // Paired terminals also own standalone Account reads. Client
                // reads still require their installed Session caller proof.
                const standalone = await mint({ v: 1, machineId: fixture.machine.id, envelope });
                const standaloneAccountRead = kind === 'terminal' && ['workflow.definition.list', 'workflow.definition.get',
                    'boards.list', 'workflow.run.list', 'workflow.starters.list'].includes(actionId);
                expect(standalone.statusCode, actionId).toBe(standaloneAccountRead ? 200 : 401);
                if (standaloneAccountRead) expect(ExternalActionExecutionAuthorizationV1Schema.parse(standalone.json()).binding)
                    .not.toHaveProperty('sessionActionOrigin');
                publisher = null;
                expect((await mint()).statusCode).toBe(401);
                publisher = fixture.machine.id;
            }
        } finally { await app.close(); }
    });

    it.each((['account', 'terminal'] as const).flatMap(kind =>
        (['widgets.catalog.list', 'widgets.item.add'] as const).map(actionId => ({ kind, actionId }))))(
        'admits composed Session reads under their original $kind $actionId agent root without widening writes', async ({ kind, actionId }) => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const sibling = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const otherAccount = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const unreadable = await db.session.create({ data: { accountId: otherAccount.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-source-key' } });
        let publisher: string | null = fixture.machine.id;
        const { app } = await createApp(fixture.team.id, false, async () => publisher, undefined, false, registerSessionSystemRecordRoutes);
        const token = await auth.createToken(fixture.account.id, undefined, kind === 'account'
            ? { kind, authority: 'present_user' } : { kind, authority: 'account_automation' });
        const homeId = await getOrCreateServerIdentityId();
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        try {
                const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                    caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                    sourceTurnId: 'board-read-turn', callerPermissionMode: 'yolo', requestId: crypto.randomUUID() });
                const surface = { serverId: homeId, accountId: fixture.account.id, owner: { kind: 'sessionBoard', sessionId: session.id } };
                const input = actionId === 'widgets.item.add' ? { surface, instance: { v: 1, id: 'new-copy',
                    definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} },
                    placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' } } : { surface };
                const envelope = { v: 1, requestId: origin.requestId,
                    target: { kind: 'machine', machineId: fixture.machine.id }, input } satisfies ExternalActionRequestEnvelopeV1;
                const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                    payload: { version: 1, accountId: fixture.account.id, ...source,
                        externalActionOrigin: { homeId, actionId, requestId: origin.requestId,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
                const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id,
                        envelope, sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
                expect(issued.statusCode, issued.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
                const headers = (method: string, path: string, body?: unknown) => createExternalActionAuthorizedRequestHeaders({
                    authorization, effectActionId: method === 'GET' ? actionId : 'session.board.item.upsert',
                    target: authorization.binding.target, installationId: fixture.machine.installationId!,
                    method, path, ...(body === undefined ? {} : { body }), privateKey: fixture.keyPair.secretKey,
                });
                for (const path of [`/v2/sessions/${session.id}?accessProjectionVersion=1`,
                    `/v2/sessions/${session.id}/system-records/record?owner=host&namespace=surface&kind=layout.v1&localId=layout`,
                    `/v2/sessions/${session.id}/system-records?owner=host&namespace=surface&kind=item.v1&limit=100`]) {
                    const read = await app.inject({ method: 'GET', url: path, headers: {
                        ...headers('GET', path), [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE,
                    } });
                    expect(read.statusCode, `${actionId}: ${path}: ${read.body}`).toBe(200);
                }
                for (const [id, readStatus] of [[sibling.id, 200], [unreadable.id, 404]] as const) {
                    const path = `/v2/sessions/${id}?accessProjectionVersion=1`;
                    const read = await app.inject({ method: 'GET', url: path, headers: headers('GET', path) });
                    expect(read.statusCode, `${actionId}: ${read.body}`).toBe(actionId === 'widgets.item.add' ? 401 : readStatus);
                }
                const path = `/v2/sessions/${session.id}/board`;
                const mutation = SessionBoardMutationV1Schema.parse({ operation: 'update_layout',
                    expectedLayoutRevision: null, layoutContent: { t: 'plain', v: { v: 1, tabs: [] } } });
                const write = await app.inject({ method: 'PUT', url: path, payload: mutation, headers: headers('PUT', path, mutation) });
                expect(write.statusCode).toBe(401);
                publisher = null;
                const retiredPath = `/v2/sessions/${session.id}?accessProjectionVersion=1`;
                expect((await app.inject({ method: 'GET', url: retiredPath, headers: headers('GET', retiredPath) })).statusCode).toBe(401);
                publisher = fixture.machine.id;
        } finally { await app.close(); }
    });

    it.each([
        '/system-records/record?owner=host&namespace=surface&kind=layout.v1&localId=layout',
        '/data-key/envelopes?limit=1&state=all',
        '/subagents/custody/capability',
        '/subagents/custody',
        '/follow',
    ])('keeps a signed catalog PAT inside its granted Machine when reading Session %s', async suffix => {
        const fixture = await createFixture({ qualifiedPat: true });
        const own = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const outside = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: own.id, data: 'opaque-granted-machine-key' } });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['widgets.catalog.list'] },
            targets: { sessions: [], machines: [fixture.machine.id] } };
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: grant } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, routes => {
            registerSessionSystemRecordRoutes(routes);
            registerSessionDataKeyEnvelopeRoutes(routes);
            registerSessionSubagentCustodyRoutes(routes);
            registerSessionFollowRoutes(routes);
        });
        try {
            const homeId = await getOrCreateServerIdentityId();
            const root = await mint(app, fixture, 'widgets.catalog.list', { ...fixture.envelope,
                input: { surface: { serverId: homeId, accountId: fixture.account.id,
                    owner: { kind: 'sessionBoard', sessionId: own.id } } } });
            const read = async (sessionId: string) => {
                const scope = { pluginId: 'acme.agent', contributionId: 'assistant', sourceCustody: {
                    kind: 'managed', immutableGenerationId: 'l68-custody', installSource: 'npm',
                } } as const;
                const query = suffix === '/subagents/custody' ? `?${new URLSearchParams({
                    pluginId: scope.pluginId, contributionId: scope.contributionId,
                    sourceCustody: JSON.stringify(scope.sourceCustody),
                    custodyKey: createSessionSubagentCustodyKeyV1({ ...scope, sessionId }),
                })}` : '';
                const path = `/v2/sessions/${sessionId}${suffix}${query}`;
                return await app.inject({ method: 'GET', url: path, headers: {
                    ...createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: 'widgets.catalog.list',
                        target: root.binding.target, installationId: fixture.machine.installationId!, method: 'GET', path,
                        privateKey: fixture.keyPair.secretKey }),
                    [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE,
                } });
            };
            const allowed = await read(own.id);
            expect(allowed.statusCode, allowed.body).toBe(200);
            const denied = await read(outside.id);
            expect(denied.statusCode, denied.body).toBe(401);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: API_TOKEN_FULL_GRANT_V1 } });
            const expanded = await read(outside.id);
            expect(expanded.statusCode, expanded.body).toBe(401);
        } finally { await app.close(); }
    });

    it.each([
        { scope: 'granted', targetKind: 'machine' },
        { scope: 'granted', targetKind: 'session' },
        { scope: 'outside-grant', targetKind: 'machine' },
        { scope: 'outside-grant', targetKind: 'session' },
    ] as const)('refuses a signed catalog PAT system-record PUT in a $scope Session with a $targetKind target without persisting', async ({ scope, targetKind }) => {
        const fixture = await createFixture({ qualifiedPat: true });
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        if (scope === 'granted') await db.accessKey.create({ data: { accountId: fixture.account.id,
            machineId: fixture.machine.id, sessionId: session.id, data: 'opaque-granted-machine-key' } });
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
            ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['widgets.catalog.list'] },
            targets: { sessions: [], machines: [fixture.machine.id] },
        } } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerSessionSystemRecordRoutes);
        try {
            const root = await mint(app, fixture, 'widgets.catalog.list', { ...fixture.envelope,
                input: { surface: { serverId: await getOrCreateServerIdentityId(), accountId: fixture.account.id,
                    owner: { kind: 'sessionBoard', sessionId: session.id } } } });
            const body = { address: { owner: 'host', namespace: 'memory', kind: 'synopsis.v1', localId: 'catalog-write' },
                expectedRevision: null, content: { t: 'plain', v: { v: 1, seqTo: 0, updatedAtMs: 0, synopsis: 'Forbidden write' } } };
            const path = `/v2/sessions/${session.id}/system-records`;
            const result = await app.inject({ method: 'PUT', url: path, payload: body, headers: {
                ...createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: root.binding.actionId,
                    target: targetKind === 'session' ? { kind: 'session', sessionId: session.id } : root.binding.target,
                    installationId: fixture.machine.installationId!, method: 'PUT', path, body,
                    privateKey: fixture.keyPair.secretKey }),
                [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE,
            } });
            const persisted = await db.sessionSystemRecord.findFirst({ where: { sessionId: session.id, localId: 'catalog-write' } });
            expect({ status: result.statusCode, persisted: persisted !== null }, result.body).toEqual({ status: 401, persisted: false });
        } finally { await app.close(); }
    });

    it.each(['widgets.catalog.list', 'follow.set'])('refuses a signed catalog PAT Follow PUT using effect %s without changing personal Follow state', async effectActionId => {
        const fixture = await createFixture({ qualifiedPat: true });
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-granted-machine-key' } });
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
            ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['widgets.catalog.list'] },
            targets: { sessions: [], machines: [fixture.machine.id] },
        } } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerSessionFollowRoutes);
        try {
            const root = await mint(app, fixture, 'widgets.catalog.list', { ...fixture.envelope,
                input: { surface: { serverId: await getOrCreateServerIdentityId(), accountId: fixture.account.id,
                    owner: { kind: 'sessionBoard', sessionId: session.id } } } });
            const path = `/v2/sessions/${session.id}/follow`;
            const body = { notificationLevel: 'none', includeInVoice: true };
            const result = await app.inject({ method: 'PUT', url: path, payload: body,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId,
                    target: root.binding.target, installationId: fixture.machine.installationId!, method: 'PUT', path, body,
                    privateKey: fixture.keyPair.secretKey }) });
            const persisted = await db.accountSessionFollow.findUnique({ where: {
                accountId_sessionId: { accountId: fixture.account.id, sessionId: session.id },
            } });
            expect({ status: result.statusCode, persisted: persisted !== null }, result.body).toEqual({ status: 401, persisted: false });
        } finally { await app.close(); }
    });

    it('admits the actual signed Follow mutation while retaining its captured Session ceiling', async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const own = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const outside = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: own.id, data: 'opaque-granted-machine-key' } });
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
            ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['follow.set'] },
            targets: { sessions: [], machines: [fixture.machine.id] },
        } } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerSessionFollowRoutes);
        try {
            const body = { policy: { preset: 'quiet' } };
            const root = await mint(app, fixture, 'follow.set', { ...fixture.envelope,
                input: { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: own.id }, ...body } });
            const write = (sessionId: string) => {
                const path = `/v2/sessions/${sessionId}/follow`;
                return app.inject({ method: 'PUT', url: path, payload: body,
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: root.binding.actionId,
                        target: root.binding.target, installationId: fixture.machine.installationId!, method: 'PUT', path, body,
                        privateKey: fixture.keyPair.secretKey }) });
            };
            const allowed = await write(own.id);
            expect(allowed.statusCode, allowed.body).toBe(200);
            expect(await db.accountSessionFollow.findUnique({ where: {
                accountId_sessionId: { accountId: fixture.account.id, sessionId: own.id },
            } })).toMatchObject({ following: true });
            expect(allowed.json().follow.policy).toEqual(body.policy);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: API_TOKEN_FULL_GRANT_V1 } });
            const denied = await write(outside.id);
            expect(denied.statusCode, denied.body).toBe(401);
            expect(await db.accountSessionFollow.findUnique({ where: {
                accountId_sessionId: { accountId: fixture.account.id, sessionId: outside.id },
            } })).toBeNull();
        } finally { await app.close(); }
    });

    it('admits only the signed private Follow phases and preserves full-Account census authority', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerSessionFollowRoutes);
        const receiver = { kind: 'account' } as const;
        const ruleId = 'private-project';
        const definition = SessionFollowRuleDefinitionV1Schema.parse({ v: 1, enabled: true,
            filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } });
        const content = sealSessionFollowRuleContentV1({ ruleId, receiver, definition, mode: 'plain', material: null });
        const source = { kind: 'rule', ruleId } as const;
        const path = `/v2/account/session-follow-rules/${ruleId}`;
        try {
            const root = await mint(app, fixture, 'follow.set', { ...fixture.envelope, input: { receiver, source,
                ruleDefinition: { v: definition.v, enabled: definition.enabled, filter: definition.filter },
                policy: definition.policy, expectedVersion: -1 } });
            const request = (authorization: typeof root, method: 'GET' | 'PUT' | 'DELETE', url: string,
                body?: unknown, effectActionId: string = authorization.binding.actionId) => app.inject({ method, url,
                ...(body === undefined ? {} : { payload: body }), headers: machineHeaders({
                    authorizationToken: authorization.token, method, path: url, body, effectActionId,
                    privateKey: fixture.keyPair.secretKey }) });
            const currentness = await request(root, 'GET', '/v1/account/encryption/currentness');
            expect(currentness.statusCode, currentness.body).toBe(200);
            const saved = await request(root, 'PUT', path, { receiver, content, expectedVersion: -1 });
            expect(saved.statusCode, saved.body).toBe(200);
            expect(saved.json().rule).toMatchObject({ ruleId, receiver, version: 0, content });
            expect((await request(root, 'GET', '/v2/account/session-follow-rules')).statusCode).toBe(401);
            expect((await request(root, 'GET', '/v2/account/settings')).statusCode).toBe(401);
            expect((await request(root, 'DELETE', path, { receiver, expectedVersion: 0 }, 'follow.remove')).statusCode).toBe(401);
            const reader = await mint(app, fixture, 'follow.get', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { receiver, source } });
            const read = await request(reader, 'GET', path);
            expect([read.statusCode, read.json()]).toEqual([200, saved.json()]);
            expect((await request(reader, 'PUT', path, { receiver, content, expectedVersion: 0 })).statusCode).toBe(401);
            const listing = await mint(app, fixture, 'follow.list', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { receiver, direction: 'following' } });
            const census = await request(listing, 'GET', '/v2/account/session-follow-rules');
            expect([census.statusCode, census.json()]).toEqual([200, { rules: [saved.json().rule] }]);
            const removal = await mint(app, fixture, 'follow.remove', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { receiver, source, expectedVersion: 0 } });
            expect((await request(removal, 'GET', '/v1/account/encryption/currentness')).statusCode).toBe(401);
            expect((await request(removal, 'GET', '/v2/account/session-follow-rules')).statusCode).toBe(401);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
                ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['follow.get', 'follow.list'] },
                targets: { sessions: [], machines: [fixture.machine.id] },
            } } });
            const restricted = await mint(app, fixture, 'follow.list', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { receiver, direction: 'following' } });
            const denied = await request(restricted, 'GET', '/v2/account/session-follow-rules');
            expect([denied.statusCode, denied.json()]).toEqual([403, { error: 'credential_scope_denied' }]);
            const restrictedReader = await mint(app, fixture, 'follow.get', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { receiver, source } });
            const privateDenied = await request(restrictedReader, 'GET', path);
            expect([privateDenied.statusCode, privateDenied.json()]).toEqual([403, { error: 'credential_scope_denied' }]);
        } finally { await app.close(); }
    });

    it.each(['discussion.post', 'discussion.reply'] as const)('admits only the signed %s participant-policy companion read', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED', '1');
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerDiscussionRoutes);
        try {
            const foreignAccount = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const discussions: string[] = [];
            for (const account of [fixture.account, foreignAccount]) {
                const created = await createDiscussion({ actorAccountId: account.id,
                    authentication: createPresentUserSessionAccessAuthentication(), request: {
                        creationLocalId: crypto.randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Policy companion' } },
                        firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: { v: 1,
                            parts: [{ t: 'text', text: 'Current participant policy' }] } }, mentionedAccountIds: [] },
                    } });
                if (!created.ok) throw new Error(created.error);
                discussions.push(created.value.discussion.id);
            }
            const discussionId = discussions[0]!;
            const path = `/v1/discussions/${discussionId}/participants`;
            const root = await mint(app, fixture, actionId, { ...fixture.envelope, requestId: crypto.randomUUID(),
                input: { discussionId, localId: crypto.randomUUID(), replyTarget: { kind: 'message', messageId: 'question' },
                    content: { v: 1, parts: [{ t: 'text', text: 'Addressed reply' }] } } });
            const headers = (method: string, requestPath: string, body?: unknown) => machineHeaders({
                authorizationToken: root.token, effectActionId: actionId, method, path: requestPath, body,
                privateKey: fixture.keyPair.secretKey });
            const verify = (method: string, requestPath: string, body?: unknown, routeInput?: unknown,
                effectActionId: string = actionId, machineSignature?: string) => verifyExternalActionDomainExecutionRequest({
                authorizationToken: root.token, effectActionId, encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target),
                method, path: requestPath, body, routeInput,
                machineSignature: machineSignature ?? signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId, target: root.binding.target, installationId: fixture.machine.installationId!,
                    requestId: root.binding.requestId, method, path: requestPath, body, privateKey: fixture.keyPair.secretKey }),
            });
            expect(await verify('GET', path, undefined, { discussionId })).not.toBeNull();
            const admitted = await app.inject({ method: 'GET', url: path, headers: headers('GET', path) });
            expect([admitted.statusCode, admitted.json()]).toMatchObject([200, { discussionId, participants: [] }]);
            // The installed host signs decrypted operands, not a new grant. A
            // different Account's Discussion remains private at the real route.
            const privatePath = `/v1/discussions/${discussions[1]!}/participants`;
            expect((await app.inject({ method: 'GET', url: privatePath,
                headers: headers('GET', privatePath) })).statusCode).toBe(404);
            for (const [method, requestPath, body, routeInput] of [
                ['GET', path, undefined, { discussionId: 'other' }],
                ['GET', '/v1/discussions/other/participants', undefined, { discussionId }],
                ['GET', `${path}?includeMessages=true`, undefined, { discussionId }],
                ['GET', path, {}, { discussionId }],
                ['POST', path, {}, { discussionId }],
                ['POST', `${path}/invite`, { participant: { kind: 'account', accountId: foreignAccount.id } },
                    { discussionId, participant: { kind: 'account', accountId: foreignAccount.id } }],
            ] as const) expect(await verify(method, requestPath, body, routeInput), `${method} ${requestPath}`).toBeNull();
            expect(await verify('GET', path, undefined, { discussionId }, 'discussion.participants.list')).toBeNull();
            expect(await verify('GET', path, undefined, { discussionId }, actionId, '')).toBeNull();
            const unsignedHeaders = headers('GET', path);
            delete unsignedHeaders[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
            expect((await app.inject({ method: 'GET', url: path, headers: unsignedHeaders })).statusCode).toBe(401);
            const queryPath = `${path}?includeMessages=true`;
            expect((await app.inject({ method: 'GET', url: queryPath, headers: headers('GET', queryPath) })).statusCode).toBe(401);
            expect((await db.discussionMessage.count({ where: { discussionId } }))).toBe(1);
        } finally { await app.close(); vi.unstubAllEnvs(); }
    });

    it('composes fresh Session status with accepted checkout through signed requester HTTP', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const homeId = await getOrCreateServerIdentityId();
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: null } as const;
        const ref = { id: crypto.randomUUID(), serverId: homeId, machineId: fixture.machine.id,
            rootPath: '/fresh-project', projectKey: crypto.randomUUID(), createdAtMs: 1 };
        const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain',
            storedContentMode: 'plain', metadata: createTestMetadata({ machineId: ref.machineId, path: ref.rootPath,
                workspaceId: ref.id, projectId: ref.projectKey }), agentState: null });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadataLayoutVersion: fields.metadataLayoutVersion,
            metadata: fields.sharedMetadata.ciphertext, ownerMetadata: JSON.stringify(fields.ownerMetadata), agentState: fields.agentState } });
        const reads: Array<{ path: string; status: number }> = [];
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, routes => {
            routes.addHook('onResponse', async (request, reply) => {
                if (request.url.startsWith('/v1/account/project-rows/')) reads.push({ path: request.url, status: reply.statusCode });
            });
        });
        const channel = await createRequesterCurrentnessSocketHarness();
        try {
            const key = { kind: 'workspace-ref', serverId: homeId, id: ref.id } as const;
            const graphKey = { kind: 'relationship-graph' } as const;
            const seeded = await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate',
                headers: { authorization: `Bearer ${token}` }, payload: ProjectAccountRowMutationRequestV1Schema.parse({
                    mutations: [{ key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: ref } } },
                        { key: graphKey, expectedRevision: 'absent', content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } }],
                    expectedRefs: [], topologyChange: true }) });
            expect(seeded.statusCode, seeded.body).toBe(200);
            reads.length = 0;
            const input = { sessionId: session.id, includeAcceptedWorkspace: true };
            const authorization = await mint(app, fixture, 'session.status.get', { ...fixture.envelope, input });
            const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
            const http = await projectExternalActionRequesterHttpAuthorization({ authorization, serverId: homeId,
                serverIdentityId: homeId, serverHttpBaseUrl, target: authorization.binding.target,
                installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey });
            if (!http) throw new Error('Signed requester HTTP was not admitted');
            const projected = await projectRequesterAccountActionAuthorization({ authorization: http, serverIdentityId: homeId,
                bootstrap: { credentials, serverHttpBaseUrl, isCurrent: async () => true,
                    attribution: { serverId: homeId, accountId: fixture.account.id, machineId: fixture.machine.id,
                        installationId: fixture.machine.installationId! } } });
            if (!projected) throw new Error('Requester Account projection was not admitted');
            const executor = createActionExecutor(createCliActionDeps({ credentials, token, sessionId: session.id,
                serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl, mode: 'plain', ctx: null,
                externalActionMachineRequestPrivateKey: fixture.keyPair.secretKey,
                externalActionMachineInstallationId: fixture.machine.installationId! }));
            const result = await executor.execute('session.status.get', input, {
                surface: 'ui', authority: 'present_user', serverId: homeId, defaultSessionId: session.id, runtimeAccountId: fixture.account.id,
                externalActionExecutionAuthorization: projected, externalActionTarget: projected.binding.target,
            });
            expect(result, JSON.stringify({ reads, result })).toMatchObject({ ok: true, result: { session: { id: session.id },
                acceptedWorkspace: { checkout: { serverId: homeId, workspaceId: ref.id, machineId: ref.machineId, rootPath: ref.rootPath } } } });
            expect(reads).toEqual([{ path: '/v1/account/project-rows/read', status: 200 }]);
            // Older path-associated Sessions consume the same signed owner,
            // with a Home/kind-filtered census rather than an accepted id.
            const pathFields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain',
                storedContentMode: 'plain', metadata: createTestMetadata({ machineId: ref.machineId, path: ref.rootPath,
                    projectId: ref.projectKey }), agentState: null });
            await db.session.update({ where: { id: session.id }, data: {
                metadata: pathFields.sharedMetadata.ciphertext, ownerMetadata: JSON.stringify(pathFields.ownerMetadata) } });
            reads.length = 0;
            expect(await executor.execute('session.status.get', input, {
                surface: 'ui', authority: 'present_user', serverId: homeId, defaultSessionId: session.id, runtimeAccountId: fixture.account.id,
                externalActionExecutionAuthorization: projected, externalActionTarget: projected.binding.target,
            })).toMatchObject({ ok: true, result: { acceptedWorkspace: { checkout: { workspaceId: ref.id } } } });
            expect(reads).toEqual([{ path: '/v1/account/project-rows/list', status: 200 }]);
        } finally { await channel.close(); await app.close(); }
    });

    it('admits declaration-owned SessionTarget preparation reads only under the original signed root', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED', '1');
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, routes => {
            registerSessionFollowRoutes(routes);
            registerDiscussionRoutes(routes);
        });
        const actionId = 'session.status.get';
        const query = buildSessionListServerQueryV1(projectSessionListFilterHomeQueriesV1(normalizeSessionListFilterV1({
            show: 'sessions', scope: 'all_accessible', homeServerIds: ['home'],
        }),
            { storage: 'active', includeInactive: true, mountedHomeServerIds: ['home'] })[0]!.query);
        const issue = (root = actionId) => mint(app, fixture, root, { ...fixture.envelope, requestId: crypto.randomUUID(),
            input: { sessionId: { selector: 'followers', of: session.id } } });
        try {
            const authorization = await issue();
            const verify = (method: string, path: string, body?: unknown, routeInput?: unknown,
                sessionRouteTarget?: { kind: 'session'; sessionId: string; actionId: 'follow.list' },
                root = authorization, effectActionId = root.binding.actionId, target = root.binding.target) =>
                verifyExternalActionDomainExecutionRequest({ authorizationToken: root.token, effectActionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(target), method, path, body, routeInput, sessionRouteTarget,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId,
                        target, installationId: fixture.machine.installationId!, requestId: root.binding.requestId,
                        method, path, body, privateKey: fixture.keyPair.secretKey }) });
            const participantsPath = '/v1/discussions/discussion-1/participants';
            const censusPath = '/v2/account/session-follow-rules';
            const assignmentsRead = buildSessionOrganizationAssignmentSnapshotHttpRequestV1([session.id]);
            const assignmentsPath = assignmentsRead.path;
            const assignmentsInput = assignmentsRead.query;
            const sourcesPath = `/v2/sessions/${session.id}/follows/sessions`;
            const followersPath = `/v2/sessions/${session.id}/follows/followers`;
            const scope = { kind: 'session' as const, sessionId: session.id, actionId: 'follow.list' as const };
            for (const [method, path, body, routeInput] of [
                ['POST', '/v2/sessions/query', query, query],
                ['GET', '/v1/account/encryption/currentness', undefined, {}],
                ['GET', '/v1/features/authenticated', undefined, {}],
                ['GET', censusPath, undefined, {}],
                ['GET', participantsPath, undefined, { discussionId: 'discussion-1' }],
                ['POST', '/v1/account/project-rows/list', {}, {}],
                ['POST', '/v1/account/project-rows/read', { key: { kind: 'workspace-ref', serverId: 'home', id: 'checkout' } },
                    { key: { kind: 'workspace-ref', serverId: 'home', id: 'checkout' } }],
                ['POST', '/v1/account/project-rows/list', { kinds: ['workspace-ref'], serverId: 'home' },
                    { kinds: ['workspace-ref'], serverId: 'home' }],
                ['GET', assignmentsPath, undefined, assignmentsInput],
            ] as const) expect(await verify(method, path, body, routeInput), path).not.toBeNull();
            expect(await verify('GET', sourcesPath, undefined, { destinationSessionId: session.id }, scope)).not.toBeNull();
            expect(await verify('GET', followersPath, undefined, { sourceSessionId: session.id }, scope)).not.toBeNull();
            const preview = await mint(app, fixture, 'session.targets.resolve', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { actionId: 'session.goal.get',
                    target: { selector: 'workers', of: session.id } } });
            // Inspection prepares the same canonical selection under its own
            // signed read root; the described Action grants no effect authority.
            expect.soft(await verify('GET', '/v1/account/encryption/currentness', undefined, {}, undefined, preview)).not.toBeNull();
            expect.soft(await verify('POST', '/v2/sessions/query', query, query, undefined, preview)).not.toBeNull();
            expect(await verify('GET', '/v1/account/encryption/currentness', undefined, {}, undefined,
                preview, 'session.goal.get')).toBeNull();
            expect(await verify('GET', '/v2/account/settings', undefined, {}, undefined, preview)).toBeNull();
            const goalSelection = await mint(app, fixture, 'session.goal.set', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { objective: 'Selected child goal',
                    sessionId: { selector: 'self', of: session.id } } });
            const detailPath = `/v2/sessions/${session.id}`;
            const detailProof = (path: string, root = goalSelection, targetSessionId = session.id) => ({
                authorizationToken: root.token, effectActionId: root.binding.actionId,
                encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target), method: 'GET', path,
                routeInput: { sessionId: targetSessionId, ...(path.includes('?') ? { accessProjectionVersion: 1 } : {}) },
                sessionRouteTarget: { kind: 'session' as const, sessionId: targetSessionId, actionId: 'session.transcript.get' as const },
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: root.binding.actionId, target: root.binding.target,
                    installationId: fixture.machine.installationId!, requestId: root.binding.requestId,
                    method: 'GET', path, privateKey: fixture.keyPair.secretKey }) });
            expect.soft(await verifyExternalActionDomainExecutionRequest(detailProof(detailPath))).not.toBeNull();
            expect.soft(await verifyExternalActionDomainExecutionRequest(detailProof(`${detailPath}?accessProjectionVersion=1`))).not.toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(detailProof(`${detailPath}?includeMessages=true`))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(detailProof(`/v1/sessions/${session.id}/messages`))).toBeNull();
            const census = await app.inject({ method: 'GET', url: censusPath, headers: machineHeaders({
                authorizationToken: authorization.token, effectActionId: actionId, method: 'GET', path: censusPath,
                body: undefined, privateKey: fixture.keyPair.secretKey }) });
            expect([census.statusCode, census.json()]).toEqual([200, { rules: [] }]);
            const get = (path: string) => app.inject({ method: 'GET', url: path, headers: machineHeaders({
                authorizationToken: authorization.token, effectActionId: actionId, method: 'GET', path,
                body: undefined, privateKey: fixture.keyPair.secretKey }) });
            const foreignAccount = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const foreignSession = await db.session.create({ data: { accountId: foreignAccount.id, tag: crypto.randomUUID(),
                encryptionMode: 'plain', metadata: '{}' } });
            const listed = await app.inject({ method: 'POST', url: '/v2/sessions/query', payload: query, headers: machineHeaders({
                authorizationToken: authorization.token, effectActionId: actionId, method: 'POST', path: '/v2/sessions/query',
                body: query, privateKey: fixture.keyPair.secretKey }) });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().sessions.map((row: { id: string }) => row.id)).toEqual([session.id]);
            const sourceList = await get(sourcesPath);
            expect(sourceList.statusCode, sourceList.body).toBe(200);
            expect((await get(`/v2/sessions/${foreignSession.id}/follows/sessions`)).statusCode).toBe(404);
            for (const owner of [fixture.account, foreignAccount]) {
                const created = await createDiscussion({ actorAccountId: owner.id,
                    authentication: createPresentUserSessionAccessAuthentication(), request: {
                        creationLocalId: crypto.randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Selector access' } },
                        firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: { v: 1,
                            parts: [{ t: 'text', text: 'Participants' }] } }, mentionedAccountIds: [] },
                    } });
                if (!created.ok) throw new Error(created.error);
                const response = await get(`/v1/discussions/${created.value.discussion.id}/participants`);
                expect(response.statusCode, response.body).toBe(owner.id === fixture.account.id ? 200 : 404);
            }
            for (const [method, path, body, routeInput] of [
                ['POST', '/v2/sessions/query', { ...query, accountId: 'foreign' }, undefined],
                ['POST', '/v2/sessions/query?extra=true', query, undefined],
                ['GET', '/v2/sessions/query', undefined, undefined],
                ['GET', participantsPath, undefined, { discussionId: 'other' }],
                ['GET', `${participantsPath}?includeMessages=true`, undefined, { discussionId: 'discussion-1' }],
                ['POST', '/v1/discussions/discussion-1/participants/invite', { participant: { kind: 'account', accountId: 'foreign' } },
                    { discussionId: 'discussion-1', participant: { kind: 'account', accountId: 'foreign' } }],
                ['PUT', censusPath, {}, undefined],
                ['GET', `${censusPath}?accountId=foreign`, undefined, { accountId: 'foreign' }],
                ['POST', '/v1/account/project-rows/mutate', {}, undefined],
                ['POST', '/v1/account/project-rows/read', { key: { kind: 'workspace-ref', serverId: 'home', id: 'checkout' }, extra: true }, undefined],
                ['POST', '/v1/account/project-rows/list', { kinds: ['workspace-ref'], extra: true }, undefined],
                ['POST', '/v1/account/project-rows/read?extra=true', { key: { kind: 'workspace-ref', serverId: 'home', id: 'checkout' } }, undefined],
                ['GET', `${assignmentsPath}&includeAllTagAssignments=true`, undefined, { ...assignmentsInput, includeAllTagAssignments: true }],
                ['GET', '/v2/account/settings', undefined, {}],
            ] as const) expect(await verify(method, path, body, routeInput), path).toBeNull();
            expect(await verify('GET', censusPath, undefined, {}, undefined, authorization, 'follow.list')).toBeNull();
            expect(await verify('GET', censusPath, undefined, {}, undefined, authorization, actionId,
                { kind: 'machine', machineId: 'foreign-machine' })).toBeNull();
            const unrelated = await issue('agents.models.list');
            expect(await verify('GET', censusPath, undefined, {}, undefined, unrelated)).toBeNull();
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
                ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
            } } });
            const actionRestricted = await issue();
            const privateDenied = await app.inject({ method: 'GET', url: censusPath, headers: machineHeaders({
                authorizationToken: actionRestricted.token, effectActionId: actionId, method: 'GET', path: censusPath,
                body: undefined, privateKey: fixture.keyPair.secretKey }) });
            expect([privateDenied.statusCode, privateDenied.json()]).toEqual([403, { error: 'credential_scope_denied' }]);
            for (const [path, body] of [
                ['/v1/account/project-rows/read', { key: { kind: 'workspace-ref', serverId: 'home', id: 'checkout' } }],
                ['/v1/account/project-rows/list', { kinds: ['workspace-ref'], serverId: 'home' }],
                ['/v1/account/project-rows/list', {}],
            ] as const) {
                const denied = await app.inject({ method: 'POST', url: path, payload: body, headers: machineHeaders({
                    authorizationToken: actionRestricted.token, effectActionId: actionId, method: 'POST', path,
                    body, privateKey: fixture.keyPair.secretKey }) });
                expect(denied.statusCode).toBe(401);
            }
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
                ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId, 'session.goal.set'] },
                targets: { sessions: [session.id], machines: [fixture.machine.id] },
            } } });
            const restricted = await issue();
            for (const [method, path, body, routeInput] of [
                ['POST', '/v2/sessions/query', query, query], ['GET', censusPath, undefined, {}],
                ['GET', participantsPath, undefined, { discussionId: 'discussion-1' }],
                ['POST', '/v1/account/project-rows/list', {}, {}],
                ['POST', '/v1/account/project-rows/read', { key: { kind: 'workspace-ref', serverId: 'home', id: 'checkout' } },
                    { key: { kind: 'workspace-ref', serverId: 'home', id: 'checkout' } }],
                ['POST', '/v1/account/project-rows/list', { kinds: ['workspace-ref'], serverId: 'home' },
                    { kinds: ['workspace-ref'], serverId: 'home' }],
            ] as const) expect(await verify(method, path, body, routeInput, undefined, restricted), path).toBeNull();
            expect(await verify('GET', sourcesPath, undefined, { destinationSessionId: session.id }, scope, restricted)).not.toBeNull();
            expect(await verify('GET', '/v2/sessions/outside/follows/sessions', undefined, { destinationSessionId: 'outside' },
                { ...scope, sessionId: 'outside' }, restricted)).toBeNull();
            const restrictedGoal = await mint(app, fixture, 'session.goal.set', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { objective: 'Selected child goal',
                    sessionId: { selector: 'self', of: session.id } } });
            expect(await verifyExternalActionDomainExecutionRequest(detailProof(detailPath, restrictedGoal))).not.toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(detailProof(`/v2/sessions/${foreignSession.id}`,
                restrictedGoal, foreignSession.id))).toBeNull();
        } finally { await app.close(); vi.unstubAllEnvs(); }
    });

    it('admits installed contributed target preparation without inspection borrowing final Session read authority', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false);
        const query = buildSessionListServerQueryV1(projectSessionListFilterHomeQueriesV1(normalizeSessionListFilterV1({
            show: 'sessions', scope: 'all_accessible', homeServerIds: ['home'],
        }), { storage: 'active', includeInactive: true, mountedHomeServerIds: ['home'] })[0]!.query);
        try {
            const contributed = await mint(app, fixture, 'action.invoke', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { action: { pluginId: 'example.session-targets', localId: 'inspect' },
                    input: { sessionId: { selector: 'workers', of: session.id } } } });
            const preview = await mint(app, fixture, 'session.targets.resolve', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { actionId: 'example.session-targets/actions/inspect',
                    target: { selector: 'workers', of: session.id } } });
            for (const root of [contributed, preview]) {
                const verify = (method: string, path: string, body?: unknown, routeInput?: unknown,
                    sessionRouteTarget?: { kind: 'session'; sessionId: string; actionId: 'session.transcript.get' },
                    effectActionId = root.binding.actionId) => verifyExternalActionDomainExecutionRequest({
                    authorizationToken: root.token, effectActionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target), method, path, body, routeInput, sessionRouteTarget,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId,
                        target: root.binding.target, installationId: fixture.machine.installationId!, requestId: root.binding.requestId,
                        method, path, body, privateKey: fixture.keyPair.secretKey }),
                });
                const scope = { kind: 'session' as const, sessionId: session.id, actionId: 'session.transcript.get' as const };
                expect(await verify('GET', '/v1/account/encryption/currentness', undefined, {})).not.toBeNull();
                expect(await verify('POST', '/v2/sessions/query', query, query)).not.toBeNull();
                expect(await verify('GET', `/v2/sessions/${session.id}`, undefined, { sessionId: session.id }, scope)).not.toBeNull();
                expect(await verify('GET', '/v1/account/encryption/currentness', undefined, {}, undefined, 'session.status.get')).toBeNull();
                expect(await verify('GET', '/v2/account/settings', undefined, {})).toBeNull();
                expect(await verify('GET', `/v1/sessions/${session.id}/messages`, undefined, { sessionId: session.id }, scope)).toBeNull();
            }
        } finally { await app.close(); }
    });

    it('admits signed Follow preview corpus phases without widening collection or private Account authority', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }) } });
        const projectRowKey = { kind: 'relationship-graph' as const };
        const projectRowContent = { t: 'plain', v: { key: projectRowKey, value: { relationships: [] } } };
        await db.userKVStore.create({ data: { accountId: fixture.account.id, key: buildProjectAccountRowPhysicalKeyV1(projectRowKey),
            version: 0, value: new TextEncoder().encode(JSON.stringify(projectRowContent)) } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, routes => {
            enableErrorHandlers(routes);
            registerSessionFollowRoutes(routes);
            registerSessionOrganizationRoutes(routes);
        });
        const filter = normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible', homeServerIds: ['home'],
            underSessionId: session.id, projects: { include: [{ serverId: 'home', projectKey: 'payments' }], exclude: [] } });
        const query = buildSessionListServerQueryV1(projectSessionListFilterHomeQueriesV1(filter,
            { storage: 'active', includeInactive: true, mountedHomeServerIds: ['home'] })[0]!.query);
        const input = { receiver: { kind: 'account' }, filter };
        const mintPreview = () => mint(app, fixture, 'follow.preview', { ...fixture.envelope, requestId: crypto.randomUUID(), input });
        try {
            const root = await mintPreview();
            const request = (authorization: typeof root, method: 'GET' | 'POST', path: string, body?: unknown,
                effectActionId: string = authorization.binding.actionId) => app.inject({ method, url: path,
                ...(body === undefined ? {} : { payload: body }), headers: machineHeaders({
                    authorizationToken: authorization.token, method, path, body, effectActionId, privateKey: fixture.keyPair.secretKey }) });
            expect((await request(root, 'GET', '/v1/account/encryption/currentness')).statusCode).toBe(200);
            const listed = await request(root, 'POST', '/v2/sessions/query', query);
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().sessions.map((row: { id: string }) => row.id)).toEqual([session.id]);
            const projects = await request(root, 'POST', '/v1/account/project-rows/list', {});
            expect(projects.statusCode, projects.body).toBe(200);
            expect(projects.json()).toMatchObject({ status: 'listed', coverage: 'complete',
                rows: [{ key: projectRowKey, revision: 0, content: projectRowContent }] });
            const fullOuter = await mint(app, fixture, 'approval.request.create', { ...fixture.envelope, requestId: crypto.randomUUID() });
            const wrappedProjects = await request(fullOuter, 'POST', '/v1/account/project-rows/list', {}, 'follow.preview');
            expect([wrappedProjects.statusCode, wrappedProjects.json()]).toEqual([200, projects.json()]);
            const assignmentsPath = `/v2/session-organization?includeFolders=false&includeTags=false&includeLabels=false&assignmentSessionIds=${session.id}`;
            const assignments = await request(root, 'GET', assignmentsPath);
            expect(assignments.statusCode, assignments.body).toBe(200);
            expect(assignments.json()).toMatchObject({ snapshot: { tagAssignments: [] } });
            expect((await request(fullOuter, 'GET', assignmentsPath, undefined, 'follow.preview')).statusCode).toBe(200);
            expect((await request(root, 'GET', `${assignmentsPath}&includeAllTagAssignments=true`)).statusCode).toBe(401);
            expect((await request(root, 'GET', assignmentsPath.replace('includeTags=false', 'includeTags=true'))).statusCode).toBe(401);
            expect((await request(root, 'POST', '/v2/sessions/query', { ...query, accountId: 'other' })).statusCode).toBe(400);
            expect((await request(root, 'POST', '/v2/sessions/query', query, 'session.list')).statusCode).toBe(401);
            for (const path of ['/v2/account/settings', '/v1/kv', '/v2/account/session-follow-rules']) {
                expect((await request(root, 'GET', path)).statusCode).toBe(401);
            }
            const key = { kind: 'relationship-graph' };
            expect((await request(root, 'POST', '/v1/account/project-rows/mutate', {
                mutations: [{ key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: { relationships: [] } } } }],
                expectedRefs: [], topologyChange: true,
            })).statusCode).toBe(401);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
                ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['follow.preview'] }, targets: null,
            } } });
            const actionOnly = await mintPreview();
            expect((await request(actionOnly, 'GET', '/v1/account/encryption/currentness')).statusCode).toBe(200);
            const scopedList = await request(actionOnly, 'POST', '/v2/sessions/query', query);
            expect(scopedList.statusCode, scopedList.body).toBe(200);
            expect(scopedList.json().sessions.map((row: { id: string }) => row.id)).toEqual([session.id]);
            expect((await request(actionOnly, 'POST', '/v1/account/project-rows/list', {})).statusCode).toBe(401);
            expect((await request(actionOnly, 'GET', assignmentsPath)).statusCode).toBe(401);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
                ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['approval.request.create', 'follow.preview'] }, targets: null,
            } } });
            const outer = await mint(app, fixture, 'approval.request.create', { ...fixture.envelope, requestId: crypto.randomUUID() });
            expect((await request(outer, 'POST', '/v1/account/project-rows/list', {}, 'follow.preview')).statusCode).toBe(401);
            expect((await request(outer, 'GET', assignmentsPath, undefined, 'follow.preview')).statusCode).toBe(401);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
                ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['follow.preview'] },
                targets: { sessions: [session.id], machines: [fixture.machine.id] },
            } } });
            const finiteTargets = await mintPreview();
            expect((await request(finiteTargets, 'POST', '/v2/sessions/query', query)).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('retains captured receiver resource scope for signed delivery-mute mutations', async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const [receiver, outside, sender] = await Promise.all(['receiver', 'outside', 'sender'].map(tag => db.session.create({
            data: { accountId: fixture.account.id, tag: `${tag}-${crypto.randomUUID()}`, encryptionMode: 'plain', metadata: '{}' },
        })));
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: receiver.id, data: 'opaque-mute-receiver-key' } });
        // The installed daemon derives plaintext operands; Home enforces the
        // captured credential's resource ceiling on each signed route operand.
        const scopedPat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(),
            label: 'receiver Machine only', grant: { ...API_TOKEN_FULL_GRANT_V1,
                targets: { sessions: [], machines: [fixture.machine.id] } } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerSessionFollowRoutes);
        try {
            const scope = { kind: 'sender_session' as const, sessionId: sender.id };
            const root = await mint(app, { ...fixture, pat: scopedPat }, 'session.delivery.mute.set', { ...fixture.envelope,
                input: { receiver: { kind: 'session', sessionId: receiver.id }, scope } });
            const write = (sessionId: string) => {
                const path = `/v2/sessions/${sessionId}/delivery-mutes`;
                const body = { scope };
                return app.inject({ method: 'PUT', url: path, payload: body,
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: root.binding.actionId,
                        target: root.binding.target, installationId: fixture.machine.installationId!, method: 'PUT', path, body,
                        privateKey: fixture.keyPair.secretKey }) });
            };
            const admitted = await write(receiver.id);
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(admitted.json()).toEqual({ changed: true, disposition: 'muted' });
            const personalRoot = await mint(app, fixture, 'session.delivery.mute.set', { ...fixture.envelope,
                requestId: crypto.randomUUID(), input: { receiver: { kind: 'account' }, scope } });
            const personalPath = '/v2/account/session-delivery-mutes';
            const personalBody = { scope };
            const personal = await app.inject({ method: 'PUT', url: personalPath, payload: personalBody,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization: personalRoot,
                    effectActionId: personalRoot.binding.actionId, target: personalRoot.binding.target,
                    installationId: fixture.machine.installationId!, method: 'PUT', path: personalPath, body: personalBody,
                    privateKey: fixture.keyPair.secretKey }) });
            expect(personal.statusCode, personal.body).toBe(200);
            await auth.updateApiToken({ accountId: fixture.account.id, tokenId: scopedPat.tokenId, grant: API_TOKEN_FULL_GRANT_V1 });
            const denied = await write(outside.id);
            expect(denied.statusCode, denied.body).toBe(401);
            expect((await db.session.findUniqueOrThrow({ where: { id: outside.id } })).deliveryMutes).toBeNull();
        } finally { await app.close(); }
    });

    it('admits signed Follow source writes only for the complete captured Session pair', async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const sessions = await Promise.all(['destination', 'source', 'outside'].map(tag => db.session.create({ data: {
            accountId: fixture.account.id, tag: `${tag}-${crypto.randomUUID()}`, encryptionMode: 'plain', metadata: '{}',
        } })));
        const [destination, source, outside] = sessions;
        for (const session of [destination, source]) await db.accessKey.create({ data: {
            accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id, data: 'opaque-pair-key',
        } });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['follow.set', 'follow.remove'] },
            targets: { sessions: [], machines: [fixture.machine.id] } };
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: grant } });
        const { app } = await createApp(fixture.team.id);
        try {
            const body = { policy: { preset: 'important' } };
            const root = await mint(app, fixture, 'follow.set', { ...fixture.envelope,
                input: { receiver: { kind: 'session', sessionId: destination.id }, source: { kind: 'session', sessionId: source.id }, ...body } });
            const write = (sourceSessionId: string) => {
                const path = `/v2/sessions/${destination.id}/follows/sessions/${sourceSessionId}`;
                return app.inject({ method: 'PUT', url: path, payload: body,
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: root.binding.actionId,
                        target: root.binding.target, installationId: fixture.machine.installationId!, method: 'PUT', path, body,
                        privateKey: fixture.keyPair.secretKey }) });
            };
            const admitted = await write(source.id);
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(await db.sessionFollowEdge.count({ where: { destinationSessionId: destination.id, sourceSessionId: source.id } })).toBe(1);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: API_TOKEN_FULL_GRANT_V1 } });
            const denied = await write(outside.id);
            expect(denied.statusCode, denied.body).toBe(401);
            expect(await db.sessionFollowEdge.count({ where: { destinationSessionId: destination.id, sourceSessionId: outside.id } })).toBe(0);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: grant } });
            const removal = await mint(app, fixture, 'follow.remove', { ...fixture.envelope,
                input: { receiver: { kind: 'session', sessionId: destination.id }, source: { kind: 'session', sessionId: source.id } } });
            const path = `/v2/sessions/${destination.id}/follows/sessions/${source.id}`;
            const removed = await app.inject({ method: 'DELETE', url: path,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization: removal, effectActionId: removal.binding.actionId,
                    target: removal.binding.target, installationId: fixture.machine.installationId!, method: 'DELETE', path, body: undefined,
                        privateKey: fixture.keyPair.secretKey }) });
            expect(removed.statusCode, removed.body).toBe(200);
            expect(await db.sessionFollowEdge.count({ where: { destinationSessionId: destination.id, sourceSessionId: source.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it.each(['granted', 'outside-grant'] as const)('checks the captured Session before a native Account delete in a %s Session', async scope => {
        const fixture = await createFixture({ qualifiedPat: true });
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        if (scope === 'granted') await db.accessKey.create({ data: { accountId: fixture.account.id,
            machineId: fixture.machine.id, sessionId: session.id, data: 'opaque-delete-key' } });
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
            ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.delete'] },
            targets: { sessions: [], machines: [fixture.machine.id] },
        } } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerSessionDeleteRoute);
        try {
            const input = { sessionId: session.id };
            const root = await mint(app, fixture, 'session.delete', { ...fixture.envelope, input });
            const request = bindHomeDomainActionHttpRequestV1('session.delete', input);
            const result = await app.inject({ method: 'DELETE', url: request.path, payload: request.body,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: root.binding.actionId,
                    target: root.binding.target, installationId: fixture.machine.installationId!, method: 'DELETE',
                    path: request.path, body: request.body, privateKey: fixture.keyPair.secretKey }) });
            expect(result.statusCode, result.body).toBe(scope === 'granted' ? 200 : 401);
            if (scope === 'outside-grant') {
                expect(await db.session.findUnique({ where: { id: session.id } })).not.toBeNull();
                await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: API_TOKEN_FULL_GRANT_V1 } });
                const expanded = await app.inject({ method: 'DELETE', url: request.path, payload: request.body,
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: root.binding.actionId,
                        target: root.binding.target, installationId: fixture.machine.installationId!, method: 'DELETE',
                        path: request.path, body: request.body, privateKey: fixture.keyPair.secretKey }) });
                expect(expanded.statusCode, expanded.body).toBe(401);
                expect(await db.session.findUnique({ where: { id: session.id } })).not.toBeNull();
            } else expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['session.access.grants.list', 'session.responsibility.candidates.list', 'session.public_link.get'] as const)(
        'admits the declared native Account %s transport only inside the captured Session ceiling', async actionId => {
        const fixture = await createFixture({ qualifiedPat: true });
        const [own, outside] = await Promise.all(['own', 'outside'].map(tag => db.session.create({ data: {
            accountId: fixture.account.id, tag: `${tag}-${crypto.randomUUID()}`, encryptionMode: 'plain', metadata: '{}',
        } })));
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: own.id, data: 'opaque-account-route-key' } });
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
            ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
            targets: { sessions: [], machines: [fixture.machine.id] },
        } } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, app => {
            registerSessionAccessGrantRoutes(app); registerSessionResponsibilityRoutes(app); registerPublicShareOwnerRoutes(app);
        });
        try {
            const spec = getActionSpec(actionId);
            const input = (sessionId: string) => ({ sessionId,
                ...(actionId === 'session.responsibility.candidates.list' ? { purpose: 'assignment' } : {}) });
            const root = await mint(app, fixture, actionId, { ...fixture.envelope, input: input(own.id) });
            const read = (sessionId: string) => {
                const request = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!, inputSchema: spec.inputSchema,
                    input: input(sessionId) });
                return app.inject({ method: request.method as 'GET' | 'POST', url: request.path,
                    ...(request.body === undefined ? {} : { payload: request.body }),
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: actionId,
                        target: root.binding.target, installationId: fixture.machine.installationId!, method: request.method,
                        path: request.path, body: request.body, privateKey: fixture.keyPair.secretKey }) });
            };
            const admitted = await read(own.id);
            expect(admitted.statusCode, admitted.body).toBe(200);
            const denied = await read(outside.id);
            expect(denied.statusCode, denied.body).toBe(401);
        } finally { await app.close(); }
    });

    it('preserves direct PAT manager scope denials and the existing relation', async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const [child, lead, outside] = await Promise.all(['child', 'lead', 'outside'].map(tag => db.session.create({ data: {
            accountId: fixture.account.id, tag: `${tag}-${crypto.randomUUID()}`, encryptionMode: 'plain', metadata: '{}',
        } })));
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
            ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.manager.set', 'session.message.send'] },
            targets: { sessions: [child.id, lead.id], machines: [fixture.machine.id] },
        } } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, routes => {
            enableErrorHandlers(routes);
            registerSessionManagerRoutes(routes);
        });
        try {
            const write = (sessionId: string, managerSessionId: string | null, expectedManagerSessionId: string | null) => app.inject({
                method: 'POST', url: `/v1/sessions/${sessionId}/manager`,
                headers: { authorization: `Bearer ${fixture.pat.token}` }, payload: { managerSessionId, expectedManagerSessionId },
            });
            const attached = await write(child.id, lead.id, null);
            expect(attached.statusCode, attached.body).toBe(200);
            const relation = await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } });
            expect(relation).toMatchObject({ destinationSessionId: lead.id, relation: 'manager' });
            for (const [sessionId, managerSessionId, expectedManagerSessionId] of [
                [outside.id, lead.id, null], [child.id, outside.id, lead.id], [child.id, null, outside.id],
            ] as const) {
                const denied = await write(sessionId, managerSessionId, expectedManagerSessionId);
                expect({ status: denied.statusCode, body: denied.json() }).toEqual({
                    status: 403, body: { error: 'credential_scope_denied' },
                });
                expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toEqual(relation);
                expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: outside.id } })).toBeNull();
            }
            const detached = await write(child.id, null, lead.id);
            expect(detached.statusCode, detached.body).toBe(200);
            expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toBeNull();
        } finally { await app.close(); }
    });

    it.each([
        ['DELETE', '/v1/sessions/:id', undefined],
        ['GET', '/v2/sessions/:id/data-key/envelopes?limit=1&state=all', undefined],
        ['GET', '/v2/sessions/:id/subagents/custody/capability', undefined],
        ['GET', '/v2/sessions/:id/subagents/custody', undefined],
        ['GET', '/v2/sessions/:id/follow', undefined],
        ['PUT', '/v2/sessions/:id/follow', { notificationLevel: 'none', includeInVoice: false }],
        ['DELETE', '/v2/sessions/:id/follow', undefined],
        ['GET', '/v2/sessions/:id/follows/sessions', undefined],
        ['PUT', '/v2/sessions/:id/follows/sessions/:id', { mode: 'next_turn' }],
        ['DELETE', '/v2/sessions/:id/follows/sessions/:id', undefined],
        ['POST', '/v2/sessions/access-candidates/inspect', { v: 1, subjects: [] }],
        ['POST', '/v2/sessions/access-grants/list', {}],
        ['POST', '/v2/sessions/access-grants/set', { subject: { kind: 'account', accountId: 'recipient' }, accessLevel: 'view', canApprovePermissions: false }],
        ['POST', '/v2/sessions/access-grants/remove', { subject: { kind: 'account', accountId: 'recipient' } }],
        ['POST', '/v2/sessions/access-context/set', { primaryTeamId: null }],
        ['POST', '/v2/sessions/responsibility/set', { responsibleAccountId: null }],
        ['POST', '/v2/sessions/responsibility/candidates', { purpose: 'assignment' }],
        ['POST', '/v2/sessions/:id/read-state', { state: 'read' }],
        ['GET', '/v1/sessions/:id/public-share', undefined],
        ['POST', '/v1/sessions/:id/public-share', {}],
        ['DELETE', '/v1/sessions/:id/public-share', undefined],
        ['POST', '/v1/public-shares', { subject: { kind: 'session', id: ':id' }, lookupId: 'scope-denial-test', keyDerivation: 'fragment_v1', encryptedDataKey: null }],
        ['PUT', '/v2/session-organization/pins/:id', { pinned: false }],
        ['PUT', '/v2/session-organization/attention-standings/:id', { standing: null }],
        ['PUT', '/v2/session-organization/folder-assignments/:id', { folderId: null }],
        ['PUT', '/v2/session-organization/tag-assignments/:id', { tagIds: [] }],
    ] as const)('preserves authentication errors on declared Session route %s %s', async (method, path, body) => {
        const fixture = await createFixture({ qualifiedPat: true });
        const outside = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
            ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [], machines: [fixture.machine.id] },
        } } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, routes => {
            enableErrorHandlers(routes);
            registerSessionDeleteRoute(routes);
            registerSessionDataKeyEnvelopeRoutes(routes);
            registerSessionSubagentCustodyRoutes(routes);
            registerSessionFollowRoutes(routes);
            registerSessionAccessGrantRoutes(routes);
            registerSessionResponsibilityRoutes(routes);
            registerSessionReadStateRoutes(routes);
            registerPublicShareOwnerRoutes(routes);
            registerStoredContentPublicShareRoutes(routes);
            registerSessionOrganizationRoutes(routes);
        });
        try {
            const url = path.replaceAll(':id', outside.id);
            const needsBodySession = path.startsWith('/v2/sessions/') && !path.includes(':id');
            const payload = body === undefined ? undefined : {
                ...body, ...(needsBodySession ? { sessionId: outside.id } : {}),
                ...(path === '/v1/public-shares' ? { subject: { kind: 'session', id: outside.id } } : {}),
            };
            // Custody's query is schema-validated before authentication. Use the real key producer.
            const scope = { pluginId: 'acme.agent', contributionId: 'assistant', sourceCustody: {
                kind: 'managed', immutableGenerationId: 'l68c-custody', installSource: 'npm',
            } } as const;
            const query = path.endsWith('/subagents/custody') ? `?${new URLSearchParams({
                pluginId: scope.pluginId, contributionId: scope.contributionId,
                sourceCustody: JSON.stringify(scope.sourceCustody),
                custodyKey: createSessionSubagentCustodyKeyV1({ ...scope, sessionId: outside.id }),
            })}` : '';
            for (const token of ['invalid-token', fixture.pat.token]) {
                const result = await app.inject({ method, url: `${url}${query}`,
                    ...(payload === undefined ? {} : { payload }), headers: { authorization: `Bearer ${token}` } });
                const unscopedRead = path.includes('/data-key/') || path.includes('/subagents/');
                expect({ status: result.statusCode, body: result.json() }, `${method} ${path}`).toEqual({
                    status: token === 'invalid-token' ? 401 : 403,
                    body: { error: token === 'invalid-token' ? 'invalid_token'
                        : unscopedRead ? 'present_user_required' : 'credential_scope_denied' },
                });
            }
            expect(await db.session.findUnique({ where: { id: outside.id } })).toMatchObject({ id: outside.id });
        } finally { await app.close(); }
    });

    it('admits signed manager attach and detach only for every non-null captured Session operand', async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const [child, lead, outside] = await Promise.all(['child', 'lead', 'outside'].map(tag => db.session.create({ data: {
            accountId: fixture.account.id, tag: `${tag}-${crypto.randomUUID()}`, encryptionMode: 'plain', metadata: '{}',
        } })));
        for (const session of [child, lead]) await db.accessKey.create({ data: { accountId: fixture.account.id,
            machineId: fixture.machine.id, sessionId: session.id, data: 'opaque-reports-to-key' } });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.manager.set'] },
            targets: { sessions: [], machines: [fixture.machine.id] } };
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: grant } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerSessionManagerRoutes);
        try {
            const root = await mint(app, fixture, 'session.manager.set', { ...fixture.envelope,
                input: { sessionId: child.id, managerSessionId: lead.id, expectedManagerSessionId: null } });
            const write = (sessionId: string, managerSessionId: string | null, expectedManagerSessionId: string | null) => {
                const spec = getActionSpec('session.manager.set');
                const request = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!, inputSchema: spec.inputSchema,
                    input: { sessionId, managerSessionId, expectedManagerSessionId } });
                return app.inject({ method: 'POST', url: request.path, payload: request.body,
                    headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: root.binding.actionId,
                        target: root.binding.target, installationId: fixture.machine.installationId!, method: 'POST',
                        path: request.path, body: request.body, privateKey: fixture.keyPair.secretKey }) });
            };
            const attached = await write(child.id, lead.id, null);
            expect(attached.statusCode, attached.body).toBe(200);
            expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toMatchObject({ destinationSessionId: lead.id, relation: 'manager' });
            const detached = await write(child.id, null, lead.id);
            expect(detached.statusCode, detached.body).toBe(200);
            expect(detached.json()).toMatchObject({ ok: true, managerSessionId: null });
            expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: child.id } })).toBeNull();
            for (const expandGrant of [false, true]) {
                if (expandGrant) await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: API_TOKEN_FULL_GRANT_V1 } });
                for (const [sessionId, managerSessionId, expectedManagerSessionId] of [
                    [outside.id, lead.id, null], [child.id, outside.id, null], [child.id, null, outside.id],
                ] as const) {
                    const denied = await write(sessionId, managerSessionId, expectedManagerSessionId);
                    expect(denied.statusCode, denied.body).toBe(401);
                    expect(await db.sessionFollowEdge.count({ where: { managerSourceSessionId: { in: [child.id, outside.id] } } })).toBe(0);
                }
            }
        } finally { await app.close(); }
    });

    it('refuses native Account deletion after a captured secondary Machine loses current access', async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const key = tweetnacl.sign.keyPair();
        const secondary = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: secondary.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: secondary.id,
            sessionId: session.id, data: 'retained-secondary-delete-key' } });
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
            ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.delete'] },
            targets: { sessions: [], machines: [fixture.machine.id, secondary.id] },
        } } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerSessionDeleteRoute);
        try {
            const input = { sessionId: session.id };
            const root = await mint(app, fixture, 'session.delete', { ...fixture.envelope, input });
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: secondary.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            expect(await verifyCurrentExternalActionPrincipal(root.binding)).not.toBeNull();
            const request = bindHomeDomainActionHttpRequestV1('session.delete', input);
            const denied = await app.inject({ method: 'DELETE', url: request.path, payload: request.body,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: root.binding.actionId,
                    target: root.binding.target, installationId: fixture.machine.installationId!, method: 'DELETE',
                    path: request.path, body: request.body, privateKey: fixture.keyPair.secretKey }) });
            expect(denied.statusCode, denied.body).toBe(401);
            expect(await db.session.findUnique({ where: { id: session.id } })).not.toBeNull();
        } finally { await app.close(); }
    });

    it('rechecks a signed catalog PAT captured secondary Machine grant while its execution Machine stays current', async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const key = tweetnacl.sign.keyPair();
        const secondary = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: secondary.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: secondary.id,
            sessionId: session.id, data: 'retained-secondary-machine-key' } });
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
            ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['widgets.catalog.list'] },
            targets: { sessions: [], machines: [fixture.machine.id, secondary.id] },
        } } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, registerSessionDataKeyEnvelopeRoutes);
        try {
            const root = await mint(app, fixture, 'widgets.catalog.list', { ...fixture.envelope,
                input: { surface: { serverId: await getOrCreateServerIdentityId(), accountId: fixture.account.id,
                    owner: { kind: 'sessionBoard', sessionId: session.id } } } });
            const path = `/v2/sessions/${session.id}/data-key/envelopes?limit=1&state=all`;
            const read = () => app.inject({ method: 'GET', url: path,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization: root, effectActionId: root.binding.actionId,
                    target: root.binding.target, installationId: fixture.machine.installationId!, method: 'GET', path,
                    privateKey: fixture.keyPair.secretKey }) });
            const admitted = await read();
            expect(admitted.statusCode, admitted.body).toBe(200);
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: secondary.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            expect(await verifyCurrentExternalActionPrincipal(root.binding)).not.toBeNull();
            expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: fixture.machine.id,
                requiredRole: 'use' })).toMatchObject({ kind: 'admitted' });
            expect(await db.accessKey.count({ where: { accountId: fixture.account.id, machineId: secondary.id, sessionId: session.id } })).toBe(1);
            const revoked = await read();
            expect(revoked.statusCode, revoked.body).toBe(401);
        } finally { await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('binds Session visual creator proof to its installed current publisher with %s credentials', async kind => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const otherSession = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id, data: 'opaque-source-key' } });
        let publisher: string | null = fixture.machine.id;
        const { app } = await createApp(fixture.team.id, false, async () => publisher);
        const token = await auth.createToken(fixture.account.id, undefined, kind === 'account'
            ? { kind, authority: 'present_user' } : { kind, authority: 'account_automation' });
        const actionId = 'session.board.item.upsert';
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'visual-turn',
            callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' }, requestId: crypto.randomUUID() });
        const target = { kind: 'session' as const, sessionId: session.id };
        const envelope = { v: 1, requestId: origin.requestId, target, input: { sessionId: session.id,
            itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item: { v: 1, title: 'Visual', frame: 'frameless',
                height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'hello' } } } } } } satisfies ExternalActionRequestEnvelopeV1;
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const sign = (nextEnvelope = envelope, nextOrigin = origin) => signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: { homeId: homeId,
                actionId, requestId: nextOrigin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(nextEnvelope), origin: nextOrigin } } });
        const homeId = await getOrCreateServerIdentityId();
        const payload = { v: 1, machineId: fixture.machine.id, envelope, sessionActionOrigin: origin, sessionActionSource: source, installationProof: sign() };
        const mint = (body: unknown = payload) => app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${token}` }, payload: body });
        try {
            const minted = await mint();
            expect(minted.statusCode, JSON.stringify({ body: minted.body,
                signedRoot: SignedRootActionIdSchema.safeParse(actionId).success,
                original: kind === 'account' ? isOriginalAccountExecutionAction(actionId, payload) : isOriginalTerminalExecutionAction(actionId, payload),
                request: externalActionExecutionAuthorizationRequestSchemaForActionV1(actionId).safeParse(payload) })).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding.target).toEqual(target);
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({ authority: 'account_automation', sessionActionOrigin: origin });
            authorizationRequests.set(authorization.token, { target, installationId: source.installationId, requestId: origin.requestId });
            const verify = async (method: string, path: string, body?: unknown, privateKey = fixture.keyPair.secretKey) => {
                const headers = machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId, method, path, body, privateKey });
                return verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token, effectActionId: actionId,
                    encodedTarget: headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER], machineSignature: headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER],
                    method, path, body, resolveCurrentSessionMachine: async () => publisher });
            };
            const body = { operation: 'upsert_item', itemId: 'visual', expectedItemRevision: null, destination: 'transcript', itemContent: { t: 'plain', v: envelope.input.item } };
            const path = `/v2/sessions/${session.id}/board`;
            expect(await verify('PUT', path, body)).not.toBeNull();
            const applied = await app.inject({ method: 'PUT', url: path, payload: body,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'PUT', path, body, privateKey: fixture.keyPair.secretKey }) });
            expect(applied.statusCode, applied.body).toBe(200);
            const signedHeaders = machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                method: 'PUT', path, body, privateKey: fixture.keyPair.secretKey });
            const tampered = await app.inject({ method: 'PUT', url: path, headers: signedHeaders,
                payload: { ...body, itemContent: { t: 'plain', v: { ...envelope.input.item, title: 'Substituted' } } } });
            expect(tampered.statusCode).toBe(401);
            const foreignPath = `/v2/sessions/${otherSession.id}/board`;
            const foreignWrite = await app.inject({ method: 'PUT', url: foreignPath, payload: body,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'PUT', path: foreignPath, body, privateKey: fixture.keyPair.secretKey }) });
            expect(foreignWrite.statusCode).toBe(401);
            expect(await readSessionSystemRecordV1({ actorUserId: fixture.account.id, sessionId: session.id,
                authentication: createPresentUserSessionAccessAuthentication(),
                address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' } }))
                .toMatchObject({ ok: true, record: { creator: { kind: 'session', sessionId: session.id } } });
            expect(await verify('GET', `/v2/sessions/${session.id}?accessProjectionVersion=1`)).not.toBeNull();
            expect(await verify('GET', `/v2/sessions/${session.id}/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=visual`)).not.toBeNull();
            expect(await verify('PUT', `/v2/sessions/${otherSession.id}/board`, body)).toBeNull();
            expect(await verify('PUT', path, { ...body, operation: 'remove_item' })).toBeNull();
            expect(await verify('PUT', path, body, tweetnacl.sign.keyPair().secretKey)).toBeNull();
            expect(await verify('GET', `/v2/sessions/${session.id}/system-records/record?owner=host&namespace=permissions&kind=item.v1&localId=visual`)).toBeNull();
            const missingProof = await mint({ ...payload, installationProof: undefined });
            expect(missingProof.statusCode).toBe(400);
            expect(missingProof.json()).toMatchObject({ error: 'invalid_request', code: 'invalid_envelope' });
            expect((await mint({ ...payload, sessionActionOrigin: { ...origin, sourceTurnId: 'forged' } })).statusCode).toBe(401);
            const foreignEnvelope = { ...envelope, target: { kind: 'session' as const, sessionId: otherSession.id } };
            expect((await mint({ ...payload, envelope: foreignEnvelope, installationProof: sign(foreignEnvelope) })).statusCode).not.toBe(200);
            publisher = null;
            expect((await mint()).statusCode).toBe(401);
            expect(await verify('PUT', path, body)).toBeNull();
            publisher = fixture.machine.id;
            await db.machine.update({ where: { id: fixture.machine.id }, data: { revokedAt: new Date() } });
            expect(await verify('PUT', path, body)).toBeNull();
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toBeNull();
        } finally { await app.close(); }
    });

    it('retains Settings session-agent authority through signed Account issuance and relay', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-source-key' } });
        const { app, dispatchedPrincipals } = await createApp(fixture.team.id, false, async () => fixture.machine.id);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const actionId = 'settings.set';
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'settings-turn',
            callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
            requestId: crypto.randomUUID() });
        const envelope = { ...fixture.envelope, requestId: origin.requestId, input: { anchor: 'workDepthLimit', value: 3 } };
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: {
                homeId: await getOrCreateServerIdentityId(), actionId, requestId: origin.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const payload = { v: 1, machineId: fixture.machine.id, envelope, sessionActionOrigin: origin,
            sessionActionSource: source, installationProof };
        try {
            const response = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload });
            expect(response.statusCode, response.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                accountId: fixture.account.id, authority: 'account_automation', sessionActionOrigin: origin,
            });
            const relay = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` }, payload });
            expect(relay.statusCode, relay.body).toBe(200);
            expect(dispatchedPrincipals).toEqual([expect.objectContaining({
                accountId: fixture.account.id, authority: 'account_automation', sessionActionOrigin: origin,
            })]);
            const forged = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` },
                payload: { ...payload, sessionActionOrigin: { ...origin, sourceTurnId: 'forged-turn' } } });
            expect(forged.statusCode).toBe(401);
            expect(dispatchedPrincipals).toHaveLength(1);
        } finally { await app.close(); }
    });

    it.each(['session.notes.set', 'session.role.set', 'session.roles.apply_to_reports'] as const)(
        'binds signed Workflow role effects for %s to the assigned Run executor and exact Session without impersonating a Session', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const homeId = await getOrCreateServerIdentityId();
        const targetKeys = tweetnacl.sign.keyPair();
        const targetMachine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: fixture.account.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(targetKeys.publicKey) } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const unrelated = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: targetMachine.id, sessionId: session.id, data: 'target-custody' } });
        const runId = crypto.randomUUID();
        const snapshot = await materializeWorkflowAcceptedSnapshotFixture({ definition: { version: 1,
            defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: ['work'] },
            context: { source: { kind: 'inline' }, inputs: {}, machineId: fixture.machine.id,
            executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: fixture.machine.id,
                directory: '/repo', checkoutRootPath: '/repo' } }, origin: { kind: 'direct', originSessionId: session.id },
            authorization: { principal: { kind: 'host' } } } });
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: fixture.account.id, runId }, acceptedSnapshot: snapshot }));
        const run = await db.automationRun.create({ data: { id: runId, accountId: fixture.account.id, originKind: 'direct', originSessionId: session.id,
            workflowAcceptedSnapshotEnvelope: acceptedEnvelope,
            causeKind: null, state: 'running', workflowCustodyState: 'settled', scheduledAt: new Date(), dueAt: new Date(),
            assignments: { create: { machineId: fixture.machine.id } } } });
        const target = { kind: 'session' as const, sessionId: session.id };
        const input = actionId === 'session.notes.set' ? { sessionId: session.id, notes: 'Run-authored notes' }
            : actionId === 'session.role.set' ? { sessionId: session.id, roleId: 'scout' } : { sessionId: session.id };
        const params = actionId === 'session.roles.apply_to_reports'
            ? { sessionId: session.id, configuration: { overrides: [], sessionRoles: [], notes: 'Copied by Run' } } : input;
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(), target, input });
        const workflowActionOrigin = { runId: run.id, requestId: envelope.requestId!, sessionAuthority: {
            authorization: snapshot.authorization,
            runDepth: 1, runOriginSessionId: session.id, directory: '/repo', workspaceWrites: 'deny' as const } };
        const signOrigin = (origin = workflowActionOrigin, signedEnvelope = envelope, privateKey = fixture.keyPair.secretKey) => signMachineInstallationProof({ privateKey,
            payload: { version: 1, accountId: fixture.account.id, machineId: fixture.machine.id, installationId: fixture.machine.installationId!,
                externalActionOrigin: { homeId, actionId, requestId: envelope.requestId!,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(signedEnvelope), origin } } });
        const { app } = await createApp(fixture.team.id);
        const request = { v: 1, machineId: fixture.machine.id, envelope, workflowActionOrigin, installationProof: signOrigin() };
        const mint = (payload: unknown = request) => app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${token}` }, payload });
        try {
            const minted = await mint();
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding).toMatchObject({ machineId: fixture.machine.id, target, workflowActionOrigin });
            expect(authorization.binding).not.toHaveProperty('sessionActionOrigin');
            const rpcMethod = actionId === 'session.roles.apply_to_reports' ? SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET : actionId;
            const method = `${session.id}:${rpcMethod}`;
            const requestId = crypto.randomUUID();
            const sign = (rpcMethod = method, privateKey = fixture.keyPair.secretKey) => signExternalActionMachineRpcRequestV1({
                authorizationToken: authorization.token, effectActionId: actionId, target, installationId: fixture.machine.installationId!,
                event: SOCKET_RPC_EVENTS.CALL, method: rpcMethod, requestId, params, privateKey });
            const execution = { v: 1 as const, authorization, effectActionId: actionId, target,
                installationId: fixture.machine.installationId!, machineSignature: sign() };
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params })).toMatchObject({
                principal: { authority: 'account_automation', workflowActionOrigin } });
            // Only the Socket.IO transport is simulated; Home signing, Run
            // assignment, Session access and production relay wiring stay real.
            const delivered = vi.fn(async (_event: string, _request: unknown) => ({ updated: true }));
            const receiver = { id: 'workflow-role-receiver', data: { clientType: 'session-scoped', sessionId: session.id,
                machineId: targetMachine.id, verifiedMachineInstallationId: targetMachine.installationId },
                timeout: () => ({ emitWithAck: delivered }) };
            qualifyCurrentAccountStoredContentSocket(receiver);
            const io = createSocketRoomDiscoveryHarness(async room => room === receiver.id
                || room === `rpc:${fixture.account.id}:${method}` ? [receiver] : []);
            const socket = Object.assign(createFakeSocket({ id: 'workflow-role-sender', data: { clientType: 'machine-scoped',
                machineId: fixture.machine.id, verifiedMachineInstallationId: fixture.machine.installationId,
                authTokenKind: 'terminal', authAuthority: 'account_automation' } }), { handshake: { auth: { token } } });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: fixture.account.id, socket: socket as unknown as Socket, io });
            const callback = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId, params,
                externalActionExecution: execution }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { updated: true } });
            expect(delivered).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
                callerAuthority: 'account_automation', callerInputAuthorization: authorization }));
            expect(delivered.mock.calls[0]?.[1]).not.toHaveProperty('sessionActionOrigin');
            expect(await verifyExternalActionMachineRpcExecution({ ...execution, machineSignature: sign(method, targetKeys.secretKey) },
                { method, requestId, params })).toBeNull();
            const wrongMethod = `${unrelated.id}:${rpcMethod}`;
            expect(await verifyExternalActionMachineRpcExecution({ ...execution, machineSignature: sign(wrongMethod) },
                { method: wrongMethod, requestId, params })).toBeNull();
            const otherEffectMethod = `${session.id}:${actionId === 'session.role.set' ? SESSION_RPC_METHODS.SESSION_NOTES_SET : SESSION_RPC_METHODS.SESSION_ROLE_SET}`;
            expect(await verifyExternalActionMachineRpcExecution({ ...execution, machineSignature: sign(otherEffectMethod) },
                { method: otherEffectMethod, requestId, params })).toBeNull();
            expect((await mint({ ...request, installationProof: signOrigin(workflowActionOrigin, envelope, targetKeys.secretKey) })).statusCode).toBe(401);
            const wrongOrigin = { ...workflowActionOrigin, sessionAuthority: { ...workflowActionOrigin.sessionAuthority, runOriginSessionId: unrelated.id } };
            expect((await mint({ ...request, workflowActionOrigin: wrongOrigin, installationProof: signOrigin(wrongOrigin) })).statusCode).toBe(401);
            const missingAuthority = { runId: run.id, requestId: envelope.requestId! };
            expect((await mint({ ...request, workflowActionOrigin: missingAuthority,
                installationProof: signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                    payload: { version: 1, accountId: fixture.account.id, machineId: fixture.machine.id, installationId: fixture.machine.installationId!,
                        externalActionOrigin: { homeId, actionId, requestId: envelope.requestId!,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: missingAuthority } } }) })).statusCode).toBe(400);
            await db.automationRunAssignment.deleteMany({ where: { runId: run.id } });
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params })).toBeNull();
            expect((await mint()).statusCode).toBe(401);
            await db.automationRunAssignment.create({ data: { runId: run.id, machineId: fixture.machine.id } });
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params })).not.toBeNull();
            await db.accessKey.deleteMany({ where: { sessionId: session.id } });
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params })).toBeNull();
            expect((await mint()).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('admits only a signed assigned FIN scope origin with %s provenance and retires its accepted authority on unarchive and clear', async kind => {
        const fixture = await createFixture({ qualifiedPat: true });
        const token = await auth.createToken(fixture.account.id, undefined,
            kind === 'account' ? { kind, authority: 'present_user' } : { kind, authority: 'account_automation' });
        const homeId = await getOrCreateServerIdentityId();
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: 'plain', v: { workspace: { directory: '~' }, executionTarget: { kind: 'detached_run' }, inputs: {},
                inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'action', id: 'managed-scope-end',
                    actionId: 'machines.managed.delete', input: { homeId: { kind: 'literal', value: homeId },
                        managedId: { kind: 'literal', value: 'managed' }, intent: { kind: 'literal', value: 'delete' },
                        when: { kind: 'literal', value: 'after-idle' }, reviewedDependencies: { kind: 'literal', value: true } } }] } } } });
        if (recipe.kind !== 'available') throw new Error('Scope recipe unavailable');
        const automation = await db.automation.create({ data: { accountId: fixture.account.id, name: 'Managed scope', enabled: true,
            targetType: null, scopeSessionId: session.id, templateVersion: 1, templateCiphertext: recipe.serialized } });
        await db.automationAssignment.create({ data: { automationId: automation.id, machineId: fixture.machine.id, enabled: true } });
        const trigger = await db.automationTrigger.create({ data: { automationId: automation.id, revision: 1, enabled: true,
            ...encodeAutomationSessionLifecycleConfiguration({ kind: 'sessionLifecycle', sourceSessionId: session.id,
                events: ['sessionArchived'], policy: { kind: 'everyMatch' } }), kind: 'sessionLifecycle' } });
        const { app, dispatchedPrincipals } = await createApp(fixture.team.id);
        try {
            const archive = (action: 'archive' | 'unarchive') => app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/${action}`,
                headers: { authorization: `Bearer ${token}`, ...currentAccountStoredContentCompatibilityHeaders } });
            expect((await archive('archive')).statusCode).toBe(200);
            const run = await db.automationRun.findFirstOrThrow({ where: { triggerId: trigger.id } });
            await db.automationRun.update({ where: { id: run.id }, data: { state: 'succeeded', workflowCustodyState: 'settled', workflowAcceptedSnapshotEnvelope: '{}' } });
            const actionId = 'machines.managed.delete';
            const envelope: ExternalActionRequestEnvelopeV1 = { v: 1, requestId: 'scope-effect', target: { kind: 'machine', machineId: fixture.machine.id },
                input: { homeId, managedId: 'managed', intent: 'delete', when: 'after-idle', reviewedDependencies: true } };
            const workflowActionOrigin = { runId: run.id, requestId: envelope.requestId! };
            const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                payload: { version: 1, accountId: fixture.account.id, machineId: fixture.machine.id, installationId: fixture.machine.installationId!,
                    externalActionOrigin: { homeId, actionId, requestId: envelope.requestId!,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: workflowActionOrigin } } });
            const request = { v: 1, machineId: fixture.machine.id, envelope, workflowActionOrigin, installationProof };
            const mintOrigin = (payload = request) => app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload });
            const minted = await mintOrigin();
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            if (!('authentication' in authorization.binding)) throw new Error('Signed credential provenance was not retained');
            expect(authorization.binding.authentication).toMatchObject({ kind, tokenEpoch: fixture.account.tokenEpoch });
            authorizationRequests.set(authorization.token, { target: envelope.target!, installationId: fixture.machine.installationId!, requestId: envelope.requestId! });
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const body = { v: 1 };
            const verify = () => app.inject({ method: 'POST', url: path, payload: body,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId, path, method: 'POST', body,
                    privateKey: fixture.keyPair.secretKey }) });
            expect((await verify()).statusCode).toBe(200);
            const relayPath = `/v1/actions/${actionId}`;
            const relayBody = { v: 1, machineId: fixture.machine.id, envelope, executionAuthorization: authorization };
            const relay = await app.inject({ method: 'POST', url: relayPath, payload: relayBody,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    path: relayPath, method: 'POST', body: relayBody, privateKey: fixture.keyPair.secretKey }) });
            expect(relay.statusCode, relay.body).toBe(200);
            expect(dispatchedPrincipals).toEqual([{ accountId: fixture.account.id, authentication: authorization.binding.authentication,
                authority: 'account_automation', workflowActionOrigin }]);
            expect((await mintOrigin({ ...request, workflowActionOrigin: { ...workflowActionOrigin, runId: 'substituted-run' } })).statusCode).toBe(401);
            const unassignedOrigin = { ...workflowActionOrigin, runId: 'unassigned-run' };
            const unassignedProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                payload: { version: 1, accountId: fixture.account.id, machineId: fixture.machine.id, installationId: fixture.machine.installationId!,
                    externalActionOrigin: { homeId, actionId, requestId: envelope.requestId!,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: unassignedOrigin } } });
            expect((await mintOrigin({ ...request, workflowActionOrigin: unassignedOrigin, installationProof: unassignedProof })).statusCode).toBe(401);
            expect((await archive('unarchive')).statusCode).toBe(200);
            expect((await verify()).statusCode).toBe(401);
            expect((await mintOrigin()).statusCode).toBe(401);
            await db.session.update({ where: { id: session.id }, data: { archivedAt: run.causeOccurredAt } });
            expect((await verify()).statusCode).toBe(200);
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await verify()).statusCode).toBe(401);
            // Restore the independent credential fixture to discriminate trigger retirement below.
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: fixture.account.tokenEpoch } });
            expect((await verify()).statusCode).toBe(200);
            await deleteAutomationTrigger({ accountId: fixture.account.id, automationId: automation.id, triggerId: trigger.id, expectedRevision: trigger.revision });
            expect((await verify()).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it.each(['account', 'pat'] as const)('does not let a %s Project Trust list authorization mutate private Project rows', async credential => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = credential === 'pat' ? fixture.pat.token
            : await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const { app } = await createApp(fixture.team.id);
        try {
            const actionId = 'projects.trust.list';
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: fixture.machine.id }, input: {} });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId });
            const key = { kind: 'project-organization', serverId: await getOrCreateServerIdentityId(), projectKey: 'read-only-root' } as const;
            const path = '/v1/account/project-rows/mutate';
            const body = { mutations: [{ key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: { pinned: true } } } }],
                expectedRefs: [], topologyChange: false };
            const response = await app.inject({ method: 'POST', url: path,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }), payload: body });
            expect(response.statusCode, response.body).toBe(401);
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: fixture.account.id,
                key: buildProjectAccountRowPhysicalKeyV1(key) } } })).toBeNull();
        } finally { await app.close(); }
    });

    it('copies a signed worker Script through installed finite registration and the paired terminal SOURCE relay', async () => {
        await db.account.create({ data: { id: 'account', publicKey: null, encryptionMode: 'plain', tokenEpoch: 1 } });
        const token = await auth.createToken('account', undefined, { kind: 'account', authority: 'present_user' });
        const terminalToken = await auth.createToken('account', undefined, { kind: 'terminal', authority: 'account_automation' });
        const homeId = await getOrCreateServerIdentityId();
        const { app } = await createApp('unused-team');
        let deliveries = 0;
        let relay: ((packet: SocketRpcRequestPayload, deliver: (request: Parameters<RpcHandlerManager['handleRequest']>[0]) => Promise<unknown>) => Promise<unknown>) | undefined;
        const h = await createInstalledProjectApprovalHarness('projects.script.run', 'ask', false, homeId, {
            token,
            mintAuthorization: async (actionId, envelope, authentication) => {
                const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${authentication.kind === 'terminal' ? terminalToken : token}` }, payload: { v: 1, machineId: envelope.target?.kind === 'machine'
                        ? envelope.target.machineId : 'machine', envelope } });
                expect(issued.statusCode, issued.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
                expect('authentication' in authorization.binding && authorization.binding.authentication).toMatchObject(authentication);
                return authorization;
            },
            // Home's signed-root verification and relay are real. Account-row,
            // approval-store and OS boundaries retain the installed harness.
            request: input => input.path.includes('/execution-authorization/verify') ? app.inject({ method: input.method,
                url: input.path, headers: input.headers, ...(input.body === undefined ? {} : { payload: JSON.stringify(input.body) }) })
                .then(response => ({ status: response.statusCode, data: response.json() })) : null,
            relayWorkspaceSource: (packet, deliver) => {
                if (!relay) throw new Error('Missing registered Home relay');
                return relay(packet, deliver);
            },
        }, true);
        try {
            for (const [machineId, installation] of [[h.workerRef.machineId, h.installation], [h.ref.machineId, h.sourceInstallation]] as const) {
                await db.machine.create({ data: { id: machineId, accountId: 'account', active: true, installationId: installation.installationId,
                    installationPublicKey: decodeBase64(installation.publicKey, 'base64url'),
                    metadata: encodePlainMachineStoredContent({ host: machineId, platform: 'linux', happyCliVersion: 'test',
                        homeDir: '/home/fixture', happyHomeDir: '/home/fixture/.happier' }),
                    dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
            }
            relay = async (packet, deliver) => {
                const receiver = { id: 'installed-source', data: { clientType: 'machine-scoped', machineId: h.ref.machineId,
                    verifiedMachineInstallationId: h.sourceInstallation.installationId }, timeout: () => ({
                    emitWithAck: async (_event: string, request: Parameters<RpcHandlerManager['handleRequest']>[0]) => {
                        deliveries++; return await deliver(request);
                    },
                }) };
                qualifyCurrentAccountStoredContentSocket(receiver);
                const io = createSocketRoomDiscoveryHarness(async room => room === receiver.id
                    || room === `rpc:account:${packet.method}` ? [receiver] : []);
                const sender = Object.assign(createFakeSocket({ id: 'installed-worker', data: { clientType: 'machine-scoped',
                    machineId: h.workerRef.machineId, verifiedMachineInstallationId: h.installation.installationId,
                    authTokenKind: 'terminal', authAuthority: 'account_automation' } }), { handshake: { auth: { token: terminalToken } } });
                qualifyCurrentAccountStoredContentSocket(sender);
                registerSocketRpcHandlers({ userId: 'account', socket: sender as unknown as Socket, io });
                let response: unknown;
                await getSocketHandler(sender, SOCKET_RPC_EVENTS.CALL)(packet, (value: unknown) => { response = value; });
                return response;
            };
            await writeFile(join(h.rootPath, '.happier/project.json'), JSON.stringify({ version: 1,
                scripts: { ok: { execution: 'portable', source: { kind: 'command', command: 'echo worker-admitted' } } } }));
            const workspace = { serverId: homeId, workspaceId: h.ref.id, machineId: h.ref.machineId, rootPath: h.rootPath };
            expect(await h.run({ workspace, selection: { kind: 'named', name: 'ok' },
                choice: { kind: 'workers', destination: { kind: 'machine', machineId: h.workerRef.machineId } } },
            'ui', false, 'present_user')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(await h.decide('approve')).toMatchObject({ ok: true });
            const receipt = await h.approval();
            expect(receipt.execution?.errorCode, JSON.stringify({ error: receipt.execution?.error,
                details: receipt.execution?.details })).toBeUndefined();
            expect(receipt).toMatchObject({ status: 'executed', execution: { ok: true } });
            const output = ProjectCommandActionOutputV1Schema.parse(receipt.execution?.result);
            const started = await Promise.race([h.waitForSpawn(0).then(() => ({ kind: 'spawned' as const })),
                h.waitForTerminal(output.operation.operationId).then(operation => ({ kind: 'terminal' as const, operation }))]);
            expect(started, JSON.stringify(started)).toMatchObject({ kind: 'spawned' });
            expect(deliveries).toBeGreaterThan(0);
            expect(h.copies()).toBe(1);
            expect(h.spawned[0]?.cwd).toBe(h.workerRef.rootPath);
            h.spawned[0]!.exit(0);
            expect(await h.waitForTerminal(output.operation.operationId)).toMatchObject({ kind: 'found', operation: {
                state: 'succeeded', domainRef: { machineId: h.workerRef.machineId, exitCode: 0 },
            } });
        } finally { await h.close(); await app.close(); }
    });

    it.each([['projects.script.run', 1, 'source', 'account'], ['projects.script.run', 2, 'source', 'account'],
        ['projects.compute.exec', 1, 'source', 'account'], ['projects.compute.exec', 2, 'source', 'account'], ['projects.script.run', 1, 'hub', 'account'],
        ['projects.service.relocate', 1, 'source', 'account'], ['projects.service.relocate', 2, 'source', 'account'], ['projects.service.relocate', 1, 'hub', 'account'],
        ['projects.script.run', 1, 'source', 'terminal'], ['projects.service.relocate', 1, 'source', 'terminal'],
        ['localServices.launcher.start', 1, 'source', 'account'], ['localServices.launcher.start', 2, 'source', 'account'],
        ['localServices.launcher.start', 1, 'hub', 'account'], ['localServices.launcher.start', 1, 'source', 'terminal']] as const)(
        'retains the worker-bound %s root v%s through a %s controller from an installed %s with SOURCE Sync discovery, relay and receiver currentness', async (actionId, version, controllerKind, senderKind) => {
        const fixture = await createFixture({ qualifiedPat: false });
        const material = version === 2 ? { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) } : undefined;
        if (material) {
            const signing = tweetnacl.sign.keyPair();
            const contentPublicKey = new Uint8Array(tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey);
            await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: 'e2ee',
                publicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey,
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey }) } });
            const machineKey = createMachineDataEncryptionKeyV1({ material, dataKeyPublicKey: contentPublicKey, randomBytes: tweetnacl.randomBytes });
            const nonce = tweetnacl.randomBytes(SESSION_DATA_KEY_NONCE_BYTES);
            const cipher = createCipheriv('aes-256-gcm', machineKey.encryptionKey, nonce);
            const ciphertext = Buffer.concat([cipher.update(serializeSessionDataKeyValue(decodePlainMachineStoredContent(fixture.machine.metadata))), cipher.final()]);
            await db.machine.update({ where: { id: fixture.machine.id }, data: {
                metadata: encodeBase64(packSessionDataKeyBundleV0({ nonce, ciphertext, authTag: cipher.getAuthTag() })),
                dataEncryptionKey: new Uint8Array(machineKey.dataEncryptionKey) } });
        }
        const sourceCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const sourceKey = tweetnacl.sign.keyPair();
        const source = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: sourceCustodian.id,
            active: true, metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(sourceKey.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: sourceCustodian.id, machineId: source.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const controllerCustodian = controllerKind === 'hub' ? await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } }) : sourceCustodian;
        const controllerKey = controllerKind === 'hub' ? tweetnacl.sign.keyPair() : sourceKey;
        const controller = controllerKind === 'hub' ? await db.machine.create({ data: { id: crypto.randomUUID(),
            accountId: controllerCustodian.id, active: true, metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(controllerKey.publicKey) } }) : source;
        if (controllerKind === 'hub') await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: controllerCustodian.id,
            machineId: controller.id, principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const admitted = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: source.id, requiredRole: 'use' });
        if (admitted.kind !== 'admitted') throw new Error('Requester must have real independent SOURCE admission');
        const { kind: _kind, ...context } = admitted;
        const homeId = await getOrCreateServerIdentityId();
        const workspace = { serverId: homeId, workspaceId: crypto.randomUUID(), machineId: source.id, rootPath: '/source/project' };
        const input = actionId === 'projects.service.relocate' ? ProjectServiceRelocateInputV1Schema.parse({
            workspace: { serverId: homeId, refId: workspace.workspaceId }, serviceName: 'web', requestId: 'reviewed-move',
            currentTarget: { kind: 'managed_service', machineId: source.id, managedServiceId: 'native-web' },
            destination: { kind: 'workers', destination: { kind: 'machine', machineId: fixture.machine.id } },
            selectedTarget: { machineId: fixture.machine.id }, desiredPlacement: {
                workspace: { serverId: homeId, refId: workspace.workspaceId }, serviceName: 'web', expectedRevision: 0,
                expected: { kind: 'absent' }, value: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: fixture.machine.id } }, unavailable: 'fail' },
            },
        }) : actionId === 'localServices.launcher.start' ? DaemonLocalServiceLauncherStartRequestV1Schema.parse({
            machineId: fixture.machine.id, targetId: 'project-service:web', workspace,
            declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'web' } },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: fixture.machine.id } },
        }) : PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].parse(actionId === 'projects.script.run'
            ? { workspace, selection: { kind: 'named', name: 'test' } }
            : { workspace, executable: 'git', argv: ['status'], cwd: workspace.rootPath });
        const { app } = await createApp(fixture.team.id);
        try {
            const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const controllerToken = await auth.createToken(controllerCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const senderToken = senderKind === 'terminal' ? await auth.createToken(fixture.account.id, undefined,
                { kind: 'terminal', authority: 'account_automation' }) : token;
            const target = { kind: 'machine' as const, machineId: fixture.machine.id };
            const rootRequestId = crypto.randomUUID();
            const envelope = material ? sealExternalActionRequestV2({ binding: { serverIdentityId: homeId, accountId: fixture.account.id,
                actionId, requestId: rootRequestId, target, authentication: { kind: 'account', tokenEpoch: fixture.account.tokenEpoch } },
                input, material, randomBytes: tweetnacl.randomBytes })
                : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: rootRequestId, target, input });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: crypto.randomUUID(),
                accountServerId: homeId, sourceMachineId: source.id, sourceRootPath: workspace.rootPath,
                sourceContext: { machineAdmission: context, callerAuthority: 'present_user' }, originalActionEnvelope: envelope });
            const method = `${controller.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN}`;
            const params = { sourceWorkspaceRefId: workspace.workspaceId, targetWorkspaceRefId: crypto.randomUUID() };
            const requestId = crypto.randomUUID();
            const execution = { v: 1 as const, authorization: root, effectActionId: actionId, target: root.binding.target,
                installationId: fixture.machine.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: root.token, effectActionId: actionId, target: root.binding.target,
                    installationId: fixture.machine.installationId!, method, requestId, params, workspaceSyncSourceRouting: routing,
                    privateKey: fixture.keyPair.secretKey }) };
            const packet = { method, requestId, params, externalActionExecution: execution };
            const verify = (receiver: boolean, selectedRouting = routing, selectedPacket = packet) => {
                const machine = receiver ? controller : fixture.machine;
                const rpcAdmission = { context: selectedRouting.sourceContext!.machineAdmission, method,
                    workspaceSyncSourceRouting: selectedRouting, callerInputAuthorization: root,
                    ...(receiver ? { workspaceSyncSourceExecution: selectedPacket } : {}) };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: machine.id,
                    installationId: machine.installationId!, accountId: machine.accountId, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${machine.id}/admission/verify`,
                    headers: { authorization: `Bearer ${receiver ? controllerToken : token}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload,
                        privateKey: receiver ? controllerKey.secretKey : fixture.keyPair.secretKey }) } });
            };
            for (const receiver of [false, true]) {
                const result = await verify(receiver);
                expect(result.statusCode, result.body).toBe(200);
                expect(result.json()).toMatchObject({ ok: true, destinationInstallation: { machineId: controller.id,
                    installationId: controller.installationId } });
            }
            const delivered = vi.fn(async (_event: string, _request: unknown) => ({ ok: true }));
            const receiver = { id: 'finite-source-controller', data: { clientType: 'machine-scoped', machineId: controller.id,
                verifiedMachineInstallationId: controller.installationId }, timeout: () => ({ emitWithAck: delivered }) };
            qualifyCurrentAccountStoredContentSocket(receiver);
            const runtimeAction = actionId === 'projects.service.relocate' || actionId === 'localServices.launcher.start';
            const rootMethod = `${fixture.machine.id}:${runtimeAction ? actionId : PROJECT_FINITE_ACTION_RPC_METHODS_V1[actionId]}`;
            const rootDelivered = vi.fn(async (_event: string, _request: unknown) => ({ kind: 'accepted' }));
            const rootReceiver = { id: 'finite-root-worker', data: { clientType: 'machine-scoped', machineId: fixture.machine.id,
                verifiedMachineInstallationId: fixture.machine.installationId }, timeout: () => ({ emitWithAck: rootDelivered }) };
            qualifyCurrentAccountStoredContentSocket(rootReceiver);
            const io = createSocketRoomDiscoveryHarness(async room => room === receiver.id
                || room === `rpc:${controllerCustodian.id}:${method}` ? [receiver]
                : room === rootReceiver.id || room === `rpc:${fixture.account.id}:${rootMethod}` ? [rootReceiver] : []);
            const socket = Object.assign(createFakeSocket({ id: 'finite-worker-sender', data: { clientType: 'machine-scoped',
                machineId: fixture.machine.id, verifiedMachineInstallationId: fixture.machine.installationId,
                authTokenKind: senderKind, authAuthority: senderKind === 'terminal' ? 'account_automation' : 'present_user' } }),
                { handshake: { auth: { token: senderToken } } });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: fixture.account.id, socket: socket as unknown as Socket, io });
            const callback = vi.fn();
            const call = (externalActionExecution = execution, workspaceSyncSourceRouting = routing) => getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({
                method, requestId, params, externalActionExecution, workspaceSyncSourceRouting }, callback);
            const rootPacket = { ...execution, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
                effectActionId: actionId, target: root.binding.target, installationId: fixture.machine.installationId!,
                method: rootMethod, requestId, params: input, privateKey: fixture.keyPair.secretKey }) };
            const callRoot = (originalActionEnvelope = envelope) => getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({
                method: rootMethod, requestId, params: input, externalActionExecution: rootPacket, originalActionEnvelope }, callback);
            // Finite roots have their own canonical Machine RPC. Move enters
            // through the runtime Action front door, covered by its composed test.
            if (!runtimeAction && senderKind === 'account') {
                await callRoot();
                expect(callback).toHaveBeenLastCalledWith({ ok: true, result: { kind: 'accepted' } });
                expect(rootDelivered.mock.calls[0]?.[1]).toMatchObject({ callerInputAuthorization: root, originalActionEnvelope: envelope });
                await callRoot({ ...envelope, requestId: crypto.randomUUID() });
                expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
                expect(rootDelivered).toHaveBeenCalledTimes(1);
            }
            await call();
            expect(callback).toHaveBeenLastCalledWith({ ok: true, result: { ok: true } });
            expect(delivered.mock.calls[0]?.[1]).toMatchObject({ machineAdmission: context, callerInputAuthorization: root,
                workspaceSyncSourceRouting: routing, workspaceSyncSourceExecution: packet });
            expect(root.binding.machineId).toBe(fixture.machine.id);
            if (senderKind === 'terminal') {
                await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId, params,
                    workspaceSyncSourceRouting: routing }, callback);
                expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
                // A terminal is only the installed transport for this signed
                // effect. Neither a user socket nor a different installation
                // may acquire SOURCE preparation from the same root.
                for (const changed of [{ clientType: 'user-scoped' }, { machineId: source.id },
                    { verifiedMachineInstallationId: 'foreign-installation' }, { authTokenKind: 'api_token' }]) {
                    const previous = { ...socket.data };
                    Object.assign(socket.data, changed);
                    await call();
                    expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
                    Object.assign(socket.data, previous);
                }
                expect(delivered).toHaveBeenCalledTimes(1);
            }
            const foreignRouting = { ...routing, sourceRootPath: '/source/foreign' };
            // Move names its Account WorkspaceRef rather than carrying a raw
            // root. The requester-owned controller resolves that ref.
            if (version === 1 && actionId !== 'projects.service.relocate') expect((await verify(false, foreignRouting)).statusCode).toBe(403);
            expect((await verify(true, foreignRouting)).statusCode).toBe(403);
            const changedEnvelope = { ...routing, originalActionEnvelope: { ...envelope, requestId: crypto.randomUUID() } };
            expect((await verify(false, changedEnvelope)).statusCode).toBe(403);
            const foreignActorRouting = { ...routing, sourceContext: { ...routing.sourceContext!,
                machineAdmission: { ...context, actorAccountId: sourceCustodian.id } } };
            for (const receiver of [false, true]) expect((await verify(receiver, foreignActorRouting)).statusCode).toBe(403);
            const wrongParams = { ...params, sourceWorkspaceRefId: 'foreign-ref' };
            const wrongPacket = { ...packet, params: wrongParams, externalActionExecution: { ...execution,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: actionId,
                    target: root.binding.target, installationId: fixture.machine.installationId!, method, requestId,
                    params: wrongParams, workspaceSyncSourceRouting: routing, privateKey: fixture.keyPair.secretKey }) } };
            // V2's input stays opaque to Home; the receiver's verified opener owns
            // comparison with the original ref. V1 can discriminate it here too.
            if (version === 1) expect((await verify(true, routing, wrongPacket)).statusCode).toBe(403);
            const otherActionId = actionId === 'projects.script.run' ? 'projects.compute.exec' : 'projects.script.run';
            await call({ ...execution, effectActionId: otherActionId, machineSignature: signExternalActionMachineRpcRequestV1({
                authorizationToken: root.token, effectActionId: otherActionId, target: root.binding.target,
                installationId: fixture.machine.installationId!, method, requestId, params, workspaceSyncSourceRouting: routing,
                privateKey: fixture.keyPair.secretKey }) });
            expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
            await call({ ...execution, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
                effectActionId: actionId, target: root.binding.target, installationId: fixture.machine.installationId!,
                method, requestId, params, workspaceSyncSourceRouting: routing, privateKey: sourceKey.secretKey }) });
            expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
            await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: source.id, accountId: fixture.account.id } } });
            for (const receiver of [false, true]) expect((await verify(receiver)).statusCode).toBe(403);
            await call();
            expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: sourceCustodian.id, machineId: source.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            if (controllerKind === 'hub') {
                await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: controller.id, accountId: fixture.account.id } } });
                for (const receiver of [false, true]) expect((await verify(receiver)).statusCode).toBe(403);
                await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: controllerCustodian.id, machineId: controller.id,
                    principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            }
            await db.machine.update({ where: { id: source.id }, data: { installationId: crypto.randomUUID() } });
            for (const receiver of [false, true]) expect((await verify(receiver)).statusCode).toBe(403);
            await db.machine.update({ where: { id: source.id }, data: { installationId: source.installationId } });
            await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: crypto.randomUUID() } });
            for (const receiver of [false, true]) expect((await verify(receiver)).statusCode).toBe(403);
            await call();
            expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
            await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: fixture.machine.installationId } });
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await verify(true)).statusCode).toBe(403);
            await call();
            expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false }));
            expect(delivered).toHaveBeenCalledTimes(1);
        } finally { await app.close(); }
    });

    it.each([[1, 'Home'], [2, 'Home'], [1, 'Socket'], [2, 'Socket'],
        [1, 'B Home'], [2, 'B Home'], [1, 'B Socket'], [2, 'B Socket'],
        [1, 'Seed Home'], [2, 'Seed Home'], [1, 'Seed Socket'], [2, 'Seed Socket'],
        [1, 'Seed child Home'], [2, 'Seed child Home'], [1, 'Seed child Socket'], [2, 'Seed child Socket'],
        [1, 'Seed ordinary Home'], [2, 'Seed ordinary Home'], [1, 'Seed ordinary Socket'], [2, 'Seed ordinary Socket']] as const)(
        'verifies genuine Project Open v%s SOURCE custody without a Session or changing its D-bound Root through %s', async (version, boundary) => {
        const seedOwnTarget = boundary.startsWith('Seed child') || boundary.startsWith('Seed ordinary');
        const fixture = await createFixture({ qualifiedPat: false });
        const material = version === 2 ? { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) } : undefined;
        if (material) {
            const accountSigning = tweetnacl.sign.keyPair();
            const contentPublicKey = new Uint8Array(tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey);
            await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: 'e2ee',
                publicKey: Buffer.from(accountSigning.publicKey).toString('hex'), contentPublicKey: new Uint8Array(contentPublicKey),
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: accountSigning.secretKey, contentPublicKey }) } });
        }
        const sourceCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const writerKey = tweetnacl.sign.keyPair();
        const targetKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createMachine = (accountId: string, key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId, active: true, metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(sourceCustodian.id, childKey);
        const writer = await createMachine(sourceCustodian.id, writerKey);
        const target = await createMachine(targetCustodian.id, targetKey);
        const parent = await createMachine(targetCustodian.id, parentKey);
        for (const [machine, custodian] of [[child, sourceCustodian], [target, targetCustodian]] as const) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const sourceAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        expect(sourceAdmission).toMatchObject({ kind: 'admitted', role: 'use' });
        if (sourceAdmission.kind !== 'admitted') throw new Error('Project SOURCE must be genuinely admitted independently of Root target');
        const { kind: _sourceKind, ...context } = sourceAdmission;
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: writer.id })).toMatchObject({ kind: 'denied' });
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const homeId = await getOrCreateServerIdentityId();
        const createRow = (machine: typeof child, controller: typeof writer, custodianAccountId: string, childPath: string, hostPath: string,
            storage: 'bind' | 'child' = 'bind') => db.managedMachine.create({ data: {
            homeId, custodianAccountId, controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, enrolledMachineId: machine.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Project Sync child', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: machine.id, user: 'coder', workspaceFolder: childPath,
                    storage: storage === 'child' ? { kind: 'child', childPath } : { kind: 'bind', hostPath, childPath } } },
        } });
        const sourceRow = await createRow(child, writer, sourceCustodian.id, '/child/source', '/parent/source');
        if (!boundary.startsWith('Seed ordinary')) {
            await createRow(target, parent, targetCustodian.id, '/child/target', '/parent/target',
                boundary.startsWith('Seed child') ? 'child' : 'bind');
        } else {
            expect(await db.managedMachine.findUnique({ where: { enrolledMachineId: target.id } })).toBeNull();
        }
        const method = `${writer.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
        const projectMethod = `${target.id}:${RPC_METHODS.PROJECTS_OPEN}`;
        // Only the remote daemon network is simulated; no internal verifier or
        // materialization owner is mocked and this test claims no copy effect.
        const delivered = vi.fn(async (_event: string, _request: unknown) => ({ kind: 'materialized' }));
        const receiver = { id: 'project-source-physical-writer', data: { clientType: 'machine-scoped', machineId: writer.id,
            verifiedMachineInstallationId: writer.installationId }, timeout: () => ({ emitWithAck: delivered }) };
        const projectDelivered = vi.fn(async (_event: string, _request: unknown) => ({ kind: 'opened' }));
        const projectReceiver = { id: 'project-original-target', data: { clientType: 'machine-scoped', machineId: target.id,
            verifiedMachineInstallationId: target.installationId }, timeout: () => ({ emitWithAck: projectDelivered }) };
        qualifyCurrentAccountStoredContentSocket(receiver);
        qualifyCurrentAccountStoredContentSocket(projectReceiver);
        const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${sourceCustodian.id}:${method}`
            || room === receiver.id ? [receiver]
                : room === `rpc:${targetCustodian.id}:${projectMethod}` || room === projectReceiver.id ? [projectReceiver] : []);
        const { app } = await createApp(fixture.team.id);
        try {
            const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const sourceRef = { id: crypto.randomUUID(), serverId: homeId, machineId: child.id, rootPath: '/child/source', createdAtMs: 1 };
            const targetRef = { id: crypto.randomUUID(), serverId: homeId, machineId: target.id, rootPath: '/child/target', createdAtMs: 1 };
            const rowPayloads = [
                { key: { kind: 'workspace-ref' as const, serverId: homeId, id: sourceRef.id }, value: sourceRef },
                { key: { kind: 'workspace-ref' as const, serverId: homeId, id: targetRef.id }, value: targetRef },
                { key: { kind: 'relationship-graph' as const }, value: { relationships: [] } },
            ];
            const rows = await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate',
                headers: { authorization: `Bearer ${token}`, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { mutations: rowPayloads.map(payload => ({ key: payload.key, expectedRevision: 'absent', content: material
                    ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'project_account_row', payload, material, randomBytes: tweetnacl.randomBytes }) }
                    : { t: 'plain', v: payload } })), expectedRefs: [], topologyChange: true } });
            expect(rows.statusCode, rows.body).toBe(200);
            expect(rows.json()).toMatchObject({ status: 'updated' });
            const input = OpenProjectInputV1Schema.parse({ serverId: homeId, machineId: target.id,
                source: { kind: 'workspace', workspaceId: sourceRef.id,
                    checkout: { serverId: homeId, workspaceId: sourceRef.id, machineId: child.id, rootPath: sourceRef.rootPath } },
                materialization: { kind: 'sync', targetPath: targetRef.rootPath, workspaceAction: createFixtureCopyOnceWorkspaceAction() } });
            const requestId = crypto.randomUUID();
            const selectedTarget = { kind: 'machine' as const, machineId: target.id };
            const encryptionBinding = { serverIdentityId: homeId, accountId: fixture.account.id, actionId: 'projects.open', requestId,
                target: selectedTarget, authentication: { kind: 'account' as const, tokenEpoch: fixture.account.tokenEpoch } };
            const originalActionEnvelope = material ? sealExternalActionRequestV2({ binding: encryptionBinding, input, material, randomBytes: tweetnacl.randomBytes })
                : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target: selectedTarget, input });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('projects.open'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: target.id, envelope: originalActionEnvelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(root.binding).toMatchObject({ accountId: fixture.account.id, machineId: target.id,
                installationId: target.installationId, target: selectedTarget,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope) });
            expect(root.binding).not.toHaveProperty('sessionActionOrigin');
            expect(root.binding).not.toHaveProperty('handoffAdmission');
            if (material) {
                // The actual installed-D owner verifies the whole envelope before
                // this canonical V2 open; no plaintext/ciphertext digest substitution.
                expect(openExternalActionRequestV2({ envelope: originalActionEnvelope, binding: encryptionBinding, material })?.input).toEqual(input);
                expect(computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target: selectedTarget, input }))
                    .not.toBe(root.binding.requestEnvelopeDigest);
            }
            const workspaceSyncSourceRouting = { v: 1 as const, phase: 'prepare' as const, operationId: crypto.randomUUID(),
                accountServerId: homeId, sourceMachineId: child.id, sourceRootPath: sourceRef.rootPath,
                sourceContext: { machineAdmission: context, callerAuthority: 'present_user' as const }, originalActionEnvelope };
            expect(workspaceSyncSourceRouting.operationId).not.toBe(root.binding.requestId);
            expect(workspaceSyncSourceRouting).not.toHaveProperty('sourceSessionId');
            if (version === 1 && boundary === 'Home') {
                const current = await verifyCurrentExternalActionPrincipal(root.binding);
                expect(current).toMatchObject({ authority: 'present_user' });
                const attenuated = await readCurrentWorkspaceSyncProjectSourceAuthorization(root, {
                    ...workspaceSyncSourceRouting,
                    sourceContext: { ...workspaceSyncSourceRouting.sourceContext, callerAuthority: 'account_automation' },
                }, writer.id);
                expect(attenuated).not.toBeNull();
                expect(attenuated?.verified.principal).toEqual(current);
                expect(attenuated?.verified).toMatchObject({ effectiveAuthority: 'account_automation' });
            }
            const originalTransportRequestId = crypto.randomUUID();
            const signedRequest = { authorizationToken: root.token, effectActionId: 'projects.open', target: root.binding.target,
                installationId: target.installationId!, method, requestId: originalTransportRequestId, params: input,
                workspaceSyncSourceRouting };
            const execution = { v: 1 as const, authorization: root, effectActionId: 'projects.open', target: root.binding.target,
                installationId: target.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...signedRequest, privateKey: targetKey.secretKey }) };
            const workspaceSyncSourceExecution = { method, requestId: originalTransportRequestId, params: input,
                externalActionExecution: execution };
            expect(originalTransportRequestId).not.toBe(root.binding.requestId);
            if (boundary === 'B Home' || boundary === 'B Socket' || boundary.startsWith('Seed')) {
                const seed = boundary.startsWith('Seed');
                const source = WorkspaceSyncSourceRoutingV1Schema.parse({ ...workspaceSyncSourceRouting,
                    sourceContext: { ...workspaceSyncSourceRouting.sourceContext, callerPermissionMode: 'default', workspaceWrites: 'allow' } });
                // The live SOURCE packet is sealed to installed P1. Home must
                // bind readable V1 Root paths independently of opaque params.
                const sealSourceParams = (sourceInput: typeof input, sourceRouting: typeof source) => {
                    const inner = { v: 1, kind: 'workspace_sync_target_request_v1', machineId: writer.id,
                        installationId: writer.installationId, method, routing: sourceRouting,
                        replyPublicKey: Buffer.from(deriveBoxPublicKeyFromSeed(tweetnacl.randomBytes(32))).toString('base64url'),
                        rpc: { v: 2, k: 'req', m: method, c: randomBytes(16).toString('hex'), p: sourceInput } };
                    const bundle = sealBoxBundle({ recipientPublicKey: deriveBoxPublicKeyFromEd25519PublicKey(writerKey.publicKey),
                        randomBytes: tweetnacl.randomBytes, plaintext: new TextEncoder().encode(JSON.stringify(inner)) });
                    const opened = openBoxBundleWithSecretKey({ bundle, recipientSecretKey: deriveBoxSecretKeyFromSeed(writerKey.secretKey.subarray(0, 32)) });
                    expect(opened).not.toBeNull();
                    if (!opened) throw new Error('The installed SOURCE owner must decrypt the genuine packet');
                    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual(inner);
                    return JSON.stringify({ v: 1, kind: 'workspace_sync_target_request_v1', machineId: writer.id,
                        installationId: writer.installationId, ciphertext: Buffer.from(bundle).toString('base64url') });
                };
                const sealedSourceParams = sealSourceParams(input, source);
                const sourceExecution = { ...workspaceSyncSourceExecution, params: sealedSourceParams, externalActionExecution: { ...execution,
                    machineSignature: signExternalActionMachineRpcRequestV1({ ...signedRequest, params: sealedSourceParams, workspaceSyncSourceRouting: source,
                        privateKey: targetKey.secretKey }) } };
                const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1, source,
                    sourceWriter: { machineId: writer.id, installationId: writer.installationId! },
                    target: { v: 1, phase: seed ? 'prepare' : 'preflight', operationId: crypto.randomUUID(), accountServerId: homeId,
                        targetMachineId: target.id, targetRootPath: targetRef.rootPath } });
                const sourceContext = routing.source.sourceContext;
                const targetAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: target.id, requiredRole: 'use' });
                expect(targetAdmission).toMatchObject({ kind: 'admitted', role: 'use' });
                if (targetAdmission.kind !== 'admitted') throw new Error('Project target must remain independently admitted');
                const { kind: _targetKind, ...targetContext } = targetAdmission;
                const targetRouting = { ...routing.target, targetContext: { ...sourceContext, machineAdmission: targetContext } };
                const targetMethod = `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
                const physicalMethod = `${parent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
                const targetInput = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, serverId: homeId, machineId: target.id,
                    targetPath: targetRef.rootPath, operationId: routing.target.operationId });
                const writerToken = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
                const targetToken = await auth.createToken(targetCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
                if (seed) {
                    // Native child storage and an ordinary D export from D itself,
                    // not its controller. The same Root/actor/seed fence still applies.
                    const seedSigner = seedOwnTarget ? target : parent;
                    const seedSignerKey = seedOwnTarget ? targetKey : parentKey;
                    const wrongSeedSignerKey = seedOwnTarget ? parentKey : targetKey;
                    const workspaceSyncSeedRouting = { v: 1 as const, sourceWriterTarget: routing, target: targetRouting };
                    const seedMethod = `${writer.id}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`;
                    const seedInput = { t: 'workspace_sync_seed_v1' as const, operationId: routing.target.operationId,
                        sourceWorkspaceRefId: sourceRef.id, targetMachineId: seedSigner.id,
                        contentPolicy: createFixtureCopyOnceWorkspaceAction().contentPolicy };
                    if (boundary.endsWith('Home')) {
                        const verifySeed = (receiver = false, selectedRouting = workspaceSyncSeedRouting,
                            packet = sourceExecution, authorization = root, privateKey = receiver ? writerKey.secretKey : seedSignerKey.secretKey) => {
                            const signer = receiver ? writer : seedSigner;
                            const rpcAdmission = { context, method: seedMethod, workspaceSyncSeedRouting: selectedRouting,
                                workspaceSyncSourceExecution: packet, callerInputAuthorization: authorization };
                            const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: signer.id,
                                installationId: signer.installationId!, accountId: receiver ? sourceCustodian.id : targetCustodian.id, rpcAdmission });
                            return app.inject({ method: 'POST', url: `/v1/machines/${signer.id}/admission/verify`,
                                headers: { authorization: `Bearer ${receiver ? writerToken : targetToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                                payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey }) } });
                        };
                        for (const receiver of [false, true]) {
                            const admitted = await verifySeed(receiver);
                            expect(admitted.statusCode, admitted.body).toBe(200);
                            expect(admitted.json()).toEqual({ v: 1, ok: true, destinationInstallation: { machineId: writer.id,
                                installationId: writer.installationId, installationPublicKey: Buffer.from(writerKey.publicKey).toString('base64url') } });
                        }
                        if (boundary.startsWith('Seed child')) {
                            const enrollment = await db.managedMachine.findUniqueOrThrow({ where: { enrolledMachineId: target.id } });
                            await db.managedMachine.update({ where: { id: enrollment.id }, data: { archivedAt: new Date() } });
                            expect((await verifySeed()).statusCode).toBe(403);
                            await db.managedMachine.update({ where: { id: enrollment.id }, data: { archivedAt: null } });
                        }
                        expect((await verifySeed(false, workspaceSyncSeedRouting, sourceExecution, root, wrongSeedSignerKey.secretKey)).statusCode).toBe(403);
                        expect((await verifySeed(false, workspaceSyncSeedRouting, sourceExecution, { ...root, token: 'forged-root' })).statusCode).toBe(403);
                        expect((await verifySeed(false, { ...workspaceSyncSeedRouting, sourceWriterTarget: { ...routing,
                            sourceWriter: { machineId: parent.id, installationId: parent.installationId! } } })).statusCode).toBe(403);
                        expect((await verifySeed(false, { ...workspaceSyncSeedRouting, target: { ...targetRouting,
                            targetContext: { ...targetRouting.targetContext, machineAdmission: { ...targetContext, role: 'manage' } } } })).statusCode).toBe(403);
                        await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: sourceCustodian.id, machineId: child.id,
                            principal: { kind: 'account', accountId: fixture.account.id } }));
                        expect((await verifySeed()).statusCode).toBe(403);
                        return;
                    }
                    // Only Socket delivery is simulated. The CLI owner separately
                    // proves the existing active seed fence and publication lifecycle.
                    const exportEffect = vi.fn(async (_event: string, _request: unknown) => ({ transferId: 'seed-export' }));
                    const exportReceiver = { id: 'project-seed-source-writer', data: { clientType: 'machine-scoped', machineId: writer.id,
                        verifiedMachineInstallationId: writer.installationId }, timeout: () => ({ emitWithAck: exportEffect }) };
                    qualifyCurrentAccountStoredContentSocket(exportReceiver);
                    const seedIo = createSocketRoomDiscoveryHarness(async room => room === `rpc:${sourceCustodian.id}:${seedMethod}`
                        || room === exportReceiver.id ? [exportReceiver] : []);
                    const seedSocket = Object.assign(createFakeSocket({ id: 'project-physical-target-seed-sender', data: {
                        clientType: 'machine-scoped', machineId: seedSigner.id, verifiedMachineInstallationId: seedSigner.installationId,
                        authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token: targetToken } } });
                    qualifyCurrentAccountStoredContentSocket(seedSocket);
                    registerSocketRpcHandlers({ userId: targetCustodian.id, socket: seedSocket as unknown as Socket, io: seedIo });
                    const callback = vi.fn();
                    const seedRequestId = crypto.randomUUID();
                    const callSeed = (selectedRouting = workspaceSyncSeedRouting, packet = sourceExecution, privateKey = seedSignerKey.secretKey) => {
                        const request = { authorizationToken: root.token, effectActionId: 'projects.open', target: root.binding.target,
                            installationId: seedSigner.installationId!, method: seedMethod, requestId: seedRequestId, params: seedInput,
                            workspaceSyncSeedRouting: selectedRouting };
                        const externalActionExecution = { v: 1 as const, authorization: root, effectActionId: 'projects.open', target: root.binding.target,
                            installationId: seedSigner.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ ...request, privateKey }) };
                        return getSocketHandler(seedSocket, SOCKET_RPC_EVENTS.CALL)({ method: seedMethod, requestId: seedRequestId,
                            params: seedInput, workspaceSyncSeedRouting: selectedRouting, workspaceSyncSourceExecution: packet, externalActionExecution }, callback);
                    };
                    await callSeed();
                    expect(callback).toHaveBeenCalledWith({ ok: true, result: { transferId: 'seed-export' } });
                    expect(exportEffect.mock.calls[0]?.[1]).toMatchObject({ machineAdmission: context, callerInputAuthorization: root,
                        workspaceSyncSeedRouting, workspaceSyncSourceExecution: sourceExecution });
                    if (boundary.startsWith('Seed child')) {
                        const enrollment = await db.managedMachine.findUniqueOrThrow({ where: { enrolledMachineId: target.id } });
                        await db.managedMachine.update({ where: { id: enrollment.id }, data: { archivedAt: new Date() } });
                        callback.mockClear();
                        await callSeed();
                        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                        await db.managedMachine.update({ where: { id: enrollment.id }, data: { archivedAt: null } });
                    }
                    for (const selectedRouting of [
                        { ...workspaceSyncSeedRouting, sourceWriterTarget: { ...routing, source: { ...source, sourceRootPath: '/unscoped' } } },
                        { ...workspaceSyncSeedRouting, target: { ...targetRouting, targetContext: { ...targetRouting.targetContext,
                            machineAdmission: { ...targetContext, installationId: 'retired-target' } } } },
                    ]) {
                        callback.mockClear();
                        await callSeed(selectedRouting);
                        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                    }
                    callback.mockClear();
                    await callSeed(workspaceSyncSeedRouting, sourceExecution, wrongSeedSignerKey.secretKey);
                    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                    await db.machine.update({ where: { id: seedSigner.id }, data: { installationId: crypto.randomUUID() } });
                    callback.mockClear();
                    await callSeed();
                    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                    expect(exportEffect).toHaveBeenCalledTimes(1);
                    return;
                }
                const reviewedPurpose = version === 1 ? await (async () => {
                    const reviewedInput = OpenProjectInputV1Schema.parse({ ...input,
                        materialization: { ...input.materialization, targetPath: '/child/reviewed-target' } });
                    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(), target: selectedTarget, input: reviewedInput });
                    const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('projects.open'),
                        headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: target.id, envelope } });
                    expect(issued.statusCode, issued.body).toBe(200);
                    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
                    const reviewedSource = { ...source, originalActionEnvelope: envelope };
                    const params = sealSourceParams(reviewedInput, reviewedSource);
                    const packetRequestId = crypto.randomUUID();
                    const packet = { ...sourceExecution, requestId: packetRequestId, params, externalActionExecution: { ...execution,
                        authorization, machineSignature: signExternalActionMachineRpcRequestV1({ ...signedRequest,
                            authorizationToken: authorization.token, target: authorization.binding.target, requestId: packetRequestId,
                            params, workspaceSyncSourceRouting: reviewedSource, privateKey: targetKey.secretKey }) } };
                    // B still selects the current native D/P2 root. It must not
                    // spend the different path authorized by this genuine Root.
                    return { authorization, packet, routing: { ...routing, source: reviewedSource } };
                })() : null;
                if (boundary === 'B Home') {
                    const verifyTarget = (paired = false, selectedRouting = routing, packet: typeof sourceExecution | null = sourceExecution, authorization = root,
                        privateKey = paired ? targetKey.secretKey : writerKey.secretKey) => {
                        const signer = paired ? target : writer;
                        const rpcAdmission = { context: paired ? targetContext : context, method: paired ? physicalMethod : targetMethod,
                            workspaceSyncSourceWriterTargetRouting: selectedRouting, ...(packet ? { workspaceSyncSourceExecution: packet } : {}),
                            callerInputAuthorization: authorization, ...(paired ? { workspaceSyncTargetRouting: targetRouting } : {}) };
                        const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: signer.id,
                            installationId: signer.installationId!, accountId: paired ? targetCustodian.id : sourceCustodian.id, rpcAdmission });
                        return app.inject({ method: 'POST', url: `/v1/machines/${signer.id}/admission/verify`,
                            headers: { authorization: `Bearer ${paired ? targetToken : writerToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                            payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey }) } });
                    };
                    for (const [paired, destination, key] of [[false, target, targetKey], [true, parent, parentKey]] as const) {
                        const admitted = await verifyTarget(paired);
                        expect(admitted.statusCode, admitted.body).toBe(200);
                        expect(admitted.json()).toEqual({ v: 1, ok: true, destinationInstallation: { machineId: destination.id,
                            installationId: destination.installationId, installationPublicKey: Buffer.from(key.publicKey).toString('base64url') } });
                    }
                    if (reviewedPurpose) {
                        for (const paired of [false, true]) expect((await verifyTarget(paired, reviewedPurpose.routing,
                            reviewedPurpose.packet, reviewedPurpose.authorization)).statusCode).toBe(403);
                    }
                    expect((await verifyTarget(false, routing, sourceExecution, root, targetKey.secretKey)).statusCode).toBe(403);
                    expect((await verifyTarget(false, routing, null)).statusCode).toBe(403);
                    expect((await verifyTarget(false, routing, { ...sourceExecution, requestId: root.binding.requestId })).statusCode).toBe(403);
                    expect((await verifyTarget(false, { ...routing, source: { ...source, sourceRootPath: '/child/other' } })).statusCode).toBe(403);
                    expect((await verifyTarget(false, { ...routing, source: { ...source, sourceContext: { ...source.sourceContext,
                        machineAdmission: { ...context, role: 'manage' } } } })).statusCode).toBe(403);
                    expect((await verifyTarget(false, { ...routing, target: { ...routing.target, targetMachineId: writer.id } })).statusCode).toBe(403);
                    expect((await verifyTarget(false, { ...routing, target: { ...routing.target, targetRootPath: '/child/other' } })).statusCode).toBe(403);
                    expect((await verifyTarget(false, routing, sourceExecution, { ...root, token: 'forged-root' })).statusCode).toBe(403);
                    await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: targetCustodian.id, machineId: target.id,
                        principal: { kind: 'account', accountId: fixture.account.id } }));
                    expect((await verifyTarget()).statusCode).toBe(403);
                    return;
                }
                const firstDelivery = vi.fn(async (_event: string, _request: unknown) => ({ type: 'not_required' }));
                const secondDelivery = vi.fn(async (_event: string, _request: unknown) => ({ type: 'not_required' }));
                const firstReceiver = { id: 'project-b-target', data: { clientType: 'machine-scoped', machineId: target.id,
                    verifiedMachineInstallationId: target.installationId }, timeout: () => ({ emitWithAck: firstDelivery }) };
                const secondReceiver = { id: 'project-b-physical-target', data: { clientType: 'machine-scoped', machineId: parent.id,
                    verifiedMachineInstallationId: parent.installationId }, timeout: () => ({ emitWithAck: secondDelivery }) };
                qualifyCurrentAccountStoredContentSocket(firstReceiver);
                qualifyCurrentAccountStoredContentSocket(secondReceiver);
                const bIo = createSocketRoomDiscoveryHarness(async room => room === `rpc:${targetCustodian.id}:${targetMethod}`
                    || room === firstReceiver.id ? [firstReceiver]
                        : room === `rpc:${targetCustodian.id}:${physicalMethod}` || room === secondReceiver.id ? [secondReceiver] : []);
                const makeSender = (paired: boolean) => {
                    const signer = paired ? target : writer;
                    const socket = Object.assign(createFakeSocket({ id: paired ? 'project-b-target-sender' : 'project-b-source-writer',
                        data: { clientType: 'machine-scoped', machineId: signer.id, verifiedMachineInstallationId: signer.installationId,
                            authTokenKind: 'account', authAuthority: 'present_user' } }),
                        { handshake: { auth: { token: paired ? targetToken : writerToken } } });
                    qualifyCurrentAccountStoredContentSocket(socket);
                    registerSocketRpcHandlers({ userId: paired ? targetCustodian.id : sourceCustodian.id, socket: socket as unknown as Socket, io: bIo });
                    return socket;
                };
                const writerSocket = makeSender(false);
                const targetSocket = makeSender(true);
                const callback = vi.fn();
                const bRequestId = crypto.randomUUID();
                const callTarget = (paired = false, selectedRouting = routing, packet: typeof sourceExecution | null = sourceExecution,
                    privateKey = paired ? targetKey.secretKey : writerKey.secretKey, authorization = root) => {
                    const signer = paired ? target : writer;
                    const selectedMethod = paired ? physicalMethod : targetMethod;
                    const externalActionExecution = { v: 1 as const, authorization, effectActionId: 'projects.open', target: authorization.binding.target,
                        installationId: signer.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                            effectActionId: 'projects.open', target: authorization.binding.target, installationId: signer.installationId!, method: selectedMethod,
                            requestId: bRequestId, params: targetInput, workspaceSyncSourceWriterTargetRouting: selectedRouting, privateKey }) };
                    return getSocketHandler(paired ? targetSocket : writerSocket, SOCKET_RPC_EVENTS.CALL)({ method: selectedMethod,
                        requestId: bRequestId, params: targetInput, externalActionExecution, workspaceSyncSourceWriterTargetRouting: selectedRouting,
                        ...(packet ? { workspaceSyncSourceExecution: packet } : {}), ...(paired ? { workspaceSyncTargetRouting: targetRouting } : {}) }, callback);
                };
                for (const paired of [false, true]) {
                    callback.mockClear();
                    await callTarget(paired);
                    expect(callback).toHaveBeenCalledWith({ ok: true, result: { type: 'not_required' } });
                    expect((paired ? secondDelivery : firstDelivery).mock.calls[0]?.[1]).toMatchObject({ machineAdmission: targetContext,
                        callerAuthority: sourceContext.callerAuthority,
                        callerInputAuthorization: root, workspaceSyncSourceWriterTargetRouting: routing, workspaceSyncSourceExecution: sourceExecution });
                }
                if (reviewedPurpose) {
                    for (const paired of [false, true]) {
                        callback.mockClear();
                        await callTarget(paired, reviewedPurpose.routing, reviewedPurpose.packet,
                            paired ? targetKey.secretKey : writerKey.secretKey, reviewedPurpose.authorization);
                        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                    }
                }
                for (const altered of [
                    { ...routing, source: { ...source, sourceRootPath: '/child/other' } },
                    { ...routing, source: { ...source, sourceContext: { ...source.sourceContext, workspaceWrites: 'deny' as const } } },
                    { ...routing, target: { ...routing.target, targetMachineId: writer.id } },
                    { ...routing, target: { ...routing.target, targetRootPath: '/child/other' } },
                ]) {
                    callback.mockClear();
                    await callTarget(false, altered);
                    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                }
                callback.mockClear();
                await callTarget(false, routing, null);
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                callback.mockClear();
                await callTarget(false, routing, { ...sourceExecution, requestId: root.binding.requestId });
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                callback.mockClear();
                await callTarget(true, routing, sourceExecution, parentKey.secretKey);
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                expect(firstDelivery).toHaveBeenCalledTimes(1);
                expect(secondDelivery).toHaveBeenCalledTimes(1);
                return;
            }
            if (boundary === 'Socket') {
                const targetToken = await auth.createToken(targetCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
                const makeSocket = (machine: typeof target, id: string, token: string) => Object.assign(createFakeSocket({ id,
                    data: { clientType: 'machine-scoped', machineId: machine.id, verifiedMachineInstallationId: machine.installationId,
                        authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token } } });
                const socket = makeSocket(target, 'actual-installed-project-target', targetToken);
                qualifyCurrentAccountStoredContentSocket(socket);
                registerSocketRpcHandlers({ userId: targetCustodian.id, socket: socket as unknown as Socket, io });
                const callback = vi.fn();
                const projectRequestId = crypto.randomUUID();
                const projectSignedRequest = { authorizationToken: root.token, effectActionId: 'projects.open', target: root.binding.target,
                    installationId: target.installationId!, method: projectMethod, requestId: projectRequestId, params: input };
                const projectExecution = { ...execution, machineSignature: signExternalActionMachineRpcRequestV1({
                    ...projectSignedRequest, privateKey: targetKey.secretKey }) };
                const callProject = (envelope: unknown = originalActionEnvelope, params: typeof input = input) => getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({
                    method: projectMethod, requestId: projectRequestId, params, externalActionExecution: { ...projectExecution,
                        machineSignature: signExternalActionMachineRpcRequestV1({ ...projectSignedRequest, params, privateKey: targetKey.secretKey }) },
                    ...(envelope === null ? {} : { originalActionEnvelope: envelope }) }, callback);
                await callProject();
                expect(callback).toHaveBeenCalledWith({ ok: true, result: { kind: 'opened' } });
                expect(projectDelivered.mock.calls[0]?.[1]).toMatchObject({ callerInputAuthorization: root, originalActionEnvelope });
                for (const alteredEnvelope of [{ ...originalActionEnvelope, requestId: crypto.randomUUID() },
                    { ...originalActionEnvelope, target: { kind: 'machine', machineId: writer.id } }]) {
                    callback.mockClear();
                    await callProject(alteredEnvelope);
                    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                }
                if (version === 1) {
                    callback.mockClear();
                    await callProject(originalActionEnvelope, { ...input, ref: 'substituted-ref' });
                    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                }
                expect(projectDelivered).toHaveBeenCalledTimes(1);
                callback.mockClear();
                await callProject(null);
                expect(callback).toHaveBeenCalledWith({ ok: true, result: { kind: 'opened' } });
                expect(projectDelivered.mock.calls[1]?.[1]).not.toHaveProperty('originalActionEnvelope');
                expect(projectDelivered.mock.calls[1]?.[1]).not.toHaveProperty('callerInputAuthorization');
                callback.mockClear();
                const call = (selectedSocket = socket, externalActionExecution = execution, routing = workspaceSyncSourceRouting) =>
                    getSocketHandler(selectedSocket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: originalTransportRequestId,
                        params: input, externalActionExecution, workspaceSyncSourceRouting: routing }, callback);
                await call();
                expect(callback).toHaveBeenCalledWith({ ok: true, result: { kind: 'materialized' } });
                expect(delivered.mock.calls[0]?.[1]).toMatchObject({ machineAdmission: context, callerAuthority: 'present_user',
                    callerInputAuthorization: root, workspaceSyncSourceRouting, workspaceSyncSourceExecution });
                const forwarded = delivered.mock.calls[0]?.[1];
                expect(forwarded).toHaveProperty('requestId');
                if (!forwarded || typeof forwarded !== 'object' || !('requestId' in forwarded)) throw new Error('Relay request correlation required');
                expect(forwarded.requestId).not.toBe(originalTransportRequestId);
                callback.mockClear();
                await call(socket, { ...execution, machineSignature: signExternalActionMachineRpcRequestV1({ ...signedRequest, privateKey: childKey.secretKey }) });
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                callback.mockClear();
                await call(socket, execution, { ...workspaceSyncSourceRouting, sourceRootPath: '/child/unreviewed' });
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                const writerToken = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
                const writerSocket = makeSocket(writer, 'writer-cannot-claim-target-decryption', writerToken);
                qualifyCurrentAccountStoredContentSocket(writerSocket);
                registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: writerSocket as unknown as Socket, io });
                callback.mockClear();
                await call(writerSocket);
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                socket.data!.clientType = 'user-scoped';
                callback.mockClear();
                await call();
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
                expect(delivered).toHaveBeenCalledTimes(1);
                return;
            }
            const writerToken = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            // Independent Home input: the existing public signer and real D
            // installation create this packet. Socket capture is proved above,
            // not inferred from this boundary fixture.
            const verify = (routing = workspaceSyncSourceRouting, authorization = root, privateKey = writerKey.secretKey,
                sourceExecution = workspaceSyncSourceExecution) => {
                const rpcAdmission = { context, method, workspaceSyncSourceRouting: routing, callerInputAuthorization: authorization,
                    workspaceSyncSourceExecution: sourceExecution };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: writer.id,
                    installationId: writer.installationId!, accountId: sourceCustodian.id, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${writer.id}/admission/verify`,
                    headers: { authorization: `Bearer ${writerToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey }) } });
            };
            // Initial discovery belongs to installed D, before a Socket call
            // exists. D signs only its own installation proof; no P1 token/key
            // or purported already-forwarded execution packet is available.
            const targetToken = await auth.createToken(targetCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const discoverSource = (routing = workspaceSyncSourceRouting, authorization = root,
                privateKey = targetKey.secretKey, daemonToken = targetToken) => {
                const rpcAdmission = { context, method, workspaceSyncSourceRouting: routing, callerInputAuthorization: authorization };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: target.id,
                    installationId: target.installationId!, accountId: targetCustodian.id, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${target.id}/admission/verify`,
                    headers: { authorization: `Bearer ${daemonToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey }) } });
            };
            const sourceDestination = { machineId: writer.id, installationId: writer.installationId,
                installationPublicKey: Buffer.from(writerKey.publicKey).toString('base64url') };
            const discovered = await discoverSource();
            expect(discovered.statusCode, discovered.body).toBe(200);
            expect(discovered.json()).toEqual({ v: 1, ok: true, destinationInstallation: sourceDestination });
            expect((await discoverSource(workspaceSyncSourceRouting, root, writerKey.secretKey)).statusCode).toBe(403);
            expect((await discoverSource(workspaceSyncSourceRouting, root, targetKey.secretKey, writerToken)).statusCode).toBe(403);
            expect((await discoverSource({ ...workspaceSyncSourceRouting, sourceRootPath: '/child/other' })).statusCode).toBe(403);
            expect((await discoverSource({ ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                machineAdmission: { ...context, role: 'manage' } } })).statusCode).toBe(403);
            expect((await discoverSource(workspaceSyncSourceRouting, { ...root, token: 'not-a-home-issued-root' })).statusCode).toBe(403);
            const verified = await verify();
            expect(verified.statusCode, verified.body).toBe(200);
            expect(verified.json()).toEqual({ v: 1, ok: true, destinationInstallation: {
                machineId: writer.id, installationId: writer.installationId,
                installationPublicKey: Buffer.from(writerKey.publicKey).toString('base64url'),
            } });
            expect((await verify(workspaceSyncSourceRouting, root, targetKey.secretKey)).statusCode).toBe(403);
            expect((await verify({ ...workspaceSyncSourceRouting, sourceRootPath: '/child/other' })).statusCode).toBe(403);
            expect((await verify(workspaceSyncSourceRouting, { ...root, token: 'not-a-home-issued-root' })).statusCode).toBe(403);
            expect((await verify(workspaceSyncSourceRouting, root, writerKey.secretKey, { ...workspaceSyncSourceExecution,
                requestId: root.binding.requestId })).statusCode).toBe(403);
            expect((await verify(workspaceSyncSourceRouting, root, writerKey.secretKey, { ...workspaceSyncSourceExecution,
                externalActionExecution: { ...execution, machineSignature: signExternalActionMachineRpcRequestV1({ ...signedRequest, privateKey: childKey.secretKey }) } })).statusCode).toBe(403);
            expect((await verify({ ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                machineAdmission: { ...context, role: 'manage' } } })).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: sourceRow.id }, data: { resource: {
                contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {} } } });
            expect((await verify()).statusCode).toBe(403);
            expect((await discoverSource()).statusCode).toBe(403);
            await db.managedMachine.update({ where: { id: sourceRow.id }, data: { resource: {
                contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: child.id, user: 'coder', workspaceFolder: '/child/source',
                    storage: { kind: 'bind', hostPath: '/parent/source', childPath: '/child/source' } } } } });
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: sourceCustodian.id, machineId: child.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            expect((await verify()).statusCode).toBe(403);
            expect((await discoverSource()).statusCode).toBe(403);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: sourceCustodian.id, machineId: child.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            await db.machine.update({ where: { id: target.id }, data: { installationId: crypto.randomUUID() } });
            expect((await verify()).statusCode).toBe(403);
            expect((await discoverSource()).statusCode).toBe(403);
        } finally { await app.close(); }
    });

    it.each(['projects.open', 'projects.trust.list'] as const)('permits only the original projects.open purpose to read a Source with %s', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const source = await db.projectSource.create({ data: { id: crypto.randomUUID(), name: 'Requester Source', revision: 1,
            createdByAccountId: fixture.account.id, audience: [], attachments: [], repository: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'requester/project', cloneUrl: 'https://github.com/requester/project.git', visibility: 'private' },
                protocol: 'https' } } });
        const { app } = await createApp(fixture.team.id);
        try {
            const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: fixture.machine.id }, input: { source: { kind: 'source', sourceId: source.id } } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId });
            const homeId = await getOrCreateServerIdentityId();
            const path = `/v1/projects/sources/${encodeURIComponent(source.id)}?serverId=${encodeURIComponent(homeId)}`;
            const read = await app.inject({ method: 'GET', url: path, headers: machineHeaders({ authorizationToken: authorization.token,
                effectActionId: actionId, method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey }) });
            expect(read.statusCode, read.body).toBe(actionId === 'projects.open' ? 200 : 401);
            if (actionId === 'projects.open') {
                expect(read.json()).toMatchObject({ ok: true, source: { id: source.id, createdByAccountId: fixture.account.id }, canManage: true });
                // Source visibility still belongs to the original requester, never the installed custodian.
                await db.projectSource.update({ where: { id: source.id }, data: { createdByAccountId: custodian.id } });
                const hidden = await app.inject({ method: 'GET', url: path, headers: machineHeaders({ authorizationToken: authorization.token,
                    effectActionId: actionId, method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey }) });
                expect(hidden.statusCode, hidden.body).toBe(404);
                const mutationPath = `/v1/projects/sources/${encodeURIComponent(source.id)}`;
                const body = { serverId: homeId, sourceId: source.id, expectedRevision: 1, patch: { name: 'Must not mutate' } };
                const mutation = await app.inject({ method: 'PATCH', url: mutationPath, payload: body,
                    headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                        method: 'PATCH', path: mutationPath, body, privateKey: fixture.keyPair.secretKey }) });
                expect(mutation.statusCode, mutation.body).toBe(401);
                expect((await db.projectSource.findUniqueOrThrow({ where: { id: source.id } })).name).toBe('Requester Source');
            }
        } finally { await app.close(); }
    });

    it.each(['grant', 'installation', 'epoch', 'publisher-during-eligibility'] as const)('refuses a Project mutation after final awaited %s loss', async loss => {
        const envBefore = snapshotEnv();
        let restoreFetch: (() => void) | undefined;
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const destinationKey = tweetnacl.sign.keyPair();
        const destination = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(destinationKey.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: destination.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const fence = new Date();
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: fence } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        let discoveryReads = 0;
        let retireOnFinalRead = false;
        let publisherVisible = true;
        let eligibilityRead = false;
        // Socket discovery alone is external; source binding and destination admission use real SQLite owners.
        const io = { in: (room: string) => ({ fetchSockets: async () => {
            if (retireOnFinalRead && ++discoveryReads === 2 && loss !== 'publisher-during-eligibility') {
                if (loss === 'grant') await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                    machineId: destination.id, principal: { kind: 'account', accountId: fixture.account.id } }));
                else if (loss === 'epoch') await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
                else await db.machine.update({ where: { id: destination.id }, data: { installationId: 'replacement-installation' } });
            }
            return publisherVisible && room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher] : [];
        } }) } as unknown as Server;
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'source-turn',
            callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: crypto.randomUUID() });
        const actionId = 'projects.open';
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: destination.id }, input: { serverId: homeId, machineId: destination.id,
                source: { kind: 'folder', path: '/workspace/project' }, materialization: { kind: 'attach' } } });
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: { homeId, actionId,
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: destination.id, envelope,
                    sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: destination.installationId!, requestId: authorization.binding.requestId });
            const key = { kind: 'project-organization', serverId: homeId, projectKey: 'destination-currentness' } as const;
            const path = '/v1/account/project-rows/mutate';
            const body = { mutations: [{ key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: { pinned: true } } } }],
                expectedRefs: [], topologyChange: false };
            if (loss === 'publisher-during-eligibility') {
                await db.accountIdentity.create({ data: { accountId: fixture.account.id, provider: 'github',
                    providerUserId: 'project-requester', providerLogin: 'project-requester', profile: {},
                    token: encryptString(['user', fixture.account.id, 'github', 'token'], 'github-oauth-boundary-token') } });
                applyEnvValues({ AUTH_REQUIRED_LOGIN_PROVIDERS: 'github', AUTH_GITHUB_ALLOWED_USERS: '',
                    AUTH_GITHUB_ALLOWED_ORGS: 'requester-projects', AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'oauth_user_token',
                    AUTH_OFFBOARDING_ENABLED: 'false' });
                // Only GitHub's actual HTTP boundary is replaced. The real eligibility
                // owner remains eligible while the live source publisher retires.
                const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
                    expect(String(url)).toBe('https://api.github.com/orgs/requester-projects/members/project-requester');
                    eligibilityRead = true;
                    publisherVisible = false;
                    return new Response(null, { status: 204 });
                });
                restoreFetch = () => fetchSpy.mockRestore();
            }
            retireOnFinalRead = true;
            const response = await app.inject({ method: 'POST', url: path, headers: machineHeaders({ authorizationToken: authorization.token,
                effectActionId: actionId, method: 'POST', path, body, privateKey: destinationKey.secretKey }), payload: body });
            if (loss === 'publisher-during-eligibility') {
                expect(eligibilityRead).toBe(true);
                expect(publisherVisible).toBe(false);
                expect((await db.account.findUniqueOrThrow({ where: { id: fixture.account.id } })).tokenEpoch).toBe(fixture.account.tokenEpoch);
                expect((await db.machine.findUniqueOrThrow({ where: { id: destination.id } })).installationId).toBe(destination.installationId);
                expect(await db.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
                    accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } } })).not.toBeNull();
            } else expect(discoveryReads).toBe(2);
            expect(response.statusCode, response.body).toBe(401);
            expect(await resolvePublisher({ accountId: fixture.account.id, sessionId: session.id }))
                .toBe(loss === 'publisher-during-eligibility' ? null : fixture.machine.id);
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: fixture.account.id,
                key: buildProjectAccountRowPhysicalKeyV1(key) } } })).toBeNull();
        } finally { restoreFetch?.(); restoreEnv(envBefore); await app.close(); }
    });

    it.each(['full', 'scoped'] as const)('verifies the genuine %s original SOURCE root under the physical writer installation proof before effects', async scope => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null,
            modelId: 'allowed-model' }], permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'source-root-home-proof',
            grant: { ...API_TOKEN_FULL_GRANT_V1,
                ...(scope === 'scoped' ? { actions: { families: [], ids: ['session.handoff'] } } : {}), ...callerInputConstraints } });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const anotherActor = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createMachine = (key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, active: true, metadata: fixture.machine.metadata,
            dataEncryptionKey: fixture.machine.dataEncryptionKey, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(childKey);
        const parent = await createMachine(parentKey);
        for (const actorAccountId of [fixture.account.id, anotherActor.id]) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: child.id, principal: { kind: 'account', accountId: actorAccountId }, level: 'view' }));
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const admitted = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        expect(admitted).toMatchObject({ kind: 'admitted', role: 'use' });
        if (admitted.kind !== 'admitted') throw new Error('Real original shared-child admission required');
        const { kind: _kind, ...context } = admitted;
        const homeId = await getOrCreateServerIdentityId();
        const sourceRow = await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
            controllerMachineId: parent.id, controllerInstallationId: parent.installationId!, enrolledMachineId: child.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'SOURCE proof child', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: child.id, user: 'coder', workspaceFolder: '/child/source',
                    storage: { kind: 'bind', hostPath: '/parent/source', childPath: '/child/source' } } },
        } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id, data: 'source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${parent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
        // These are only the network delivery/result boundary. The receiver's
        // existing prepared-entry tests, not a server fixture map, prove custody.
        const delivered = vi.fn(async (_event: string, _request: unknown) => ({ success: true }));
        const parentSocket = { id: 'source-proof-parent-receiver', data: { clientType: 'machine-scoped', machineId: parent.id,
            verifiedMachineInstallationId: parent.installationId }, timeout: () => ({ emitWithAck: delivered }) };
        qualifyCurrentAccountStoredContentSocket(parentSocket);
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher]
            : room === `rpc:${custodian.id}:${method}` || room === parentSocket.id ? [parentSocket] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        try {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: child.id },
                handoffAdmission: { sessionId: session.id, sourceMachineId: child.id, targetMachineId: fixture.machine.id },
                input: { sessionId: session.id, targetMachineId: fixture.machine.id, targetPath: '/target', accountServerId: homeId,
                    workspaceAction: createFixtureCopyOnceWorkspaceAction() } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: child.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: root.binding.requestId, accountServerId: homeId,
                sourceMachineId: child.id, sourceRootPath: '/child/source', sourceSessionId: session.id,
                sourceContext: { machineAdmission: context, callerAuthority: 'account_automation', callerInputConstraints } });
            const currentPrincipal = await verifyCurrentExternalActionPrincipal(root.binding);
            if (!currentPrincipal || !('grant' in currentPrincipal)) throw new Error('Current PAT principal required');
            const sourceProof = await verifyWorkspaceSyncHandoffSourceAuthorization(root, routing, resolvePublisher);
            expect(sourceProof?.principal).toMatchObject({
                expiresAt: currentPrincipal.expiresAt,
                parentTokenId: currentPrincipal.parentTokenId,
                embedConfig: currentPrincipal.embedConfig,
            });
            const accountToken = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const verify = (callerInputAuthorization: typeof root | null = root, workspaceSyncSourceRouting = routing, privateKey = parentKey.secretKey) => {
                const rpcAdmission = { context: workspaceSyncSourceRouting.sourceContext?.machineAdmission ?? context, method,
                    workspaceSyncSourceRouting, ...(callerInputAuthorization ? { callerInputAuthorization } : {}) };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: parent.id,
                    installationId: parent.installationId!, accountId: custodian.id, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${parent.id}/admission/verify`,
                    headers: { authorization: `Bearer ${accountToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey }) } });
            };
            const response = await verify();
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ v: 1, ok: true });
            expect((await verify({ ...root, token: 'forged-root-token' })).statusCode).toBe(403);
            expect((await verify({ ...root, binding: { ...root.binding, requestEnvelopeDigest: 'a'.repeat(43) } })).statusCode).toBe(403);
            expect((await verify(root, { ...routing, operationId: crypto.randomUUID() })).statusCode).toBe(403);
            expect((await verify(root, { ...routing, sourceSessionId: 'substituted-session' })).statusCode).toBe(403);
            expect((await verify(root, { ...routing, sourceRootPath: '/child/other' })).statusCode).toBe(403);
            if (!routing.sourceContext) throw new Error('Original SOURCE context required');
            expect((await verify(root, { ...routing, sourceContext: { ...routing.sourceContext,
                machineAdmission: { ...context, actorAccountId: anotherActor.id } } })).statusCode).toBe(403);
            expect((await verify(root, { ...routing, sourceContext: { ...routing.sourceContext,
                callerInputConstraints: { models: null, permissionModes: null } } })).statusCode).toBe(403);
            expect((await verify(root, routing, childKey.secretKey)).statusCode).toBe(403);
            const sourceSocket = Object.assign(createFakeSocket({ id: 'still-installed-source-guest', data: {
                clientType: 'machine-scoped', machineId: child.id, verifiedMachineInstallationId: child.installationId,
                authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token: accountToken } } });
            qualifyCurrentAccountStoredContentSocket(sourceSocket);
            registerSocketRpcHandlers({ userId: custodian.id, socket: sourceSocket as unknown as Socket, io, sessionPublisherPresence: presence });
            const params = 'opaque-retained-source-prepare';
            const execution = { v: 1 as const, authorization: root, effectActionId: 'session.handoff', target: root.binding.target,
                installationId: child.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
                    effectActionId: 'session.handoff', target: root.binding.target, installationId: child.installationId!, event: SOCKET_RPC_EVENTS.CALL,
                    method, requestId: root.binding.requestId, params, privateKey: childKey.secretKey }) };
            const callback = vi.fn();
            await getSocketHandler(sourceSocket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: root.binding.requestId, params,
                externalActionExecution: execution, workspaceSyncSourceRouting: routing }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { success: true } });
            expect(delivered.mock.calls[0]?.[1]).toMatchObject({ callerInputAuthorization: root, workspaceSyncSourceRouting: routing });
            await auth.revokeApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId });
            expect((await verify()).statusCode).toBe(403);
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: child.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            // The real replacement writer clears this inverse/native observation
            // while the original installed guest and controller still exist.
            await db.managedMachine.update({ where: { id: sourceRow.id }, data: { enrolledMachineId: null,
                resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {} } } });
            // Only the current custodian's retained release purpose survives:
            // no retired borrower bearer or restored effect permission.
            const releaseRouting = { ...routing, phase: 'abort' as const };
            expect((await verify(null, releaseRouting)).statusCode).toBe(200);
            callback.mockClear();
            await getSocketHandler(sourceSocket, SOCKET_RPC_EVENTS.CALL)({ method, params: 'opaque-retained-source-abort',
                workspaceSyncSourceRouting: releaseRouting }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { success: true } });
            expect(delivered.mock.calls[1]?.[1]).toMatchObject({ machineAdmission: context, workspaceSyncSourceRouting: releaseRouting });
            expect(delivered.mock.calls[1]?.[1]).not.toHaveProperty('callerInputAuthorization');
            callback.mockClear();
            await getSocketHandler(sourceSocket, SOCKET_RPC_EVENTS.CALL)({ method, params,
                workspaceSyncSourceRouting: routing }, callback);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            sourceSocket.data!.verifiedMachineInstallationId = crypto.randomUUID();
            callback.mockClear();
            await getSocketHandler(sourceSocket, SOCKET_RPC_EVENTS.CALL)({ method, params: 'opaque-retained-source-abort',
                workspaceSyncSourceRouting: releaseRouting }, callback);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(delivered).toHaveBeenCalledTimes(2);
        } finally { await app.close(); }
    });

    it('refuses the original Session SOURCE root after its publisher retires during requester provider eligibility', async () => {
        const envBefore = snapshotEnv();
        let restoreFetch: (() => void) | undefined;
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createMachine = (key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, active: true, metadata: fixture.machine.metadata,
            dataEncryptionKey: fixture.machine.dataEncryptionKey, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(childKey);
        const parent = await createMachine(parentKey);
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: child.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const admission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        if (admission.kind !== 'admitted') throw new Error('Real original shared-source admission required');
        const { kind: _kind, ...context } = admission;
        const homeId = await getOrCreateServerIdentityId();
        await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
            controllerMachineId: parent.id, controllerInstallationId: parent.installationId!, enrolledMachineId: child.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Session SOURCE proof child', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: child.id, user: 'coder', workspaceFolder: '/child/source',
                    storage: { kind: 'bind', hostPath: '/parent/source', childPath: '/child/source' } } },
        } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id, data: 'session-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        // Socket discovery and GitHub HTTP are external boundaries; all source,
        // principal, C41 and native-bind decisions use their actual owners.
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        const requesterToken = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const custodianToken = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 },
            sourceTurnId: 'source-eligibility-turn', callerPermissionMode: 'default',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' }, requestId: crypto.randomUUID() });
        const source = { machineId: child.id, installationId: child.installationId! };
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: child.id },
            handoffAdmission: { sessionId: session.id, sourceMachineId: child.id, targetMachineId: fixture.machine.id },
            input: { sessionId: session.id, targetMachineId: fixture.machine.id, targetPath: '/target', accountServerId: homeId,
                workspaceAction: createFixtureCopyOnceWorkspaceAction() } });
        const installationProof = signMachineInstallationProof({ privateKey: childKey.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: { homeId, actionId: 'session.handoff',
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${requesterToken}` }, payload: { v: 1, machineId: child.id, envelope,
                    sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: root.binding.requestId,
                accountServerId: homeId, sourceMachineId: child.id, sourceRootPath: '/child/source', sourceSessionId: session.id,
                sourceContext: { machineAdmission: context, callerAuthority: 'account_automation', sessionActionOrigin: origin,
                    callerPermissionMode: origin.callerPermissionMode, causalPermissionAuthority: origin.causalPermissionAuthority } });
            const rpcAdmission = { context, method: `${parent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`,
                workspaceSyncSourceRouting: routing, callerInputAuthorization: root };
            const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: parent.id,
                installationId: parent.installationId!, accountId: custodian.id, rpcAdmission });
            const verify = () => app.inject({ method: 'POST', url: `/v1/machines/${parent.id}/admission/verify`,
                headers: { authorization: `Bearer ${custodianToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey: parentKey.secretKey }) } });
            const current = await verify();
            expect(current.statusCode, current.body).toBe(200);
            expect(await resolvePublisher({ accountId: fixture.account.id, sessionId: session.id })).toBe(child.id);
            const requesterLogin = `source-requester-${fixture.account.id}`;
            const custodianLogin = `source-writer-${custodian.id}`;
            for (const [accountId, login] of [[fixture.account.id, requesterLogin], [custodian.id, custodianLogin]] as const) {
                await db.accountIdentity.create({ data: { accountId, provider: 'github', providerUserId: login, providerLogin: login, profile: {},
                    token: encryptString(['user', accountId, 'github', 'token'], 'github-source-boundary-token'),
                    // The installed writer's already-eligible identity skips its
                    // own org lookup; only the original requester is due.
                    ...(accountId === custodian.id ? { eligibilityStatus: 'eligible', eligibilityCheckedAt: new Date() } : {}) } });
            }
            applyEnvValues({ AUTH_REQUIRED_LOGIN_PROVIDERS: 'github', AUTH_GITHUB_ALLOWED_USERS: '',
                AUTH_GITHUB_ALLOWED_ORGS: 'source-requesters', AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'oauth_user_token', AUTH_OFFBOARDING_ENABLED: 'false' });
            let requesterEligibilityReached = false;
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
                expect(String(url)).toBe(`https://api.github.com/orgs/source-requesters/members/${requesterLogin}`);
                requesterEligibilityReached = true;
                expect(await presence.closePublisher({ socket: publisher })).toMatchObject({ status: 'closed' });
                return new Response(null, { status: 204 });
            });
            restoreFetch = () => fetchSpy.mockRestore();
            const retired = await verify();
            expect(requesterEligibilityReached).toBe(true);
            expect(await resolvePublisher({ accountId: fixture.account.id, sessionId: session.id })).toBeNull();
            expect((await db.account.findUniqueOrThrow({ where: { id: fixture.account.id } })).tokenEpoch).toBe(fixture.account.tokenEpoch);
            expect(await db.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
                accountId: fixture.account.id, machineId: child.id, sessionId: session.id } } })).not.toBeNull();
            expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' }))
                .toMatchObject({ kind: 'admitted', installationId: child.installationId, role: 'use' });
            expect((await db.machine.findUniqueOrThrow({ where: { id: parent.id } })).installationId).toBe(parent.installationId);
            expect(retired.statusCode, retired.body).toBe(403);
        } finally { restoreFetch?.(); restoreEnv(envBefore); await app.close(); }
    });

    it.each(['Home', 'Socket'] as const)('authenticates B-only physical writer release across custodians after the chosen child retires without a Root bearer through %s', async boundary => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'allowed-model' }],
            permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'retained-target-release',
            grant: { ...API_TOKEN_FULL_GRANT_V1, ...callerInputConstraints } });
        const sourceCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const writerKey = tweetnacl.sign.keyPair();
        const targetKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const strangerKey = tweetnacl.sign.keyPair();
        const createMachine = (accountId: string, key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId, active: true, metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(sourceCustodian.id, childKey);
        const writer = await createMachine(sourceCustodian.id, writerKey);
        const target = await createMachine(targetCustodian.id, targetKey);
        const parent = await createMachine(targetCustodian.id, parentKey);
        const stranger = await createMachine(sourceCustodian.id, strangerKey);
        for (const [machine, custodian] of [[child, sourceCustodian], [target, targetCustodian]] as const) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const sourceAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        const writerAdmission = await resolveMachineAdmission({ actorAccountId: sourceCustodian.id, machineId: writer.id });
        if (sourceAdmission.kind !== 'admitted' || writerAdmission.kind !== 'admitted') throw new Error('Current source snapshot and installed writer required');
        const { kind: _sourceKind, ...originalSourceAdmission } = sourceAdmission;
        const { kind: _writerKind, ...transportAdmission } = writerAdmission;
        expect(await resolveMachineAdmission({ actorAccountId: sourceCustodian.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const homeId = await getOrCreateServerIdentityId();
        const createRow = (machine: typeof child, controller: typeof writer, custodianAccountId: string, rootPath: string, hostPath: string) => db.managedMachine.create({ data: {
            homeId, custodianAccountId, controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, enrolledMachineId: machine.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Retained cleanup child', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: machine.id, user: 'coder', workspaceFolder: rootPath,
                    storage: { kind: 'bind', hostPath, childPath: rootPath } } },
        } });
        await createRow(child, writer, sourceCustodian.id, '/child/source', '/parent/source');
        const targetRow = await createRow(target, parent, targetCustodian.id, '/child/target', '/parent/target');
        const retainedTarget = await readMachineDevcontainerWorkspaceSyncRouteInTx(db, { accountServerId: homeId,
            childMachineId: target.id, childRootPath: '/child/target', parentMachineId: parent.id });
        expect(retainedTarget).toMatchObject({ parentInstallationId: parent.installationId });
        if (!retainedTarget) throw new Error('Canonical physical target must be captured before retirement');
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id, data: 'source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher, binding: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${parent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`;
        // Home/socket own authentication and forwarding, not the receiver's loan.
        // The real RetainedBootstrap tests decide exact snapshot/op matching and
        // root-fence release; this mock replaces only network delivery/reply.
        const delivered = vi.fn(async (_event: string, _request: unknown) => 'sealed-release-delivery-response');
        const receiver = { id: 'retained-physical-target-receiver', data: { clientType: 'machine-scoped', machineId: parent.id,
            verifiedMachineInstallationId: parent.installationId }, timeout: () => ({ emitWithAck: delivered }) };
        qualifyCurrentAccountStoredContentSocket(receiver);
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher]
            : room === `rpc:${targetCustodian.id}:${method}` || room === receiver.id ? [receiver] : []);
        const { app } = await createApp(fixture.team.id, false, input => resolveCurrentSessionMachineFromServer({ io, presence, ...input }));
        try {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: child.id },
                handoffAdmission: { sessionId: session.id, sourceMachineId: child.id, targetMachineId: target.id },
                input: { sessionId: session.id, targetMachineId: target.id, targetPath: '/child/target', accountServerId: homeId, workspaceAction: createFixtureCopyOnceWorkspaceAction() } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: child.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(root.binding).toMatchObject({ accountId: fixture.account.id, machineId: child.id, custodianAccountId: sourceCustodian.id });
            const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
                source: { v: 1, phase: 'prepare', operationId: crypto.randomUUID(), accountServerId: homeId,
                    sourceMachineId: child.id, sourceSessionId: session.id, sourceRootPath: '/child/source',
                    sourceContext: { machineAdmission: originalSourceAdmission, callerAuthority: 'account_automation', callerInputConstraints } },
                sourceWriter: { machineId: writer.id, installationId: writer.installationId! },
                target: { v: 1, phase: 'release', operationId: crypto.randomUUID(), accountServerId: homeId,
                    targetMachineId: target.id, targetRootPath: '/child/target' } });
            await db.managedMachine.update({ where: { id: targetRow.id }, data: { enrolledMachineId: null,
                resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {} } } });
            await db.machine.update({ where: { id: target.id }, data: { revokedAt: new Date(), active: false, installationId: crypto.randomUUID() } });
            for (const [machine, custodian] of [[child, sourceCustodian], [target, targetCustodian]] as const) await inTx(tx => removeMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: fixture.account.id } }));
            await auth.revokeApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId });
            const receiverToken = await auth.createToken(targetCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const verify = (workspaceSyncSourceWriterTargetRouting = routing, privateKey = parentKey.secretKey) => {
                const rpcAdmission = { context: transportAdmission, method, workspaceSyncSourceWriterTargetRouting };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: parent.id,
                    installationId: retainedTarget.parentInstallationId, accountId: targetCustodian.id, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${parent.id}/admission/verify`,
                    headers: { authorization: `Bearer ${receiverToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey }) } });
            };
            if (boundary === 'Home') {
                const verified = await verify();
                expect(verified.statusCode, verified.body).toBe(200);
                expect(verified.json()).toEqual({ v: 1, ok: true });
                expect((await verify(routing, writerKey.secretKey)).statusCode).toBe(403);
                expect((await verify({ ...routing, sourceWriter: { machineId: stranger.id, installationId: stranger.installationId! } })).statusCode).toBe(403);
                const rpcAdmission = { context: transportAdmission, method, workspaceSyncSourceWriterTargetRouting: routing };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: parent.id,
                    installationId: retainedTarget.parentInstallationId, accountId: targetCustodian.id, rpcAdmission });
                const malformed = await app.inject({ method: 'POST', url: `/v1/machines/${parent.id}/admission/verify`,
                    headers: { authorization: `Bearer ${receiverToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, workspaceSyncSourceWriterTargetRouting: { ...routing,
                        source: { ...routing.source, sourceMachineId: stranger.id } },
                        proof: signMachineInstallationProof({ payload, privateKey: parentKey.secretKey }) } });
                expect(malformed.statusCode).toBe(400);
                return;
            }
            const writerToken = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const makeSocket = (machine: typeof writer, id: string) => Object.assign(createFakeSocket({ id, data: {
                clientType: 'machine-scoped', machineId: machine.id, verifiedMachineInstallationId: machine.installationId,
                authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token: writerToken } } });
            const socket = makeSocket(writer, 'current-source-writer-release');
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            const call = (selectedSocket = socket, workspaceSyncSourceWriterTargetRouting = routing) => getSocketHandler(selectedSocket, SOCKET_RPC_EVENTS.CALL)({
                method, params: 'sealed-retained-target-release', workspaceSyncSourceWriterTargetRouting }, callback);
            await call();
            expect(callback).toHaveBeenCalledWith({ ok: true, result: 'sealed-release-delivery-response' });
            expect(delivered.mock.calls[0]?.[1]).toMatchObject({ machineAdmission: transportAdmission,
                callerAuthority: 'present_user', workspaceSyncSourceWriterTargetRouting: routing });
            expect(delivered.mock.calls[0]?.[1]).not.toHaveProperty('callerInputAuthorization');
            expect(delivered.mock.calls[0]?.[1]).not.toHaveProperty('workspaceSyncTargetRouting');
            const strangerSocket = makeSocket(stranger, 'wrong-source-writer-release');
            qualifyCurrentAccountStoredContentSocket(strangerSocket);
            registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: strangerSocket as unknown as Socket, io, sessionPublisherPresence: presence });
            callback.mockClear();
            await call(strangerSocket);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call(socket, { ...routing, source: { ...routing.source, sourceMachineId: stranger.id } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            socket.data!.clientType = 'user-scoped';
            callback.mockClear();
            await call();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(delivered).toHaveBeenCalledTimes(1);
        } finally { await app.close(); }
    });

    it('verifies an ordinary HOST source writer handoff root and discovers only its chosen TARGET installation', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'allowed-model' }],
            permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'ordinary-source-writer',
            grant: { ...API_TOKEN_FULL_GRANT_V1, ...callerInputConstraints } });
        const sourceCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const sourceKey = tweetnacl.sign.keyPair();
        const targetKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createMachine = (accountId: string, key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId, active: true, metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const source = await createMachine(sourceCustodian.id, sourceKey);
        const target = await createMachine(targetCustodian.id, targetKey);
        const targetParent = await createMachine(targetCustodian.id, parentKey);
        for (const [machine, custodian] of [[source, sourceCustodian], [target, targetCustodian]] as const) await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const sourceAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: source.id, requiredRole: 'use' });
        const targetAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: target.id, requiredRole: 'use' });
        if (sourceAdmission.kind !== 'admitted' || targetAdmission.kind !== 'admitted') throw new Error('Current ordinary SOURCE and shared TARGET required');
        const { kind: _sourceKind, ...sourceContextAdmission } = sourceAdmission;
        const { kind: _targetKind, ...targetContextAdmission } = targetAdmission;
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: targetParent.id })).toMatchObject({ kind: 'denied' });
        const homeId = await getOrCreateServerIdentityId();
        // Only TARGET is a managed child. An ordinary SOURCE must not need a
        // fabricated enrollment/native observation to prove its own writer.
        await db.managedMachine.create({ data: { homeId, custodianAccountId: targetCustodian.id,
            controllerMachineId: targetParent.id, controllerInstallationId: targetParent.installationId!, enrolledMachineId: target.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'HOST handoff target', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: target.id, user: 'coder', workspaceFolder: '/child/target',
                    storage: { kind: 'bind', hostPath: '/parent/target', childPath: '/child/target' } } },
        } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: source.id, sessionId: session.id, data: 'ordinary-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher, binding: { accountId: fixture.account.id, machineId: source.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ type: 'not_required' }));
        const receiver = { id: 'ordinary-source-chosen-target', data: { clientType: 'machine-scoped', machineId: target.id,
            verifiedMachineInstallationId: target.installationId }, timeout: () => ({ emitWithAck: effect }) };
        qualifyCurrentAccountStoredContentSocket(receiver);
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher]
            : room === `rpc:${targetCustodian.id}:${method}` || room === receiver.id ? [receiver] : []);
        const { app } = await createApp(fixture.team.id, false, input => resolveCurrentSessionMachineFromServer({ io, presence, ...input }));
        try {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: source.id },
                handoffAdmission: { sessionId: session.id, sourceMachineId: source.id, targetMachineId: target.id },
                input: { sessionId: session.id, targetMachineId: target.id, targetPath: '/child/target', accountServerId: homeId, workspaceAction: createFixtureCopyOnceWorkspaceAction() } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: source.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: root.binding.requestId, accountServerId: homeId,
                sourceMachineId: source.id, sourceSessionId: session.id, sourceRootPath: '/source',
                sourceContext: { machineAdmission: sourceContextAdmission, callerAuthority: 'account_automation', callerInputConstraints } });
            const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1, source: sourceRouting, sourceWriter: { machineId: source.id, installationId: source.installationId! },
                target: { v: 1 as const, phase: 'preflight' as const, operationId: crypto.randomUUID(), accountServerId: homeId,
                    targetMachineId: target.id, targetRootPath: '/child/target' } });
            const token = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const verify = (workspaceSyncSourceWriterTargetRouting = routing, callerInputAuthorization = root) => {
                const rpcAdmission = { context: sourceContextAdmission, method, workspaceSyncSourceWriterTargetRouting, callerInputAuthorization };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: source.id, installationId: source.installationId!,
                    accountId: sourceCustodian.id, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${source.id}/admission/verify`,
                    headers: { authorization: `Bearer ${token}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey: sourceKey.secretKey }) } });
            };
            const verified = await verify();
            expect(verified.statusCode, verified.body).toBe(200);
            expect(verified.json()).toEqual({ v: 1, ok: true, destinationInstallation: { machineId: target.id,
                installationId: target.installationId, installationPublicKey: Buffer.from(targetKey.publicKey).toString('base64url') } });
            expect((await verify({ ...routing, sourceWriter: { machineId: fixture.machine.id, installationId: fixture.machine.installationId! } })).statusCode).toBe(403);
            expect((await verify({ ...routing, target: { ...routing.target, phase: 'prepare' } })).statusCode).toBe(403);
            expect((await verify(routing, { ...root, token: 'forged-root' })).statusCode).toBe(403);
            const params = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, serverId: homeId, machineId: target.id,
                targetPath: routing.target.targetRootPath, operationId: routing.target.operationId });
            const execution = { v: 1 as const, authorization: root, effectActionId: 'session.handoff', target: root.binding.target,
                installationId: source.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
                    effectActionId: 'session.handoff', target: root.binding.target, installationId: source.installationId!, event: SOCKET_RPC_EVENTS.CALL,
                    method, requestId: root.binding.requestId, params, workspaceSyncSourceWriterTargetRouting: routing, privateKey: sourceKey.secretKey }) };
            const socket = Object.assign(createFakeSocket({ id: 'ordinary-source-writer', data: { clientType: 'machine-scoped', machineId: source.id,
                verifiedMachineInstallationId: source.installationId, authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token } } });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: root.binding.requestId, params,
                externalActionExecution: execution, workspaceSyncSourceWriterTargetRouting: routing }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { type: 'not_required' } });
            expect(effect.mock.calls[0]?.[1]).toMatchObject({ machineAdmission: targetContextAdmission,
                callerAuthority: 'account_automation', callerInputConstraints, workspaceSyncSourceWriterTargetRouting: routing });
        } finally { await app.close(); }
    });

    it.each(['full', 'scoped'] as const)('relays the %s original shared-child handoff root from its physical SOURCE writer to the chosen TARGET', async scope => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null,
            modelId: 'allowed-model' }], permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'source-writer-target',
            grant: { ...API_TOKEN_FULL_GRANT_V1,
                ...(scope === 'scoped' ? { actions: { families: [], ids: ['session.handoff'] } } : {}), ...callerInputConstraints } });
        const sourceCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetCustodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const writerKey = tweetnacl.sign.keyPair();
        const targetKey = tweetnacl.sign.keyPair();
        const targetParentKey = tweetnacl.sign.keyPair();
        const createMachine = (accountId: string, key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId, active: true, metadata: fixture.machine.metadata,
            dataEncryptionKey: fixture.machine.dataEncryptionKey, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(sourceCustodian.id, childKey);
        const writer = await createMachine(sourceCustodian.id, writerKey);
        const chosenTarget = await createMachine(targetCustodian.id, targetKey);
        const targetParent = await createMachine(targetCustodian.id, targetParentKey);
        for (const [machine, custodian] of [[child, sourceCustodian], [chosenTarget, targetCustodian]] as const) {
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        }
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: writer.id })).toMatchObject({ kind: 'denied' });
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: targetParent.id })).toMatchObject({ kind: 'denied' });
        const sourceAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        const targetAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: chosenTarget.id, requiredRole: 'use' });
        expect(sourceAdmission).toMatchObject({ kind: 'admitted', role: 'use' });
        expect(targetAdmission).toMatchObject({ kind: 'admitted', role: 'use' });
        if (sourceAdmission.kind !== 'admitted' || targetAdmission.kind !== 'admitted') throw new Error('Current shared children required');
        const { kind: _sourceKind, ...originalSourceAdmission } = sourceAdmission;
        const { kind: _targetKind, ...originalTargetAdmission } = targetAdmission;
        const homeId = await getOrCreateServerIdentityId();
        const createChildRow = (machine: typeof child, controller: typeof writer, custodianAccountId: string, rootPath: string, hostPath: string) => db.managedMachine.create({ data: {
            homeId, custodianAccountId, controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, enrolledMachineId: machine.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
                name: 'Handoff child', choices: {} }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: machine.id, user: 'coder', workspaceFolder: rootPath,
                    storage: { kind: 'bind', hostPath, childPath: rootPath } } },
        } });
        const sourceRow = await createChildRow(child, writer, sourceCustodian.id, '/child/source', '/parent/source');
        const targetRow = await createChildRow(chosenTarget, targetParent, targetCustodian.id, '/child/target', '/parent/target');
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id, data: 'source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const sourceMethod = `${writer.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
        const targetMethod = `${chosenTarget.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
        const physicalTargetMethod = `${targetParent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
        const sourceEffect = vi.fn(async (_event: string, _request: unknown) => ({ prepared: true }));
        const targetEffect = vi.fn(async (_event: string, _request: unknown) => ({ type: 'not_required' }));
        const physicalTargetEffect = vi.fn(async (_event: string, _request: unknown) => ({ type: 'not_required' }));
        const physicalReceiver = { id: 'physical-source-receiver', data: { clientType: 'machine-scoped', machineId: writer.id,
            verifiedMachineInstallationId: writer.installationId }, timeout: () => ({ emitWithAck: sourceEffect }) };
        const targetReceiver = { id: 'chosen-target-receiver', data: { clientType: 'machine-scoped', machineId: chosenTarget.id,
            verifiedMachineInstallationId: chosenTarget.installationId }, timeout: () => ({ emitWithAck: targetEffect }) };
        const physicalTargetReceiver = { id: 'physical-target-receiver', data: { clientType: 'machine-scoped', machineId: targetParent.id,
            verifiedMachineInstallationId: targetParent.installationId }, timeout: () => ({ emitWithAck: physicalTargetEffect }) };
        qualifyCurrentAccountStoredContentSocket(physicalReceiver);
        qualifyCurrentAccountStoredContentSocket(targetReceiver);
        qualifyCurrentAccountStoredContentSocket(physicalTargetReceiver);
        // Network discovery/delivery alone are simulated; both RPC ingress paths,
        // Home-issued root, canonical child relations, C41 and signatures are real.
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id)
            ? [publisher] : room === `rpc:${sourceCustodian.id}:${sourceMethod}` || room === physicalReceiver.id ? [physicalReceiver]
                : room === `rpc:${targetCustodian.id}:${targetMethod}` || room === targetReceiver.id ? [targetReceiver]
                    : room === `rpc:${targetCustodian.id}:${physicalTargetMethod}` || room === physicalTargetReceiver.id ? [physicalTargetReceiver] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        try {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: child.id },
                handoffAdmission: { sessionId: session.id, sourceMachineId: child.id, targetMachineId: chosenTarget.id },
                input: { sessionId: session.id, targetMachineId: chosenTarget.id, targetPath: '/child/target', accountServerId: homeId,
                    workspaceAction: createFixtureCopyOnceWorkspaceAction() } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: child.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({ machineAdmission: originalSourceAdmission,
                callerAuthority: 'account_automation', callerInputConstraints });
            const sourceRouting = { ...WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: root.binding.requestId,
                accountServerId: homeId, sourceMachineId: child.id, sourceSessionId: session.id, sourceRootPath: '/child/source' }), sourceContext };
            const custodianToken = await auth.createToken(sourceCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const createInstalledSocket = (machine: typeof child, id: string) => Object.assign(createFakeSocket({ id,
                data: { clientType: 'machine-scoped', machineId: machine.id, verifiedMachineInstallationId: machine.installationId,
                    authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token: custodianToken } } });
            const childSocket = createInstalledSocket(child, 'original-child-sender');
            qualifyCurrentAccountStoredContentSocket(childSocket);
            registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: childSocket as unknown as Socket, io, sessionPublisherPresence: presence });
            const sourceParams = 'sealed-source-prepare';
            const sourceExecution = { v: 1 as const, authorization: root, effectActionId: 'session.handoff', target: root.binding.target,
                installationId: child.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
                    effectActionId: 'session.handoff', target: root.binding.target, installationId: child.installationId!, event: SOCKET_RPC_EVENTS.CALL,
                    method: sourceMethod, requestId: root.binding.requestId, params: sourceParams, privateKey: childKey.secretKey }) };
            const sourceAck = vi.fn();
            await getSocketHandler(childSocket, SOCKET_RPC_EVENTS.CALL)({ method: sourceMethod, requestId: root.binding.requestId,
                params: sourceParams, externalActionExecution: sourceExecution, workspaceSyncSourceRouting: sourceRouting }, sourceAck);
            expect(sourceAck).toHaveBeenCalledWith({ ok: true, result: { prepared: true } });
            const sourceRequest = sourceEffect.mock.calls[0]?.[1];
            expect(sourceRequest).toMatchObject({ callerInputAuthorization: root, workspaceSyncSourceRouting: sourceRouting });
            if (!sourceRequest || typeof sourceRequest !== 'object') throw new Error('Actual physical SOURCE ingress required');
            const retainedRoot = ExternalActionExecutionAuthorizationV1Schema.parse(Reflect.get(sourceRequest, 'callerInputAuthorization'));
            const parsedSource = WorkspaceSyncSourceRoutingV1Schema.parse(Reflect.get(sourceRequest, 'workspaceSyncSourceRouting'));
            const retainedSource = { ...parsedSource, sourceContext: WorkspaceSyncSourceContextV1Schema.parse(parsedSource.sourceContext) };
            const target = { v: 1 as const, phase: 'preflight' as const, operationId: crypto.randomUUID(), accountServerId: homeId,
                targetMachineId: chosenTarget.id, targetRootPath: '/child/target' };
            const workspaceSyncSourceWriterTargetRouting = { v: 1 as const, source: retainedSource, target,
                sourceWriter: { machineId: writer.id, installationId: writer.installationId! } };
            const targetParams = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, serverId: homeId, machineId: chosenTarget.id,
                operationId: target.operationId, targetPath: target.targetRootPath });
            const request = { authorizationToken: retainedRoot.token, effectActionId: 'session.handoff', target: retainedRoot.binding.target,
                installationId: writer.installationId!, event: SOCKET_RPC_EVENTS.CALL, method: targetMethod,
                requestId: retainedRoot.binding.requestId, params: targetParams, workspaceSyncSourceWriterTargetRouting };
            const execution = { v: 1 as const, authorization: retainedRoot, effectActionId: 'session.handoff', target: retainedRoot.binding.target,
                installationId: writer.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ ...request, privateKey: writerKey.secretKey }) };
            const writerSocket = createInstalledSocket(writer, 'actual-source-writer');
            qualifyCurrentAccountStoredContentSocket(writerSocket);
            registerSocketRpcHandlers({ userId: sourceCustodian.id, socket: writerSocket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            const call = (routing: unknown = workspaceSyncSourceWriterTargetRouting, carrier: unknown = execution) => getSocketHandler(writerSocket, SOCKET_RPC_EVENTS.CALL)({
                method: targetMethod, requestId: retainedRoot.binding.requestId, params: targetParams,
                externalActionExecution: carrier, workspaceSyncSourceWriterTargetRouting: routing }, callback);
            await call();
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { type: 'not_required' } });
            expect(targetEffect.mock.calls[0]?.[1]).toMatchObject({ machineAdmission: originalTargetAdmission,
                callerAuthority: 'account_automation', callerInputConstraints, workspaceSyncSourceWriterTargetRouting });
            expect(targetEffect.mock.calls[0]?.[1]).not.toHaveProperty('sessionActionOrigin');
            // The chosen D, not P2 and not the retained P1 source writer, owns
            // the second-hop sender key. Home independently derives the exact
            // physical receiver from the unchanged root and joint routing.
            const targetCustodianToken = await auth.createToken(targetCustodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const jointTargetRouting = { ...target, targetContext: { ...sourceContext, machineAdmission: originalTargetAdmission } };
            const verifyTargetSender = (routing = workspaceSyncSourceWriterTargetRouting, targetRouting = jointTargetRouting,
                privateKey = targetKey.secretKey, selectedMethod = physicalTargetMethod) => {
                const rpcAdmission = { context: originalTargetAdmission, method: selectedMethod,
                    workspaceSyncSourceWriterTargetRouting: routing, workspaceSyncTargetRouting: targetRouting,
                    callerInputAuthorization: retainedRoot };
                const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: chosenTarget.id,
                    installationId: chosenTarget.installationId!, accountId: targetCustodian.id, rpcAdmission });
                return app.inject({ method: 'POST', url: `/v1/machines/${chosenTarget.id}/admission/verify`,
                    headers: { authorization: `Bearer ${targetCustodianToken}`, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { v: 1, ...rpcAdmission, proof: signMachineInstallationProof({ payload, privateKey }) } });
            };
            const targetSenderVerified = await verifyTargetSender();
            expect(targetSenderVerified.statusCode, targetSenderVerified.body).toBe(200);
            expect(targetSenderVerified.json()).toEqual({ v: 1, ok: true, destinationInstallation: { machineId: targetParent.id,
                installationId: targetParent.installationId, installationPublicKey: Buffer.from(targetParentKey.publicKey).toString('base64url') } });
            expect((await verifyTargetSender(workspaceSyncSourceWriterTargetRouting, jointTargetRouting, writerKey.secretKey)).statusCode).toBe(403);
            expect((await verifyTargetSender({ ...workspaceSyncSourceWriterTargetRouting,
                target: { ...target, operationId: 'different-target-loan' } })).statusCode).toBe(403);
            expect((await verifyTargetSender(workspaceSyncSourceWriterTargetRouting, jointTargetRouting, targetKey.secretKey,
                `${writer.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`)).statusCode).toBe(403);
            // Independent Socket boundary input: the current public box primitive
            // seals the unchanged Target request to P2's installed key. This
            // exercises opaque signed ingress, not the CLI encoder or loan owner.
            const sealedTargetParams = JSON.stringify({ v: 1, kind: 'workspace_sync_target_request_v1', machineId: targetParent.id,
                installationId: targetParent.installationId, ciphertext: Buffer.from(sealBoxBundle({
                    recipientPublicKey: deriveBoxPublicKeyFromEd25519PublicKey(targetParentKey.publicKey), randomBytes: tweetnacl.randomBytes,
                    plaintext: new TextEncoder().encode(JSON.stringify({ v: 1, kind: 'workspace_sync_target_request_v1',
                        machineId: targetParent.id, installationId: targetParent.installationId, method: physicalTargetMethod,
                        routing: workspaceSyncSourceWriterTargetRouting,
                        replyPublicKey: Buffer.from(deriveBoxPublicKeyFromSeed(tweetnacl.randomBytes(32))).toString('base64url'), rpc: targetParams })),
                })).toString('base64url') });
            const jointRequest = { ...request, method: physicalTargetMethod, installationId: chosenTarget.installationId!,
                requestId: crypto.randomUUID(), params: sealedTargetParams };
            const jointExecution = { ...execution, installationId: chosenTarget.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...jointRequest, privateKey: targetKey.secretKey }) };
            expect(await verifyExternalActionMachineRpcExecution(jointExecution, { method: physicalTargetMethod,
                requestId: jointRequest.requestId, params: sealedTargetParams, workspaceSyncSourceWriterTargetRouting,
                workspaceSyncTargetRouting: jointTargetRouting, resolveCurrentSessionMachine: resolvePublisher })).toMatchObject({
                binding: retainedRoot.binding, principal: { accountId: fixture.account.id, authority: 'account_automation' },
            });
            const chosenTargetSocket = Object.assign(createFakeSocket({ id: 'actual-chosen-target-second-hop', data: {
                clientType: 'machine-scoped', machineId: chosenTarget.id, verifiedMachineInstallationId: chosenTarget.installationId,
                authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token: targetCustodianToken } } });
            qualifyCurrentAccountStoredContentSocket(chosenTargetSocket);
            registerSocketRpcHandlers({ userId: targetCustodian.id, socket: chosenTargetSocket as unknown as Socket,
                io, sessionPublisherPresence: presence });
            const jointCallback = vi.fn();
            const callJointTarget = (targetRouting: unknown = jointTargetRouting, carrier: unknown = jointExecution,
                routing: unknown = workspaceSyncSourceWriterTargetRouting) => getSocketHandler(chosenTargetSocket, SOCKET_RPC_EVENTS.CALL)({
                    method: physicalTargetMethod, requestId: jointRequest.requestId, params: sealedTargetParams,
                    externalActionExecution: carrier, workspaceSyncSourceWriterTargetRouting: routing,
                    ...(targetRouting === null ? {} : { workspaceSyncTargetRouting: targetRouting }) }, jointCallback);
            await callJointTarget();
            expect(jointCallback).toHaveBeenCalledWith({ ok: true, result: { type: 'not_required' } });
            expect(physicalTargetEffect.mock.calls[0]?.[1]).toMatchObject({ params: sealedTargetParams,
                machineAdmission: originalTargetAdmission, callerAuthority: 'account_automation', callerInputConstraints,
                callerInputAuthorization: retainedRoot, workspaceSyncSourceWriterTargetRouting, workspaceSyncTargetRouting: jointTargetRouting });
            for (const privateKey of [writerKey.secretKey, targetParentKey.secretKey]) {
                jointCallback.mockClear();
                await callJointTarget(jointTargetRouting, { ...jointExecution,
                    machineSignature: signExternalActionMachineRpcRequestV1({ ...jointRequest, privateKey }) });
                expect(jointCallback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            }
            for (const alteredTarget of [null, { ...jointTargetRouting, operationId: 'different-target-operation' },
                { ...jointTargetRouting, targetRootPath: '/child/unreviewed-target' },
                { ...jointTargetRouting, targetContext: { ...jointTargetRouting.targetContext, callerAuthority: 'present_user' } },
                { ...jointTargetRouting, targetContext: { ...jointTargetRouting.targetContext,
                    machineAdmission: { ...originalTargetAdmission, actorAccountId: targetCustodian.id } } }]) {
                jointCallback.mockClear();
                await callJointTarget(alteredTarget);
                expect(jointCallback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            }
            chosenTargetSocket.data!.clientType = 'user-scoped';
            jointCallback.mockClear();
            await callJointTarget();
            expect(jointCallback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            chosenTargetSocket.data!.clientType = 'machine-scoped';
            await db.managedMachine.update({ where: { id: targetRow.id }, data: { controllerInstallationId: crypto.randomUUID() } });
            jointCallback.mockClear();
            await callJointTarget();
            expect(jointCallback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            await db.managedMachine.update({ where: { id: targetRow.id }, data: { controllerInstallationId: targetParent.installationId! } });
            expect(physicalTargetEffect).toHaveBeenCalledTimes(1);
            callback.mockClear();
            await call({ ...workspaceSyncSourceWriterTargetRouting, target: { ...target, operationId: 'substituted-target-operation' } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            // A valid P1 signature does not authorize a different native bind root:
            // Home must still derive both endpoints from the unchanged handoff tuple.
            for (const routing of [
                { ...workspaceSyncSourceWriterTargetRouting, source: { ...retainedSource, sourceRootPath: '/child/other-source' } },
                { ...workspaceSyncSourceWriterTargetRouting, target: { ...target, targetRootPath: '/child/other-target' } },
            ]) {
                callback.mockClear();
                await call(routing, { ...execution, machineSignature: signExternalActionMachineRpcRequestV1({
                    ...request, workspaceSyncSourceWriterTargetRouting: routing, privateKey: writerKey.secretKey,
                }) });
                expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            }
            callback.mockClear();
            await call(workspaceSyncSourceWriterTargetRouting, { ...execution,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...request, privateKey: childKey.secretKey }) });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            writerSocket.data!.clientType = 'user-scoped';
            callback.mockClear();
            await call();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            writerSocket.data!.clientType = 'machine-scoped';
            await db.managedMachine.update({ where: { id: sourceRow.id }, data: { controllerInstallationId: crypto.randomUUID() } });
            callback.mockClear();
            await call();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(targetEffect).toHaveBeenCalledTimes(1);
            expect(sourceEffect).toHaveBeenCalledTimes(1);
        } finally { await app.close(); }
    });

    it.each(['full', 'scoped'] as const)('relays a genuine Home-minted %s PAT continuation to a shared TARGET without parent authority', async scope => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null,
            modelId: 'allowed-model' }], permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'shared-target',
            grant: { ...API_TOKEN_FULL_GRANT_V1,
                ...(scope === 'scoped' ? { actions: { families: [], ids: ['session.handoff'] } } : {}), ...callerInputConstraints } });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createCustodianMachine = (key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, active: true,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createCustodianMachine(targetKey);
        const parent = await createCustodianMachine(parentKey);
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: child.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        expect(await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const admitted = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        expect(admitted).toMatchObject({ kind: 'admitted', role: 'use' });
        if (admitted.kind !== 'admitted') throw new Error('Real shared TARGET admission required');
        const { kind: _kind, ...machineAdmission } = admitted;
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'original-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${child.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ type: 'not_required' }));
        const target = { id: 'shared-target-daemon', data: { clientType: 'machine-scoped', machineId: child.id,
            verifiedMachineInstallationId: child.installationId }, timeout: () => ({ emitWithAck: effect }) };
        qualifyCurrentAccountStoredContentSocket(target);
        // Only Socket.IO discovery/delivery are simulated. Home issuance, tuple,
        // requester grants, original source signatures and RPC admission remain real.
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id)
            ? [publisher] : room === `rpc:${custodian.id}:${method}` || room === target.id ? [target] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        try {
            const homeId = await getOrCreateServerIdentityId();
            await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
                controllerMachineId: parent.id, controllerInstallationId: parent.installationId!, enrolledMachineId: child.id,
                admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
                launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
                    name: 'Shared TARGET child', choices: {} }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                    devcontainerObservation: { nativeResourceId: 'shared-target-container', user: 'coder', workspaceFolder: '/child/target',
                        storage: { kind: 'bind', hostPath: '/parent/target', childPath: '/child/target' } } },
            } });
            const handoffAdmission = { sessionId: session.id, sourceMachineId: fixture.machine.id, targetMachineId: child.id };
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: fixture.machine.id }, handoffAdmission,
                input: { sessionId: session.id, targetMachineId: child.id, targetPath: '/child/target', accountServerId: homeId,
                    workspaceAction: createFixtureCopyOnceWorkspaceAction() } });
            const rootResponse = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            const handoffId = 'shared-target-handoff';
            const path = bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff.prepare_target');
            const accountToken = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const privatePrepare = SessionRequesterHandoffBootstrapRpcRequestV1Schema.parse({
                kind: 'requester_session_handoff_bootstrap_v1',
                input: { ...handoffAdmission, handoffId, targetPath: '/child/target',
                    negotiatedTransportStrategy: 'server_routed_stream', sourceSessionStorageMode: 'persisted', endpointCandidates: [] },
                requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: accountToken } },
            });
            const body = { v: 1, machineId: child.id, envelope: { v: 1, requestId: root.binding.requestId,
                target: { kind: 'machine', machineId: child.id }, handoffAdmission, input: privatePrepare },
                handoffContinuation: { authorization: root, handoffId } };
            const issue = (payload: unknown = body) => app.inject({ method: 'POST', url: path, payload,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'session.handoff', target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path, body: payload, privateKey: fixture.keyPair.secretKey }) } });
            const continuationResponse = await issue();
            expect(continuationResponse.statusCode, continuationResponse.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(continuationResponse.json());
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                accountId: fixture.account.id, credentialId: pat.tokenId, authority: 'account_automation' });
            expect(authorization.binding).toMatchObject({ machineId: child.id, installationId: child.installationId,
                custodianAccountId: custodian.id, handoffContinuation: { handoffId } });
            const params = HandoffTargetReplacementPreflightV1Schema.parse({ v: 1, serverId: homeId, machineId: child.id,
                operationId: handoffId, targetPath: '/child/target' });
            const execution = { v: 1 as const, authorization, effectActionId: 'session.handoff.prepare_target',
                target: authorization.binding.target, installationId: authorization.binding.installationId,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'session.handoff.prepare_target', target: authorization.binding.target,
                    installationId: authorization.binding.installationId, event: SOCKET_RPC_EVENTS.CALL,
                    method, requestId: authorization.binding.requestId, params, privateKey: fixture.keyPair.secretKey }) };
            const socket = Object.assign(createFakeSocket({ id: 'original-requester', data: { clientType: 'user-scoped',
                authTokenKind: 'account', authAuthority: 'present_user' } }), { handshake: { auth: { token: accountToken } } });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: fixture.account.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            const call = (carrier: unknown = execution, selectedMethod = method) => getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({
                method: selectedMethod, requestId: authorization.binding.requestId, params, externalActionExecution: carrier }, callback);
            await call();
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { type: 'not_required' } });
            expect(effect.mock.calls[0]?.[1]).toMatchObject({ machineAdmission, callerAuthority: 'account_automation', callerInputConstraints });
            expect(effect.mock.calls[0]?.[1]).not.toHaveProperty('sessionActionOrigin');
            callback.mockClear();
            await call({ ...execution, machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                effectActionId: 'session.handoff.prepare_target', target: authorization.binding.target,
                installationId: authorization.binding.installationId, event: SOCKET_RPC_EVENTS.CALL, method,
                requestId: authorization.binding.requestId, params, privateKey: targetKey.secretKey }) });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call({ ...execution, target: { kind: 'machine', machineId: parent.id } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            if (!('grant' in authorization.binding)) throw new Error('Genuine PAT continuation grant required');
            callback.mockClear();
            await call({ ...execution, authorization: { ...authorization, binding: { ...authorization.binding,
                grant: { ...authorization.binding.grant, models: null, permissionModes: null } } } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect((await issue({ ...body, envelope: { ...body.envelope, handoffAdmission: {
                ...handoffAdmission, sourceMachineId: parent.id } } })).statusCode).toBe(401);
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: child.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            callback.mockClear();
            await call();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).toHaveBeenCalledTimes(1);
        } finally { await app.close(); }
    });

    it.each(['full', 'scoped'] as const)('relays a genuine Home-minted %s PAT handoff SOURCE carrier without widening original child authority', async scope => {
        const fixture = await createFixture({ qualifiedPat: false });
        const callerInputConstraints = { models: [{ agentTargetKey: 'agent:codex', providerConnectionId: null,
            modelId: 'allowed-model' }], permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'source-scoped',
            grant: { ...API_TOKEN_FULL_GRANT_V1,
                ...(scope === 'scoped' ? { actions: { families: [], ids: ['session.handoff'] } } : {}), ...callerInputConstraints } });
        const custodian = fixture.account;
        const otherActor = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const childKey = tweetnacl.sign.keyPair();
        const parentKey = tweetnacl.sign.keyPair();
        const createMachine = (key: ReturnType<typeof tweetnacl.sign.keyPair>) => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, active: true,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey),
        } });
        const child = await createMachine(childKey);
        const parent = await createMachine(parentKey);
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: child.id,
            principal: { kind: 'account', accountId: otherActor.id }, level: 'view' }));
        expect(await resolveMachineAdmission({ actorAccountId: otherActor.id, machineId: parent.id })).toMatchObject({ kind: 'denied' });
        const admitted = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: child.id, requiredRole: 'use' });
        expect(admitted).toMatchObject({ kind: 'admitted' });
        if (admitted.kind !== 'admitted') throw new Error('Genuine current child admission required');
        const { kind: _kind, ...currentAdmission } = admitted;
        const machineAdmission = { ...currentAdmission, role: 'use' as const };
        const homeId = await getOrCreateServerIdentityId();
        await db.managedMachine.create({ data: { homeId, custodianAccountId: custodian.id,
            controllerMachineId: parent.id, controllerInstallationId: parent.installationId!, enrolledMachineId: child.id,
            admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Signed source', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {},
                devcontainerObservation: { nativeResourceId: 'signed-source', user: 'coder', workspaceFolder: '/child/source',
                    storage: { kind: 'bind', hostPath: '/parent/source', childPath: '/child/source' } } },
        } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id, data: 'source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: child.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${parent.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ success: true }));
        const target = { id: 'signed-source-parent', data: { clientType: 'machine-scoped', machineId: parent.id,
            verifiedMachineInstallationId: parent.installationId }, timeout: () => ({ emitWithAck: effect }) };
        qualifyCurrentAccountStoredContentSocket(target);
        // Only Socket.IO discovery/delivery are simulated; Home mint, signatures, C41 and source binding are real.
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id)
            ? [publisher] : room === `rpc:${custodian.id}:${method}` || room === target.id ? [target] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        try {
            const input = { sessionId: session.id, targetMachineId: fixture.machine.id, targetPath: '/target', accountServerId: homeId,
                workspaceAction: createFixtureCopyOnceWorkspaceAction() };
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: child.id }, input,
                handoffAdmission: { sessionId: session.id, sourceMachineId: child.id, targetMachineId: fixture.machine.id } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${pat.token}` }, payload: { v: 1, machineId: child.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            if (!('grant' in authorization.binding)) throw new Error('Original scoped PAT grant required');
            const params = 'sealed-original-source-phase';
            const requestId = authorization.binding.requestId;
            const sign = (privateKey: Uint8Array, signedParams: unknown = params) => signExternalActionMachineRpcRequestV1({
                authorizationToken: authorization.token, effectActionId: 'session.handoff', target: authorization.binding.target,
                installationId: child.installationId!, event: SOCKET_RPC_EVENTS.CALL, method, requestId, params: signedParams, privateKey });
            const execution = { v: 1 as const, authorization, effectActionId: 'session.handoff', target: authorization.binding.target,
                installationId: child.installationId!, machineSignature: sign(childKey.secretKey) };
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params,
                resolveCurrentSessionMachine: resolvePublisher })).toMatchObject({ principal: { accountId: fixture.account.id,
                credentialId: pat.tokenId, authority: 'account_automation' }, binding: { machineId: child.id } });
            expect(await verifyExternalActionMachineRpcExecution({ ...execution, machineSignature: sign(parentKey.secretKey) },
                { method, requestId, params, resolveCurrentSessionMachine: resolvePublisher })).toBeNull();
            const childAction = 'session.handoff.status.get';
            const childPath = bindExternalActionExecutionAuthorizationHttpPathV1(childAction);
            const childBody = { v: 1, machineId: fixture.machine.id, envelope: { v: 1, requestId,
                target: { kind: 'machine', machineId: fixture.machine.id }, input: { handoffId: 'scoped-pat-handoff' },
                handoffAdmission: envelope.handoffAdmission },
                handoffContinuation: { authorization, handoffId: 'scoped-pat-handoff' } };
            const childResponse = await app.inject({ method: 'POST', url: childPath, payload: childBody,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'session.handoff', target: authorization.binding.target, installationId: child.installationId!,
                        requestId, method: 'POST', path: childPath, body: childBody, privateKey: childKey.secretKey }) } });
            expect(childResponse.statusCode, childResponse.body).toBe(200);
            const childAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(childResponse.json());
            expect(childAuthorization.binding).toMatchObject({ grant: authorization.binding.grant,
                handoffContinuation: { handoffId: 'scoped-pat-handoff' } });
            expect(await verifyCurrentExternalActionPrincipal(childAuthorization.binding)).toMatchObject({
                accountId: fixture.account.id, credentialId: pat.tokenId, grant: authorization.binding.grant });
            const preparePath = bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff.prepare_target');
            const requesterToken = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const privatePrepare = { kind: 'requester_session_handoff_bootstrap_v1',
                input: { ...envelope.handoffAdmission, handoffId: 'scoped-pat-handoff', targetPath: '/target',
                    negotiatedTransportStrategy: 'server_routed_stream', sourceSessionStorageMode: 'persisted', endpointCandidates: [] },
                requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: requesterToken } } };
            const parsedPrepare = SessionRequesterHandoffBootstrapRpcRequestV1Schema.safeParse(privatePrepare);
            expect(parsedPrepare.success, parsedPrepare.success ? undefined : parsedPrepare.error.message).toBe(true);
            const prepareBody = { ...childBody, envelope: { ...childBody.envelope, input: privatePrepare } };
            const issuePrepare = (payload: unknown = prepareBody) => app.inject({ method: 'POST', url: preparePath, payload,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'session.handoff', target: authorization.binding.target, installationId: child.installationId!,
                        requestId, method: 'POST', path: preparePath, body: payload, privateKey: childKey.secretKey }) } });
            const prepared = await issuePrepare();
            expect(prepared.statusCode, prepared.body).toBe(200);
            const preparedAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(prepared.json());
            expect(preparedAuthorization.binding).toMatchObject({
                actionId: 'session.handoff.prepare_target', grant: authorization.binding.grant });
            const prepareMethod = `${fixture.machine.id}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3}`;
            const prepareRpc = (privateKey: Uint8Array) => ({ v: 1 as const, authorization: preparedAuthorization,
                effectActionId: 'session.handoff.prepare_target', target: preparedAuthorization.binding.target,
                installationId: preparedAuthorization.binding.installationId,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: preparedAuthorization.token,
                    effectActionId: 'session.handoff.prepare_target', target: preparedAuthorization.binding.target,
                    installationId: preparedAuthorization.binding.installationId, event: SOCKET_RPC_EVENTS.CALL,
                    method: prepareMethod, requestId, params: privatePrepare, privateKey }) });
            expect(await verifyExternalActionMachineRpcExecution(prepareRpc(childKey.secretKey), {
                method: prepareMethod, requestId, params: privatePrepare, resolveCurrentSessionMachine: resolvePublisher })).toMatchObject({
                principal: { accountId: fixture.account.id, credentialId: pat.tokenId }, binding: { actionId: 'session.handoff.prepare_target' } });
            expect(await verifyExternalActionMachineRpcExecution(prepareRpc(fixture.keyPair.secretKey), {
                method: prepareMethod, requestId, params: privatePrepare, resolveCurrentSessionMachine: resolvePublisher })).toBeNull();
            const preparedVerifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('session.handoff.prepare_target');
            const verifyPrepared = (privateKey: Uint8Array) => app.inject({ method: 'POST', url: preparedVerifyPath, payload: { v: 1 }, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: preparedAuthorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff.prepare_target',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(preparedAuthorization.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: preparedAuthorization.token,
                    effectActionId: 'session.handoff.prepare_target', target: preparedAuthorization.binding.target,
                    installationId: preparedAuthorization.binding.installationId, requestId, method: 'POST',
                    path: preparedVerifyPath, body: { v: 1 }, privateKey }),
            } });
            expect((await verifyPrepared(childKey.secretKey)).statusCode).toBe(200);
            expect((await verifyPrepared(fixture.keyPair.secretKey)).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: preparePath, headers: { authorization: `Bearer ${pat.token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope: prepareBody.envelope } })).statusCode).toBe(401);
            expect((await issuePrepare({ ...prepareBody, envelope: { ...prepareBody.envelope, input: {
                ...privatePrepare, input: { ...privatePrepare.input, sessionId: 'unrelated-session' } } } })).statusCode).toBe(401);
            if (scope === 'full') {
            // The envelope keeps its entire protected-input budget; the original
            // proof is additional transport framing, not a cut from that input.
            const sealedEnvelope = { v: 2 as const, requestId, target: childBody.envelope.target,
                payload: { t: 'encrypted' as const, c: '' }, handoffAdmission: envelope.handoffAdmission };
            sealedEnvelope.payload.c = 'a'.repeat(EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2
                - Buffer.byteLength(JSON.stringify(sealedEnvelope), 'utf8'));
            const sealedBody = { ...childBody, envelope: sealedEnvelope };
            const sealedResponse = await app.inject({ method: 'POST', url: childPath, payload: sealedBody,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'session.handoff', target: authorization.binding.target, installationId: child.installationId!,
                        requestId, method: 'POST', path: childPath, body: sealedBody, privateKey: childKey.secretKey }) } });
            expect(sealedResponse.statusCode, sealedResponse.body).toBe(200);
            }
            const token = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
            const socket = Object.assign(createFakeSocket({ id: 'signed-child-source', data: { clientType: 'machine-scoped',
                machineId: child.id, verifiedMachineInstallationId: child.installationId, authTokenKind: 'account', authAuthority: 'present_user' } }),
            { handshake: { auth: { token } } });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: custodian.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const workspaceSyncSourceRouting = { v: 1, phase: 'prepare', operationId: crypto.randomUUID(), accountServerId: homeId,
                sourceMachineId: child.id, sourceRootPath: '/child/source', sourceSessionId: session.id,
                sourceContext: { machineAdmission, callerAuthority: 'account_automation',
                    callerInputConstraints } };
            await auth.updateApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId,
                grant: { ...API_TOKEN_FULL_GRANT_V1, ...callerInputConstraints } });
            const current = await verifyCurrentExternalActionPrincipal(authorization.binding);
            if (!current || 'authentication' in current) throw new Error('Current verified PAT facts required');
            const boundFacts = { ...current, grant: authorization.binding.grant };
            const admittedSource = await verifyWorkspaceSyncHandoffSourceAuthorization(authorization,
                WorkspaceSyncSourceRoutingV1Schema.parse({ ...workspaceSyncSourceRouting,
                    operationId: authorization.binding.requestId }), resolvePublisher);
            expect(admittedSource).not.toBeNull();
            expect(admittedSource?.principal).toEqual(boundFacts);
            expect(admittedSource).toMatchObject({ effectiveAuthority: 'account_automation' });
            expect((await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params,
                resolveCurrentSessionMachine: resolvePublisher }))?.principal).toEqual(boundFacts);
            const call = (callParams: unknown = params, sourceRouting: unknown = workspaceSyncSourceRouting) => getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId,
                params: callParams, externalActionExecution: execution, workspaceSyncSourceRouting: sourceRouting }, callback);
            const callback = vi.fn();
            await call();
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { success: true } });
            expect(effect.mock.calls[0]?.[1]).toMatchObject({ machineAdmission, callerAuthority: 'account_automation',
                workspaceSyncSourceRouting, callerInputConstraints, callerInputAuthorization: authorization });
            const unboundOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                sourceTurnId: 'unbound-turn', requestId, callerPermissionMode: 'default',
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } });
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                sessionActionOrigin: unboundOrigin } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).toHaveBeenCalledTimes(1);
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceMachineId: fixture.machine.id });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceSessionId: 'substituted-source-session' });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                machineAdmission: { ...machineAdmission, actorAccountId: otherActor.id } } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                callerAuthority: 'present_user' } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call(params, { ...workspaceSyncSourceRouting, sourceContext: { ...workspaceSyncSourceRouting.sourceContext,
                callerInputConstraints: { models: null, permissionModes: null } } });
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await call('substituted-source-phase');
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({
                method: `${parent.id}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3}`, requestId, params,
                externalActionExecution: execution, workspaceSyncSourceRouting }, callback);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).toHaveBeenCalledTimes(1);
            await auth.revokeApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId });
            callback.mockClear();
            await call();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            const releaseRouting = { ...workspaceSyncSourceRouting, phase: 'abort' };
            callback.mockClear();
            // Release uses the installed custodian's existing SOURCE attestation,
            // never the retired borrower bearer and never an unsigned fresh effect.
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, params: 'sealed-retained-source-abort',
                workspaceSyncSourceRouting: releaseRouting }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { success: true } });
            expect(effect.mock.calls[1]?.[1]).toMatchObject({ machineAdmission,
                workspaceSyncSourceRouting: releaseRouting, callerAuthority: 'account_automation', callerInputConstraints });
            expect(effect.mock.calls[1]?.[1]).not.toHaveProperty('callerInputAuthorization');
            expect(effect).toHaveBeenCalledTimes(2);
        } finally { await app.close(); }
    });

    it.each(['action.spec.get', 'action.spec.search'] as const)('admits original Account discovery without inventing a Session origin (%s)', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const input = actionId === 'action.spec.get'
            ? { id: 'session.message.send', includeOutputSchema: true }
            : { query: 'session.message.send' };
        const envelope = { ...fixture.envelope, input };
        const { app } = await createApp(fixture.team.id);
        try {
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(authorization.binding).toMatchObject({ accountId: fixture.account.id, actionId,
                machineId: fixture.machine.id, target: envelope.target, authentication: { kind: 'account' } });
            expect(authorization.binding).not.toHaveProperty('sessionActionOrigin');
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                accountId: fixture.account.id, authority: 'present_user' });
        } finally { await app.close(); }
    });

    it('admits an original Account catalog Machine Action only under its current named Manage policy', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const keys = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'admin' }));
        const actionId = 'machines.work.summary.get';
        const homeId = await getOrCreateServerIdentityId();
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target: { kind: 'machine' as const, machineId: machine.id },
            input: { serverId: homeId, machineId: machine.id } };
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const { app } = await createApp(fixture.team.id);
        const issue = () => app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: machine.id, envelope } });
        try {
            const issued = await issue();
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(root.binding).toMatchObject({ accountId: fixture.account.id, custodianAccountId: custodian.id,
                accountEncryptionMode: 'plain', actionId, machineId: machine.id, installationId: machine.installationId });
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const verify = () => app.inject({ method: 'POST', url: path, payload: { v: 1 }, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: actionId, target: root.binding.target, installationId: root.binding.installationId,
                    requestId: root.binding.requestId, method: 'POST', path, body: { v: 1 }, privateKey: keys.secretKey }),
            } });
            expect((await verify()).statusCode).toBe(200);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            expect((await verify()).statusCode).toBe(401);
            const denied = await issue();
            expect(denied.statusCode, denied.body).toBe(409);
            expect(denied.json()).toMatchObject({ error: 'invalid_request', code: 'target_unavailable' });
        } finally { await app.close(); }
    });

    it('prepares an installed Session ordinary Action with encrypted inherited spawn choices without decision authority', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
        const signing = tweetnacl.sign.keyPair();
        const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey;
        await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: 'e2ee',
            publicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey,
            contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey }) } });
        const machineKey = createMachineDataEncryptionKeyV1({ material, dataKeyPublicKey: contentPublicKey,
            randomBytes: tweetnacl.randomBytes });
        const nonce = tweetnacl.randomBytes(SESSION_DATA_KEY_NONCE_BYTES);
        const cipher = createCipheriv('aes-256-gcm', machineKey.encryptionKey, nonce);
        const ciphertext = Buffer.concat([cipher.update(serializeSessionDataKeyValue(decodePlainMachineStoredContent(fixture.machine.metadata))), cipher.final()]);
        await db.machine.update({ where: { id: fixture.machine.id }, data: {
            metadata: encodeBase64(packSessionDataKeyBundleV0({ nonce, ciphertext, authTag: cipher.getAuthTag() })),
            dataEncryptionKey: new Uint8Array(machineKey.dataEncryptionKey),
        } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-agent-spawn-source' } });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const actionId = 'session.spawn_new';
        // Agent authoring deliberately inherits execution target and engine;
        // only the later canonical start owner resolves those choices.
        const input = { creationKey: crypto.randomUUID(),
            title: 'Inherited agent child', directory: { kind: 'path', path: '/tmp' }, roleId: 'builder',
            initialInput: { text: 'Reply READY, then idle.' } };
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'inherited-spawn-turn', requestId: crypto.randomUUID(), callerPermissionMode: 'default' });
        let produced: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse> | undefined;
        const { app } = await createApp(fixture.team.id, false, async () => fixture.machine.id, undefined, false, app => {
            app.addHook('preHandler', async (request: FastifyRequest) => {
                if (request.url === bindExternalActionExecutionAuthorizationHttpPathV1(actionId))
                    produced = ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body);
            });
        });
        try {
            const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
            const target = { kind: 'machine' as const, machineId: fixture.machine.id };
            const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId, input,
                requestId: origin.requestId, target, machineId: fixture.machine.id, sourceMachineId: fixture.machine.id,
                accountId: fixture.account.id, accountEncryptionMode: 'e2ee', tokenEpochHint: fixture.account.tokenEpoch,
                token, material, serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl,
                installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey, sessionActionOrigin: origin });
            expect(authorization).not.toBeNull();
            expect(await verifyCurrentExternalActionPrincipal(authorization!.binding)).toMatchObject({
                authority: 'account_automation', sessionActionOrigin: origin,
            });
            expect(produced?.envelope.v).toBe(2);
            expect(openExternalActionRequestV2({ envelope: produced!.envelope, material,
                binding: { serverIdentityId: homeId, accountId: fixture.account.id,
                    authentication: { kind: 'account', tokenEpoch: fixture.account.tokenEpoch }, actionId,
                    requestId: origin.requestId, target } })?.input).toEqual(input);
        } finally { await app.close(); }
    });

    it.each(['session.attention.set', 'session.spawn_new'] as const)('admits an installed Session ordinary Action without decision authority: %s', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-agent-action-source' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher, undefined, false, registerSessionOrganizationRoutes);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const issue = (requestedActionId: string, input: unknown) => {
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                sourceTurnId: 'ordinary-agent-turn', requestId: crypto.randomUUID(), callerPermissionMode: 'default' });
            const envelope = { v: 1 as const, requestId: origin.requestId,
                target: { kind: 'machine' as const, machineId: fixture.machine.id }, input };
            const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                payload: { version: 1, accountId: fixture.account.id, ...source,
                    externalActionOrigin: { homeId, actionId: requestedActionId, requestId: origin.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
            return app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(requestedActionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id,
                    envelope, sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
        };
        try {
            const input = actionId === 'session.attention.set' ? { sessionId: session.id, standing: false }
                : SessionSpawnNewInputV2Schema.parse({ creationKey: crypto.randomUUID(),
                    executionTarget: { serverId: homeId, machineId: fixture.machine.id },
                    directory: { kind: 'path', path: '/workspace/agent-child' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } });
            const issued = await issue(actionId, input);
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(await verifyCurrentExternalActionPrincipal(root.binding)).toMatchObject({
                accountId: fixture.account.id, authority: 'account_automation', sessionActionOrigin: {
                    caller: { kind: 'session', sessionId: session.id },
                },
            });
            const signedHeaders = (path: string, method: string, body: unknown) => ({
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: actionId, target: root.binding.target, installationId: root.binding.installationId,
                    requestId: root.binding.requestId, method, path, body, privateKey: fixture.keyPair.secretKey }),
            });
            const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const current = await app.inject({ method: 'POST', url: verifyPath, payload: { v: 1 }, headers: signedHeaders(verifyPath, 'POST', { v: 1 }) });
            expect(current.statusCode, current.body).toBe(200);
            if (actionId === 'session.attention.set') {
                const path = `/v2/session-organization/attention-standings/${session.id}`;
                const body = { standing: false };
                const effect = await app.inject({ method: 'PUT', url: path, payload: body, headers: signedHeaders(path, 'PUT', body) });
                expect(effect.statusCode, effect.body).toBe(200);
                expect(await db.sessionAttentionStanding.findUnique({ where: { accountId_sessionId: {
                    accountId: fixture.account.id, sessionId: session.id,
                } } })).toMatchObject({ standing: false });
            }
            const decision = await issue('approval.request.decide', { artifactId: 'agent-cannot-decide',
                decision: 'approve', serverIdentityId: homeId });
            expect(decision.statusCode, decision.body).toBe(403);
        } finally { await app.close(); }
    });

    it.each(['owned', 'shared-use'] as const)('admits only a fresh reviewer approval root and preserves its exact decision replay with %s access', async access => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = access === 'owned' ? fixture.account
            : await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const targetKeys = access === 'owned' ? fixture.keyPair : tweetnacl.sign.keyPair();
        const targetMachine = access === 'owned' ? fixture.machine : await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: custodian.id, metadata: fixture.machine.metadata,
            dataEncryptionKey: fixture.machine.dataEncryptionKey, installationId: crypto.randomUUID(),
            installationPublicKey: new Uint8Array(targetKeys.publicKey),
        } });
        if (access === 'shared-use') await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId: targetMachine.id, principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-approval-source' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const io = createSocketRoomDiscoveryHarness(async room => room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher] : []);
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app, dispatchedPrincipals } = await createApp(fixture.team.id, false, resolvePublisher);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const actionId = 'approval.request.decide';
        const homeId = await getOrCreateServerIdentityId();
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(),
            target: { kind: 'machine' as const, machineId: targetMachine.id },
            input: { artifactId: 'private-requester-approval', decision: 'approve', serverIdentityId: homeId } };
        const body = { v: 1, machineId: targetMachine.id, envelope };
        const issue = (credential: string, payload: unknown = body) => app.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers: { authorization: `Bearer ${credential}` }, payload });
        try {
            const issued = await issue(token);
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(root.binding).toMatchObject({ actionId, accountId: fixture.account.id,
                machineId: targetMachine.id, custodianAccountId: custodian.id,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) });
            expect(await verifyCurrentExternalActionPrincipal(root.binding)).toMatchObject({ accountId: fixture.account.id, authority: 'present_user' });
            const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const signed = (path: string, payload: unknown) => ({
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                    effectActionId: actionId, target: root.binding.target, installationId: root.binding.installationId,
                    requestId: root.binding.requestId, method: 'POST', path, body: payload, privateKey: targetKeys.secretKey }),
            });
            expect((await app.inject({ method: 'POST', url: verifyPath, payload: { v: 1 }, headers: signed(verifyPath, { v: 1 }) })).statusCode).toBe(200);
            const relayPath = `/v1/actions/${actionId}`;
            const relayBody = { ...body, executionAuthorization: root };
            expect((await app.inject({ method: 'POST', url: relayPath, payload: relayBody, headers: signed(relayPath, relayBody) })).statusCode).toBe(200);
            expect(dispatchedPrincipals).toEqual([expect.objectContaining({ accountId: fixture.account.id, authority: 'present_user' })]);
            const substituted = { ...relayBody, envelope: { ...envelope, input: { ...envelope.input, artifactId: 'another-approval' } } };
            expect((await app.inject({ method: 'POST', url: relayPath, payload: substituted, headers: signed(relayPath, substituted) })).statusCode).toBe(401);
            expect((await issue(fixture.pat.token)).statusCode).toBe(403);
            const approvalPat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'explicit-reviewer',
                grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true, actions: { families: [], ids: [actionId] } } });
            const approvalPatIssued = await issue(approvalPat.token);
            expect(approvalPatIssued.statusCode).toBe(200);
            const approvalPatRoot = ExternalActionExecutionAuthorizationV1Schema.parse(approvalPatIssued.json());
            expect(await verifyCurrentExternalActionPrincipal(approvalPatRoot.binding)).toMatchObject({
                accountId: fixture.account.id, authority: 'account_automation', grant: { approve: true },
            });
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'original-agent-turn',
                requestId: envelope.requestId, callerPermissionMode: 'default' });
            const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
            const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                payload: { version: 1, accountId: fixture.account.id, ...source,
                    externalActionOrigin: { homeId, actionId, requestId: envelope.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
            expect((await issue(token, { ...body, sessionActionOrigin: origin, sessionActionSource: source, installationProof })).statusCode).toBe(403);
            // Both HTTP ingress and direct daemon dispatch mint through auth.
            // A previously issued binding must also lose decision authority
            // when projected as the installed Session's automation principal.
            const sessionBinding = { ...root.binding, sessionActionOrigin: origin, sessionActionSource: source };
            await expect(auth.mintExternalActionExecutionAuthorization(sessionBinding, {
                input: envelope.input, resolveCurrentSessionMachine: resolvePublisher,
            })).rejects.toMatchObject({ code: 'credential_scope_denied' });
            expect(await verifyCurrentExternalActionPrincipal(sessionBinding)).toBeNull();
            await db.machine.update({ where: { id: targetMachine.id }, data: { installationId: 'retired-reviewer-target' } });
            expect((await app.inject({ method: 'POST', url: verifyPath, payload: { v: 1 }, headers: signed(verifyPath, { v: 1 }) })).statusCode).toBe(401);
            await db.machine.update({ where: { id: targetMachine.id }, data: { installationId: targetMachine.installationId } });
            if (access === 'shared-use') {
                await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: targetMachine.id,
                    principal: { kind: 'account', accountId: fixture.account.id } }));
                expect((await app.inject({ method: 'POST', url: verifyPath, payload: { v: 1 }, headers: signed(verifyPath, { v: 1 }) })).statusCode).toBe(401);
                await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: targetMachine.id,
                    principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            }
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await app.inject({ method: 'POST', url: verifyPath, payload: { v: 1 }, headers: signed(verifyPath, { v: 1 }) })).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('rechecks signed requester Session custody without enabling foreign raw Session creation', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const keys = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: machine.id,
            sessionId: session.id, data: 'opaque-requester-custody' } });
        const admitted = await resolveMachineAdmission({ actorAccountId: fixture.account.id, machineId: machine.id, requiredRole: 'use' });
        expect(admitted.kind).toBe('admitted');
        if (admitted.kind !== 'admitted') throw new Error('Current generic C41 Use is required by the fixture');
        const context = { actorAccountId: fixture.account.id, custodianAccountId: custodian.id, machineId: machine.id,
            installationId: machine.installationId!, role: admitted.role, encryptionMode: admitted.encryptionMode };
        const purpose = { kind: 'requester_session_currentness', sessionId: session.id };
        const daemonToken = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
        const { app } = await createApp(fixture.team.id);
        const denialLog = vi.spyOn(app.log, 'warn');
        const verify = (selectedPurpose: unknown = purpose, selectedContext = context) => {
            const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: machine.id,
                installationId: machine.installationId!, accountId: custodian.id, rpcAdmission: { context: selectedContext, purpose: selectedPurpose } });
            return app.inject({ method: 'POST', url: `/v1/machines/${machine.id}/admission/verify`,
                headers: { authorization: `Bearer ${daemonToken}` }, payload: { v: 1, context: selectedContext,
                    purpose: selectedPurpose, proof: signMachineInstallationProof({ payload, privateKey: keys.secretKey }) } });
        };
        try {
            const current = await verify();
            expect(current.statusCode, current.body).toBe(200);
            const method = `${machine.id}:${RPC_METHODS.SPAWN_HAPPY_SESSION}`;
            const raw = await app.inject({ method: 'POST', url: `/v1/machines/${machine.id}/admission/verify`,
                headers: { authorization: `Bearer ${daemonToken}` }, payload: { v: 1, context, method,
                    proof: signMachineInstallationProof({ privateKey: keys.secretKey, payload: { version: 1,
                        machineId: machine.id, installationId: machine.installationId!, accountId: custodian.id,
                        rpcAdmission: { context, method } } }) } });
            expect(raw.statusCode).toBe(403);
            expect((await verify({ ...purpose, sessionId: 'another-session' })).statusCode).toBe(403);
            expect((await verify(purpose, { ...context, actorAccountId: custodian.id })).statusCode).toBe(403);
            expect((await verify(purpose, { ...context, role: 'manage' })).statusCode).toBe(403);
            await db.machine.update({ where: { id: machine.id }, data: { installationId: 'replacement' } });
            expect((await verify()).statusCode).toBe(403);
            await db.machine.update({ where: { id: machine.id }, data: { installationId: machine.installationId } });
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            expect((await verify()).statusCode).toBe(403);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: machine.id, sessionId: session.id } });
            expect((await verify()).statusCode).toBe(403);
            expect(denialLog).toHaveBeenLastCalledWith({
                event: 'machine_admission_refused', purpose: 'requester_session_currentness', stage: 'session_binding',
                sessionId: session.id,
            });
        } finally { denialLog.mockRestore(); await app.close(); }
    });

    it.each([undefined, 'deny', 'allow'] as const)('continues only the exact Home-issued Session handoff after its original publisher quiesces with %s workspace-write ceiling', async workspaceWrites => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const destinationKeys = tweetnacl.sign.keyPair();
        const destination = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(destinationKeys.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: destination.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-handoff-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        let publisherVisible = true;
        const io = { in: (room: string) => ({ fetchSockets: async () => publisherVisible
            && room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher] : [] }) } as unknown as Server;
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 },
            sourceTurnId: 'handoff-turn', callerPermissionMode: 'default',
            ...(workspaceWrites ? { workspaceWrites } : {}),
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' }, requestId: crypto.randomUUID() });
        const admission = { sessionId: session.id, sourceMachineId: fixture.machine.id, targetMachineId: destination.id };
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const rootEnvelope = { v: 1 as const, requestId: origin.requestId, target: { kind: 'machine' as const, machineId: fixture.machine.id },
            input: { ...admission, targetPath: '/workspace/project' }, handoffAdmission: admission };
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: { homeId, actionId: 'session.handoff',
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(rootEnvelope), origin } } });
        try {
            const rootResponse = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope: rootEnvelope,
                    sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(rootResponse.statusCode, rootResponse.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(rootResponse.json());
            expect(root.binding).toMatchObject({ handoffAdmission: { ...admission,
                sourceInstallationId: source.installationId, targetInstallationId: destination.installationId }, sessionActionOrigin: origin });
            const preflightPath = bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff');
            const preflightInput = { ...admission, targetPath: '/workspace/project', sourceSessionStorageMode: 'persisted' };
            const preflightBody = { v: 1, machineId: destination.id, envelope: { v: 1, requestId: root.binding.requestId,
                target: { kind: 'machine', machineId: destination.id }, input: preflightInput, handoffAdmission: admission },
                handoffPreflight: { authorization: root } };
            const issuePreflight = (payload: unknown = preflightBody) => app.inject({ method: 'POST', url: preflightPath, payload,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'session.handoff', target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path: preflightPath, body: payload, privateKey: fixture.keyPair.secretKey }) } });
            const preflightResponse = await issuePreflight();
            expect(preflightResponse.statusCode, preflightResponse.body).toBe(200);
            const preflight = ExternalActionExecutionAuthorizationV1Schema.parse(preflightResponse.json());
            expect(preflight.binding).toMatchObject({ handoffPreflight: { rootRequestId: root.binding.requestId,
                rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest }, handoffAdmission: root.binding.handoffAdmission,
                sessionActionOrigin: origin, sessionActionSource: source });
            const preflightRpc = async (methodId: string, privateKey = fixture.keyPair.secretKey) => {
                const method = `${destination.id}:${methodId}`;
                const execution = { v: 1 as const, authorization: preflight, effectActionId: 'session.handoff',
                    target: preflight.binding.target, installationId: preflight.binding.installationId,
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: preflight.token,
                        effectActionId: 'session.handoff', target: preflight.binding.target, installationId: preflight.binding.installationId,
                        event: SOCKET_RPC_EVENTS.CALL, method, requestId: root.binding.requestId, params: preflightInput, privateKey }) };
                return verifyExternalActionMachineRpcExecution(execution, { method, requestId: root.binding.requestId,
                    params: preflightInput, resolveCurrentSessionMachine: resolvePublisher });
            };
            expect(await preflightRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3)).not.toBeNull();
            expect(await preflightRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3, destinationKeys.secretKey)).toBeNull();
            expect(await preflightRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)).toBeNull();
            const preflightHttp = (method: string, path: string, body?: unknown, privateKey = fixture.keyPair.secretKey) =>
                verifyExternalActionDomainExecutionRequest({ authorizationToken: preflight.token, effectActionId: 'session.handoff',
                    encodedTarget: encodeExternalActionResolvedTargetV1(preflight.binding.target), method, path, body,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: preflight.token,
                        effectActionId: 'session.handoff', target: preflight.binding.target, installationId: preflight.binding.installationId,
                        requestId: preflight.binding.requestId, method, path, ...(body === undefined ? {} : { body }), privateKey }),
                    resolveCurrentSessionMachine: resolvePublisher });
            // The installed-key sealing transport reads only its exact bound peer's public Machine projection.
            expect(await preflightHttp('GET', `/v1/machines/${destination.id}`)).not.toBeNull();
            expect(await preflightHttp('GET', `/v1/machines/${fixture.machine.id}`)).toBeNull();
            expect(await preflightHttp('GET', `/v1/machines/${destination.id}`, undefined, destinationKeys.secretKey)).toBeNull();
            expect(await preflightHttp('POST', '/v1/actions/session.handoff', {
                ...preflightBody, executionAuthorization: preflight })).toBeNull();
            expect((await issuePreflight({ ...preflightBody, envelope: { ...preflightBody.envelope,
                input: { ...preflightInput, sessionId: 'another-session' } } })).statusCode).toBe(401);
            const { sessionId: _sessionId, ...missingSessionInput } = preflightInput;
            expect((await issuePreflight({ ...preflightBody, envelope: { ...preflightBody.envelope,
                input: missingSessionInput } })).statusCode).toBe(401);
            // A non-writing handoff can legitimately be issued under a deny ceiling.
            // Its private SOURCE carrier must retain that signed ceiling for later write phases.
            const sourceAdmission = await resolveMachineAdmission({ actorAccountId: fixture.account.id,
                machineId: source.machineId, requiredRole: 'use' });
            if (sourceAdmission.kind !== 'admitted') throw new Error('Original Session source must remain admitted');
            const { kind: _sourceKind, ...machineAdmission } = sourceAdmission;
            const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({ machineAdmission,
                callerAuthority: 'account_automation', sessionActionOrigin: origin,
                callerPermissionMode: origin.callerPermissionMode, causalPermissionAuthority: origin.causalPermissionAuthority,
                ...(workspaceWrites ? { workspaceWrites } : {}) });
            const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: origin.requestId,
                accountServerId: homeId, sourceMachineId: source.machineId, sourceSessionId: session.id,
                sourceRootPath: '/workspace/project', sourceContext });
            expect(await verifyWorkspaceSyncHandoffSourceAuthorization(root, routing, resolvePublisher)).not.toBeNull();
            if (workspaceWrites === 'deny') {
                const { workspaceWrites: _redundantCeiling, ...originOnlyContext } = sourceContext;
                expect(await verifyWorkspaceSyncHandoffSourceAuthorization(root,
                    { ...routing, sourceContext: WorkspaceSyncSourceContextV1Schema.parse(originOnlyContext) }, resolvePublisher)).toBeNull();
            }
            publisherVisible = false;
            expect(await resolvePublisher({ accountId: fixture.account.id, sessionId: session.id })).toBeNull();
            expect((await issuePreflight()).statusCode).toBe(401);
            expect(await preflightRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3)).toBeNull();
            const actionId = 'session.handoff.status.get';
            const handoffId = 'accepted-handoff';
            const envelope = { v: 1, requestId: root.binding.requestId, target: { kind: 'machine', machineId: destination.id },
                input: { handoffId }, handoffAdmission: admission };
            const path = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
            const body = { v: 1, machineId: destination.id, envelope, handoffContinuation: { authorization: root, handoffId } };
            const issueChild = (payload: unknown = body) => app.inject({ method: 'POST', url: path, payload,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'session.handoff', target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path, body: payload, privateKey: fixture.keyPair.secretKey }) } });
            const childResponse = await issueChild();
            expect(childResponse.statusCode, childResponse.body).toBe(200);
            const child = ExternalActionExecutionAuthorizationV1Schema.parse(childResponse.json());
            expect(child.binding).toMatchObject({ actionId, machineId: destination.id, installationId: destination.installationId,
                requestId: root.binding.requestId, sessionActionOrigin: origin, handoffAdmission: { ...admission,
                    sourceInstallationId: source.installationId, targetInstallationId: destination.installationId },
                handoffContinuation: { rootRequestId: root.binding.requestId,
                    rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest, handoffId } });
            expect(await verifyCurrentExternalActionPrincipal(child.binding)).toMatchObject({ authority: 'account_automation', sessionActionOrigin: origin });
            const rpcMethod = `${destination.id}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3}`;
            const rpcRequestId = crypto.randomUUID();
            const rpcParams = 'sealed-exact-handoff-status';
            const rpcSignature = (privateKey: Uint8Array) => signExternalActionMachineRpcRequestV1({
                authorizationToken: child.token, effectActionId: actionId, target: child.binding.target,
                installationId: child.binding.installationId, event: SOCKET_RPC_EVENTS.CALL, method: rpcMethod,
                requestId: rpcRequestId, params: rpcParams, privateKey });
            const execution = { v: 1 as const, authorization: child, effectActionId: actionId, target: child.binding.target,
                installationId: child.binding.installationId, machineSignature: rpcSignature(fixture.keyPair.secretKey) };
            expect(await verifyExternalActionMachineRpcExecution(execution, { method: rpcMethod, requestId: rpcRequestId,
                params: rpcParams, resolveCurrentSessionMachine: resolvePublisher })).toMatchObject({
                principal: { accountId: fixture.account.id, authority: 'account_automation', sessionActionOrigin: origin },
                binding: { machineId: destination.id, handoffContinuation: { handoffId } } });
            expect(await verifyExternalActionMachineRpcExecution({ ...execution,
                machineSignature: rpcSignature(destinationKeys.secretKey) }, { method: rpcMethod, requestId: rpcRequestId,
                params: rpcParams, resolveCurrentSessionMachine: resolvePublisher })).toBeNull();
            const resumePath = bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new');
            const resumeBody = { ...body, envelope: { ...envelope, input: { type: 'resume-session', sessionId: session.id } } };
            const issueResume = (payload: unknown = resumeBody) => app.inject({ method: 'POST', url: resumePath, payload,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'session.handoff',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(root.binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: root.token,
                        effectActionId: 'session.handoff', target: root.binding.target, installationId: root.binding.installationId,
                        requestId: root.binding.requestId, method: 'POST', path: resumePath, body: payload, privateKey: fixture.keyPair.secretKey }) } });
            const resumed = await issueResume();
            expect(resumed.statusCode, resumed.body).toBe(200);
            const resume = ExternalActionExecutionAuthorizationV1Schema.parse(resumed.json());
            expect(resume.binding).toMatchObject({ actionId: 'session.spawn_new', sessionActionOrigin: origin, handoffAdmission: child.binding.handoffAdmission });
            for (const methodId of [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE]) {
                const method = `${destination.id}:${methodId}`;
                const params = 'sealed-resume-or-original-nonce';
                const resumeExecution = { ...execution, authorization: resume, effectActionId: 'session.spawn_new',
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: resume.token,
                        effectActionId: 'session.spawn_new', target: resume.binding.target, installationId: resume.binding.installationId,
                        event: SOCKET_RPC_EVENTS.CALL, method, requestId: rpcRequestId, params, privateKey: fixture.keyPair.secretKey }) };
                expect(await verifyExternalActionMachineRpcExecution(resumeExecution, { method, requestId: rpcRequestId,
                    params, resolveCurrentSessionMachine: resolvePublisher })).toMatchObject({ principal: { authority: 'account_automation', sessionActionOrigin: origin } });
            }
            expect((await issueResume({ ...resumeBody, envelope: { ...envelope, input: { type: 'resume-session', sessionId: 'different-session' } } })).statusCode).toBe(401);
            expect((await issueResume({ ...resumeBody, envelope: { ...envelope, input: { type: 'new-session' } } })).statusCode).toBe(401);
            expect((await issueResume({ ...resumeBody, machineId: fixture.machine.id,
                envelope: { ...resumeBody.envelope, target: root.binding.target } })).statusCode).toBe(401);
            expect((await issueChild({ ...body, envelope: { ...envelope, input: { handoffId: 'substituted-handoff' } } })).statusCode).toBe(401);
            expect((await issueChild({ ...body, envelope: { ...envelope, handoffAdmission: { ...admission, sessionId: 'another-session' } } })).statusCode).toBe(401);
            expect((await issueChild({ ...body, handoffContinuation: { authorization: { ...root,
                binding: { ...root.binding, actionId: 'projects.open' } }, handoffId } })).statusCode).toBe(401);
            await db.machine.update({ where: { id: destination.id }, data: { installationId: 'replacement-target-installation' } });
            expect((await issueChild()).statusCode).toBe(401);
            await db.machine.update({ where: { id: destination.id }, data: { installationId: destination.installationId } });
            await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: 'replacement-source-installation' } });
            expect((await issueChild()).statusCode).toBe(401);
            await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: fixture.machine.installationId } });
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: destination.id,
                principal: { kind: 'account', accountId: fixture.account.id } }));
            expect((await issueChild()).statusCode).toBe(401);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: destination.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await issueChild()).statusCode).toBe(401);
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: fixture.account.tokenEpoch } });
            await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } });
            expect((await issueChild()).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it.each(['projects.open', 'machines.managed.acquire'] as const)('verifies and relays the original Session source proof to a different admitted Machine for %s', async actionId => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const destinationKeys = tweetnacl.sign.keyPair();
        const destination = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey, active: true,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(destinationKeys.publicKey) } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: destination.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: actionId === 'machines.managed.acquire' ? 'admin' : 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-source-key' } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        let visible = true;
        let sourceReads = 0;
        let retireSourceOnFinalRead = false;
        const effect = vi.fn(async (_event: string, _request: unknown) => ({ success: true }));
        const target = { id: 'destination-socket', data: { clientType: 'machine-scoped', machineId: destination.id,
            verifiedMachineInstallationId: destination.installationId }, timeout: () => ({ emitWithAck: effect }) };
        qualifyCurrentAccountStoredContentSocket(target);
        const method = `${destination.id}:${actionId === 'projects.open' ? RPC_METHODS.PROJECTS_OPEN : actionId}`;
        // Only Socket.IO discovery/delivery are simulated; signing, Home auth, source/publisher and C41 are real.
        const io = createSocketRoomDiscoveryHarness(async room => {
            if (room === getAccountSessionSocketRoom(fixture.account.id, session.id)) {
                if (retireSourceOnFinalRead && ++sourceReads === 2) {
                    await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } });
                }
                return visible ? [publisher] : [];
            }
            return room === `rpc:${custodian.id}:${method}` || room === target.id ? [target] : [];
        });
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'original-turn',
            callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
            requestId: crypto.randomUUID() });
        const homeId = await getOrCreateServerIdentityId();
        const params = actionId === 'projects.open'
            ? { serverId: homeId, machineId: destination.id, source: { kind: 'folder', path: '/workspace/project' },
                materialization: { kind: 'attach' } }
            : { selection: { kind: 'one-off', homeId,
                controller: { machineId: destination.id, installationId: destination.installationId! },
                launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1,
                    name: 'Reviewed', choices: {} }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: destination.id }, input: params });
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: { homeId, actionId,
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: destination.id, envelope,
                    sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: destination.installationId!, requestId: authorization.binding.requestId });
            const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const verifyBody = { v: 1 };
            const verifyHttp = (privateKey: Uint8Array, body: unknown = verifyBody) => app.inject({ method: 'POST', url: verifyPath,
                payload: body, headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path: verifyPath, body, privateKey }) });
            // The receiver signs with its installation; the Home-bound original
            // source may also obtain this exact root's qualified currentness.
            expect((await verifyHttp(destinationKeys.secretKey)).statusCode).toBe(200);
            const sourceSignedHttp = await verifyHttp(fixture.keyPair.secretKey);
            expect(sourceSignedHttp.statusCode, sourceSignedHttp.body).toBe(200);
            expect(sourceSignedHttp.json()).toEqual({ ok: true });
            expect((await verifyHttp(tweetnacl.sign.keyPair().secretKey)).statusCode).toBe(401);
            await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: 'replaced-original-source' } });
            expect((await verifyHttp(destinationKeys.secretKey)).statusCode).toBe(401);
            await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: fixture.machine.installationId } });
            expect((await verifyHttp(destinationKeys.secretKey)).statusCode).toBe(200);
            const signingInput = { authorizationToken: authorization.token, effectActionId: actionId,
                target: authorization.binding.target, installationId: destination.installationId!, event: SOCKET_RPC_EVENTS.CALL,
                method, requestId: origin.requestId, params };
            const execution = { v: 1 as const, authorization, effectActionId: actionId, target: authorization.binding.target,
                installationId: destination.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({ ...signingInput,
                    privateKey: fixture.keyPair.secretKey }) };
            const request = { method, requestId: origin.requestId, params, resolveCurrentSessionMachine: resolvePublisher };
            expect(await verifyExternalActionMachineRpcExecution(execution, request)).toMatchObject({
                principal: { accountId: fixture.account.id, authority: 'account_automation', sessionActionOrigin: origin } });
            expect(await verifyExternalActionMachineRpcExecution({ ...execution,
                machineSignature: signExternalActionMachineRpcRequestV1({ ...signingInput, privateKey: destinationKeys.secretKey }) }, request)).toBeNull();
            expect(await verifyExternalActionMachineRpcExecution(execution, { ...request, params: { ...params, machineId: fixture.machine.id } })).toBeNull();
            expect(await verifyExternalActionMachineRpcExecution({ ...execution, authorization: { ...authorization,
                binding: { ...authorization.binding, sessionActionOrigin: { ...origin, sourceTurnId: 'forged-turn' } } } }, request)).toBeNull();
            const socket = Object.assign(createFakeSocket({ id: 'requester-source', data: { clientType: 'machine-scoped',
                machineId: fixture.machine.id, verifiedMachineInstallationId: fixture.machine.installationId,
                authTokenKind: 'account', authAuthority: 'present_user' } }), {
                    handshake: { auth: { token, ...currentAccountStoredContentCompatibilitySocketAuth } },
                });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: fixture.account.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: origin.requestId, params,
                externalActionExecution: execution }, callback);
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { success: true } });
            expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
                callerAuthority: 'account_automation', sessionActionOrigin: origin, callerInputAuthorization: authorization }));
            expect(authorization.binding).toMatchObject({ machineId: destination.id, installationId: destination.installationId,
                accountId: fixture.account.id, custodianAccountId: custodian.id, sessionActionSource: source });
            const forged = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: origin.requestId, params,
                externalActionExecution: { ...execution, machineSignature: signExternalActionMachineRpcRequestV1({
                    ...signingInput, privateKey: destinationKeys.secretKey }) } }, forged);
            expect(forged).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'Forbidden' }));
            expect(effect).toHaveBeenCalledOnce();
            visible = false;
            expect((await verifyHttp(fixture.keyPair.secretKey)).statusCode).toBe(401);
            expect((await verifyHttp(destinationKeys.secretKey)).statusCode).toBe(401);
            expect(await verifyExternalActionMachineRpcExecution(execution, request)).toBeNull();
            const retired = vi.fn();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: origin.requestId, params,
                externalActionExecution: execution }, retired);
            expect(retired).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'Forbidden' }));
            expect(effect).toHaveBeenCalledOnce();
            visible = true;
            retireSourceOnFinalRead = true;
            expect(await verifyExternalActionMachineRpcExecution(execution, request)).toBeNull();
            expect(sourceReads).toBe(2);
        } finally { await app.close(); }
    });

    it.each(['view', 'admin'] as const)('admits original requester Project Open with proved Session origin for %s and retires it with its exact AccessKey', async level => {
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        await db.machine.update({ where: { id: fixture.machine.id }, data: { accountId: custodian.id } });
        await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: fixture.machine.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level }));
        const fence = new Date();
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: fence } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'opaque-requester-key' } });
        expect(await resolveMachineAccess({ actorAccountId: fixture.account.id, machineId: fixture.machine.id }))
            .toMatchObject({ owned: false, role: level === 'admin' ? 'manage' : 'use', custodianAccountId: custodian.id, accessState: 'ready' });
        const ungranted = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        expect(await resolveMachineAdmission({ actorAccountId: ungranted.id, machineId: fixture.machine.id, actionId: 'projects.open' }))
            .toMatchObject({ kind: 'denied', code: 'access_denied' });
        expect(await inTx(tx => hasCurrentSessionScopedMachineAccessInTx({ tx, accountId: fixture.account.id,
            machineId: fixture.machine.id, sessionId: session.id }))).toBe(true);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 2 },
            sourceTurnId: 'turn-2', callerPermissionMode: 'yolo', causalPermissionAuthority: null,
            requestId: crypto.randomUUID() });
        const actionId = 'projects.open';
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: fixture.machine.id }, input: { serverId: homeId,
                machineId: fixture.machine.id, source: { kind: 'folder', path: '/workspace/project' },
                materialization: { kind: 'attach' } } });
        const proof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, machineId: fixture.machine.id,
                installationId: fixture.machine.installationId!, externalActionOrigin: { homeId, actionId,
                    requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const presence = createSessionPublisherPresence();
        const publisher = { data: {} as Record<string, unknown> };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        let publisherVisible = true;
        let revokeGrantDuringDiscovery = false;
        // Only socket discovery is simulated: AccessKey, publisher freshness and Account/Machine admission are real.
        const io = { in: (room: string) => ({ fetchSockets: async () => {
            if (revokeGrantDuringDiscovery) {
                revokeGrantDuringDiscovery = false;
                await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: fixture.machine.id,
                    principal: { kind: 'account', accountId: fixture.account.id } }));
            }
            return publisherVisible && room === getAccountSessionSocketRoom(fixture.account.id, session.id)
                ? [publisher] : [];
        } }) } as unknown as Server;
        const resolvePublisher = (input: Readonly<{ accountId: string; sessionId: string }>) => resolveCurrentSessionMachineFromServer({ io, presence, ...input });
        expect(await resolvePublisher({ accountId: fixture.account.id, sessionId: session.id })).toBe(fixture.machine.id);
        const { app } = await createApp(fixture.team.id, false, resolvePublisher);
        const sessionActionSource = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const request = { v: 1, machineId: fixture.machine.id, envelope, sessionActionOrigin: origin, sessionActionSource, installationProof: proof };
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: request });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding).toMatchObject({ accountId: fixture.account.id, custodianAccountId: custodian.id,
                sessionActionOrigin: origin, sessionActionSource, accountEncryptionMode: 'plain' });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                accountId: fixture.account.id, authority: 'account_automation' });
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: fixture.machine.installationId!, requestId: origin.requestId });
            const forged = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { ...request,
                    sessionActionOrigin: { ...origin, sourceTurnId: 'substituted-turn' } } });
            expect(forged.statusCode).toBe(401);
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
            const body = { v: 1 };
            const headers = machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                method: 'POST', path, body, privateKey: fixture.keyPair.secretKey });
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(200);
            const key = { kind: 'project-organization', serverId: homeId, projectKey: 'requester-private' } as const;
            const mutationPath = '/v1/account/project-rows/mutate';
            const mutationBody = { mutations: [{ key, expectedRevision: 'absent',
                content: { t: 'plain', v: { key, value: { hidden: true, pinned: true } } } }], expectedRefs: [], topologyChange: false };
            const mutationHeaders = machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                method: 'POST', path: mutationPath, body: mutationBody, privateKey: fixture.keyPair.secretKey });
            const mutated = await app.inject({ method: 'POST', url: mutationPath, headers: mutationHeaders, payload: mutationBody });
            expect(mutated.statusCode, mutated.body).toBe(200);
            expect(mutated.json()).toMatchObject({ status: 'updated' });
            const physicalKey = buildProjectAccountRowPhysicalKeyV1(key);
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: custodian.id, key: physicalKey } } })).toBeNull();
            const requesterRow = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: fixture.account.id, key: physicalKey } } });
            expect(requesterRow.version).toBe(0);
            await db.session.update({ where: { id: session.id }, data: { accountId: ungranted.id } });
            expect(await db.accessKey.count({ where: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } })).toBe(1);
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: mutationPath, headers: mutationHeaders, payload: mutationBody })).statusCode).toBe(401);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: fixture.account.id, key: physicalKey } } })).toEqual(requesterRow);
            await db.session.update({ where: { id: session.id }, data: { accountId: fixture.account.id } });
            publisherVisible = false;
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: mutationPath, headers: mutationHeaders, payload: mutationBody })).statusCode).toBe(401);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: fixture.account.id, key: physicalKey } } })).toEqual(requesterRow);
            publisherVisible = true;
            revokeGrantDuringDiscovery = true;
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(401);
            expect(await db.accessKey.count({ where: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } })).toBe(1);
            expect((await app.inject({ method: 'POST', url: mutationPath, headers: mutationHeaders, payload: mutationBody })).statusCode).toBe(401);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: fixture.account.id, key: physicalKey } } })).toEqual(requesterRow);
            await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: fixture.machine.id,
                principal: { kind: 'account', accountId: fixture.account.id }, level }));
            await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id } });
            expect((await app.inject({ method: 'POST', url: path, headers, payload: body })).statusCode).toBe(401);
            expect((await app.inject({ method: 'POST', url: mutationPath, headers: mutationHeaders, payload: mutationBody })).statusCode).toBe(401);
            expect(await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: fixture.account.id, key: physicalKey } } })).toEqual(requesterRow);
            const retiredMint = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: request });
            expect(retiredMint.statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('requires the semantic withdrawal effect while allowing a composite outer Action to invoke that exact effect', async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const session = await db.session.create({ data: { tag: crypto.randomUUID(), accountId: fixture.account.id,
            metadata: '{}', encryptionMode: 'plain' } });
        const localId = `effect-${crypto.randomUUID()}`;
        await expect(enqueuePendingMessage({ actorUserId: fixture.account.id, sessionId: session.id, localId,
            authentication: createPresentUserSessionAccessAuthentication(), requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Keep original custody' } } } }))
            .resolves.toMatchObject({ ok: true });
        const { app } = await createApp(fixture.team.id, true);
        const path = `/v2/sessions/${session.id}/pending/${localId}/withdraw`;
        const body = {};
        const envelope = { ...fixture.envelope, target: { kind: 'session' as const, sessionId: session.id } };
        try {
            const wrong = await mint(app, fixture, 'session.message.send', envelope);
            const denied = await app.inject({ method: 'POST', url: path, payload: body,
                headers: machineHeaders({ authorizationToken: wrong.token, effectActionId: 'session.message.send',
                    method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }) });
            expect(denied.statusCode).toBe(401);
            expect(denied.json()).toMatchObject({ error: 'invalid_token' });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(1);
            // The effect is exact; its originating Action is intentionally composite rather than withdrawal itself.
            const composite = await mint(app, fixture, 'approval.request.create', envelope);
            const removed = await app.inject({ method: 'POST', url: path, payload: body,
                headers: machineHeaders({ authorizationToken: composite.token, effectActionId: 'session.pending.withdraw',
                    method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }) });
            expect(removed.statusCode, removed.body).toBe(200);
            expect(removed.json()).toMatchObject({ ok: true, outcome: 'removed' });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(0);
        } finally { await app.close(); }
    });

    it.each([1, 2] as const)('admits a terminal Session start V%s without granting present-user authority and revokes its exact root on epoch change', async version => {
        const fixture = await createFixture({ qualifiedPat: false });
        const material = version === 2 ? { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) } : undefined;
        if (material) {
            const signing = tweetnacl.sign.keyPair();
            const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey;
            await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: 'e2ee',
                publicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey,
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey }) } });
            const machineKey = createMachineDataEncryptionKeyV1({ material, dataKeyPublicKey: contentPublicKey,
                randomBytes: tweetnacl.randomBytes });
            const nonce = tweetnacl.randomBytes(SESSION_DATA_KEY_NONCE_BYTES);
            const cipher = createCipheriv('aes-256-gcm', machineKey.encryptionKey, nonce);
            const ciphertext = Buffer.concat([cipher.update(serializeSessionDataKeyValue(decodePlainMachineStoredContent(fixture.machine.metadata))), cipher.final()]);
            await db.machine.update({ where: { id: fixture.machine.id }, data: {
                metadata: encodeBase64(packSessionDataKeyBundleV0({ nonce, ciphertext, authTag: cipher.getAuthTag() })),
                dataEncryptionKey: new Uint8Array(machineKey.dataEncryptionKey),
            } });
            expect(await resolveMachineAccess({ actorAccountId: fixture.account.id, machineId: fixture.machine.id }))
                .toMatchObject({ owned: true, encryptionMode: 'e2ee', accessState: 'ready', installationId: fixture.machine.installationId });
        }
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const actionId = 'session.spawn_new';
        const homeId = await getOrCreateServerIdentityId();
        const input = SessionSpawnNewInputV2Schema.parse({ executionTarget: { serverId: homeId, machineId: fixture.machine.id },
            directory: { kind: 'path', path: '/workspace/terminal-session' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
        const envelope = material ? sealExternalActionRequestV2({ binding: { serverIdentityId: homeId,
            accountId: fixture.account.id, actionId, requestId: fixture.envelope.requestId!, target: fixture.envelope.target!,
            authentication: { kind: 'terminal', tokenEpoch: fixture.account.tokenEpoch } },
            input, sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(input), material, randomBytes: tweetnacl.randomBytes })
            : { ...fixture.envelope, input };
        const execution = { ok: true as const, result: SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created',
            sessionId: crypto.randomUUID(), executionTarget: input.executionTarget,
            organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } }) };
        let receivedAuthorization: Parameters<ExternalActionDaemonDispatcher>[0]['executionAuthorization'];
        const { app, dispatchedPrincipals } = await createApp(fixture.team.id, false, undefined, async request => {
            receivedAuthorization = request.executionAuthorization;
            const root = receivedAuthorization?.binding;
            if (!root || !('authentication' in root)) throw new Error('Terminal relay must retain its admitted signed root');
            if (request.envelope.v === 2) {
                if (!material) throw new Error('Protected terminal response requires the same Account material');
                const binding = { serverIdentityId: root.serverIdentityId, accountId: root.accountId, authentication: root.authentication,
                    actionId: root.actionId, requestId: root.requestId, target: root.target };
                expect(openExternalActionRequestV2({ envelope: request.envelope, binding, material })?.input).toEqual(input);
                return { kind: 'response', prepared: prepareExternalActionResponseV2({ binding, request: request.envelope,
                    executedMachineId: fixture.machine.id, execution, material, randomBytes: tweetnacl.randomBytes }) };
            }
            expect(request.envelope.input).toEqual(input);
            return { kind: 'response', prepared: prepareExternalActionResponseEnvelopeV1({ v: 1, actionId,
                requestId: root.requestId, execution }) };
        });
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const principal = await verifyCurrentExternalActionPrincipal(authorization.binding);
            expect(principal?.authority).toBe('account_automation');
            expect(principal?.accountId).toBe(fixture.account.id);
            expect('authentication' in authorization.binding).toBe(true);
            if ('authentication' in authorization.binding) {
                expect(authorization.binding.authentication).toEqual({ kind: 'terminal', tokenEpoch: fixture.account.tokenEpoch });
            }
            const ordinaryAccountToken = await auth.createToken(fixture.account.id, undefined,
                { kind: 'account', authority: 'present_user' });
            const ordinaryAccountMint = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${ordinaryAccountToken}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
            // Machine-placed roots also admit ordinary Account credentials;
            // terminal authentication is not the root's only authority.
            expect(ordinaryAccountMint.statusCode).toBe(200);
            const accountAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(ordinaryAccountMint.json());
            expect(accountAuthorization.binding).toMatchObject({ authentication: {
                kind: 'account', tokenEpoch: fixture.account.tokenEpoch,
            } });
            const relay = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope, executionAuthorization: authorization } });
            expect(relay.statusCode, relay.body).toBe(200);
            expect(receivedAuthorization).toEqual(authorization);
            expect(dispatchedPrincipals.map(p => p.authority)).toEqual(['account_automation']);
            if (material && envelope.v === 2) {
                expect(openExternalActionResponseV2({ envelope: relay.json(), request: envelope, material,
                    binding: { serverIdentityId: homeId, accountId: fixture.account.id, authentication: { kind: 'terminal', tokenEpoch: fixture.account.tokenEpoch },
                        actionId, requestId: envelope.requestId, target: fixture.envelope.target! } })).toEqual(execution);
            } else expect(relay.json()).toMatchObject({ execution });
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toBeNull();
            expect((await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } })).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it("admits shared launch for current Use without substituting the custodian principal", async () => {
        expect(isOriginalAccountExecutionAction('session.open')).toBe(true);
        const fixture = await createFixture({ qualifiedPat: false });
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        await db.machine.update({ where: { id: fixture.machine.id }, data: {
            accountId: custodian.id,
            metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/shared', happyHomeDir: '/home/shared/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            active: true,
        } });
        await db.machineAccountGrant.create({ data: {
            machineId: fixture.machine.id, accountId: fixture.account.id,
            accessLevel: "view", createdByAccountId: custodian.id,
        } });
        const { app } = await createApp(fixture.team.id);
        try {
            const envelope: ExternalActionRequestEnvelopeV1 = { v: 1, requestId: crypto.randomUUID(),
                target: { kind: "machine", machineId: fixture.machine.id }, input: {} };
            const mintLaunch = () => app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new'),
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope } });
            const admitted = await mintLaunch();
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(admitted.json()).binding).toMatchObject({
                accountId: fixture.account.id, custodianAccountId: custodian.id,
                installationId: fixture.machine.installationId,
            });
            const accountToken = await auth.createToken(fixture.account.id, undefined,
                { kind: 'account', authority: 'present_user' });
            const mintResume = () => app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('session.open'),
                headers: { authorization: `Bearer ${accountToken}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope } });
            const resume = await mintResume();
            expect(resume.statusCode, resume.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(resume.json()).binding).toMatchObject({
                accountId: fixture.account.id, custodianAccountId: custodian.id, actionId: 'session.open',
            });
            await db.machineAccountGrant.update({ where: { machineId_accountId: {
                machineId: fixture.machine.id, accountId: fixture.account.id,
            } }, data: { accessLevel: 'admin' } });
            expect((await mintLaunch()).statusCode).toBe(200);
            await db.machineAccountGrant.delete({ where: { machineId_accountId: {
                machineId: fixture.machine.id, accountId: fixture.account.id,
            } } });
            expect((await mintLaunch()).statusCode).toBe(409);
            expect((await mintResume()).statusCode).toBe(409);
        } finally { await app.close(); }
    });

    it("originates managed execution from the actual ordinary Account credential and rechecks its epoch", async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, {
            kind: 'account', authority: 'present_user',
            authenticationEvidence: [{ kind: 'home_method', methodId: 'email_password' }],
        });
        const actionId = 'machines.managed.acquire';
        const envelope = { ...fixture.envelope, input: {} };
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as import('@/app/api/types').Fastify;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
        registerAccountApiTokenManagementRoutes(app);
        app.post('/v1/machines/managed/controller/test-effect', { preHandler: app.authenticate }, async request => ({
            accountId: request.userId, authority: request.authAuthority,
            tokenKind: request.authTokenKind, evidence: request.authTokenAuthenticationEvidence,
            custodianAccountId: request.externalActionExecutionCustodianAccountId,
            requestId: request.externalActionExecutionRequestId,
            hasPat: request.apiTokenPrincipal !== undefined,
        }));
        await app.ready();
        try {
            const minted = await app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope } });
            expect(minted.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(authorization.binding).toMatchObject({ accountId: fixture.account.id,
                custodianAccountId: fixture.account.id, installationId: fixture.machine.installationId,
                accountEncryptionMode: 'plain',
                authentication: { kind: 'account', tokenEpoch: fixture.account.tokenEpoch,
                    evidence: [{ kind: 'home_method', methodId: 'email_password' }] } });
            expect(authorization.binding).not.toHaveProperty('credentialId');
            expect(authorization.binding).not.toHaveProperty('grant');
            expect(JSON.stringify(authorization)).not.toContain(token);
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: authorization.binding.installationId, requestId: authorization.binding.requestId });
            const body = { managedId: 'same-resource' };
            const execute = () => app.inject({ method: 'POST', url: '/v1/machines/managed/controller/test-effect', payload: body,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path: '/v1/machines/managed/controller/test-effect', body, privateKey: fixture.keyPair.secretKey }) });
            expect((await execute()).json()).toMatchObject({ accountId: fixture.account.id, authority: 'present_user',
                tokenKind: 'account', custodianAccountId: fixture.account.id, requestId: envelope.requestId, hasPat: false });
            const unrelatedBody = { tokenId: crypto.randomUUID(), label: 'Unrelated security authority' };
            const unrelated = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                payload: unrelatedBody, headers: machineHeaders({ authorizationToken: authorization.token,
                    effectActionId: 'account.apiTokens.create', method: 'POST', path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                    body: unrelatedBody, privateKey: fixture.keyPair.secretKey }) });
            expect(unrelated.statusCode).toBe(401);
            expect(await db.accountApiToken.findUnique({ where: { id: unrelatedBody.tokenId } })).toBeNull();
            const wrongPurposeBody = { tokenId: crypto.randomUUID(), label: 'Same effect, unrelated HTTP purpose' };
            const wrongPurpose = await app.inject({ method: 'POST', url: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                payload: wrongPurposeBody, headers: machineHeaders({ authorizationToken: authorization.token,
                    effectActionId: actionId, method: 'POST', path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
                    body: wrongPurposeBody, privateKey: fixture.keyPair.secretKey }) });
            expect(wrongPurpose.statusCode).toBe(401);
            expect(await db.accountApiToken.findUnique({ where: { id: wrongPurposeBody.tokenId } })).toBeNull();
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await execute()).statusCode).toBe(401);
        } finally { await app.close(); }
    });

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
            { id: 'reconcile', inputSchema: reconciliation.input.jsonSchema, resultSchema: reconciliation.result.jsonSchema },
            ...(rebuild ? [{ id: 'rebuild', inputSchema: roles.rebuildInput.jsonSchema, resultSchema: roles.rebuildResult.jsonSchema }] : []),
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.pending-auth', version: '1.0.0',
            displayName: 'Pending native authentication fixture', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Guest', icon: 'machine', resourceKind: rebuild ? 'devcontainer' : 'vm', schemaVersion: 1,
                    launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: rebuild ? ['delete', 'rebuild'] : ['delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy', ...(rebuild ? { rebuild: 'rebuild' } : {}) },
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
        const input = { selection: { kind: 'one-off' as const, homeId, controller,
            launch: { provider: { pluginId: manifest.id, localId: 'compute' }, schemaVersion: 1, name: 'Reviewed', choices: { id: 'reviewed' } },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        return { fixture, homeId, controller, input };
    }

    it('retains an actually submitted pending allocation through real Home authentication after its Session origin retires', async () => {
        const { fixture, homeId, controller, input } = await createManagedNativeAuthFixture();
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: new Date() } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: controller.machineId, sessionId: session.id, data: 'source-key' } });
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'paid-source-turn', callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: crypto.randomUUID() });
        const actionId = 'machines.managed.acquire';
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: controller.machineId }, input });
        const source = controller;
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: { homeId, actionId,
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as import('@/app/api/types').Fastify;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Only publisher transport is substituted. Source custody, token mint,
        // installation signatures and managed submission use their real owners.
        app.decorate('resolveCurrentSessionMachine', async () => controller.machineId);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
        registerManagedMachineRoutes(app);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope, sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: controller.installationId, requestId: origin.requestId });
            const created = await admitManagedAcquire({ requesterAccountId: fixture.account.id, custodianAccountId: fixture.account.id,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), input: { input, requestId: origin.requestId, continuationPresent: false } });
            const correlation = { homeId, managedId: created.machine.id, expectedIntentRevision: 0, requestId: origin.requestId, controller };
            const post = (path: string, body: InjectOptions['payload']) => app.inject({ method: 'POST', url: path, payload: body,
                headers: machineHeaders({ authorizationToken: authorization.token, effectActionId: actionId,
                    method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }) });
            const submitted = await post('/v1/machines/managed/controller/submit', correlation);
            expect(submitted.statusCode, submitted.body).toBe(200);
            await cancelManagedCreation({ actorAccountId: fixture.account.id, input: { homeId, managedId: created.machine.id, expectedIntentRevision: 0 } });
            await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: controller.machineId, sessionId: session.id } });
            const nativeOperationRef = { contributionRef: input.selection.launch.provider, schemaVersion: 1, value: { requestId: 'actually-submitted-native-request' } };
            const reported = await post('/v1/machines/managed/controller/report', { ...correlation, result: { kind: 'pending', nativeOperationRef } });
            expect(reported.statusCode, reported.body).toBe(200);
            expect(reported.json()).toMatchObject({ machine: { creationState: 'canceled', allocation: 'may-exist', nativeOperationRef,
                desired: 'delete', intentRevision: 1, cleanup: { disposition: 'pending' } } });
            const invalidHandle = await post('/v1/machines/managed/controller/report', { ...correlation,
                result: { kind: 'pending', nativeOperationRef: { ...nativeOperationRef, value: { ...nativeOperationRef.value, undeclared: true } } } });
            expect(invalidHandle.statusCode, invalidHandle.body).toBe(409);
            expect(invalidHandle.json()).toEqual({ code: 'resource_mismatch' });
            expect((await post('/v1/machines/managed/controller/submit', correlation)).statusCode).toBe(401);
            expect((await post('/v1/machines/managed/controller/report', { ...correlation, result: { kind: 'rejected', code: 'provider_unavailable' } })).statusCode).toBe(401);
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            expect((await post('/v1/machines/managed/controller/report', { ...correlation, result: { kind: 'pending', nativeOperationRef } })).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('recovers the original rebuild tuple through fresh Inspector Home authentication after its Session origin retires', async () => {
        const { fixture, homeId, controller, input } = await createManagedNativeAuthFixture(true);
        const creationRequestId = crypto.randomUUID();
        const created = await admitManagedAcquire({ requesterAccountId: fixture.account.id, custodianAccountId: fixture.account.id,
            requestEnvelopeDigest: 'reviewed-auth-rebuild-acquire', input: { input, requestId: creationRequestId, continuationPresent: false } });
        const creation = { homeId, managedId: created.machine.id, expectedIntentRevision: 0, requestId: creationRequestId, controller };
        await submitManagedAcquire(creation);
        const observation = (nativeResourceId: string) => ({ nativeResourceId, user: 'coder', workspaceFolder: '/workspace',
            storage: { kind: 'bind' as const, hostPath: '/host/workspace', childPath: '/workspace' } });
        const previous = { contributionRef: input.selection.launch.provider, schemaVersion: 1,
            value: { id: 'a'.repeat(64) }, devcontainerObservation: observation('a'.repeat(64)) };
        const replacement = { ...previous, value: { id: 'b'.repeat(64) }, devcontainerObservation: observation('b'.repeat(64)) };
        await reportManagedAcquire({ ...creation, result: { kind: 'bound', resource: previous } });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true, lastActiveAt: new Date() } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: controller.machineId, sessionId: session.id, data: 'source-key' } });
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'rebuild-source-turn', callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: crypto.randomUUID() });
        const rebuildInput = { homeId, managedMachineId: created.machine.id, expectedRevision: 0, kind: 'rebuild' as const, reviewedEffectDigest: 'd'.repeat(64) };
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: origin.requestId,
            target: { kind: 'machine', machineId: controller.machineId }, input: rebuildInput });
        const actionId = 'machines.managed.rebuild';
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...controller, externalActionOrigin: { homeId, actionId,
                requestId: origin.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as import('@/app/api/types').Fastify;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate('resolveCurrentSessionMachine', async () => controller.machineId);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
        registerManagedMachineRoutes(app);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const post = (authorization: { token: string }, effectActionId: string, path: string, body: InjectOptions['payload']) => app.inject({ method: 'POST', url: path, payload: body,
            headers: machineHeaders({ authorizationToken: authorization.token, effectActionId, method: 'POST', path, body, privateKey: fixture.keyPair.secretKey }) });
        const remember = (authorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>) => {
            authorizationRequests.set(authorization.token, { target: authorization.binding.target,
                installationId: controller.installationId, requestId: authorization.binding.requestId });
            return authorization;
        };
        try {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId,
                    envelope, sessionActionOrigin: origin, sessionActionSource: controller, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const rebuild = remember(ExternalActionExecutionAuthorizationV1Schema.parse(minted.json()));
            const admitted = await post(rebuild, actionId, '/v1/machines/managed/controller/admit-control',
                { action: actionId, requestId: origin.requestId, input: rebuildInput });
            expect(admitted.statusCode, admitted.body).toBe(200);
            const correlation = { ...creation, expectedIntentRevision: 1, requestId: origin.requestId };
            const submitted = await post(rebuild, actionId, '/v1/machines/managed/controller/submit-intent', correlation);
            expect(submitted.statusCode, submitted.body).toBe(200);
            await db.accessKey.deleteMany({ where: { accountId: fixture.account.id, machineId: controller.machineId, sessionId: session.id } });
            const report = { ...correlation, result: { kind: 'bound', resource: replacement } };
            expect((await post(rebuild, actionId, '/v1/machines/managed/controller/report-intent', report)).statusCode).toBe(401);
            const unresolved = await db.managedMachine.findUniqueOrThrow({ where: { id: created.machine.id } });
            expect(unresolved).toMatchObject({ resource: previous, admittedInput: { submittedEffect: {
                requestId: origin.requestId, expectedIntentRevision: 1, intent: 'rebuild', reviewedEffectDigest: rebuildInput.reviewedEffectDigest,
            } } });
            const inspectorEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: controller.machineId }, input: { homeId, managedId: created.machine.id } });
            const inspectorMint = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.inspect'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: controller.machineId, envelope: inspectorEnvelope } });
            expect(inspectorMint.statusCode, inspectorMint.body).toBe(200);
            const inspector = remember(ExternalActionExecutionAuthorizationV1Schema.parse(inspectorMint.json()));
            const current = await post(inspector, 'machines.managed.inspect', '/v1/machines/managed/controller/current', { ...correlation, nativeRole: 'inspect' });
            expect(current.statusCode, current.body).toBe(200);
            expect(current.json()).toMatchObject({ machine: { resource: previous, submittedNativeEffect: {
                requestId: origin.requestId, intentRevision: 1, intent: 'rebuild', reviewedEffectDigest: rebuildInput.reviewedEffectDigest,
            } } });
            const recovered = await post(inspector, 'machines.managed.inspect', '/v1/machines/managed/controller/report-intent', report);
            expect(recovered.statusCode, recovered.body).toBe(200);
            expect(recovered.json()).toMatchObject({ machine: { resource: replacement } });
            expect(recovered.json().machine).not.toHaveProperty('submittedNativeEffect');
            expect(recovered.json().machine).not.toHaveProperty('enrolledMachineId');
            expect(await db.managedMachine.count({ where: { id: created.machine.id } })).toBe(1);
        } finally { await app.close(); }
    });

    it('does not widen an already admitted PAT grant when issuing its later execution authorization', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['machines.managed.acquire'] } };
        const principal = (await auth.verifyTokenForRoute(fixture.pat.token))?.apiTokenPrincipal;
        if (!principal) throw new Error('Missing authenticated PAT fixture');
        // A previously admitted root retains its original grant even when the
        // credential's current row is broader at this later mint boundary.
        await expect(auth.mintExternalActionExecutionAuthorization({
            serverIdentityId: await getOrCreateServerIdentityId(), accountId: fixture.account.id,
            principalId: principal.principalId, credentialId: principal.credentialId, grant,
            machineId: fixture.machine.id, actionId: 'session.spawn_new', requestId: crypto.randomUUID(),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(fixture.envelope),
            target: { kind: 'machine', machineId: fixture.machine.id },
        })).rejects.toMatchObject({ code: 'credential_scope_denied' });
    });

    it.each([
        {
            actionId: "identity.providers.test.start",
            body: {
                owner: { kind: "home" },
                id: "missing-provider",
                expectedRevision: 1,
                expectedSecurityRevision: 1,
            },
            expectedStatus: 403,
            expectedDomainError: "identity_provider_forbidden",
        },
        {
            actionId: "teams.identity.connections.test.start",
            body: {
                v: 1,
                teamId: "team_missing",
                connectionId: "missing-connection",
                expectedRevision: 1,
            },
            expectedStatus: 404,
            expectedDomainError: "team_not_found",
        },
    ] as const)(
        "admits signed external PAT execution for Lane 03 action $actionId only as far as domain authorization",
        async ({ actionId, body, expectedStatus, expectedDomainError }) => {
            const fixture = await createFixture({ qualifiedPat: false });
            const { app } = await createRealLane03App();
            try {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse({
                    v: 1,
                    requestId: crypto.randomUUID(),
                    target: { kind: "machine", machineId: fixture.machine.id },
                    input: body,
                });
                const authorization = await mint(app, fixture, actionId, envelope);
                const transport = getActionSpec(actionId).serverTransport;
                if (!transport) throw new Error(`test Action ${actionId} has no server transport`);
                const response = await app.inject({
                    method: transport.method,
                    url: transport.path,
                    headers: machineHeaders({
                        authorizationToken: authorization.token,
                        target: authorization.binding.target,
                        effectActionId: actionId,
                        method: transport.method,
                        path: transport.path,
                        body,
                        privateKey: fixture.keyPair.secretKey,
                    }),
                    payload: body,
                });

                expect(response.json()).toEqual({ error: expectedDomainError });
                expect(response.statusCode).toBe(expectedStatus);
            } finally {
                await app.close();
            }
        },
    );

    it("keeps Lane 03 external Action admission at the canonical proof owner without route-local Action lists", async () => {
        const { app, duplicateExternalActionAdmissionRoutes } = await createRealLane03App();
        try {
            expect(duplicateExternalActionAdmissionRoutes).toEqual([]);
        } finally {
            await app.close();
        }
    });

    it("reconstructs the current PAT for one exact signed cross-Machine RPC and rejects substitution", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const method = `${fixture.machine.id}:daemon.mergedContributionRegistry.projection.describe`;
            const requestId = crypto.randomUUID();
            const params = { machineId: fixture.machine.id };
            const execution = {
                v: 1 as const,
                authorization,
                effectActionId: ACTION_ID,
                target: authorization.binding.target,
                installationId: fixture.machine.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: authorization.token,
                    effectActionId: ACTION_ID,
                    target: authorization.binding.target,
                    installationId: fixture.machine.installationId!,
                    event: SOCKET_RPC_EVENTS.CALL,
                    method,
                    requestId,
                    params,
                    privateKey: fixture.keyPair.secretKey,
                }),
            };

            const verified = await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params });
            expect(verified?.principal).toMatchObject({
                accountId: fixture.account.id,
                credentialId: fixture.pat.tokenId,
                authority: "account_automation",
            });
            for (const bindingPatch of [
                { accountId: "account-substituted" },
                { custodianAccountId: "custodian-substituted" },
                { installationId: "installation-substituted" },
                { principalId: "principal-substituted" },
                { credentialId: "credential-substituted" },
                { actionId: "teams.list" },
                { requestId: "request-substituted" },
                { requestEnvelopeDigest: "digest-substituted" },
                { accountEncryptionMode: 'e2ee' as const },
                { managedContinuation: { managedId: 'unrelated-managed', creationRequestId: 'unrelated-creation',
                    expectedIntentRevision: 0, controller: { machineId: fixture.machine.id, installationId: fixture.machine.installationId! },
                    acquireRequestEnvelopeDigest: authorization.binding.requestEnvelopeDigest } },
                { grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true } },
                { target: { kind: "machine" as const, machineId: "target-machine-substituted" } },
            ]) {
                await expect(verifyExternalActionMachineRpcExecution({
                    ...execution,
                    authorization: {
                        ...execution.authorization,
                        binding: {
                            ...execution.authorization.binding,
                            ...bindingPatch,
                        },
                    },
                }, { method, requestId, params })).resolves.toBeNull();
            }
            await expect(verifyExternalActionMachineRpcExecution({
                ...execution,
                effectActionId: "teams.list",
            }, { method, requestId, params })).resolves.toBeNull();
            await expect(verifyExternalActionMachineRpcExecution({
                ...execution,
                authorization: {
                    ...execution.authorization,
                    binding: {
                        ...execution.authorization.binding,
                        serverIdentityId: "srv_substituted_home",
                    },
                },
            }, { method, requestId, params })).resolves.toBeNull();
            await expect(verifyExternalActionMachineRpcExecution(execution, {
                method,
                requestId,
                params: { machineId: "substituted" },
            })).resolves.toBeNull();
            const otherMachineMethod = `other-machine:daemon.mergedContributionRegistry.projection.describe`;
            const otherMachineExecution = {
                ...execution,
                machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: authorization.token,
                    effectActionId: ACTION_ID,
                    target: authorization.binding.target,
                    installationId: fixture.machine.installationId!,
                    event: SOCKET_RPC_EVENTS.CALL,
                    method: otherMachineMethod,
                    requestId,
                    params,
                    privateKey: fixture.keyPair.secretKey,
                }),
            };
            await expect(verifyExternalActionMachineRpcExecution(otherMachineExecution, {
                method: otherMachineMethod,
                requestId,
                params,
            })).resolves.toMatchObject({
                principal: {
                    accountId: fixture.account.id,
                    credentialId: fixture.pat.tokenId,
                    authority: "account_automation",
                },
            });
            await expect(verifyExternalActionMachineRpcExecution({
                ...otherMachineExecution,
                authorization: {
                    ...otherMachineExecution.authorization,
                    binding: {
                        ...otherMachineExecution.authorization.binding,
                        machineId: "substituted-relay-machine",
                    },
                },
            }, {
                method: otherMachineMethod,
                requestId,
                params,
            })).resolves.toBeNull();
            await expect(verifyExternalActionMachineRpcExecution(otherMachineExecution, {
                method: `${otherMachineMethod}.substituted`,
                requestId,
                params,
            })).resolves.toBeNull();
        } finally {
            await app.close();
        }
    });

    it("binds protected input to the exact payload and persists the invocation's original constraints", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const session = await db.session.create({ data: {
            accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        await db.machine.update({ where: { accountId_id: { accountId: fixture.account.id, id: fixture.machine.id } },
            data: { operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id, data: "key" } });
        try {
            const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ["session.message.send" as const] },
                targets: { sessions: [session.id], machines: [] }, approve: false, permissionModes: ["default" as const] };
            const issued = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: "input", grant });
            const principal = (await auth.verifyTokenForRoute(issued.token))?.apiTokenPrincipal;
            if (!principal) throw new Error("Missing authenticated test principal");
            const target = { kind: "session" as const, sessionId: session.id };
            const authorization = await auth.mintExternalActionExecutionAuthorization({
                serverIdentityId: await getOrCreateServerIdentityId(), accountId: principal.accountId,
                principalId: principal.principalId, credentialId: principal.credentialId, grant,
                machineId: fixture.machine.id, actionId: "session.message.send", requestId: crypto.randomUUID(),
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, target, input: { text: "input" } }), target,
            });
            await auth.updateApiToken({ accountId: fixture.account.id, tokenId: principal.credentialId, grant: API_TOKEN_FULL_GRANT_V1 });
            const request = { v: 1 as const, sessionId: session.id, targetMachineId: fixture.machine.id, localId: "protected-input",
                content: { t: "plain" as const, v: { role: "user", content: { type: "text", text: "input" } } },
                requestedAction: { v: 1 as const, kind: "enqueue" as const } };
            const externalAction = { v: 1 as const, authorization, target, effectActionId: "session.message.send",
                installationId: fixture.machine.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: authorization.token, target, effectActionId: "session.message.send",
                    installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId,
                    event: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, method: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
                    params: request, privateKey: fixture.keyPair.secretKey,
                }) };
            const socket = createAuthenticatedFakeSocket({ nsp: { server: createSocketRoomDiscoveryHarness(async () => []) }, data: { clientType: "machine-scoped", machineId: fixture.machine.id,
                verifiedMachineInstallationId: fixture.machine.installationId } });
            // Only the Socket.IO transport is a fixture; proof verification and durable admission remain real.
            machineUpdateHandler(fixture.account.id, socket as unknown as Socket, {
                operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
            });
            const invoke = getSocketHandler(socket, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1);
            let response: unknown;
            await invoke({ ...request, localId: "substituted", externalAction }, (value: unknown) => { response = value; });
            expect(response).toMatchObject({ result: { status: "rejected", code: "session_input_unauthorized" } });
            expect(await db.sessionPendingMessage.findFirst({ where: { sessionId: session.id } })).toBeNull();
            await invoke({ ...request, externalAction }, (value: unknown) => { response = value; });
            expect(response).toMatchObject({ result: { status: "accepted", localId: request.localId } });
            expect(await db.sessionPendingMessage.findFirst({ where: { sessionId: session.id, localId: request.localId } }))
                .toMatchObject({ inputAdmissionReceipt: { issuer: "authenticatedMachine",
                    callerInputConstraints: { models: null, permissionModes: ["default"] } } });
        } finally {
            await db.sessionPendingMessage.deleteMany({ where: { sessionId: session.id } });
            await db.accessKey.deleteMany({ where: { sessionId: session.id } });
        }
    });

    it.each(['account', 'api_token'] as const)('admits only the installed transition first-input packet under its original %s root', async credential => {
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: {
            accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } });
        await db.machine.update({ where: { accountId_id: { accountId: fixture.account.id, id: fixture.machine.id } },
            data: { operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id, data: 'key' } });
        const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.agent.transition' as const] },
            targets: { sessions: [session.id], machines: [fixture.machine.id] }, permissionModes: ['default' as const] };
        const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'transition', grant });
        const token = credential === 'account'
            ? await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' }) : pat.token;
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, { ...fixture, pat: { ...pat, token } }, 'session.agent.transition', {
                ...fixture.envelope, input: { sessionId: session.id, expectedCurrentAgentId: 'claude',
                    selection: { v: 1, agentId: 'codex' }, input: { text: 'continue', localId: 'transition-first-input' } },
            });
            if (credential === 'api_token') await auth.updateApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId, grant: API_TOKEN_FULL_GRANT_V1 });
            const request = { v: 1 as const, sessionId: session.id, targetMachineId: fixture.machine.id, localId: 'transition-first-input',
                content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'continue' } } },
                requestedAction: { v: 1 as const, kind: 'send_now' as const } };
            const target = { kind: 'session' as const, sessionId: session.id };
            const sign = (params: unknown, event = SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, signingTarget = target) => ({
                v: 1 as const, authorization, target: signingTarget, effectActionId: 'session.message.send',
                installationId: fixture.machine.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: authorization.token, target: signingTarget, effectActionId: 'session.message.send',
                    installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId,
                    event, method: event, params, privateKey: fixture.keyPair.secretKey,
                }),
            });
            const socket = createAuthenticatedFakeSocket({ nsp: { server: createSocketRoomDiscoveryHarness(async () => []) }, data: { clientType: 'machine-scoped', machineId: fixture.machine.id,
                verifiedMachineInstallationId: fixture.machine.installationId } });
            // Only Socket.IO is replaced: installed proof, root currentness and durable custody remain real.
            machineUpdateHandler(fixture.account.id, socket as unknown as Socket, {
                operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
            });
            const invoke = getSocketHandler(socket, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1);
            let response: unknown;
            const proof = sign(request);
            for (const packet of [
                { ...request, localId: 'forged-input', externalAction: proof },
                { ...request, externalAction: { ...proof, authorization: undefined } },
                { ...request, externalAction: { ...proof, machineSignature: 'A'.repeat(86) } },
                { ...request, externalAction: sign(request, SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, { kind: 'session', sessionId: 'wrong-session' }) },
                { ...request, requestedAction: { v: 1, kind: 'reset_start' }, externalAction: proof },
            ]) {
                await invoke(packet, (value: unknown) => { response = value; });
                expect(response).toMatchObject({ result: { status: 'rejected' } });
                expect(await db.sessionPendingMessage.findFirst({ where: { sessionId: session.id } })).toBeNull();
            }
            const wrongPurpose = { ...request, requestedAction: { v: 1 as const, kind: 'steer_if_active' as const } };
            await invoke({ ...wrongPurpose, externalAction: sign(wrongPurpose) }, (value: unknown) => { response = value; });
            expect(response).toMatchObject({ result: { status: 'rejected', code: 'session_input_unauthorized' } });
            await invoke({ ...request, externalAction: proof }, (value: unknown) => { response = value; });
            expect(response).toMatchObject({ result: { status: 'accepted', localId: request.localId } });
            const row = await db.sessionPendingMessage.findFirst({ where: { sessionId: session.id, localId: request.localId } });
            expect(row).toMatchObject({ inputAdmissionReceipt: { issuer: 'authenticatedMachine',
                ...(credential === 'api_token' ? { callerInputConstraints: { models: null, permissionModes: ['default'] } } : {}) } });
            if (credential === 'account') await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
            else await auth.updateApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId,
                grant: { ...grant, actions: { families: [], ids: ['session.message.send'] } } });
            await invoke({ ...request, externalAction: proof }, (value: unknown) => { response = value; });
            expect(response).toMatchObject({ result: { status: 'rejected', code: 'session_input_unauthorized' } });
        } finally {
            await app.close();
            await db.sessionPendingMessage.deleteMany({ where: { sessionId: session.id } });
            await db.accessKey.deleteMany({ where: { sessionId: session.id } });
        }
    });

    it.each(['account', 'api_token'] as const)('retains ordinary ancestor transcript access without widening an exact-Session transition %s grant', async credential => {
        const fixture = await createFixture({ qualifiedPat: false });
        const [session, ancestor] = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
        } })));
        const { app } = await createApp(fixture.team.id);
        const token = credential === 'account'
            ? await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' }) : fixture.pat.token;
        try {
            const authorization = await mint(app, { ...fixture, pat: { ...fixture.pat, token } }, 'session.agent.transition', {
                ...fixture.envelope, input: { sessionId: session.id, expectedCurrentAgentId: 'claude',
                    selection: { v: 1, agentId: 'codex' }, input: { text: 'continue', localId: 'transition-first-input' } },
            });
            const rootTarget = { kind: 'session' as const, sessionId: session.id };
            const read = async (captured = authorization, requestedSessionId = ancestor.id) => {
                const path = `/v1/sessions/${requestedSessionId}/messages?afterSeq=0&limit=10`;
                return app.inject({ method: 'GET', url: path, headers: machineHeaders({
                    authorizationToken: captured.token, effectActionId: 'session.agent.transition', target: rootTarget,
                    method: 'GET', path, body: undefined, privateKey: fixture.keyPair.secretKey,
                }) });
            };
            expect((await read()).statusCode).toBe(200);
            const foreignAccount = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
            const foreignSession = await db.session.create({ data: { accountId: foreignAccount.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
            expect((await read(authorization, foreignSession.id)).statusCode).toBe(404);
            if (credential === 'api_token') {
                const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.agent.transition' as const] },
                    targets: { sessions: [session.id], machines: [] } };
                const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'exact-session', grant });
                const principal = (await auth.verifyTokenForRoute(pat.token))?.apiTokenPrincipal;
                if (!principal) throw new Error('Missing authenticated test principal');
                const exactEnvelope = { ...fixture.envelope, requestId: crypto.randomUUID(), target: rootTarget,
                    input: { sessionId: session.id, expectedCurrentAgentId: 'claude', selection: { v: 1, agentId: 'codex' },
                        input: { text: 'continue', localId: 'transition-first-input' } } };
                const exact = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: authorization.binding.serverIdentityId,
                    accountId: fixture.account.id, principalId: principal.principalId, credentialId: principal.credentialId, grant,
                    machineId: fixture.machine.id, actionId: 'session.agent.transition', requestId: exactEnvelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(exactEnvelope), target: rootTarget });
                authorizationRequests.set(exact.token, { target: rootTarget, installationId: fixture.machine.installationId!, requestId: exact.binding.requestId });
                expect((await read(exact, session.id)).statusCode).toBe(200);
                expect((await read(exact)).statusCode).toBe(401);
                await auth.updateApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId, grant: API_TOKEN_FULL_GRANT_V1 });
                expect((await read(exact)).statusCode).toBe(401);
                const machineGrant = { ...grant, targets: { sessions: [], machines: [fixture.machine.id] } };
                const machinePat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'machine-scope', grant: machineGrant });
                const machinePrincipal = (await auth.verifyTokenForRoute(machinePat.token))?.apiTokenPrincipal;
                if (!machinePrincipal) throw new Error('Missing authenticated Machine-scoped principal');
                const machineRoot = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: authorization.binding.serverIdentityId,
                    accountId: fixture.account.id, principalId: machinePrincipal.principalId, credentialId: machinePrincipal.credentialId, grant: machineGrant,
                    machineId: fixture.machine.id, actionId: 'session.agent.transition', requestId: exactEnvelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(exactEnvelope), target: rootTarget });
                authorizationRequests.set(machineRoot.token, { target: rootTarget, installationId: fixture.machine.installationId!, requestId: machineRoot.binding.requestId });
                expect((await read(machineRoot)).statusCode).toBe(401);
                const accessKey = await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
                    sessionId: ancestor.id, data: 'key' } });
                expect((await read(machineRoot)).statusCode).toBe(200);
                await db.accessKey.delete({ where: { id: accessKey.id } });
                expect((await read(machineRoot)).statusCode).toBe(401);
            }
        } finally { await app.close(); }
    });

    it.each(['plain', 'e2ee'] as const)('captures persisted %s Account mode in the production PAT transition issuer and private carrier', async mode => {
        const { encodeStoredCredentials } = await importTestModule<{
            encodeStoredCredentials(credentials: TestStoredCredentials): Parameters<typeof sealExternalActionRequesterAccountContextV1>[0]['credentials'];
        }>('../../../../../../cli/src/persistence');
        const fixture = await createFixture({ qualifiedPat: false });
        await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: mode } });
        const principal = (await auth.verifyTokenForRoute(fixture.pat.token))?.apiTokenPrincipal;
        if (!principal) throw new Error('Missing authenticated PAT principal');
        const root = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: await getOrCreateServerIdentityId(),
            accountId: principal.accountId, principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant,
            machineId: fixture.machine.id, actionId: 'session.agent.transition', requestId: fixture.envelope.requestId!,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(fixture.envelope), target: fixture.envelope.target! });
        expect(root.binding.accountEncryptionMode).toBe(mode);
        const purpose = { kind: 'external_action' as const };
        const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root,
            credentials: encodeStoredCredentials({ token: fixture.pat.token, encryption: mode === 'plain' ? null
                : { type: 'legacy', secret: tweetnacl.randomBytes(32) } }),
            invocation: { caller: { kind: 'host' }, surface: 'api', authority: 'account_automation' }, purpose,
            installationPublicKey: fixture.keyPair.publicKey, randomBytes: tweetnacl.randomBytes });
        expect(openExternalActionRequesterAccountContextV1({ authorization: sealed, purpose, machineId: fixture.machine.id,
            installationId: fixture.machine.installationId!, installationPrivateKey: fixture.keyPair.secretKey,
            serverIdentityId: root.binding.serverIdentityId })?.token).toBe(fixture.pat.token);
        await db.account.update({ where: { id: fixture.account.id }, data: { encryptionMode: mode === 'plain' ? 'e2ee' : 'plain' } });
        expect(await verifyCurrentExternalActionPrincipal(root.binding)).toBeNull();
    });

    it.each(['account', 'api_token'] as const)('relays the verified transition %s root into the actual Session fence receiver', async credential => {
        const [{ RpcHandlerManager }, { prepareRequesterAccountActionContext }, { createCliActionExecutorFromCredentials },
            { verifyExternalActionExecutionAuthorizationCurrent }, { encodeStoredCredentials }] = await Promise.all([
            importTestModule<{ RpcHandlerManager: new (options: unknown) => {
                registerHandler(method: string, handler: (request: unknown,
                    context?: Pick<SocketRpcRequestPayload, 'callerInputAuthorization' | 'callerAuthority' | 'callerInputConstraints'>) => unknown): void;
                handleRequest(request: SocketRpcRequestPayload): Promise<unknown>;
            } }>('../../../../../../cli/src/api/rpc/RpcHandlerManager'),
            importTestModule<{ prepareRequesterAccountActionContext(input: unknown): Promise<unknown> }>(
                '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection'),
            importTestModule<{ createCliActionExecutorFromCredentials(input: unknown):
                NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountExecutor']> }>(
                '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials'),
            importTestModule<{ verifyExternalActionExecutionAuthorizationCurrent(input: Readonly<{
                authorization: ExternalActionExecutionAuthorizationV1; effectActionId: string;
                target: ExternalActionExecutionAuthorizationV1['binding']['target']; installationId: string;
                privateKey: Uint8Array; serverHttpBaseUrl: string; signal?: AbortSignal;
            }>): Promise<boolean> }>('../../../../../../cli/src/api/externalActionExecutionAuthorization'),
            importTestModule<{ encodeStoredCredentials(credentials: TestStoredCredentials):
                Parameters<typeof sealExternalActionRequesterAccountContextV1>[0]['credentials'] }>('../../../../../../cli/src/persistence'),
        ]);
        const fixture = await createFixture({ qualifiedPat: false });
        const session = await db.session.create({ data: { accountId: fixture.account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id, data: 'key' } });
        const presence = createSessionPublisherPresence();
        const serverHttpBaseUrl = 'https://transition-home.test';
        const receiver = new RpcHandlerManager({ scopePrefix: session.id, localMachineId: fixture.machine.id, encryptionMode: 'plain', logger: () => {},
            ...(credential === 'api_token' ? { authorizeRequest: async ({ callerInputAuthorization, signal }: Readonly<{
                callerInputAuthorization?: ExternalActionExecutionAuthorizationV1; signal?: AbortSignal;
            }>) => {
                if (!callerInputAuthorization || callerInputAuthorization.binding.machineId !== fixture.machine.id
                    || callerInputAuthorization.binding.installationId !== fixture.machine.installationId) return { ok: false as const, error: 'Installed transition root unavailable' };
                const current = await verifyExternalActionExecutionAuthorizationCurrent({ authorization: callerInputAuthorization,
                    effectActionId: callerInputAuthorization.binding.actionId, target: callerInputAuthorization.binding.target,
                    installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey, serverHttpBaseUrl, signal });
                return current ? { ok: true as const } : { ok: false as const, error: 'Transition root no longer current' };
            } } : {}),
            ...(credential === 'account' ? {
            prepareRequesterAccountContext: async ({ authorization, purpose, signal }: TestRequesterPreparation) => prepareRequesterAccountActionContext({
                authorization, purpose: purpose ?? { kind: 'external_action' }, machineId: fixture.machine.id,
                installationId: fixture.machine.installationId!, installationPrivateKey: fixture.keyPair.secretKey,
                serverId: 'transition-home', serverIdentityId: authorization.binding.serverIdentityId, serverHttpBaseUrl, signal,
                isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization,
                    effectActionId: authorization.binding.actionId, target: authorization.binding.target,
                    installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey, serverHttpBaseUrl, signal }),
                createExecutor: (admitted: TestAdmittedRequester) => createCliActionExecutorFromCredentials({ credentials: admitted.credentials, serverId: 'transition-home',
                    serverApiUrl: serverHttpBaseUrl, serverIdentityId: authorization.binding.serverIdentityId, machineId: fixture.machine.id,
                    externalActionMachineInstallationId: fixture.machine.installationId!, externalActionMachineRequestPrivateKey: fixture.keyPair.secretKey,
                    readCredentials: async () => await admitted.isCurrent() ? admitted.credentials : null,
                    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
                        getAccountSettings: () => admitted.accountSettingsContext.settings },
                }),
            }),
            } : {}),
        });
        receiver.registerHandler(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, async (_request, context) => ({
            rootActionId: context?.callerInputAuthorization?.binding.actionId,
            rootAccountId: context?.callerInputAuthorization?.binding.accountId,
            callerAuthority: context?.callerAuthority,
            constraints: context?.callerInputConstraints,
        }));
        let delivered: SocketRpcRequestPayload | undefined;
        // Only Socket.IO delivery is replaced: the relay producer and CLI receiver remain real.
        const publisher = { id: `transition-publisher-${credential}`, data: {}, timeout: () => ({
            emitWithAck: async (_event: string, request: SocketRpcRequestPayload) => {
                delivered = request;
                return await receiver.handleRequest(request);
            },
        }) };
        expect((await presence.registerPublisher({ socket: publisher,
            binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
        const method = `${session.id}:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`;
        const io = createSocketRoomDiscoveryHarness(async room => room === `rpc:${fixture.account.id}:${method}`
            || room === publisher.id || room === getAccountSessionSocketRoom(fixture.account.id, session.id) ? [publisher] : []);
        const { app } = await createApp(fixture.team.id);
        const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            const response = await app.inject({ method: 'GET', url: new URL(String(url)).pathname,
                headers: config?.headers as Record<string, string> });
            return { status: response.statusCode, data: response.json() };
        });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, payload, config) => {
            const response = await app.inject({ method: 'POST', url: new URL(String(url)).pathname,
                headers: config?.headers as Record<string, string>, payload });
            return { status: response.statusCode, data: response.json() };
        });
        const currentnessChannel = await createRequesterCurrentnessSocketHarness();
        try {
            const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.agent.transition' as const] },
                targets: { sessions: [session.id], machines: [fixture.machine.id] }, permissionModes: ['default' as const] };
            const pat = await auth.createApiToken({ accountId: fixture.account.id, tokenId: crypto.randomUUID(), label: 'fence', grant });
            const originalToken = credential === 'account' ? await auth.createToken(fixture.account.id, undefined,
                { kind: 'account', authority: 'present_user' }) : pat.token;
            if (!originalToken) throw new Error('Original caller credential unavailable');
            const root = await mint(app, { ...fixture, pat: { ...pat, token: originalToken } }, 'session.agent.transition', {
                ...fixture.envelope, input: { sessionId: session.id, expectedCurrentAgentId: 'claude', selection: { v: 1, agentId: 'codex' },
                    input: { text: 'continue', localId: 'first-input' } },
            });
            if (credential === 'api_token') await auth.updateApiToken({ accountId: fixture.account.id, tokenId: pat.tokenId, grant: API_TOKEN_FULL_GRANT_V1 });
            const target = { kind: 'session' as const, sessionId: session.id };
            const params = { action: 'enforce', serviceId: 'session.agentTransition', groupId: 'group', epochId: 'epoch' };
            const authorization = credential === 'api_token' ? root : sealExternalActionRequesterAccountContextV1({ authorization: root,
                credentials: encodeStoredCredentials({ token: originalToken, encryption: null }),
                invocation: { caller: { kind: 'plugin', pluginId: 'happier.agent.codex', contributionLocalId: 'automation' },
                    surface: 'plugin', authority: 'account_automation', callerInputConstraints: { models: null, permissionModes: ['default'] },
                    workspaceWrites: 'deny',
                    defaultSessionId: session.id },
                purpose: { kind: 'machine_rpc', method: SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, params },
                installationPublicKey: fixture.keyPair.publicKey, randomBytes: tweetnacl.randomBytes });
            const execution = { v: 1 as const, authorization, effectActionId: 'session.agent.transition', target,
                installationId: fixture.machine.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'session.agent.transition', target,
                    requesterAccountContext: authorization.requesterAccountContext,
                    installationId: fixture.machine.installationId!, event: SOCKET_RPC_EVENTS.CALL,
                    method, requestId: authorization.binding.requestId, params, privateKey: fixture.keyPair.secretKey,
                }) };
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, params, requestId: authorization.binding.requestId })).not.toBeNull();
            const ambientAuthority = 'present_user';
            const ambientToken = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: ambientAuthority });
            const socket = Object.assign(createFakeSocket({ id: `transition-caller-${credential}`, data: { clientType: 'machine-scoped',
                machineId: fixture.machine.id, verifiedMachineInstallationId: fixture.machine.installationId,
                authTokenKind: 'account', authAuthority: ambientAuthority } }), { handshake: { auth: { token: ambientToken,
                    ...currentAccountStoredContentCompatibilitySocketAuth } } });
            qualifyCurrentAccountStoredContentSocket(socket);
            registerSocketRpcHandlers({ userId: fixture.account.id, socket: socket as unknown as Socket, io, sessionPublisherPresence: presence });
            const callback = vi.fn();
            if (credential === 'account') {
            const reboxedHost = sealExternalActionRequesterAccountContextV1({ authorization: root,
                credentials: encodeStoredCredentials({ token: originalToken, encryption: null }),
                invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user', defaultSessionId: session.id },
                purpose: { kind: 'machine_rpc', method: SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, params },
                installationPublicKey: fixture.keyPair.publicKey, randomBytes: tweetnacl.randomBytes });
            // A public installation key can rebox known credentials, but cannot
            // replace the signed private Plugin ceiling with host authority.
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: authorization.binding.requestId, params,
                externalActionExecution: { ...execution, authorization: reboxedHost } }, callback);
            expect(delivered).toBeUndefined();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            callback.mockClear();
            }
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: authorization.binding.requestId, params,
                externalActionExecution: execution }, callback);
            expect(delivered?.callerInputAuthorization).toEqual(authorization);
            expect(delivered?.callerAuthority).toBe(credential === 'account' ? 'present_user' : 'account_automation');
            expect(callback).toHaveBeenCalledWith({ ok: true, result: { rootActionId: 'session.agent.transition', rootAccountId: fixture.account.id,
                callerAuthority: 'account_automation', constraints: { models: null, permissionModes: ['default'] } } });
            delivered = undefined;
            const otherMachine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: fixture.account.id,
                metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey ? new Uint8Array(fixture.machine.dataEncryptionKey) : null,
                installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey) } });
            await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: otherMachine.id, sessionId: session.id, data: 'other-key' } });
            expect((await presence.registerPublisher({ socket: publisher,
                binding: { accountId: fixture.account.id, machineId: otherMachine.id, sessionId: session.id },
                completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
            callback.mockClear();
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method, requestId: authorization.binding.requestId, params,
                externalActionExecution: execution }, callback);
            expect(delivered).toBeUndefined();
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        } finally { await currentnessChannel.close(); get.mockRestore(); post.mockRestore(); await app.close(); }
    });

    it('bounds transition phase proofs to the named Session lifecycle and cutover purposes', async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const { app } = await createApp(fixture.team.id);
        try {
            const sessionId = 'transition-session';
            const authorization = await mint(app, fixture, 'session.agent.transition', {
                ...fixture.envelope, input: { sessionId, expectedCurrentAgentId: 'claude',
                    selection: { v: 1, agentId: 'codex' }, input: { text: 'continue', localId: 'transition-first-input' } },
            });
            const target = { kind: 'session' as const, sessionId };
            const verifyRpc = (method: string, params: unknown, signingTarget = target) => {
                const execution = { v: 1 as const, authorization, effectActionId: 'session.agent.transition', target: signingTarget,
                    installationId: fixture.machine.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                        authorizationToken: authorization.token, target: signingTarget, effectActionId: 'session.agent.transition',
                        installationId: fixture.machine.installationId!, requestId: authorization.binding.requestId,
                        method, params, privateKey: fixture.keyPair.secretKey,
                    }) };
                return verifyExternalActionMachineRpcExecution(execution, { method, params, requestId: authorization.binding.requestId });
            };
            const fence = { action: 'enforce', serviceId: 'session.agentTransition', groupId: 'group', epochId: 'epoch' };
            expect(await verifyRpc(`${sessionId}:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`, fence)).not.toBeNull();
            expect(await verifyRpc(`${fixture.machine.id}:${RPC_METHODS.STOP_SESSION}`, { sessionId })).not.toBeNull();
            for (const method of [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE]) {
                expect(await verifyRpc(`${fixture.machine.id}:${method}`, { type: 'resume-session', sessionId, directory: '/workspace' })).not.toBeNull();
                expect(await verifyRpc(`${fixture.machine.id}:${method}`, { type: 'spawn-in-directory', directory: '/workspace' })).toBeNull();
                expect(await verifyRpc(`${fixture.machine.id}:${method}`, { type: 'resume-session', sessionId: 'other', directory: '/workspace' })).toBeNull();
            }
            expect(await verifyRpc(`${sessionId}:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`, { ...fence, serviceId: 'other' })).toBeNull();
            expect(await verifyRpc(`${fixture.machine.id}:${RPC_METHODS.STOP_SESSION}`, { sessionId: 'other' })).toBeNull();
            expect(await verifyRpc(`other-machine:${RPC_METHODS.STOP_SESSION}`, { sessionId })).toBeNull();
            expect(await verifyRpc(`${fixture.machine.id}:${RPC_METHODS.SPAWN_HAPPY_SESSION}`, 'sealed-resume')).not.toBeNull();
            expect(await verifyRpc(`${fixture.machine.id}:${RPC_METHODS.STOP_SESSION}`, { sessionId }, { kind: 'session', sessionId: 'other' })).toBeNull();
            const verifyHttp = (method: string, path: string, body?: unknown) => verifyExternalActionDomainExecutionRequest({
                authorizationToken: authorization.token, effectActionId: 'session.agent.transition',
                encodedTarget: encodeExternalActionResolvedTargetV1(target), method, path, body,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'session.agent.transition', target, installationId: fixture.machine.installationId!,
                    requestId: authorization.binding.requestId, method, path, body, privateKey: fixture.keyPair.secretKey }),
            });
            expect(await verifyHttp('GET', `/v2/sessions/${sessionId}`)).not.toBeNull();
            expect(await verifyHttp('GET', `/v1/machines/${fixture.machine.id}`)).not.toBeNull();
            expect(await verifyHttp('GET', '/v1/account/encryption/currentness')).not.toBeNull();
            expect(await verifyHttp('POST', `/v2/sessions/${sessionId}/agent-transition/cutover`, { v: 1 })).not.toBeNull();
            expect(await verifyHttp('POST', `/v2/sessions/${sessionId}/pending`, { localId: 'unrelated' })).toBeNull();
            expect(await verifyHttp('POST', `/v1/sessions/${sessionId}/archive`, {})).toBeNull();
            expect(await verifyHttp('POST', '/v2/sessions/other/agent-transition/cutover', { v: 1 })).toBeNull();
            expect(await verifyHttp('GET', '/v1/machines/other')).toBeNull();
        } finally { await app.close(); }
    });

    it("uses the originating PAT evidence rather than daemon ambient qualification", async () => {
        const qualified = await createFixture({ qualifiedPat: true });
        const qualifiedRoute = await createApp(qualified.team.id);
        try {
            const authorization = await mint(qualifiedRoute.app, qualified);
            const body = createTeamPolicyInput(qualified.team.id);
            const response = await qualifiedRoute.app.inject({
                method: qualifiedRoute.transport.method,
                url: qualifiedRoute.transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: qualifiedRoute.transport.method,
                    path: qualifiedRoute.transport.path,
                    body,
                    privateKey: qualified.keyPair.secretKey,
                }),
                payload: body,
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                qualification: "satisfied",
                rootActionId: ACTION_ID,
                effectActionId: ACTION_ID,
                target: authorization.binding.target,
                principal: {
                    accountId: qualified.account.id,
                    principalId: qualified.account.id,
                    credentialId: qualified.pat.tokenId,
                    authority: "account_automation",
                    authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }],
                },
            });
        } finally {
            await qualifiedRoute.app.close();
        }

        const unqualified = await createFixture({ qualifiedPat: false });
        const unqualifiedRoute = await createApp(unqualified.team.id);
        try {
            const authorization = await mint(unqualifiedRoute.app, unqualified);
            const body = createTeamPolicyInput(unqualified.team.id);
            const response = await unqualifiedRoute.app.inject({
                method: unqualifiedRoute.transport.method,
                url: unqualifiedRoute.transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: unqualifiedRoute.transport.method,
                    path: unqualifiedRoute.transport.path,
                    body,
                    privateKey: unqualified.keyPair.secretKey,
                }),
                payload: body,
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ qualification: "authentication_required" });
        } finally {
            await unqualifiedRoute.app.close();
        }
    });

    it.each([
        { requiredProvider: "github", expectedStatus: 401 },
        { requiredProvider: "not-configured", expectedStatus: 503 },
    ])("revalidates current Home login eligibility before accepting a signed PAT effect ($requiredProvider)", async ({ requiredProvider, expectedStatus }) => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app, transport } = await createApp(fixture.team.id);
        const previous = process.env.AUTH_REQUIRED_LOGIN_PROVIDERS;
        try {
            const authorization = await mint(app, fixture);
            // The fixture has an email identity only. A registered provider can
            // establish ineligibility; an absent provider leaves evidence unavailable.
            process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = requiredProvider;
            const body = createTeamPolicyInput(fixture.team.id);
            const response = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: transport.method,
                    path: transport.path,
                    body,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: body,
            });
            expect(response.statusCode).toBe(expectedStatus);
        } finally {
            if (previous === undefined) delete process.env.AUTH_REQUIRED_LOGIN_PROVIDERS;
            else process.env.AUTH_REQUIRED_LOGIN_PROVIDERS = previous;
            await app.close();
        }
    });

    it("binds the proof to the exact body, route, Machine, current PAT, and current evidence row", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app, transport } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const body = createTeamPolicyInput(fixture.team.id);
            const validHeaders = machineHeaders({
                authorizationToken: authorization.token,
                target: authorization.binding.target,
                method: transport.method,
                path: transport.path,
                body,
                privateKey: fixture.keyPair.secretKey,
            });

            const tamperedBody = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: validHeaders,
                payload: { teamId: "another-team" },
            });
            expect(tamperedBody.statusCode).toBe(401);

            const wrongRoute = await app.inject({
                method: "POST",
                url: bindExternalActionExecutionAuthorizationVerifyHttpPathV1("teams.list"),
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: "POST",
                    path: bindExternalActionExecutionAuthorizationVerifyHttpPathV1("teams.list"),
                    body: { v: 1 },
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: { v: 1 },
            });
            expect(wrongRoute.statusCode).toBe(401);

            const otherKey = tweetnacl.sign.keyPair();
            await db.machine.create({
                data: {
                    id: crypto.randomUUID(),
                    accountId: fixture.account.id,
                    metadata: "substitute",
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    installationId: crypto.randomUUID(),
                    installationPublicKey: new Uint8Array(otherKey.publicKey),
                },
            });
            const wrongMachine = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: transport.method,
                    path: transport.path,
                    body,
                    privateKey: otherKey.secretKey,
                }),
                payload: body,
            });
            expect(wrongMachine.statusCode).toBe(401);

            const originalInstallationId = fixture.machine.installationId!;
            await db.machine.update({
                where: { id: fixture.machine.id },
                data: { installationId: crypto.randomUUID() },
            });
            const replacedInstallation = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: validHeaders,
                payload: body,
            });
            expect(replacedInstallation.statusCode).toBe(401);
            await db.machine.update({
                where: { id: fixture.machine.id },
                data: { installationId: originalInstallationId },
            });

            await db.accountApiToken.update({
                where: { id: fixture.pat.tokenId },
                data: { authenticationEvidence: { v: 1, evidence: [] } },
            });
            const evidenceChanged = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: validHeaders,
                payload: body,
            });
            expect(evidenceChanged.statusCode).toBe(200);
            expect(evidenceChanged.json()).toMatchObject({ qualification: "authentication_required" });

            await auth.revokeApiToken({ accountId: fixture.account.id, tokenId: fixture.pat.tokenId });
            const revoked = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: validHeaders,
                payload: body,
            });
            expect(revoked.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it("keeps the authorization useless without the exact registered Machine signature and preserves allowed bearer admission", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app, transport } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const body = createTeamPolicyInput(fixture.team.id);

            const tokenOnly = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token },
                payload: body,
            });
            expect(tokenOnly.statusCode).toBe(401);

            const rawPat = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: body,
            });
            expect(rawPat.statusCode).toBe(200);

            const accountToken = await auth.createToken(fixture.account.id, undefined, {
                kind: "account",
                authority: "present_user",
            });
            const ordinary = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: { authorization: `Bearer ${accountToken}` },
                payload: body,
            });
            expect(ordinary.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });

    it("admits a signed auxiliary production read without treating Action serverTransport as a route allowlist", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const path = "/v1/features/authenticated";
            const response = await app.inject({
                method: "GET",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: "GET",
                    path,
                    body: undefined,
                    privateKey: fixture.keyPair.secretKey,
                }),
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ capabilities: { serverIdentity: {} } });
        } finally {
            await app.close();
        }
    });

    it("admits the real Follow source-list handler from the exact signed PAT invocation without a duplicate route allowlist", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const destination = await db.session.create({
            data: {
                tag: `external-follow-destination-${crypto.randomUUID()}`,
                accountId: fixture.account.id,
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                metadata: JSON.stringify({ v: 1 }),
                ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                agentState: null,
            },
        });
        const { app } = await createApp(fixture.team.id);
        try {
            const actionId = "follow.list";
            const envelope: ExternalActionRequestEnvelopeV1 = {
                v: 1,
                requestId: crypto.randomUUID(),
                target: { kind: "machine", machineId: fixture.machine.id },
                input: { direction: 'following', receiver: { kind: 'session', sessionId: destination.id } },
            };
            const authorization = await mint(app, fixture, actionId, envelope);
            const path = `/v2/sessions/${destination.id}/follows/sessions`;
            const response = await app.inject({
                method: "GET",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    effectActionId: actionId,
                    method: "GET",
                    path,
                    body: undefined,
                    privateKey: fixture.keyPair.secretKey,
                }),
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ sources: [] });
        } finally {
            await app.close();
        }
    });

    it("admits the proof-bound PAT through normal handlers while handler-specific effect, target, resource, and revocation checks stay closed", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const now = Date.now();
        const [activeSession, archivedSession] = await Promise.all([
            db.session.create({
                data: {
                    tag: `external-list-active-${crypto.randomUUID()}`,
                    accountId: fixture.account.id,
                    encryptionMode: "plain",
                    metadataLayoutVersion: 1,
                    metadata: JSON.stringify({ v: 1 }),
                    ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                    agentState: null,
                    active: true,
                    lastActiveAt: new Date(now),
                    meaningfulActivityAt: new Date(now),
                    currentStorageState: "hosted",
                },
            }),
            db.session.create({
                data: {
                    tag: `external-list-archived-${crypto.randomUUID()}`,
                    accountId: fixture.account.id,
                    encryptionMode: "plain",
                    metadataLayoutVersion: 1,
                    metadata: JSON.stringify({ v: 1 }),
                    ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                    agentState: null,
                    active: false,
                    archivedAt: new Date(now - 1_000),
                    meaningfulActivityAt: new Date(now - 1_000),
                },
            }),
        ]);
        const foreignAccount = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const foreignSession = await db.session.create({
            data: {
                tag: `external-list-foreign-${crypto.randomUUID()}`,
                accountId: foreignAccount.id,
                encryptionMode: "plain",
                metadataLayoutVersion: 1,
                metadata: JSON.stringify({ v: 1 }),
                ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                agentState: null,
            },
        });
        await db.sessionMessage.create({
            data: {
                sessionId: activeSession.id,
                localId: `external-list-preview-${crypto.randomUUID()}`,
                seq: 1,
                messageRole: "user",
                content: {
                    t: "plain",
                    v: {
                        role: "user",
                        content: { type: "text", text: "signed session.list preview" },
                    },
                },
                inputAdmissionReceipt: {
                    v: 1,
                    issuer: "authenticatedAccount",
                    actorAccountId: fixture.account.id,
                    sessionRelationship: "owner",
                },
            },
        });
        const { app } = await createApp(fixture.team.id);
        try {
            const envelope: ExternalActionRequestEnvelopeV1 = {
                v: 1,
                requestId: crypto.randomUUID(),
                target: { kind: "machine", machineId: fixture.machine.id },
                input: {},
            };
            const authorization = await mint(app, fixture, "session.list", envelope);
            const signedGet = (
                path: string,
                effectActionId = "session.list",
                target: ExternalActionRequestEnvelopeV1["target"] = authorization.binding.target,
            ) => app.inject({
                method: "GET",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target,
                    effectActionId,
                    method: "GET",
                    path,
                    body: undefined,
                    privateKey: fixture.keyPair.secretKey,
                }),
            });
            const signedPost = (
                path: string,
                body: unknown,
                effectActionId = "session.list",
            ) => app.inject({
                method: "POST",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    effectActionId,
                    method: "POST",
                    path,
                    body,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: body,
            });
            const previewPath = `/v1/sessions/${activeSession.id}/messages?limit=1&scope=main&roles=user%2Cagent`;
            const filteredPath = "/v2/sessions/query";
            const filteredBody = {
                v: 1,
                storage: "active",
                includeInactive: true,
                scope: "all_accessible",
                attention: "any",
                audiences: [],
                tagIds: [],
            } as const;
            const [legacyListed, listed, active, archived, detail, filtered, currentness, previewMessages] = await Promise.all([
                signedGet("/v1/sessions"),
                signedGet("/v2/sessions?limit=10"),
                signedGet("/v2/sessions/active?limit=10"),
                signedGet("/v2/sessions/archived?limit=10"),
                signedGet(`/v2/sessions/${activeSession.id}`),
                signedPost(filteredPath, filteredBody),
                signedGet("/v1/account/encryption/currentness"),
                signedGet(previewPath),
            ]);
            expect(legacyListed.statusCode).toBe(200);
            expect(legacyListed.json().sessions.map((session: { id: string }) => session.id))
                .toContain(activeSession.id);
            expect(listed.statusCode).toBe(200);
            expect(listed.json().sessions.map((session: { id: string }) => session.id))
                .toContain(activeSession.id);
            expect(active.statusCode).toBe(200);
            expect(active.json().sessions.map((session: { id: string }) => session.id))
                .toEqual([activeSession.id]);
            expect(archived.statusCode).toBe(200);
            expect(archived.json().sessions.map((session: { id: string }) => session.id))
                .toEqual([archivedSession.id]);
            expect(detail.statusCode).toBe(200);
            expect(detail.json()).toMatchObject({ session: { id: activeSession.id } });
            expect(filtered.statusCode).toBe(200);
            expect(filtered.json().sessions.map((session: { id: string }) => session.id))
                .toContain(activeSession.id);
            expect(currentness.statusCode).toBe(200);
            expect(currentness.json()).toMatchObject({ mode: "plain" });
            expect(previewMessages.statusCode).toBe(200);
            expect(previewMessages.json()).toEqual({
                messages: [{
                    id: expect.any(String),
                    seq: 1,
                    localId: expect.any(String),
                    messageRole: "user",
                    content: {
                        t: "plain",
                        v: {
                            role: "user",
                            content: { type: "text", text: "signed session.list preview" },
                        },
                    },
                    createdAt: expect.any(Number),
                    updatedAt: expect.any(Number),
                }],
                hasMore: false,
                nextBeforeSeq: null,
                nextAfterSeq: null,
            });

            for (const path of [
                "/v1/sessions",
                "/v2/sessions?limit=10",
                "/v2/sessions/active?limit=10",
                "/v2/sessions/archived?limit=10",
                "/v1/account/encryption/currentness",
            ]) {
                const raw = await app.inject({
                    method: "GET",
                    url: path,
                    headers: { ...currentAccountStoredContentCompatibilityHeaders,
                        authorization: `Bearer ${fixture.pat.token}` },
                });
                expect(raw.statusCode, path).toBe(403);
                expect(raw.json(), path).toEqual({ error: "present_user_required" });
            }
            // Full PATs may read a named accessible Session directly; only the
            // Account-wide surfaces above still require proof-bound admission.
            for (const path of [`/v2/sessions/${activeSession.id}`, previewPath]) {
                const raw = await app.inject({ method: "GET", url: path, headers: {
                    ...currentAccountStoredContentCompatibilityHeaders,
                    authorization: `Bearer ${fixture.pat.token}`,
                } });
                expect(raw.statusCode, raw.body).toBe(200);
            }
            const rawFiltered = await app.inject({
                method: "POST",
                url: filteredPath,
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: filteredBody,
            });
            expect(rawFiltered.statusCode).toBe(403);
            const [
                accountSettings,
                accountEncryption,
                alternateEffectListing,
                alternateEffectPreview,
                previewSidechainTraversal,
                previewCursorTraversal,
                previewOversizedRead,
                previewNarrowedRole,
                previewOutsideSessionTarget,
                inaccessibleSessionPreview,
                alternateEffectFiltered,
            ] = await Promise.all([
                signedGet("/v2/account/settings"),
                signedGet("/v1/account/encryption"),
                signedGet("/v2/sessions?limit=10", ACTION_ID),
                signedGet(previewPath, ACTION_ID),
                signedGet(`/v1/sessions/${activeSession.id}/messages?limit=1&scope=all&roles=user%2Cagent`),
                signedGet(`/v1/sessions/${activeSession.id}/messages?limit=1&afterSeq=0&scope=main&roles=user%2Cagent`),
                signedGet(`/v1/sessions/${activeSession.id}/messages?limit=2&scope=main&roles=user%2Cagent`),
                signedGet(`/v1/sessions/${activeSession.id}/messages?limit=1&scope=main&roles=user`),
                signedGet(previewPath, "session.list", { kind: "session", sessionId: archivedSession.id }),
                signedGet(`/v1/sessions/${foreignSession.id}/messages?limit=1&scope=main&roles=user%2Cagent`),
                signedPost(filteredPath, filteredBody, ACTION_ID),
            ]);
            expect(accountSettings.statusCode, accountSettings.body).toBe(200);
            expect(accountEncryption.statusCode, accountEncryption.body).toBe(200);
            expect(alternateEffectListing.statusCode).toBe(401);
            expect(alternateEffectPreview.statusCode).toBe(401);
            expect(previewSidechainTraversal.statusCode).toBe(403);
            expect(previewCursorTraversal.statusCode).toBe(403);
            expect(previewOversizedRead.statusCode).toBe(403);
            expect(previewNarrowedRole.statusCode).toBe(403);
            expect(previewOutsideSessionTarget.statusCode).toBe(401);
            expect(inaccessibleSessionPreview.statusCode).toBe(404);
            expect(alternateEffectFiltered.statusCode).toBe(401);

            // A collection has no named operand at which to enforce a captured
            // resource ceiling. It cannot spend a scoped root as Account-wide access.
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
                ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.list'] },
                targets: { sessions: [activeSession.id], machines: [fixture.machine.id] },
            } } });
            const scoped = await mint(app, fixture, 'session.list', envelope);
            const scopedRead = (path: string, body?: unknown) => app.inject({ method: body === undefined ? 'GET' : 'POST',
                url: path, ...(body === undefined ? {} : { payload: body }), headers: machineHeaders({
                    authorizationToken: scoped.token, effectActionId: 'session.list', method: body === undefined ? 'GET' : 'POST',
                    path, body, privateKey: fixture.keyPair.secretKey,
                }) });
            expect((await scopedRead(`/v2/sessions/${activeSession.id}`)).statusCode).toBe(200);
            expect((await scopedRead('/v2/sessions?limit=10')).statusCode).toBe(401);
            expect((await scopedRead(filteredPath, filteredBody)).statusCode).toBe(401);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: API_TOKEN_FULL_GRANT_V1 } });
            expect((await scopedRead('/v2/sessions?limit=10')).statusCode).toBe(401);
            expect((await scopedRead(`/v2/sessions/${archivedSession.id}`)).statusCode).toBe(401);

            await auth.revokeApiToken({
                accountId: fixture.account.id,
                tokenId: fixture.pat.tokenId,
            });
            expect((await signedGet("/v2/sessions?limit=10")).statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it("rejects an unmatched signed mutation before the present-user domain handler", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const path = "/test/present-user-only";
            const body = { operation: "interactive-only" };
            const response = await app.inject({
                method: "POST",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: "POST",
                    path,
                    body,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: body,
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "invalid_token" });
        } finally {
            await app.close();
        }
    });

    it("lets the ordinary Session handler deny a signed resolved target the originating PAT cannot read", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const foreignAccount = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const foreignSession = await db.session.create({
            data: {
                tag: crypto.randomUUID(),
                accountId: foreignAccount.id,
                encryptionMode: "plain",
                metadata: "foreign",
                metadataVersion: 1,
            },
        });
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture, 'widgets.catalog.list', { ...fixture.envelope, input: {
                surface: { serverId: await getOrCreateServerIdentityId(), accountId: fixture.account.id,
                    owner: { kind: 'sessionBoard', sessionId: foreignSession.id } },
            } });
            const path = `/v2/sessions/${foreignSession.id}`;
            const target = { kind: "session" as const, sessionId: foreignSession.id };
            const response = await app.inject({
                method: "GET",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target,
                    effectActionId: 'widgets.catalog.list',
                    method: "GET",
                    path,
                    body: undefined,
                    privateKey: fixture.keyPair.secretKey,
                }),
            });

            expect(response.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it("rechecks the same authorization and Machine at the signed currentness endpoint", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            const authorization = await mint(app, fixture);
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(ACTION_ID);
            const body = { v: 1, admittedMachineRole: authorization.binding.admittedMachineRole } as const;
            const unsigned = await app.inject({ method: "POST", url: path, payload: body });
            expect(unsigned.statusCode).toBe(401);
            const headers = machineHeaders({
                authorizationToken: authorization.token,
                target: authorization.binding.target,
                method: "POST",
                path,
                body,
                privateKey: fixture.keyPair.secretKey,
            });
            const current = await app.inject({ method: "POST", url: path, headers, payload: body });
            expect(current.statusCode).toBe(200);
            expect(current.json()).toEqual({ ok: true });

            const queryPath = `${path}?bypass=1`;
            const queryBypass = await app.inject({
                method: "POST",
                url: queryPath,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: "POST",
                    path: queryPath,
                    body,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: body,
            });
            expect(queryBypass.statusCode).toBe(401);

            const invalidBody = { v: 1, unexpected: true };
            const invalid = await app.inject({
                method: "POST",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: "POST",
                    path,
                    body: invalidBody,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: invalidBody,
            });
            expect(invalid.statusCode).toBe(401);

            await db.machine.update({ where: { id: fixture.machine.id }, data: { revokedAt: new Date() } });
            const revokedMachine = await app.inject({ method: "POST", url: path, headers, payload: body });
            expect(revokedMachine.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it.each(['cli', 'ui'] as const)('replays an explicit %s Workflow approval against its retained Home root once', async surface => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const serverId = 'retained-approval-home';
        const machineId = fixture.machine.id;
        const runId = crypto.randomUUID();
        const directory = '/home/controller/project';
        const target = { kind: 'machine' as const, machineId, project: { machineId, directory } };
        const sourceInput = { serverId: { kind: 'literal', value: homeId },
            requestKey: { kind: 'literal', value: runId }, name: { kind: 'literal', value: 'Reviewed Source' },
            audience: { kind: 'literal', value: [] }, repository: { kind: 'literal', value: {
                provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'happier-dev/happier' }, protocol: 'https',
            } } };
        const actionArgs = { runId, source: { kind: 'inline', definition: { version: 1, defaults: {}, inputs: [],
            blocks: ['first', 'second'].map(id => ({ kind: 'action', id, actionId: 'projects.sources.create', input: sourceInput })) } } };
        const input = { actionId: 'workflow.run.start', actionArgs, summary: 'Start reviewed Workflow', createdBy: { surface: 'cli' } };
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, artifactsRoutes);
        try {
            const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
            const authorization = await mint(app, fixture, 'approval.request.create', {
                v: 1, requestId: crypto.randomUUID(), target, input,
            }, token);
            await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
                const credentials = { token, encryption: null };
                const artifacts = createCliApprovalsArtifactStore({ credentials, serverId });
                const current = createDaemonApprovalExecutionOriginCurrentness({ accountId: fixture.account.id, machineId, serverId,
                    resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: homeId }),
                    resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
                    isAccountCurrent: async () => (await fetchAccountProfile({ token })).id === fixture.account.id,
                    listAccountApiTokens: async () => ({ tokens: [] }), externalActionMachinePublicKey: fixture.keyPair.publicKey,
                    verifyExternalExecutionAuthorization: args => verifyExternalActionExecutionAuthorizationCurrent({ ...args,
                        privateKey: fixture.keyPair.secretKey, installationId: fixture.machine.installationId!, serverHttpBaseUrl }),
                });
                const unexpected = (): never => { throw new Error('Unexpected saved-definition storage access'); };
                // Opaque Run/definition storage and workspace preparation are system boundaries;
                // Home auth, signatures, approval persistence/CAS and Workflow admission stay real.
                const definitions = createWorkflowDefinitionActions({ artifactStore: { read: unexpected, list: unexpected,
                    create: unexpected, update: unexpected, delete: unexpected }, encodeListCursor: unexpected,
                    assertDefinitionWriteAllowed: unexpected });
                const storage = createWorkflowRunStorageTestkit({ runId, machineId, accountId: fixture.account.id, origin: { kind: 'direct' } });
                const runs = createWorkflowRunActionOwner({ storage, definitions, resolveAccountId: async () => fixture.account.id,
                    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
                    resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
                        readActionContract: async actionId => {
                            const parsed = ActionIdSchema.safeParse(actionId);
                            return parsed.success ? freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(parsed.data))) : null;
                        },
                    } }),
                    prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId, directory, checkoutRootPath: directory } } }),
                });
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...artifacts,
                    isApprovalExecutionOriginCurrent: current,
                    workflowAction: createWorkflowActionExecutor({ definitions, runs, isWorkflowFeatureEnabled: async () => true }),
                });
                expect(await executor.execute('approval.request.create', input, {
                    surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId, serverIdentityId: homeId,
                    runtimeAccountId: fixture.account.id, defaultSessionMachineId: machineId,
                    actionRequestId: authorization.binding.requestId, externalActionTarget: target,
                    externalActionExecutionAuthorization: authorization,
                    signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ ...args,
                        authorizationToken: args.authorization.token, privateKey: fixture.keyPair.secretKey }),
                })).toMatchObject({ ok: true });
                const pending = await artifacts.approvalsList({ serverId });
                const artifactId = pending.items[0]?.artifactId;
                if (!artifactId) throw new Error('Expected stored Workflow approval');
                const request = ApprovalRequestV2Schema.parse(await artifacts.approvalsGet({ artifactId, serverId }));
                expect(request.executionOriginV1.target).toEqual(target);
                const reasons: string[] = [];
                expect(await current({ origin: request.executionOriginV1, request, reportStale: reason => reasons.push(reason) }),
                    JSON.stringify(reasons)).toBe(true);
                const decide = () => executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
                    surface, authority: 'present_user', actionCaller: { kind: 'host' }, serverId,
                    serverIdentityId: homeId, runtimeAccountId: fixture.account.id,
                });
                expect(await decide()).toMatchObject({ ok: true });
                const executed = ApprovalRequestV2Schema.parse(await artifacts.approvalsGet({ artifactId, serverId }));
                expect(executed.execution?.ok, executed.execution?.errorCode).toBe(true);
                expect(executed.status).toBe('executed');
                expect(storage.acceptedEnvelope()).not.toBeNull();
                expect(storage.calls.filter(call => call.operation === 'admit')).toHaveLength(1);
                await decide();
                expect(storage.calls.filter(call => call.operation === 'admit')).toHaveLength(1);
                await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
                expect(await current({ origin: request.executionOriginV1, request })).toBe(false);
            });
        } finally { await app.close(); }
    });

    it("rejects a deferred authorization after grant narrowing without undoing an already executed effect", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const app = await createRealTeamApp();
        try {
            const authorization = await mint(app, fixture, 'approval.request.create');
            const transport = getActionSpec(ACTION_ID).serverTransport;
            if (!transport) throw new Error('test Action has no server transport');
            const body = { v: 1, teamId: fixture.team.id, previousAuthenticationPolicy: fixture.team.authenticationPolicy,
                authenticationPolicy: { v: 1, mode: 'inherit' } };
            const headers = machineHeaders({ authorizationToken: authorization.token, target: authorization.binding.target,
                method: transport.method, path: transport.path, body, privateKey: fixture.keyPair.secretKey });
            const executed = await app.inject({ method: transport.method, url: transport.path, headers, payload: body });
            expect(executed.statusCode, executed.body).toBe(200);
            expect((await db.team.findUniqueOrThrow({ where: { id: fixture.team.id } })).authenticationPolicy).toBeNull();
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
                accessGrant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.transcript.get'] } },
            } });
            const replay = await app.inject({ method: transport.method, url: transport.path, headers, payload: body });
            expect(replay.statusCode, replay.body).toBe(401);
            expect((await db.team.findUniqueOrThrow({ where: { id: fixture.team.id } })).authenticationPolicy).toBeNull();
            const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('approval.request.create');
            const currentnessBody = { v: 1 };
            const deferred = await app.inject({ method: 'POST', url: path, payload: currentnessBody,
                headers: machineHeaders({ authorizationToken: authorization.token, target: authorization.binding.target,
                    method: 'POST', path, body: currentnessBody, privateKey: fixture.keyPair.secretKey }) });
            expect(deferred.statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it("refuses daemon-local minting outside the current Session grant and admits its named Session", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
                accessGrant: { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ['S1'], machines: [] } },
            } });
            const request = (sessionId: string) => app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('session.message.send'),
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope: { ...fixture.envelope,
                    target: { kind: 'session', sessionId } } } });
            const refused = await request('S2');
            expect(refused.statusCode, refused.body).toBe(403);
            expect(refused.json()).toMatchObject({ error: 'credential_scope_denied' });
            const admitted = await request('S1');
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(admitted.json()).binding.target)
                .toEqual({ kind: 'session', sessionId: 'S1' });
        } finally { await app.close(); }
    });

    it("refuses an ungranted relay Session before transport and attenuates verified machine membership without rewriting grants", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        await db.machine.update({ where: { id: fixture.machine.id }, data: {
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
        } });
        const fence = new Date();
        const presence = createSessionPublisherPresence();
        const publishers: { sessionId: string; socket: { data: Record<string, unknown> } }[] = [];
        for (const sessionId of ['S1', 'S2']) {
            await db.session.create({ data: { id: sessionId, accountId: fixture.account.id, tag: sessionId,
                metadata: '{}', active: true, lastActiveAt: fence } });
            await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
                sessionId, data: 'encrypted' } });
            const socket = { data: {} as Record<string, unknown> };
            expect((await presence.registerPublisher({ socket,
                binding: { accountId: fixture.account.id, machineId: fixture.machine.id, sessionId },
                completeActivitySnapshot: { state: 'active', activeCount: 1 } })).status).toBe('registered');
            publishers.push({ sessionId, socket });
        }
        // Only Socket.IO discovery and the daemon transport are simulated; current publisher,
        // credential, grant, placement and persistence decisions remain the real owners.
        let publisherVisible = true;
        const io = { in: (room: string) => ({ fetchSockets: async () => publisherVisible
            ? publishers.filter(({ sessionId }) => room === getAccountSessionSocketRoom(fixture.account.id, sessionId))
                .map(({ socket }) => socket)
            : [] }) } as unknown as Server;
        const sentSessions: string[] = [];
        const dispatch = createExternalActionDaemonDispatcher({ io, sessionPublisherPresence: presence,
            forwardRpc: async ({ callParams }) => {
                const request = callParams as { actionId: string; envelope: ExternalActionRequestEnvelopeV1 };
                if (request.envelope.target?.kind === 'session') sentSessions.push(request.envelope.target.sessionId);
                return { ok: true, result: createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                    v: 1, actionId: request.actionId, requestId: request.envelope.requestId,
                    execution: { ok: true, result: { accepted: true } },
                })) };
            } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as any;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerExternalActionRoutes(app, { dispatch });
        await app.ready();
        try {
            const grant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ['S1'], machines: [] } };
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: grant } });
            const relay = (sessionId: string) => app.inject({ method: 'POST', url: '/v1/actions/session.message.send',
                headers: { authorization: `Bearer ${fixture.pat.token}` }, payload: { ...fixture.envelope,
                    target: { kind: 'session', sessionId } } });
            const refused = await relay('S2');
            expect(refused.statusCode, refused.body).toBe(403);
            expect(refused.json()).toEqual({ error: 'credential_scope_denied' });
            expect(sentSessions).toEqual([]);
            const admitted = await relay('S1');
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(sentSessions).toEqual(['S1']);

            const machineGrant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [], machines: [fixture.machine.id] } };
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: machineGrant } });
            const parent = await auth.verifyPat(fixture.pat.token);
            if (!parent.ok) throw new Error('fixture credential was not verified');
            const childGrant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ['S1'], machines: [] } };
            const mintChild = () => auth.createChildApiToken({ principal: parent, tokenId: crypto.randomUUID(), label: 'Session',
                expiresAt: new Date(Date.now() + 60_000), grant: childGrant,
                resolveSessionMachine: (sessionId) => resolveCurrentSessionMachineFromServer({
                    io, presence, accountId: fixture.account.id, sessionId,
                }) });
            const child = await mintChild();
            expect(child.grant).toEqual(childGrant);
            expect((await db.accountApiToken.findUniqueOrThrow({ where: { id: fixture.pat.tokenId } })).accessGrant).toEqual(machineGrant);
            publisherVisible = false;
            await expect(mintChild()).rejects.toMatchObject({ code: 'api_token_child_invalid' });
        } finally { await app.close(); }
    });

    it("admits Found download phases only under their current terminal root and exact signed body", async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const { app } = await createApp(fixture.team.id);
        const terminal = await auth.createToken(fixture.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        try {
            for (const actionId of ['skills.found.read', 'skills.found.adopt'] as const) {
                const target = { kind: 'machine' as const, machineId: fixture.machine.id };
                const path = '/home/controller/.agents/skills/native';
                const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target,
                    input: actionId === 'skills.found.read' ? { machineId: fixture.machine.id, path }
                        : { machineId: fixture.machine.id, items: [{ name: 'native', path }] } };
                const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${terminal}` }, payload: { v: 1, machineId: fixture.machine.id, envelope } });
                expect(issued.statusCode, issued.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
                expect(authorization.binding).toMatchObject({ actionId, target, authentication: { kind: 'terminal' } });
                for (const [rpc, params] of [
                    [RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, { path, recipientPublicKeyBase64: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64') }],
                    [RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK, { downloadId: 'download', index: 0 }],
                    [RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE, { downloadId: 'download' }],
                    [RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT, { downloadId: 'download' }],
                ] as const) {
                    const method = `${fixture.machine.id}:${rpc}`, requestId = crypto.randomUUID();
                    const signed = (effectActionId: string = actionId, signedMethod = method) => ({ v: 1 as const, authorization, effectActionId, target,
                        installationId: fixture.machine.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                            authorizationToken: authorization.token, effectActionId, target, installationId: fixture.machine.installationId!,
                            event: SOCKET_RPC_EVENTS.CALL, method: signedMethod, requestId, params, privateKey: fixture.keyPair.secretKey }) });
                    expect(await verifyExternalActionMachineRpcExecution(signed(), { method, requestId, params }), rpc)
                        .toMatchObject({ effectActionId: actionId });
                    expect(await verifyExternalActionMachineRpcExecution(signed(), { method, requestId, params: { ...params, substituted: true } })).toBeNull();
                    expect(await verifyExternalActionMachineRpcExecution(signed('skills.list'), { method, requestId, params })).toBeNull();
                    const otherMachineMethod = `another-machine:${rpc}`;
                    expect(await verifyExternalActionMachineRpcExecution(signed(actionId, otherMachineMethod), { method: otherMachineMethod, requestId, params })).toBeNull();
                }
            }
        } finally { await app.close(); }
    });

    it("reads and adopts Found skill bytes through signed encrypted Home RPC and real Account storage", async () => {
        const fixture = await createFixture({ qualifiedPat: false });
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const terminal = await auth.createToken(fixture.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const credentials = { token, encryption: null } as const;
        const home = join(harness.baseDir, fixture.machine.id);
        const path = join(home, '.agents', 'skills', 'native');
        const markdown = '---\nname: native\ndescription: Native seam fixture\n---\nRead the diff.\n';
        const script = '#!/bin/sh\nprintf native\n';
        await mkdir(join(path, 'scripts'), { recursive: true });
        await writeFile(join(path, 'SKILL.md'), markdown);
        await writeFile(join(path, 'scripts', 'run.sh'), script);
        await chmod(join(path, 'scripts', 'run.sh'), 0o755);
        const agents = [{ agentId: 'codex', nativeRoots: { user: [['.agents', 'skills']] } }];
        const scan = await scanNativeSkillRoots({ purpose: 'found', home, agents });
        expect(scan.items).toMatchObject([{ name: 'native', path, agents: ['codex'] }]);
        await db.machine.update({ where: { id: fixture.machine.id }, data: { active: true, lastActiveAt: new Date() } });
        const { app } = await createApp(fixture.team.id, false, undefined, undefined, false, routes => {
            artifactsRoutes(routes);
            registerPromptLibraryRoutes(routes);
        });
        const io = new SocketServer(app.server, { path: '/v1/updates' });
        // The network boundary verifies real credentials and installation proof;
        // registration, relay admission, handler execution and storage remain real.
        io.use((socket, next) => {
            void (async () => {
                const verified = await auth.verifyTokenForRoute(socket.handshake.auth.token);
                if (!verified || verified.userId !== fixture.account.id) return next(new Error('Unauthorized'));
                socket.data = { userId: verified.userId, authTokenKind: verified.authTokenKind,
                    authAuthority: verified.authority, authTokenAuthenticationEvidence: verified.authenticationEvidence,
                    clientType: socket.handshake.auth.clientType, machineId: socket.handshake.auth.machineId };
                qualifyCurrentAccountStoredContentSocket(socket);
                if (socket.data.clientType === 'machine-scoped') {
                    const installationId = resolveVerifiedMachineSocketInstallationId({ accountId: fixture.account.id,
                        machineId: fixture.machine.id, machine: fixture.machine, socketAuth: socket.handshake.auth });
                    if (!installationId) return next(new Error('Invalid installation'));
                    socket.data.verifiedMachineInstallationId = installationId;
                    await socket.join(getMachineSocketRoom(verified.userId, fixture.machine.id));
                }
                next();
            })().catch(next);
        });
        io.on('connection', socket => registerSocketRpcHandlers({ userId: fixture.account.id, socket, io }));
        eventRouter.setIo(io);
        const origin = await app.listen({ port: 0, host: '127.0.0.1' });
        const key = new Uint8Array(randomBytes(32));
        const content: SocketRpcContent = { mode: 'e2ee', cipher: {
            encryptRaw: async value => encodeBase64(encryptRpc(key, 'dataKey', value), 'base64'),
            decryptRaw: async ciphertext => decryptRpc(key, 'dataKey', decodeBase64(ciphertext, 'base64')),
        } };
        const rpcDiagnostics: unknown[] = [];
        const manager = new RpcHandlerManager({ scopePrefix: fixture.machine.id, localMachineId: fixture.machine.id,
            encryptionMode: 'e2ee', encryptionKey: key, encryptionVariant: 'dataKey',
            logger: (message, diagnostic) => { if (message === '[RPC] Request completed') rpcDiagnostics.push(diagnostic); },
            authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: fixture.machine.id,
                resolveInstallationId: () => fixture.machine.installationId,
                resolveCustodianAccountId: async () => fixture.account.id,
                verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: fixture.keyPair.secretKey,
                    daemonToken: token, serverHttpBaseUrl: origin }),
            }),
        });
        const transfers = registerMachinePromptAssetTransferRpcHandlers({ rpcHandlerManager: manager,
            adapterRegistry: new Map(), foundSkills: { home, agents } });
        const prepared = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
        registerMachinePreparedTransferRpcHandlers({ rpcHandlerManager: manager, request: prepared.requestPreparedTransfer });
        registerMachineDirectTransferExportRpcHandlers({ rpcHandlerManager: manager,
            prepareExportSession: async (input, _scope, context) => {
                if (input.t !== 'prompt_asset_download_v1') throw new Error('Expected Found export request');
                return await prepareFoundSkillExport({ lifecycle: prepared, request: { path: input.path }, signal: context?.signal });
            },
            releaseExportSession: (transferId, scope) => { prepared.clearPublishedTransfer(transferId, scope); },
        });
        const machine = connectSocket(origin, { path: '/v1/updates', transports: ['websocket'], autoConnect: false, reconnection: false,
            auth: { token, clientType: 'machine-scoped', machineId: fixture.machine.id, installationId: fixture.machine.installationId,
                installationPublicKey: encodeRpcBase64(fixture.keyPair.publicKey, 'base64url'),
                installationProof: signMachineInstallationProof({ payload: { version: 1, machineId: fixture.machine.id,
                    installationId: fixture.machine.installationId!, accountId: fixture.account.id }, privateKey: fixture.keyPair.secretKey }),
                ...currentAccountStoredContentCompatibilitySocketAuth } });
        const requester = connectSocket(origin, { path: '/v1/updates', transports: ['websocket'], autoConnect: false, reconnection: false,
            auth: { token, clientType: 'user-scoped', ...currentAccountStoredContentCompatibilitySocketAuth } });
        machine.on(SOCKET_RPC_EVENTS.REQUEST, (request, acknowledge) => { void manager.handleRequest(request).then(acknowledge); });
        machine.on('connect', () => manager.onSocketConnect(machine));
        machine.on('disconnect', () => manager.onSocketDisconnect());
        const connect = async (socket: typeof machine) => await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect();
        });
        const originalEnvironment = snapshotEnv();
        try {
            // HOME is the real OS boundary used by the production scanner. The
            // prepared producer uses the current Agent catalog without injection.
            applyEnvValues({ HOME: home, USERPROFILE: home });
            await Promise.all([connect(machine), connect(requester)]);
            const methods = [RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
                RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT];
            const preparedMethods = [RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
                RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT];
            expect(await manager.waitForRegisteredHandlers([...methods, ...preparedMethods,
                RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE],
                { timeoutMs: 10_000 })).toEqual({ status: 'ready' });
            const target = { kind: 'machine' as const, machineId: fixture.machine.id };
            let authorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>;
            let effectActionId: 'skills.found.read' | 'skills.found.adopt' | 'daemon.filesystem.download' = 'skills.found.read';
            const phases: string[] = [];
            const call = async (rpc: string, payload: unknown, tamper?: 'body' | 'root' | 'target') => {
                const method = `${fixture.machine.id}:${rpc}`, requestId = crypto.randomUUID(), callId = crypto.randomUUID().replaceAll('-', '');
                const params = await socketRpcCodec.encodeParams(content, payload, { method, callId });
                const signedEffect = tamper === 'root' ? 'skills.list' : effectActionId;
                const signedTarget = tamper === 'target' ? { kind: 'machine' as const, machineId: 'another-machine' } : target;
                const execution = { v: 1 as const, authorization, effectActionId: signedEffect, target: signedTarget, installationId: fixture.machine.installationId!,
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token, effectActionId: signedEffect, target: signedTarget,
                        installationId: fixture.machine.installationId!, event: SOCKET_RPC_EVENTS.CALL, method, requestId, params,
                        privateKey: fixture.keyPair.secretKey }) };
                const reply = await requester.timeout(20_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, { method, requestId,
                    params: tamper === 'body' ? await socketRpcCodec.encodeParams(content, { substituted: true }, { method, callId }) : params,
                    externalActionExecution: execution });
                if (tamper) { expect(reply).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' }); return; }
                phases.push(rpc);
                return await socketRpcCodec.decodeResult(content, reply, callId);
            };
            const preparedCall = async (payload: ReturnType<typeof PreparedTransferRpcRequestV1Schema.parse>) => {
                const parsed = PreparedTransferRpcRequestV1Schema.parse(payload);
                const method = resolvePreparedTransferRpcPhaseV1(parsed.path, parsed.httpMethod, parsed.body);
                if (!method) throw new Error('Expected a prepared download phase');
                const response = await call(method, parsed);
                expect(response, JSON.stringify({ response, diagnostic: rpcDiagnostics.at(-1) })).toHaveProperty('status');
                return PreparedTransferRpcResponseV1Schema.parse(response);
            };
            const fetchPrepared: typeof fetch = async (input, init) => {
                const request = new Request(input, init);
                const payload = PreparedTransferRpcRequestV1Schema.parse({ t: 'prepared_machine_transfer_v1',
                    path: new URL(request.url).pathname, httpMethod: request.method,
                    authorizationToken: request.headers.get('authorization')?.replace(/^Bearer /u, ''),
                    recipientPublicKeyBase64: request.headers.get(DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER) });
                const response = await preparedCall(payload);
                return new Response(response.body, { status: response.status,
                    headers: { 'content-type': response.contentType ?? 'application/json' } });
            };
            await runWithServerHttpBaseUrl(origin, async () => {
                const settings = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking' });
                expect(settings.source).toBe('network');
                const executor = createActionExecutor(createCliActionDeps({ token, credentials, serverId: 'found-seam',
                    serverIdentityId: await getOrCreateServerIdentityId(), serverHttpBaseUrl: origin, sessionId: '', mode: 'plain', ctx: null,
                    machineActionDirectTargetTransport: { machineId: fixture.machine.id, invoke: (rpc, payload) => call(rpc, payload) } }));
                for (const actionId of ['skills.found.read', 'skills.found.adopt'] as const) {
                    effectActionId = actionId;
                    const input = actionId === 'skills.found.read' ? { machineId: fixture.machine.id, path }
                        : { machineId: fixture.machine.id, items: [{ name: scan.items[0]!.name, path }] };
                    const issued = await fetch(`${origin}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, { method: 'POST',
                        headers: { authorization: `Bearer ${terminal}`, 'content-type': 'application/json' },
                        body: JSON.stringify({ v: 1, machineId: fixture.machine.id,
                            envelope: { v: 1, requestId: crypto.randomUUID(), target, input } }) });
                    expect(issued.status).toBe(200);
                    authorization = ExternalActionExecutionAuthorizationV1Schema.parse(await issued.json());
                    const recipient = createTransferRecipientKeyPair();
                    for (const tamper of ['root', 'target', 'body'] as const) {
                        await call(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, { path,
                            recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 }, tamper);
                        expect(transfers.downloadStore.listDownloadSessionIds()).toEqual([]);
                    }
                    const before = await db.artifact.count({ where: { accountId: fixture.account.id } });
                    const result = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user' });
                    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                    if (!result.ok) throw new Error('Expected Found Action completion');
                    if (actionId === 'skills.found.read') {
                        const bundle = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.read'].parse(result.result);
                        expect(bundle).toMatchObject({ name: 'native' });
                        expect(bundle.files).toEqual(expect.arrayContaining([
                            expect.objectContaining({ path: 'SKILL.md', contentBase64: encodeBase64(new TextEncoder().encode(markdown), 'base64') }),
                            expect.objectContaining({ path: 'scripts/run.sh', unixMode: 0o755 }),
                        ]));
                        expect(await db.artifact.count({ where: { accountId: fixture.account.id } })).toBe(before);
                    } else {
                        const adopted = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.adopt'].parse(result.result);
                        expect(adopted.skillIds).toHaveLength(1);
                        expect(adopted.incomplete).toBeUndefined();
                        expect(await db.artifact.count({ where: { accountId: fixture.account.id } })).toBe(before + 1);
                        const stored = createCliApprovalsArtifactStore({ credentials, serverId: 'found-seam', getAccountEncryptionMode: async () => 'plain' });
                        const copy = await stored.promptLibraryStore.read(adopted.skillIds[0]!);
                        expect(copy?.header).toMatchObject({ kind: 'prompt_bundle.v2', skillLock: {
                            provenance: { kind: 'machine', machineId: fixture.machine.id, path, agentIds: ['codex'] } } });
                        expect(copy?.body).toContain(encodeBase64(new TextEncoder().encode(script), 'base64'));
                        const ruleRead = await fetch(`${origin}${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`, {
                            headers: { authorization: `Bearer ${token}` } });
                        expect(ruleRead.status).toBe(200);
                        const ruleRow = PromptLibraryRowReadResponseV1Schema.parse(await ruleRead.json());
                        if (ruleRow.status !== 'present') throw new Error('Expected persisted adopted skill rules');
                        expect(openPromptLibraryContentV1({ key: 'skill-rules', mode: 'plain', material: null, content: ruleRow.content }))
                            .toMatchObject({ status: 'opened', record: { key: 'skill-rules', value: { rules: expect.arrayContaining([
                                expect.objectContaining({ skillId: adopted.skillIds[0], target: { t: 'allMachines' }, enabled: true }),
                            ]) } } });
                    }
                    expect(transfers.downloadStore.listDownloadSessionIds()).toEqual([]);

                    // The browser baseline carries the incumbent prepared HTTP
                    // phases over the same Home relay. The producer and file
                    // consumer retain their real scanner, encryption and digest.
                    const exportInput = { t: 'prompt_asset_download_v1', path };
                    for (const tamper of ['root', 'target', 'body'] as const) {
                        await call(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, exportInput, tamper);
                        expect(prepared.getState().publishedTransferCount).toBe(0);
                    }
                    const registeredExport = await call(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, exportInput);
                    expect(registeredExport).toMatchObject({ success: true });
                    const producer = await readFoundSkillBundle({ home, agents, request: { path } });
                    if (!registeredExport || typeof registeredExport !== 'object' || !('transferId' in registeredExport)
                        || typeof registeredExport.transferId !== 'string' || !('endpointCandidates' in registeredExport)) {
                        throw new Error('Expected registered Found export');
                    }
                    const transferId = registeredExport.transferId;
                    const endpointCandidates = z.array(TransferEndpointCandidateSchema).parse(registeredExport.endpointCandidates);
                    const endpoint = endpointCandidates[0];
                    if (!endpoint?.authorizationToken) throw new Error('Expected Found capability');
                    const base = buildDirectPeerTransferEndpointPath(transferId);
                    const recipientInput = { t: 'prepared_machine_transfer_v1' as const, path: `${base}/open`, httpMethod: 'POST' as const,
                        authorizationToken: endpoint.authorizationToken, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
                    for (const tamper of ['root', 'target', 'body'] as const) await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, recipientInput, tamper);
                    expect(prepared.getState().publishedTransferCount).toBe(1);
                    const invalidCapability = await preparedCall({ ...recipientInput, authorizationToken: 'invalid-capability' });
                    expect(invalidCapability.status).toBe(401);
                    const downloaded = await requestDirectPeerTransferToFile({ transferId, endpointCandidates,
                        destinationPath: join(home, `${actionId}.json`), fetchFn: fetchPrepared });
                    const bundle = FoundSkillBundleV1Schema.parse(JSON.parse(await readFile(downloaded.destinationPath, 'utf8')));
                    expect(bundle).toMatchObject({ name: producer.name, path: producer.path, pluginOwned: producer.pluginOwned });
                    expect(bundle.files).toEqual(producer.files);
                    expect(bundle.agents).toContain('codex');
                    const releaseInput = { transferId };
                    for (const tamper of ['root', 'target', 'body'] as const) {
                        await call(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE, releaseInput, tamper);
                        expect(prepared.getState().publishedTransferCount).toBe(1);
                    }
                    expect(await call(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE, releaseInput)).toEqual({ success: true });
                    expect(prepared.getState().publishedTransferCount).toBe(0);
                    expect((await preparedCall({ ...recipientInput, path: `${base}/chunks/0`, httpMethod: 'GET' })).status).toBe(401);
                }
                effectActionId = 'daemon.filesystem.download';
                const workspaceBytes = Buffer.from([0, 255, 128, 10, 0, 1]);
                await writeFile(join(home, 'binary.bin'), workspaceBytes);
                const workspaceInput = getActionSpec(effectActionId).inputSchema.parse({ rootPath: home, path: 'binary.bin',
                    destination: { destinationId: 'browser' }, asZip: false });
                const workspaceAuthorization = await fetch(`${origin}${bindExternalActionExecutionAuthorizationHttpPathV1(effectActionId)}`, {
                    method: 'POST', headers: { authorization: `Bearer ${terminal}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ v: 1, machineId: fixture.machine.id,
                        envelope: { v: 1, requestId: crypto.randomUUID(), target, input: workspaceInput } }),
                });
                expect(workspaceAuthorization.status).toBe(200);
                authorization = ExternalActionExecutionAuthorizationV1Schema.parse(await workspaceAuthorization.json());
                const workspaceScope = { rootPath: home, requesterAccountId: fixture.account.id, destinationId: 'browser' };
                const publishWorkspace = () => prepareWorkspaceFileExport({ lifecycle: prepared, filesystemScope: workspaceScope,
                    request: { workingDirectory: home, path: 'binary.bin', asZip: false } });
                const workspace = await publishWorkspace();
                const workspaceEndpoint = workspace.endpointCandidates[0];
                if (!workspaceEndpoint?.authorizationToken) throw new Error('Expected prepared workspace capability');
                const workspaceBase = new URL(workspaceEndpoint.url).pathname;
                const workspaceRecipient = createTransferRecipientKeyPair();
                const workspaceOpen = { t: 'prepared_machine_transfer_v1' as const, path: `${workspaceBase}/open`, httpMethod: 'POST' as const,
                    authorizationToken: workspaceEndpoint.authorizationToken, recipientPublicKeyBase64: workspaceRecipient.recipientPublicKeyBase64 };
                for (const tamper of ['root', 'target', 'body'] as const) await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, workspaceOpen, tamper);
                const workspaceDownload = await requestDirectPeerTransferToFile({ transferId: workspace.transferId,
                    endpointCandidates: workspace.endpointCandidates, destinationPath: join(home, 'downloaded.bin'), fetchFn: fetchPrepared,
                    expectedSizeBytes: workspace.sizeBytes, expectedManifestHash: workspace.manifestHash });
                expect(await readFile(workspaceDownload.destinationPath)).toEqual(workspaceBytes);
                const workspaceSettlement = prepared.waitForFilesystemExportSettlement(workspace.transferId, workspaceScope);
                expect((await preparedCall({ t: 'prepared_machine_transfer_v1', path: `${workspaceBase}/complete`, httpMethod: 'POST',
                    authorizationToken: workspaceEndpoint.authorizationToken, body: { destinationId: 'browser', success: true,
                        sizeBytes: workspaceDownload.sizeBytes, manifestHash: workspaceDownload.manifestHash } })).status).toBe(200);
                expect(await workspaceSettlement).toMatchObject({ success: true, sizeBytes: workspaceBytes.length });
                expect((await preparedCall({ ...workspaceOpen, path: `${workspaceBase}/chunks/0`, httpMethod: 'GET' })).status).toBe(401);
                const workspaceAbort = await publishWorkspace();
                const workspaceAbortEndpoint = workspaceAbort.endpointCandidates[0];
                if (!workspaceAbortEndpoint?.authorizationToken) throw new Error('Expected workspace cancellation capability');
                const workspaceAbortSettlement = prepared.waitForFilesystemExportSettlement(workspaceAbort.transferId, workspaceScope);
                expect((await preparedCall({ t: 'prepared_machine_transfer_v1',
                    path: `${new URL(workspaceAbortEndpoint.url).pathname}/complete`, httpMethod: 'POST',
                    authorizationToken: workspaceAbortEndpoint.authorizationToken,
                    body: { destinationId: 'browser', success: false, error: 'cancelled' } })).status).toBe(200);
                expect(await workspaceAbortSettlement).toMatchObject({ success: false, error: 'cancelled' });
                expect(prepared.getState().publishedTransferCount).toBe(0);
                effectActionId = 'skills.found.adopt';
                const cancellationAuthorization = await fetch(`${origin}${bindExternalActionExecutionAuthorizationHttpPathV1(effectActionId)}`, {
                    method: 'POST', headers: { authorization: `Bearer ${terminal}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ v: 1, machineId: fixture.machine.id, envelope: { v: 1, requestId: crypto.randomUUID(), target,
                        input: { machineId: fixture.machine.id, items: [{ name: 'native', path }] } } }),
                });
                expect(cancellationAuthorization.status).toBe(200);
                authorization = ExternalActionExecutionAuthorizationV1Schema.parse(await cancellationAuthorization.json());
                const controller = new AbortController();
                const cancelled = createFoundSkillBundleReader({ machineId: null, machineRPC: async (_machineId, rpc, payload) => {
                    const result = await call(rpc, payload);
                    if (rpc === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK) controller.abort();
                    return result;
                } });
                await expect(cancelled(fixture.machine.id, path, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
                expect(transfers.downloadStore.listDownloadSessionIds()).toEqual([]);
                expect(phases).toEqual(expect.arrayContaining([...methods, ...preparedMethods]));
                expect(phases).toEqual(expect.arrayContaining([RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
                    RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE]));
                expect(await readFile(join(path, 'SKILL.md'), 'utf8')).toBe(markdown);
                expect(await readFile(join(path, 'scripts', 'run.sh'), 'utf8')).toBe(script);
            });
        } finally {
            restoreEnv(originalEnvironment);
            requester.close(); machine.close();
            await transfers.dispose(); await prepared.stop(); eventRouter.clearIo();
            await io.close(); await app.close();
        }
    });

    it("admits a signed decision proof only when the current credential retains approve", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        try {
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
                accessGrant: { ...API_TOKEN_FULL_GRANT_V1, approve: true },
            } });
            const authorization = await mint(app, fixture, 'approval.request.decide');
            const method = 'S1:permission';
            const requestId = crypto.randomUUID();
            const params = { id: 'request', approved: true };
            const execution = { v: 1 as const, authorization, effectActionId: 'approval.request.decide',
                target: authorization.binding.target, installationId: fixture.machine.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'approval.request.decide', target: authorization.binding.target,
                    installationId: fixture.machine.installationId!, event: SOCKET_RPC_EVENTS.CALL, method, requestId, params,
                    privateKey: fixture.keyPair.secretKey }) };
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params })).not.toBeNull();
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: API_TOKEN_FULL_GRANT_V1 } });
            expect(await verifyExternalActionMachineRpcExecution(execution, { method, requestId, params })).toBeNull();

            const withoutApprove = await mint(app, fixture, ACTION_ID);
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
                accessGrant: { ...API_TOKEN_FULL_GRANT_V1, approve: true },
            } });
            const widenedProof = { ...execution, authorization: withoutApprove,
                target: withoutApprove.binding.target,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: withoutApprove.token,
                    effectActionId: 'approval.request.decide', target: withoutApprove.binding.target,
                    installationId: fixture.machine.installationId!, event: SOCKET_RPC_EVENTS.CALL, method, requestId, params,
                    privateKey: fixture.keyPair.secretKey }) };
            expect(await verifyExternalActionMachineRpcExecution(widenedProof, { method, requestId, params })).toBeNull();
        } finally { await app.close(); }
    });

    it("binds a V1 invocation without optional correlation or target to the selected Machine", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        const { app } = await createApp(fixture.team.id);
        const envelope = { v: 1 as const, input: { teamId: fixture.team.id } };
        try {
            const response = await app.inject({
                method: "POST",
                url: bindExternalActionExecutionAuthorizationHttpPathV1(ACTION_ID),
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope },
            });
            expect(response.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            authorizationRequests.set(authorization.token, {
                target: authorization.binding.target,
                installationId: fixture.machine.installationId!,
                requestId: authorization.binding.requestId,
            });
            expect(authorization.binding).toMatchObject({
                machineId: fixture.machine.id,
                target: { kind: "machine", machineId: fixture.machine.id },
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            });
            expect(authorization.binding.requestId.length).toBeGreaterThan(0);
        } finally {
            await app.close();
        }
    });

    it.each(["approval.request.create", "action.invoke", "acme.workflow/actions/update-team"] as const)(
        "allows the trusted Machine to bind a resolved effect for outer %s",
        async (outerActionId) => {
            const fixture = await createFixture({ qualifiedPat: true });
            if (outerActionId !== 'approval.request.create') {
                await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
                    accessGrant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['acme.workflow/actions/update-team'] } },
                } });
            }
            const envelope = outerActionId === 'action.invoke' ? { ...fixture.envelope, input: {
                action: { pluginId: 'acme.workflow', localId: 'update-team' }, input: { teamId: fixture.team.id },
            } } : fixture.envelope;
            const { app, transport } = await createApp(fixture.team.id);
            try {
                const response = await app.inject({
                    method: "POST",
                    url: bindExternalActionExecutionAuthorizationHttpPathV1(outerActionId),
                    headers: { authorization: `Bearer ${fixture.pat.token}` },
                    payload: { v: 1, machineId: fixture.machine.id, envelope },
                });
                expect(response.statusCode).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
                authorizationRequests.set(authorization.token, {
                    target: authorization.binding.target,
                    installationId: fixture.machine.installationId!,
                    requestId: authorization.binding.requestId,
                });
                expect(authorization.binding.actionId).toBe(outerActionId);

                const body = createTeamPolicyInput(fixture.team.id);
                const effect = await app.inject({
                    method: transport.method,
                    url: transport.path,
                    headers: machineHeaders({
                        authorizationToken: authorization.token,
                        target: authorization.binding.target,
                        effectActionId: ACTION_ID,
                        method: transport.method,
                        path: transport.path,
                        body,
                        privateKey: fixture.keyPair.secretKey,
                    }),
                    payload: body,
                });
                expect(effect.statusCode).toBe(200);
                expect(effect.json()).toMatchObject({ qualification: "satisfied" });
            } finally {
                await app.close();
            }
        },
    );

    it("does not let a contributed invocation authorize present-user-only token management even with approve", async () => {
        const fixture = await createFixture({ qualifiedPat: true });
        await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: {
            accessGrant: { ...API_TOKEN_FULL_GRANT_V1, approve: true,
                actions: { families: [], ids: ['acme.workflow/actions/update-team'] } },
        } });
        const { app } = await createApp(fixture.team.id);
        try {
            const response = await app.inject({
                method: "POST",
                url: bindExternalActionExecutionAuthorizationHttpPathV1("acme.workflow/actions/update-team"),
                headers: { authorization: `Bearer ${fixture.pat.token}` },
                payload: { v: 1, machineId: fixture.machine.id, envelope: fixture.envelope },
            });
            expect(response.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            authorizationRequests.set(authorization.token, {
                target: authorization.binding.target,
                installationId: fixture.machine.installationId!,
                requestId: authorization.binding.requestId,
            });
            const path = "/test/present-user-only";
            const body = { tokenId: crypto.randomUUID(), label: "must remain present-user-only" };
            const effect = await app.inject({
                method: "POST",
                url: path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    effectActionId: "account.apiTokens.create",
                    method: "POST",
                    path,
                    body,
                    privateKey: fixture.keyPair.secretKey,
                }),
                payload: body,
            });
            expect(effect.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it("admits the qualified PAT through the real Team policy mutation and persists its result", async () => {
        const qualified = await createFixture({ qualifiedPat: true });
        const app = await createRealTeamApp();
        try {
            const authorization = await mint(app, qualified);
            const transport = getActionSpec(ACTION_ID).serverTransport;
            if (!transport) throw new Error("test Action has no server transport");
            const body = {
                v: 1 as const,
                teamId: qualified.team.id,
                previousAuthenticationPolicy: qualified.team.authenticationPolicy,
                authenticationPolicy: { v: 1 as const, mode: "inherit" as const },
            };
            const response = await app.inject({
                method: transport.method,
                url: transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: transport.method,
                    path: transport.path,
                    body,
                    privateKey: qualified.keyPair.secretKey,
                }),
                payload: body,
            });

            expect(response.statusCode).toBe(200);
            expect(response.json().policy.authenticationPolicy).toBeNull();
            expect((await db.team.findUniqueOrThrow({ where: { id: qualified.team.id } })).authenticationPolicy)
                .toBeNull();
        } finally {
            await app.close();
        }

        const unqualified = await createFixture({ qualifiedPat: false });
        const unqualifiedApp = await createRealTeamApp();
        try {
            const authorization = await mint(unqualifiedApp, unqualified);
            const transport = getActionSpec(ACTION_ID).serverTransport;
            if (!transport) throw new Error("test Action has no server transport");
            const body = {
                v: 1 as const,
                teamId: unqualified.team.id,
                previousAuthenticationPolicy: unqualified.team.authenticationPolicy,
                authenticationPolicy: { v: 1 as const, mode: "inherit" as const },
            };
            const response = await unqualifiedApp.inject({
                method: transport.method,
                url: transport.path,
                headers: machineHeaders({
                    authorizationToken: authorization.token,
                    target: authorization.binding.target,
                    method: transport.method,
                    path: transport.path,
                    body,
                    privateKey: unqualified.keyPair.secretKey,
                }),
                payload: body,
            });

            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "team_authentication_required" });
            expect((await db.team.findUniqueOrThrow({ where: { id: unqualified.team.id } })).authenticationPolicy)
                .toEqual(unqualified.team.authenticationPolicy);
        } finally {
            await unqualifiedApp.close();
        }
    });
});
