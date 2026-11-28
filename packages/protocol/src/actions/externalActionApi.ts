import { TELEMETRY_COSTS_READ_ACTION_ID_V1 } from './actionIdsDatabaseV1.js';
import { formatQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { ResourceTeamShareScopeV1Schema } from '../teams/resourceGrantAccessV1.js';
import { ManagedAdmissionPresetContentV1Schema } from '../machines/managed/managedMachinePresetContentCarrierV1.js';
import { ManagedMachinePresetV1BaseSchema } from '../machines/managed/managedMachinePresetStructureV1.js';
import { ApiTokenSessionPresetAcquisitionV1Schema } from '../auth/apiTokenGrant.js';
import { ManagedMachinePresetPrepareInputV1Schema, ManagedMachinePresetRevisionInputV1Schema } from '../machines/managed/managedMachinePresetRevisionV1.js';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1, MACHINE_PRESET_ARCHIVE_ACTION_ID_V1 } from '../machines/managed/machinePresetActionIdsV1.js';
import { ExternalActionRequestIdV1Schema, ExternalActionPreOpenFailureCodeSchema, ExternalActionTargetRefusalPhaseSchema } from './externalActionHttpError.js';
import { ExternalActionWorkflowSessionLeafV1Schema } from './workflowSessionChildV1.js';
export { ExternalActionWorkflowSessionLeafV1Schema, projectExternalActionWorkflowSessionLeafContextV1, type ExternalActionWorkflowSessionLeafV1,
  type InstalledWorkflowSessionLeafAdmission } from './workflowSessionChildV1.js';
import { ACTION_INVOKE_ACTION_ID_V1, PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1, SESSION_SPAWN_NEW_ACTION_ID_V1, WorkflowActionIdV1Schema, isProjectSessionDefaultsPreparationReadActionIdV1, isSessionSpawnHomeDefaultsReadEffectV1 } from './actionIds.js';
import { isRequesterOperationActionIdV1 } from './operations/actionIdsV1.js';
import { ProjectSessionDefaultsAdmissionV1Schema, ProjectSessionDefaultsContextSelectionV1Schema, ProjectSessionDefaultsGetInputV1Schema, type ProjectSessionDefaultsAdmissionV1 } from '../projects/projectSessionDefaultsSelectionV1.js';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '../bots/templates/botTemplateActionIdsV1.js';
import { SessionInitialAccessDraftV1Schema } from '../sessions/access/sessionInitialAccessDraftV1.js';
export * from './externalActionHttpError.js';
import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { MachineServiceLogsResourceContinuationV1Schema, MachineServiceLogsGenerationV1Schema } from '../daemon/machineServiceLogsResource.js';
import { AccessibleMachineAccessV1Schema, MachineCustodianV1Schema } from '../machines/machineAccessV1.js';
export { MachineNpmProfileAdmissionResponseV1Schema as ExternalActionMachineNpmProfileAdmissionResponseV1Schema } from '../machines/machineAccessV1.js';
import { ManagedMachineRefReadV1Schema } from '../machines/managed/managedMachineV1.js';
import { WorkspaceSyncAdmissionInputV1Schema, WorkspaceSyncAdmissionV1Schema } from '../workspaces/workspaceSyncAdmissionV1.js';
import { isProjectWorkspaceSyncOpenActionV1, isProjectWorkspaceSyncPreparationActionV1 } from './projectActionIdsV1.js';
export { WorkspaceSyncAdmissionV1Schema, projectWorkspaceSyncAdmissionInputV1, deriveWorkspaceSyncRelationshipId,
  readWorkspaceSyncSourceAdmissionV1,
  type WorkspaceSyncAdmissionV1, type WorkspaceSyncAdmissionInputV1 } from '../workspaces/workspaceSyncAdmissionV1.js';
import { z } from '../zodRuntimePolicy.js';
import { RegistryAppUpdateAdmissionV1Schema, projectRegistryAppUpdateAdmissionV1,
  type RegistryAppUpdateAdmissionV1 } from '../registries/registryAppUpdateAdmissionV1.js';
export { RegistryAppUpdateAdmissionV1Schema, projectRegistryAppUpdateAdmissionV1,
  type RegistryAppUpdateAdmissionV1 } from '../registries/registryAppUpdateAdmissionV1.js';
import { DeploymentPreparationAdmissionV1Schema, isDeploymentPreparationActionIdV1, projectDeploymentPreparationAdmissionV1, deploymentPreparationOperationForActionV1,
  type DeploymentPreparationAdmissionV1 } from '../deployments/deploymentPreparationAdmissionV1.js';
export { DeploymentPreparationAdmissionV1Schema, isDeploymentPreparationActionIdV1, projectDeploymentPreparationAdmissionV1, deploymentPreparationOperationForActionV1,
  type DeploymentPreparationAdmissionV1 } from '../deployments/deploymentPreparationAdmissionV1.js';
import { API_TOKEN_ENVIRONMENT_ACTION_IDS_V1, ApiTokenGrantV1Schema, ApiTokenSessionSpawnAdmissionV1Schema, hasApiTokenUsageAppCallsScopeV1 } from '../auth/apiTokenGrant.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from '../deployments/deploymentIdentifiersV1.js';
import { DatabaseAgentLevelV1Schema } from '../deployments/deploymentEnvironmentDeployerV1.js';
import { DatabaseAccessSummaryV1Schema } from '../databases/databaseAccessSummaryV1.js';
import { DeploymentTargetMachinesV1Schema } from '../deployments/deploymentEnvironmentCreateV1.js';
import { ProjectSourceOwnerV1Schema, ProjectSourcesCreateActionInputV1Schema } from '../projects/sources/projectSourceV1.js';
import { ProjectAccountWorkspaceRefKeyV1Schema } from '../projects/workspaceRefKeyV1.js';
import { PROJECT_SOURCE_CREATE_ACTION_ID_V1 } from './specs/projectSourcesActionIdsV1.js';
import { isMachineTerminalSessionReadActionIdV1 } from './specs/machineTerminalActionIdsV1.js';
import { TerminalStreamReadRequestSchema } from '../terminal/stream.js';
import type { ProjectSourceArtifactReadOptionsV1 } from '../projects/sources/projectSourceAttachmentAdmissionV1.js';
import { deploymentOperationForRootActionV1, isDeploymentDomainChildActionIdV1, isDeploymentBackupActionIdV1, DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
  isDeploymentEnvironmentMetadataReadActionIdV1, isDeploymentApprovalMetadataPreparationActionIdV1, DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1, DEPLOYMENT_CANCEL_ACTION_ID_V1,
  DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1,
  DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_DELETE_ACTION_ID_V1,
  DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1,
  DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1, isDeploymentActionIdV1, isDeploymentNativeReadActionIdV1, isDeploymentPromoteActionIdV1, isDeploymentMembershipActionIdV1, DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1 } from '../deployments/deploymentActionIdsV1.js';
import { DeploymentReviewedCandidateV1Schema } from '../deployments/deploymentCandidatePublicationV1.js';
import { DeploymentReadAdmissionV1Schema, DeploymentTelemetryReadFactsV1Schema, isDeploymentReadAdmissionActionIdV1, projectDeploymentReadAdmissionV1,
  type DeploymentReadAdmissionV1 } from '../deployments/deploymentReadAdmissionV1.js';
export { DeploymentReadAdmissionV1Schema, isDeploymentNativeReadActionIdV1, isDeploymentReadActionIdV1, isDeploymentReadAdmissionActionIdV1, projectDeploymentReadAdmissionV1,
  type DeploymentReadAdmissionV1 } from '../deployments/deploymentReadAdmissionV1.js';
import { DeploymentChildRoutingV1Schema } from '../deployments/deploymentChildRoutingV1.js';
import { DeploymentNativeAdmissionV1Schema, DeploymentEnvironmentUpdateNativeAdmissionV1Schema, DeploymentDomainNativeAdmissionV1Schema, DeploymentRestartNativeAdmissionV1Schema, DeploymentRestoreNativeAdmissionV1Schema, DeploymentBackupNativeAdmissionV1Schema, DeploymentCandidatePublicationV1Schema,
  projectDeploymentNativeAdmissionV1, isDeploymentDomainNativeAdmissionV1, isDeploymentDomainDnsNativeAdmissionV1, isDeploymentBackupNativeAdmissionV1,
  isDeploymentEnvironmentUpdateNativeAdmissionV1, DeploymentBackupConfigureNativeAdmissionV1Schema,
  isDeploymentBackupConfigureNativeAdmissionV1, DeploymentTelemetryNativeAdmissionV1Schema, isDeploymentTelemetryNativeAdmissionV1 } from '../deployments/deploymentCandidatePublicationV1.js';
export { DeploymentNativeAdmissionV1Schema, DeploymentEnvironmentUpdateNativeAdmissionV1Schema, DeploymentDomainNativeAdmissionV1Schema, DeploymentDomainDnsNativeAdmissionV1Schema, DeploymentRestoreNativeAdmissionV1Schema, DeploymentBackupNativeAdmissionV1Schema, DeploymentCandidatePublicationV1Schema,
  projectDeploymentNativeAdmissionV1, createDeploymentCandidatePublicationV1, createDeploymentLinkContentArtifactIdV1,
  createDeploymentDomainContentArtifactIdV1, computeDeploymentDomainAuthoredMetadataDigestV1, matchesDeploymentDomainPreparedInputV1,
  createDeploymentEnvironmentContentArtifactIdV1, computeDeploymentEnvironmentUpdateInputDigestV1,
  computeDeploymentEnvironmentUpdateMetadataDigestV1, isDeploymentEnvironmentUpdateNativeAdmissionV1,
  isDeploymentDomainNativeAdmissionV1, isDeploymentDomainDnsNativeAdmissionV1, isDeploymentBackupNativeAdmissionV1,
  DeploymentBackupConfigureNativeAdmissionV1Schema, isDeploymentBackupConfigureNativeAdmissionV1,
  type DeploymentBackupConfigureNativeAdmissionV1,
  DeploymentTelemetryNativeAdmissionV1Schema, isDeploymentTelemetryNativeAdmissionV1, type DeploymentTelemetryNativeAdmissionV1,
  type DeploymentNativeAdmissionV1, type DeploymentDomainNativeAdmissionV1, type DeploymentDomainDnsNativeAdmissionV1, type DeploymentRestoreNativeAdmissionV1, type DeploymentBackupNativeAdmissionV1 } from '../deployments/deploymentCandidatePublicationV1.js';
import { DeploymentChildExecutionProofV1Schema } from '../deployments/deploymentChildExecutionProofV1.js';
import { AuthTokenAuthenticationEvidenceSnapshotV1Schema } from '../auth/authToken.js';
import { ActionRequiredAuthoritySchema } from './metadata.js';
import { ManagedAcquireInputV1Schema, ManagedAdmissionComputeInputV1Schema, ManagedResourceTargetV1Schema, ManagedExecInputV1Schema, ManagedInspectInputV1Schema, ManagedMutationInputV1Schema, ManagedBootstrapRetryInputV1Schema, ManagedCredentialInstallInputV1Schema, ManagedPowerInputV1Schema, ManagedDeleteInputV1Schema, ManagedResizeInputV1Schema } from '../machines/managed/actionsV1.js';
import { MANAGED_EXEC_ACTION_ID_V1 } from '../machines/managed/actionIdsV1.js';
import { isManagedControlAdmissionActionIdV1, isManagedCreationMutationActionIdV1, MANAGED_CREATION_MUTATION_ACTION_IDS_V1,
  MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 } from '../machines/managed/actionIdsV1.js';
import type { GuestCliIdentityV1 } from '../features/payload/capabilities/guestCliIdentityV1.js';
import { ManagedControllerV1Schema } from '../machines/managed/managedMachineV1.js';
import { ActionOperationListActionInputV1Schema, ActionOperationGetActionInputV1Schema } from './specs/actionOperations.js';
import { AccountEncryptionModeSchema, type AccountEncryptionMode } from '../features/payload/capabilities/encryptionCapabilities.js';
import { readDeferredDeclarationDescriptor } from '../plugins/contributions/deferredDeclarationFields.js';
import { WorkflowProjectTargetV1Schema } from '../workflows/workflowWorkspaceV1.js';
import type { ProjectAccountRowCipherV1 } from '../projects/projectAccountRowCipherV1.js';
import type { PromptArtifactRefV1 } from '../prompts/library/promptArtifactRefsV1.js';
import { SessionActionRpcOriginV1Schema } from '../rpc/socket.js';
import { SessionInputSourceSessionV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { MachineInstallationProofV1Schema, MachineInstallationPublicKeySchema } from '../machines/identity/installationKeySchemas.js';
import { ManagedWakeTargetV1Schema } from '../machines/managed/managedIntentV1.js';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from './projectActionFamily.js';
import { SessionRequesterInstallationSealedBootstrapV1Schema } from '../sessions/creation/sessionRequesterBootstrapSchemasV1.js';
import type { ExternalActionRequesterAccountContextPurposeV1 } from '../sessions/creation/sessionRequesterBootstrapV1.js';
import type { ProjectTrustContentV1, ProjectTrustValueV1, QualifiedProjectTrustProjectV1 } from '../workspaces/projectSetup/projectTrustRowV1.js';
import type { MachinePublishedRowV1 } from '../machines/machineContentKeyTransitionV1.js';
import type { AuthoringMemoryContentV1, AuthoringMemoryValueV1 } from '../account/authoringMemory.js';
import type { PromptLibraryStoredArtifact } from '../prompts/library/promptLibraryActionOperations.js';
import type { ArtifactBodyV1 } from '../artifacts/artifactBinaryV1.js';
import type { ArtifactRevisionV1 } from '../artifacts/artifactRevisionV1.js';
import type { createActionExecutor } from './actionExecutor.js';

import { RunnerMachineContentKeyBindingV1Schema } from '../ephemeralRunner/machineContentKeyBindingSchema.js';
import { RunnerClaimV1Schema } from '../ephemeralRunner/endpoint.js';
import { MachineKindFromLegacyProjectionSchema } from '../machines/machineKind.js';
import { PendingResetStartSetInputV1Schema } from '../sessions/pending/pendingRequestedActionV1.js';
import { DaemonPluginMountedInvocationV1Schema } from '../plugins/actions/daemonInvocationV1.js';
import { WorkflowAcceptedAuthorizationV1Schema } from '../workflows/workflowDefinitionV1.js';
import { isRoleActionIdV1 } from '../prompts/roles/roleActionIdsV1.js';
import { ManagedMachineActionIdV1Schema } from '../machines/managed/actionsV1.js';
import { AutomationManualIdempotencyKeyV1Schema } from '../automations/automationOccurrenceV1.js';
import { isDiscussionActionIdV1 } from '../discussions/actionIds.js';
import { TriageEntryRefV1Schema } from '../tasks/entryRefV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { DiscussionIdSchema } from '../discussions/references.js';

import {
  ActionExecuteFailureSchema,
  parseActionExecuteFailure,
  type ActionExecuteResult,
} from './actionExecutionResult.js';
import { StrictJsonValueSchema, sameStrictJsonValue } from '../json/strictJsonValue.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import {
  measurePluginJsonUtf8Bytes,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../plugins/contributions/strictJsonValue.js';
import {
  EXTERNAL_ACTION_PENDING_RESET_START_ADMISSION_MAX_UTF8_BYTES_V2,
  EXTERNAL_ACTION_ENCRYPTED_REQUEST_PLAINTEXT_MAX_BYTES_V2,
  EXTERNAL_ACTION_ENCRYPTED_RESPONSE_PLAINTEXT_MAX_BYTES_V2,
  EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2,
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2,
  EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES_V2,
  EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES_V2,
  EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH,
  EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES,
  EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from './externalActionLimits.js';

export {
  EXTERNAL_ACTION_ENCRYPTED_REQUEST_PLAINTEXT_MAX_BYTES_V2,
  EXTERNAL_ACTION_ENCRYPTED_RESPONSE_PLAINTEXT_MAX_BYTES_V2,
  EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2,
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2,
  EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES_V2,
  EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES_V2,
  EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH,
  EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES,
  EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
  measureExternalActionResultResponseEnvelopeUtf8BytesV1,
};

/** Relative path prefix; the Action id is the final path segment. */
export const EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1 = '/v1/actions/' as const;

/** The existing relay's empty 502 means submission occurred without an execution receipt. */
export function isExternalActionSubmittedUnknownHttpResponse(status: number, body: unknown): boolean {
  return status === 502 && body === '';
}

/**
 * The public path segment is an opaque identifier to the server relay. Its
 * finite scalar bound matches the other external Action identity fields while
 * admission remains exclusively with the target daemon's Action registry.
 */
export const ExternalActionActionIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), maxCodeUnits(EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH), z.refine((value) => value.trim() === value, 'actionId must not have outer whitespace')));
export type ExternalActionActionIdV1 = z.infer<typeof ExternalActionActionIdV1Schema>;

