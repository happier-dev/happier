import { readDeploymentDefinitionSourceKindV1, readDeploymentTargetSourceCheckV1 } from '@happier-dev/protocol/deployments/resolvePublishTargetRecommendation';
import { createEnvironmentTelemetrySetForHost } from './telemetry/setForHost';
import { executeOwnServerDatabaseOperationForHost } from './targets/ownServer/databaseConnection';
import { ApiClient } from '@/api/api';
import { DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1, DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createOwnServerDataRoleBindingsForHost } from './targets/ownServer/dataRoleBindings';
import { createDomainDnsActionsForHost } from './targets/domainDnsActionsForHost';
import { isDeploymentDomainDnsActionIdV1 } from '@happier-dev/protocol';
import { deploymentOutputValidationFailure } from './outputValidation';
import { projectDeploymentFailure } from './deploymentFailure';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { readExpectedDownDomainReferencesForHost, readTelemetryCollectorDomainForHost,
    readTelemetryCollectorPlacementForHost } from './targets/ownServer/domainRouteSelection';
import { resolvePrivateServiceExportAdmissionForHost } from './targets/ownServer/privateServiceReference';
import { resolveOwnServerDeploymentIdentityForHost } from './targets/ownServer/paths';
import { configuration } from '@/configuration';
import { decodeBase64 } from '@/api/encryption';
import type { TcpTunnelServiceExportBindingV1 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantScopesV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isHomeAdmittedPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';
import { isSharedRequesterActionV1 } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { normalizeDeploymentTargetLinkOriginV1 } from '@happier-dev/protocol/deployments/targetLinkInput';
import { createDeploymentBackupActionForHost, createDeploymentBackupRecordedHealthForHost } from './actions/backups';
import { createDeploymentBackupConfigureForHost } from './actions/backupConfigureForHost';
import { prepareBackupAnotherMachineChildrenForHost } from './backups/anotherMachineForHost';
import { DeploymentBackupConfigureInputV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { createProjectReadinessActionForHost, projectReadinessEnvironmentFactForHost } from './actions/projectReadiness';
import { readScmHostingProjectReadinessForHost } from '@/scm/hostingProviders/projectReadinessForHost';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import { readSavedHealthCheckSourcesForHost } from './healthChecks/readSavedHealthCheckSource';
import { readHealthCheckReadiness, readHealthAlertReadiness } from './healthChecks/readiness';
import type { CurrentDomainEdgeObservation } from './healthChecks/currentDomainEdgeObservation';
import { readDeploymentHealthCurrentPlacementFailure } from './healthChecks/currentHealthPlacement';
import { createCliNotificationCatalogForHost } from '@/session/actions/cliActionDeps/notifications';
import { createHostPluginNotificationChannels, readSavedHealthAlertDestinationAvailabilityForHost } from '@/notifications/activity/pluginNotificationChannels';
import { createPlatformFailureEnrollmentForHost } from './platformFailureEnrollment';
import { createPreviewEnrollmentForHost } from './previewEnrollment';
import { deploymentAuthorizationFailure, refuseDeploymentAuthorization } from './deploymentAuthorizationFailure';
import { logger } from '@/ui/logger';
import axios from '@/api/client/credentialAxios';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { projectHomeAuthorizationHttpFailure } from '@/api/client/homeAuthorizationHttpFailure';
import { deploymentPreparationOperationForActionV1 } from '@happier-dev/protocol/deployments/deploymentPreparationAdmissionV1';
import { z } from 'zod/mini';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
    DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1,
    DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema, DeploymentReceiptListResultV1Schema, DeploymentReceiptResultV1Schema,
    DeploymentTransitionInputV1Schema, computeDeploymentTransitionRequestDigestV1, signMachineInstallationProof,
    type ActionExecutorContext, type ActionExecutorDeps, type DeploymentDomainHeaderV1, type DeploymentTargetLinkHeaderV1,
    DeploymentDeployInputV1Schema, DeploymentTeardownInputV1Schema, DeploymentTeardownPreparedInputV1Schema, type DeploymentDeployInputV1,
    DeploymentPendingCancelInputV1Schema, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentCreateInputV1Schema,
    DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentEnvironmentCreatePreviewV1Schema, DeploymentTargetLinksListResultV1Schema,
    type DeploymentEnvironmentCreateIntentInputV1,
    type DeploymentTransitionInputV1, type DeploymentTeardownInputV1,
    DeploymentChildRpcV1Schema, type DeploymentChildRpcV1,
    DeploymentDomainMutationResultV1Schema, DeploymentDomainMachineTopologyV1Schema, isDeploymentDomainChildActionIdV1,
    DeploymentTemplateInstantiateInputV1Schema, deploymentOperationForRootActionV1,
} from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentEnvironmentCreationReviewV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readHostAdmittedReviewedChildV1, readHostAdmittedReviewedParentV1, readHostAdmittedReviewedRootV1, readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { admitForkPreviewDeploymentForHost, prepareForkPreviewCreateForHost } from './forkPreviewCreateForHost';
import { readPreviewDomainForHost, preparePreviewDomainFactForHost } from './previewDomainForHost';
import { createDeploymentCandidatePublicationV1, createDeploymentDomainContentArtifactIdV1, createDeploymentEnvironmentContentArtifactIdV1,
    isDeploymentDomainNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readDeploymentTargetLinkArtifactV1, readDeploymentReceiptArtifactV1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
} from '@happier-dev/deployment-protocol';
import { readDeploymentReceiptActionFactsV1, type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1, type DeploymentContentV1, type DeploymentMachineResultV1, type DeploymentReceiptHeaderV1, type DeploymentSourceIntentV1, DeploymentContentV1Schema, DeploymentEnvironmentContentV1Schema, DeploymentDataTeardownContentV1Schema, DeploymentOwnServerContentV1Schema, DeploymentPlatformContentV1Schema, DeploymentProviderTeardownContentV1Schema, OwnServerDeploymentInputBasisV1Schema, getDeploymentTargetLinkLineageV1 } from '@happier-dev/deployments/contracts/v1';
import { readDeploymentEnvironmentArtifactV1, createDeploymentReceiptArtifactHeaderV1 } from '@happier-dev/deployments';
import { findExistingNativeComposeTargetLinkV1 } from '@happier-dev/deployments';
import { DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { createDeploymentMemberVersionProjectionV1, deploymentDomainProbeVantageV1,
    projectDeploymentDomainHealthFactsV1 } from '@happier-dev/deployments';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { ExternalActionInstalledMachineUnavailableSchema, readExternalActionInstalledMachineResult,
    readReviewedActionOperationCancelAddress } from '@/api/externalActionExecutionAuthorization';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { readRequesterAccountActionContext, readRequesterAccountActionTransportContext, rebindRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { captureRequesterCurrentnessRefusal } from '@/daemon/sessionEncryption/requesterCurrentness';
import { ArtifactEncryptionMaterialUnavailableError, createCredentialedAccountArtifactStore, type ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { StoredCredentials } from '@/persistence';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';
import { isDeploymentNativeReadActionIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createOwnServerDeploymentReads } from './targets/ownServer/ownServerDeploymentReads';
import { createPrivateServicePublicationSettlementForHost } from './targets/ownServer/privateServicePublicationHost';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createDataTeardownForHost } from './actions/dataTeardown';
import { createDeploymentRestoreActionForHost } from './actions/restore';
import { createDeploymentTeardownExecutor, resumeDeploymentTeardownReceiptForHost, type DeploymentTeardownBoundary } from './actions/teardown';
import { createOwnServerTeardownForHost } from './targets/ownServer/teardown';
import { readDeploymentUniformTargetLinkRevisionV1 } from './deploymentUniformProof';
import { createPrepareEnvironmentContentForHost } from './prepareEnvironmentContentForHost';
import { readStoredPromotionCandidateForHost, createStoredPromotionReceiptContentForHost } from './storedPromotionCandidate';
import { preparePromotionForHost } from './preparePromotionForHost';
import { projectDeploymentReviewRevisionV1, type DeploymentPromotionReviewV1Schema } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import { isDeploymentPromoteActionIdV1, isDeploymentMembershipActionIdV1,
    DEPLOYMENT_TEARDOWN_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1,
    DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1,
    DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_ROLLBACK_ACTION_ID_V1, DEPLOYMENT_TARGET_LINK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { admitStoredComposeDefinition } from '@/workspaces/projectSetup/nativeComposeSource';
import { createPrepareDeploymentBindingsForHost } from './secrets/prepareDeploymentBindingsForHost';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createOwnServerDeploymentTargetForHost, type OwnServerDeploymentRuntime,
    type OwnServerDeploymentTransition, type OwnServerDeploymentTargetHostInput,
    type OwnServerDeploymentReview, type OwnServerDeploymentReviewRequest } from './targets/ownServer/ownServerDeploymentTarget';
import { DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE, prepareOwnServerDeploymentCandidate } from './targets/ownServer/prepareCandidate';
import { requireOwnServerDeploymentBuildMachine } from './targets/ownServer/ownServerTargetAdmission';
import { assertReviewedDeploymentSource } from './reviewedSource';
import { createDaemonDeploymentChildExecutor, readDeploymentChildResult as readChildResult } from './deploymentChild';
import { projectDeploymentTransitionOutcomeUnknownForHost, projectDeploymentTransitionResultForHost } from './deploymentTransitionResult';
import { createDeploymentTemplateInstantiationForHost } from './templates/instantiate';
import { createDeploymentMoveToRepositoryForHost } from './moveToRepository';
import { createAdmittedCheckoutRepositoryFiles } from './admittedCheckoutRepositoryFiles';
import { readProjectAccountRows, createProjectAccountSnapshotMutation } from '@/workspaces/projectAccountRows';
import { materializeWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import type { CliAdmittedProjectRowsReader } from '@/session/actions/cliActionDeps/projectAdmission';
import type { RepositoryFilesPullRequestHost } from '@/scm/actions/repositoryFilesPullRequest';
import { deploymentMoveToRepositoryReviewedChildrenV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { executePreviewTemplateCreationForHost, type PreviewTemplateCreationPlanForHost } from './templates/previewCreate';
import type { HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import { readDeploymentTemplateDeployIntentV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import { createPlatformVariablesForHost } from './targets/platformVariablesForHost';
import { readDeploymentObservationForHost } from './readObservationForHost';
import { openDeploymentReceiptForHost, readDeploymentReceiptForHost, readDeploymentReceiptHistoryHeadersForHost,
    readOwnServerDeploymentReceiptHistoryForHost } from './readReceiptForHost';
import { readDeploymentCreationDefaultInputsForHost, prepareDeploymentCreationDefaultsForHost, prepareDeploymentEnvironmentDefaultsForHost,
    type DeploymentCreationDefaultRequestForHost } from './readCreationDefaultsForHost';
import { createEnvironmentCreatePlannerForHost, resolveEnvironmentCreateCopyForHost,
    resolveEnvironmentCreatePreviewForHost } from './prepareEnvironmentCreateForHost';
import { COPY_ENVIRONMENT_BINDINGS_ROLE, createEnvironmentWithCopyForHost } from './copyEnvironmentForHost';
import { copyEnvironmentDataProvisionRole, copyEnvironmentDataLinkRole } from './copyEnvironmentDataForHost';
import { readDeploymentTargetV1 } from './targets/deploymentTargetCatalog';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { prepareServiceAdoptionForHost } from './serviceAdoptionForHost';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { cancelPendingDeploymentForHost, preparePendingDeploymentForHost, waitForPendingDeploymentForHost, validatePendingDeploymentInputForHost,
} from './pendingDeploy';
import { readPendingDeploymentRecoveryOperation, readCompactPendingDeploymentRecovery } from './pendingDeploymentRecovery';
import { createDeploymentArtifactForHost } from './createArtifactForHost';
import { prepareRollbackForHost } from './prepareRollbackForHost';
import { settleInterruptedDeploymentReceiptForHost } from './receiptRecovery';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { createContributedDeploymentTargetForHost, deploymentTeardownDetachPreview } from './targets/contributedDeploymentTargetForHost';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { prepareTargetLinkForHost, TargetLinkPreparationError } from './prepareTargetLinkForHost';
import { prepareRuntimeTargetCreateForHost, createRuntimeTargetForHost, RuntimeTargetCreationCheckpointError } from './runtimeTargetCreateForHost';
import { DeploymentTargetLinkProvisionedResultV1Schema, type DeploymentTargetLinkProviderIntentInputV1, type DeploymentTargetLinkCreateIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentInvalidV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createOwnServerDomainActions, createOwnServerDomainContentWriter,
    prepareOwnServerDomainReviewedChildren, prepareOwnServerTeardownDomainReviewedChildren,
    prepareOwnServerMembershipDomainReviewedChildren } from './targets/ownServer/ownServerDomainActions';
import { createOwnServerDomainNative, createOwnServerStartFirstRoutesForHost } from './targets/ownServer/ownServerDomainNative';
import { createContributedDomainActionsForHost } from './targets/contributedDomainActionsForHost';
import { resolveDeploymentDefinitionRoleForHost, admitUseDeploymentDefinition, assertDeploymentHttpAuthorityForHost,
    assertDeploymentContentAuthorityForHost } from './deploymentDefinitionAdmission';
import { createDeploymentRestartActionForHost } from './actions/restart';
import { createDeploymentDataSizeActionForHost } from './actions/dataSize';
import { isDeploymentDataSizeActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { admitPreviewEnvironmentForHost, preparePreviewForkEligibilityForHost } from './previewAdmissionForHost';

type AdmittedTemplateSource = Readonly<{ id: string; revision: number }>;
export type DaemonDeploymentPreparationRequest = Parameters<NonNullable<ActionExecutorDeps['prepareDeploymentAction']>>[0] & Readonly<{
    /** Same-process Source facts captured by template admission; never Action/RPC input. */
    admittedTemplateSource?: AdmittedTemplateSource;
}>;
export type DaemonDeploymentPreparationResult = Awaited<ReturnType<NonNullable<ActionExecutorDeps['prepareDeploymentAction']>>>;
export type DaemonDeploymentCandidateRequest = Readonly<{
    environmentId: string; targetLinkId?: string; context: ActionExecutorContext;
    sourceIntent?: DeploymentSourceIntentV1; sha?: string; sourceMethod?: 'gitIntegration' | 'upload';
    services?: string[];
    requestKey?: string; whenBusy?: 'refuse' | 'supersede';
    onFailure?: DeploymentDeployInputV1['onFailure'];
    admittedTemplateSource?: AdmittedTemplateSource;
}>;
export type DaemonDeploymentCandidateResult = Readonly<{ ok: true; input: DeploymentDeployInputV1; content: DeploymentContentV1 }> | ActionExecuteFailure;
function refuse(reason: string | ActionExecuteFailure): never {
    const code = typeof reason === 'string' ? reason : reason.errorCode;
    throw Object.assign(new RpcError(code, code), { code, ...(typeof reason === 'string' ? {} : { cause: reason }) });
}
// Home owns completeness and grant coverage; native preparation only consumes that typed fact.
function requireDeploymentSecretScope(environment: DeploymentEnvironmentDetailV1): void {
    const scope = environment.secretScope;
    if (!scope) refuse('secret_scope_requirements_unavailable');
    if (scope.status !== 'ready') refuse(scope.reason);
}
const machineUnavailable = (details: z.infer<typeof ExternalActionInstalledMachineUnavailableSchema>): ActionExecuteFailure => ({
    ok: false, errorCode: 'machine_unavailable', details,
    error: `machine_unavailable (Machine ${details.machineId}: ${details.reason}, HTTP ${details.status})`,
});
const readMachineUnavailable = (error: unknown): ActionExecuteFailure | null => {
    const candidate = error instanceof Error ? error.cause : error;
    if (!candidate || typeof candidate !== 'object' || !('errorCode' in candidate)
        || candidate.errorCode !== 'machine_unavailable' || !('details' in candidate)) return null;
    const details = ExternalActionInstalledMachineUnavailableSchema.safeParse(candidate.details);
    return details.success ? machineUnavailable(details.data) : null;
};
const failure = (errorCode: string, error?: unknown): ActionExecuteFailure =>
    (errorCode === 'machine_unavailable' ? readMachineUnavailable(error) : null)
        ?? projectDeploymentFailure(errorCode, error);
const errorCode = (error: unknown) => {
    const { errorCode: code } = normalizeActionExecutorThrownError(error);
    const details = error instanceof Error && 'details' in error ? error.details : undefined;
    // Project only the native owner's closed reason. Native stderr, messages
    // and arbitrary PluginError details never enter the public Action result.
    if (code === 'service_admission_unavailable' && details !== null && typeof details === 'object'
        && 'reason' in details && details.reason === 'native_runtime_form_unsupported'
        && 'form' in details && details.form === 'native_config') return 'native_runtime_configuration_failed';
    return code;
};

import { createDaemonDeploymentNativeSnapshot, type ExecuteManagedNativeSnapshot } from './daemonDeploymentNativeSnapshot';
import { openManagedMachineRead } from '@/machines/managed/readManagedMachine';

/** Installed controller storage composition; the target remains the sole native executor. */
export function createDaemonDeploymentActionDeps(host: Readonly<{
    credentials: StoredCredentials;
    /** Native installation authentication remains distinct from requester content custody. */
    installedCredentials?: StoredCredentials;
    executeManagedSnapshot?: ExecuteManagedNativeSnapshot;
    /** Exact requester-owned content custody; transport remains signed by the root. */
    accountArtifacts?: ReturnType<typeof createCredentialedAccountArtifactStore>;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    resolveRequesterIdentity: import('./readDeploymentSourceIntentForHost').DeploymentSourceRequesterIdentityResolver;
    readMachineVitals?: () => MachineVitalsSampleV1 | null;
    ensureServiceObservations?: import('@/plugins/runtime/invocation/services/environmentServiceRecovery').EnsureEnvironmentServices;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    runtime: OwnServerDeploymentRuntime;
    captureNativeSetup?: () => import('./targets/ownServer/ownServerDomainNative').DomainNativeSetupForHost;
    acquirePluginRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
    executeSourceReadAction?: import('@/scm/hostingProviders/resolveRefForHost').ExecuteScmSourceReadAction;
    /** The Machine's SCM backends for reviewed checkout work; absent uses the installed runtime. */
    scmRegistry?: import('@/scm/registry').ScmBackendRegistry;
    resolveRepositoryRemovalRuntime?: import('./admittedCheckoutRepositoryFiles').ResolveRepositoryCheckoutRemovalRuntime;
    teardownBoundary?: DeploymentTeardownBoundary;
    /** Re-enters the incumbent executor's policy/review path, not another operation runner. */
    executePreparedPendingDeploy?(input: DeploymentDeployInputV1, context: ActionExecutorContext):
        Promise<import('@happier-dev/protocol/actions').ActionExecuteResult>;
    /** Existing installed operation owner; absence leaves ordinary cold preparation. */
    preparePendingDeploymentObservation?: HostActionOperationRuntime['preparePendingDeploymentObservation'];
    readOperation?(operationId: string, context: ActionExecutorContext): Promise<import('@happier-dev/protocol/actions').ActionOperationSnapshotV1 | null>;
    readBackupOperations?: Parameters<typeof createDeploymentBackupActionForHost>[0]['readBackupOperations'];
    readActiveBackupAutomationIds?(environment: Awaited<ReturnType<typeof readDeploymentEnvironmentForHost>>,
        context: ActionExecutorContext): Promise<readonly string[]>;
    acquireUpload?: Parameters<typeof createDeploymentRestoreActionForHost>[0]['acquireUpload'];
    runActionOperation?: ActionExecutorDeps['runActionOperation'];
}>) {
    const artifacts = host.accountArtifacts ?? createCredentialedAccountArtifactStore(host.credentials);
    const notificationCatalog = createCliNotificationCatalogForHost({ ...host,
        resolvePluginNotifications: createHostPluginNotificationChannels });
    const definitionRole = (context: ActionExecutorContext) => resolveDeploymentDefinitionRoleForHost(context, host);
    const copyEnvironmentChildren = (plan: NonNullable<import('@happier-dev/protocol').DeploymentEnvironmentCreateInputV1['copyPlan']>):
        HostReviewedChildrenPreparationV1['children'] => [
        ...(plan.bindings.length ? [{ action: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, role: COPY_ENVIRONMENT_BINDINGS_ROLE }] : []),
        ...(plan.data ?? []).flatMap(row => [
            { action: row.provision.action, role: copyEnvironmentDataProvisionRole(row.targetLinkId) },
            { action: DEPLOYMENT_TARGET_LINK_ACTION_ID_V1, role: copyEnvironmentDataLinkRole(row.targetLinkId) },
        ]),
    ];
    const requireDefinitionManage = async (context: ActionExecutorContext, code = 'action_forbidden') => {
        if (await definitionRole(context) !== 'manage') return refuse(code);
    };
    const atHome = <T>(run: () => T) => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, run);
    const assertHttpAuthority = assertDeploymentHttpAuthorityForHost;
    const assertCurrent = assertDeploymentContentAuthorityForHost;
    const headers = async (context: ActionExecutorContext, actionId: string,
        request: Readonly<{ method: string; path: string; body?: unknown }>) => {
        await assertHttpAuthority(context);
        const projection = context.externalActionExecutionAuthorization?.requesterHttpProjection;
        if (projection) {
            // A retained child spends its admitted root, not a new sub-read
            // Action. The projection and Home still admit the exact purpose.
            const child = readRequesterAccountActionContext(context.externalActionExecutionAuthorization)?.deploymentChild;
            // Create preparation spends its root; a reviewed Create keeps its
            // Action identity so the signer retains the child's role and digest.
            const root = context.externalActionExecutionAuthorization?.binding.actionId;
            const effectActionId = child?.actionId ?? (actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 && root
                && readHostAdmittedReviewedChildV1(context)?.actionId !== actionId
                && deploymentPreparationOperationForActionV1(root) === 'create' ? root : actionId);
            const signed = await captureRequesterCurrentnessRefusal(() => projection.createRequestHeaders({
                ...request, effectActionId,
                ...(context.signal ? { signal: context.signal } : {}) }));
            if (!signed.value) return refuseDeploymentAuthorization(signed.branch
                ? `home_request_headers_refused:${signed.branch}` : 'home_request_headers_refused');
            return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...signed.value };
        }
        return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${host.credentials.token}` };
    };
    const artifactAuthorization = (context: ActionExecutorContext, effectActionId?: string): ArtifactRequestAuthorizationHeaders => request => headers(context,
            effectActionId ?? context.externalActionExecutionAuthorization?.binding.actionId ?? 'deployments.deploy', request);
    const isTemplateDeploymentRoot = (context: ActionExecutorContext) => {
        const binding = context.externalActionExecutionAuthorization?.binding;
        return binding?.actionId === 'deployments.templates.instantiate'
            || binding?.actionId === 'deployments.environments.create'
                && deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission) === 'deploy';
    };
    const candidateArtifactAuthorization = (context: ActionExecutorContext): ArtifactRequestAuthorizationHeaders => request => headers(context,
        isTemplateDeploymentRoot(context)
            ? 'deployments.deploy' : context.externalActionExecutionAuthorization?.binding.actionId ?? 'deployments.deploy', request);
    const publicationSources = createCliProjectSourceActionDeps({ serverHttpBaseUrl: host.serverHttpBaseUrl,
        admitAccount: async (serverId, context) => { await assertHttpAuthority(context); return serverId === host.serverId ? null : failure('server_scope_mismatch'); },
        resolveRequestHeaders: headers });
    const candidateIdentity = async (environmentId: string, context: ActionExecutorContext, kind: 'receipt' | 'environment' = 'receipt',
        environment?: DeploymentEnvironmentDetailV1['environment'], admittedTemplateSource?: AdmittedTemplateSource) => {
        const binding = context.externalActionExecutionAuthorization?.binding;
        if (!binding) return {};
        const operation = deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission);
        if (operation === undefined) return {};
        let scope = binding.deploymentCandidatePublication;
        if (isTemplateDeploymentRoot(context)) {
            const current = environment ?? (await readEnvironmentMetadata({ environmentId, context })).environment;
            // The finite template invocation retains the Source fact its admission read.
            // Other candidate callers still acquire their own Source admission here.
            const source = admittedTemplateSource ?? await (async () => {
                const read = await publicationSources.projectSourcesRead!({ serverId: host.serverId, sourceId: current.projectSourceId }, context);
                if (!read.ok) return refuse('errorCode' in read ? read : read.error);
                return { id: read.source.id, revision: read.source.revision };
            })();
            scope = createDeploymentCandidatePublicationV1({ accountId: binding.accountId,
                serverIdentityId: binding.serverIdentityId, actionId: binding.actionId, requestId: binding.requestId,
                requestEnvelopeDigest: binding.requestEnvelopeDigest, environmentId,
                source });
        }
        if (!scope || scope.environmentId !== environmentId) return refuse('action_forbidden');
        const artifactId = kind === 'receipt' ? scope.contentArtifactId : scope.environmentContentArtifactId;
        if (!artifactId) return refuse('action_forbidden');
        return { artifactId };
    };
    const open = async (id: string, context: ActionExecutorContext,
        authorizationHeaders: ArtifactRequestAuthorizationHeaders = artifactAuthorization(context)) => {
        await assertCurrent(context);
        return atHome(() => artifacts.read(id, { signal: context.signal, prepareRecipients: false,
            includeSharedAudience: false, authorizationHeaders }));
    };
    const openReceipt = async (deployment: DeploymentReceiptHeaderV1, context: ActionExecutorContext): Promise<DeploymentReceiptDetailV1> => {
        return openDeploymentReceiptForHost(deployment, context, { open, assertCurrent });
    };
    const readEnvironmentMetadata = async ({ environmentId, context }: Readonly<{ environmentId: string; context: ActionExecutorContext }>) => {
        const loaded = await storage('deployments.environments.get', { serverId: host.serverId, environmentId }, context);
        if ('ok' in loaded && !loaded.ok && 'errorCode' in loaded) return refuse(loaded);
        const detail = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
        if (!detail.ok) return refuse(detail.error);
        return detail;
    };
    const readTargetLink = async (targetLink: DeploymentTargetLinkHeaderV1, context: ActionExecutorContext) => {
        const content = readDeploymentTargetLinkArtifactV1(targetLink, await open(targetLink.contentArtifactId, context));
        if (!content.ok) return refuse(failure(content.error, content));
        return { targetLink, content: content.content };
    };
    const assertEnvironmentContentOwnerCurrent = async (request: Readonly<{ environmentId: string; context: ActionExecutorContext }>,
        owner: DeploymentEnvironmentDetailV1['environment']['owner']) => {
        await assertCurrent(request.context);
        const current = (await readEnvironmentMetadata(request)).environment;
        if (!isDeepStrictEqual(current.owner, owner)) return refuse('deployment_conflict');
    };
    const readReceiptMetadata = async (environmentId: string, deploymentId: string, context: ActionExecutorContext) => {
        const loaded = await storage('deployments.receipts.get', { serverId: host.serverId, environmentId, deploymentId }, context);
        if ('ok' in loaded && !loaded.ok && 'errorCode' in loaded) return refuse(loaded);
        const detail = DeploymentReceiptGetResultV1Schema.parse(loaded);
        if (!detail.ok) return refuse(detail.error);
        return detail;
    };
    const targetHostReaders = {
        async readRetentionHeaders(request: Parameters<NonNullable<OwnServerDeploymentTargetHostInput['readRetentionHeaders']>>[0]) {
            const [environment, loaded] = await Promise.all([
                readEnvironmentMetadata(request),
                storage('deployments.receipts.get', { serverId: host.serverId,
                    deploymentId: request.deploymentId }, request.context),
            ]);
            if ('ok' in loaded && !loaded.ok && 'errorCode' in loaded) return refuse(loaded);
            const receipt = DeploymentReceiptGetResultV1Schema.parse(loaded);
            if (!receipt.ok) return refuse(receipt.error);
            const link = environment.targetLinks.find(link => link.id === request.targetLinkId);
            if (!link) return refuse('target_mismatch');
            await assertHttpAuthority(request.context);
            return { environment: environment.environment, deployment: receipt.deployment, link };
        },
        async readEnvironmentMetadata(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>) {
            return (await readEnvironmentMetadata(request)).environment;
        },
        async readEnvironment({ environmentId, targetLinkId, context }: Readonly<{ environmentId: string; targetLinkId?: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1> {
            const detail = await readDeploymentEnvironmentForHost({ environmentId, context }, {
                readMetadata: readEnvironmentMetadata, open, assertCurrent,
            });
            // Native deployment execution consumes the selected workload and its
            // retained predecessor proofs, not other private target resources.
            const selected = detail.targetLinks.find(link => link.id === (targetLinkId ?? detail.environment.runtimeTargetLinkId));
            const lineage = selected?.role === 'runtime' ? getDeploymentTargetLinkLineageV1(selected, detail.targetLinks)
                : new Set(selected ? [selected.id] : []);
            const links = await Promise.all(detail.targetLinks.filter(link => lineage.has(link.id))
                .map(link => readTargetLink(link, context)));
            await assertCurrent(context);
            return { ...detail, targetLinks: links };
        },
        async readAnyReceipt(request: Parameters<OwnServerDeploymentTargetHostInput['readReceipt']>[0]): Promise<DeploymentReceiptDetailV1> {
            const { environmentId, deploymentId, nativeIncumbentSource } = request;
            let context = request.context;
            const authorization = context.externalActionExecutionAuthorization;
            const projection = authorization?.requesterHttpProjection;
            const child = readRequesterAccountActionContext(authorization)?.deploymentChild;
            if (nativeIncumbentSource && child?.kind === 'review') {
                if (!authorization || !projection) return refuse('action_forbidden');
                // Rebind keeps the admitted requester context (and its forwarded child) on the new carrier;
                // a bare spread drops it, so the incumbent read was signed as a receipts.get effect and refused.
                context = { ...context, externalActionExecutionAuthorization: rebindRequesterAccountActionContext({ ...authorization,
                    requesterHttpProjection: { ...projection, createRequestHeaders: request => projection.createRequestHeaders({
                        ...request, nativeIncumbentSource }) } }, authorization) };
            }
            return readDeploymentReceiptForHost({ environmentId, deploymentId, context }, { open, assertCurrent,
                async readMetadata(request) {
                    return readReceiptMetadata(request.environmentId, request.deploymentId, request.context);
                } });
        },
        async readReceipt(request: Parameters<OwnServerDeploymentTargetHostInput['readReceipt']>[0]): ReturnType<OwnServerDeploymentTargetHostInput['readReceipt']> {
            const receipt = await targetHostReaders.readAnyReceipt(request);
            return { ...receipt, content: DeploymentOwnServerContentV1Schema.parse(receipt.content) };
        },
    };
    const sendChild = async (job: DeploymentChildRpcV1, context: ActionExecutorContext): Promise<unknown> => {
        await assertCurrent(context);
        const authorization = context.externalActionExecutionAuthorization;
        const requester = readRequesterAccountActionTransportContext(authorization);
        const identity = readInstallationIdentityIfExistsSync();
        if (!authorization || !requester || !identity || !context.originalActionEnvelope) {
            logger.warn('[Deployment] child dispatch refused', {
                rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD,
                branch: deploymentAuthorizationFailure('child_dispatch_context_missing').error,
                requesterAvailable: Boolean(requester),
                installationAvailable: Boolean(identity),
                envelopeAvailable: Boolean(context.originalActionEnvelope),
            });
            return refuseDeploymentAuthorization('child_dispatch_context_missing');
        }
        return callExactMachineRpc({ credentials: requester.credentials, serverUrl: requester.serverHttpBaseUrl,
            machineId: job.machineId, method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, request: job,
            requireCurrentMachine: true, requiredMachineKind: 'persistent', timeoutMs: null, waitForResultOnCancel: true,
            externalAction: { context, effectActionId: job.actionId, installationId: identity.installationId, privateKey: identity.privateKey },
            ...(context.authority === 'account_automation' ? { authorityCeiling: 'account_automation' as const } : {}),
            ...(context.signal ? { signal: context.signal } : {}) });
    };
    const nativeSnapshot = createDaemonDeploymentNativeSnapshot(host, {
        headers,
        sendChild,
        async openManagedRead(read, context) {
            await assertCurrent(context);
            const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
            if (requester && !await requester.isCurrent()) return null;
            try {
                const machine = await openManagedMachineRead({
                    credentials: requester?.credentials ?? host.credentials,
                    serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? host.serverHttpBaseUrl,
                    read,
                    ...(context.signal ? { signal: context.signal } : {}),
                });
                return requester && !await requester.isCurrent() ? null : machine;
            } catch {
                context.signal?.throwIfAborted();
                return null;
            }
        },
    });
    const readInstallation = async (machineId: string, context: ActionExecutorContext) => {
        if (machineId === host.machineId) {
            const identity = readInstallationIdentityIfExistsSync();
            return identity?.installationId ?? refuse('target_mismatch');
        }
        const path = `/v1/machines/${encodeURIComponent(machineId)}`;
        const installed = await readExternalActionInstalledMachineResult({ serverHttpBaseUrl: host.serverHttpBaseUrl, machineId,
            headers: await headers(context, context.externalActionExecutionAuthorization?.binding.actionId ?? 'deployments.deploy', { method: 'GET', path }),
            ...(context.signal ? { signal: context.signal } : {}) });
        if (!installed.ok) return refuse(machineUnavailable(installed.details));
        return installed.machine.installationId;
    };
    const readTelemetryCollectorPlacement: NonNullable<OwnServerDeploymentTargetHostInput['readTelemetryCollectorPlacement']> = async (machineId, context) => {
        const machine = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, async () => context.externalActionExecutionAuthorization
            ? ApiClient.getRequesterMachine(machineId, { authorization: context.externalActionExecutionAuthorization, signal: context.signal })
            : (await ApiClient.create(host.credentials)).getMachine(machineId, { signal: context.signal }));
        return machine ? readTelemetryCollectorPlacementForHost(machine) : { kind: 'unavailable', reason: 'collector_unavailable' };
    };
    const receiptHistoryPages = (request: Readonly<{ environmentId: string; context: ActionExecutorContext }>, lineage?: ReadonlySet<string>) => ({
        environmentId: request.environmentId, lineage,
        async readPage(cursor?: string) {
            const loaded = await storage('deployments.receipts.list', { serverId: host.serverId,
                environmentId: request.environmentId, ...(cursor ? { cursor } : {}) }, request.context);
            if ('ok' in loaded && !loaded.ok && 'errorCode' in loaded) return refuse(loaded);
            return loaded;
        },
    });
    const historyLineage = async (request: Parameters<NonNullable<OwnServerDeploymentTargetHostInput['readBuildHistory']>>[0]) => {
        if (request.targetLinkId === undefined) return undefined;
        const environment = request.environment ?? await targetHostReaders.readEnvironment(request);
        const link = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId)?.targetLink;
        if (!link) return refuse('target_mismatch');
        return getDeploymentTargetLinkLineageV1(link, environment.targetLinks.map(item => item.targetLink));
    };
    const readReceiptHistory = (request: Parameters<typeof receiptHistoryPages>[0], lineage?: ReadonlySet<string>) =>
        readOwnServerDeploymentReceiptHistoryForHost({ ...receiptHistoryPages(request, lineage),
            readCurrent: deploymentId => targetHostReaders.readReceipt({ ...request, deploymentId }),
            open: deployment => openReceipt(deployment, request.context),
        });
    const readMemberVersions = async (request: Parameters<NonNullable<OwnServerDeploymentTargetHostInput['readMemberVersions']>>[0],
        environment: DeploymentEnvironmentDetailV1): Promise<readonly DeploymentMachineResultV1[]> => {
        const link = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId)?.targetLink;
        if (!link) return refuse('target_mismatch');
        const retainedLinks = environment.targetLinks.map(item => item.targetLink);
        const lineage = getDeploymentTargetLinkLineageV1(link, retainedLinks);
        const projection = createDeploymentMemberVersionProjectionV1(link, retainedLinks);
        for await (const receipt of readReceiptHistory(request, lineage)) {
            if (projection.addReceipt(receipt)) break;
        }
        const versions = projection.getVersions();
        return link.members.map(member => ({ machineId: member.machineId, installationId: member.installationId,
            steps: [], activation: 'pending', health: 'unknown',
            ...(versions[member.machineId]?.deploymentId ? { currentDeploymentId: versions[member.machineId].deploymentId! } : {}) }));
    };
    const targetHost: Omit<OwnServerDeploymentTargetHostInput, 'writeTransition'> & Readonly<{
        writeTransition(request: Omit<OwnServerDeploymentTransition, 'content'> & Readonly<{ content?: DeploymentContentV1 }>):
            ReturnType<OwnServerDeploymentTargetHostInput['writeTransition']>;
    }> = { ...host, ...targetHostReaders,
        readTelemetryCollectorPlacement,
        async readTelemetryCollectorDomain(request) {
            const collector = await readTelemetryCollectorPlacement(request.collectorMachineId, request.context);
            if (collector.kind !== 'ready') return collector;
            const authorization = request.context.externalActionExecutionAuthorization;
            const observer = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, async () => authorization
                ? ApiClient.getRequesterMachine(host.machineId, { authorization, signal: request.context.signal })
                : (await ApiClient.create(host.credentials)).getMachine(host.machineId, { signal: request.context.signal }));
            return readTelemetryCollectorDomainForHost({ serverId: host.serverId, environmentId: request.environmentId,
                targetLinkId: request.targetLinkId, collectorMachineId: collector.machineId,
                observerNetworks: observer?.daemonState?.reachability?.privateNetworks ?? [], signal: request.context.signal,
                open: id => open(id, request.context),
                list: async (query, signal) => DeploymentActionOutputSchemasV1['deployments.domains.list'].parse(
                    await storage('deployments.domains.list', query, { ...request.context, signal })),
                async observe(domain, capture) {
                    const response = readChildResult(await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain',
                        actionId: 'deployments.domains.verify', machineId: capture.placement.machineId,
                        installationId: capture.placement.installationId, input: { serverId: host.serverId,
                            environmentId: domain.environmentId, domainId: domain.id }, expectedDomainRevision: domain.revision,
                        capture, observeTopology: { environmentId: request.environmentId, deploymentId: request.deployment.id,
                            actionOperationId: request.deployment.actionOperationId } }), request.context));
                    const parsed = DeploymentDomainMachineTopologyV1Schema.safeParse(response);
                    return parsed.success ? parsed.data : null;
                } });
        },
        readPreviewDomain(request) {
            return readPreviewDomainForHost(request, {
                readMetadata: operand => storage('deployments.domains.get', operand, request.context),
                open: id => open(id, request.context),
            });
        },
        settlePrivateWorkloadFirewall: createPrivateServicePublicationSettlementForHost(host),
        async enrollMemberRoutes(request, input) {
            const result = await domainActions.reconcileMembership({ environmentId: request.input.environmentId,
                targetLinkId: input.link.id, deploymentId: request.receipt.deploymentId,
                requestKey: request.input.requestKey,
                ...(input.reconcileTunnelConnectorsOnly ? { reconcileTunnelConnectorsOnly: true } : {}),
            }, { ...request.context, signal: input.signal });
            return result ?? request.receipt;
        },
        async readExpectedDownDomains(request) {
            return readExpectedDownDomainReferencesForHost({ serverId: host.serverId, environmentId: request.environmentId,
                targetLinkId: request.targetLinkId, affectedServices: request.affectedServices, signal: request.context.signal,
                open: id => open(id, request.context),
                list: async (query, signal) => DeploymentActionOutputSchemasV1['deployments.domains.list'].parse(
                    await storage('deployments.domains.list', query, { ...request.context, signal })) });
        },
        async readStartFirstRoutes(request, input) {
            return createOwnServerStartFirstRoutesForHost({ ...host, open,
                list: async (query, signal) => DeploymentActionOutputSchemasV1['deployments.domains.list'].parse(
                    await storage('deployments.domains.list', query, { ...request.context, signal })) })(request, input);
        },
        async dispatchBuild(request, receiptHeader) {
            const builder = receiptHeader.acceptedExecution!.builder!;
            return readChildResult(await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'build', actionId: request.actionId,
                input: request.input, machineId: builder.machineId, installationId: builder.installationId,
                deploymentId: request.receipt.deploymentId,
                actionOperationId: request.context.operationAcceptance?.operationId }), request.context));
        },
        async *readBuildHistory(request) {
            yield* readReceiptHistory(request, await historyLineage(request));
        },
        async dispatchMember(member) {
            const { request } = member;
            const result = await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: request.actionId,
                input: request.input, machineId: member.machineId, installationId: member.installationId,
                phase: member.phase, selectedDeploymentId: member.selectedDeploymentId, deploymentId: request.receipt.deploymentId,
                actionOperationId: request.context.operationAcceptance?.operationId }), request.context);
            return readChildResult(result);
        },
        async dispatchRetention(member) {
            const { request } = member;
            return readChildResult(await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'retention', actionId: request.actionId,
                input: request.input, machineId: member.machineId, installationId: member.installationId,
                deploymentId: request.receipt.deploymentId, actionOperationId: request.context.operationAcceptance?.operationId,
                settledTargetLinkRevision: member.settledTargetLinkRevision,
                settledDeploymentRevision: member.settledDeploymentRevision, activeDeploymentId: member.activeDeploymentId }), request.context));
        },
        async reviewMember(member): Promise<OwnServerDeploymentReview> {
            if (member.machineId === host.machineId) return target.reviewMember(member);
            const result = await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: member.request.actionId,
                input: member.request.input, machineId: member.machineId, installationId: member.installationId }), member.request.context);
            if (!result || typeof result !== 'object') return refuse('invalid_action_transport_output');
            if ('errorCode' in result && typeof result.errorCode === 'string')
                return refuse(projectDeploymentFailure(result.errorCode, result));
            if (!('inputBasis' in result) || !('reviewedEffect' in result) || !('runtimePlatform' in result)
                || typeof result.runtimePlatform !== 'string' || !result.runtimePlatform) return refuse('invalid_action_transport_output');
            return { inputBasis: OwnServerDeploymentInputBasisV1Schema.parse(result.inputBasis),
                reviewedEffect: normalizeStrictJsonValue(result.reviewedEffect), runtimePlatform: result.runtimePlatform };
        },
        async readMemberVersions(request): Promise<readonly DeploymentMachineResultV1[]> {
            return readMemberVersions(request, await targetHostReaders.readEnvironment(request));
        },
        async writeTransition(request) {
            let issued = false;
            try {
                await assertCurrent(request.context);
                const identity = readInstallationIdentityIfExistsSync();
                const accountId = request.context.externalActionExecutionAuthorization?.binding.accountId
                    ?? request.context.runtimeAccountId ?? readAccountIdFromToken(host.credentials.token);
                if (!identity || !accountId) return failure('target_mismatch');
                const receipt = request.receiptHeader;
                const content = request.content;
                let contentReference: Pick<DeploymentTransitionInputV1, 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'> | undefined;
                // Recovery records its reason through the same atomic receipt
                // Artifact update as ordinary transitions.
                const prepared = content ? await (async () => {
                    const artifactId = receipt.contentArtifactId;
                    if (artifactId === null) return failure('deployment_content_unavailable');
                    const resource = await atHome(() => artifacts.readForUpdate(artifactId, {
                        signal: request.context.signal, prepareRecipients: false, includeSharedAudience: false,
                        authorizationHeaders: artifactAuthorization(request.context) }));
                    if (!resource) return failure('deployment_content_unavailable');
                    const artifact = resource.artifact;
                    const title = artifact.header.title;
                    if (typeof title !== 'string') return failure('deployment_content_unavailable');
                    contentReference = { contentArtifactId: artifact.artifactId, contentHeaderVersion: artifact.revision.headerVersion,
                        contentBodyVersion: artifact.revision.bodyVersion };
                    const retained = readDeploymentReceiptArtifactV1({ contentArtifactId: artifact.artifactId,
                        contentHeaderVersion: artifact.revision.headerVersion, contentBodyVersion: artifact.revision.bodyVersion }, artifact);
                    if (!retained.ok) return failure('deployment_content_unavailable');
                    // Only the admitted root can capture its first execution actor. Later
                    // observation/recovery keeps the historical actor, including unknown.
                    const acceptance = request.context.operationAcceptance;
                    const isFirstExecution = receipt.state === 'queued' && acceptance?.operationId === receipt.actionOperationId
                        && acceptance.actionId !== undefined && deploymentOperationForRootActionV1(acceptance.actionId) === receipt.operation;
                    const actor = retained.content.actor ?? content.actor
                        ?? (isFirstExecution ? acceptance?.actor : undefined);
                    const historicalContent = actor ? { ...content, actor } : content;
                    return atHome(() => resource.prepareJsonUpdate({
                        header: createDeploymentReceiptArtifactHeaderV1(title, historicalContent),
                        body: JSON.stringify(historicalContent), beforeWrite: () => assertCurrent(request.context) }));
                })() : null;
                if (prepared && !prepared.ok) return prepared;
                const binding = request.context.externalActionExecutionAuthorization?.binding;
                const restoring = binding?.actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1;
                const settled = ['succeeded', 'running_unverified', 'failed', 'cancelled', 'outcome_unknown'].includes(request.state);
                const environment = !restoring && receipt.operation !== 'teardown' && (request.state === 'succeeded' || request.state === 'running_unverified')
                    ? await readEnvironmentMetadata(request) : null;
                const link = environment?.targetLinks.find(item => item.id === receipt.targetLinkId);
                if (environment && !link) return failure('target_mismatch');
                const uniformProof = link?.source.kind === 'plugin' && request.content?.platform
                    ? { expectedTargetLinkRevision: request.content.platform.targetLinkRevision }
                    : link?.source.kind === 'host' ? readDeploymentUniformTargetLinkRevisionV1({ deploymentId: receipt.id,
                        actionOperationId: receipt.actionOperationId,
                        targetLink: link, content: DeploymentOwnServerContentV1Schema.parse(request.content) }) : undefined;
                if (link && uniformProof == null) return failure('deployment_conflict');
                const body: Omit<DeploymentTransitionInputV1, 'proof'> = {
                    serverId: request.context.externalActionExecutionAuthorization?.binding.serverIdentityId ?? host.serverId,
                    environmentId: request.environmentId, deploymentId: request.deploymentId,
                    expectedRevision: request.expectedRevision, actionOperationId: receipt.actionOperationId,
                    machineId: host.machineId, installationId: identity.installationId,
                    kind: settled ? 'settle' : 'stage', state: request.state,
                    ...(request.telemetryMachineId !== undefined ? { telemetryMachineId: request.telemetryMachineId,
                        telemetryTokenHash: request.telemetryTokenHash } : {}),
                    ...contentReference, ...(prepared ? { contentUpdate: prepared.mutation } : {}),
                    ...uniformProof,
                    ...(request.teardownProof ? { teardownProof: request.teardownProof } : {}),
                };
                const proof = signMachineInstallationProof({ payload: { version: 1, machineId: host.machineId,
                    installationId: identity.installationId, accountId,
                    deploymentTransition: { serverId: body.serverId, environmentId: body.environmentId, deploymentId: body.deploymentId,
                        actionOperationId: body.actionOperationId, expectedRevision: body.expectedRevision,
                        requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: identity.privateKey });
                const wire = DeploymentTransitionInputV1Schema.parse({ ...body, proof });
                const path = `/v1/deployments/environments/${encodeURIComponent(request.environmentId)}/deployments/${encodeURIComponent(request.deploymentId)}/transitions`;
                if (prepared) await atHome(() => prepared.assertCurrent());
                const rootOperation = binding && deploymentOperationForRootActionV1(binding.actionId, binding.deploymentPreparationAdmission);
                const effectActionId = restoring || binding?.actionId === 'deployments.receipts.observe'
                    ? binding.actionId : `deployments.${rootOperation ?? receipt.operation}`;
                const admittedHeaders = await headers(request.context, effectActionId,
                    { method: 'POST', path, body: wire });
                issued = true;
                const response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`,
                    headers: admittedHeaders, data: wire, signal: request.context.signal, validateStatus: () => true });
                const parsed = DeploymentReceiptResultV1Schema.safeParse(response.data);
                const result = parsed.success ? projectDeploymentTransitionResultForHost(parsed.data, response.status) : null;
                if (!result) return projectDeploymentTransitionOutcomeUnknownForHost({ response });
                if (result.ok && prepared) await atHome(() => prepared.afterCommit());
                return result;
            } catch (error) { return issued ? projectDeploymentTransitionOutcomeUnknownForHost(error) : failure(errorCode(error), error); }
        },
    };
    const recoverInterruptedReceipt = async (actionId: string,
        input: Readonly<{ serverId: string; environmentId?: string; requestKey?: string }>,
        context: ActionExecutorContext): Promise<ActionExecuteFailure | null> => {
        const environmentId = input.environmentId;
        const operation = deploymentOperationForRootActionV1(actionId);
        if (host.readOperation && operation !== undefined && environmentId !== undefined) {
            try {
                if (input.serverId !== host.serverId) return failure('server_scope_mismatch');
                const identity = readInstallationIdentityIfExistsSync();
                const accountId = context.externalActionExecutionAuthorization?.binding.accountId
                    ?? context.runtimeAccountId ?? readAccountIdFromToken(host.credentials.token);
                if (identity && accountId) {
                    const recovered = await settleInterruptedDeploymentReceiptForHost({ environmentId,
                        accountId, machineId: host.machineId, installationId: identity.installationId, context,
                        operation, requestKey: input.requestKey }, {
                        readOperation: host.readOperation,
                        readReceipt: (header, context) => openDeploymentReceiptForHost(header, context, { open, assertCurrent }),
                        writeTransition: targetHost.writeTransition,
                        async readInProgress() {
                            const result = await storage('deployments.receipts.list', { serverId: input.serverId,
                                environmentId, inProgressOnly: true }, context);
                            if ('ok' in result && !result.ok && 'errorCode' in result) return refuse(result);
                            const page = DeploymentReceiptListResultV1Schema.parse(result);
                            return page.ok ? page.items : refuse(page.error);
                        },
                    });
                    if (recovered) return recovered;
                }
            } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
        }
        return null;
    };
    const target = createOwnServerDeploymentTargetForHost(targetHost);
    const injectedTeardown = createDeploymentTeardownExecutor({ ...targetHost, boundary: host.teardownBoundary });
    const readPreparedDeploymentContent = async (request: Readonly<{ input: DeploymentDeployInputV1; context: ActionExecutorContext }>) => {
        try {
            if (request.input.serverId !== host.serverId) return failure('server_scope_mismatch');
            await assertCurrent(request.context);
            const opened = readDeploymentReceiptArtifactV1(request.input,
                await open(request.input.contentArtifactId, request.context));
            if (!opened.ok) return failure(opened.error, opened);
            await assertCurrent(request.context);
            return { ok: true as const, content: opened.content };
        } catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
    };
    const createReceiptCandidate = async ({ environment, content, context, assertCurrent: assertCandidateCurrent }: Readonly<{
        environment: DeploymentEnvironmentDetailV1; content: DeploymentContentV1; context: ActionExecutorContext;
        assertCurrent(): Promise<void>;
    }>) => {
            const binding = context.externalActionExecutionAuthorization?.binding;
            // This preparer also publishes contributed Deploy candidates. Only native
            // Teardown rebuilds its inventory before reopening the reviewed receipt.
            const teardown = 'teardown' in content && binding?.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1;
            const reviewed = teardown ? binding.deploymentCandidatePublication?.reviewed : undefined;
            if (reviewed) {
                const opened = readDeploymentReceiptArtifactV1(reviewed,
                    await open(reviewed.contentArtifactId, context, candidateArtifactAuthorization(context)));
                if (!opened.ok) return refuse(opened.error);
                // Only the queued observation timestamp is generated again during provider preparation.
                const facts = (value: DeploymentContentV1) => value.platform ? { ...value,
                    platform: { ...value.platform, observation: { ...value.platform.observation, observedAtMs: 0 } } } : value;
                if (!sameStrictJsonValue(facts(opened.content), facts(content), { omitUndefinedObjectMembers: true }))
                    return refuse('approval_stale');
                return reviewed;
            }
            if (teardown && context.presentUserConfirmation?.actionId === binding.actionId
                && context.presentUserConfirmation.reviewedDeploymentInput !== undefined) return refuse('approval_stale');
            const created = await atHome(async () => createDeploymentArtifactForHost({ artifacts,
                owner: environment.environment.owner, async assertCurrent() {
                    await assertCandidateCurrent();
                    await assertEnvironmentContentOwnerCurrent({ environmentId: environment.environment.id, context }, environment.environment.owner);
                }, content: { prepareRecipients: true,
                    ...await candidateIdentity(environment.environment.id, context, 'receipt', environment.environment),
                    header: createDeploymentReceiptArtifactHeaderV1(environment.content.name, content),
                    body: JSON.stringify(content), signal: context.signal, beforeWrite: assertCandidateCurrent,
                    authorizationHeaders: candidateArtifactAuthorization(context),
                } }));
            return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                contentBodyVersion: created.revision.bodyVersion };
    };
    const contributedTarget = createContributedDeploymentTargetForHost({ ...host,
        readEnvironment: targetHostReaders.readEnvironment, readReceipt: targetHostReaders.readAnyReceipt,
        readEnvironmentMetadata, readTargetLink,
        readPreparedDeploymentContent, assertCurrent, writeTransition: targetHost.writeTransition,
        createCandidate: createReceiptCandidate,
    });
    const findTeardownReceipt: Parameters<typeof createDataTeardownForHost>[0]['findReceipt'] = async (input, context) => {
        const result = await storage('deployments.receipts.list', {
            serverId: host.serverId, environmentId: input.environmentId, teardownRequestKey: input.requestKey,
        }, context);
        if ('ok' in result && !result.ok && 'errorCode' in result) return refuse(result);
        const selection = DeploymentReceiptListResultV1Schema.parse(result);
        if (!selection.ok) return refuse(selection.error);
        const [found] = selection.items;
        if (!found) return null;
        if (found.targetLinkId !== input.targetLinkId || found.requestKey !== input.requestKey
            || found.environmentId !== input.environmentId || found.operation !== 'teardown') return refuse('deployment_conflict');
        return targetHostReaders.readAnyReceipt({ environmentId: input.environmentId, deploymentId: found.id, context });
    };
    const ownServerTeardown = createOwnServerTeardownForHost({ ...targetHost, sendChild, findReceipt: findTeardownReceipt,
        async *readHistoryHeaders(request) {
            yield* readDeploymentReceiptHistoryHeadersForHost(receiptHistoryPages(request, await historyLineage(request)));
        },
        createCandidate: (environment, content, context) => createReceiptCandidate({ environment, content, context,
            assertCurrent: () => assertCurrent(context) }),
    });
    const dataTeardown = createDataTeardownForHost({ ...host, assertCurrent,
        readEnvironment: targetHostReaders.readEnvironment, readReceipt: targetHostReaders.readAnyReceipt,
        writeTransition: targetHost.writeTransition,
        findReceipt: findTeardownReceipt,
        async readContent(input, context) {
            const artifact = await open(input.contentArtifactId, context);
            if (!artifact) return refuse('deployment_content_unavailable');
            const opened = readDeploymentReceiptArtifactV1({ ...input,
                contentHeaderVersion: artifact.revision.headerVersion, contentBodyVersion: artifact.revision.bodyVersion }, artifact);
            return opened.ok ? opened.content : refuse(failure(opened.error, opened));
        },
        createCandidate: (environment, content, context) => createReceiptCandidate({ environment, content, context,
            assertCurrent: () => assertCurrent(context) }),
    });
    const creationDefaultsHost = (context: ActionExecutorContext): Parameters<typeof prepareDeploymentCreationDefaultsForHost>[1] => ({
        ...host, accountId: readAccountIdFromToken(host.credentials.token) ?? refuseDeploymentAuthorization('local_account_subject_missing'),
        expectedScopeKey: resolveAccountSettingsScopeKey(host.credentials), open, headers,
        async assertCurrent(admittedContext) {
            await assertCurrent(admittedContext);
            if (host.savedSecretOperationContext && (host.savedSecretOperationContext.credentials.token !== host.credentials.token
                || !await host.savedSecretOperationContext.isCurrent(admittedContext.signal))) return refuse('action_forbidden');
        },
        async readAccountSnapshot() {
            if (host.savedSecretOperationContext) return host.savedSecretOperationContext.readSnapshot();
            return bootstrapAccountSettingsContext({ credentials: host.credentials, mode: 'blocking',
                publication: 'invocation', refresh: 'force', honorAccountSettingsModeEnv: false });
        },
    });
    const readCreationDefaultInputs = (request: DeploymentCreationDefaultRequestForHost) => atHome(() =>
        readDeploymentCreationDefaultInputsForHost(request, creationDefaultsHost(request.context)));
    type CreatePreparation = Awaited<ReturnType<NonNullable<ActionExecutorDeps['prepareDeploymentEnvironmentCreate']>>>;
    type NativeCreatePreparation = Readonly<{ input: import('@happier-dev/protocol').DeploymentEnvironmentCreateInputV1;
        preview: import('@happier-dev/protocol/json/strictJsonValue').JsonValue }> | ActionExecuteFailure | Readonly<{ existingNative: Readonly<{
        environmentId: string; revision: number; targetLinkId: string;
    }> }>;
    type CreatePreparationRequest = Readonly<{
        input: DeploymentEnvironmentCreateIntentInputV1; context: ActionExecutorContext;
        creationReview?: import('@happier-dev/protocol').DeploymentEnvironmentCreationReviewV1;
        nativeOrigin?: import('@happier-dev/deployments/contracts/v1').DeploymentNativeComposeOriginV1;
    }>;
    function previewTemplateCreateContinuation(plan: PreviewTemplateCreationPlanForHost,
        prepared: import('@happier-dev/protocol').DeploymentEnvironmentCreateInputV1): HostReviewedChildrenPreparationV1 {
        const children: HostReviewedChildrenPreparationV1['children'][number][] = [];
        if (plan.preparations.length || plan.explicitBindings?.length)
            children.push({ action: 'deployments.bindings.set', role: 'preview.bindings' });
        if (plan.backup) children.push({ action: DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, role: 'preview.backup' });
        return { children,
            executeAdmittedAction: ({ context }) => executePreviewTemplateCreationForHost({ plan, prepared, context }, { ...host, storage }) };
    }
    async function preparePreviewCreateContinuation(preview: import('./prepareEnvironmentCreateForHost').EnvironmentCreatePreviewResolution,
        prepared: import('@happier-dev/protocol').DeploymentEnvironmentCreateInputV1,
        content: import('@happier-dev/deployments/contracts/v1').DeploymentEnvironmentContentV1,
        context: ActionExecutorContext): Promise<HostReviewedChildrenPreparationV1 | undefined> {
        if (preview.fork) {
            const plan = preview.nativeTemplate ?? { name: content.name, definition: content.definition,
                data: [], preparations: [], selections: [] };
            const domain = preview.domain && preview.provenance ? await readPreviewDomainForHost({ serverId: prepared.serverId,
                templateEnvironmentId: preview.provenance.templateEnvironmentId, selection: preview.domain,
                pullRequestNumber: preview.provenance.pullRequestNumber }, {
                    readMetadata: input => storage('deployments.domains.get', input, context),
                    open: artifactId => open(artifactId, context),
                }) : undefined;
            return prepareForkPreviewCreateForHost({ prepared, content, context, bindings: plan.explicitBindings,
                ...(domain ? { domain: { ...domain, domainId: preview.domain!.domainId } } : {}) }, { storage,
                readEnvironment: request => readDeploymentEnvironmentForHost(request, { readMetadata: readEnvironmentMetadata, open, assertCurrent }),
                create: request => executePreviewTemplateCreationForHost({ ...request, plan }, { ...host, storage }),
            });
        }
        return preview.nativeTemplate ? previewTemplateCreateContinuation(preview.nativeTemplate, prepared) : undefined;
    }
    function previewCreateHost(context: ActionExecutorContext) {
        const defaultsHost = atHome(() => creationDefaultsHost(context));
        return { ...host, assertCurrent: defaultsHost.assertCurrent, resolveRequestHeaders: headers,
            readPreviewTemplate: (request: Readonly<{ environmentId: string; context: ActionExecutorContext }>) =>
                readDeploymentEnvironmentForHost(request, { readMetadata: readEnvironmentMetadata, open, assertCurrent }) };
    }
    function prepareEnvironmentCreate(request: CreatePreparationRequest & { nativeOrigin: import('@happier-dev/deployments/contracts/v1').DeploymentNativeComposeOriginV1 }): Promise<NativeCreatePreparation>;
    function prepareEnvironmentCreate(request: CreatePreparationRequest & { nativeOrigin?: undefined }): Promise<CreatePreparation>;
    async function prepareEnvironmentCreate({ input, context, creationReview, nativeOrigin }: CreatePreparationRequest): Promise<CreatePreparation | NativeCreatePreparation> {
        try {
            await requireDefinitionManage(context, 'deployment_access_denied');
            if (input.serverId !== host.serverId) return failure('server_scope_mismatch');
            const reviewedCommitment = creationReview?.definitionCommitment;
            if (input.definition?.from === 'catalogApp') return reviewedCommitment !== undefined
                ? failure('approval_stale') : templates.prepareCreate(input, context, creationReview);
            const defaultsHost = atHome(() => creationDefaultsHost(context));
            const createHost = previewCreateHost(context);
            const preview = await resolveEnvironmentCreatePreviewForHost({ input, context }, createHost);
            if ('errorCode' in preview) return preview;
            const copy = await resolveEnvironmentCreateCopyForHost({ input: preview.input, context }, {
                ...createHost, readMetadata: readEnvironmentMetadata,
                async readDataProvisionDeclaration(source) {
                    const lease = host.acquirePluginRuntimeRegistryLease
                        ? await host.acquirePluginRuntimeRegistryLease() : tryAcquireAuthoritativePluginRuntimeRegistryLease();
                    if (!lease) return null;
                    try {
                        const target = readDeploymentTargetV1(source, lease.registry.contributes.deploymentTargets);
                        if (!target || target.role !== 'data') return null;
                        const reference = target.dataV1?.projects?.provision;
                        const action = reference?.kind === 'plugin' ? parseQualifiedPluginActionId(reference.actionId) : null;
                        const declaration = action ? readResolvedActionContribution(lease.registry.contributes, action) : null;
                        return action && declaration?.definition.inputSchema
                            ? { target, action, inputSchema: declaration.definition.inputSchema } : null;
                    } finally { await lease.release(); }
                },
            });
            if ('errorCode' in copy) return copy;
            const authored = copy.input;
            const defaults = await atHome(() => prepareDeploymentCreationDefaultsForHost({
                projectSourceId: authored.projectSourceId, newProject: authored.newProject, actionId: 'deployments.environments.create', context,
                explicit: { ...(authored.controllerMachineId === undefined ? {} : { controllerMachineId: authored.controllerMachineId }),
                    ...(authored.buildMachineId === undefined ? {} : { buildMachineId: authored.buildMachineId }),
                    ...(authored.retainPreviousDeployments === undefined ? {} : { retainPreviousDeployments: authored.retainPreviousDeployments }) },
                target: { kind: 'ownServer', machines: authored.firstTargetLink?.machines.map(machine => machine.machineId) ?? [] },
            }, defaultsHost));
            if (nativeOrigin) {
                const existing = await findExistingNativeComposeTargetLinkV1({ machineId: host.machineId, origin: nativeOrigin }, {
                    async list(selection, cursor) {
                        const path = '/v1/deployments/targets/list';
                        const body = { serverId: host.serverId, scope: defaults.projectOwner, selection, ...(cursor ? { cursor } : {}) };
                        const requestHeaders = await artifactAuthorization(context)({ method: 'POST', path, body });
                        const response = await axios.request({ method: 'POST', url: new URL(path, host.serverHttpBaseUrl).href,
                            data: body, signal: context.signal, validateStatus: () => true, headers: requestHeaders });
                        // A Home refusal is not a list result; keep its typed authorization reason.
                        if (response.status === 401 || response.status === 403) {
                            return refuse(projectHomeAuthorizationHttpFailure(response.status, requestHeaders, response.data));
                        }
                        return DeploymentTargetLinksListResultV1Schema.parse(response.data);
                    },
                    artifact: targetLink => open(targetLink.contentArtifactId, context),
                });
                if (existing) return { existingNative: { environmentId: existing.environment.id,
                    revision: existing.environment.revision, targetLinkId: existing.targetLink.id } };
            }
            if (defaults.values.controllerMachineId === undefined) return {
                ok: false, errorCode: 'invalid_parameters',
                error: 'Select a controller Machine: pass controllerMachineId or set the Project default.',
                details: { requiredFact: 'controller_machine', remedy: 'pass_controllerMachineId_or_set_project_default',
                    issues: [{ code: 'custom', path: ['controllerMachineId'] }] },
            };
            const planCreate = createEnvironmentCreatePlannerForHost(createHost);
            // The person's compact Apply can cross two signed requests for review.
            // Keep its definition plan stable until the receiving executor admits its effect.
            const deferred = input.mode !== 'preview' && !authored.preview && !nativeOrigin
                && context.surface === 'ui' && !isSharedRequesterActionV1(context)
                && isHomeAdmittedPresentUserHostInvocation(context, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1);
            const { telemetry, ...creationValues } = defaults.values;
            const resolved = { ...authored, ...creationValues };
            const plan = await planCreate({ input: resolved, telemetry, projectOwner: defaults.projectOwner,
                context, copy, nativeOrigin, admittedPreview: preview }, deferred || reviewedCommitment !== undefined);
            if ('errorCode' in plan) return plan;
            if (reviewedCommitment !== undefined && (reviewedCommitment !== plan.definitionCommitment
                || !sameStrictJsonValue(creationReview?.creationDefaultsBasis ?? null, defaults.reviewBasis ?? null)))
                return failure('approval_stale');
            const { controllerMachineId: _controller, buildMachineId: _build, ...otherDefaults } = defaults.values;
            const review = (controllerMachineId: string, buildMachineId: string | undefined, definitionCommitment?: string) =>
                normalizeStrictJsonValue({ creationDefaults: { values: { ...otherDefaults, controllerMachineId,
                    ...(buildMachineId === undefined ? {} : { buildMachineId }) }, sources: defaults.sources },
                    ...(defaults.reviewBasis ? { creationDefaultsBasis: defaults.reviewBasis } : {}),
                    ...(definitionCommitment ? { definitionCommitment } : {}),
                    ...(copy.review ? { copy: copy.review } : {}) });
            if (deferred) {
                if (!plan.definitionCommitment) return failure('invalid_action_output');
                const preview = review(defaults.values.controllerMachineId, resolved.buildMachineId, plan.definitionCommitment);
                return { input: resolved, preview,
                    hostReviewedChildren: { children: copy.copyPlan ? copyEnvironmentChildren(copy.copyPlan) : [],
                    async executeAdmittedAction({ context }) {
                        const prepared = await plan.publish(context);
                        if ('errorCode' in prepared) return prepared;
                        const result = await deps.deploymentAction!(DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, prepared,
                            context, DeploymentEnvironmentCreationReviewV1Schema.parse(preview));
                        if ('errorCode' in result) return result;
                        const created = DeploymentEnvironmentCreateResultV1Schema.parse(result);
                        return created.ok ? { ok: true, result: created } : failure(created.error, created);
                    } } };
            }
            const prepared = await plan.publish(context);
            if ('errorCode' in prepared) return prepared;
            const hostReviewedChildren = await preparePreviewCreateContinuation(preview, prepared, plan.content, context);
            const selected = hostReviewedChildren?.input === undefined ? prepared
                : DeploymentEnvironmentCreateInputV1Schema.parse(hostReviewedChildren.input);
            return { input: selected, ...(hostReviewedChildren ? { hostReviewedChildren } : {}),
                preview: review(selected.controllerMachineId, selected.buildMachineId) };
        } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
    }
    const dispatchReceipt: NonNullable<Parameters<typeof createCliDeploymentActionDeps>[0]['dispatchReceipt']> = async request => {
        let providerTeardownReceipt: DeploymentReceiptDetailV1 | undefined;
        if (request.actionId === 'deployments.teardown') {
            let receipt = await targetHostReaders.readAnyReceipt({ environmentId: request.input.environmentId,
                deploymentId: request.receipt.deploymentId, context: request.context });
            const resumed = await resumeDeploymentTeardownReceiptForHost({ request, receipt, writeTransition: targetHost.writeTransition });
            if (resumed) {
                if (!resumed.ok) return resumed;
                receipt = await targetHostReaders.readAnyReceipt({ environmentId: request.input.environmentId,
                    deploymentId: receipt.deployment.id, context: request.context });
            }
            // Native step proofs are written only after Domain retirement settles.
            // Resume from that recorded progress instead of re-entering its owner.
            if (receipt.deployment.state !== 'succeeded' && receipt.deployment.state !== 'cancelled'
                && !receipt.content.teardown?.proofs.length && receipt.deployment.state !== 'outcome_unknown') {
                request.context.signal?.throwIfAborted();
                const retirement = await domainActions.retireEnvironment({ ...request.input,
                    deploymentId: receipt.deployment.id }, request.context);
                if (retirement) {
                    const details = projectDeploymentFailureRecoveryV1(isRecord(retirement.details) ? retirement.details : {});
                    const domain = details.domainHostname ?? details.domainId;
                    const saved = await targetHost.writeTransition({ environmentId: request.input.environmentId,
                        deploymentId: receipt.deployment.id, receiptHeader: receipt.deployment,
                        expectedRevision: receipt.deployment.revision, state: 'failed', context: request.context,
                        content: { ...receipt.content, failure: { code: retirement.errorCode, phase: 'cleanup',
                            remedy: `Domain ${domain}: ${details.remedy}`,
                            ...(retirement.failureCause ? { failureCause: retirement.failureCause } : {}),
                            ...(retirement.effectAttempted === undefined ? {} : { effectAttempted: retirement.effectAttempted }) } } });
                    return saved.ok ? retirement : { ...retirement,
                        ...(saved.failureCause ? { failureCause: saved.failureCause } : {}) };
                }
            }
            if (DeploymentDataTeardownContentV1Schema.safeParse(receipt.content).success) return dataTeardown.execute(request, receipt);
            if (DeploymentProviderTeardownContentV1Schema.safeParse(receipt.content).success) providerTeardownReceipt = receipt;
        }
        const environment = await readEnvironmentMetadata({ environmentId: request.input.environmentId, context: request.context });
        const link = environment.targetLinks.find(item => item.id === request.input.targetLinkId);
        if (!link) return failure('target_mismatch');
        if (providerTeardownReceipt && link.role === 'data') return dataTeardown.executeProject(request, providerTeardownReceipt, link);
        return link.source.kind === 'plugin' ? contributedTarget.execute(request, {
            environment: environment.environment, link, receipt: providerTeardownReceipt,
        })
            : request.actionId === 'deployments.teardown'
                ? host.teardownBoundary ? injectedTeardown(request) : ownServerTeardown.execute(request)
                : target.execute(request);
    };
    const platformVariables = createPlatformVariablesForHost({ withTargetRole: contributedTarget.withTargetRole,
        readEnvironment: targetHostReaders.readEnvironment });
    const dataRoleBindings = createOwnServerDataRoleBindingsForHost({ ...targetHost, open, sendChild,
        assertCurrent: assertHttpAuthority, ensureServiceObservations: host.ensureServiceObservations });
    const storageDeps = createCliDeploymentActionDeps({ serverHttpBaseUrl: host.serverHttpBaseUrl,
        admitAccount: async (serverId, context) => {
            if (serverId !== host.serverId) return failure('server_scope_mismatch');
            await assertHttpAuthority(context); return null;
        },
        resolveRequestHeaders: headers,
        prepareEnvironment: createPrepareEnvironmentContentForHost({ ...host, accountArtifacts: artifacts, resolveRequestHeaders: headers,
            listEnvironments: (input, context) => storage('deployments.environments.list', input, context) }),
        prepareBindings: createPrepareDeploymentBindingsForHost({ ...host, resolveRequestHeaders: headers, preparePlatformBindings: platformVariables.sync,
            prepareDataRoleBindings: dataRoleBindings.prepare }),
        async admitTeardown(input: DeploymentTeardownInputV1, context: ActionExecutorContext) {
            const dataAdmission = await dataTeardown.admit(input, context);
            if (dataAdmission) return 'errorCode' in dataAdmission ? dataAdmission : null;
            await assertCurrent(context);
            const artifact = await open(input.contentArtifactId, context);
            if (!artifact) return failure('deployment_content_unavailable');
            const initial = artifact.revision.headerVersion === input.contentHeaderVersion
                && artifact.revision.bodyVersion === input.contentBodyVersion;
            const opened = readDeploymentReceiptArtifactV1({ ...input,
                contentHeaderVersion: artifact.revision.headerVersion,
                contentBodyVersion: artifact.revision.bodyVersion }, artifact);
            if (!opened.ok) return failure(opened.error, opened);
            const intent = opened.content.teardown;
            // A changed head is only a retry candidate. Storage must resolve the
            // original requestKey and Artifact identity; new stale references
            // cannot pass storage admission. Execution then reads its pinned ref.
            const environment = await targetHostReaders.readEnvironment({ environmentId: input.environmentId,
                targetLinkId: input.targetLinkId, context });
            const link = environment.targetLinks.find(item => item.targetLink.id === input.targetLinkId)?.targetLink;
            const providerTeardown = link?.source.kind === 'plugin'
                && DeploymentProviderTeardownContentV1Schema.safeParse(opened.content).success;
            const retained = providerTeardown ? null : await findTeardownReceipt(input, context);
            const retainedIntent = retained?.deployment.operation === 'teardown'
                && retained.deployment.contentArtifactId === input.contentArtifactId;
            // Provider receipts have no native completion inventory. Storage
            // resolves their original requestKey without reading native history.
            // Native completion requires the installation-signed transition owner.
            if (initial && intent?.proofs.length && !retainedIntent) return failure('deployment_invalid');
            if (!host.teardownBoundary && !providerTeardown) {
                const denied = await ownServerTeardown.admit(environment, input.targetLinkId, opened.content, input, context, retainedIntent);
                if (denied) return denied;
            }
            if (!intent || !link || intent.reason !== input.reason || intent.targetLinkRevision !== input.expectedTargetLinkRevision
                || !isDeepStrictEqual(intent.machines.map(member => member.machineId), input.machines ?? link.machines)
                || intent.machines.some(member => !link.members.some(current => current.machineId === member.machineId
                    && current.installationId === member.installationId))) return failure('deployment_conflict');
            return null;
        },
        dispatchReceipt,
    });
    async function readRuntimeLinkTarget(source: DeploymentTargetLinkCreateIntentInputV1['source']) {
        const lease = host.acquirePluginRuntimeRegistryLease
            ? await host.acquirePluginRuntimeRegistryLease() : tryAcquireAuthoritativePluginRuntimeRegistryLease();
        if (!lease) return null;
        try { return readDeploymentTargetV1(source, lease.registry.contributes.deploymentTargets); }
        finally { await lease.release(); }
    }
    const failureEnrollment = createPlatformFailureEnrollmentForHost({ ...host,
        readEnvironment: targetHostReaders.readEnvironment });
    const previewEnrollment = createPreviewEnrollmentForHost({ ...host,
        readEnvironment: request => readDeploymentEnvironmentForHost(request, {
            readMetadata: readEnvironmentMetadata, open, assertCurrent,
        }) });
    const storage: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, input, context, creationReview) => {
        const result = await storageDeps.deploymentAction!(actionId, input, context, creationReview);
        if (actionId === 'deployments.targets.link' && 'ok' in result && result.ok && 'targetLinkId' in result) {
            const linked = DeploymentActionOutputSchemasV1['deployments.targets.link'].parse(result);
            const scope = DeploymentActionInputSchemasV1['deployments.targets.link'].parse(input);
            if (linked.ok) return failureEnrollment.completeLink(linked, scope, context);
        }
        if (actionId === 'deployments.environments.update' && 'ok' in result && result.ok) {
            const updated = DeploymentActionOutputSchemasV1[actionId].parse(result);
            if (updated.ok) return previewEnrollment.completeUpdate(updated, DeploymentActionInputSchemasV1[actionId].parse(input), context);
        }
        return result;
    };
    const domainHost: Parameters<typeof createOwnServerDomainActions>[0] = { ...host,
        storage, headers, dispatch: sendChild,
        open: (id, context, effectActionId) => open(id, context, artifactAuthorization(context, effectActionId)),
        readEnvironment: targetHostReaders.readEnvironment, readReceipt: targetHostReaders.readReceipt, readInstallation,
        readTelemetryCollectorPlacement,
        async createContent(content, owner, context) {
            const binding = context.externalActionExecutionAuthorization?.binding;
            const reviewedChild = readHostAdmittedReviewedChildV1(context);
            const native = reviewedChild?.deploymentNativeAdmission ?? binding?.deploymentNativeAdmission;
            if (!binding || !isDeploymentDomainNativeAdmissionV1(native) || !native.authoredMetadataDigest)
                throw createActionExecuteFailureError({ ok: false, errorCode: 'action_forbidden', error: 'action_forbidden' });
            const created = await atHome(() => createDeploymentArtifactForHost({ artifacts, owner, publication: 'create',
                assertCurrent: async () => { context.signal?.throwIfAborted(); },
                content: { artifactId: createDeploymentDomainContentArtifactIdV1({ ...binding, deploymentNativeAdmission: native,
                    ...(reviewedChild ? { reviewedChild } : {}) }),
                    header: { kind: DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1, ...(content.hostname ? { title: content.hostname } : {}) }, body: JSON.stringify(content),
                    signal: context.signal, beforeWrite: async () => { context.signal?.throwIfAborted(); },
                    authorizationHeaders: artifactAuthorization(context, native.actionId) } }));
            return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                contentBodyVersion: created.revision.bodyVersion };
        },
        persistPreparedContent: createOwnServerDomainContentWriter({ serverId: host.serverId,
            serverHttpBaseUrl: host.serverHttpBaseUrl, artifacts, headers }) };
    const prepareContributedDomain = createContributedDomainActionsForHost({ ...domainHost, artifacts, target: contributedTarget });
    const domainDnsActions = createDomainDnsActionsForHost(domainHost);
    const domainActions = createOwnServerDomainActions({ ...domainHost, retireProviderDomain: prepareContributedDomain.retire });
    const readRepositoryWorkspaceRows: CliAdmittedProjectRowsReader = (selection, signal, context, effectActionId) => atHome(() =>
        readProjectAccountRows(context?.externalActionExecutionAuthorization
            ? { authorization: context.externalActionExecutionAuthorization, effectActionId: effectActionId
                ?? context.externalActionExecutionAuthorization.binding.actionId, serverId: host.serverId, selection, signal }
            : { credentials: host.credentials, serverId: host.serverId, selection, signal }));
    const sharedRepositoryWorkspace = { readWorkspaceRows: readRepositoryWorkspaceRows,
        readSource: publicationSources.projectSourcesRead! };
    // Every repository effect of a reviewed composition stays inside its admitted checkout.
    const repositoryFiles = (cwd: string, context: ActionExecutorContext): RepositoryFilesPullRequestHost =>
        createAdmittedCheckoutRepositoryFiles({ root: cwd, context, ...(host.scmRegistry ? { registry: host.scmRegistry } : {}),
            resolveRemovalRuntime: host.resolveRepositoryRemovalRuntime });
    const moveToRepository = createDeploymentMoveToRepositoryForHost({ ...host, assertCurrent, requireDefinitionManage,
        ...sharedRepositoryWorkspace, repositoryFiles,
        // A definition Move consumes only Environment content; Home admits no target-link reads for it.
        readEnvironment: request => readDeploymentEnvironmentForHost(request, { readMetadata: readEnvironmentMetadata, open, assertCurrent }),
        updateSource: publicationSources.projectSourcesUpdate,
        async acceptWorkspace(workspace, source, repository, context) {
            const mutate = createProjectAccountSnapshotMutation(context.externalActionExecutionAuthorization
                ? { authorization: context.externalActionExecutionAuthorization,
                    effectActionId: context.externalActionExecutionAuthorization.binding.actionId, serverId: host.serverId }
                : { credentials: host.credentials, serverId: host.serverId });
            const accepted = await atHome(() => mutate(snapshot => ({ ...snapshot,
                workspaceRefs: materializeWorkspaceRefForMachineRoot(snapshot.workspaceRefs, {
                    serverId: workspace.serverId, machineId: workspace.machineId, rootPath: workspace.rootPath,
                    repositoryIdentity: repository, source: { sourceId: source.id, revision: source.revision },
                    nowMs: workspace.createdAtMs, createId: () => workspace.id,
                }).workspaceRefs,
            }), context.signal));
            if (accepted.status !== 'applied' && accepted.status !== 'unchanged')
                throw createActionExecuteFailureError({ ok: false, errorCode: `project_account_rows_${accepted.status}`, error: `project_account_rows_${accepted.status}` });
        },
        async createContent(content, kind, context, owner, environmentId) {
            const binding = context.externalActionExecutionAuthorization?.binding;
            const created = await atHome(() => createDeploymentArtifactForHost({ artifacts, owner, publication: 'create',
                assertCurrent: async () => { context.signal?.throwIfAborted(); }, content: {
                    ...(binding ? { artifactId: createDeploymentEnvironmentContentArtifactIdV1({ ...binding, environmentId }) } : {}), header: { kind,
                    title: DeploymentEnvironmentContentV1Schema.parse(content).name }, body: JSON.stringify(content),
                    signal: context.signal, beforeWrite: async () => { context.signal?.throwIfAborted(); },
                    authorizationHeaders: artifactAuthorization(context) } }));
            return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                contentBodyVersion: created.revision.bodyVersion };
        } });
    const templates = createDeploymentTemplateInstantiationForHost({ ...host, storage, headers, assertCurrent, readInstallation,
        sharedRepositoryWorkspace, repositoryFiles,
        async deploy(input, context, admittedTemplateSource) {
            const prepared = await deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input, context, admittedTemplateSource });
            if ('errorCode' in prepared) return prepared;
            if ('observePendingOperation' in prepared) {
                const observed = await prepared.observePendingOperation(context);
                return observed.ok ? DeploymentReceiptResultV1Schema.parse(observed.result) : observed;
            }
            if (!context.hostReviewedChild) return failure('credential_scope_denied');
            const deployed = await context.hostReviewedChild.invoke({ action: 'deployments.deploy', role: 'template.deploy',
                input: normalizeStrictJsonValue(prepared.input) });
            return deployed.ok ? DeploymentReceiptResultV1Schema.parse(deployed.result) : deployed;
        },
        readEnvironment: targetHostReaders.readEnvironment,
        readCreationDefaultInputs,
        async createContent(content, kind, context, authority) {
            const created = await atHome(() => createDeploymentArtifactForHost({ artifacts, owner: authority.owner,
                assertCurrent: async () => { context.signal?.throwIfAborted(); }, content: { header: { kind,
                    title: kind === DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 ? DeploymentEnvironmentContentV1Schema.parse(content).name : 'Deployment content' },
                    body: JSON.stringify(content), signal: context.signal, beforeWrite: authority.assertCurrent,
                    authorizationHeaders: artifactAuthorization(context) } }));
            return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                contentBodyVersion: created.revision.bodyVersion };
        } });
    const domainNative = createOwnServerDomainNative({ ...host, open, readEnvironment: targetHostReaders.readEnvironment, readReceipt: targetHostReaders.readReceipt });
    const deploymentChild = createDaemonDeploymentChildExecutor(targetHost, { target, open, storage, assertCurrent, domainNative,
        snapshot: nativeSnapshot.executeChild,
        dataRole: dataRoleBindings.executeChild,
        teardown: ownServerTeardown.executeNative,
        prepareCandidate: (request): Promise<DaemonDeploymentCandidateResult> => deps.prepareDeployCandidate(request) });
    const nativeReads = createOwnServerDeploymentReads({ ...targetHost, readEnvironmentMetadata,
        readRetentionHeaders: targetHostReaders.readRetentionHeaders, assertCurrent: assertHttpAuthority,
        ensureServiceObservations: host.ensureServiceObservations });
    const admitPreview = async (environment: DeploymentEnvironmentDetailV1, context: ActionExecutorContext, sha?: string) => {
        if (environment.environment.purpose !== 'preview') return;
        const admittedRoot = readHostAdmittedReviewedParentV1(context.hostReviewedChild) ?? readHostAdmittedReviewedRootV1(context);
        if (admittedRoot?.actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) {
            await admitForkPreviewDeploymentForHost({ environment, context, sha }, artifactId => open(artifactId, context));
            return;
        }
        const templateEnvironmentId = environment.environment.previewTemplateEnvironmentId;
        if (!templateEnvironmentId) return refuse('deployment_content_unavailable');
        const admission = await admitPreviewEnvironmentForHost({ content: environment.content, templateEnvironmentId }, {
            readTemplate: environmentId => readDeploymentEnvironmentForHost({ environmentId, context }, {
                readMetadata: readEnvironmentMetadata, open, assertCurrent,
            }),
        });
        if (admission.fork) await admitForkPreviewDeploymentForHost({ environment, context, sha }, artifactId => open(artifactId, context));
    };
    const readCompactPending = (input: import('@happier-dev/protocol').DeploymentDeployIntentInputV1,
        context: ActionExecutorContext) => readCompactPendingDeploymentRecovery({ input, context,
        scope: { accountId: context.externalActionExecutionAuthorization?.binding.accountId ?? '', machineId: host.machineId },
        custody: { serverId: host.serverId, installationId: readInstallationIdentityIfExistsSync()?.installationId ?? '' },
        read: () => readEnvironmentMetadata({ environmentId: input.environmentId, context }),
        readResource: artifactId => atHome(() => artifacts.readForUpdate(artifactId, { signal: context.signal,
            prepareRecipients: false, includeSharedAudience: false, authorizationHeaders: artifactAuthorization(context) })),
        assertCurrent: () => assertCurrent(context),
    });
    const hasControllerPreparationAdmission = (context: ActionExecutorContext, environment: DeploymentEnvironmentDetailV1) =>
        readRequesterAccountActionContext(context.externalActionExecutionAuthorization)?.deploymentChild?.kind === 'prepare'
        && context.externalActionExecutionAuthorization?.binding.machineId === environment.environment.controllerMachineId;
    const admitCandidateRequest = async (request: DaemonDeploymentCandidateRequest,
        observedEnvironment?: DeploymentEnvironmentDetailV1): Promise<DeploymentEnvironmentDetailV1 | undefined> => {
        let environment = observedEnvironment;
        if (readRequesterAccountActionContext(request.context.externalActionExecutionAuthorization)?.deploymentChild?.kind === 'prepare') {
            environment ??= await targetHostReaders.readEnvironment(request);
            // Only the Environment controller admitted the requester's source
            // role. Other originating hosts consume the receiver's own grant.
            if (hasControllerPreparationAdmission(request.context, environment)) return environment;
        }
        const role = await definitionRole(request.context);
        if (role === 'use' && (request.sourceIntent !== undefined || request.sha !== undefined
            || request.sourceMethod !== undefined || request.services !== undefined)) return refuse('action_forbidden');
        return environment;
    };
    const prepareAdmittedDeployCandidate = async (originalRequest: DaemonDeploymentCandidateRequest,
        observedEnvironment?: DeploymentEnvironmentDetailV1): Promise<DaemonDeploymentCandidateResult> => {
        try {
            const sourceIntent = originalRequest.sourceIntent ? structuredClone(originalRequest.sourceIntent) : undefined;
            await assertCurrent(originalRequest.context);
            const environment = observedEnvironment ?? await targetHostReaders.readEnvironment(originalRequest);
            // Other originating hosts cannot lend the controller's admission.
            if (!hasControllerPreparationAdmission(originalRequest.context, environment)) {
                requireDeploymentSecretScope(environment);
                await admitPreview(environment, originalRequest.context, originalRequest.sha);
            }
            const targetLinkId = originalRequest.targetLinkId ?? environment.environment.runtimeTargetLinkId;
            if (!targetLinkId) return failure('target_mismatch');
            const request = { ...originalRequest, targetLinkId };
            const selectedLink = environment.targetLinks.find(item => item.targetLink.id === targetLinkId)?.targetLink;
            if (!selectedLink) return failure('target_mismatch');
            if (selectedLink.source.kind === 'plugin') return request.services ? failure('unsupported_action')
                : await contributedTarget.prepareCandidate(request, environment);
            if (request.sourceMethod !== undefined) return failure('unsupported_action');
            const machineResults = await readMemberVersions(request, environment);
            const builder = requireOwnServerDeploymentBuildMachine(environment.environment.buildMachineId);
            const link = environment.targetLinks.find(item => item.targetLink.id === request.targetLinkId)?.targetLink;
            if (!link) return failure('target_mismatch');
            const assertCandidateCurrent = () => assertCurrent(request.context);
            const previewDomain = request.context.invocationServices?.deploymentPreviewDomain
                ?? await preparePreviewDomainFactForHost({ serverId: host.serverId,
                    provenance: environment.content.previewProvenance,
                    sources: environment.content.bindings.map(binding => binding.source) }, {
                    readTemplate: environmentId => targetHostReaders.readEnvironment({ environmentId, context: request.context }),
                    readDomain: input => targetHost.readPreviewDomain!({ ...input, context: request.context }),
                });
            if (builder !== host.machineId) {
                const response = await sendChild(DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'prepare',
                    ...(previewDomain ? { previewDomain } : {}),
                    actionId: 'deployments.deploy', input: { serverId: host.serverId, environmentId: request.environmentId,
                        targetLinkId: request.targetLinkId,
                        ...(sourceIntent ? { sourceIntent } : {}), ...(request.sha ? { sha: request.sha } : {}),
                        ...(request.requestKey ? { requestKey: request.requestKey } : {}),
                        ...(request.onFailure ? { onFailure: request.onFailure } : {}),
                        ...(request.services ? { services: request.services } : {}),
                        ...(request.whenBusy ? { whenBusy: request.whenBusy } : {}) }, machineId: builder,
                    installationId: await readInstallation(builder, request.context), expectedRevision: environment.environment.revision,
                    expectedTargetLinkRevision: link.revision }), request.context);
                if (response && typeof response === 'object' && 'errorCode' in response && typeof response.errorCode === 'string') return failure(response.errorCode, response);
                const candidate = z.strictObject({ ok: z.literal(true), input: DeploymentDeployInputV1Schema,
                    content: DeploymentContentV1Schema }).parse(response);
                await assertCandidateCurrent();
                if (candidate.input.serverId !== host.serverId || candidate.input.environmentId !== request.environmentId
                    || candidate.input.targetLinkId !== link.id || candidate.input.expectedRevision !== environment.environment.revision
                    || candidate.input.expectedTargetLinkRevision !== link.revision || candidate.content.buildMachineId !== builder
                    || !isDeepStrictEqual(candidate.content.previewDomain, previewDomain)
                    || !isDeepStrictEqual(candidate.content.machines, link.machines)
                    || !isDeepStrictEqual(candidate.content.machineResults, machineResults)) return failure('target_mismatch');
                if (sourceIntent && !isDeepStrictEqual(candidate.content.sourceIntent, sourceIntent)
                    || request.sha && (candidate.content.sourceIntent?.kind !== 'repository' || candidate.content.sourceIntent.sha !== request.sha)
                    || request.requestKey && candidate.input.requestKey !== request.requestKey
                    || (candidate.input.onFailure ?? DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE) !== (request.onFailure ?? DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE)
                    || candidate.content.onFailure !== (request.onFailure ?? DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE)
                    || !isDeepStrictEqual(candidate.input.services, request.services)
                    || !isDeepStrictEqual(candidate.content.services, request.services)
                    || (candidate.input.whenBusy ?? 'refuse') !== (request.whenBusy ?? 'refuse')) return failure('target_mismatch');
                const opened = readDeploymentReceiptArtifactV1(candidate.input, await open(candidate.input.contentArtifactId,
                    request.context, candidateArtifactAuthorization(request.context)));
                if (!opened.ok) return failure(opened.error, opened);
                if (!isDeepStrictEqual(opened.content, candidate.content)) return failure('target_mismatch');
                return candidate;
            }
            const staging: { artifact?: Awaited<ReturnType<typeof artifacts.create>> } = {};
            const candidateContext = previewDomain ? { ...request.context, invocationServices: {
                ...request.context.invocationServices, deploymentPreviewDomain: previewDomain } } : request.context;
            const content = await prepareOwnServerDeploymentCandidate({ ...request, context: candidateContext, sourceIntent, environment, runtime: host.runtime,
                machineId: host.machineId, machineResults, readReferenceEnvironment: targetHostReaders.readEnvironment,
                readPreviewDomain: targetHost.readPreviewDomain,
                async stageContent(sourceIntent) {
                    const initial = DeploymentContentV1Schema.parse({ sourceIntent, machines: link.machines,
                        ...(previewDomain ? { previewDomain } : {}),
                        ...(request.services ? { services: request.services } : {}),
                        buildMachineId: builder, ...(environment.content.ingress ? { ingress: environment.content.ingress } : {}),
                        onFailure: request.onFailure ?? DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE, images: [], machineResults, steps: [] });
                    const created = await atHome(async () => createDeploymentArtifactForHost({ artifacts,
                        owner: environment.environment.owner,
                        assertCurrent: assertCandidateCurrent, content: { prepareRecipients: true,
                        ...await candidateIdentity(request.environmentId, request.context, 'receipt', environment.environment,
                            request.admittedTemplateSource ?? (sourceIntent.kind === 'repository'
                                ? { id: sourceIntent.projectSourceId, revision: sourceIntent.sourceRevision } : undefined)),
                        header: createDeploymentReceiptArtifactHeaderV1(environment.content.name, initial),
                        body: JSON.stringify(initial), signal: request.context.signal,
                        beforeWrite: assertCandidateCurrent, authorizationHeaders: candidateArtifactAuthorization(request.context),
                    } }));
                    staging.artifact = created;
                    return created.artifactId;
                } });
            await assertCandidateCurrent();
            const staged = staging.artifact;
            if (!staged) return failure('deployment_content_unavailable');
            const updated = await atHome(() => artifacts.update({ artifactId: staged.artifactId, expectedRevision: staged.revision,
                header: createDeploymentReceiptArtifactHeaderV1(environment.content.name, content), body: JSON.stringify(content),
                signal: request.context.signal, beforeWrite: assertCandidateCurrent,
                authorizationHeaders: candidateArtifactAuthorization(request.context) }));
            if (!updated.ok) return failure(updated.errorCode);
            return { ok: true, content, input: DeploymentDeployInputV1Schema.parse({ serverId: host.serverId,
                environmentId: request.environmentId, targetLinkId: request.targetLinkId,
                expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
                requestKey: request.requestKey ?? randomUUID(), ...(request.whenBusy ? { whenBusy: request.whenBusy } : {}),
                ...(request.onFailure ? { onFailure: request.onFailure } : {}),
                ...(request.services ? { services: request.services } : {}),
                contentArtifactId: staged.artifactId,
                contentHeaderVersion: updated.revision.headerVersion, contentBodyVersion: updated.revision.bodyVersion }) };
        } catch (error) { return failure(errorCode(error), error); }
    };
    // Both finite consumers use the saved-observation owner; readiness lends its already admitted Environment.
    const readCurrentHealth = async (request: z.infer<(typeof DeploymentActionInputSchemasV1)['deployments.health.current']>,
        context: ActionExecutorContext, admitted?: Readonly<{ environment: DeploymentEnvironmentDetailV1['environment'];
            targetLinks: readonly DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink'][];
            current?: CurrentDomainEdgeObservation;
            source?: Parameters<CurrentDomainEdgeObservation['readDomainProofs']>[3] }>) => {
    let lease: ReturnType<typeof tryAcquireAuthoritativePluginRuntimeRegistryLease> = null;
    try {
        await assertHttpAuthority(context);
        if (request.serverId !== host.serverId || request.machineId !== host.machineId) return failure('target_mismatch');
        const detail = admitted ?? await readEnvironmentMetadata({ environmentId: request.environmentId, context });
        const environment = detail.environment;
        const placement = readDeploymentHealthCurrentPlacementFailure(request, environment, detail.targetLinks);
        if (placement) return placement;
        const link = detail.targetLinks.find(item => item.id === request.targetLinkId);
        if (!link) return failure('target_mismatch');
        if (!admitted?.current) lease = host.acquirePluginRuntimeRegistryLease
            ? await host.acquirePluginRuntimeRegistryLease() : tryAcquireAuthoritativePluginRuntimeRegistryLease();
        const current = admitted?.current ?? lease?.registry.currentDomainEdgeObservation;
        if (request.domainIds !== undefined) {
            const readAt = Date.now();
            const domainHealth = [];
            let observation = null;
            const proof = current?.readProof(environment.id, link.id);
            for (const domainId of new Set(request.domainIds)) {
                const loaded = await storage('deployments.domains.get', { serverId: host.serverId,
                    environmentId: environment.id, domainId }, context);
                if ('errorCode' in loaded) { current?.withdrawDomain(environment.id, domainId); return loaded; }
                const detail = DeploymentDomainMutationResultV1Schema.parse(loaded);
                if (!detail.ok) {
                    current?.withdrawDomain(environment.id, domainId);
                    if (detail.error === 'deployment_unavailable') continue;
                    return failure(detail.error);
                }
                const domain = detail.domain;
                if (detail.environmentId !== environment.id || domain.id !== domainId
                    || domain.environmentId !== environment.id || domain.targetLinkId !== link.id
                    || domain.deletedAtMs !== undefined) {
                    current?.withdrawDomain(environment.id, domainId);
                    continue;
                }
                // The retained check owner decides provenance; this read
                // matches its evidence to the current Home metadata.
                const retained = current?.readDomainProofs(environment.id, link.id, [domainId], admitted?.source).filter(entry =>
                    entry.domainObservation.domainRevision === domain.revision
                    && entry.domainObservation.targetLinkRevision === link.revision
                    && entry.domainObservation.observerMachineId === environment.controllerMachineId
                    && entry.domainObservation.vantage === deploymentDomainProbeVantageV1(
                        environment, link, entry.domainObservation.observerMachineId)) ?? [];
                const observations = retained.map(entry => entry.domainObservation);
                const tlsKind = retained.find(entry => entry.domainObservation.kind === 'certificate')?.tlsKind;
                domainHealth.push({ domainId, domainRevision: domain.revision, observations,
                    facts: projectDeploymentDomainHealthFactsV1(domain,
                        { ...(tlsKind === undefined ? {} : { tls: { kind: tlsKind } }) },
                        observations, current ? null : 'source_unavailable', readAt) });
                if (proof && retained.includes(proof) && environment.ingress?.kind === 'edgeCaddy'
                    && proof.observation.machineId === environment.ingress.edgeMachineId) observation = proof.observation;
            }
            await assertHttpAuthority(context);
            return DeploymentActionOutputSchemasV1['deployments.health.current'].parse({ ok: true,
                environmentId: environment.id, targetLinkId: link.id, observation, domainHealth });
        }
        const proof = current?.readProof(environment.id, link.id);
        let observation = proof?.observation ?? null;
        if (proof && (environment.ingress?.kind !== 'edgeCaddy'
            || proof.observation.machineId !== environment.ingress.edgeMachineId
            || proof.observation.targetLinkRevision !== link.revision)) observation = null;
        if (proof && observation) {
            const loaded = await storage('deployments.domains.get', { serverId: host.serverId,
                environmentId: environment.id, domainId: proof.domainId }, context);
            if ('errorCode' in loaded) { current?.withdrawDomain(environment.id, proof.domainId); return loaded; }
            const domain = DeploymentDomainMutationResultV1Schema.parse(loaded);
            if (!domain.ok) {
                if (domain.error !== 'deployment_unavailable') {
                    current?.withdrawDomain(environment.id, proof.domainId);
                    return failure(domain.error);
                }
                observation = null;
            } else if (domain.domain.id !== proof.domainId || domain.domain.environmentId !== environment.id
                || domain.domain.targetLinkId !== link.id || domain.domain.revision !== proof.domainRevision
                || domain.domain.deletedAtMs !== undefined) observation = null;
        }
        if (!observation && proof) current?.withdrawDomain(environment.id, proof.domainId);
        await assertHttpAuthority(context);
        return DeploymentActionOutputSchemasV1['deployments.health.current'].parse({ ok: true,
            environmentId: environment.id, targetLinkId: link.id, observation });
    } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
    finally { await lease?.release(); }
    };
    const deploymentRestore = createDeploymentRestoreActionForHost({ ...host, assertCurrent,
        readPreparation: host.readOperation, restore: target.restore, nativeSnapshot,
        async checkData(request, input, context) {
            const environment = await targetHostReaders.readEnvironment({ environmentId: input.environmentId,
                targetLinkId: input.targetLinkId, context });
            return executeOwnServerDatabaseOperationForHost({ host: { ...host, assertCurrent,
                readEnvironment: targetHostReaders.readEnvironment, readReceipt: targetHostReaders.readAnyReceipt },
                environment, installationId: input.installationId, request, context,
                signal: context.signal ?? new AbortController().signal, operationId: context.operationAcceptance!.operationId });
        } });
    const deploymentBackupConfigure = createDeploymentBackupConfigureForHost({ ...host, artifacts, assertCurrent,
        resolveRequestHeaders: headers,
        readEnvironment: request => readDeploymentEnvironmentForHost(request, { readMetadata: readEnvironmentMetadata, open, assertCurrent }),
        async resolveCreationDefaults(environment, explicit, context) {
            const defaults = await atHome(() => prepareDeploymentCreationDefaultsForHost({
                projectSourceId: environment.environment.projectSourceId, actionId: DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1,
                context, explicit, target: { kind: 'ownServer', machines: environment.targetLinks.flatMap(link => link.members.map(member => member.machineId)) },
            }, creationDefaultsHost(context)));
            return { values: defaults.values, sources: defaults.sources };
        },
    });
    const deploymentTelemetrySet = createEnvironmentTelemetrySetForHost({ ...host,
        readEnvironment: request => readDeploymentEnvironmentForHost(request, { readMetadata: readEnvironmentMetadata, open, assertCurrent }),
        async readProject(environment, context, readDefault) {
            const source = await publicationSources.projectSourcesRead!({ serverId: host.serverId, sourceId: environment.environment.projectSourceId }, context);
            if (!source.ok) return refuse('errorCode' in source ? source.errorCode : source.error);
            const defaults = readDefault ? await readCreationDefaultInputs({ projectSourceId: source.source.id,
                sourceRevision: source.source.revision, projectOwner: source.source.owner ?? { kind: 'account', accountId: source.source.createdByAccountId },
                actionId: DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1, context }) : undefined;
            const telemetryMachineId = defaults?.projectDefaults?.deploymentDefaults.telemetryMachineId;
            return { name: source.source.name, ...(telemetryMachineId ? { telemetryMachineId } : {}) };
        },
        readMachine: (machineId, context) => atHome(() => context.externalActionExecutionAuthorization
            ? ApiClient.getRequesterMachine(machineId, { authorization: context.externalActionExecutionAuthorization, signal: context.signal,
                effectActionId: DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1 })
            : ApiClient.create(host.credentials).then(api => api.getMachine(machineId, { signal: context.signal }))),
    });
    const deps = {
        deploymentTelemetrySet,
        deploymentChild,
        deploymentBackupAction: createDeploymentBackupActionForHost({ ...host, assertCurrent, backup: target.backup }),
        projectReadinessRead: (async (input, context, executeCanonicalAction) => {
            try {
                if (input.serverId !== host.serverId || input.machineId !== host.machineId) return {
                    ...failure('target_mismatch'), details: { step: 'admission', code: 'target_mismatch' },
                };
                return await createProjectReadinessActionForHost({
                    async readProjectSources(scope, currentContext) {
                        const read = await publicationSources.projectSourcesRead!({ serverId: scope.serverId,
                            sourceId: scope.projectId }, currentContext);
                        if (!read.ok) {
                            const reason = 'errorCode' in read ? read.errorCode : read.error;
                            return { ci: { status: 'unavailable', reason }, security: { status: 'unavailable', reason } };
                        }
                        return readScmHostingProjectReadinessForHost({ repository: read.source.repository, context: currentContext,
                            acquireRuntimeRegistryLease: host.acquirePluginRuntimeRegistryLease,
                            executeSourceReadAction: host.executeSourceReadAction });
                    },
                    async readEnvironment(scope, currentContext) {
                        const detail = await targetHostReaders.readEnvironment({ environmentId: scope.environment.environmentId,
                            context: currentContext });
                        return projectReadinessEnvironmentFactForHost(scope, input.machineId, detail);
                    },
                    async readHealthAndAlerts(environments, currentContext) {
                        const signal = currentContext.signal ?? new AbortController().signal;
                        const execute = async (actionId: Parameters<typeof executeCanonicalAction>[0], selected: unknown) => {
                            const result = await executeCanonicalAction(actionId, selected);
                            if (!result.ok) throw createActionExecuteFailureError({ ok: false, errorCode: result.errorCode, error: result.errorCode });
                            return result.result;
                        };
                        const sources = await readSavedHealthCheckSourcesForHost({ sourceInstanceIds: environments.map(({ scope }) =>
                            createHealthCheckSourceInstanceIdV1({ kind: 'environment', environmentId: scope.environment.environmentId })), signal }, {
                            list: query => execute('workflow.trigger.list', query),
                        });
                        // This borrowed promise ends with this finite read; destination inspection remains provider-owned.
                        let channelsRead: ReturnType<typeof notificationCatalog.readChannels> | undefined;
                        return await Promise.all(environments.map(async ({ scope, environment: admitted }) => {
                            const subject = { kind: 'environment' as const, environmentId: scope.environment.environmentId };
                            const sourceInstanceId = createHealthCheckSourceInstanceIdV1(subject);
                            const source = sources.get(sourceInstanceId)!;
                            const detail = admitted.detail;
                            const observerMachineId = source.kind === 'available' ? source.observer?.machineId ?? null : null;
                            const controllerOnline = detail.controller?.state === 'available' ? true
                                : detail.controller?.state === 'paused' ? false : null;
                            const observerOnline = observerMachineId === detail.controller?.machineId ? controllerOnline : null;
                            const unavailable = (reason: string) => ({ status: 'unavailable' as const, reason });
                            const bothUnavailable = (reason: string) => ({ health: unavailable(reason), alerts: unavailable(reason) });
                            if (source.kind === 'available' && !isDeepStrictEqual(source.source.subject, subject)) {
                                return bothUnavailable('health_check_source_mismatch');
                            }
                            let lease: PluginRuntimeRegistryLease | null = null;
                            try {
                                if (source.kind === 'available' && source.enabled && source.observer) {
                                    lease = host.acquirePluginRuntimeRegistryLease
                                        ? await host.acquirePluginRuntimeRegistryLease() : tryAcquireAuthoritativePluginRuntimeRegistryLease();
                                    const adopted = lease?.registry.readHealthCheckSource?.(sourceInstanceId, signal);
                                    if (!adopted || adopted.kind !== 'available') return bothUnavailable(adopted?.reason ?? 'source_unavailable');
                                    if (!isDeepStrictEqual(adopted.source, source.source)) return bothUnavailable('source_unavailable');
                                }
                                const readCoverage = async () => {
                                    if (source.kind !== 'available' || !source.enabled || !source.observer) {
                                        return readHealthCheckReadiness({ source, observerMachineId, observerOnline, domains: [] });
                                    }
                                    try {
                                        const domains: DeploymentDomainHeaderV1[] = [];
                                        let cursor: string | undefined;
                                        do {
                                            const raw = await storage('deployments.domains.list', { serverId: scope.serverId,
                                                environmentId: subject.environmentId, ...(cursor ? { cursor } : {}) }, currentContext);
                                            if ('errorCode' in raw) return unavailable(raw.errorCode);
                                            const page = DeploymentActionOutputSchemasV1['deployments.domains.list'].parse(raw);
                                            if (!page.ok) return unavailable(page.error);
                                            domains.push(...page.domains.filter(domain => domain.deletedAtMs === undefined
                                                && (domain.state === 'active' || domain.state === 'warning')));
                                            cursor = page.nextCursor ?? undefined;
                                        } while (cursor);
                                        const link = detail.targetLinks.find(item => item.targetLink.id === detail.environment.runtimeTargetLinkId)?.targetLink;
                                        if (!domains.length) return readHealthCheckReadiness({ source, observerMachineId, observerOnline, domains });
                                        if (!link) return unavailable('health_target_unavailable');
                                        const current = await readCurrentHealth({ serverId: scope.serverId, machineId: host.machineId,
                                            environmentId: subject.environmentId, targetLinkId: link.id, domainIds: domains.map(domain => domain.id) },
                                        currentContext, { environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
                                            current: lease?.registry.currentDomainEdgeObservation,
                                            source: { sourceInstanceId, observerMachineId: source.observer.machineId, checks: source.source.checks } });
                                        return readHealthCheckReadiness({ source, observerMachineId, observerOnline, domains,
                                            ...('errorCode' in current ? {} : { current }) });
                                    } catch (error) {
                                        if (currentContext.signal?.aborted) throw error;
                                        return unavailable(errorCode(error));
                                    }
                                };
                                const readAlerts = async () => {
                                    try {
                                        const alertInput = { source, controllerMachineId: detail.environment.controllerMachineId,
                                            controllerOnline, observerMachineId, observerOnline };
                                        const configured = readHealthAlertReadiness({ ...alertInput, destinations: [] });
                                        // The alert owner settles paused, off and unassigned setups before provider reads.
                                        if (configured.reason !== 'health_alert_destination_unavailable') return configured;
                                        // The Account catalog is read once; each provider decides its own saved destination.
                                        const channels = source.kind === 'available' && source.enabled && source.source.alerts?.channels.length
                                            ? await (channelsRead ??= notificationCatalog.readChannels(currentContext, { maintainSource: false })) : { items: [] };
                                        if ('errorCode' in channels) return unavailable(channels.errorCode);
                                        const destinations = await Promise.all((source.kind === 'available' ? source.source.alerts?.channels ?? [] : [])
                                            .map(channel => readSavedHealthAlertDestinationAvailabilityForHost({ channel, signal: currentContext.signal }, {
                                                notificationChannelsList: async () => channels.items,
                                                executeSetup: (action, selected) => execute('action.invoke', { action, input: selected }),
                                            })));
                                        return readHealthAlertReadiness({ ...alertInput, destinations });
                                    } catch (error) {
                                        if (currentContext.signal?.aborted) throw error;
                                        return unavailable(errorCode(error));
                                    }
                                };
                                const [health, alerts] = await Promise.all([readCoverage(), readAlerts()]);
                                return { health, alerts };
                            } catch (error) {
                                if (signal.aborted) throw error;
                                return bothUnavailable(errorCode(error));
                            } finally { await lease?.release(); }
                        }));
                    },
                    readRecordedBackups: createDeploymentBackupRecordedHealthForHost(host),
                })(input, context);
            } catch (error) {
                const code = context.signal?.aborted ? 'cancelled' : errorCode(error);
                const result = failure(code, error);
                return { ...result, details: {
                    ...(result.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details : {}),
                    step: 'readiness', code,
                } };
            }
        }) satisfies NonNullable<ActionExecutorDeps['projectReadinessRead']>,
        deploymentRestore,
        prepareDeploymentRestore: deploymentRestore.prepare,
        async prepareDeploymentTeardown(request: Parameters<NonNullable<ActionExecutorDeps['prepareDeploymentTeardown']>>[0]) {
            if ('detachKeepRunning' in request.input) return { input: request.input, preview: deploymentTeardownDetachPreview };
            if ('dataCreation' in request.input || 'contentArtifactId' in request.input) return dataTeardown.prepare(request);
            try {
                if (request.input.serverId !== host.serverId) return failure('server_scope_mismatch');
                const environment = await targetHostReaders.readEnvironment({ environmentId: request.input.environmentId,
                    targetLinkId: request.input.targetLinkId, context: request.context });
                const targetLinkId = request.input.targetLinkId ?? environment.environment.runtimeTargetLinkId;
                if (targetLinkId) {
                    const data = await dataTeardown.prepareProject({ ...request, input: { ...request.input, targetLinkId } }, environment);
                    if (data) return data;
                    const contributed = await contributedTarget.prepareTeardown({ ...request.input,
                        environmentId: request.input.environmentId, targetLinkId, context: request.context }, environment);
                    if (contributed) return contributed;
                }
                return await ownServerTeardown.prepare(request, environment);
            } catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
        },
        async prepareHostReviewedChildren(request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0]) {
            if (request.actionId === DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1) return { children: [
                { action: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, role: DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1 },
            ] };
            if (request.actionId === 'deployments.bindings.set' || request.actionId === 'deployments.observation.get') {
                try {
                    if (request.actionId === 'deployments.bindings.set') {
                        const input = DeploymentActionInputSchemasV1[request.actionId].parse(request.input);
                        return await platformVariables.prepareBindingsChildren({ input, context: request.context });
                    }
                    const input = DeploymentActionInputSchemasV1[request.actionId].parse(request.input);
                    return await platformVariables.prepareRead({ input, context: request.context });
                } catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (request.actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1) {
                const input = DeploymentBackupConfigureInputV1Schema.safeParse(request.input);
                if (!input.success) return failure('invalid_parameters');
                if (input.data.intent === 'markNotNeeded') return null;
                const destinationSetup = 'destinationSetup' in input.data ? input.data.destinationSetup : undefined;
                const setup = destinationSetup ? prepareBackupAnotherMachineChildrenForHost({
                    serverId: input.data.serverId, setup: destinationSetup }) : null;
                const hasBindings = input.data.intent === 'rekeyAndSave'
                    || ('backupBindings' in input.data && Boolean(input.data.backupBindings?.length));
                const children = [...(setup?.children ?? []),
                    ...(hasBindings || destinationSetup ? [{ action: 'deployments.bindings.set' as const,
                        role: 'backup.bindings' }] : [])];
                return children.length ? { children } : null;
            }
            if (request.actionId === 'deployments.environments.moveToRepository') {
                const input = DeploymentActionInputSchemasV1[request.actionId].safeParse(request.input);
                return input.success ? deploymentMoveToRepositoryReviewedChildrenV1(input.data) : failure('invalid_parameters');
            }
            if (isDeploymentMembershipActionIdV1(request.actionId) && request.actionId !== DEPLOYMENT_TEARDOWN_ACTION_ID_V1) {
                const input = DeploymentActionInputSchemasV1[request.actionId].parse(request.input);
                if (!('targetLinkId' in input)) return null;
                try { return await prepareOwnServerMembershipDomainReviewedChildren(input, request.context,
                    { serverId: host.serverId, storage, open, dispatch: sendChild,
                        readEnvironment: targetHostReaders.readEnvironment, readReceipt: targetHostReaders.readReceipt, readInstallation }); }
                catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (request.actionId === 'machines.services.adopt') return prepareServiceAdoptionForHost(request, {
                ...host, prepareCreate: prepareEnvironmentCreate,
                readInstallation: context => readInstallation(host.machineId, context),
                readEnvironment: request => readDeploymentEnvironmentForHost(request, {
                    readMetadata: readEnvironmentMetadata, open, assertCurrent,
                }),
            });
            if (request.actionId === 'deployments.targets.link') {
                const input = DeploymentActionInputSchemasV1['deployments.targets.link'].safeParse(request.input);
                if (!input.success) return failure('invalid_parameters');
                const enrollment = await failureEnrollment.prepare(input.data, request.context);
                if (!('providerCreate' in input.data)) return enrollment;
                const creation = prepareRuntimeTargetCreateForHost(input.data, await readRuntimeLinkTarget(input.data.source));
                return { ...creation, children: [...creation.children, ...(enrollment?.children ?? [])] };
            }
            if (request.actionId === 'deployments.environments.update') {
                const input = DeploymentActionInputSchemasV1[request.actionId].safeParse(request.input);
                return input.success ? previewEnrollment.prepare(input.data, request.context) : failure('invalid_parameters');
            }
            if (request.actionId === 'deployments.receipts.observe') {
                const input = DeploymentActionInputSchemasV1['deployments.receipts.observe'].safeParse(request.input);
                return input.success ? contributedTarget.prepareObservation({ input: input.data, context: request.context })
                    : failure('invalid_parameters');
            }
            if (request.actionId === 'deployments.logs.read') {
                const input = DeploymentActionInputSchemasV1['deployments.logs.read'].safeParse(request.input);
                if (!input.success) return failure('invalid_parameters');
                if (input.data.targetLinkId === undefined) {
                    return contributedTarget.prepareLogs({ input: input.data, context: request.context });
                }
                try {
                    // Native runtime log recovery uses public placement without opening Account content.
                    const metadata = await readEnvironmentMetadata({ environmentId: input.data.environmentId, context: request.context });
                    const link = metadata.targetLinks.find(link => link.id === input.data.targetLinkId);
                    if (!link) return failure('target_mismatch');
                    return link.source.kind === 'plugin' ? contributedTarget.prepareLogs({ input: input.data, context: request.context }, metadata) : null;
                } catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (isDeploymentDomainDnsActionIdV1(request.actionId)) {
                try { return await domainDnsActions(request); }
                catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (isDeploymentDomainChildActionIdV1(request.actionId)) {
                try { return await prepareContributedDomain(request, observed => prepareOwnServerDomainReviewedChildren(request, {
                    storage, open, dispatch: sendChild, readEnvironment: targetHostReaders.readEnvironment,
                    readReceipt: targetHostReaders.readReceipt, readInstallation, readTelemetryCollectorPlacement,
                    reviewNativeSetup: sendChild,
                }, observed)); }
                catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (request.actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) {
                // Existing Environment upgrades also enroll retained Domains during their reviewed deploy child.
                const input = DeploymentTemplateInstantiateInputV1Schema.parse(request.input);
                if (input.mode !== 'apply' || input.environment.kind !== 'existing' || input.target.kind !== 'existing' || !input.deploy) return null;
                try { return await prepareOwnServerMembershipDomainReviewedChildren({
                    environmentId: input.environment.environmentId, targetLinkId: input.target.targetLinkId,
                    requestKey: input.deploy.requestKey }, request.context,
                    { serverId: host.serverId, storage, open, dispatch: sendChild,
                        readEnvironment: targetHostReaders.readEnvironment, readReceipt: targetHostReaders.readReceipt, readInstallation }); }
                catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (request.actionId === 'deployments.environments.create') {
                const copy = DeploymentEnvironmentCreateInputV1Schema.safeParse(request.input);
                if (copy.success && copy.data.preview) {
                    try {
                        const prepared = copy.data;
                        const opened = readDeploymentEnvironmentArtifactV1(prepared, await open(prepared.contentArtifactId, request.context));
                        if (!opened.ok) return failure(opened.error, opened);
                        // Approved replay reconstructs the same invocation-local template continuation.
                        const previewHost = previewCreateHost(request.context);
                        let previewDefinition = opened.content.definition;
                        if (prepared.previewCompanionOfEnvironmentId) {
                            const main = await readDeploymentEnvironmentForHost({
                                environmentId: prepared.previewCompanionOfEnvironmentId, context: request.context },
                            { readMetadata: readEnvironmentMetadata, open, assertCurrent });
                            previewDefinition = main.content.definition;
                            const readTemplate = previewHost.readPreviewTemplate;
                            previewHost.readPreviewTemplate = templateRequest => templateRequest.environmentId === main.environment.id
                                ? Promise.resolve(main) : readTemplate(templateRequest);
                        }
                        if (opened.content.previewProvenance && previewDefinition.kind === 'repository') {
                            const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: prepared.serverId,
                                projectSourceId: prepared.projectSourceId, newProject: prepared.newProject, requestKey: prepared.requestKey,
                                protection: prepared.protection, purpose: prepared.purpose, deployerMode: prepared.deployerMode,
                                ...(prepared.previewCompanionOfEnvironmentId === undefined ? {} : {
                                    previewCompanionOfEnvironmentId: prepared.previewCompanionOfEnvironmentId }),
                                preview: { ...prepared.preview, provenance: opened.content.previewProvenance,
                                    headSha: previewDefinition.ref } });
                            const preview = await resolveEnvironmentCreatePreviewForHost({ input, context: request.context }, previewHost);
                            if ('errorCode' in preview) return preview;
                            return await preparePreviewCreateContinuation(preview, prepared, opened.content, request.context) ?? null;
                        }
                    } catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
                }
                if (!copy.success || !copy.data.copyPlan) return null;
                const children = copyEnvironmentChildren(copy.data.copyPlan);
                return children.length ? { children } : null;
            }
            if (request.actionId !== DEPLOYMENT_TEARDOWN_ACTION_ID_V1) return null;
            // The Action owner classifies volume inventory as a preview. It has
            // no destructive child effects or prepared receipt to review.
            if (getActionSpec(request.actionId).safetyForInput?.(request.input) === 'safe') return null;
            try {
                const input = DeploymentTeardownPreparedInputV1Schema.parse(request.input);
                if (input.serverId !== host.serverId) return failure('server_scope_mismatch');
                if ('detachKeepRunning' in input || 'nothingDeployed' in input) return null;
                const environment = await targetHostReaders.readEnvironment({ environmentId: input.environmentId, targetLinkId: input.targetLinkId, context: request.context });
                const link = environment.targetLinks.find(row => row.targetLink.id === input.targetLinkId)?.targetLink;
                if (!link) return failure('target_mismatch');
                // Data cleanup already declared its retained child; Domain effects join the same parent review.
                const targetPlan = link.role !== 'data' && link.source.kind === 'plugin'
                    ? await contributedTarget.prepareTeardownChildren({ environmentId: input.environmentId,
                        targetLinkId: input.targetLinkId, context: request.context }, environment) : null;
                if (targetPlan && 'errorCode' in targetPlan) return targetPlan;
                const domainPlan = await prepareOwnServerTeardownDomainReviewedChildren({ ...request, input }, { serverId: host.serverId,
                    storage, open, dispatch: sendChild, readEnvironment: targetHostReaders.readEnvironment, readReceipt: targetHostReaders.readReceipt, readInstallation,
                    prepareProviderDomain: prepareContributedDomain });
                if (domainPlan && 'errorCode' in domainPlan) return domainPlan;
                const children = [...(targetPlan?.children ?? []), ...(domainPlan?.children ?? [])];
                return children.length ? { children } : null;
            } catch (error) { return failure(request.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
        },
        deploymentAction: (async (actionId, input, context, creationReview = undefined) => {
            if (actionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1 && 'backupPolicy' in input && input.backupPolicy !== undefined) {
                const selected = DeploymentActionInputSchemasV1[DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1].safeParse(input);
                if (!selected.success) return failure('invalid_parameters');
                if (selected.data.serverId !== host.serverId) return failure('server_scope_mismatch');
                try {
                    const { content: _content, ...detail } = await readDeploymentEnvironmentForHost({ ...selected.data, context }, {
                        readMetadata: readEnvironmentMetadata, open, assertCurrent,
                    });
                    return DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, ...detail });
                } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1) {
                const selected = DeploymentBackupConfigureInputV1Schema.safeParse(input);
                return selected.success ? deploymentBackupConfigure(selected.data, context) : failure('invalid_parameters');
            }
            if (actionId === 'deployments.receipts.get') {
                const selected = DeploymentActionInputSchemasV1[actionId].safeParse(input);
                if (!selected.success) return failure('invalid_parameters');
                const { projection, ...requested } = selected.data;
                // A receipt read by its own id reads within the Environment Home bound at issuance.
                const boundEnvironmentId = context.externalActionExecutionAuthorization?.binding.environmentId;
                const address = requested.environmentId === undefined && boundEnvironmentId !== undefined
                    ? { ...requested, environmentId: boundEnvironmentId } : requested;
                try {
                    const result = await storage(actionId, address, context);
                    if ('ok' in result && !result.ok && 'errorCode' in result) return result;
                    const detail = DeploymentReceiptGetResultV1Schema.parse(result);
                    if (!detail.ok || projection === undefined && (detail.deployment.state === 'queued'
                        || detail.deployment.state === 'succeeded' || detail.deployment.state === 'running_unverified')) return detail;
                    return await readDeploymentReceiptActionFactsV1(detail, { ...address, projection },
                        deployment => openReceipt(deployment, context));
                } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (actionId === 'deployments.observation.get') {
                const selected = DeploymentActionInputSchemasV1[actionId].safeParse(input);
                if (!selected.success) return failure('invalid_parameters');
                if (selected.data.serverId !== host.serverId) return failure('target_mismatch');
                try {
                    return await readDeploymentObservationForHost(selected.data, context, { open, assertCurrent,
                        readEnvironment: (environmentId, context) => readEnvironmentMetadata({ environmentId, context }),
                        readReceipt: readReceiptMetadata });
                } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1 && 'mode' in input && input.mode === 'preview') {
                const selected = DeploymentActionInputSchemasV1[actionId].safeParse(input);
                if (!selected.success || !('mode' in selected.data)) return failure('invalid_parameters');
                return ownServerTeardown.preview(selected.data, context);
            }
            if (actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1 && context.resumeActionRequest
                && context.operationAcceptance?.actionId === actionId) {
                const prepared = DeploymentTeardownInputV1Schema.safeParse(input);
                if (!prepared.success || prepared.data.serverId !== host.serverId) return failure('deployment_conflict');
                const operation = await host.readOperation?.(context.operationAcceptance.operationId, context);
                const reference = operation?.domainRef;
                if (!operation || operation.actionId !== actionId || reference?.kind !== 'deployment'
                    || reference.serverId !== prepared.data.serverId || reference.environmentId !== prepared.data.environmentId) {
                    return failure('deployment_conflict');
                }
                // The retained invocation already admitted this exact receipt. It
                // resumes through dispatch without repeating Home begin or review.
                const [environment, receipt] = await Promise.all([
                    readEnvironmentMetadata({ environmentId: reference.environmentId, context }),
                    readReceiptMetadata(reference.environmentId, reference.deploymentId, context),
                ]);
                return dispatchReceipt({ actionId, input: prepared.data, context, receipt: { ok: true,
                    environmentId: reference.environmentId, revision: environment.environment.revision,
                    deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision,
                    state: receipt.deployment.state } });
            }
            const recovery = actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1 && ('detachKeepRunning' in input || 'nothingDeployed' in input)
                ? null : await recoverInterruptedReceipt(actionId, input, context);
            if (recovery) return recovery;
            if (actionId === 'deployments.restart') {
                const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
                if (!parsed.success) return failure('invalid_parameters');
                return createDeploymentRestartActionForHost({ ...host, assertCurrent: assertHttpAuthority })(parsed.data, context);
            }
            if (isDeploymentDataSizeActionIdV1(actionId)) {
                const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
                if (!parsed.success) return failure('invalid_parameters');
                return createDeploymentDataSizeActionForHost({ ...targetHost, assertCurrent: assertHttpAuthority,
                    ensureServiceObservations: host.ensureServiceObservations })(parsed.data, context);
            }
            if (actionId === 'deployments.environments.update' || (actionId === 'deployments.environments.create'
                && ('contentArtifactId' in input || !('mode' in input) || input.mode !== 'preview'))) {
                try { await requireDefinitionManage(context,
                    actionId === 'deployments.environments.create' ? 'deployment_access_denied' : 'action_forbidden'); }
                catch (error) { return failure(errorCode(error), error); }
            }
            if (actionId === 'deployments.health.current') {
                const selected = DeploymentActionInputSchemasV1[actionId].safeParse(input);
                return selected.success ? readCurrentHealth(selected.data, context) : failure('invalid_parameters');
            }
            if (isDeploymentDomainDnsActionIdV1(actionId)) {
                try {
                    const result = await domainDnsActions.execute(actionId, input, context);
                    return result ? result.ok ? DeploymentActionOutputSchemasV1[actionId].parse(result.result) : result : failure('action_forbidden');
                } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (isDeploymentDomainChildActionIdV1(actionId)) {
                const provider = await prepareContributedDomain.execute(actionId, input, context);
                const result = provider ? provider.ok ? DeploymentActionOutputSchemasV1[actionId].parse(provider.result) : provider
                    : await domainActions(actionId, input, context);
                if ('ok' in result && result.ok && 'environmentId' in result && 'domain' in result) {
                    const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
                    try { lease?.registry.currentDomainEdgeObservation?.withdrawDomain(result.environmentId, result.domain.id); }
                    finally { await lease?.release(); }
                }
                return result;
            }
            if (actionId === 'deployments.targets.link') {
                let recovery: DeploymentTargetLinkProviderIntentInputV1 | undefined;
                try {
                    let intent = DeploymentActionInputSchemasV1[actionId].parse(input);
                    // Only the private, exact child issued by the Create parent can carry a data Create acknowledgment.
                    const createdByParent = readHostReviewedChildOperationV1(context, actionId, input)?.parent.actionId === 'deployments.environments.create';
                    let acknowledgedCreate = createdByParent && 'provider' in intent && intent.provider.providerResourceOrigin === 'created';
                    if ('provider' in intent && intent.provisioned === true) recovery = { ...intent,
                        provider: normalizeDeploymentTargetLinkOriginV1(intent.provider) };
                    if ('providerCreate' in intent && (!context.operationOwnerUpdate || !context.hostReviewedChild)) {
                        return failure('source_unavailable');
                    }
                    let readLinkMetadata = readEnvironmentMetadata;
                    let target = null;
                    if (intent.role === 'runtime' && intent.source?.kind === 'plugin') {
                        target = await readRuntimeLinkTarget(intent.source);
                        if (!target || target.role !== 'runtime' || target.targetKind !== intent.targetKind) {
                            return failure('deployment_target_role_unavailable');
                        }
                        const checkSource = readDeploymentTargetSourceCheckV1(target);
                        if (checkSource) {
                            // Association reuses the metadata for this exact definition. Home compares the reviewed revision.
                            const selected = { environmentId: intent.environmentId, context };
                            const metadata = await readEnvironmentMetadata(selected);
                            readLinkMetadata = async () => metadata;
                            const environment = await readDeploymentEnvironmentForHost(selected, { readMetadata: readLinkMetadata, open, assertCurrent });
                            const sourceRefusal = checkSource(readDeploymentDefinitionSourceKindV1(environment.content.definition));
                            if (sourceRefusal) return failure(sourceRefusal);
                        }
                    }
                    if ('providerCreate' in intent) {
                        const created = await createRuntimeTargetForHost(intent, target, context);
                        if (!created.ok) return created;
                        recovery = created.recovery;
                        intent = recovery;
                        acknowledgedCreate = true;
                    }
                    const prepared = await prepareTargetLinkForHost({ input: intent, context, acknowledgedCreate }, {
                        serverHttpBaseUrl: host.serverHttpBaseUrl, artifacts,
                        readMetadata: readLinkMetadata, assertCurrent, artifactAuthorization,
                    });
                    if ('contentArtifactId' in prepared) {
                        const linked = await storage(actionId, prepared, context);
                        if (recovery && 'ok' in linked && linked.ok === false) return DeploymentTargetLinkProvisionedResultV1Schema.parse({
                            ok: false, error: 'deployment_link_incomplete', recovery,
                            failure: 'errorCode' in linked ? linked : failure(linked.error, linked),
                        });
                        if ('ok' in linked && linked.ok === false && ('errorCode' in linked ? linked.errorCode : linked.error) === 'deployment_content_unavailable') {
                            return { ...failure('deployment_content_unavailable'),
                                error: 'deployment_content_unavailable (target_link.content_associate: storage_refused)' };
                        }
                        const productionBranchOutcome = recovery?.provider.preparedNative?.productionBranchOutcome;
                        return 'ok' in linked && linked.ok && productionBranchOutcome
                            ? { ...linked, productionBranchOutcome } : linked;
                    }
                    return prepared;
                } catch (error) {
                    if (error instanceof RuntimeTargetCreationCheckpointError) recovery = error.recovery;
                    const cause = error instanceof TargetLinkPreparationError || error instanceof RuntimeTargetCreationCheckpointError ? error.cause : error;
                    const refused = failure(context.signal?.aborted ? 'cancelled'
                        : cause instanceof ArtifactEncryptionMaterialUnavailableError ? 'client_required' : errorCode(cause), cause);
                    const httpStatus = readHttpStatus(cause);
                    const invalid = DeploymentInvalidV1Schema.safeParse(cause instanceof Error && 'details' in cause ? cause.details : undefined);
                    const preparedFailure = error instanceof TargetLinkPreparationError
                        ? { ...refused, ...(invalid.success && invalid.data.error === refused.errorCode ? { details: invalid.data } : {}),
                            error: `${refused.error} (target_link.${error.step}: ${error.reason}${httpStatus === null ? '' : `, http_status=${httpStatus}`})` } : refused;
                    if (recovery) return DeploymentTargetLinkProvisionedResultV1Schema.parse({
                        ok: false, error: 'deployment_link_incomplete', recovery, failure: preparedFailure,
                    });
                    return preparedFailure;
                }
            }
            if (actionId === 'deployments.environments.create' && !('contentArtifactId' in input)) {
                const { actionInputValidationFailure, actionInputIssueFailure } = await import('@happier-dev/protocol/actions/executor/actionInputValidation');
                const intent = DeploymentEnvironmentCreateIntentInputV1Schema.safeParse(input);
                if (!intent.success) return actionInputValidationFailure(intent.error);
                if (intent.data.mode !== 'preview') return intent.data.definition?.from === 'catalogApp'
                    ? templates.instantiateCreate(intent.data, context, creationReview)
                    : actionInputIssueFailure({ code: 'invalid_value', path: ['mode'], acceptedValues: ['preview'] });
                const prepared = await prepareEnvironmentCreate({ input: intent.data, context });
                return 'errorCode' in prepared ? prepared : DeploymentEnvironmentCreatePreviewV1Schema.parse({
                    kind: 'preview', input: prepared.input, review: prepared.preview });
            }
            if (actionId === 'deployments.environments.update' && 'mode' in input && input.mode === 'preview') {
                // A preview writes nothing, so a refused or failed read is a typed refusal, never an unknown outcome.
                try {
                    const selected = DeploymentActionInputSchemasV1[actionId].safeParse(input);
                    if (!selected.success) return failure('invalid_parameters');
                    const request = selected.data;
                    const detail = await readEnvironmentMetadata({ environmentId: request.environmentId, context });
                    if (request.patch?.previewTemplate) {
                        if (detail.environment.revision !== request.expectedRevision) return failure('deployment_conflict');
                        const runtime = detail.targetLinks.find(link => link.id === request.patch!.previewTemplate!.runtimeTargetLinkId);
                        const forkEligibility = await preparePreviewForkEligibilityForHost({ serverId: request.serverId,
                            protection: detail.environment.protection,
                            buildMachineId: request.patch.buildMachineId ?? detail.environment.buildMachineId, runtime },
                            input => storage('deployments.environments.list', input, context));
                        return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision, forkEligibility };
                    }
                    const defaultsHost = atHome(() => creationDefaultsHost(context));
                    const preview = await atHome(() => prepareDeploymentEnvironmentDefaultsForHost({
                        input: request, environment: detail, context,
                    }, defaultsHost));
                    const backupSourceChoices = request.defaultsFor === 'backups' ? await atHome(async () => {
                        if (!host.runtime.prepareBackupSourceChoices) throw new PluginError({ code: 'unsupported_action',
                            message: 'Backup source preparation is unavailable on this host' });
                        const environment = await readDeploymentEnvironmentForHost({ environmentId: request.environmentId, context }, {
                            readMetadata: async () => detail, open, assertCurrent,
                        });
                        return host.runtime.prepareBackupSourceChoices({ environment, context });
                    }) : undefined;
                    return { ...preview,
                        ...(backupSourceChoices ? { backupSourceChoices } : {}) };
                } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
            }
            if (actionId === 'deployments.environments.create') {
                const prepared = DeploymentEnvironmentCreateInputV1Schema.safeParse(input);
                if (!prepared.success) {
                    const { actionInputValidationFailure } = await import('@happier-dev/protocol/actions/executor/actionInputValidation');
                    return actionInputValidationFailure(prepared.error);
                }
                if (prepared.data.copyFrom) return createEnvironmentWithCopyForHost({ input: prepared.data, context, creationReview }, {
                    create: storage,
                    readEnvironment: request => readDeploymentEnvironmentForHost(request, {
                        readMetadata: readEnvironmentMetadata, open, assertCurrent,
                    }),
                });
            }
            if (actionId === 'deployments.publish.prepare') return templates.preparePublishEntry(DeploymentActionInputSchemasV1[actionId].parse(input), context);
            if (isDeploymentNativeReadActionIdV1(actionId)) return nativeReads(actionId, input, context);
            if (actionId !== 'deployments.deploy') return storage(actionId, input, context, creationReview);
            const parsed = DeploymentDeployInputV1Schema.safeParse(input);
            if (!parsed.success || parsed.data.whenBusy !== 'supersede') return storage(actionId, input, context);
            try {
                if (parsed.data.serverId !== host.serverId) return failure('server_scope_mismatch');
                const prepared = await preparePendingDeploymentForHost({ input: parsed.data, context }, {
                    readEnvironment: () => readEnvironmentMetadata({ environmentId: parsed.data.environmentId, context }),
                    readResource: artifactId => atHome(() => artifacts.readForUpdate(artifactId, { signal: context.signal,
                        prepareRecipients: false, includeSharedAudience: false, authorizationHeaders: artifactAuthorization(context) })),
                    open: artifactId => open(artifactId, context), assertCurrent: () => assertCurrent(context),
                });
                const result = await storage(actionId, prepared.input, context);
                if ('errorCode' in result || !('ok' in result) || !result.ok || !('kind' in result) || result.kind !== 'pending') return result;
                if (result.environmentId !== prepared.input.environmentId
                    || result.actionOperationId !== prepared.intent.actionOperationId) return failure('deployment_conflict');
                return await waitForPendingDeploymentForHost({ ...prepared, result, context }, {
                    credentials: host.credentials, serverHttpBaseUrl: host.serverHttpBaseUrl,
                    readEnvironment: () => readEnvironmentMetadata({ environmentId: prepared.input.environmentId, context }),
                    readReceipts: () => storage('deployments.receipts.list', { serverId: prepared.input.serverId,
                        environmentId: prepared.input.environmentId, inProgressOnly: true }, context),
                    assertCurrent: () => assertCurrent(context),
                    async cancel(fresh) {
                        await fresh.assertCurrent();
                        const authorization = fresh.callerInputAuthorization;
                        if (authorization?.binding.requesterOperationRead && authorization.requesterHttpProjection) {
                            await cancelPendingDeploymentForHost({ context: fresh, operationId: prepared.intent.actionOperationId,
                                scope: { accountId: authorization.binding.accountId, machineId: host.machineId },
                                custody: { serverId: host.serverId, installationId: authorization.binding.installationId } });
                            return;
                        }
                        // Never substitute the accepted Deploy root or the
                        // machine custodian's bearer for this fresh requester.
                        if (!authorization?.requesterAccountProjection || !authorization.requesterHttpProjection) return refuse('action_forbidden');
                        const address = await readReviewedActionOperationCancelAddress({ authorization,
                            envelope: fresh.originalActionEnvelope, signal: fresh.signal });
                        if (!address || address.operationId !== prepared.intent.actionOperationId
                            || address.machineId !== host.machineId
                            || host.serverId !== authorization.binding.serverIdentityId) return refuse('action_forbidden');
                        const currentContext = buildActionExecutorContextForRpc({ ...fresh,
                            actionId: 'action.operations.cancel', serverId: host.serverId,
                            runtimeAccountId: authorization.binding.accountId,
                            externalActionTarget: authorization.binding.target });
                        const serverId = authorization.binding.serverIdentityId;
                        const environmentId = prepared.input.environmentId;
                        const readPath = `/v1/deployments/environments/${encodeURIComponent(environmentId)}?serverId=${encodeURIComponent(serverId)}`;
                        await fresh.assertCurrent();
                        const readHeaders = await headers(currentContext, 'action.operations.cancel', { method: 'GET', path: readPath });
                        const read = await axios.request<unknown>({ method: 'GET', url: `${host.serverHttpBaseUrl}${readPath}`,
                            headers: readHeaders, signal: fresh.signal, validateStatus: () => true });
                        await fresh.assertCurrent();
                        await assertCurrent(currentContext);
                        const metadata = DeploymentEnvironmentGetResultV1Schema.parse(read.data);
                        if (!metadata.ok) return refuse(metadata.error);
                        if (read.status < 200 || read.status >= 300 || metadata.environment.id !== environmentId) return refuse(deploymentOutputValidationFailure('deployments.pending.cancel', undefined));
                        if (!metadata.environment.capabilities.deploy) return refuse('deployment_access_denied');
                        if (!metadata.pendingDeploy) return;
                        if (!isDeepStrictEqual(metadata.pendingDeploy, prepared.input.pendingDeploy)) return refuse('deployment_conflict');
                        const body = DeploymentPendingCancelInputV1Schema.parse({ serverId, environmentId,
                            expectedRevision: metadata.environment.revision, actionOperationId: prepared.intent.actionOperationId,
                            pendingDeploy: prepared.input.pendingDeploy });
                        const path = `/v1/deployments/environments/${encodeURIComponent(environmentId)}/pending/cancel`;
                        await fresh.assertCurrent();
                        const requestHeaders = await headers(currentContext, 'action.operations.cancel', { method: 'POST', path, body });
                        const response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`,
                            headers: requestHeaders, data: body, signal: fresh.signal, validateStatus: () => true });
                        await fresh.assertCurrent();
                        await assertCurrent(currentContext);
                        const cleared = DeploymentEnvironmentCreateResultV1Schema.parse(response.data);
                        if (!cleared.ok) return refuse(cleared.error);
                        if (response.status < 200 || response.status >= 300 || cleared.environmentId !== environmentId
                            || cleared.revision !== metadata.environment.revision + 1) return refuse(deploymentOutputValidationFailure('deployments.pending.cancel', undefined));
                    },
                    async resume(): Promise<ReturnType<typeof DeploymentReceiptResultV1Schema.parse> | ActionExecuteFailure> {
                        if (!host.executePreparedPendingDeploy) return failure('unsupported_action');
                        await definitionRole(context);
                        const fresh = await prepareAdmittedDeployCandidate({ environmentId: prepared.input.environmentId,
                            targetLinkId: prepared.input.targetLinkId, sourceIntent: prepared.intent.sourceIntent,
                            ...(prepared.intent.sourceMethod ? { sourceMethod: prepared.intent.sourceMethod } : {}),
                            ...(prepared.intent.onFailure ? { onFailure: prepared.intent.onFailure } : {}),
                            requestKey: prepared.intent.requestKey, whenBusy: 'supersede', context });
                        if (!fresh.ok) return fresh;
                        if (!sameStrictJsonValue(fresh.content.sourceIntent, prepared.intent.sourceIntent)
                            || fresh.content.sourceMethod !== prepared.intent.sourceMethod
                            || (fresh.content.onFailure ?? DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE)
                                !== (prepared.intent.onFailure ?? DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE)) return failure('target_mismatch');
                        const resumed = await host.executePreparedPendingDeploy({ ...fresh.input,
                            pendingDeploy: prepared.input.pendingDeploy }, context);
                        return resumed.ok ? DeploymentReceiptResultV1Schema.parse(resumed.result) : resumed;
                    },
                });
            } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
        }) satisfies NonNullable<ActionExecutorDeps['deploymentAction']>,
        async deploymentTemplateInstantiate(...args: Parameters<typeof templates.instantiate>) {
            try { await requireDefinitionManage(args[1]); return await templates.instantiate(...args); }
            catch (error) { return failure(errorCode(error), error); }
        },
        deploymentMoveToRepository: moveToRepository,
        prepareDeploymentEnvironmentCreate: prepareEnvironmentCreate,
        async prepareDeploymentTemplateInstantiation({ input, context, executeCanonicalAction }: Parameters<NonNullable<ActionExecutorDeps['prepareDeploymentTemplateInstantiation']>>[0]) {
            try { await requireDefinitionManage(context); return await templates.prepare(input, context, executeCanonicalAction); }
            catch (error) { return failure(errorCode(error), error); }
        },
        resolveEnvironmentApprovalScope: storageDeps.resolveEnvironmentApprovalScope,
        async resolveServiceExportBinding(binding: TcpTunnelServiceExportBindingV1, signal: AbortSignal) {
            const identity = readInstallationIdentityIfExistsSync();
            if (!identity || !host.acquirePluginRuntimeRegistryLease) return null;
            signal.throwIfAborted();
            await host.ensureServiceObservations?.({ environmentId: binding.service.environmentId, serviceId: binding.service.serviceId });
            const lease = await host.acquirePluginRuntimeRegistryLease();
            try {
                const { homeServerIdentityId } = await resolveOwnServerDeploymentIdentityForHost({
                    happierHomeDir: configuration.happyHomeDir, serverId: host.serverId, environmentId: binding.service.environmentId });
                const owner = lease.registry.projectManagedServices;
                const handle = owner.resolveEnvironmentService(homeServerIdentityId, binding.service);
                if (!handle) return null;
                const admission = await resolvePrivateServiceExportAdmissionForHost({
                    kind: 'applied', exportKey: binding.exportKey, machineId: host.machineId, installationId: identity.installationId,
                    exports: handle.appliedServiceExports ?? [], row: owner.machineServiceRows.read(handle), signal,
                });
                return admission.kind === 'iroh' ? { binding: admission.serviceExport, retirementSignal: handle.retirementSignal } : null;
            } catch (error) {
                signal.throwIfAborted();
                if (error instanceof Error && 'code' in error && error.code === 'reference_unavailable') return null;
                throw error;
            } finally { await lease.release(); }
        },
        readDeploymentEnvironment: targetHostReaders.readEnvironment,
        readPreparedDeploymentContent,
        readSetupAppArtifact: (input: Readonly<{ contentArtifactId: string }>, context: ActionExecutorContext) => open(input.contentArtifactId, context),
        async readPendingDeploymentRecovery(input: unknown, context: ActionExecutorContext) {
            const parsed = DeploymentDeployInputV1Schema.safeParse(input);
            if (!parsed.success || parsed.data.whenBusy !== 'supersede') return undefined;
            const authorization = context.externalActionExecutionAuthorization;
            const identity = readInstallationIdentityIfExistsSync();
            if (!authorization || !identity) return refuse('action_forbidden');
            return readPendingDeploymentRecoveryOperation({ input: parsed.data, context,
                scope: { accountId: authorization.binding.accountId, machineId: host.machineId },
                custody: { serverId: host.serverId, installationId: identity.installationId },
                read: () => readEnvironmentMetadata({ environmentId: parsed.data.environmentId, context }),
                async validate(currentInput, current, operationId) {
                    await validatePendingDeploymentInputForHost({ input: currentInput, current, operationId }, {
                        readResource: artifactId => atHome(() => artifacts.readForUpdate(artifactId, { signal: context.signal,
                            prepareRecipients: false, includeSharedAudience: false, authorizationHeaders: artifactAuthorization(context) })),
                        open: artifactId => open(artifactId, context), assertCurrent: () => assertCurrent(context),
                    });
                },
            });
        },
        async prepareDeployCandidate(originalRequest: DaemonDeploymentCandidateRequest,
            observedEnvironment?: DeploymentEnvironmentDetailV1): Promise<DaemonDeploymentCandidateResult> {
            try {
                const environment = await admitCandidateRequest(originalRequest, observedEnvironment);
                return await prepareAdmittedDeployCandidate(originalRequest, environment);
            } catch (error) { return failure(errorCode(error), error); }
        },
        async prepareDeploymentAction(originalRequest: DaemonDeploymentPreparationRequest): Promise<DaemonDeploymentPreparationResult> {
            try {
                const originalInput = originalRequest.input;
                const reviewedReentry = originalRequest.context.externalActionExecutionAuthorization?.binding.deploymentCandidatePublication?.reviewed;
                if (!reviewedReentry) {
                    const recovery = await recoverInterruptedReceipt(originalRequest.actionId, originalInput, originalRequest.context);
                    if (recovery) return recovery;
                }
                const parent = originalRequest.context.hostReviewedChild?.parent;
                const reviewedCreate = readHostAdmittedReviewedParentV1(originalRequest.context.hostReviewedChild);
                const forkDeployment = reviewedCreate?.actionId === 'deployments.environments.create'
                    && DeploymentEnvironmentCreateInputV1Schema.safeParse(reviewedCreate.input).success
                    && 'preview' in reviewedCreate.input;
                const template = parent?.actionId === 'deployments.templates.instantiate'
                    ? DeploymentTemplateInstantiateInputV1Schema.safeParse(parent.input) : null;
                // The template parent reviews its explicit deploy effect before
                // creating the definition. It does not carry a pre-built Deploy candidate.
                const templateDeployment = template?.success && template.data.mode === 'apply'
                    && readDeploymentTemplateDeployIntentV1(template.data)?.requestKey === originalInput.requestKey
                    || parent?.actionId === 'deployments.environments.create'
                        && isTemplateDeploymentRoot(originalRequest.context)
                        && parent.input.requestKey === originalInput.requestKey;
                const replayingDeployment = originalRequest.context.approvedActionReplay && !templateDeployment && !forkDeployment;
                const authorsCandidate = !('contentArtifactId' in originalInput);
                if (reviewedReentry && authorsCandidate) return failure('approval_stale');
                let preparationEnvironment: DeploymentEnvironmentDetailV1 | undefined;
                let preparationPromotion: Awaited<ReturnType<typeof readStoredPromotionCandidateForHost>> | undefined;
                let promotionSource: DeploymentReceiptDetailV1 | undefined;
                let preparedCandidate: Readonly<{ title: string; content: DeploymentContentV1 }> | undefined;
                let input: OwnServerDeploymentReviewRequest['input'];
                const createCandidate = async (environment: DeploymentEnvironmentDetailV1, content: DeploymentContentV1) => {
                    const context = originalRequest.context;
                    const header = createDeploymentReceiptArtifactHeaderV1(environment.content.name, content);
                    const created = await atHome(async () => createDeploymentArtifactForHost({ artifacts,
                        owner: environment.environment.owner,
                        assertCurrent: () => assertEnvironmentContentOwnerCurrent({ environmentId: environment.environment.id, context }, environment.environment.owner),
                        content: { prepareRecipients: true,
                            ...await candidateIdentity(environment.environment.id, context, 'receipt', environment.environment),
                            header,
                            body: JSON.stringify(content), signal: context.signal,
                            beforeWrite: () => assertCurrent(context), authorizationHeaders: candidateArtifactAuthorization(context),
                        } }));
                    preparedCandidate = { title: header.title, content };
                    return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                        contentBodyVersion: created.revision.bodyVersion };
                };
                if ('contentArtifactId' in originalInput) input = originalInput;
                else if (isDeploymentPromoteActionIdV1(originalRequest.actionId) && 'sourceDeploymentId' in originalInput) {
                    if (originalInput.serverId !== host.serverId) return failure('server_scope_mismatch');
                    if (replayingDeployment) return failure('invalid_parameters');
                    await requireDefinitionManage(originalRequest.context);
                    const prepared = await preparePromotionForHost({ input: originalInput, context: originalRequest.context }, {
                        ...targetHostReaders, readReceipt: targetHostReaders.readAnyReceipt,
                        async createCandidate(environment, content) {
                            await admitPreview(environment, originalRequest.context);
                            return createCandidate(environment, content);
                        },
                    });
                    input = prepared.input;
                    preparationPromotion = prepared.promotion;
                    promotionSource = prepared.sourceReceipt;
                    preparationEnvironment = prepared.environment;
                }
                else if (originalRequest.actionId === 'deployments.rollback' && 'deploymentId' in originalInput) {
                    await definitionRole(originalRequest.context);
                    if (originalInput.serverId !== host.serverId) return failure('server_scope_mismatch');
                    if (replayingDeployment) return failure('invalid_parameters');
                    const request = { environmentId: originalInput.environmentId, context: originalRequest.context };
                    const prepared = await prepareRollbackForHost({ input: originalInput, context: request.context }, {
                        ...targetHostReaders, readReceipt: targetHostReaders.readAnyReceipt, createCandidate,
                    });
                    input = prepared.input;
                    preparationEnvironment = prepared.environment;
                }
                else {
                    if (originalRequest.actionId !== 'deployments.deploy' || 'deploymentId' in originalInput || 'sourceDeploymentId' in originalInput) return failure('invalid_parameters');
                    if (originalInput.serverId !== host.serverId) return failure('server_scope_mismatch');
                    preparationEnvironment = await admitCandidateRequest({ environmentId: originalInput.environmentId, context: originalRequest.context,
                        ...(originalInput.sourceIntent ? { sourceIntent: originalInput.sourceIntent } : {}),
                        ...(originalInput.sha ? { sha: originalInput.sha } : {}),
                        ...(originalInput.sourceMethod ? { sourceMethod: originalInput.sourceMethod } : {}),
                        ...(originalInput.services ? { services: originalInput.services } : {}) });
                    const pending = await readCompactPending(originalInput, originalRequest.context);
                    const captured = pending?.captured;
                    if (pending && host.preparePendingDeploymentObservation) {
                        const observe = await host.preparePendingDeploymentObservation({ input: originalInput,
                            admission: pending.admission, pendingDeploy: pending.pendingDeploy, context: originalRequest.context,
                            async validateOriginalInput(original, context) {
                                const current = await readCompactPending(originalInput, context);
                                if (!current || !isDeepStrictEqual(current.admission, pending.admission)
                                    || !isDeepStrictEqual(current.pendingDeploy, pending.pendingDeploy)) return refuse('deployment_conflict');
                                // This is observation, not a new receipt claim. The original
                                // runner input intentionally retains its pre-pending CAS.
                                await validatePendingDeploymentInputForHost({ input: { ...original, pendingDeploy: current.pendingDeploy },
                                    current: current.current, operationId: pending.admission.actionOperationId }, {
                                    readResource: artifactId => atHome(() => artifacts.readForUpdate(artifactId, { signal: context.signal,
                                        prepareRecipients: false, includeSharedAudience: false, authorizationHeaders: artifactAuthorization(context) })),
                                    open: artifactId => open(artifactId, context), assertCurrent: () => assertCurrent(context),
                                });
                            },
                        });
                        if (observe) return { observePendingOperation: async context => {
                            try { return await observe(context); }
                            catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
                        } };
                    }
                    // An approved compact replay may only observe an already
                    // active invocation; it never authors a replacement candidate.
                    if (replayingDeployment) return failure('invalid_parameters');
                    preparationEnvironment ??= await targetHostReaders.readEnvironment({ environmentId: originalInput.environmentId,
                        context: originalRequest.context });
                    const candidate = await prepareAdmittedDeployCandidate({ environmentId: originalInput.environmentId,
                        admittedTemplateSource: originalRequest.admittedTemplateSource,
                        targetLinkId: captured?.targetLinkId ?? originalInput.targetLinkId, context: originalRequest.context,
                        ...(captured ? { sourceIntent: captured.sourceIntent } : originalInput.sourceIntent ? { sourceIntent: originalInput.sourceIntent } : {}),
                        ...(!captured && originalInput.sha ? { sha: originalInput.sha } : {}),
                        ...(captured?.sourceMethod ? { sourceMethod: captured.sourceMethod }
                            : originalInput.sourceMethod ? { sourceMethod: originalInput.sourceMethod } : {}),
                        ...(captured?.onFailure ? { onFailure: captured.onFailure }
                            : originalInput.onFailure ? { onFailure: originalInput.onFailure } : {}),
                        ...((captured?.services ?? originalInput.services) ? { services: captured?.services ?? originalInput.services } : {}),
                        ...(originalInput.requestKey ? { requestKey: originalInput.requestKey } : {}),
                        ...(originalInput.whenBusy ? { whenBusy: originalInput.whenBusy } : {}) }, preparationEnvironment);
                    if (!candidate.ok) return candidate;
                    preparedCandidate = { title: createDeploymentReceiptArtifactHeaderV1(preparationEnvironment.content.name,
                        candidate.content).title, content: candidate.content };
                    if (captured && (!sameStrictJsonValue(candidate.content.sourceIntent, captured.sourceIntent)
                        || candidate.content.sourceMethod !== captured.sourceMethod
                        || !isDeepStrictEqual(candidate.content.services, captured.services)
                        || (candidate.content.onFailure ?? DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE)
                            !== (captured.onFailure ?? DEFAULT_OWN_SERVER_DEPLOYMENT_ON_FAILURE))) return failure('target_mismatch');
                    input = pending ? { ...candidate.input, pendingDeploy: pending.pendingDeploy } : candidate.input;
                }
                const request = { ...originalRequest, input };
                if (request.input.serverId !== host.serverId) return failure('server_scope_mismatch');
                await assertCurrent(request.context);
                const candidate = preparedCandidate ? { ok: true as const, ...preparedCandidate }
                    : readDeploymentReceiptArtifactV1(request.input, await open(request.input.contentArtifactId,
                        request.context, candidateArtifactAuthorization(request.context)));
                if (!candidate.ok) return reviewedReentry && candidate.error === 'deployment_conflict'
                    ? failure('approval_stale', candidate) : failure(candidate.error, candidate);
                const environment = preparationEnvironment ?? await targetHostReaders.readEnvironment({
                    environmentId: request.input.environmentId, context: request.context });
                if (!authorsCandidate) {
                    if (request.actionId === 'deployments.deploy') requireDeploymentSecretScope(environment);
                    await admitPreview(environment, request.context, candidate.content.sourceIntent?.kind === 'repository'
                        ? candidate.content.sourceIntent.sha : undefined);
                    const role = await definitionRole(request.context);
                    if (role === 'use') {
                        if (request.actionId === 'deployments.promote') return failure('action_forbidden');
                        const retained = request.actionId === 'deployments.rollback' && 'deploymentId' in request.input
                            ? await targetHostReaders.readReceipt({ environmentId: request.input.environmentId,
                                deploymentId: request.input.deploymentId, context: request.context }) : undefined;
                        admitUseDeploymentDefinition(environment, candidate.content, request.input.targetLinkId, retained?.content);
                    }
                }
                const metadata = { environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) };
                const selectedLink = metadata.targetLinks.find(link => link.id === request.input.targetLinkId);
                if (reviewedReentry && (environment.environment.revision !== request.input.expectedRevision
                    || selectedLink?.revision !== request.input.expectedTargetLinkRevision)) return failure('approval_stale');
                if (!selectedLink) return failure('target_mismatch');
                if (selectedLink.source.kind === 'plugin') {
                    if (request.actionId === 'deployments.deploy' && 'services' in request.input && request.input.services)
                        return failure('unsupported_action');
                    const platform = DeploymentPlatformContentV1Schema.safeParse(candidate.content);
                    if (!platform.success) return failure('invalid_parameters');
                    return await contributedTarget.prepareAction(request, platform.data, environment,
                        preparedCandidate !== undefined || Boolean(reviewedReentry), promotionSource);
                }
                const nativeCandidate = DeploymentOwnServerContentV1Schema.parse(candidate.content);
                if (reviewedReentry && !nativeCandidate.ownServer) return failure('approval_stale');
                if (request.actionId === 'deployments.deploy') {
                    assertReviewedDeploymentSource({ intent: request.input, content: nativeCandidate });
                }
                if (replayingDeployment && !nativeCandidate.ownServer) return failure('invalid_parameters');
                let effectInput = request.input;
                let content = nativeCandidate;
                let contentOwner: DeploymentEnvironmentDetailV1['environment']['owner'] | undefined = environment.environment.owner;
                const contentEnvironmentRequest = { environmentId: request.input.environmentId, context: request.context };
                const readContentOwner = async () => contentOwner ??= (await readEnvironmentMetadata(contentEnvironmentRequest)).environment.owner;
                const assertContentOwnerCurrent = async () => originalRequest.admittedTemplateSource
                    ? assertCurrent(request.context) : assertEnvironmentContentOwnerCurrent(contentEnvironmentRequest, await readContentOwner());
                let candidateEnvironmentContent: DeploymentEnvironmentDetailV1['content'] | undefined;
                let sourceImageArchives: NonNullable<DeploymentContentV1['ownServer']>['imageArchives'];
                let promotionReview: z.infer<typeof DeploymentPromotionReviewV1Schema> | undefined;
                if (request.actionId === 'deployments.promote') {
                    if (!('sourceDeploymentId' in request.input)) return failure('deployment_invalid');
                    // The current native producer only admits immutable images.
                    // P41's explicit rebuild producer must co-land before this choice can execute.
                    if (request.input.artifact !== 'image') return failure('unsupported');
                    const promotion = preparationPromotion ?? await readStoredPromotionCandidateForHost({ input: request.input, context: request.context }, targetHostReaders);
                    const { sourceReceipt, destination } = promotion;
                    contentOwner = destination.environment.owner;
                    sourceImageArchives = sourceReceipt.content.ownServer?.imageArchives;
                    candidateEnvironmentContent = promotion.candidateEnvironmentContent;
                    if (candidateEnvironmentContent.definition.kind !== 'stored' || destination.content.definition.kind !== 'stored') return failure('deployment_invalid');
                    await admitStoredComposeDefinition(candidateEnvironmentContent.definition);
                    const { ownServer: _review, ...unreviewed } = nativeCandidate;
                    content = createStoredPromotionReceiptContentForHost(promotion, nativeCandidate.onFailure);
                    if (nativeCandidate.ownServer) {
                        if (nativeCandidate.previewDomain) content = { ...content, previewDomain: nativeCandidate.previewDomain };
                        if (!isDeepStrictEqual(unreviewed, content)) return failure('target_mismatch');
                        if (!isDeepStrictEqual(nativeCandidate.ownServer.imageArchives, sourceImageArchives)) return failure('target_mismatch');
                        const retained = readDeploymentEnvironmentArtifactV1(request.input.destinationContent,
                            await open(request.input.destinationContent.contentArtifactId, request.context,
                                reviewedReentry ? candidateArtifactAuthorization(request.context) : undefined));
                        if (!retained.ok) return failure(reviewedReentry && retained.error === 'deployment_conflict'
                            ? 'approval_stale' : 'target_mismatch', retained);
                        if (!isDeepStrictEqual(retained.content, candidateEnvironmentContent)) return failure('target_mismatch');
                        content = nativeCandidate;
                    } else {
                        const created = await atHome(async () => createDeploymentArtifactForHost({ artifacts,
                            owner: destination.environment.owner, assertCurrent: assertContentOwnerCurrent, content: {
                            ...await candidateIdentity(request.input.environmentId, request.context, 'environment', metadata.environment, request.admittedTemplateSource),
                            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: destination.content.name },
                            body: JSON.stringify(candidateEnvironmentContent), signal: request.context.signal,
                            beforeWrite: () => assertCurrent(request.context), authorizationHeaders: candidateArtifactAuthorization(request.context) } }));
                        effectInput = { ...request.input, destinationContent: { contentArtifactId: created.artifactId,
                            contentHeaderVersion: created.revision.headerVersion, contentBodyVersion: created.revision.bodyVersion } };
                    }
                    promotionReview = { artifact: 'image', previousDocument: destination.content.definition.document,
                        candidateDocument: candidateEnvironmentContent.definition.document,
                        sourceRevision: projectDeploymentReviewRevisionV1(sourceReceipt.content.sourceIntent, sourceReceipt.content.commitSubject) };
                }
                if (!content.previewDomain && !nativeCandidate.ownServer) {
                    const effectiveEnvironment = candidateEnvironmentContent ?? environment.content;
                    const previewDomain = await preparePreviewDomainFactForHost({ serverId: host.serverId,
                        provenance: effectiveEnvironment.previewProvenance,
                        sources: effectiveEnvironment.bindings.map(binding => binding.source) }, {
                        readTemplate: environmentId => targetHostReaders.readEnvironment({ environmentId, context: request.context }),
                        readDomain: input => targetHost.readPreviewDomain!({ ...input, context: request.context }),
                    });
                    if (previewDomain) content = { ...content, previewDomain };
                }
                if (!isDeepStrictEqual(content, candidate.content)) {
                    const owner = await readContentOwner();
                    const effective = await atHome(async () => createDeploymentArtifactForHost({ artifacts, owner,
                        assertCurrent: assertContentOwnerCurrent, content: { prepareRecipients: true, header: createDeploymentReceiptArtifactHeaderV1(candidate.title, content),
                        ...await candidateIdentity(request.input.environmentId, request.context, 'receipt', metadata.environment, request.admittedTemplateSource),
                        body: JSON.stringify(content), signal: request.context.signal, beforeWrite: () => assertCurrent(request.context),
                        authorizationHeaders: candidateArtifactAuthorization(request.context) } }));
                    effectInput = { ...effectInput, contentArtifactId: effective.artifactId,
                        contentHeaderVersion: effective.revision.headerVersion, contentBodyVersion: effective.revision.bodyVersion };
                }
                const reviewed = await target.review({ ...request, input: effectInput, content, environment,
                    ...(candidateEnvironmentContent ? { candidateEnvironmentContent } : {}) });
                const preview = promotionReview ? { deployment: reviewed.reviewedEffect, promotion: promotionReview }
                    : request.actionId === DEPLOYMENT_ROLLBACK_ACTION_ID_V1
                        ? normalizeStrictJsonValue({ ...readRecord(reviewed.reviewedEffect),
                            rollbackData: 'restoreBackupId' in request.input && request.input.restoreBackupId ? 'restoreBackup' : 'keep' })
                        : reviewed.reviewedEffect;
                if (nativeCandidate.ownServer) {
                    return { input: effectInput, preview };
                }
                const reviewedBody = JSON.stringify({ ...content, ownServer: { approvedInputBasis: reviewed.inputBasis,
                    ...(sourceImageArchives === undefined ? {} : { imageArchives: sourceImageArchives }) } });
                if (authorsCandidate || request.context.externalActionExecutionAuthorization?.binding.deploymentCandidatePublication
                    && effectInput.contentArtifactId === request.context.externalActionExecutionAuthorization.binding.deploymentCandidatePublication.contentArtifactId) {
                    // This invocation owns the fresh candidate. Retain the same
                    // identity P42 admitted; supplied/approved heads remain immutable.
                    const updated = await atHome(() => artifacts.update({ artifactId: effectInput.contentArtifactId,
                        expectedRevision: { headerVersion: effectInput.contentHeaderVersion, bodyVersion: effectInput.contentBodyVersion },
                        header: createDeploymentReceiptArtifactHeaderV1(candidate.title, content), body: reviewedBody,
                        signal: request.context.signal, beforeWrite: () => assertCurrent(request.context),
                        authorizationHeaders: candidateArtifactAuthorization(request.context) }));
                    if (!updated.ok) return failure(updated.errorCode);
                    return { input: { ...effectInput, contentHeaderVersion: updated.revision.headerVersion,
                        contentBodyVersion: updated.revision.bodyVersion }, preview };
                }
                const owner = await readContentOwner();
                const created = await atHome(async () => createDeploymentArtifactForHost({ artifacts, owner,
                    assertCurrent: assertContentOwnerCurrent, content: { prepareRecipients: true, header: createDeploymentReceiptArtifactHeaderV1(candidate.title, content),
                    ...await candidateIdentity(request.input.environmentId, request.context, 'receipt', metadata.environment, request.admittedTemplateSource),
                    body: reviewedBody,
                    signal: request.context.signal, beforeWrite: () => assertCurrent(request.context),
                    authorizationHeaders: candidateArtifactAuthorization(request.context) } }));
                return { input: { ...effectInput, contentArtifactId: created.artifactId,
                    contentHeaderVersion: created.revision.headerVersion, contentBodyVersion: created.revision.bodyVersion },
                    preview };
            } catch (error) { return failure(originalRequest.context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
        },
    };
    return deps;
}