/** Public retry identity, never private content or authorization. */
export function projectExternalActionRunNowIdempotencyKeyV1(actionId: string, input: unknown): string | undefined {
  if (actionId !== 'workflow.trigger.run_now') return undefined;
  const record = readRecord(input);
  return record?.idempotencyKey === undefined ? undefined : AutomationManualIdempotencyKeyV1Schema.parse(record.idempotencyKey);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The one transport-neutral projection from internal Action execution into
 * the public external Action result. Internal contributors may retain richer
 * diagnostics; neither HTTP origin can disclose them as top-level fields.
 */
export function projectExternalActionExecutionResultV1(value: unknown): ActionExecuteResult | null {
  const result = readRecord(value);
  if (!result) return null;

  if (result.ok === true && Object.prototype.hasOwnProperty.call(result, 'result')) {
    return { ok: true, result: result.result };
  }
  if (result.ok !== false) return null;

  return parseActionExecuteFailure(result);
}

export { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '../rpc/methods.js';

/**
 * Recovers only safe correlation from a purported protected outer frame. It
 * deliberately does not classify the frame as valid or expose any other key.
 */
export function readExternalActionProtectedRequestId(value: unknown): string | undefined {
  const record = readRecord(value);
  if (record?.v !== 2) return undefined;
  const requestId = ExternalActionRequestIdV1Schema.safeParse(record.requestId);
  return requestId.success ? requestId.data : undefined;
}

const ExternalActionExecutionSuccessV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  result: z.unknown(),
}).check(z.superRefine((value, context) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'result')) {
    context.addIssue({
      code: "custom",
      path: ['result'],
      message: 'result is required',
    });
  }
})));

/** Closed public execution union. Bridge-private execution metadata cannot cross it. */
export const ExternalActionExecutionResultV1Schema = lazyZodSchema(() => z.union([
  ExternalActionExecutionSuccessV1Schema,
  ActionExecuteFailureSchema,
]));

const EXTERNAL_ACTION_RESULT_TOO_LARGE_MESSAGE =
  'Action execution completed, but its response exceeded the external Action response limit and could not be represented.' as const;

/** Strict admitted result used only after the Action has completed. */
export const ExternalActionResultTooLargeExecutionV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  errorCode: z.literal('result_too_large'),
  error: z.literal(EXTERNAL_ACTION_RESULT_TOO_LARGE_MESSAGE),
  details: z.strictObject({
    executionCompleted: z.literal(true),
    maxSerializedBytes: z.literal(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES),
  }),
}));
export type ExternalActionResultTooLargeExecutionV1 = Readonly<z.infer<
  typeof ExternalActionResultTooLargeExecutionV1Schema
>>;

export function createExternalActionResultTooLargeExecutionV1(): ExternalActionResultTooLargeExecutionV1 {
  return {
    ok: false,
    errorCode: 'result_too_large',
    error: EXTERNAL_ACTION_RESULT_TOO_LARGE_MESSAGE,
    details: {
      executionCompleted: true,
      maxSerializedBytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    },
  };
}

/**
 * Strict public external Action response. Both HTTP origins and the SDK use
 * this one envelope; Action-domain failures stay inside `execution`.
 */
export const ExternalActionResponseEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  actionId: ExternalActionActionIdV1Schema,
  requestId: z.optional(ExternalActionRequestIdV1Schema),
  execution: ExternalActionExecutionResultV1Schema,
}));

/**
 * Strict outer relay framing. The relay may receive a daemon execution result
 * with private metadata, but never gains a second public response envelope.
 */
const ExternalActionResponseEnvelopeV1ProjectionInputSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  actionId: ExternalActionActionIdV1Schema,
  requestId: z.optional(ExternalActionRequestIdV1Schema),
  execution: z.unknown(),
}).check(z.superRefine((value, context) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'execution')) {
    context.addIssue({
      code: "custom",
      path: ['execution'],
      message: 'execution is required',
    });
  }
})));

/** Stable finite response envelope shared by the daemon and server adapters. */
export type ExternalActionResponseEnvelopeV1 = Readonly<{
  v: 1;
  actionId: ExternalActionActionIdV1;
  requestId?: string;
  execution: ActionExecuteResult;
}>;

/**
 * The one strict JSON response projection prepared after external Action
 * execution. Same-process HTTP adapters send these bytes directly; the
 * reserved daemon relay carries a binary projection of these exact bytes.
 */
export type PreparedExternalActionResponseEnvelopeV1 = Readonly<{
  response: ExternalActionResponseEnvelopeV1;
  body: string;
  byteLength: number;
}>;

/**
 * Projects an exact-daemon relay result onto the one strict public response
 * union. Only execution metadata is normalized; relay envelope fields remain
 * closed and are never rewritten by a transport adapter.
 */
export function projectExternalActionResponseEnvelopeV1(
  value: unknown,
): ExternalActionResponseEnvelopeV1 | null {
  const parsed = ExternalActionResponseEnvelopeV1ProjectionInputSchema.safeParse(value);
  if (!parsed.success) return null;
  const execution = projectExternalActionExecutionResultV1(parsed.data.execution);
  if (!execution) return null;
  return {
    v: 1,
    actionId: parsed.data.actionId,
    ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
    execution,
  };
}

/**
 * Reads the strict public response shape and returns the canonical Action
 * execution projection. Consumers never need a hand-written response parser.
 */
export function parseExternalActionResponseEnvelopeV1(
  value: unknown,
): ExternalActionResponseEnvelopeV1 | null {
  const parsed = ExternalActionResponseEnvelopeV1Schema.safeParse(value);
  if (!parsed.success) return null;
  const execution = projectExternalActionExecutionResultV1(parsed.data.execution);
  if (!execution) return null;
  return {
    v: 1,
    actionId: parsed.data.actionId,
    ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
    execution,
  };
}

/** Extracts a validated response while preserving its outer failure correlation. */
export function readExternalActionResponseExecutionV1(
  envelope: Pick<ExternalActionResponseEnvelopeV1, 'execution' | 'requestId'>,
): ActionExecuteResult {
  return !envelope.execution.ok && envelope.execution.requestId === undefined && envelope.requestId !== undefined
    ? { ...envelope.execution, requestId: envelope.requestId } : envelope.execution;
}

const ExternalActionDaemonDispatchInvalidRequestCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_action',
  'invalid_envelope',
]));
export type ExternalActionDaemonDispatchInvalidRequestCodeV1 = z.infer<
  typeof ExternalActionDaemonDispatchInvalidRequestCodeV1Schema
>;

const ExternalActionDaemonDispatchInvalidRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('invalid_request'),
  errorCode: ExternalActionDaemonDispatchInvalidRequestCodeV1Schema,
}));

/**
 * Socket.IO carries the already-prepared public response as a binary
 * attachment. A JSON string would need another escaping pass in the Socket.IO
 * frame and could exceed the one-megabyte response-carrier reserve.
 */
const ExternalActionDaemonDispatchPreparedBodyV1Schema = lazyZodSchema(() => z.instanceof(Uint8Array).check(z.refine((value) => value.byteLength <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, `external Action relay response must not exceed ${EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES} bytes`)));

/**
 * Closed result of the reserved server-to-daemon Action relay. Admission
 * failures remain transport failures; only a completed/admitted Action may
 * carry the already-serialized strict public response bytes.
 */
export const ExternalActionDaemonDispatchResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ExternalActionDaemonDispatchInvalidRequestV1Schema,
  z.strictObject({
    kind: z.literal('response'),
    body: ExternalActionDaemonDispatchPreparedBodyV1Schema,
  }),
]));
export type ExternalActionDaemonDispatchResultV1 = Readonly<
  | {
    kind: 'invalid_request';
    errorCode: ExternalActionDaemonDispatchInvalidRequestCodeV1;
  }
  | {
    kind: 'response';
    body: Uint8Array;
  }
>;

/** Parsed relay result; the prepared body is never re-projected or remeasured. */
export type ParsedExternalActionDaemonDispatchResultV1 = Readonly<
  | {
    kind: 'invalid_request';
    errorCode: ExternalActionDaemonDispatchInvalidRequestCodeV1;
  }
  | {
    kind: 'response';
    prepared: PreparedExternalActionResponseEnvelopeV1;
  }
>;

/**
 * Projects the canonical prepared body onto the existing closed reserved-RPC
 * response wrapper. The payload is binary so Socket.IO does not quote/escape
 * the already-serialized JSON a second time.
 */
export function createExternalActionDaemonDispatchResponseV1(
  prepared: PreparedExternalActionResponseEnvelopeV1,
): Extract<ExternalActionDaemonDispatchResultV1, Readonly<{ kind: 'response' }>> {
  const body = new TextEncoder().encode(prepared.body);
  if (body.byteLength !== prepared.byteLength) {
    throw new TypeError('External Action prepared response byte length mismatch');
  }
  return { kind: 'response', body };
}

function parsePreparedExternalActionResponseBodyV1(
  value: Uint8Array,
): PreparedExternalActionResponseEnvelopeV1 | null {
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const response = parseExternalActionResponseEnvelopeV1(raw);
  return response
    ? { response, body, byteLength: value.byteLength }
    : null;
}

/** Reads a strict reserved relay result without retaining daemon-private fields. */
export function parseExternalActionDaemonDispatchResultV1(
  value: unknown,
): ParsedExternalActionDaemonDispatchResultV1 | null {
  const parsed = ExternalActionDaemonDispatchResultV1Schema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.kind === 'invalid_request') {
    return {
      kind: 'invalid_request',
      errorCode: parsed.data.errorCode,
    };
  }
  const prepared = parsePreparedExternalActionResponseBodyV1(parsed.data.body);
  return prepared ? { kind: 'response', prepared } : null;
}

function measureSerializedUtf8Bytes(
  value: ExternalActionResponseEnvelopeV1,
  maximumBytes?: number,
): number {
  return measureSerializedValidatedStrictPluginJsonUtf8Bytes(
    value,
    'externalActionResponse',
    maximumBytes,
  );
}

function projectStrictJsonExternalActionResponseEnvelopeV1(
  response: ExternalActionResponseEnvelopeV1,
): ExternalActionResponseEnvelopeV1 | null {
  // JSON.stringify omits undefined/function/symbol object members and emits
  // null for those values in arrays. Apply that native projection before the
  // strict-data validation so an otherwise valid Action result is not turned
  // into invalid_action_output merely because it contains an optional field.
  const omitted = Symbol('omitted');
  const invalid = Symbol('invalid');
  const project = (value: unknown, ancestors: Set<object>, depth = 0): unknown => {
    // Keep the projection itself stack-safe; the response will be replaced
    // with invalid_action_output rather than allowing a deeply nested result
    // to overflow the process before the existing serializer guard runs.
    if (depth > 1_000) return invalid;
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return omitted;
    if (value === null || typeof value !== 'object') return value;
    if (ancestors.has(value)) return invalid;
    const nextAncestors = new Set(ancestors).add(value);
    if (Array.isArray(value)) {
      return value.map((item) => {
        const projected = project(item, nextAncestors, depth + 1);
        return projected === omitted ? null : projected;
      });
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // Accessors are not JSON data and must not be invoked at this boundary,
      // except host-deferred declaration fields, which are data not yet read.
      const deferred = descriptor ? readDeferredDeclarationDescriptor(value, descriptor) : null;
      if (!descriptor || (!('value' in descriptor) && !deferred)) return invalid;
      const projected = project(deferred ? deferred.value : descriptor.value, nextAncestors, depth + 1);
      if (projected !== omitted) output[key] = projected;
    }
    return output;
  };
  const projected = project(response, new Set());
  const strictJson = projected === invalid
    ? { success: false as const }
    : StrictJsonValueSchema.safeParse(projected);
  return strictJson.success
    ? parseExternalActionResponseEnvelopeV1(strictJson.data)
    : null;
}

function invalidActionOutputResponse(
  response: ExternalActionResponseEnvelopeV1,
): ExternalActionResponseEnvelopeV1 {
  return {
    v: 1,
    actionId: response.actionId,
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    execution: {
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    },
  };
}

/** Measures exactly the strict JSON envelope that an external transport sends. */
export function measureExternalActionResponseEnvelopeUtf8BytesV1(value: unknown): number {
  const parsed = parseExternalActionResponseEnvelopeV1(value);
  const strictJson = parsed && StrictJsonValueSchema.safeParse(parsed);
  const response = strictJson?.success ? parseExternalActionResponseEnvelopeV1(strictJson.data) : null;
  if (!response) {
    throw new TypeError('External Action response envelope must contain strict JSON data');
  }
  return measureSerializedUtf8Bytes(response);
}

/**
 * Applies the one response ceiling and native JSON representability check
 * after Action execution. Both public entry points consume this one prepared
 * projection rather than owning separate response serializers.
 */
export function prepareExternalActionResponseEnvelopeV1(
  value: unknown,
): PreparedExternalActionResponseEnvelopeV1 {
  const response = parseExternalActionResponseEnvelopeV1(value);
  if (!response) {
    throw new TypeError('Invalid external Action response envelope');
  }
  const strictJsonResponse = projectStrictJsonExternalActionResponseEnvelopeV1(response);
  let candidate: ExternalActionResponseEnvelopeV1;
  if (!strictJsonResponse) {
    candidate = invalidActionOutputResponse(response);
  } else if (
    measureSerializedUtf8Bytes(
      strictJsonResponse,
      EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    ) > EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES
  ) {
    candidate = {
      v: 1,
      actionId: strictJsonResponse.actionId,
      ...(strictJsonResponse.requestId === undefined ? {} : { requestId: strictJsonResponse.requestId }),
      execution: createExternalActionResultTooLargeExecutionV1(),
    };
  } else {
    candidate = strictJsonResponse;
  }

  let body: string | undefined;
  try {
    body = JSON.stringify(candidate);
  } catch {
    // Supported engines do not agree on JSON nesting depth. This is not a
    // size policy, so preserve the existing permanent Action-output failure.
    const invalidActionOutput = invalidActionOutputResponse(candidate);
    const invalidActionOutputBody = JSON.stringify(invalidActionOutput);
    if (invalidActionOutputBody === undefined) {
      throw new TypeError('External Action response envelope must serialize to JSON');
    }
    return {
      response: invalidActionOutput,
      body: invalidActionOutputBody,
      byteLength: measurePluginJsonUtf8Bytes(invalidActionOutputBody, 'externalActionResponse'),
    };
  }
  if (body === undefined) {
    throw new TypeError('External Action response envelope must serialize to JSON');
  }
  return {
    response: candidate,
    body,
    byteLength: measurePluginJsonUtf8Bytes(body, 'externalActionResponse'),
  };
}

/**
 * Applies the one response ceiling after Action execution. Oversize output is
 * replaced with a small admitted result while retaining request correlation.
 */
export function enforceExternalActionResponseEnvelopeLimitV1(
  value: unknown,
): ExternalActionResponseEnvelopeV1 {
  return prepareExternalActionResponseEnvelopeV1(value).response;
}

/**
 * The one native JSON body projection for a public Action response. Both
 * Fastify origins consume this pre-serialized representation so a valid
 * Protocol value cannot reach one adapter only to fail during serialization.
 */
export function serializeExternalActionResponseEnvelopeV1(value: unknown): Readonly<{
  body: string;
  byteLength: number;
}> {
  const prepared = prepareExternalActionResponseEnvelopeV1(value);
  return {
    body: prepared.body,
    byteLength: prepared.byteLength,
  };
}

const ExternalActionTargetIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(256), z.refine((value) => value.trim() === value, 'target id must not have outer whitespace')));

/**
 * Closed Account-server bootstrap projection used only to select an exact
 * Machine for a subsequent external Action request.
 *
 * Machine metadata and daemon state do not cross this PAT-authenticated seam.
 * A shared persistent target carries only its safe access/resource mode, exact
 * installation and current recipient-sealed key. A restricted Runner carries the
 * facts a protected request must seal against — its kind, its winning
 * installation, its Account-sealed content-key envelope, the strict
 * non-secret binding that authenticates it and the activation-signed claim
 * that binds it to its Session. None is usable without Account material: the
 * envelope is a sealed box only an Account content key opens, and the binding
 * and claim carry only public keys and signatures. A bearer-only token
 * therefore cannot open encrypted Machine content, and an encryption-capable credential
 * reaches the same verifier every other authorized Account device reaches.
 */
export const ExternalActionMachineBootstrapV1Schema = lazyZodSchema(() => z.strictObject({
  id: ExternalActionTargetIdV1Schema,
  managedMachineRef: ManagedMachineRefReadV1Schema,
  active: z.boolean(),
  revokedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
  replacedByMachineId: z.nullable(ExternalActionTargetIdV1Schema),
  kind: MachineKindFromLegacyProjectionSchema,
  /**
   * Runner only; the activation-signed claim persisted when the endpoint claimed
   * this Runner. It is how a Session-targeted protected request selects the
   * Runner that Session was activated for: the claim signs activation, Session,
   * Machine and installation under the activation identity the reader already
   * trusts for the content-key binding, so the Home relays the correspondence
   * but cannot author it. It carries public keys and proofs only, never a
   * credential.
   */
  runnerClaim: z._default(z.nullable(RunnerClaimV1Schema), null),
  /** Exact current installation for Runner or admitted shared persistent target. */
  installationId: z._default(z.nullable(z.string().check(z.trim(), z.minLength(1))), null),
  dataEncryptionKey: z._default(z.nullable(z.string().check(z.minLength(1))), null),
  runnerContentKeyBinding: z._default(z.nullable(RunnerMachineContentKeyBindingV1Schema), null),
  /** Safe target resource facts; this is discovery, never effect authority. */
  access: z.optional(AccessibleMachineAccessV1Schema),
  sharedWithTeamScope: z.optional(ResourceTeamShareScopeV1Schema),
}));
export type ExternalActionMachineBootstrapV1 = z.infer<
  typeof ExternalActionMachineBootstrapV1Schema
>;

export const ExternalActionMachineBootstrapListV1Schema = lazyZodSchema(() => z.array(
  ExternalActionMachineBootstrapV1Schema,
));
export type ExternalActionMachineBootstrapListV1 = z.infer<
  typeof ExternalActionMachineBootstrapListV1Schema
>;

/**
 * Target selection is transport metadata only. It never becomes Action input,
 * caller provenance, approval state, or a contributor-generation assertion.
 */
export const ExternalActionTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('machine'),
    machineId: ExternalActionTargetIdV1Schema,
    /** Optional machine-local project target, cryptographically bound as transport metadata. */
    project: z.optional(WorkflowProjectTargetV1Schema),
  }).check(z.superRefine((value, context) => {
    if (value.project && value.project.machineId !== value.machineId) {
      context.addIssue({
        code: "custom",
        path: ['project', 'machineId'],
        message: 'project target must match machineId',
      });
    }
  })),
  z.strictObject({
    kind: z.literal('session'),
    sessionId: ExternalActionTargetIdV1Schema,
  }),
]));
export type ExternalActionTargetV1 = z.infer<typeof ExternalActionTargetV1Schema>;

/** One strict equality owner for cryptographically bound external Action targets. */
export function externalActionTargetsEqualV1(
  left: ExternalActionTargetV1,
  right: ExternalActionTargetV1,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'session') {
    return right.kind === 'session' && left.sessionId === right.sessionId;
  }
  if (right.kind !== 'machine' || left.machineId !== right.machineId) return false;
  if (!left.project || !right.project) return left.project === right.project;
  return left.project.machineId === right.project.machineId
    && left.project.directory === right.project.directory
    && left.project.workspaceRefId === right.project.workspaceRefId
    && sameStrictJsonValue(left.project.sessionPlacement, right.project.sessionPlacement);
}

/**
 * A Home authorizes one exact outer target and one selected relay Machine.
 * That Machine may resolve its own outer Machine target to an exact Session,
 * but it may not substitute another Machine or mutate a project target.
 */
export function isExternalActionResolvedTargetAllowedV1(input: Readonly<{
  authorizedTarget: ExternalActionTargetV1;
  resolvedTarget: ExternalActionTargetV1;
  selectedMachineId: string;
}>): boolean {
  if (input.authorizedTarget.kind === 'session') {
    return externalActionTargetsEqualV1(input.authorizedTarget, input.resolvedTarget);
  }
  if (input.authorizedTarget.machineId !== input.selectedMachineId) return false;
  return input.resolvedTarget.kind === 'session'
    || externalActionTargetsEqualV1(input.authorizedTarget, input.resolvedTarget);
}

/**
 * Public Action HTTP request envelope. Execution context is deliberately
 * absent: each ingress verifies credentials and stamps authority, provenance,
 * cancellation, and placement after this parser succeeds.
 */
const ExternalActionManagedAcquireAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.literal('machines.managed.acquire'),
  input: ManagedAdmissionComputeInputV1Schema,
  continuationPresent: z.boolean(),
}));
const ExternalActionManagedInspectAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.literal('machines.managed.inspect'), input: ManagedResourceTargetV1Schema,
}));
const ExternalActionManagedExecAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.literal(MANAGED_EXEC_ACTION_ID_V1), input: ManagedResourceTargetV1Schema,
}));
const ExternalActionManagedRetryAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.literal('machines.managed.bootstrap.retry'), input: ManagedBootstrapRetryInputV1Schema,
}));
const ExternalActionManagedCancelAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.literal('machines.managed.cancel'), input: ManagedMutationInputV1Schema,
  authority: z.optional(z.literal('creator_recovery')),
}));
const ExternalActionManagedCreationMutationAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.enum(MANAGED_CREATION_MUTATION_ACTION_IDS_V1.filter(actionId => actionId !== 'machines.managed.cancel')),
  input: ManagedMutationInputV1Schema,
}));
const ExternalActionManagedCredentialInstallAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.literal('machines.managed.credentials.install'), input: ManagedCredentialInstallInputV1Schema,
}));
const ExternalActionManagedOperationListAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.literal('action.operations.list'), input: ManagedResourceTargetV1Schema,
}));
const ExternalActionManagedOperationGetAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.literal('action.operations.get'), input: z.strictObject({ ...ManagedResourceTargetV1Schema.shape,
    operationId: ActionOperationGetActionInputV1Schema.shape.operationId }),
}));
export const ExternalActionManagedControlAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  z.strictObject({ actionId: z.literal('machines.managed.power.set'), input: ManagedPowerInputV1Schema }),
  z.strictObject({ actionId: z.literal('machines.managed.delete'), input: ManagedDeleteInputV1Schema,
    authority: z.optional(z.literal('creator_recovery')) }),
  z.strictObject({ actionId: z.literal('machines.managed.resize'), input: ManagedResizeInputV1Schema }),
]));
export type ExternalActionManagedControlAdmissionV1 = z.infer<typeof ExternalActionManagedControlAdmissionV1Schema>;
export const ExternalActionManagedRecoveryAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  ExternalActionManagedCredentialInstallAdmissionV1Schema,
  ExternalActionManagedExecAdmissionV1Schema,
  ExternalActionManagedInspectAdmissionV1Schema, ExternalActionManagedRetryAdmissionV1Schema,
  ExternalActionManagedCancelAdmissionV1Schema, ExternalActionManagedCreationMutationAdmissionV1Schema,
  ExternalActionManagedOperationListAdmissionV1Schema, ExternalActionManagedOperationGetAdmissionV1Schema,
]));
export const ExternalActionManagedAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  ExternalActionManagedCredentialInstallAdmissionV1Schema,
  ExternalActionManagedExecAdmissionV1Schema,
  ExternalActionManagedAcquireAdmissionV1Schema, ExternalActionManagedInspectAdmissionV1Schema, ExternalActionManagedRetryAdmissionV1Schema,
  ExternalActionManagedCancelAdmissionV1Schema, ExternalActionManagedCreationMutationAdmissionV1Schema,
  ExternalActionManagedOperationListAdmissionV1Schema, ExternalActionManagedOperationGetAdmissionV1Schema,
  ...ExternalActionManagedControlAdmissionV1Schema.def.options,
]));
export type ExternalActionManagedAdmissionV1 = z.infer<typeof ExternalActionManagedAdmissionV1Schema>;

/** Managed recovery exposes only the exact resource/revision needed for Home admission. */
export function projectExternalActionManagedAdmissionV1(actionId: string, input: unknown): ExternalActionManagedAdmissionV1 | undefined {
  if (isManagedControlAdmissionActionIdV1(actionId)) {
    return ExternalActionManagedControlAdmissionV1Schema.parse({ actionId, input });
  }
  if (actionId === 'machines.managed.credentials.install') return { actionId, input: ManagedCredentialInstallInputV1Schema.parse(input) };
  if (actionId === 'machines.managed.acquire') {
    const { agentStart, ...compute } = ManagedAcquireInputV1Schema.parse(input);
    return { actionId, input: ManagedAdmissionComputeInputV1Schema.parse(compute), continuationPresent: agentStart !== undefined };
  }
  if (actionId === 'machines.managed.inspect') {
    const { homeId, managedId } = ManagedInspectInputV1Schema.parse(input);
    return { actionId, input: { homeId, managedId } };
  }
  if (actionId === MANAGED_EXEC_ACTION_ID_V1) {
    const { homeId, managedId } = ManagedExecInputV1Schema.parse(input);
    return { actionId, input: { homeId, managedId } };
  }
  if (actionId === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1) {
    const { guestCli: _requesterPayload, ...operands } = ManagedBootstrapRetryInputV1Schema.parse(input);
    return { actionId, input: operands };
  }
  if (isManagedCreationMutationActionIdV1(actionId)) {
    return { actionId, input: ManagedMutationInputV1Schema.parse(input) };
  }
  if (actionId === 'action.operations.list') {
    const request = ActionOperationListActionInputV1Schema.parse(input);
    return request.managed ? { actionId, input: request.managed } : undefined;
  }
  if (actionId === 'action.operations.get') {
    const request = ActionOperationGetActionInputV1Schema.parse(input);
    return request.managed ? { actionId, input: { ...request.managed, operationId: request.operationId } } : undefined;
  }
  return undefined;
}

/** Compare requester operands without reinterpreting Home-owned signed facts as requester choices. */
export function projectExternalActionManagedAdmissionOperandV1(
  admission: ExternalActionExecutionAuthorizationBindingV1['managedAdmission'],
): ExternalActionManagedAdmissionV1 | undefined {
  return admission && ('authority' in admission || admission.actionId === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1)
    ? projectExternalActionManagedAdmissionV1(admission.actionId, admission.input) : admission;
}

/** Closed routing hints; only the authenticated Home can turn them into custody authority. */
export const ExternalActionHandoffAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: ExternalActionTargetIdV1Schema,
  sourceMachineId: ExternalActionTargetIdV1Schema,
  targetMachineId: ExternalActionTargetIdV1Schema,
}));
export type ExternalActionHandoffAdmissionV1 = z.infer<typeof ExternalActionHandoffAdmissionV1Schema>;
/**
 * The one requester projection of a Handoff's admission operands. The signed
 * request targets the Session's own Machine, so that Machine is the source;
 * Home re-reads both Machines and the Session binding before admitting it.
 */
export function projectExternalActionHandoffAdmissionV1(params: Readonly<{
  actionId: string;
  input: unknown;
  sourceMachineId: string;
}>): ExternalActionHandoffAdmissionV1 | undefined {
  if (params.actionId !== 'session.handoff' || !params.input || typeof params.input !== 'object') return undefined;
  const input = params.input as Readonly<{ sessionId?: unknown; targetMachineId?: unknown }>;
  const trim = (value: unknown) => typeof value === 'string' ? value.trim() : value;
  const admission = ExternalActionHandoffAdmissionV1Schema.safeParse({ sessionId: trim(input.sessionId),
    sourceMachineId: trim(params.sourceMachineId), targetMachineId: trim(input.targetMachineId) });
  return admission.success ? admission.data : undefined;
}
/** Both installations are issuer-observed, not inferred from a caller's Machine id. */
export const ExternalActionHandoffBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalActionHandoffAdmissionV1Schema, {
  sourceInstallationId: ExternalActionTargetIdV1Schema,
  targetInstallationId: ExternalActionTargetIdV1Schema,
})));
export const ExternalActionHandoffContinuationV1Schema = lazyZodSchema(() => z.strictObject({
  rootRequestId: ExternalActionRequestIdV1Schema,
  rootRequestEnvelopeDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  handoffId: ExternalActionTargetIdV1Schema,
}));

/** Bound once by the original Workflow caller and protected by the root envelope digest. */
export const ExternalActionWorkflowPreparationV1Schema = lazyZodSchema(() => z.strictObject({
  /** Authored placement retained before the transport target binds a controller. */
  project: WorkflowProjectTargetV1Schema,
  acquisition: z.extend(z.omit(ManagedAcquireInputV1Schema._zod.def.options[1], { agentStart: true }), {
    controller: ManagedControllerV1Schema,
  }),
}));
export type ExternalActionWorkflowPreparationV1 = z.infer<typeof ExternalActionWorkflowPreparationV1Schema>;

/** The reviewed target preserves authored intent while routing to the selected controller. */
export function projectExternalActionWorkflowPreparationTargetV1(
  preparation: ExternalActionWorkflowPreparationV1,
): Extract<ExternalActionTargetV1, { kind: 'machine' }> | null {
  const placement = preparation.project.sessionPlacement;
  const selection = preparation.acquisition.selection;
  if (placement?.kind !== 'preset' || placement.homeId !== selection.homeId || placement.presetId !== selection.id) return null;
  const machineId = preparation.acquisition.controller.machineId;
  const { workspaceRefId: _previousWorkspace, ...authoredProject } = preparation.project;
  return { kind: 'machine', machineId, project: machineId === preparation.project.machineId
    ? preparation.project : { ...authoredProject, machineId } };
}

export const ExternalActionRequestEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  requestId: z.optional(ExternalActionRequestIdV1Schema),
  idempotencyKey: z.optional(AutomationManualIdempotencyKeyV1Schema),
  target: z.optional(ExternalActionTargetV1Schema),
  input: StrictJsonValueSchema,
  workflowPreparation: z.optional(ExternalActionWorkflowPreparationV1Schema),
  resourceContinuation: z.optional(MachineServiceLogsResourceContinuationV1Schema),
  machineServiceLogsGeneration: z.optional(MachineServiceLogsGenerationV1Schema),
  /** Private requester read operand; ordinary registry Action input remains metadata-only. */
  registryThemeContent: z.optional(z.literal(true)),
  /** Commitment only. The selected input opens from the installation-sealed requester context. */
  selectedActionInputDigest: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u))),
  pluginInvocation: z.optional(DaemonPluginMountedInvocationV1Schema),
  managedAdmission: z.optional(ExternalActionManagedAdmissionV1Schema),
  managedCreationCodec: z.optional(SessionRequesterInstallationSealedBootstrapV1Schema),
  sessionSpawnAdmission: z.optional(ApiTokenSessionSpawnAdmissionV1Schema),
  handoffAdmission: z.optional(ExternalActionHandoffAdmissionV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.workflowPreparation) {
    const expected = projectExternalActionWorkflowPreparationTargetV1(value.workflowPreparation);
    if (!expected || !value.target || !externalActionTargetsEqualV1(expected, value.target)) {
      context.addIssue({ code: 'custom', path: ['workflowPreparation'], message: 'Workflow preparation target mismatch' });
    }
  }
  if (value.pluginInvocation && !value.requestId) {
    context.addIssue({ code: "custom", path: ['requestId'], message: 'Mounted plugin invocation requires requestId' });
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'input')) {
    context.addIssue({
      code: "custom",
      path: ['input'],
      message: 'input is required',
    });
  }
})));
export type ExternalActionRequestEnvelopeV1 = z.infer<
  typeof ExternalActionRequestEnvelopeV1Schema
>;

const resetFactDigest = (fact: string, parts: readonly string[]) => computeCanonicalDomainSeparatedDigest(
  // JSON escaping preserves lone UTF-16 surrogates that raw UTF-8 encoding
  // would collapse into the replacement character, changing identity equality.
  `happier.external-action.pending-reset-start.${fact}.v1`, parts.map(part => JSON.stringify(part)),
);
type ResetBinding = z.infer<typeof PendingResetStartSetInputV1Schema>['reset'];
export function projectExternalActionPendingResetStartSessionDigestV1(sessionId: string): string {
  return resetFactDigest('session', [PendingResetStartSetInputV1Schema.shape.sessionId.parse(sessionId)]);
}
export type ExternalActionPendingResetStartReadPurposeV1 =
  | Readonly<{ kind: 'source'; source: ResetBinding['source'] }>
  | Readonly<{ kind: 'record'; recordId: string }>
  | Readonly<{ kind: 'witness'; witness: ResetBinding['witness'] }>;

/** Same individually verifiable read selector representation used by the signed issuer. */
export function projectExternalActionPendingResetStartReadPurposeDigestV1(purpose: ExternalActionPendingResetStartReadPurposeV1): string {
  if (purpose.kind === 'record') return resetFactDigest('record', [PendingResetStartSetInputV1Schema.shape.reset.shape.recordId.parse(purpose.recordId)]);
  if (purpose.kind === 'witness') {
    const witness = PendingResetStartSetInputV1Schema.shape.reset.shape.witness.parse(purpose.witness);
    return resetFactDigest('witness', [witness.id, String(witness.observedAtMs)]);
  }
  const source = PendingResetStartSetInputV1Schema.shape.reset.shape.source.parse(purpose.source);
  return resetFactDigest('source', [source.bindingKind, source.ref.service.pluginId, source.ref.service.localId, source.ref.accountId,
    ...(source.bindingKind === 'group_member' ? [source.groupId, source.groupGeneration === undefined ? '' : String(source.groupGeneration)] : [])]);
}

/** Fixed-size exact reset purpose; no raw quota identity is copied into JWT headers. */
export const ExternalActionPendingResetStartAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  sessionDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  sourceDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  recordDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  witnessDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  mutationDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));
export type ExternalActionPendingResetStartAdmissionV1 = z.infer<typeof ExternalActionPendingResetStartAdmissionV1Schema>;

export function projectExternalActionPendingResetStartAdmissionV1(input: unknown): ExternalActionPendingResetStartAdmissionV1 {
  const { sessionId, localId, reset } = PendingResetStartSetInputV1Schema.parse(input);
  const sessionDigest = projectExternalActionPendingResetStartSessionDigestV1(sessionId);
  const sourceDigest = projectExternalActionPendingResetStartReadPurposeDigestV1({ kind: 'source', source: reset.source });
  const recordDigest = projectExternalActionPendingResetStartReadPurposeDigestV1({ kind: 'record', recordId: reset.recordId });
  const witnessDigest = projectExternalActionPendingResetStartReadPurposeDigestV1({ kind: 'witness', witness: reset.witness });
  return { sessionDigest, sourceDigest, recordDigest, witnessDigest,
    mutationDigest: resetFactDigest('mutation', [sessionId, localId, reset.meterId, sourceDigest, recordDigest, witnessDigest]) };
}

/** Non-content scope of a person's approval decision; private operands remain sealed. */
export const ExternalActionApprovalDecisionAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.minLength(1)),
  decision: z.enum(['approve', 'reject', 'cancel']),
}));
export type ExternalActionApprovalDecisionAdmissionV1 = z.infer<typeof ExternalActionApprovalDecisionAdmissionV1Schema>;

export function projectExternalActionApprovalDecisionAdmissionV1(input: unknown): ExternalActionApprovalDecisionAdmissionV1 {
  const fields = z.looseObject(ExternalActionApprovalDecisionAdmissionV1Schema.shape).parse(input);
  return { artifactId: fields.artifactId, decision: fields.decision };
}

/** V2 is closed at every routing and encryption boundary; content is opaque. */
const DeploymentStopReceiptV1Schema = lazyZodSchema(() => z.strictObject({
  deploymentId: DeploymentIdentifierV1Schema,
  expectedReceiptRevision: DeploymentRevisionV1Schema,
}));

export const ExternalActionRequestEnvelopeV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), requestId: ExternalActionRequestIdV1Schema,
  /** Requester-scoped access to one known operation opens with an invocation key. */
  requesterOperationRead: z.optional(z.literal(true)),
  telemetryCollectorCodec: z.optional(z.literal(true)),
  /** Non-content Browser Session operand; checked against the sealed command on open. */
  browserSessionId: z.optional(ExternalActionTargetIdV1Schema),
  /** Declaration-derived pre-effect runtime demand; private operands remain sealed. */
  machineRuntimeDemand: z.optional(z.literal('required')),
  idempotencyKey: z.optional(AutomationManualIdempotencyKeyV1Schema),
  /** Exact non-content Discussion root needed by Home-owned recipient repair. */
  discussionId: z.optional(DiscussionIdSchema),
  discussionTask: z.optional(asProtocolZod(TriageEntryRefV1Schema)),
  /** Non-content terminal session operand of a terminal read; the receiving Machine checks it against the sealed input. */
  terminalId: z.optional(TerminalStreamReadRequestSchema.shape.terminalId),
  target: z.optional(ExternalActionTargetV1Schema),
  pluginInvocation: z.optional(DaemonPluginMountedInvocationV1Schema),
  payload: z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1), maxCodeUnits(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2)) }),
  managedCreationCodec: z.optional(SessionRequesterInstallationSealedBootstrapV1Schema),
  managedAdmission: z.optional(ExternalActionManagedAdmissionV1Schema),
  sessionSpawnAdmission: z.optional(ApiTokenSessionSpawnAdmissionV1Schema),
  handoffAdmission: z.optional(ExternalActionHandoffAdmissionV1Schema),
  pendingResetStartAdmission: z.optional(ExternalActionPendingResetStartAdmissionV1Schema),
  workspaceSyncAdmission: z.optional(WorkspaceSyncAdmissionInputV1Schema),
  approvalDecisionAdmission: z.optional(ExternalActionApprovalDecisionAdmissionV1Schema),
  deploymentReadAdmission: z.optional(DeploymentReadAdmissionV1Schema),
  /** Exact non-content Link operand; Home derives its owner during issuance. */
  deploymentLinkEnvironmentId: z.optional(DeploymentIdentifierV1Schema),
  /** Exact non-content replaced Link, its revision and replacement installations. */
  deploymentLinkReplacement: z.optional(DeploymentLinkReplacementV1Schema),
  /** Exact non-content Environment operand for Home-authorized reads and binding preparation. */
  deploymentMetadataEnvironmentId: z.optional(DeploymentIdentifierV1Schema),
  /** Exact non-content receipt operand of a receipt read by its own id; Home binds that receipt's Environment during issuance. */
  deploymentMetadataReceiptId: z.optional(DeploymentIdentifierV1Schema),
  deploymentStopReceipt: z.optional(DeploymentStopReceiptV1Schema),
  presetPreparationAdmission: z.optional(z.union([ManagedMachinePresetPrepareInputV1Schema, ManagedMachinePresetRevisionInputV1Schema])),
  deploymentPreparationAdmission: z.optional(DeploymentPreparationAdmissionV1Schema),
  deploymentNativeAdmission: z.optional(DeploymentNativeAdmissionV1Schema),
  registryAppUpdateAdmission: z.optional(RegistryAppUpdateAdmissionV1Schema),
  projectSessionDefaultsAdmission: z.optional(ProjectSessionDefaultsAdmissionV1Schema),
  projectSourceCheckoutId: z.optional(ProjectAccountWorkspaceRefKeyV1Schema.shape.id),
}));
export type ExternalActionRequestEnvelopeV2 = z.infer<typeof ExternalActionRequestEnvelopeV2Schema>;
export const ExternalActionRequestEnvelopeSchema = lazyZodSchema(() => z.union([
  ExternalActionRequestEnvelopeV1Schema, ExternalActionRequestEnvelopeV2Schema,
]));
export type ExternalActionRequestEnvelope = z.infer<typeof ExternalActionRequestEnvelopeSchema>;
/** Stop carries only the exact receipt address and CAS operand. */
export function projectExternalActionDeploymentStopReceiptV1(actionId: string, input: unknown) {
  if (actionId !== DEPLOYMENT_CANCEL_ACTION_ID_V1) return undefined;
  const { deploymentId, expectedReceiptRevision } = z.looseObject(DeploymentStopReceiptV1Schema.shape).parse(input);
  return { deploymentId, expectedReceiptRevision };
}
export function projectExternalActionDeploymentStopEnvelopeReceiptV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>) {
  if (input.envelope.v === 1) return projectExternalActionDeploymentStopReceiptV1(input.actionId, input.envelope.input);
  if (input.actionId === DEPLOYMENT_CANCEL_ACTION_ID_V1) return DeploymentStopReceiptV1Schema.parse(input.envelope.deploymentStopReceipt);
  if (input.envelope.deploymentStopReceipt !== undefined) throw new TypeError('Unexpected Stop receipt');
  return undefined;
}

/** Public resource scope only; metadata content remains sealed in V2. */
export function projectExternalActionDeploymentMetadataEnvironmentIdV1(actionId: string, input: unknown): string | undefined {
  return (isDeploymentEnvironmentMetadataReadActionIdV1(actionId) || actionId === DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1
    || actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 || actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
    || actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1
    || actionId === DEPLOYMENT_ENVIRONMENT_DELETE_ACTION_ID_V1 || actionId === DEPLOYMENT_TARGET_UNLINK_ACTION_ID_V1
    || isDeploymentApprovalMetadataPreparationActionIdV1(actionId))
    ? actionId === DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1 && readRecord(input)?.environmentId === undefined ? undefined
      : z.looseObject({ environmentId: DeploymentIdentifierV1Schema }).parse(input).environmentId : undefined;
}
/** Only a bare receipt lookup or an exact receipt observation exposes the receipt operand. */
export function projectExternalActionDeploymentMetadataReceiptIdV1(actionId: string, input: unknown): string | undefined {
  return actionId === DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1
    || actionId === DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1 && readRecord(input)?.environmentId === undefined
    ? z.looseObject({ deploymentId: DeploymentIdentifierV1Schema }).parse(input).deploymentId : undefined;
}
export function projectExternalActionDeploymentMetadataEnvelopeReceiptIdV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): string | undefined {
  if (input.envelope.v === 1) return projectExternalActionDeploymentMetadataReceiptIdV1(input.actionId, input.envelope.input);
  if (input.actionId === DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1) {
    return projectExternalActionDeploymentMetadataReceiptIdV1(input.actionId,
      { deploymentId: input.envelope.deploymentMetadataReceiptId });
  }
  if (input.envelope.deploymentMetadataReceiptId === undefined) return undefined;
  if (input.actionId !== DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1 || input.envelope.deploymentMetadataEnvironmentId !== undefined) {
    throw new TypeError('Unexpected metadata receipt');
  }
  return input.envelope.deploymentMetadataReceiptId;
}
export function projectExternalActionDeploymentMetadataEnvelopeEnvironmentIdV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): string | undefined {
  if (input.envelope.v === 1) return projectExternalActionDeploymentMetadataEnvironmentIdV1(input.actionId, input.envelope.input);
  const environmentId = projectExternalActionDeploymentMetadataEnvironmentIdV1(input.actionId,
    { environmentId: input.envelope.deploymentMetadataEnvironmentId });
  if (environmentId === undefined && input.envelope.deploymentMetadataEnvironmentId !== undefined) {
    throw new TypeError('Unexpected metadata Environment');
  }
  return environmentId;
}
/** The same non-content Link operand is used by plain and encrypted request producers. */
export function projectExternalActionDeploymentLinkEnvironmentIdV1(actionId: string, input: unknown): string | undefined {
  return actionId === 'deployments.targets.link'
    ? z.looseObject({ environmentId: DeploymentIdentifierV1Schema }).parse(input).environmentId : undefined;
}
export function projectExternalActionDeploymentLinkEnvelopeEnvironmentIdV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): string | undefined {
  if (input.envelope.v === 1) return projectExternalActionDeploymentLinkEnvironmentIdV1(input.actionId, input.envelope.input);
  if (input.actionId !== 'deployments.targets.link') {
    if (input.envelope.deploymentLinkEnvironmentId !== undefined) throw new TypeError('Unexpected Link Environment');
    return undefined;
  }
  return DeploymentIdentifierV1Schema.parse(input.envelope.deploymentLinkEnvironmentId);
}
/** A Link replacement's reviewed operand: the replaced Link, its exact revision and the replacement installations. */
export const DeploymentLinkReplacementV1Schema = lazyZodSchema(() => z.strictObject({
  replacesLinkId: DeploymentIdentifierV1Schema,
  expectedTargetLinkRevision: DeploymentRevisionV1Schema,
  machines: DeploymentTargetMachinesV1Schema,
}));
export type DeploymentLinkReplacementV1 = z.infer<typeof DeploymentLinkReplacementV1Schema>;
/** The same non-content replacement operand is used by plain and encrypted request producers. */
export function projectExternalActionDeploymentLinkReplacementV1(actionId: string, input: unknown): DeploymentLinkReplacementV1 | undefined {
  if (actionId !== 'deployments.targets.link') return undefined;
  const link = z.looseObject({ replacesLinkId: z.optional(z.unknown()), expectedTargetLinkRevision: z.optional(z.unknown()),
    machines: z.optional(z.unknown()) }).parse(input);
  return link.replacesLinkId === undefined ? undefined : DeploymentLinkReplacementV1Schema.parse({
    replacesLinkId: link.replacesLinkId, expectedTargetLinkRevision: link.expectedTargetLinkRevision, machines: link.machines });
}
export function projectExternalActionDeploymentLinkEnvelopeReplacementV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): DeploymentLinkReplacementV1 | undefined {
  if (input.envelope.v === 1) return projectExternalActionDeploymentLinkReplacementV1(input.actionId, input.envelope.input);
  if (input.actionId !== 'deployments.targets.link' && input.envelope.deploymentLinkReplacement !== undefined) {
    throw new TypeError('Unexpected Link replacement');
  }
  return input.envelope.deploymentLinkReplacement;
}
/** Only routing identities are visible to Home. Authored content stays sealed. */
export function projectExternalActionDiscussionOperandsV1(actionId: string, input: unknown) {
  if (!isDiscussionActionIdV1(actionId) || input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  const id = DiscussionIdSchema.safeParse(Reflect.get(input, 'discussionId'));
  const task = TriageEntryRefV1Schema.safeParse(Reflect.get(input, 'anchorTask'));
  if (id.success && task.success) throw new TypeError('Ambiguous Discussion operands');
  return { ...(id.success ? { discussionId: id.data } : {}), ...(task.success ? { discussionTask: task.data } : {}) };
}
/** V1 derives the operand from plaintext. V2 authenticates the same routing identity on open. */
export function projectExternalActionDiscussionEnvelopeOperandsV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>) {
  if (input.envelope.v === 1) return projectExternalActionDiscussionOperandsV1(input.actionId, input.envelope.input);
  const { discussionId, discussionTask } = input.envelope;
  if ((discussionId !== undefined || discussionTask !== undefined) && !isDiscussionActionIdV1(input.actionId)
    || (discussionId !== undefined && discussionTask !== undefined)) {
    throw new TypeError('Unexpected Discussion admission');
  }
  return { ...(discussionId === undefined ? {} : { discussionId }), ...(discussionTask === undefined ? {} : { discussionTask }) };
}

/** The terminal session an interactive read addresses; V2 carries it as a non-content operand. */
export function projectExternalActionTerminalSessionEnvelopeIdV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): string | undefined {
  if (!isMachineTerminalSessionReadActionIdV1(input.actionId)) return undefined;
  if (input.envelope.v === 2) return input.envelope.terminalId;
  const fields = z.looseObject({ terminalId: TerminalStreamReadRequestSchema.shape.terminalId }).safeParse(input.envelope.input);
  return fields.success ? fields.data.terminalId : undefined;
}

/**
 * A foreign Account-credential terminal read is admitted once per terminal session: its root
 * binds the session instead of one page. Home re-reads current Machine access for each later
 * page; the Machine refuses this root for finite output, which keeps per-request admission.
 */
export function projectExternalActionTerminalSessionBindingV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope; accountId: string; custodianAccountId: string;
  authenticationKind: string | undefined;
}>): Readonly<{ terminalId: string }> | undefined {
  if (input.authenticationKind !== 'account' || input.accountId === input.custodianAccountId
    || input.envelope.v === 2 && input.envelope.requesterOperationRead) return undefined;
  const terminalId = projectExternalActionTerminalSessionEnvelopeIdV1(input);
  return terminalId === undefined ? undefined : { terminalId };
}
/** One selection projection for editable defaults and creation preparation. */
export function projectExternalActionProjectSessionDefaultsAdmissionV1(actionId: string, input: unknown): ProjectSessionDefaultsAdmissionV1 | undefined {
  if (actionId === PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1) return ProjectSessionDefaultsGetInputV1Schema.parse(input);
  if (actionId !== SESSION_SPAWN_NEW_ACTION_ID_V1 && actionId !== BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) return undefined;
  const creation = actionId === BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 && input !== null && typeof input === 'object'
    ? Reflect.get(input, 'creation') : input;
  if (creation === null || typeof creation !== 'object' || Array.isArray(creation)) return undefined;
  const projectContext = ProjectSessionDefaultsContextSelectionV1Schema.parse(Reflect.get(creation, 'projectContext') ?? {});
  const primaryTeamId = Reflect.get(creation, 'primaryTeamId');
  if (!projectContext.projectRef && !projectContext.sourceRef) {
    return actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && primaryTeamId != null
      ? ProjectSessionDefaultsAdmissionV1Schema.parse({ primaryTeamId }) : undefined;
  }
  const initialAccess = Reflect.get(creation, 'initialAccess');
  const sharedTeamIds = initialAccess === undefined ? undefined : SessionInitialAccessDraftV1Schema.parse(initialAccess).grants
    .flatMap(grant => grant.subject.kind === 'account' ? [] : [grant.subject.teamId]);
  return ProjectSessionDefaultsAdmissionV1Schema.parse({ ...projectContext,
    ...(primaryTeamId === undefined ? {} : { primaryTeamId }), ...(sharedTeamIds === undefined ? {} : { sharedTeamIds }) });
}

export function projectExternalActionProjectSessionDefaultsEnvelopeAdmissionV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): ProjectSessionDefaultsAdmissionV1 | undefined {
  if (input.envelope.v === 1) return projectExternalActionProjectSessionDefaultsAdmissionV1(input.actionId, input.envelope.input);
  if (input.actionId !== PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1 && input.actionId !== SESSION_SPAWN_NEW_ACTION_ID_V1
    && input.actionId !== BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) {
    if (input.envelope.projectSessionDefaultsAdmission !== undefined) throw new TypeError('Unexpected Project defaults admission');
    return undefined;
  }
  return input.envelope.projectSessionDefaultsAdmission === undefined ? undefined
    : (input.actionId === PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1 ? ProjectSessionDefaultsGetInputV1Schema
      : ProjectSessionDefaultsAdmissionV1Schema).parse(input.envelope.projectSessionDefaultsAdmission);
}

/** The Home signs the checkout row id. The managed address stays inside the Action input. */
export function projectExternalActionProjectSourceCheckoutIdV1(actionId: string, input: unknown): string | undefined {
  if (actionId !== PROJECT_SOURCE_CREATE_ACTION_ID_V1 || input === null || typeof input !== 'object'
    || !Object.hasOwn(input, 'checkout') || Reflect.get(input, 'checkout') === undefined) return undefined;
  return ProjectSourcesCreateActionInputV1Schema.parse(input).checkout?.workspaceId;
}

export function projectExternalActionProjectSourceCheckoutEnvelopeIdV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): string | undefined {
  if (input.envelope.v === 1) return projectExternalActionProjectSourceCheckoutIdV1(input.actionId, input.envelope.input);
  if (input.actionId !== PROJECT_SOURCE_CREATE_ACTION_ID_V1 && input.envelope.projectSourceCheckoutId !== undefined) {
    throw new TypeError('Unexpected Project Source checkout admission');
  }
  return input.envelope.projectSourceCheckoutId;
}

export function projectExternalActionRegistryAppUpdateEnvelopeAdmissionV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): RegistryAppUpdateAdmissionV1 | undefined {
  if (input.actionId !== 'registries.updates.check') {
    if (input.envelope.v === 2 && input.envelope.registryAppUpdateAdmission) throw new TypeError('Unexpected registry app admission');
    return undefined;
  }
  return input.envelope.v === 1 ? projectRegistryAppUpdateAdmissionV1(input.actionId, input.envelope.input)
    : input.envelope.registryAppUpdateAdmission;
}
/** The exact non-content preset scope is authenticated with the original request envelope. */
export function projectExternalActionPresetPreparationEnvelopeAdmissionV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): z.infer<typeof ManagedMachinePresetPrepareInputV1Schema> | z.infer<typeof ManagedMachinePresetRevisionInputV1Schema> | undefined {
  if (input.actionId !== MACHINE_PRESET_PREPARE_ACTION_ID_V1 && input.actionId !== MACHINE_PRESET_ARCHIVE_ACTION_ID_V1) {
    if (input.envelope.v === 2 && input.envelope.presetPreparationAdmission !== undefined)
      throw new TypeError('Unexpected preset preparation admission');
    return undefined;
  }
  const schema = input.actionId === MACHINE_PRESET_PREPARE_ACTION_ID_V1
    ? ManagedMachinePresetPrepareInputV1Schema : ManagedMachinePresetRevisionInputV1Schema;
  return schema.parse(input.envelope.v === 1
    ? input.envelope.input : input.envelope.presetPreparationAdmission);
}
export function projectExternalActionDeploymentPreparationEnvelopeAdmissionV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): DeploymentPreparationAdmissionV1 | undefined {
  const operation = deploymentPreparationOperationForActionV1(input.actionId);
  if (operation === undefined) {
    if (input.envelope.v === 2 && input.envelope.deploymentPreparationAdmission) throw new TypeError('Unexpected deployment preparation admission');
    return undefined;
  }
  const admission = input.envelope.v === 1 ? projectDeploymentPreparationAdmissionV1(input.actionId, input.envelope.input)
    : input.envelope.deploymentPreparationAdmission === undefined ? undefined
      : DeploymentPreparationAdmissionV1Schema.parse(input.envelope.deploymentPreparationAdmission);
  if (admission ? admission.operation !== operation : isDeploymentPreparationActionIdV1(input.actionId)) throw new TypeError('Deployment preparation admission mismatch');
  return admission;
}
export function projectExternalActionDeploymentNativeEnvelopeAdmissionV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>) {
  const native = input.actionId === 'deployments.deploy' || input.actionId === 'deployments.rollback'
    || input.actionId === 'deployments.promote' || input.actionId === 'deployments.teardown'
    || input.actionId === 'deployments.restart' || input.actionId === 'deployments.backups.restore' || isDeploymentBackupActionIdV1(input.actionId)
    || input.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1
    || input.actionId === DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1
    || isDeploymentDomainChildActionIdV1(input.actionId) || input.actionId === 'deployments.environments.update';
  const operationRead = input.actionId === 'action.operations.get';
  if (!native && !operationRead) {
    if (input.envelope.v === 2 && input.envelope.deploymentNativeAdmission) throw new TypeError('Unexpected native deployment admission');
    return undefined;
  }
  const admission = input.envelope.v === 1 ? projectDeploymentNativeAdmissionV1(input.actionId, input.envelope.input)
    : (operationRead || input.actionId === 'deployments.environments.update') && input.envelope.deploymentNativeAdmission === undefined ? undefined
      : DeploymentNativeAdmissionV1Schema.parse(input.envelope.deploymentNativeAdmission);
  if (admission && 'kind' in admission && admission.kind === 'promote' && !isDeploymentPromoteActionIdV1(input.actionId)) throw new TypeError('Native deployment admission mismatch');
  if (isDeploymentDomainDnsNativeAdmissionV1(admission)
    ? input.actionId !== admission.actionId
    : isDeploymentDomainChildActionIdV1(input.actionId)
      ? !isDeploymentDomainNativeAdmissionV1(admission) || admission.actionId !== input.actionId
      : isDeploymentDomainNativeAdmissionV1(admission)) throw new TypeError('Native deployment admission mismatch');
  if ((input.actionId === 'deployments.restart') !== (admission !== undefined && 'kind' in admission && admission.kind === 'restart')) {
    throw new TypeError('Native deployment restart admission mismatch');
  }
  if ((input.actionId === 'deployments.backups.restore') !== (admission !== undefined && 'kind' in admission && admission.kind === 'restore')) {
    throw new TypeError('Native deployment restore admission mismatch');
  }
  if (isDeploymentBackupActionIdV1(input.actionId)
    ? !isDeploymentBackupNativeAdmissionV1(admission) || admission.actionId !== input.actionId
    : isDeploymentBackupNativeAdmissionV1(admission)) {
    throw new TypeError('Native deployment backup admission mismatch');
  }
  if (input.actionId === 'deployments.environments.update' ? admission !== undefined
    && !isDeploymentEnvironmentUpdateNativeAdmissionV1(admission) : isDeploymentEnvironmentUpdateNativeAdmissionV1(admission)) {
    throw new TypeError('Native Environment update admission mismatch');
  }
  if ((input.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1) !== isDeploymentBackupConfigureNativeAdmissionV1(admission)) {
    throw new TypeError('Native backup configure admission mismatch');
  }
  if ((input.actionId === DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1) !== isDeploymentTelemetryNativeAdmissionV1(admission)) {
    throw new TypeError('Native telemetry admission mismatch');
  }
  return admission;
}
/** V1 derives from opened input; V2 exposes only the same closed non-content routing purpose. */
export function projectExternalActionDeploymentReadEnvelopeAdmissionV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): DeploymentReadAdmissionV1 | undefined {
  const requiresDeploymentReadAdmission = isDeploymentReadAdmissionActionIdV1(input.actionId);
  const qualifiedManagedQuery = input.actionId === ACTION_INVOKE_ACTION_ID_V1;
  if (!requiresDeploymentReadAdmission && !qualifiedManagedQuery) {
    if (input.envelope.v === 2 && input.envelope.deploymentReadAdmission) throw new TypeError('Unexpected deployment read admission');
    return undefined;
  }
  const admission = input.envelope.v === 1 ? projectDeploymentReadAdmissionV1(input.actionId, input.envelope.input)
    : qualifiedManagedQuery && input.envelope.deploymentReadAdmission === undefined
      ? undefined
      : DeploymentReadAdmissionV1Schema.parse(input.envelope.deploymentReadAdmission);
  if (admission === undefined ? requiresDeploymentReadAdmission : admission.actionId !== input.actionId) {
    throw new TypeError('Deployment read admission mismatch');
  }
  return admission;
}
/** Missing older-client metadata grants no approval-reply settlement purpose. */
export function projectExternalActionApprovalDecisionEnvelopeAdmissionV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope;
}>): ExternalActionApprovalDecisionAdmissionV1 | undefined {
  if (input.actionId !== 'approval.request.decide') {
    if (input.envelope.v === 2 && input.envelope.approvalDecisionAdmission) throw new TypeError('Unexpected approval decision admission');
    return undefined;
  }
  return input.envelope.v === 1 ? projectExternalActionApprovalDecisionAdmissionV1(input.envelope.input)
    : input.envelope.approvalDecisionAdmission;
}
/** One input-bound reset purpose for both Home issuance and ordinary daemon relay. */
export function projectExternalActionPendingResetStartEnvelopeAdmissionV1(input: Readonly<{
  actionId: string; envelope: ExternalActionRequestEnvelope; target?: ExternalActionTargetV1;
}>): ExternalActionPendingResetStartAdmissionV1 | undefined {
  if (input.actionId !== 'session.pending.resetStart.set') {
    if (input.envelope.v === 2 && input.envelope.pendingResetStartAdmission) throw new TypeError('Unexpected reset admission');
    return undefined;
  }
  const admission = input.envelope.v === 1
    ? projectExternalActionPendingResetStartAdmissionV1(input.envelope.input)
    : ExternalActionPendingResetStartAdmissionV1Schema.parse(input.envelope.pendingResetStartAdmission);
  const target = input.target ?? input.envelope.target;
  if (target?.kind === 'session' && projectExternalActionPendingResetStartSessionDigestV1(target.sessionId) !== admission.sessionDigest) {
    throw new TypeError('Reset admission target mismatch');
  }
  return admission;
}
/** Plain permits genuine protected transport too; encrypted never downgrades to V1. */
export function isExternalActionRequestVersionAllowedForAccountModeV1(input: Readonly<{
  accountEncryptionMode: AccountEncryptionMode; envelopeVersion: 1 | 2;
}>): boolean {
  return input.accountEncryptionMode === 'plain' || input.envelopeVersion === 2;
}
export const ExternalActionResponseEnvelopeV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), actionId: ExternalActionActionIdV1Schema, requestId: ExternalActionRequestIdV1Schema,
  payload: z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1), maxCodeUnits(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2)) }),
}));
export type ExternalActionResponseEnvelopeV2 = z.infer<typeof ExternalActionResponseEnvelopeV2Schema>;
export type PreparedExternalActionResponseEnvelope = Readonly<{
  response: ExternalActionResponseEnvelopeV1 | ExternalActionResponseEnvelopeV2;
  body: string;
  byteLength: number;
}>;

/** Version-specific ceilings retain the V1 decoded-content contract. */
export function isExternalActionRequestWithinLimit(envelope: ExternalActionRequestEnvelope): boolean {
  if (envelope.v === 1) return measurePluginJsonUtf8Bytes(JSON.stringify(envelope), 'externalActionRequest') <= EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES;
  const { pendingResetStartAdmission, ...withoutResetAdmission } = envelope;
  if (pendingResetStartAdmission === undefined) return measurePluginJsonUtf8Bytes(JSON.stringify(envelope), 'externalActionRequest') <= EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2;
  return measurePluginJsonUtf8Bytes(JSON.stringify(envelope), 'externalActionRequest') <= EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2
    && measurePluginJsonUtf8Bytes(JSON.stringify(withoutResetAdmission), 'externalActionRequest') <= EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2
    && measurePluginJsonUtf8Bytes(JSON.stringify(pendingResetStartAdmission), 'externalActionRequest') <= EXTERNAL_ACTION_PENDING_RESET_START_ADMISSION_MAX_UTF8_BYTES_V2;
}

const ExternalActionServerPrincipalIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(256), z.refine((value) => value.trim() === value, 'principal identifiers must not have outer whitespace')));

/** Server-stamped PAT provenance; it is never accepted in the public envelope. */
export const ExternalActionApiTokenServerPrincipalV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  principalId: ExternalActionServerPrincipalIdV1Schema,
  credentialId: ExternalActionServerPrincipalIdV1Schema,
  authority: z.literal('account_automation'),
  grant: ApiTokenGrantV1Schema,
  workflowActionOrigin: z.optional(z.lazy((): typeof ExternalActionWorkflowOriginV1Schema => ExternalActionWorkflowOriginV1Schema)),
}));
export const ExternalActionAccountAuthenticationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('account'),
  tokenEpoch: z.number().check(z.int(), z.nonnegative()),
  evidence: z.optional(AuthTokenAuthenticationEvidenceSnapshotV1Schema.shape.evidence),
}));
/** The real terminal bearer keeps its signed automation floor and Home epoch. */
export const ExternalActionTerminalAuthenticationV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalActionAccountAuthenticationV1Schema, { kind: z.literal('terminal') })));
export const ExternalActionSignedAuthenticationV1Schema = lazyZodSchema(() => z.union([
  ExternalActionAccountAuthenticationV1Schema, ExternalActionTerminalAuthenticationV1Schema,
]));
export type ExternalActionSignedAuthenticationV1 = z.infer<typeof ExternalActionSignedAuthenticationV1Schema>;
export const ExternalActionAccountServerPrincipalV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  authority: ActionRequiredAuthoritySchema,
  authentication: ExternalActionAccountAuthenticationV1Schema,
}));
export const ExternalActionTerminalServerPrincipalV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  authority: z.literal('account_automation'),
  authentication: ExternalActionTerminalAuthenticationV1Schema,
}));
/** Session automation requires the installed source's Home-admitted origin. */
export const ExternalActionSessionAccountServerPrincipalV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  authority: z.literal('account_automation'),
  authentication: ExternalActionSignedAuthenticationV1Schema,
  sessionActionOrigin: SessionActionRpcOriginV1Schema,
}));
/** The installed FIN executor proves this retained Run at Home. */
export const ExternalActionWorkflowOriginV1Schema = lazyZodSchema(() => z.strictObject({
  runId: ExternalActionTargetIdV1Schema, requestId: ExternalActionRequestIdV1Schema,
  /** Exact executing step Ask, signed with this Run origin. The receiver opens its private receipt. */
  stepApprovalArtifactId: z.optional(ExternalActionTargetIdV1Schema),
  reviewedChild: z.optional(z.lazy((): typeof ReviewedActionChildHttpProofV1Schema => ReviewedActionChildHttpProofV1Schema)),
  sessionLeaf: z.optional(ExternalActionWorkflowSessionLeafV1Schema),
  /** Accepted host facts only; Role content stays in the Session content envelope. */
  sessionAuthority: z.optional(z.strictObject({
    authorization: WorkflowAcceptedAuthorizationV1Schema,
    runDepth: z.number().check(z.int(), z.nonnegative()),
    runOriginSessionId: z.optional(ExternalActionTargetIdV1Schema),
    directory: z.string().check(z.minLength(1)),
    workspaceWrites: z.enum(['allow', 'deny']),
  })),
}).check(z.refine(value => !value.sessionLeaf || !value.sessionAuthority,
  'A Workflow origin carries one admitted caller.')));

/** Signed roots allowed to run on an installed Machine for an accepted Workflow. */
export function isExternalActionMachineWorkflowActionIdV1(actionId: string): boolean {
  return ManagedMachineActionIdV1Schema.safeParse(actionId).success
    || actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1
    || actionId === DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1
    || actionId === 'deployments.prepare'
    || actionId === 'deployments.templates.instantiate'
    || actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1
    // A Run may replace a runtime Link (Move); Home admits only the replacement shape.
    || actionId === 'deployments.targets.link'
    // Data Move health checks and its reviewed cutover; Home's read and native
    // admission owners still decide the Environment for the Run's Account.
    || isDeploymentNativeReadActionIdV1(actionId) || actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
    // Move's reviewed data-role grants; the bindings writer decides the runner's Manage right at the effect.
    || actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1
    || isDeploymentDomainChildActionIdV1(actionId)
    || isDeploymentBackupActionIdV1(actionId) || actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1
    || deploymentOperationForRootActionV1(actionId) !== undefined;
}

/** Deployments consume the installed Workflow root's caller and permission ceiling. */
export function isExternalActionDeploymentWorkflowActionIdV1(actionId: string): boolean {
  return isDeploymentActionIdV1(actionId) && isExternalActionMachineWorkflowActionIdV1(actionId);
}

/** The incumbent Workflow signed-root admission, shared by issuance and rechecks. */
export function isExternalActionWorkflowActionIdV1(actionId: string): boolean {
  return WorkflowActionIdV1Schema.safeParse(actionId).success
    || isExternalActionMachineWorkflowActionIdV1(actionId)
    || actionId.startsWith('session.') && isRoleActionIdV1(actionId);
}
export const ExternalActionWorkflowAccountServerPrincipalV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: ExternalActionServerPrincipalIdV1Schema,
  authority: z.literal('account_automation'),
  authentication: ExternalActionSignedAuthenticationV1Schema,
  workflowActionOrigin: ExternalActionWorkflowOriginV1Schema,
}));
export const ExternalActionServerPrincipalV1Schema = lazyZodSchema(() => z.union([
  ExternalActionApiTokenServerPrincipalV1Schema, ExternalActionAccountServerPrincipalV1Schema, ExternalActionTerminalServerPrincipalV1Schema,
  ExternalActionSessionAccountServerPrincipalV1Schema,
  ExternalActionWorkflowAccountServerPrincipalV1Schema,
]));
export type ExternalActionServerPrincipalV1 = z.infer<typeof ExternalActionServerPrincipalV1Schema>;

/** Issuer-derived exact fresh-creation tuple, rechecked at the child effect boundary. */
export const ExternalActionManagedContinuationV1Schema = lazyZodSchema(() => z.strictObject({
  managedId: ExternalActionTargetIdV1Schema,
  creationRequestId: ExternalActionRequestIdV1Schema,
  expectedIntentRevision: z.number().check(z.int(), z.nonnegative()),
  controller: z.optional(ManagedControllerV1Schema),
  acquireRequestEnvelopeDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));
export type ExternalActionManagedContinuationV1 = z.infer<typeof ExternalActionManagedContinuationV1Schema>;

const ExternalActionSessionSourceV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: ExternalActionTargetIdV1Schema, installationId: ExternalActionTargetIdV1Schema,
}));

/** Same admitted preset, authenticated by the existing root signature. */
export const ExternalActionSessionPresetAcquisitionV1Schema = lazyZodSchema(() => z.extend(ApiTokenSessionPresetAcquisitionV1Schema, {
  admission: z.optional(z.strictObject({
    preset: z.omit(ManagedMachinePresetV1BaseSchema, { content: true, recipients: true }),
    presetContent: ManagedAdmissionPresetContentV1Schema,
    delegated: z.boolean(),
  })),
}).check(z.refine(value => !value.admission || value.admission.preset.id === value.selection.id
  && value.admission.preset.homeId === value.selection.homeId && value.admission.preset.revision === value.selection.revision
  && (value.admission.preset.contentEncryptionMode === 'plain') === (value.admission.presetContent.content.t === 'plain'),
  { message: 'Admitted preset snapshot must match its selection and mode' })));
export type ExternalActionSessionPresetAcquisitionV1 = z.infer<typeof ExternalActionSessionPresetAcquisitionV1Schema>;

/**
 * One reviewed child the root was admitted with: Home selects these entries once at
 * mint from the declared table (`readDeploymentReviewedChildPlanV1`), and a child is
 * admitted only on an exact entry of its root's signed plan.
 */
export const DeploymentReviewedChildPlanEntryV1Schema = lazyZodSchema(() => z.strictObject({
  /** Exact role, or a role family ending in ':' whose operand the child carries. */
  role: z.string().check(z.minLength(1)),
  /** The child's own Action id; `plugin` is the target descriptor's qualified provider Action. */
  action: ExternalActionActionIdV1Schema,
  /** The Home effect the child spends, when it differs from its own Action. */
  effect: z.optional(ExternalActionActionIdV1Schema),
  /** A read child spends only GET requests without a body. */
  access: z.enum(['read', 'write']),
}));
export type DeploymentReviewedChildPlanEntryV1 = z.infer<typeof DeploymentReviewedChildPlanEntryV1Schema>;

/** Home-authenticated invocation facts. The selected daemon owns plaintext transformation. */
const externalActionExecutionAuthorizationRoutingShapeV1 = () => ({
    serverIdentityId: ExternalActionServerPrincipalIdV1Schema,
    machineId: ExternalActionTargetIdV1Schema,
    /** Requester identity remains accountId; custody is bound independently. */
    custodianAccountId: ExternalActionServerPrincipalIdV1Schema,
    installationId: ExternalActionTargetIdV1Schema,
    /** Effective grant already decided by Home Machine admission, never an operation-selected role. */
    admittedMachineRole: z.optional(z.enum(['use', 'manage'])),
    workspaceSyncAdmission: z.optional(WorkspaceSyncAdmissionV1Schema),
    actionId: ExternalActionActionIdV1Schema,
    /** Original runtime demand, authenticated with the exact request digest and target. */
    machineRuntimeDemand: z.optional(z.literal('required')),
    requestId: ExternalActionRequestIdV1Schema,
    requestEnvelopeDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    /** Exact run-now operand, stamped from the admitted plaintext request. */
    automationId: z.optional(ExternalActionTargetIdV1Schema),
    /** Exact non-content Discussion root admitted by the encrypted or plaintext request. */
    discussionId: z.optional(DiscussionIdSchema),
    discussionTask: z.optional(asProtocolZod(TriageEntryRefV1Schema)),
    /** Exact admitted Environment; no controller-wide Machine authority is implied. */
    environmentId: z.optional(DeploymentIdentifierV1Schema),
    idempotencyKey: z.optional(AutomationManualIdempotencyKeyV1Schema),
    target: ExternalActionTargetV1Schema,
    managedContinuation: z.optional(ExternalActionManagedContinuationV1Schema),
    managedAdmission: z.optional(z.union([ExternalActionManagedRecoveryAdmissionV1Schema, ExternalActionManagedControlAdmissionV1Schema])),
    /** Home admitted this exact preset using custodian-reviewed Team delegation. */
    managedAcquireDelegation: z.optional(z.literal(true)),
    /** Home admitted this Session's exact selected preset/controller carrier. */
    sessionPresetAcquisition: z.optional(ExternalActionSessionPresetAcquisitionV1Schema),
    /** Issuer-qualified private Account executor, scoped by the signed control admission. */
    managedAccountExecutor: z.optional(z.strictObject({ enrolledMachineId: ExternalActionTargetIdV1Schema })),
    /** Home-derived exact parent identity; only its installed post-approval child can establish this fact. */
    nativeCredentialSpawnChild: z.optional(z.strictObject({
      requestId: ExternalActionRequestIdV1Schema,
      requestEnvelopeDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    })),
    handoffAdmission: z.optional(ExternalActionHandoffBindingV1Schema),
    handoffContinuation: z.optional(ExternalActionHandoffContinuationV1Schema),
    handoffPreflight: z.optional(z.strictObject({
      rootRequestId: ExternalActionRequestIdV1Schema,
      rootRequestEnvelopeDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    })),
    accountEncryptionMode: z.optional(AccountEncryptionModeSchema),
    requesterOperationRead: z.optional(z.literal(true)),
    telemetryCollectorCodec: z.optional(z.literal(true)),
    /** Home-issued lineage for the exact collector read of an admitted scoped Usage root. */
    usageCollectorParent: z.optional(z.strictObject({
      requestId: ExternalActionRequestIdV1Schema,
      requestEnvelopeDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    })),
    sessionActionOrigin: z.optional(SessionActionRpcOriginV1Schema),
    sessionActionSource: z.optional(ExternalActionSessionSourceV1Schema),
    workflowActionOrigin: z.optional(ExternalActionWorkflowOriginV1Schema),
    pendingResetStartAdmission: z.optional(ExternalActionPendingResetStartAdmissionV1Schema),
    approvalDecisionAdmission: z.optional(ExternalActionApprovalDecisionAdmissionV1Schema),
    deploymentReadAdmission: z.optional(DeploymentReadAdmissionV1Schema),
    /** Home's metadata decision for the current installed Environment collector. */
    deploymentTelemetryRead: z.optional(DeploymentTelemetryReadFactsV1Schema),
    /** Home's database access and approval facts for the exact admitted target and requester. */
    deploymentDatabaseAccess: z.optional(z.strictObject({ summary: DatabaseAccessSummaryV1Schema,
      agentLevel: DatabaseAgentLevelV1Schema, policyEnvironmentId: DeploymentIdentifierV1Schema,
      policyRevision: DeploymentRevisionV1Schema })),
    /** Home-signed receipt operand for Observe continuation. */
    deploymentObservationReceiptId: z.optional(DeploymentIdentifierV1Schema),
    deploymentStopReceipt: z.optional(DeploymentStopReceiptV1Schema),
    presetPreparationAdmission: z.optional(z.union([ManagedMachinePresetPrepareInputV1Schema, ManagedMachinePresetRevisionInputV1Schema])),
    deploymentPreparationAdmission: z.optional(DeploymentPreparationAdmissionV1Schema),
    /** Home decides child dispatch once at mint; only the signed binding carries this authority. */
    deploymentChildRoot: z.optional(z.literal(true)),
    /** The reviewed children this root was approved with, chosen once by Home at mint. */
    deploymentReviewedChildPlan: z.optional(z.array(DeploymentReviewedChildPlanEntryV1Schema).check(z.minLength(1))),
    deploymentCandidatePublication: z.optional(DeploymentCandidatePublicationV1Schema),
    /** Home-derived preparation operands; a controller cannot select another readable owner. */
    deploymentLinkAdmission: z.optional(z.strictObject({ environmentId: DeploymentIdentifierV1Schema, owner: ProjectSourceOwnerV1Schema,
      /** The request's replacement operand; the Link write must carry exactly this. */
      replacement: z.optional(DeploymentLinkReplacementV1Schema) })),
    deploymentNativeAdmission: z.optional(DeploymentNativeAdmissionV1Schema),
    registryAppUpdateAdmission: z.optional(RegistryAppUpdateAdmissionV1Schema),
    projectSessionDefaultsAdmission: z.optional(ProjectSessionDefaultsAdmissionV1Schema),
    projectSourceCheckoutId: z.optional(ProjectAccountWorkspaceRefKeyV1Schema.shape.id),
    /** Home admitted this foreign terminal session once; later pages re-present this root. */
    terminalSession: z.optional(z.strictObject({ terminalId: TerminalStreamReadRequestSchema.shape.terminalId })),
  });
export const ExternalActionExecutionAuthorizationBindingV1Schema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(ExternalActionApiTokenServerPrincipalV1Schema, { authority: true }), externalActionExecutionAuthorizationRoutingShapeV1())),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(ExternalActionAccountServerPrincipalV1Schema, { authority: true }), externalActionExecutionAuthorizationRoutingShapeV1())),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(ExternalActionTerminalServerPrincipalV1Schema, { authority: true }), externalActionExecutionAuthorizationRoutingShapeV1())),
]).check(z.superRefine((value, context) => {
  if (value.requesterOperationRead && (!('authentication' in value)
    || !isRequesterOperationActionIdV1(value.actionId) || value.target.kind !== 'machine'
    || value.target.machineId !== value.machineId || value.target.project || value.admittedMachineRole
    || value.managedAdmission || value.environmentId
    || value.sessionActionOrigin || value.sessionActionSource || value.workflowActionOrigin || value.managedContinuation
    || value.handoffAdmission)) {
    context.addIssue({ code: 'custom', path: ['requesterOperationRead'], message: 'Requester custody binds only Account operation Get, List, or Cancel on one Machine' });
  }
  if (value.terminalSession && (!isMachineTerminalSessionReadActionIdV1(value.actionId)
    || !('authentication' in value) || value.authentication.kind !== 'account'
    || value.accountId === value.custodianAccountId || value.admittedMachineRole === undefined
    || value.target.kind !== 'machine' || value.target.machineId !== value.machineId
    || value.requesterOperationRead || value.sessionActionOrigin || value.workflowActionOrigin
    || value.handoffAdmission || value.managedContinuation || value.managedAdmission)) {
    context.addIssue({ code: 'custom', path: ['terminalSession'], message: 'A terminal session root binds one foreign Account read on its admitted Machine' });
  }
  const publication = value.deploymentCandidatePublication;
  if (publication?.reviewed && (!isDeploymentMembershipActionIdV1(value.actionId)
    || publication.reviewed.contentArtifactId !== publication.contentArtifactId
    || (publication.reviewed.destinationContent !== undefined) !== isDeploymentPromoteActionIdV1(value.actionId))) {
    context.addIssue({ code: 'custom', path: ['deploymentCandidatePublication'], message: 'Reviewed custody binds only the exact receipt candidate.' });
  }
  const projectDefaults = value.projectSessionDefaultsAdmission;
  if (projectDefaults ? (value.actionId !== PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1
    && value.actionId !== SESSION_SPAWN_NEW_ACTION_ID_V1 && value.actionId !== BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1)
    || value.actionId === PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1 && !ProjectSessionDefaultsGetInputV1Schema.safeParse(projectDefaults).success
    || [projectDefaults.projectRef, projectDefaults.sourceRef].some(ref => ref && ref.serverId !== value.serverIdentityId)
    : value.actionId === PROJECT_SESSION_DEFAULTS_GET_ACTION_ID_V1) {
    context.addIssue({ code: 'custom', path: ['projectSessionDefaultsAdmission'], message: 'Project defaults bind their exact selected Home operands.' });
  }
  if (value.projectSourceCheckoutId !== undefined && value.actionId !== PROJECT_SOURCE_CREATE_ACTION_ID_V1) {
    context.addIssue({ code: 'custom', path: ['projectSourceCheckoutId'], message: 'Only Source creation can bind a checkout.' });
  }
  if (value.workspaceSyncAdmission && (!isProjectWorkspaceSyncOpenActionV1(value.actionId) && !isProjectWorkspaceSyncPreparationActionV1(value.actionId)
    || value.workspaceSyncAdmission.source.actorAccountId !== value.accountId)) {
    context.addIssue({ code: 'custom', path: ['workspaceSyncAdmission'], message: 'Sync source facts belong to their admitted requester.' });
  }
  const native = value.deploymentNativeAdmission;
  if (native && 'kind' in native && native.kind === 'promote'
    ? !isDeploymentPromoteActionIdV1(value.actionId) || native.environmentId !== value.environmentId
      || value.target.kind !== 'machine' || value.target.machineId !== value.machineId
    : value.actionId === DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1 || isDeploymentTelemetryNativeAdmissionV1(native)
    ? !isDeploymentTelemetryNativeAdmissionV1(native) || value.actionId !== native.actionId
      || native.environmentId !== value.environmentId || value.target.kind !== 'machine' || value.target.machineId !== value.machineId
    : value.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1 || isDeploymentBackupConfigureNativeAdmissionV1(native)
    ? !isDeploymentBackupConfigureNativeAdmissionV1(native) || value.actionId !== native.actionId
      || native.environmentId !== value.environmentId || value.target.kind !== 'machine' || value.target.machineId !== value.machineId
    : isDeploymentEnvironmentUpdateNativeAdmissionV1(native)
    ? value.actionId !== 'deployments.environments.update' || native.environmentId !== value.environmentId
      || value.target.kind !== 'machine' || value.target.machineId !== value.machineId
    : isDeploymentDomainChildActionIdV1(value.actionId) || value.actionId === 'deployments.restart' || value.actionId === 'deployments.backups.restore' || isDeploymentBackupActionIdV1(value.actionId)
    ? !native || !('kind' in native) || native.actionId !== value.actionId || native.environmentId !== value.environmentId
      || (value.actionId === 'deployments.restart' || value.actionId === 'deployments.backups.restore' || isDeploymentBackupActionIdV1(value.actionId)) && (native.kind !== (value.actionId === 'deployments.restart' ? 'restart' : value.actionId === 'deployments.backups.restore' ? 'restore' : 'backup') || native.machineId !== value.machineId
        || native.installationId !== value.installationId || value.target.kind !== 'machine' || value.target.machineId !== native.machineId)
    : native !== undefined) {
    context.addIssue({ code: 'custom', path: ['deploymentNativeAdmission'], message: 'Domain execution binds its exact original public input.' });
  }
  if (value.nativeCredentialSpawnChild && (value.actionId !== 'machines.managed.credentials.install'
    || value.managedAdmission?.actionId !== 'machines.managed.credentials.install' || value.managedAdmission.input.operation === 'release'
    || value.managedAdmission.input.executionRunId || value.sessionActionOrigin || value.workflowActionOrigin)) {
    context.addIssue({ code: 'custom', path: ['nativeCredentialSpawnChild'], message: 'Native spawn admission binds only its exact install effect' });
  }
  if (value.managedAdmission && (value.managedAdmission.actionId !== value.actionId
    || value.managedAdmission.input.homeId !== value.serverIdentityId
    || value.target.kind !== 'machine' || value.target.machineId !== value.machineId)) {
    context.addIssue({ code: 'custom', path: ['managedAdmission'], message: 'Managed recovery binds its exact Home, Action and controller.' });
  }
  if (value.managedAccountExecutor && (!value.managedAdmission
    || value.managedAdmission.actionId !== 'machines.managed.power.set' && value.managedAdmission.actionId !== 'machines.managed.delete')) {
    context.addIssue({ code: 'custom', path: ['managedAccountExecutor'], message: 'Account executor binds an exact managed control admission.' });
  }
  if (value.managedAdmission && 'authority' in value.managedAdmission
    && value.managedAdmission.authority === 'creator_recovery' && value.accountId === value.custodianAccountId) {
    context.addIssue({ code: 'custom', path: ['managedAdmission', 'authority'], message: 'Creator recovery binds only its exact foreign Cancel/Delete admission.' });
  }
  if (value.registryAppUpdateAdmission && (value.actionId !== 'registries.updates.check'
    || value.target.kind !== 'machine' || value.target.machineId !== value.machineId)) {
    context.addIssue({ code: 'custom', path: ['registryAppUpdateAdmission'], message: 'Registry app demand binds only its exact read receiver.' });
  }
  if (value.deploymentPreparationAdmission
    ? value.deploymentPreparationAdmission.operation !== deploymentPreparationOperationForActionV1(value.actionId)
    : isDeploymentPreparationActionIdV1(value.actionId)) {
    context.addIssue({ code: 'custom', path: ['deploymentPreparationAdmission'], message: 'Deployment preparation binds only its reviewed operation.' });
  }
  const preparation = value.deploymentPreparationAdmission;
  if (value.deploymentLinkAdmission && (value.actionId !== 'deployments.targets.link' || value.target.kind !== 'machine')) {
    context.addIssue({ code: 'custom', path: ['deploymentLinkAdmission'], message: 'Link preparation binds its admitted Environment and owner.' });
  }
  if (value.deploymentCandidatePublication && (deploymentOperationForRootActionV1(value.actionId) === undefined
    || value.target.kind !== 'machine' || value.target.machineId !== value.machineId
    || (value.deploymentCandidatePublication.environmentContentArtifactId !== undefined) !== (value.actionId === 'deployments.promote'))) {
    context.addIssue({ code: 'custom', path: ['deploymentCandidatePublication'], message: 'Candidate publication binds its exact native root.' });
  }
  if (preparation?.operation === 'catalog' && (value.target.kind !== 'machine' || value.target.machineId !== value.machineId
    || preparation.machineId !== value.machineId || preparation.installationId !== value.installationId)) {
    context.addIssue({ code: 'custom', path: ['deploymentPreparationAdmission'], message: 'Catalog preparation binds the exact executing installation.' });
  }
  if (preparation?.operation === 'template' && (value.target.kind !== 'machine' || value.target.machineId !== value.machineId
    || preparation.environment.kind === 'create' && preparation.environment.controllerMachineId !== value.machineId
    || preparation.machineId === value.machineId && preparation.target.installationId !== value.installationId)) {
    context.addIssue({ code: 'custom', path: ['deploymentPreparationAdmission'], message: 'Template admission binds its controller and selected runtime installation.' });
  }
  const qualifiedManagedQueryRead = value.actionId === ACTION_INVOKE_ACTION_ID_V1
    && value.deploymentReadAdmission?.actionId === ACTION_INVOKE_ACTION_ID_V1;
  if (isDeploymentReadAdmissionActionIdV1(value.actionId) ? !value.deploymentReadAdmission
    || value.deploymentReadAdmission.actionId !== value.actionId || value.target.kind !== 'machine'
    || value.target.machineId !== value.machineId
    // A receipt-shaped platform log read names no Machine; an explicit selector must be the executing receiver.
    || ('machineId' in value.deploymentReadAdmission && value.deploymentReadAdmission.machineId !== value.machineId)
    || ('installationId' in value.deploymentReadAdmission
      && value.deploymentReadAdmission.installationId !== value.installationId)
    : qualifiedManagedQueryRead ? value.target.kind !== 'machine' || value.target.machineId !== value.machineId
      : value.deploymentReadAdmission !== undefined) {
    context.addIssue({ code: 'custom', path: ['deploymentReadAdmission'], message: 'Deployment reads bind their exact authenticated receiver and operation.' });
  }
  const telemetry = value.deploymentReadAdmission && 'telemetryCollector' in value.deploymentReadAdmission
    ? value.deploymentReadAdmission.telemetryCollector : undefined;
  const usageCollector = value.usageCollectorParent !== undefined && !('authentication' in value)
    && hasApiTokenUsageAppCallsScopeV1(value.grant) && value.deploymentReadAdmission?.actionId === ACTION_INVOKE_ACTION_ID_V1
    && 'telemetryCollector' in value.deploymentReadAdmission
    && formatQualifiedPluginActionId(value.deploymentReadAdmission.action) === TELEMETRY_COSTS_READ_ACTION_ID_V1;
  if (value.usageCollectorParent && (!value.telemetryCollectorCodec || !usageCollector)) {
    context.addIssue({ code: 'custom', path: ['usageCollectorParent'], message: 'Usage child lineage binds only its admitted collector read.' });
  }
  if (telemetry && telemetry.serverId !== value.serverIdentityId
    || value.telemetryCollectorCodec && (!telemetry || value.sessionActionOrigin || value.sessionActionSource || value.workflowActionOrigin
      || value.target.kind !== 'machine' || value.target.project
      || !usageCollector && (!('authentication' in value) || value.authentication.kind !== 'account'))
    || value.deploymentTelemetryRead && (!telemetry || !sameStrictJsonValue(
      value.deploymentTelemetryRead.map(environment => environment.environmentId), telemetry.environmentIds))) {
    context.addIssue({ code: 'custom', path: ['deploymentTelemetryRead'], message: 'Telemetry facts belong to their exact Home and Environment operands.' });
  }
  if (value.deploymentDatabaseAccess !== undefined && (value.actionId !== ACTION_INVOKE_ACTION_ID_V1
    || !value.deploymentReadAdmission || !('databaseTarget' in value.deploymentReadAdmission))) {
    context.addIssue({ code: 'custom', path: ['deploymentDatabaseAccess'], message: 'A database access decision belongs to an exact target.' });
  }
  if (value.approvalDecisionAdmission && value.actionId !== 'approval.request.decide') {
    context.addIssue({ code: 'custom', path: ['approvalDecisionAdmission'], message: 'Approval admission binds only its decision Action' });
  }
  if (value.deploymentStopReceipt !== undefined && (value.actionId !== DEPLOYMENT_CANCEL_ACTION_ID_V1
    || value.environmentId === undefined || value.target.kind !== 'machine' || value.target.machineId !== value.machineId)) {
    context.addIssue({ code: 'custom', path: ['deploymentStopReceipt'], message: 'Stop binds the exact Environment receipt and revision.' });
  }
  if (value.deploymentObservationReceiptId !== undefined && (value.actionId !== DEPLOYMENT_RECEIPT_OBSERVE_ACTION_ID_V1
    || value.environmentId === undefined || value.target.kind !== 'machine' || value.target.machineId !== value.machineId)) {
    context.addIssue({ code: 'custom', path: ['deploymentObservationReceiptId'], message: 'Observe binds its Environment and exact receipt on the admitted controller.' });
  }
  if (value.automationId !== undefined && value.actionId !== 'workflow.trigger.run_now') {
    context.addIssue({ code: 'custom', path: ['automationId'], message: 'Automation admission binds only run-now' });
  }
  if (value.environmentId !== undefined && ((!API_TOKEN_ENVIRONMENT_ACTION_IDS_V1.some((id) => id === value.actionId)
    && projectExternalActionDeploymentMetadataEnvironmentIdV1(value.actionId, { environmentId: value.environmentId }) === undefined
    && value.actionId !== DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1
    && value.actionId !== DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1
    && !('authentication' in value && (value.deploymentChildRoot === true || value.actionId === 'deployments.teardown'
      || value.actionId === 'deployments.restart' || value.actionId === 'deployments.backups.restore' || isDeploymentBackupActionIdV1(value.actionId) || value.actionId === 'deployments.receipts.observe')))
    || value.target.kind !== 'machine')) {
    context.addIssue({ code: 'custom', path: ['environmentId'], message: 'Environment admission binds only Environment-scoped Actions on their admitted host' });
  }
  if (value.idempotencyKey !== undefined && value.actionId !== 'workflow.trigger.run_now') {
    context.addIssue({ code: 'custom', path: ['idempotencyKey'], message: 'Manual retry identity binds only run-now' });
  }
  if (value.pendingResetStartAdmission && (value.actionId !== 'session.pending.resetStart.set'
    || value.target.kind === 'session' && projectExternalActionPendingResetStartSessionDigestV1(value.target.sessionId) !== value.pendingResetStartAdmission.sessionDigest)) {
    context.addIssue({ code: 'custom', path: ['pendingResetStartAdmission'], message: 'Reset admission binds only its exact Session set input' });
  }
  if (value.workflowActionOrigin && (value.sessionActionOrigin || value.managedContinuation || value.handoffAdmission
    || value.workflowActionOrigin.requestId !== value.requestId
    || value.target.kind === 'session' && (!value.workflowActionOrigin.sessionAuthority
      || !value.actionId.startsWith('session.') || !isRoleActionIdV1(value.actionId)))) {
    context.addIssue({ code: 'custom', path: ['workflowActionOrigin'], message: 'FIN origin binds only its original invocation' });
  }
  if ((value.sessionActionOrigin === undefined) !== (value.sessionActionSource === undefined)) {
    context.addIssue({ code: 'custom', path: ['sessionActionSource'], message: 'Session origin requires its source installation' });
  }
  if (value.sessionActionOrigin && value.sessionActionOrigin.requestId !== value.requestId) {
    context.addIssue({ code: 'custom', path: ['sessionActionOrigin', 'requestId'], message: 'Session origin must match the signed invocation' });
  }
  if (value.handoffContinuation && (!value.handoffAdmission || value.managedContinuation
    || value.handoffPreflight
    || value.handoffContinuation.rootRequestId !== value.requestId)) {
    context.addIssue({ code: 'custom', path: ['handoffContinuation'], message: 'Handoff continuation retains its exact original root' });
  }
  if (value.handoffPreflight && (!value.handoffAdmission || value.managedContinuation || value.handoffContinuation
    || value.actionId !== 'session.handoff' || value.handoffPreflight.rootRequestId !== value.requestId
    || value.target.kind !== 'machine' || value.target.machineId !== value.machineId
    || !(value.machineId === value.handoffAdmission.sourceMachineId
        && value.installationId === value.handoffAdmission.sourceInstallationId
      || value.machineId === value.handoffAdmission.targetMachineId
        && value.installationId === value.handoffAdmission.targetInstallationId))) {
    context.addIssue({ code: 'custom', path: ['handoffPreflight'], message: 'Handoff preflight retains its exact original root and admitted peer' });
  }
})));
export type ExternalActionExecutionAuthorizationBindingV1 = z.infer<typeof ExternalActionExecutionAuthorizationBindingV1Schema>
  & Readonly<{ deploymentNativeAdmission?: import('../deployments/deploymentCandidatePublicationV1.js').DeploymentNativeAdmissionV1 }>;

/** Public defaults preparation follows the original Project selection or a signed spawn's Home projection. */
export function isExternalActionProjectSessionDefaultsReadAdmittedV1(
  binding: ExternalActionExecutionAuthorizationBindingV1, effectActionId: string,
): boolean {
  const selection = binding.projectSessionDefaultsAdmission;
  return ((selection?.projectRef !== undefined || selection?.sourceRef !== undefined)
    && isProjectSessionDefaultsPreparationReadActionIdV1(effectActionId))
    || ('authentication' in binding && isSessionSpawnHomeDefaultsReadEffectV1(binding.actionId, effectActionId));
}

/** Existing finite roots and declared runtime work share one original-root wake bridge. */
export function isExternalActionManagedWakeRootV1(root: Pick<ExternalActionExecutionAuthorizationBindingV1,
  'actionId' | 'machineId' | 'target' | 'machineRuntimeDemand'>): boolean {
  // Managed Exec's carrier is the controller. Its native guest wake is prepared there.
  return root.actionId !== MANAGED_EXEC_ACTION_ID_V1
    && (root.machineRuntimeDemand === 'required' || Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, root.actionId))
    && (root.target.kind === 'machine' ? root.target.machineId === root.machineId
      : root.machineRuntimeDemand === 'required' && root.target.kind === 'session');
}

/** Authorization material: usable only together with the selected Machine's request signature. */
export const ExternalActionExecutionAuthorizationV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  token: z.string().check(z.minLength(1)),
  binding: ExternalActionExecutionAuthorizationBindingV1Schema,
  /** Installed SCM owner resolves its protected saved result before any child input. */
  scmRefineSession: z.optional(z.strictObject({
    sessionId: ExternalActionTargetIdV1Schema,
    signature: z.string().check(z.regex(/^[A-Za-z0-9_-]{86}$/u)),
  })),
  /** Private installed-key custody on this same carrier; never principal authority. */
  requesterAccountContext: z.optional(SessionRequesterInstallationSealedBootstrapV1Schema),
  /** Public recipient key for the invocation codec. Never a Machine content key. */
  requesterOperationReadInstallationPublicKey: z.optional(MachineInstallationPublicKeySchema),
  telemetryReadInstallationPublicKey: z.optional(MachineInstallationPublicKeySchema),
  /** Home-proved finite placement hint and private custody; neither retargets the root. */
  managedFiniteWake: z.optional(z.strictObject({
    target: ManagedWakeTargetV1Schema,
    installationPublicKey: MachineInstallationPublicKeySchema,
    /** Home selects an additional person receiving credentials beyond the guest recipient. */
    requesterCredentialDisclosure: z.optional(MachineCustodianV1Schema),
    requesterAccountContext: z.optional(SessionRequesterInstallationSealedBootstrapV1Schema),
  })),
}).check(z.superRefine((value, context) => {
  if (value.requesterOperationReadInstallationPublicKey && !value.binding.requesterOperationRead) {
    context.addIssue({ code: 'custom', path: ['requesterOperationReadInstallationPublicKey'], message: 'Expected the requester operation carrier' });
  }
  if (value.telemetryReadInstallationPublicKey && (!value.binding.telemetryCollectorCodec || !value.binding.deploymentTelemetryRead)) {
    context.addIssue({ code: 'custom', path: ['telemetryReadInstallationPublicKey'], message: 'Expected the admitted telemetry collector carrier' });
  }
  const wake = value.managedFiniteWake;
  if (!wake) return;
  const root = value.binding;
  if (!isExternalActionManagedWakeRootV1(root)
    || wake.target.origin.kind !== 'finite-command' || wake.target.origin.actionRequestId !== root.requestId
    || wake.target.homeId !== root.serverIdentityId || wake.target.enrolledMachineId !== root.machineId
    || wake.requesterAccountContext && wake.requesterAccountContext.installationId !== wake.target.controller?.installationId) {
    context.addIssue({ code: 'custom', path: ['managedFiniteWake'], message: 'Finite custody requires its exact original guest root and installed controller' });
  }
})));
/**
 * Admitted host-local Account ports, attached to the existing authorization
 * carrier only after requester custody has been proved. They are not wire
 * fields: the strict authorization schema never accepts them from a caller.
 */
export type ExternalActionRequesterAccountProjectionV1 = Readonly<{
  accountId: string;
  serverId: string;
  accountEncryptionMode: 'plain' | 'e2ee';
  projectAccountRowCipher: ProjectAccountRowCipherV1;
  projectTrustRowCipher?: Readonly<{
    open(project: QualifiedProjectTrustProjectV1, content: ProjectTrustContentV1): ProjectTrustValueV1;
    seal(value: ProjectTrustValueV1): ProjectTrustContentV1;
  }>;
  authoringMemoryRowCipher?: Readonly<{
    open(key: string, content: AuthoringMemoryContentV1): AuthoringMemoryValueV1;
    seal(key: string, value: AuthoringMemoryValueV1): AuthoringMemoryContentV1;
  }>;
  /** Private caller owner seals genuine custody for the exact installed destination. */
  sealRequesterAccountContext?(input: Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1;
    purpose: ExternalActionRequesterAccountContextPurposeV1;
    installationPublicKey: Uint8Array;
  }>): Promise<ExternalActionExecutionAuthorizationV1 | null>;
  resolveMachineContentEncryptionContext?(row: MachinePublishedRowV1): Readonly<
    { encryptionMode: 'plain' } | { encryptionMode: 'e2ee'; encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }
  >;
  /** Host-private owner read; never exposes a Session envelope or Account credential. */
  readOwnSessionWorkspace?(input: Readonly<{
    sessionId: string; machineId: string; currentMachineHost: string; currentMachineHomeDir: string;
    candidatePath?: string; signal?: AbortSignal;
  }>): Promise<Readonly<{ rootPath: string; requestedPath?: string; requiresManagedTarget?: true }> | null>;
  isCurrent(): Promise<boolean>;
  readArtifact(ref: PromptArtifactRefV1 & Readonly<{ serverId: string }>,
    options?: ProjectSourceArtifactReadOptionsV1 & Readonly<{ authorization?: ExternalActionExecutionAuthorizationV1 }>): Promise<Readonly<{
      artifactId: string; header: unknown; promptLibraryArtifact?: PromptLibraryStoredArtifact;
      /** Only documents within the root's admitted signed purpose; never an unrelated root's full-content port. */
      document?: Readonly<{ artifactId: string; header: Readonly<Record<string, unknown>>;
        body: ArtifactBodyV1 | null; revision: ArtifactRevisionV1 }>;
    }> | null>;
}>;
/** Host-local HTTP authority; no bearer or private Account material is exposed. */
/** Value-free child facts issued by the admitted local host, not a new credential. */
export const ReviewedActionChildHttpProofV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: ExternalActionActionIdV1Schema,
  role: z.string().check(z.minLength(1)),
  inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  /** Selected by the host's existing private child issuer, never ambient Account scope. */
  environmentId: z.optional(z.string().check(z.minLength(1))),
  deploymentNativeAdmission: z.optional(z.union([DeploymentDomainNativeAdmissionV1Schema, DeploymentBackupConfigureNativeAdmissionV1Schema, DeploymentTelemetryNativeAdmissionV1Schema])),
}));
export type ReviewedActionChildHttpProofV1 = Readonly<z.infer<typeof ReviewedActionChildHttpProofV1Schema>>;

export type ExternalActionRequesterHttpProjectionV1 = Readonly<{
  accountId: string;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  accountEncryptionMode?: 'plain' | 'e2ee';
  isCurrent(): Promise<boolean>;
  createRequestHeaders(input: Readonly<{
    effectActionId: string;
    method: string;
    path: string;
    body?: unknown;
    signal?: AbortSignal;
    reviewedChild?: ReviewedActionChildHttpProofV1;
    nativeIncumbentSource?: z.infer<typeof DeploymentChildExecutionProofV1Schema>['nativeIncumbentSource'];
  }>): Promise<Readonly<Record<string, string>> | null>;
}>;
export type ExternalActionExecutionAuthorizationV1 = z.infer<typeof ExternalActionExecutionAuthorizationV1Schema>
  & Readonly<{
    requesterAccountProjection?: ExternalActionRequesterAccountProjectionV1;
    /** Existing factory bound to admitted private custody; never a wire executor or registry. */
    requesterAccountExecutor?: Pick<ReturnType<typeof createActionExecutor>, 'execute'>
      & Partial<Pick<ReturnType<typeof createActionExecutor>, 'replayApprovedApprovalRequest'>>;
    requesterHttpProjection?: ExternalActionRequesterHttpProjectionV1;
  }>;

/** Read only an already verified Home binding, never requester Action input. */
export function readExternalActionManagedRetryGuestCliV1(binding: ExternalActionExecutionAuthorizationBindingV1 | undefined): GuestCliIdentityV1 | undefined {
  const admission = binding?.managedAdmission;
  return admission?.actionId === MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 ? admission.input.guestCli : undefined;
}

/** Optional authenticated auxiliary arm of the incumbent socket RPC request. */
export const ExternalActionMachineRpcSourceExecutionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  reviewedChild: z.optional(ReviewedActionChildHttpProofV1Schema),
  authorization: ExternalActionExecutionAuthorizationV1Schema,
  effectActionId: ExternalActionActionIdV1Schema,
  target: ExternalActionTargetV1Schema,
  installationId: z.string().check(z.trim(), z.minLength(1)),
  machineSignature: z.string().check(z.regex(/^[A-Za-z0-9_-]{86}$/u)),
  deploymentChildRouting: z.optional(DeploymentChildRoutingV1Schema),
  managedAdmission: z.optional(ExternalActionManagedCredentialInstallAdmissionV1Schema),
}));
export const ExternalActionMachineRpcExecutionV1Schema = lazyZodSchema(() => z.strictObject({
  ...ExternalActionMachineRpcSourceExecutionV1Schema.shape,
  deploymentChildExecution: z.optional(DeploymentChildExecutionProofV1Schema),
}));
export type ExternalActionMachineRpcExecutionV1 = z.infer<typeof ExternalActionMachineRpcExecutionV1Schema>;

/** The existing installed RPC child packet, spent only by the native install issuer. */
export const ExternalActionNativeCredentialSpawnChildV1Schema = lazyZodSchema(() => z.strictObject({
  externalActionExecution: ExternalActionMachineRpcExecutionV1Schema,
  method: z.string().check(z.minLength(1)),
  requestId: ExternalActionRequestIdV1Schema,
  params: z.optional(StrictJsonValueSchema),
  originalActionEnvelope: ExternalActionRequestEnvelopeSchema,
}));

export { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HTTP_PATH_TEMPLATE_V1,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1 } from './externalActionHttpTransportV1.js';
export function bindExternalActionExecutionAuthorizationHttpPathV1(actionId: string): string {
  return `/v1/actions/${encodeURIComponent(ExternalActionActionIdV1Schema.parse(actionId))}/execution-authorization`;
}
export function bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId: string): string {
  return `${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}/verify`;
}
type ExternalActionExecutionAuthorizationRequestShapeV1 = {
  v: z.ZodMiniLiteral<1>;
  machineId: typeof ExternalActionTargetIdV1Schema;
  envelope: typeof ExternalActionRequestEnvelopeSchema;
  executionAuthorization: z.ZodMiniOptional<typeof ExternalActionExecutionAuthorizationV1Schema>;
  deploymentReview: z.ZodMiniOptional<typeof DeploymentReviewReentryV1Schema>;
  nativeCredentialSpawnChild: z.ZodMiniOptional<typeof ExternalActionNativeCredentialSpawnChildV1Schema>;
  sessionActionOrigin: z.ZodMiniOptional<typeof SessionActionRpcOriginV1Schema>;
  sessionActionSource: z.ZodMiniOptional<typeof ExternalActionSessionSourceV1Schema>;
  workflowActionOrigin: z.ZodMiniOptional<typeof ExternalActionWorkflowOriginV1Schema>;
  installationProof: z.ZodMiniOptional<typeof MachineInstallationProofV1Schema>;
  managedContinuation: z.ZodMiniOptional<z.ZodMiniObject<Pick<typeof ExternalActionManagedContinuationV1Schema.shape,
    'managedId' | 'creationRequestId' | 'expectedIntentRevision'>, z.core.$strict>>;
  handoffContinuation: z.ZodMiniOptional<z.ZodMiniObject<{
    authorization: typeof ExternalActionExecutionAuthorizationV1Schema;
    handoffId: typeof ExternalActionTargetIdV1Schema;
  }, z.core.$strict>>;
  handoffPreflight: z.ZodMiniOptional<z.ZodMiniObject<{
    authorization: typeof ExternalActionExecutionAuthorizationV1Schema;
  }, z.core.$strict>>;
};

const DeploymentReviewReentryV1Schema = lazyZodSchema(() => z.strictObject({
  originalAuthorizationToken: ExternalActionExecutionAuthorizationV1Schema.shape.token,
  candidate: DeploymentReviewedCandidateV1Schema,
}));

function externalActionExecutionAuthorizationRequestSchemaV1(actionId?: 'session.board.item.upsert'): z.ZodMiniObject<ExternalActionExecutionAuthorizationRequestShapeV1, z.core.$strict> {
  return z.strictObject({
  v: z.literal(1), machineId: ExternalActionTargetIdV1Schema, envelope: ExternalActionRequestEnvelopeSchema,
  executionAuthorization: z.optional(ExternalActionExecutionAuthorizationV1Schema),
  deploymentReview: z.optional(DeploymentReviewReentryV1Schema),
  nativeCredentialSpawnChild: z.optional(ExternalActionNativeCredentialSpawnChildV1Schema),
  sessionActionOrigin: z.optional(SessionActionRpcOriginV1Schema),
  sessionActionSource: z.optional(ExternalActionSessionSourceV1Schema),
  workflowActionOrigin: z.optional(ExternalActionWorkflowOriginV1Schema),
  installationProof: z.optional(MachineInstallationProofV1Schema),
  managedContinuation: lazyZodSchema(() => z.optional(z.pick(ExternalActionManagedContinuationV1Schema, {
    managedId: true, creationRequestId: true, expectedIntentRevision: true,
  }))),
  handoffContinuation: z.optional(z.strictObject({
    authorization: ExternalActionExecutionAuthorizationV1Schema,
    handoffId: ExternalActionTargetIdV1Schema,
  })),
  handoffPreflight: z.optional(z.strictObject({ authorization: ExternalActionExecutionAuthorizationV1Schema })),
}).check(z.superRefine((value, context) => {
  if (value.executionAuthorization && (value.sessionActionOrigin || value.sessionActionSource
    || value.workflowActionOrigin && !value.installationProof || value.installationProof && !value.workflowActionOrigin
    || value.managedContinuation || value.handoffContinuation || value.handoffPreflight
    || value.nativeCredentialSpawnChild || value.deploymentReview)) {
    context.addIssue({ code: 'custom', path: ['executionAuthorization'], message: 'An admitted relay cannot author fresh origin or continuation claims' });
  }
  if (value.nativeCredentialSpawnChild && (value.sessionActionOrigin || value.sessionActionSource || value.workflowActionOrigin
    || value.installationProof || value.managedContinuation || value.handoffContinuation || value.handoffPreflight)) {
    context.addIssue({ code: 'custom', path: ['nativeCredentialSpawnChild'], message: 'Native child retains its one installed spawn origin' });
  }
  if ((value.sessionActionOrigin === undefined && value.workflowActionOrigin === undefined) !== (value.installationProof === undefined)) {
    context.addIssue({ code: 'custom', path: ['sessionActionOrigin'], message: 'Session origin requires its installed source proof' });
  }
  if (value.workflowActionOrigin && (value.sessionActionOrigin || value.managedContinuation || value.handoffContinuation || value.handoffPreflight
    || value.workflowActionOrigin.requestId !== value.envelope.requestId
    // The installed Run publisher proves origin; Home alone admits a distinct
    // receiving Machine from the server-stored exact approved child.
    || !(value.envelope.target?.kind === 'machine'
      || value.envelope.target?.kind === 'session' && value.workflowActionOrigin.sessionAuthority))) {
    context.addIssue({ code: 'custom', path: ['workflowActionOrigin'], message: 'FIN origin requires its exact installed executor invocation' });
  }
  const target = value.envelope.target;
  const bindsOriginalTarget = actionId === 'session.board.item.upsert'
    ? target?.kind === 'session' && target.sessionId === value.sessionActionOrigin?.caller.sessionId
      && value.sessionActionSource?.machineId === value.machineId
    : target?.kind === 'machine' && target.machineId === value.machineId;
  if (value.sessionActionOrigin && (value.managedContinuation
    || value.sessionActionOrigin.requestId !== value.envelope.requestId || !bindsOriginalTarget)) {
    context.addIssue({ code: 'custom', path: ['sessionActionOrigin'], message: 'Initial Session origin must bind the exact original Action target' });
  }
  if ((value.sessionActionOrigin === undefined) !== (value.sessionActionSource === undefined)) {
    context.addIssue({ code: 'custom', path: ['sessionActionSource'], message: 'Session origin requires its source installation' });
  }
  if (value.sessionActionOrigin && value.sessionActionOrigin.requestId !== value.envelope.requestId) {
    context.addIssue({ code: 'custom', path: ['sessionActionOrigin', 'requestId'], message: 'Session origin must name the invocation request' });
  }
  // The admitted child Action selects its required public facts at the server
  // continuation owner: Session start requires Session facts; machine setup
  // carries only its exact target and keeps the executable preset input sealed.
  if (value.handoffContinuation) {
    const root = value.handoffContinuation.authorization.binding;
    const handoff = value.envelope.handoffAdmission;
    if (root.actionId !== 'session.handoff' || !root.handoffAdmission || root.handoffContinuation || root.handoffPreflight
      || value.handoffPreflight
      || value.managedContinuation || value.envelope.requestId !== root.requestId
      || value.sessionActionOrigin || value.sessionActionSource || value.installationProof
      || !handoff || handoff.sessionId !== root.handoffAdmission.sessionId
      || handoff.sourceMachineId !== root.handoffAdmission.sourceMachineId
      || handoff.targetMachineId !== root.handoffAdmission.targetMachineId
      || value.envelope.target?.kind !== 'machine' || value.envelope.target.machineId !== value.machineId
      || ![root.handoffAdmission.sourceMachineId, root.handoffAdmission.targetMachineId].includes(value.machineId)) {
      context.addIssue({ code: 'custom', path: ['handoffContinuation'], message: 'Handoff continuation requires its exact Home-issued root and destination' });
    }
  }
  if (value.handoffPreflight) {
    const root = value.handoffPreflight.authorization.binding;
    const handoff = value.envelope.handoffAdmission;
    if (root.actionId !== 'session.handoff' || !root.handoffAdmission || root.handoffContinuation || root.handoffPreflight
      || value.managedContinuation || value.handoffContinuation || value.envelope.requestId !== root.requestId
      || value.sessionActionOrigin || value.sessionActionSource || value.installationProof
      || root.machineId !== root.handoffAdmission.sourceMachineId || root.installationId !== root.handoffAdmission.sourceInstallationId
      || !handoff || handoff.sessionId !== root.handoffAdmission.sessionId
      || handoff.sourceMachineId !== root.handoffAdmission.sourceMachineId || handoff.targetMachineId !== root.handoffAdmission.targetMachineId
      || value.envelope.target?.kind !== 'machine' || value.envelope.target.machineId !== value.machineId
      || ![handoff.sourceMachineId, handoff.targetMachineId].includes(value.machineId)) {
      context.addIssue({ code: 'custom', path: ['handoffPreflight'], message: 'Handoff preflight requires its exact Home-issued root and destination' });
    }
  }
  }));
}
export const ExternalActionExecutionAuthorizationRequestV1Schema: ReturnType<typeof externalActionExecutionAuthorizationRequestSchemaV1> = lazyZodSchema(() => externalActionExecutionAuthorizationRequestSchemaV1());
const SessionVisualExecutionAuthorizationRequestV1Schema = lazyZodSchema(() => externalActionExecutionAuthorizationRequestSchemaV1('session.board.item.upsert'));
/** The trusted routed Action selects framing; JSON never claims this exception. */
export function externalActionExecutionAuthorizationRequestSchemaForActionV1(actionId: string): typeof ExternalActionExecutionAuthorizationRequestV1Schema {
  return actionId === 'session.board.item.upsert'
    ? SessionVisualExecutionAuthorizationRequestV1Schema : ExternalActionExecutionAuthorizationRequestV1Schema;
}
export type ExternalActionExecutionAuthorizationRequestV1 = z.infer<typeof ExternalActionExecutionAuthorizationRequestV1Schema>;
export const ExternalActionExecutionAuthorizationVerifyRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  /** Native consumers authenticate the supplied full binding against the token once. */
  binding: z.optional(ExternalActionExecutionAuthorizationBindingV1Schema),
  nativePurpose: z.optional(z.literal('machine_npm_profile_acquisition')),
  admittedMachineRole: z.optional(z.enum(['use', 'manage'])),
  managedFiniteWakeTarget: z.optional(ManagedWakeTargetV1Schema),
  retainedDiscussionSource: z.optional(SessionInputSourceSessionV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.nativePurpose && (value.managedFiniteWakeTarget || value.retainedDiscussionSource)) {
    context.addIssue({ code: 'custom', path: ['nativePurpose'], message: 'Machine profile acquisition is a separate verification purpose' });
  }
  if (value.managedFiniteWakeTarget && value.managedFiniteWakeTarget.origin.kind !== 'finite-command') {
    context.addIssue({ code: 'custom', path: ['managedFiniteWakeTarget'], message: 'Controller custody requires an original finite-command target' });
  }
  if (value.retainedDiscussionSource && (!value.retainedDiscussionSource.sourceInputId
    || !value.retainedDiscussionSource.discussionAddressing || value.managedFiniteWakeTarget)) {
    context.addIssue({ code: 'custom', path: ['retainedDiscussionSource'], message: 'Retained Discussion currentness requires its exact original input and addressed message' });
  }
})));
export const ExternalActionExecutionAuthorizationVerifyResponseV1Schema = lazyZodSchema(() => z.strictObject({ ok: z.literal(true) }));

/** Exact server-held placement facts for the closed daemon dispatch. */
export const ExternalActionDaemonPlacementV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: ExternalActionTargetIdV1Schema,
  target: z.strictObject({
    kind: z.literal('machine'),
    machineId: ExternalActionTargetIdV1Schema,
  }),
}).check(z.superRefine((value, context) => {
  if (value.machineId !== value.target.machineId) {
    context.addIssue({
      code: "custom",
      path: ['target', 'machineId'],
      message: 'placement target must match machineId',
    });
  }
})));
export type ExternalActionDaemonPlacementV1 = z.infer<typeof ExternalActionDaemonPlacementV1Schema>;

/** Closed server-to-daemon Action dispatch framing. */
export const ExternalActionDaemonDispatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
  // The relay proves only closed framing, provenance, and placement. The
  // target daemon is the sole Action-id admission owner.
  actionId: ExternalActionActionIdV1Schema,
  envelope: ExternalActionRequestEnvelopeV1Schema,
  principal: ExternalActionServerPrincipalV1Schema,
  placement: ExternalActionDaemonPlacementV1Schema,
}));
export type ExternalActionDaemonDispatchRequestV1 = z.infer<
  typeof ExternalActionDaemonDispatchRequestV1Schema
>;

export const ExternalActionDaemonDispatchRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalActionDaemonDispatchRequestV1Schema, {
  envelope: ExternalActionRequestEnvelopeSchema,
  executionAuthorization: z.optional(ExternalActionExecutionAuthorizationV1Schema),
  observeSessionBirth: z.optional(z.literal(true)),
})));
export type ExternalActionDaemonDispatchRequest = z.infer<typeof ExternalActionDaemonDispatchRequestSchema>;

const ExternalActionDaemonDispatchInvalidRequestBaseSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalActionDaemonDispatchInvalidRequestV1Schema, {
  errorCode: ExternalActionPreOpenFailureCodeSchema,
  requestId: z.optional(ExternalActionRequestIdV1Schema),
  failureCause: ActionExecuteFailureSchema.shape.failureCause,
})));

const ExternalActionDaemonDispatchInvalidRequestSchema = lazyZodSchema(() => z.union([
  ExternalActionDaemonDispatchInvalidRequestBaseSchema,
  z.strictObject({
    ...ExternalActionDaemonDispatchInvalidRequestBaseSchema.shape,
    errorCode: z.literal('target_not_local'),
    phase: z.optional(ExternalActionTargetRefusalPhaseSchema),
  }),
]));

export type ParsedExternalActionDaemonDispatchResult = Readonly<
  | z.infer<typeof ExternalActionDaemonDispatchInvalidRequestSchema>
  | { kind: 'response'; prepared: PreparedExternalActionResponseEnvelope }
>;

/** Same reserved binary carrier; each decoded body retains its own version ceiling. */
export function createExternalActionDaemonDispatchResponse(prepared: PreparedExternalActionResponseEnvelope): Readonly<{
  kind: 'response'; body: Uint8Array;
}> {
  const body = new TextEncoder().encode(prepared.body);
  if (body.byteLength !== prepared.byteLength) throw new TypeError('External Action prepared response byte length mismatch');
  return { kind: 'response', body };
}

const ExternalActionDaemonDispatchResultSchema = lazyZodSchema(() => z.union([
  ExternalActionDaemonDispatchInvalidRequestSchema,
  z.strictObject({ kind: z.literal('response'), body: z.instanceof(Uint8Array).check(z.refine((value) => value.byteLength <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2)) }),
]));

export function parseExternalActionDaemonDispatchResult(value: unknown): ParsedExternalActionDaemonDispatchResult | null {
  const parsed = ExternalActionDaemonDispatchResultSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.kind === 'invalid_request') return parsed.data;
  try {
    const body = new TextDecoder('utf-8', { fatal: true }).decode(parsed.data.body);
    const raw: unknown = JSON.parse(body);
    const encrypted = ExternalActionResponseEnvelopeV2Schema.safeParse(raw);
    if (encrypted.success) return { kind: 'response', prepared: {
      response: encrypted.data, body, byteLength: parsed.data.body.byteLength,
    } };
    return parseExternalActionDaemonDispatchResultV1(value);
  } catch { return null; }
}
