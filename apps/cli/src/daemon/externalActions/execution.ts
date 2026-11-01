import { projectSessionSpawnNewActionInputV2 } from "@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2";
import { isManagedControllerCodecActionV1, openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { isDeploymentActionIdV1 } from "@happier-dev/protocol";
import { prepareManagedMachineSetupApplyInput } from "@/daemon/externalActions/prepareManagedMachineSetupApplyInput";
import { createDaemonDeploymentActionDeps } from "@/deployments/createDaemonDeploymentActionDeps";
import type { MachineVitalsSampleV1 } from "@happier-dev/protocol/machines/vitals/machineVitalsSampleV1";
import { createOwnServerDeploymentRuntimeForHost } from "@/deployments/targets/ownServer/ownServerDeploymentHostRuntime";
import { actionStartTargetUnavailableV1, measureActionStartPhaseV1 } from "@happier-dev/protocol/actions/executor/agentStartAdmission";
import { DiscussionAgentPublisherResponseV1Schema } from "@happier-dev/protocol/discussions/api";
import { prepareApprovedDiscussionAgentPublication, type DiscussionAgentPublisherPrivateRequestV1 } from "@/discussions/discussionAgentPublisher";
import { createApprovedDiscussionAgentPublisher } from "@/discussions/approvedDiscussionAgentPublisher";
import { createApprovedWorkflowDiscussionPublisher } from "@/discussions/approvedWorkflowDiscussionPublisher";
import { runTracedExternalActionStage } from "@/daemon/externalActions/externalActionPhase";
import { timeApprovalPhase, withApprovalActionTrace } from '@/daemon/externalActions/webLatencyTrace';
import { createEndOwnerRemainder } from "@/daemon/processes/endOwnerRemainder";
import { createApprovedApiTokenExecutionPreparer } from "@/daemon/externalActions/prepareApprovedApiTokenExecution";
import { join } from "node:path";
import type { ActionOperationRpcContext } from "@/daemon/actionOperations/actionOperationRpcHandlers";
import { createDaemonManagedMachineActionAdapter, createManagedSessionStartApprovalObserver } from "@/daemon/startup/managedMachineActionAdapter";
import { observeAccountChanges } from "@/api/observeAccountChanges";
import type { ActionExecuteResult, ActionExecutorContext } from "@happier-dev/protocol";
import type { RpcActionExecutorContext } from "@/rpc/handlers/_actionDispatchAdapter";
import { sameStrictJsonValue } from "@happier-dev/protocol/json/strictJsonValue";
import { arePluginMachineMaterializationRefsEqual } from "@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1";
import { getActionSpec } from "@happier-dev/protocol/actions/actionSpecs";
import { resolveRuntimeActionExecutionFamily } from "@happier-dev/protocol/actions/executor/dispatch";
import { callExactMachineRpc } from "@/session/transport/rpc/machineRpc";
import { createClientActionReverseDispatcher } from "@/session/actions/clientActionReverseDispatch";
import type { ApiMachineClient } from "@/api/apiMachine";
import { createProviderErrorV1 as createForegroundProviderError } from "@happier-dev/protocol/providers/errors";
import { configuration } from "@/configuration";
import { runWithServerHttpBaseUrl } from "@/api/client/serverHttpBaseUrl";
import type { RequesterSessionRuntimeContext } from "@/daemon/sessionEncryption/requesterSessionCredentials";
import { isOriginalOwnAccountActionCustody } from "@/daemon/sessionEncryption/requesterAccountActionProjection";
import { readRequesterAccountActionContext, type RequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { createProjectFiniteAction } from "@/workspaces/projectSetup/projectFiniteAction";
import type { RpcHandlerContext } from "@/api/rpc/types";
import { decodeBase64 } from "@happier-dev/protocol/crypto/base64";
import { readAccountIdFromToken as readPreviewAccountIdFromToken } from "@/cloud/decodeJwtPayload";
import { readAccountRoleOverridesFromSnapshot } from "@/settings/accountSettings/activeAccountSettingsSnapshot";
import { createCommittedInputTypeDeps } from "@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps";
import { prepareRequesterSessionBootstrap } from "@/daemon/sessionEncryption/requesterSessionCredentials";
import { readRequesterHomeWithinActionLifetime } from "@/daemon/sessionEncryption/requesterCurrentness";
import { createRequesterConnectedAccountPurposeBindingRuntime } from "@/daemon/connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime";
import { acquireAuthoritativePluginRuntimeRegistryLease } from "@/plugins/runtime/reload/runtimeLease";
import { createSessionTranscriptFollowLeaseRegistry } from "@/api/session/transcriptQueries";
import { createCliActionExecutorFromCredentials } from "@/session/actions/createCliActionExecutorFromCredentials";
import { createMachineRecipeReadAction } from "@/machines/setup/machineRecipeActionDeps";
import { createLocalServicesDaemonRuntimeActionExecutor } from "@/daemon/local/services/actions/runtimeActionExecutor";
import { createLocalServicesDaemonFeatureGate } from "@/daemon/local/services/featureGate";
import { dispatchManagedSessionStart, dispatchManagedMachineSetup, dispatchManagedMachineSetupPlan,
  dispatchLocalManagedMachineSetup, dispatchLocalManagedMachineSetupPlan, isManagedSessionStartTransportAvailable, isReviewedServiceMoveChild, isReviewedMachineSetupPlanChild, isReviewedSecondOpinionModelSpawnChild, isReviewedSessionSectionArchiveStopChild, projectExternalActionRequesterHttpAuthorization } from "@/api/externalActionExecutionAuthorization";
import type { SessionSpawnDirectTargetTransport } from "@/session/actions/createCliActionDeps";
import type { ExternalSessionPluginAdmissionOwner } from "@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner";
import type { ActionExecutorDeps, RuntimeActionExecute } from "@happier-dev/protocol/actions";
import { createDaemonExternalActionContributedApprovalReplay, createDaemonExternalActionContributedDefinitionLister, createDaemonExternalActionContributedInvoker } from "@/daemon/externalActions/createDaemonExternalActionContributedInvoker";
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from "@/daemon/externalActions/daemonExternalActionTargetResolver";
import type { ExternalActionIngressOwner } from "@/rpc/handlers/externalAction";
import type { CurrentMachineExecutionOriginContext } from "@/api/machine/resolveCurrentMachineExecutionOriginContext";
import { readInstallationIdentityIfExistsSync } from "@/daemon/identity/store";
import { readStoredCredentialsForServerId, sameStoredCredentials } from "@/persistence";
import { createDaemonShutdownCancellationDomains } from "@/daemon/startup/shutdownCancellationDomains";
import type { DaemonPluginChangeService } from "@/plugins/daemon/changeService";
import { type LocalServicesDaemonRuntime } from "@/daemon/local/services/runtime";
import { type CliServerFeaturesSnapshot } from "@/features/serverFeaturesClient";
import type { LocalServicesRuntimeActionRoutes } from "@/daemon/local/services/actions/runtimeActionExecutor";
import { SPAWN_SESSION_ERROR_CODES } from "@/session/shared/spawnSessionContract";
import { fetchAccountEncryptionCurrentness } from "@/api/client/connectedServiceCredentialApi";
import { executeSpawnSessionRequest } from "@/daemon/startup/executeSpawnSessionRequest";
import { type ConnectedAccountRequestAuthSubjectRegistry } from "@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry";
import { createProviderRedactionLease } from "@/providers/spawn/redaction";
import { createManagedProviderOperationAuthority } from "@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority";
import { createMachineSharedProviderGatewayResolver } from "@/providers/lifecycle/sharedGatewayIdentity";
import type { QualifiedConnectedAccountV4Support } from "@/daemon/connectedServices/qualifiedConnectedAccountV4Support";
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

/** Preserve an admitted host invocation; signed Session origins retain their own provenance. */
function readManagedChildInvocation(context: ActionExecutorContext) {
  const parsed = ExternalActionRequesterInvocationV1Schema.safeParse({ caller: context.actionCaller ?? { kind: 'host' },
    surface: context.surface, authority: context.authority, callerPermissionMode: context.callerPermissionMode,
    callerInputConstraints: context.callerInputConstraints, workspaceWrites: context.workspaceWrites,
    defaultSessionId: context.defaultSessionId });
  return parsed.success ? parsed.data : undefined;
}

export type DaemonExternalActionExecutorFactory = (credentials: Parameters<typeof createCliActionExecutorFromCredentials>[0]['credentials'], getCurrentTurnWorkDepth?: Parameters<
      typeof createCliActionExecutorFromCredentials
    >[0]['getCurrentTurnWorkDepth'], isSessionActionCallerCurrent?: () => Promise<boolean>, managedAgentStartMachineId?: string, requesterRuntime?: RequesterSessionRuntimeContext | null, managedPolicyAction?: Readonly<{
      managedMachineAction?: NonNullable<ActionExecutorDeps['managedMachineAction']>;
      hostActionApprovalLifetime: NonNullable<ActionExecutorDeps['hostActionApprovalLifetime']>;
    }>, requesterAccountContext?: RequesterAccountActionContext, sessionStopEffect?: ActionExecutorDeps['sessionStop'], postAgentDiscussionMessage?: Parameters<typeof createCliActionExecutorFromCredentials>[0]['postAgentDiscussionMessage'], accountPluginActions?: Readonly<{ accountPluginActions: true }>) => Pick<
    ReturnType<typeof createCliActionExecutorFromCredentials>,
    'execute' | 'replayApprovedApprovalRequest' | 'continueConfidentialApprovalRequest'
  >;

export function createDaemonExternalActionExecution({
  params, requiresPortableSessionSpawnServerIdentity, requesterAccountOperationContext, acquireDaemonPluginRuntimeRegistryLease, shutdownCancellationDomains, isSessionCallerCurrent, externalActionApprovalExecutionOriginCurrentness, externalActionIngressOwner, externalActionContributedApprovalReplay, observeContributedPluginExecution, relayDiscussionAgentPublication, externalActionInstallationIdentity, ownerRemainder, isRuntimePublicationQuiescing, pluginRuntimeController, connectedAccountRequestAuthRegistry, requireConnectedAccountRequestAuthHttpPort, localServicesActionFeatureGate, localServicesRuntimeActionRoutes, localServicesRuntime, externalActionContributedInvoker, externalActionContributedDefinitionLister, externalActionTranscriptFollowLeaseRegistry,
}: Readonly<{
  params: Readonly<{
machineId: string;
readDoctorResourceVitals?: () => Readonly<{ sample: MachineVitalsSampleV1 | null }>;
projectProviderModelsForAccount?: import('@/providers/modelManagement/runtimeServices').RuntimeProviderModelManagementServices['projectModelsForAccount'];
serverId: string;
serverBaseUrl: string;
runtimeActionExecute?: RuntimeActionExecute;
managedProviderOperationAuthority?: import('@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority').ManagedProviderOperationAuthority;
workflowAcceptedAuthorizationCurrentness?: Parameters<
      typeof createCliActionExecutorFromCredentials
    >[0]['workflowAcceptedAuthorizationCurrentness'];
resolveCurrentMachineExecutionOriginContext?: (
      signal?: AbortSignal,
    ) => Promise<CurrentMachineExecutionOriginContext | null>;
resolveExternalSessionHostAction?: () =>
      | ActionExecutorDeps['hostExternalSessionAction']
      | undefined;
resolveProjectAction?: () => ActionExecutorDeps['projectAction'];
resolveProjectWorkerAction?: () => ActionExecutorDeps['projectWorkerAction'];
externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
resolveSessionSpawnDirectTargetTransport?: () =>
      | SessionSpawnDirectTargetTransport
      | undefined;
credentials: NonNullable<
      Parameters<typeof executeSpawnSessionRequest>[0]['credentials']
    >;
resolveQualifiedConnectedAccountV4Support?: () => QualifiedConnectedAccountV4Support;
getApiMachineForSessions: () => ApiMachineClient | null;
pluginChangeService?: DaemonPluginChangeService;
resolveServerFeaturesSnapshot?: () =>
      | Promise<CliServerFeaturesSnapshot | undefined>
      | CliServerFeaturesSnapshot
      | undefined;
}>;
  requiresPortableSessionSpawnServerIdentity: (actionId: string, input: unknown) => boolean;
  requesterAccountOperationContext: (apiMachine: ApiMachineClient, requester: RequesterAccountActionContext, role: 'use' | 'manage', signal?: AbortSignal) => ActionOperationRpcContext;
  acquireDaemonPluginRuntimeRegistryLease: () => ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>;
  shutdownCancellationDomains: ReturnType<typeof createDaemonShutdownCancellationDomains>;
  isSessionCallerCurrent: NonNullable<
    Parameters<
      typeof createDaemonApprovalExecutionOriginCurrentnessFromCredentials
    >[0]['isSessionCallerCurrent']
  >;
  externalActionApprovalExecutionOriginCurrentness: ReturnType<typeof createDaemonApprovalExecutionOriginCurrentnessFromCredentials>;
  externalActionIngressOwner: ExternalActionIngressOwner | undefined;
  externalActionContributedApprovalReplay: ReturnType<typeof createDaemonExternalActionContributedApprovalReplay> | null;
  observeContributedPluginExecution: (request: Parameters<ApiMachineClient['observePluginActionExecution']>[0]) => ReturnType<ApiMachineClient['observePluginActionExecution']>;
  relayDiscussionAgentPublication: (credentials: Parameters<typeof createCliActionExecutorFromCredentials>[0]['credentials'], serverHttpBaseUrl: string, publication: DiscussionAgentPublisherPrivateRequestV1, signal?: AbortSignal) => Promise<ReturnType<typeof DiscussionAgentPublisherResponseV1Schema.parse>>;
  externalActionInstallationIdentity: ReturnType<typeof readInstallationIdentityIfExistsSync>;
  ownerRemainder: ReturnType<typeof createEndOwnerRemainder>;
  isRuntimePublicationQuiescing: () => boolean;
  pluginRuntimeController: import('@/plugins/runtime/reload/controller').PluginReloadController;
  connectedAccountRequestAuthRegistry: ConnectedAccountRequestAuthSubjectRegistry;
  requireConnectedAccountRequestAuthHttpPort: () => number;
  localServicesActionFeatureGate: ReturnType<typeof createLocalServicesDaemonFeatureGate>;
  localServicesRuntimeActionRoutes: LocalServicesRuntimeActionRoutes;
  localServicesRuntime: LocalServicesDaemonRuntime;
  externalActionContributedInvoker: ReturnType<typeof createDaemonExternalActionContributedInvoker> | null;
  externalActionContributedDefinitionLister: ReturnType<typeof createDaemonExternalActionContributedDefinitionLister> | null;
  externalActionTranscriptFollowLeaseRegistry: ReturnType<typeof createSessionTranscriptFollowLeaseRegistry> | null;
}>): DaemonExternalActionExecutorFactory {
  const createExternalActionExecutor: DaemonExternalActionExecutorFactory = (
    credentials: typeof params.credentials,
    getCurrentTurnWorkDepth?: Parameters<
      typeof createCliActionExecutorFromCredentials
    >[0]['getCurrentTurnWorkDepth'],
    isSessionActionCallerCurrent?: () => Promise<boolean>,
    managedAgentStartMachineId?: string,
    requesterRuntime?: RequesterSessionRuntimeContext | null,
    managedPolicyAction?: Readonly<{
      managedMachineAction?: NonNullable<ActionExecutorDeps['managedMachineAction']>;
      hostActionApprovalLifetime: NonNullable<ActionExecutorDeps['hostActionApprovalLifetime']>;
    }>,
    requesterAccountContext?: RequesterAccountActionContext,
    sessionStopEffect?: ActionExecutorDeps['sessionStop'],
    postAgentDiscussionMessage?: Parameters<typeof createCliActionExecutorFromCredentials>[0]['postAgentDiscussionMessage'],
    accountPluginActions?: Readonly<{ accountPluginActions: true }>,
  ): Pick<
    ReturnType<typeof createCliActionExecutorFromCredentials>,
    'execute' | 'replayApprovedApprovalRequest' | 'continueConfidentialApprovalRequest'
  > => {
    const invoke = async (
      actionId: Parameters<ReturnType<typeof createCliActionExecutorFromCredentials>['execute']>[0],
      input: unknown,
      context?: RpcActionExecutorContext,
      replay?: Parameters<ReturnType<typeof createCliActionExecutorFromCredentials>['replayApprovedApprovalRequest']>[0],
      confidential?: Readonly<{ input: unknown }>,
    ): Promise<ActionExecuteResult> => withApprovalActionTrace(actionId, () => timeApprovalPhase<ActionExecuteResult>('approval.daemon.invoke', async () => {
      context?.recordActionStartDiagnostic?.({ phase: 'credentialed_factory', requesterRuntimeBound: Boolean(requesterRuntime) });
      const trace = <T>(stage: string, operation: () => T | Promise<T>) => runTracedExternalActionStage(
        actionId, context?.actionRequestId, stage, operation);
      if (requesterAccountContext) {
        // The private opener already admitted this exact invocation at Home.
        // Keep custody live here; the reached native effect rechecks authority.
        if (!await trace('daemon.requester_currentness', () => (requesterAccountContext.isCustodyCurrent ?? requesterAccountContext.isCurrent)())
          || !await trace('daemon.requester_settings', () => requesterAccountContext.refreshAccountSettings(context?.signal ?? replay?.signal))) {
          const code = (context?.signal ?? replay?.signal)?.aborted ? 'cancelled' : 'not_authenticated';
          return { ok: false, errorCode: code, error: code };
        }
      } else if (requesterRuntime && !await trace('daemon.requester_settings', () => requesterRuntime.bootstrap.ensureAccountSettingsCurrent(context?.signal ?? replay?.signal))) {
        const code = (context?.signal ?? replay?.signal)?.aborted ? 'cancelled' : 'not_authenticated';
        return { ok: false, errorCode: code, error: code };
      }
      const readRequesterAccountSnapshot = () => {
        const snapshot = requesterAccountContext?.savedSecretOperationContext.readSnapshot();
        if (!snapshot) throw new Error('requester_account_context_retired');
        return snapshot;
      };
      let executionContext = context;
      let observedServerIdentityId: string | null = null;
      if (context?.externalActionExecutionAuthorization) {
        let origin: CurrentMachineExecutionOriginContext | null = null;
        try {
          origin =
            await measureActionStartPhaseV1(context, 'machine_origin', async () =>
              await params.resolveCurrentMachineExecutionOriginContext?.(context.signal) ?? null);
        } catch {
          origin = null;
        }
        if (
          !origin ||
          origin.machineId !== params.machineId ||
          origin.serverIdentityId !==
            context.externalActionExecutionAuthorization.binding
              .serverIdentityId
        ) {
          const cancelled = context.signal?.aborted === true;
          return {
            ok: false,
            errorCode: cancelled ? 'cancelled' : 'not_authenticated',
            error: cancelled ? 'cancelled' : 'not_authenticated',
          };
        }
        observedServerIdentityId = origin.serverIdentityId;
        const binding = context.externalActionExecutionAuthorization.binding;
        const movePacket = context.workspaceSyncSourceExecution;
        const setupPlanChild = (binding.actionId === 'machines.setup.plan' || binding.actionId === 'machines.setup.apply')
          && actionId === 'machines.setup.plan';
        // A Move child is deliberately SOURCE-bound. The receiving RPC owner
        // has already opened its exact requester/recipient custody; keep that
        // root while executing the reviewed child at this installed native owner.
        const admittedMoveChild = (binding.machineId !== params.machineId || setupPlanChild)
          && (binding.actionId === 'projects.service.relocate' || binding.actionId === 'discussion.second_opinion.start' && actionId === 'session.spawn_new'
            || binding.actionId === 'session.sections.archive' && actionId === 'session.stop' || setupPlanChild) && movePacket
          && context.machineAdmission?.machineId === params.machineId
          && context.machineAdmission.installationId === readInstallationIdentityIfExistsSync()?.installationId
          && context.machineAdmission.actorAccountId === binding.accountId
          && (!setupPlanChild || context.machineAdmission.role === 'manage')
          && context.verifyMachineAdmissionCurrent && await context.verifyMachineAdmissionCurrent()
          && movePacket.method === `${params.machineId}:${getActionSpec(actionId).bindings?.rpcMethod}`
          && movePacket.externalActionExecution.authorization.token === context.externalActionExecutionAuthorization.token
          && sameStrictJsonValue(movePacket.externalActionExecution.authorization.binding, binding)
          && sameStrictJsonValue(movePacket.originalActionEnvelope, context.originalActionEnvelope)
          && await (setupPlanChild ? isReviewedMachineSetupPlanChild : binding.actionId === 'session.sections.archive' ? isReviewedSessionSectionArchiveStopChild
            : binding.actionId === 'discussion.second_opinion.start' ? isReviewedSecondOpinionModelSpawnChild : isReviewedServiceMoveChild)({ authorization: context.externalActionExecutionAuthorization,
            envelope: context.originalActionEnvelope, actionId, machineId: params.machineId, params: input,
            ...(binding.actionId === 'session.sections.archive' ? { target: context.externalActionTarget } : {}),
            ...(context.signal ? { signal: context.signal } : {}) });
        if (setupPlanChild && movePacket && !admittedMoveChild) {
          return actionStartTargetUnavailableV1(context, 'credentialed_factory', 'target_binding_mismatch');
        }
        if (binding.machineId !== params.machineId && !admittedMoveChild) {
          const installation = readInstallationIdentityIfExistsSync();
          const target = context.externalActionTarget;
          if (!installation || !binding.sessionActionOrigin || !binding.sessionActionSource
            || binding.sessionActionSource.machineId !== params.machineId
            || binding.sessionActionSource.installationId !== installation.installationId
            || context.defaultSessionMachineId !== params.machineId
            || binding.actionId !== actionId || binding.requestId !== context.actionRequestId
            || target?.kind !== 'machine' || target.machineId !== binding.machineId
            || !isSessionActionCallerCurrent || !await isSessionActionCallerCurrent()) {
            return actionStartTargetUnavailableV1(context, 'credentialed_factory', 'target_binding_mismatch');
          }
          const result = await callExactMachineRpc({ credentials, machineId: binding.machineId,
            serverUrl: requesterRuntime?.bootstrap.serverHttpBaseUrl ?? params.serverBaseUrl,
            authorityCeiling: 'account_automation', method: getActionSpec(actionId).bindings?.rpcMethod ?? actionId,
            request: { v: 1, kind: 'targeted_action_rpc', target, input }, requestId: binding.requestId,
            timeoutMs: null, requireCurrentMachine: true,
            externalAction: { context, effectActionId: actionId,
              installationId: installation.installationId, privateKey: installation.privateKey },
            ...(context.signal ? { signal: context.signal } : {}) });
          if (result && typeof result === 'object' && 'errorCode' in result && typeof result.errorCode === 'string') {
            return { ok: false, errorCode: result.errorCode, error: result.errorCode };
          }
          return { ok: true, result };
        }
      }
      if (requiresPortableSessionSpawnServerIdentity(actionId, input)) {
        let origin: CurrentMachineExecutionOriginContext | null = null;
        try {
          origin =
            (await params.resolveCurrentMachineExecutionOriginContext?.(
              context?.signal,
            )) ?? null;
        } catch {
          origin = null;
        }
        if (!origin || origin.machineId !== params.machineId) {
          const cancelled = context?.signal?.aborted === true;
          return cancelled ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
            : actionStartTargetUnavailableV1(context, 'machine_origin', 'target_binding_mismatch');
        }
        observedServerIdentityId = origin.serverIdentityId;
        executionContext = {
          ...(context ?? {}),
          serverIdentityId: origin.serverIdentityId,
        };
      }
      if (!observedServerIdentityId && params.resolveCurrentMachineExecutionOriginContext) {
        // The connected Machine owner already holds this Home binding. Using
        // it for approval routing must not refresh the entire feature/catalog
        // projection on every unsigned Action; effect admission stays fresh.
        const origin = await params.resolveCurrentMachineExecutionOriginContext(context?.signal ?? replay?.signal)
          .catch(() => null);
        if (origin?.machineId === params.machineId) observedServerIdentityId = origin.serverIdentityId;
      }
      // Machine-sync owners can be replaced after the control listener
      // starts. Resolve their exact current adapters at the request
      // boundary rather than retaining a stale one.
      const hostExternalSessionAction =
        params.resolveExternalSessionHostAction?.();
      const currentSessionSpawnDirectTargetTransport =
        params.resolveSessionSpawnDirectTargetTransport?.();
      // A fresh managed continuation has a real, newly enrolled target.
      // Its ordinary remote transport must not reuse this controller's
      // exact local receiver. All other ingress keeps its existing binding.
      const resolvedSessionSpawnDirectTargetTransport =
        managedAgentStartMachineId !== undefined &&
        currentSessionSpawnDirectTargetTransport?.machineId !==
          managedAgentStartMachineId
          ? undefined
          : currentSessionSpawnDirectTargetTransport;
      const requesterSpawnCustody = requesterRuntime
        ? {
            machineAdmission: requesterRuntime.bootstrap.savedSecretOperationContext.machineAdmission,
            attribution: requesterRuntime.bootstrap.attribution,
            homeServerIdentityId: requesterRuntime.bootstrap.homeServerIdentityId,
            serverHttpBaseUrl: requesterRuntime.bootstrap.serverHttpBaseUrl,
            isCurrent: () => requesterRuntime.isCurrent(),
          }
        : requesterAccountContext
          ? {
              machineAdmission: {
                actorAccountId: requesterAccountContext.authorization.binding.accountId,
                custodianAccountId: requesterAccountContext.authorization.binding.custodianAccountId,
              },
              attribution: {
                serverId: params.serverId,
                accountId: requesterAccountContext.authorization.binding.accountId,
                machineId: requesterAccountContext.authorization.binding.machineId,
                installationId: requesterAccountContext.authorization.binding.installationId,
              },
              homeServerIdentityId: requesterAccountContext.authorization.binding.serverIdentityId,
              serverHttpBaseUrl: requesterAccountContext.serverHttpBaseUrl,
              isCurrent: () => requesterAccountContext.isCurrent(),
            }
          : null;
      const sessionSpawnDirectTargetTransport =
        requesterSpawnCustody && resolvedSessionSpawnDirectTargetTransport
          ? {
              ...resolvedSessionSpawnDirectTargetTransport,
              spawnedSession: {
                ...resolvedSessionSpawnDirectTargetTransport.spawnedSession,
                spawn: async (
                  ...args: Parameters<
                    typeof resolvedSessionSpawnDirectTargetTransport.spawnedSession.spawn
                  >
                ) => {
                  const prepared = await readRequesterHomeWithinActionLifetime(() => prepareRequesterSessionBootstrap({
                    credentials,
                    machineAdmission: requesterSpawnCustody.machineAdmission,
                    attribution: requesterSpawnCustody.attribution,
                    homeServerIdentityId: requesterSpawnCustody.homeServerIdentityId,
                    boundary: {
                      serverId: params.serverId,
                      serverHttpBaseUrl:
                        requesterSpawnCustody.serverHttpBaseUrl,
                      happyHomeDir: configuration.happyHomeDir,
                    },
                    verifyMachineAdmissionCurrent: () =>
                      requesterSpawnCustody.isCurrent(),
                    ...(args[1]?.signal ? { signal: args[1].signal } : {}),
                  }), args[1]?.signal);
                  if (!prepared)
                    return {
                      type: 'error',
                      errorCode:
                        SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                      errorMessage: 'Requester Session credential unavailable',
                      incompatibleTarget: { reason: 'requester_credentials_unavailable' },
                    };
                  try {
                    const result =
                      await resolvedSessionSpawnDirectTargetTransport.spawnedSession.spawn(
                        args[0],
                        {
                          ...args[1],
                          requesterSessionBootstrap: prepared.admitted,
                        },
                      );
                    if (
                      !result ||
                      typeof result !== 'object' ||
                      !('type' in result) ||
                      (result.type !== 'success' && result.type !== 'pending')
                    )
                      await prepared.cleanupOnFailure();
                    return result;
                  } catch (error) {
                    await prepared.cleanupOnFailure();
                    throw error;
                  }
                },
              },
            }
          : resolvedSessionSpawnDirectTargetTransport;
      const projectWorkerAction = params.resolveProjectWorkerAction?.();
      const apiMachineForSessions = params.getApiMachineForSessions();
      const resolveRequesterIngress = (context?: RpcActionExecutorContext, role: 'use' | 'manage' = 'use'): RpcHandlerContext | undefined => {
        // Replay restores the original private requester ports after constructing
        // this executor. Resolve them at the effect, not from approval.request.decide.
        const authorization = context?.externalActionExecutionAuthorization ?? requesterAccountContext?.authorization;
        const requester = readRequesterAccountActionContext(authorization) ?? requesterAccountContext;
        // Ordinary credentialed Session RPC already carries Home's verified
        // Machine ingress. Preserve it for the installed requester/runtime
        // owner; only that owner may select Account custody and assess readiness.
        if (!requester) {
          if (context?.machineAdmission && context.verifyMachineAdmissionCurrent)
            return { ...context, signal: context.signal ?? new AbortController().signal };
          const binding = authorization?.binding;
          const http = authorization?.requesterHttpProjection;
          const installation = externalActionInstallationIdentity;
          if (!authorization || !binding || role !== 'use' || !apiMachineForSessions || !installation || !http
            || !isManagedControllerCodecActionV1(binding) || binding.actionId !== actionId
            || binding.accountId === binding.custodianAccountId
            || binding.custodianAccountId !== readPreviewAccountIdFromToken(credentials.token)
            || binding.machineId !== params.machineId || binding.installationId !== installation.installationId
            || binding.serverIdentityId !== observedServerIdentityId
            || http.accountId !== binding.accountId || http.serverId !== params.serverId
            || http.serverIdentityId !== binding.serverIdentityId
            || http.accountEncryptionMode !== binding.accountEncryptionMode
            || !openManagedControllerActionCodecV1({ authorization, machineId: params.machineId,
              installationId: installation.installationId, serverIdentityId: binding.serverIdentityId,
              installationPrivateKey: decodeBase64(installation.privateKey, 'base64url') })) return undefined;
          return { signal: context?.signal ?? new AbortController().signal,
            machineAdmission: { actorAccountId: binding.accountId, custodianAccountId: binding.custodianAccountId,
              machineId: params.machineId, installationId: installation.installationId, role: 'use',
              encryptionMode: apiMachineForSessions.getMachineEncryptionMode() },
            callerInputAuthorization: authorization,
            verifyMachineAdmissionCurrent: async () => !context?.signal?.aborted
              && readInstallationIdentityIfExistsSync()?.installationId === installation.installationId
              && await http.isCurrent() && !context?.signal?.aborted,
          };
        }
        return requester && apiMachineForSessions ? {
          ...requesterAccountOperationContext(apiMachineForSessions, requester, role, context?.signal),
          ...(context?.machineAdmission ? { machineAdmission: context.machineAdmission,
            verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent } : {}),
          signal: context?.signal ?? new AbortController().signal,
          callerInputAuthorization: authorization,
          ...(context?.originalActionEnvelope ? { originalActionEnvelope: context.originalActionEnvelope } : {}),
          ...(context?.workspaceSyncSourceExecution ? { workspaceSyncSourceExecution: context.workspaceSyncSourceExecution } : {}),
          ...(context?.callerInputConstraints ? { callerInputConstraints: context.callerInputConstraints } : {}),
          ...(context?.authority ? { callerAuthority: context.authority } : {}),
          ...(context?.sessionActionOrigin ? { sessionActionOrigin: context.sessionActionOrigin } : {}),
          ...(context ? { localActionContext: {
            ...context,
            executionRunTargetMachineId: context.executionRunTargetMachineId ?? undefined,
            executionRunWorkflowRunId: context.executionRunWorkflowRunId ?? undefined,
          } } : {}),
        } : undefined;
      };
      const root = executionContext?.externalActionExecutionAuthorization;
      if (!requesterAccountContext && root && root.binding.accountId !== root.binding.custodianAccountId
        && isManagedControllerCodecActionV1(root.binding)) {
        const ingress = resolveRequesterIngress(executionContext);
        if (!ingress?.machineAdmission || !ingress.verifyMachineAdmissionCurrent
          || !await ingress.verifyMachineAdmissionCurrent()) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        executionContext = { ...executionContext, machineAdmission: ingress.machineAdmission,
          verifyMachineAdmissionCurrent: ingress.verifyMachineAdmissionCurrent, callerInputAuthorization: root };
      }
      const fallbackProjectAction = params.resolveProjectAction?.();
      let deploymentHomeId = observedServerIdentityId ?? executionContext?.serverIdentityId;
      const isDeploymentAction = isDeploymentActionIdV1(actionId);
      if (isDeploymentAction && !deploymentHomeId) {
        const origin = await params.resolveCurrentMachineExecutionOriginContext?.(executionContext?.signal);
        if (origin?.machineId === params.machineId) deploymentHomeId = origin.serverIdentityId;
      }
      if (isDeploymentAction && !deploymentHomeId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const deploymentDeps = (isDeploymentAction || actionId === 'approval.request.decide') && deploymentHomeId ? createDaemonDeploymentActionDeps({
        credentials, serverId: deploymentHomeId,
        ...(requesterAccountContext ? { savedSecretOperationContext: requesterAccountContext.savedSecretOperationContext }
          : requesterRuntime ? { savedSecretOperationContext: requesterRuntime.bootstrap.savedSecretOperationContext } : {}),
        serverHttpBaseUrl: requesterAccountContext?.serverHttpBaseUrl ?? requesterRuntime?.bootstrap.serverHttpBaseUrl ?? params.serverBaseUrl,
        machineId: params.machineId,
        readMachineVitals: () => params.readDoctorResourceVitals?.().sample ?? null,
        runtime: createOwnServerDeploymentRuntimeForHost({
          // The native receiver consumes only installation grants and the admitted
          // requester's source projection, never the controller's Account keys.
          credentials: params.credentials,
          credentialProfileId: params.serverId,
          serverId: deploymentHomeId, serverHttpBaseUrl: params.serverBaseUrl, machineId: params.machineId,
          acquirePluginRuntimeRegistryLease: acquireDaemonPluginRuntimeRegistryLease,
          assertInstalledCurrent: async () => {
            if (shutdownCancellationDomains.daemonWorkSignal.aborted
              || !sameStoredCredentials(params.credentials, await readStoredCredentialsForServerId(params.serverId))) {
              throw Object.assign(new Error('Installed deployment custody is no longer current'), { code: 'action_forbidden' });
            }
          },
          signal: shutdownCancellationDomains.daemonWorkSignal,
        }),
      }) : null;
      const fallbackRuntimeActionExecute = params.runtimeActionExecute;
      const projectAction: ActionExecutorDeps['projectAction'] = apiMachineForSessions
        ? async request => {
          const ingress = resolveRequesterIngress(request.context);
          if (!ingress) return fallbackProjectAction ? fallbackProjectAction(request)
            : { ok: false, errorCode: 'machine_admission_required', error: 'machine_admission_required' };
          const runtime = await apiMachineForSessions.resolveProjectFiniteRuntime(ingress);
          return runtime ? createProjectFiniteAction(runtime, ingress)(request)
            : { ok: false, errorCode: 'project_finite_execution_unavailable', error: 'project_finite_execution_unavailable' };
        } : fallbackProjectAction;
      const resolveInstalledObservationRuntime = async (context: ActionExecutorContext) => {
        if (!context.signal) return null;
        const runtime = await apiMachineForSessions?.resolveInstalledAccountObservationRuntime(context.signal);
        const origin = await params.resolveCurrentMachineExecutionOriginContext?.(context.signal);
        const homeId = context.externalActionExecutionAuthorization?.binding.serverIdentityId ?? context.serverIdentityId;
        return runtime && runtime.machineId === params.machineId && runtime.serverId === params.serverId
          && origin?.machineId === params.machineId && origin.serverIdentityId === homeId && await runtime.isCurrent?.() ? runtime : null;
      };
      const isInstalledManagedAccountCurrent = async (context: ActionExecutorContext, machine: import('@happier-dev/protocol').ManagedMachineV1) => {
        const runtime = await resolveInstalledObservationRuntime(context);
        return Boolean(runtime && runtime.accountId === machine.custodianAccountId
          && sameStoredCredentials(credentials, runtime.credentials) && await runtime.isCurrent?.());
      };
      const isManagedApprovalRequesterRuntimeCurrent = async (context: ActionExecutorContext, machine: import('@happier-dev/protocol').ManagedMachineV1) => {
        if (requesterAccountContext) return requesterAccountContext.isCurrent();
        if (requesterRuntime) return requesterRuntime.isCurrent();
        return isInstalledManagedAccountCurrent(context, machine);
      };
      const invocationApprovalCurrentness = requesterAccountContext
        ? createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
            credentials, machineId: params.machineId, serverId: params.serverId,
            serverApiUrl: requesterAccountContext.serverHttpBaseUrl, isSessionCallerCurrent,
            ...(params.workflowAcceptedAuthorizationCurrentness
              ? { isWorkflowRunAuthorizationCurrent: params.workflowAcceptedAuthorizationCurrentness } : {}),
            ...(params.resolveServerFeaturesSnapshot
              ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
          })
        : externalActionApprovalExecutionOriginCurrentness;
      const prepareInvocationApprovalExecutionAuthorization: NonNullable<import('@happier-dev/protocol/actions/executor/types').ActionExecutorDeps['prepareApprovalExecutionAuthorization']> = async ({ authorization, signal }) => {
        if ('credentialId' in authorization.binding) {
          // Artifact decoding drops private ports. Rebuild the same signed
          // HTTP custody used at ingress without lending Account credentials.
          const binding = authorization.binding;
          const installation = readInstallationIdentityIfExistsSync();
          const origin = await params.resolveCurrentMachineExecutionOriginContext?.(signal);
          if (!installation || installation.installationId !== binding.installationId
            || origin?.serverIdentityId !== binding.serverIdentityId
            || origin.machineId !== binding.machineId || binding.machineId !== params.machineId) return null;
          const projected = await projectExternalActionRequesterHttpAuthorization({ authorization,
            serverId: params.serverId, serverIdentityId: origin.serverIdentityId,
            serverHttpBaseUrl: params.serverBaseUrl, target: binding.target,
            installationId: installation.installationId, privateKey: installation.privateKey,
            ...(signal ? { signal } : {}),
          });
          return projected ? { authorization: projected } : null;
        }
        // Match first admission's custody classification. Session/Workflow
        // carriers retain their existing owners rather than borrowing this
        // installation's ordinary Account credentials.
        if (!authorization.requesterAccountContext && !isOriginalOwnAccountActionCustody(authorization.binding)) {
          const binding = authorization.binding;
          const requester = requesterAccountContext;
          if (!requester || !('authentication' in binding)
            || (binding.authentication.kind !== 'account' && binding.authentication.kind !== 'terminal')
            || binding.sessionActionOrigin || binding.workflowActionOrigin
            || binding.accountId !== requester.authorization.binding.accountId
            || binding.serverIdentityId !== requester.authorization.binding.serverIdentityId
            || binding.machineId !== params.machineId) return { authorization };
          // Stored approval provenance has no credential box. The deciding
          // invocation already holds this requester's admitted private custody;
          // rehydrate the unchanged root through the incumbent ingress owner.
          const installation = readInstallationIdentityIfExistsSync();
          if (!installation || installation.installationId !== binding.installationId) return null;
          const sealed = await requester.authorization.requesterAccountProjection?.sealRequesterAccountContext?.({
            authorization, purpose: { kind: 'external_action' },
            installationPublicKey: decodeBase64(installation.publicKey, 'base64url'),
          });
          if (!sealed) return null;
          authorization = sealed;
        }
        return await externalActionIngressOwner?.prepareRequesterAccountContext?.({ authorization,
          ...(signal ? { signal } : {}) }) ?? null;
      };
      const invocationContributedApprovalReplay = requesterAccountContext || externalActionContributedApprovalReplay
        ? createDaemonExternalActionContributedApprovalReplay({ credentials,
            isApprovalExecutionOriginCurrent: invocationApprovalCurrentness,
            prepareApprovalExecutionAuthorization: prepareInvocationApprovalExecutionAuthorization,
            resolvePreparedApprovalExecutionOriginCurrentness: authorization => {
              const source = readRequesterAccountActionContext(authorization);
              if (!source) return undefined;
              const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
                credentials: source.credentials, machineId: params.machineId, serverId: params.serverId,
                serverApiUrl: source.serverHttpBaseUrl, isSessionCallerCurrent,
                ...(params.resolveCurrentMachineExecutionOriginContext ? {
                  resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext,
                } : {}),
                ...(params.workflowAcceptedAuthorizationCurrentness ? {
                  isWorkflowRunAuthorizationCurrent: params.workflowAcceptedAuthorizationCurrentness,
                } : {}),
                ...(params.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
              });
              return currentness ? async args => await source.isCurrent() && await currentness(args) : undefined;
            },
            ...(apiMachineForSessions ? {
              observePluginExecution: observeContributedPluginExecution,
              createFileDownloadPublisher: source => apiMachineForSessions.createFileDownloadPublisher(params.serverId, source),
            } : {}),
          })
        : externalActionContributedApprovalReplay;
      const providerProjectionAccount = requesterAccountContext ? {
        operationContext: requesterAccountContext.savedSecretOperationContext,
        accountId: requesterAccountContext.authorization.binding.accountId,
        custodianAccountId: requesterAccountContext.authorization.binding.custodianAccountId,
        isCurrent: requesterAccountContext.isCurrent,
      } : requesterRuntime ? {
        operationContext: requesterRuntime.bootstrap.savedSecretOperationContext,
        accountId: requesterRuntime.bootstrap.attribution.accountId,
        custodianAccountId: requesterRuntime.bootstrap.savedSecretOperationContext.machineAdmission?.custodianAccountId,
        isCurrent: () => requesterRuntime.isCurrent(),
      } : null;
      const executor: ReturnType<
        typeof createCliActionExecutorFromCredentials
      > = await trace('daemon.cli_factory', () => createCliActionExecutorFromCredentials({
        ...(sessionStopEffect ? { sessionStop: sessionStopEffect } : {}),
        postWorkflowDiscussionMessage: createApprovedWorkflowDiscussionPublisher({
          credentials, machineId: params.machineId, serverId: params.serverId,
          serverUrl: requesterAccountContext?.serverHttpBaseUrl ?? requesterRuntime?.bootstrap.serverHttpBaseUrl ?? params.serverBaseUrl,
          callerAuthority: executionContext?.authority,
          isApprovalExecutionOriginCurrent: invocationApprovalCurrentness,
          resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext,
          executeSourceAction: (sourceActionId, sourceInput, sourceContext) => executor.execute(sourceActionId, sourceInput, sourceContext),
          getClient: () => params.getApiMachineForSessions(),
        }),
        postAgentDiscussionMessage: async (request, options) => {
          if (options?.approvedActionReplay?.artifactId && !('operation' in request)) {
            const serverHttpBaseUrl = requesterAccountContext?.serverHttpBaseUrl
              ?? requesterRuntime?.bootstrap.serverHttpBaseUrl ?? params.serverBaseUrl;
            if (!invocationApprovalCurrentness) return { v: 1, ok: false, error: 'discussion_post_denied' };
            return await createApprovedDiscussionAgentPublisher({ credentials,
              machineId: params.machineId, serverId: params.serverId, serverUrl: serverHttpBaseUrl,
              isApprovalExecutionOriginCurrent: invocationApprovalCurrentness,
              publish: (publication, publicationOptions) => params.getApiMachineForSessions()?.postAgentDiscussionMessage(publication, publicationOptions)
                ?? Promise.resolve({ v: 1, ok: false, error: 'discussions_unavailable' }),
              executeSourceAction: (sourceActionId, sourceInput, sourceContext) => executor.execute(sourceActionId, sourceInput, sourceContext),
            })(request, { ...options, approvedActionReplay: options.approvedActionReplay,
              callerAuthority: executionContext?.authority,
              ...(executionContext?.requesterApprovalDecision ? { requesterApprovalDecision: executionContext.requesterApprovalDecision } : {}),
            });
          }
          if (options?.approvedActionReplay?.artifactId) {
            const publication = prepareApprovedDiscussionAgentPublication({ request, replay: options.approvedActionReplay });
            if (!publication) return { v: 1, ok: false, error: 'discussion_post_denied' };
            const serverHttpBaseUrl = requesterAccountContext?.serverHttpBaseUrl
              ?? requesterRuntime?.bootstrap.serverHttpBaseUrl ?? params.serverBaseUrl;
            return await relayDiscussionAgentPublication(credentials, serverHttpBaseUrl,
              publication, options.signal);
          }
          return postAgentDiscussionMessage ? await postAgentDiscussionMessage(request, options)
            : { v: 1, ok: false, error: 'discussion_post_denied' };
        },
        credentials,
        clientActionExecute: createClientActionReverseDispatcher(() => params.getApiMachineForSessions()),
        ...(observedServerIdentityId ? { machineRecipesRead: createMachineRecipeReadAction({
          homeId: observedServerIdentityId, machineId: params.machineId,
          ...(apiMachineForSessions ? { readMachineMetadataSnapshot: () => apiMachineForSessions.getMachineMetadataSnapshot() } : {}),
          acquirePluginRuntimeRegistryLease: acquireDaemonPluginRuntimeRegistryLease,
          isCurrent: async readContext => {
            const origin = await params.resolveCurrentMachineExecutionOriginContext?.(readContext.signal);
            if (!origin || origin.machineId !== params.machineId || origin.serverIdentityId !== observedServerIdentityId) return false;
            const ingress = resolveRequesterIngress(readContext);
            return !ingress?.machineAdmission || ingress.machineAdmission.machineId === params.machineId
              && Boolean(ingress.verifyMachineAdmissionCurrent && await ingress.verifyMachineAdmissionCurrent());
          },
        }) } : {}),
        ...(apiMachineForSessions ? { runActionOperation: request => {
          const ingress = resolveRequesterIngress(request.context);
          const authorization = request.context.externalActionExecutionAuthorization;
          // Exact replay reopens the Move's requester, while this factory may
          // still belong to approval.request.decide. Its private readers retire
          // when that decision returns the accepted handle. Bind the operation
          // to the reopened root's executor; runHostActionOperation retains that
          // root until settlement, including its canonical child Actions.
          const moveExecutor = request.actionId === 'projects.service.relocate'
            && authorization?.binding.actionId === request.actionId
            && (!requesterAccountContext || authorization.token !== requesterAccountContext.authorization.token
              || !sameStrictJsonValue(authorization.binding, requesterAccountContext.authorization.binding))
            ? authorization.requesterAccountExecutor : undefined;
          return apiMachineForSessions.runActionOperation({ ...request, context: { ...request.context,
            ...(ingress?.machineAdmission ? { machineAdmission: ingress.machineAdmission,
              verifyMachineAdmissionCurrent: ingress.verifyMachineAdmissionCurrent } : {}),
            ...(ingress?.requesterSessionBootstrap ? { requesterSessionBootstrap: ingress.requesterSessionBootstrap } : {}),
          }, ...(moveExecutor ? { execute: operation => moveExecutor.execute('projects.service.relocate', request.input, operation) } : {}) });
        } } : {}),
        ...(apiMachineForSessions && actionId === 'machines.setup.plan' && input && typeof input === 'object'
          && !('targets' in input) && 'machineId' in input && input.machineId === params.machineId ? {
          machineSetupPlan: async request => {
            const origin = await params.resolveCurrentMachineExecutionOriginContext?.(request.signal ?? request.context.signal);
            if (!origin || origin.machineId !== params.machineId) return { ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable' };
            const ingress = resolveRequesterIngress(request.context, 'manage');
            const { createMachineSetupPlanAction } = await import('@/machines/setup/machineSetupAction');
            return createMachineSetupPlanAction({ apiMachine: apiMachineForSessions, machineId: params.machineId,
              ...(externalActionInstallationIdentity ? { installation: externalActionInstallationIdentity } : {}),
              homeId: origin.serverIdentityId, acquirePluginRuntimeRegistryLease: acquireDaemonPluginRuntimeRegistryLease })({ ...request,
                context: { ...request.context, ...(ingress?.machineAdmission ? { machineAdmission: ingress.machineAdmission,
                  verifyMachineAdmissionCurrent: ingress.verifyMachineAdmissionCurrent } : {}) } });
          },
        } : {}),
        // Only an authenticated native child reaches this singleton adapter.
        // Ordinary full-list roots retain the canonical composer dependency.
        ...(apiMachineForSessions && actionId === 'machines.setup.apply' && input && typeof input === 'object'
          && 'machineId' in input && input.machineId === params.machineId
          && 'targets' in input && Array.isArray(input.targets) && input.targets.length === 1
          && executionContext?.externalActionExecutionAuthorization
          && (executionContext.actionCaller?.kind === 'workflowRun'
            || executionContext.externalActionExecutionAuthorization.binding.managedContinuation) ? {
          machineSetupApply: async request => {
            const target = request.input.targets[0];
            if (request.input.targets.length !== 1 || !target || target.machineId !== params.machineId
              || request.input.machineId !== target.machineId || request.input.homeId !== target.homeId) {
              return { ok: false as const, errorCode: 'target_mismatch', error: 'target_mismatch' };
            }
            const origin = await params.resolveCurrentMachineExecutionOriginContext?.(request.signal ?? request.context.signal);
            if (!origin || !externalActionInstallationIdentity || origin.machineId !== params.machineId) return { ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable' };
            const ingress = resolveRequesterIngress(request.context, 'manage');
            const { createMachineSetupAction } = await import('@/machines/setup/machineSetupAction');
            return createMachineSetupAction({ apiMachine: apiMachineForSessions, machineId: params.machineId,
              homeId: origin.serverIdentityId, installation: externalActionInstallationIdentity, ownerRemainder })({ ...request, input: target,
                context: { ...request.context, ...(ingress?.machineAdmission ? { machineAdmission: ingress.machineAdmission,
                  verifyMachineAdmissionCurrent: ingress.verifyMachineAdmissionCurrent } : {}) } });
          },
        } : {}),
        ...(requesterAccountContext ? { savedSecretOperationContext: requesterAccountContext.savedSecretOperationContext } : {}),
        ...(providerProjectionAccount && params.projectProviderModelsForAccount
          && providerProjectionAccount.custodianAccountId
          && providerProjectionAccount.accountId !== providerProjectionAccount.custodianAccountId ? {
            projectModelsForAccount: async (request, actionContext) => {
              const signal = actionContext.signal ?? new AbortController().signal;
              const isCurrent = async () => !signal.aborted && !isRuntimePublicationQuiescing()
                && await providerProjectionAccount.isCurrent()
                && await providerProjectionAccount.operationContext.isCurrent(signal);
              if (!await isCurrent()) return { status: 'error', error: createForegroundProviderError('provider_authorization_changed') };
              const { purposes } = createRequesterConnectedAccountPurposeBindingRuntime({
                operationContext: providerProjectionAccount.operationContext,
                accountId: providerProjectionAccount.accountId, machineId: params.machineId,
                reloadController: pluginRuntimeController, isCurrent,
                getAccountEncryptionMode: async options => (await fetchAccountEncryptionCurrentness({ token: providerProjectionAccount.operationContext.credentials.token,
                  serverBaseUrl: providerProjectionAccount.operationContext.serverHttpBaseUrl, ...(options?.signal ? { signal: options.signal } : {}) })).mode,
                subscribe: () => ({ dispose() {} }),
                allowNativeAccountCredentials: false,
                resolveQualifiedConnectedAccountV4Support: () => params.resolveQualifiedConnectedAccountV4Support?.() ?? 'indeterminate',
              });
              return await params.projectProviderModelsForAccount!(request, {
                getAccountSettingsSnapshot: providerProjectionAccount.operationContext.readSnapshot,
                resolveManagedPurposeBindingIntent: purposes.resolveBindingIntent,
                resolveManagedPurposeBindingIntentSelection: purposes.resolveBindingIntentSelection,
                savedSecretOperationContext: providerProjectionAccount.operationContext,
                managedRuntimeAccount: {
                  readCredentials: async () => await isCurrent() ? providerProjectionAccount.operationContext.credentials : null,
                  connectedAccountsOwner: purposes,
                  operationAuthority: createManagedProviderOperationAuthority({
                    materializationBaseDir: join(configuration.happyHomeDir, 'providers', 'managed-operation-auth'),
                    purposeBindingOwner: purposes, requestAuthRegistry: connectedAccountRequestAuthRegistry,
                    resolveRequestAuthHttpPort: requireConnectedAccountRequestAuthHttpPort,
                    createRedactionLease: () => createProviderRedactionLease({ values: [] }),
                  }),
                  resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId: params.machineId,
                    readAccountId: () => providerProjectionAccount.accountId,
                    readOrigin: async () => await isCurrent()
                      ? await params.resolveCurrentMachineExecutionOriginContext?.(signal) ?? null : null }),
                },
                accountReadScope: {
                  serverUrl: providerProjectionAccount.operationContext.serverHttpBaseUrl,
                  readCredentials: async () => providerProjectionAccount.operationContext.credentials,
                  readAccountSettingsSnapshot: async () => providerProjectionAccount.operationContext.readSnapshot(),
                  isCurrent,
                },
                signal, isCurrent,
              });
            },
          } : {}),
        ...(requesterRuntime
          ? { requesterSessionBootstrap: requesterRuntime.bootstrap }
          : {}),
        ...(projectAction ? { projectAction } : {}),
        ...(deploymentDeps ? { deploymentAction: deploymentDeps.deploymentAction,
          deploymentTemplateInstantiate: deploymentDeps.deploymentTemplateInstantiate,
          prepareDeploymentTemplateInstantiation: deploymentDeps.prepareDeploymentTemplateInstantiation,
          resolveEnvironmentApprovalScope: deploymentDeps.resolveEnvironmentApprovalScope,
          prepareDeploymentAction: deploymentDeps.prepareDeploymentAction } : {}),
        ...(projectWorkerAction ? { projectWorkerAction } : {}),
        ...(apiMachineForSessions
          ? {
              projectDefinitionAction: request =>
                apiMachineForSessions.createProjectDefinitionAction(
                  params.serverId,
                  resolveRequesterIngress(request.context),
                )(request),
            }
          : {}),
        ...(apiMachineForSessions
          ? {
              filesystemActionExecute:
                apiMachineForSessions.createFilesystemActionExecutor(
                  params.serverId,
                ),
              workspaceFilesReplace: apiMachineForSessions.createWorkspaceFileReplaceActionExecutor(params.serverId),
              workspaceFilesReplacePreview: apiMachineForSessions.createWorkspaceFileReplacePreviewActionExecutor(params.serverId),
              languageIntelligenceApply: apiMachineForSessions.createLanguageIntelligenceApplyActionExecutor(params.serverId),
              skillMachineActionExecute: apiMachineForSessions.createMachineSkillActionExecutor({ credentials,
                ...(requesterAccountContext ? { operationContext: requesterAccountContext.savedSecretOperationContext } : {}) }),
            }
          : {}),
        ...(getCurrentTurnWorkDepth ? { getCurrentTurnWorkDepth } : {}),
        readCredentials: requesterAccountContext
          // Admission and native-effect boundaries own fresh Home proof. Reading
          // this invocation's captured credentials only needs its live custody.
          ? async () => await (requesterAccountContext.isCustodyCurrent ?? requesterAccountContext.isCurrent)() ? credentials : null
          : requesterRuntime
          ? async () =>
              (await requesterRuntime.isCurrent())
                ? credentials
                : null
          : async () => await readStoredCredentialsForServerId(params.serverId),
        ...(requesterAccountContext
          ? { actionsSettingsProvider: {
              getActionsSettings: () => readRequesterAccountSnapshot().settings.actionsSettingsV1,
              getAccountSettings: () => readRequesterAccountSnapshot().settings,
              getAccountRoleOverrides: () => readAccountRoleOverridesFromSnapshot(readRequesterAccountSnapshot()),
            } }
          : requesterRuntime
          ? {
              actionsSettingsProvider: {
                getActionsSettings: () =>
                  requesterRuntime.readAccountSettingsSnapshot().settings.actionsSettingsV1,
                getAccountSettings: () =>
                  requesterRuntime.readAccountSettingsSnapshot().settings,
                getAccountRoleOverrides: () =>
                  readAccountRoleOverridesFromSnapshot(
                    requesterRuntime.readAccountSettingsSnapshot(),
                  ),
              },
            }
          : {}),
        serverId: params.serverId,
        serverApiUrl: requesterAccountContext?.serverHttpBaseUrl ?? params.serverBaseUrl,
        ...(managedPolicyAction
          ? { machineId: params.machineId, hostActionApprovalLifetime: managedPolicyAction.hostActionApprovalLifetime }
          : {}),
        ...(observedServerIdentityId
          ? { serverIdentityId: observedServerIdentityId }
          : {}),
        ...(params.resolveServerFeaturesSnapshot
          ? {
              resolveServerFeaturesSnapshot:
                params.resolveServerFeaturesSnapshot,
            }
          : {}),
        ...(externalActionInstallationIdentity
          ? {
              externalActionMachineRequestPrivateKey:
                externalActionInstallationIdentity.privateKey,
              externalActionMachineInstallationId:
                externalActionInstallationIdentity.installationId,
            }
          : {}),
        pluginActionExecutionOwner: 'current_process',
        ...accountPluginActions,
        ...(params.pluginChangeService ? { pluginChangeService: params.pluginChangeService } : {}),
        revalidatePluginActionCallerMaterialization: async (reference) => {
          const lease = await acquireDaemonPluginRuntimeRegistryLease();
          try {
            const current = lease.resolveCurrentPluginMaterializationRef?.(reference.pluginId) ?? null;
            return current !== null && arePluginMachineMaterializationRefsEqual(current, reference);
          } finally { await lease.release(); }
        },
        revalidatePluginActionCallerOccurrence: async (caller) => {
          const lease = await acquireDaemonPluginRuntimeRegistryLease();
          try {
            const current = lease.registry.readPluginOccurrenceId?.(caller.pluginId);
            return current != null && current === caller.occurrenceId
              && lease.registry.isPluginOccurrenceCurrent?.(caller.pluginId, current) === true;
          } finally { await lease.release(); }
        },
        managedMachineAction: managedPolicyAction?.managedMachineAction ?? createDaemonManagedMachineActionAdapter({
          credentials,
          machineId: params.machineId,
          serverBaseUrl: params.serverBaseUrl,
          serverId: params.serverId,
          subscribeManagedMachineChanges: listener => {
            const apiMachine = params.getApiMachineForSessions();
            if (!apiMachine) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
            return apiMachine.onManagedMachinePolicyInvalidated(listener);
          },
          subscribeEnvironmentSetupChanges: async (context, callbacks) => {
            const runtime = await resolveInstalledObservationRuntime(context);
            if (!runtime)
              throw Object.assign(new Error('controller_unavailable'), { code: 'controller_unavailable' });
            return observeAccountChanges({ token: runtime.credentials.token, serverUrl: runtime.serverHttpBaseUrl }, callbacks);
          },
          executeEnvironmentSetup: async (machine, context, isCurrent) => {
            if (!machine.enrolledMachineId || !machine.preset || !machine.machineSetup) return { ok: false, errorCode: 'intent_changed', error: 'intent_changed' };
            const preset = machine.preset;
            const setup = machine.machineSetup.setup;
            const target = { homeId: machine.homeId, machineId: machine.enrolledMachineId };
            const authorization = context.externalActionExecutionAuthorization;
            if (authorization) {
              if (!externalActionInstallationIdentity || machine.homeId !== authorization.binding.serverIdentityId
                || machine.controller.machineId !== authorization.binding.machineId
                || machine.controller.installationId !== authorization.binding.installationId) return { ok: false, errorCode: 'intent_changed', error: 'intent_changed' };
              const controllerCustody = authorization.binding.accountId !== authorization.binding.custodianAccountId;
              const encryption = authorization.binding.accountEncryptionMode === 'e2ee' && !controllerCustody
                ? await (requesterAccountContext ? requesterAccountContext.resolveEncryption : externalActionIngressOwner?.resolveEncryption)?.(context.signal, authorization) : undefined;
              if (!controllerCustody && authorization.binding.accountEncryptionMode === 'e2ee' && encryption?.serverIdentityId !== authorization.binding.serverIdentityId)
                return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
              const child = { serverId: params.serverId, authorization, authority: context.authority, invocation: readManagedChildInvocation(context),
                continuation: { managedId: machine.id, creationRequestId: authorization.binding.requestId, expectedIntentRevision: machine.intentRevision },
                installationId: externalActionInstallationIdentity.installationId, privateKey: externalActionInstallationIdentity.privateKey,
                serverHttpBaseUrl: params.serverBaseUrl, ...(encryption ? { material: encryption.material } : {}), ...(context.signal ? { signal: context.signal } : {}) };
              const input = await prepareManagedMachineSetupApplyInput({ target, creation: { preset, setup }, isCurrent,
                readPlan: input => dispatchManagedMachineSetupPlan({ ...child, input, retainedCreationSetup: { preset, setup } }) });
              if ('ok' in input) return input;
              if (!await isCurrent()) return { ok: false, errorCode: 'intent_changed', error: 'intent_changed' };
              return dispatchManagedMachineSetup({ ...child, input });
            }
            const local = { context, credentials, custodianAccountId: machine.custodianAccountId,
              serverHttpBaseUrl: params.serverBaseUrl, isCurrent: async () => await isCurrent()
                && await isInstalledManagedAccountCurrent(context, machine) };
            const input = await prepareManagedMachineSetupApplyInput({ target, creation: { preset, setup }, isCurrent: local.isCurrent,
              readPlan: input => dispatchLocalManagedMachineSetupPlan({ ...local, input, retainedCreationSetup: { preset, setup } }) });
            if ('ok' in input) return input;
            if (!await local.isCurrent()) return { ok: false, errorCode: 'intent_changed', error: 'intent_changed' };
            return dispatchLocalManagedMachineSetup({ ...local, input });
          },
          preflightSessionStart: async (context: RpcActionExecutorContext) => {
            const root = context.externalActionExecutionAuthorization?.binding;
            if (
              !root ||
              root.actionId !== 'machines.managed.acquire' ||
              root.machineId !== params.machineId ||
              root.installationId !==
                externalActionInstallationIdentity?.installationId ||
              root.requestId !== context.actionRequestId ||
              !root.accountEncryptionMode
            )
              return false;
            if (root.sessionActionOrigin) {
              const requesterHttp = context.externalActionExecutionAuthorization?.requesterHttpProjection;
              const admission = context.machineAdmission;
              // The captured HTTP owner already applies accepted-continuation
              // currentness; an ended source turn must not impose a new cutoff.
              const requesterCurrent = isSessionActionCallerCurrent
                ? true
                : Boolean(admission && context.verifyMachineAdmissionCurrent
                  && admission.machineId === root.machineId
                  && admission.installationId === root.installationId
                  && admission.actorAccountId === root.accountId
                  && admission.custodianAccountId === root.custodianAccountId
                  && await context.verifyMachineAdmissionCurrent());
              if (!root.sessionActionSource || !requesterCurrent
                || readPreviewAccountIdFromToken(credentials.token) !== root.accountId
                || !requesterHttp || requesterHttp.accountId !== root.accountId
                || requesterHttp.serverIdentityId !== root.serverIdentityId
                || requesterHttp.accountEncryptionMode !== root.accountEncryptionMode
                || !await requesterHttp.isCurrent()) return false;
            }
            const controllerCustody = root.accountId !== root.custodianAccountId;
            const encryption =
              root.accountEncryptionMode === 'e2ee' && !controllerCustody
                ? await (requesterAccountContext ? requesterAccountContext.resolveEncryption : externalActionIngressOwner?.resolveEncryption)?.(
                    context.signal,
                    context.externalActionExecutionAuthorization,
                  )
                : undefined;
            return (
              (controllerCustody || root.accountEncryptionMode === 'plain' ||
                encryption?.serverIdentityId === root.serverIdentityId) &&
              isManagedSessionStartTransportAvailable({
                authorization: context.externalActionExecutionAuthorization,
                installationId: root.installationId,
                ...(encryption ? { material: encryption.material } : {}),
              })
            );
          },
          executeSessionStart: async (input, context, machine) => {
            const authorization = context.externalActionExecutionAuthorization;
            if (authorization) {
              if (
                !externalActionInstallationIdentity ||
                machine.homeId !== authorization.binding.serverIdentityId ||
                machine.controller.machineId !==
                  authorization.binding.machineId ||
                machine.controller.installationId !==
                  authorization.binding.installationId ||
                machine.enrolledMachineId !== input.executionTarget.machineId
              ) {
                return {
                  ok: false,
                  errorCode: 'intent_changed',
                  error: 'intent_changed',
                };
              }
              const controllerCustody = authorization.binding.accountId !== authorization.binding.custodianAccountId;
              const encryption =
                authorization.binding.accountEncryptionMode === 'e2ee' && !controllerCustody
                  ? await (requesterAccountContext ? requesterAccountContext.resolveEncryption : externalActionIngressOwner?.resolveEncryption)?.(
                      context.signal,
                      authorization,
                    )
                  : undefined;
              if (
                !controllerCustody && authorization.binding.accountEncryptionMode === 'e2ee' &&
                encryption?.serverIdentityId !==
                  authorization.binding.serverIdentityId
              ) {
                return {
                  ok: false,
                  errorCode: 'admission_unavailable',
                  error: 'admission_unavailable',
                };
              }
              return await dispatchManagedSessionStart({
                input,
                authorization,
                authority: context.authority,
                invocation: readManagedChildInvocation(context),
                continuation: {
                  managedId: machine.id,
                  creationRequestId: authorization.binding.requestId,
                  expectedIntentRevision: machine.intentRevision,
                },
                serverHttpBaseUrl: params.serverBaseUrl,
                installationId:
                  externalActionInstallationIdentity.installationId,
                privateKey: externalActionInstallationIdentity.privateKey,
                ...(encryption ? { material: encryption.material } : {}),
                ...(context.signal ? { signal: context.signal } : {}),
              });
            }
            return await createExternalActionExecutor(
              credentials,
              getCurrentTurnWorkDepth,
              isSessionActionCallerCurrent,
              input.executionTarget.machineId,
              requesterRuntime,
            ).execute('session.spawn_new', projectSessionSpawnNewActionInputV2(input), context);
          },
          observeSessionStartApproval: createManagedSessionStartApprovalObserver({
            credentials, machineId: params.machineId,
            observeRecordedApprovalExecution: args => executor.observeRecordedApprovalExecution(args),
            isRequesterRuntimeCurrent: isManagedApprovalRequesterRuntimeCurrent,
          }),
          observeEnvironmentSetupApproval: createManagedSessionStartApprovalObserver({
            actionId: 'machines.setup.apply', credentials, machineId: params.machineId,
            observeRecordedApprovalExecution: args => executor.observeRecordedApprovalExecution(args),
            isRequesterRuntimeCurrent: isManagedApprovalRequesterRuntimeCurrent,
          }),
          observeEnrollmentPolicyApproval: request => createManagedSessionStartApprovalObserver({
            actionId: request.actionId, credentials, machineId: params.machineId,
            observeRecordedApprovalExecution: args => executor.observeRecordedApprovalExecution(args),
            isRequesterRuntimeCurrent: isManagedApprovalRequesterRuntimeCurrent,
          })(request),
          observeActionExecution: request => {
            if (!apiMachineForSessions) return Promise.resolve({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
            const rpcContext = resolveRequesterIngress(executionContext);
            return apiMachineForSessions.observeActionExecution({ ...request, ...(rpcContext ? { rpcContext } : {}) });
          },
          resolveCurrentMachineExecutionOriginContext:
            params.resolveCurrentMachineExecutionOriginContext,
          installationIdentity: externalActionInstallationIdentity,
          managedProviderOperationAuthority:
            params.managedProviderOperationAuthority,
          acquireRuntimeRegistryLease:
            acquireDaemonPluginRuntimeRegistryLease,
        }),
        ...(fallbackRuntimeActionExecute
          ? { runtimeActionExecute: async request => {
              const family = resolveRuntimeActionExecutionFamily(request.actionId);
              if (family !== 'localServices' && family !== 'browser') {
                return fallbackRuntimeActionExecute(request);
              }
              const ingress = resolveRequesterIngress(request.context);
              if (!ingress) return fallbackRuntimeActionExecute(request);
              if (family === 'browser') {
                const context: RpcActionExecutorContext = { ...request.context,
                  machineAdmission: ingress.machineAdmission,
                  verifyMachineAdmissionCurrent: ingress.verifyMachineAdmissionCurrent,
                  ...(ingress.callerInputAuthorization
                    ? { externalActionExecutionAuthorization: ingress.callerInputAuthorization } : {}),
                };
                return fallbackRuntimeActionExecute({ ...request, context });
              }
              await localServicesActionFeatureGate.refresh();
              return createLocalServicesDaemonRuntimeActionExecutor({
                routes: localServicesRuntimeActionRoutes,
                ingress,
                featureGate: localServicesActionFeatureGate,
                prepareStartAction: (input, startContext) =>
                  executor.prepare('localServices.launcher.start', input, startContext),
              })(request);
            } }
          : {}),
        prepareLocalServiceStartApproval: async ({ input, context, executeCanonicalAction }) => {
          const ingress = resolveRequesterIngress(context);
          await localServicesActionFeatureGate.refresh();
          const prepare = localServicesRuntime.launcherRoutes.prepareStartApproval;
          if (!ingress || !prepare || !localServicesActionFeatureGate.isEnabled('localServices.launcher')) return {
            ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable',
          };
          return prepare(input, ingress, context, executeCanonicalAction);
        },
        machineGuardAction: async request => {
          const apiMachine = params.getApiMachineForSessions();
          return apiMachine ? apiMachine.executeMachineGuardAction(request)
            : { ok: false, errorCode: 'scope-retired', error: 'scope-retired' };
        },
        ...(params.workflowAcceptedAuthorizationCurrentness
          ? {
              workflowAcceptedAuthorizationCurrentness:
                params.workflowAcceptedAuthorizationCurrentness,
            }
          : {}),
        invokeContributedAction: request => externalActionContributedInvoker!({ ...request,
          context: { ...request.context, ...(apiMachineForSessions ? {
            prepareFileDownload: apiMachineForSessions.createFileDownloadPublisher(params.serverId, request.context),
          } : {}) },
        }),
        targetActionApprovalReplay: invocationContributedApprovalReplay!,
        isApprovalExecutionOriginCurrent: invocationApprovalCurrentness,
        prepareApprovalExecutionAuthorization: prepareInvocationApprovalExecutionAuthorization,
        ...(requesterAccountContext && actionId === 'approval.request.decide'
          && (replay?.artifactId || input && typeof input === 'object' && 'artifactId' in input && typeof input.artifactId === 'string')
          ? { bindApprovedApiTokenExecution: execute => createApprovedApiTokenExecutionPreparer({
              requester: requesterAccountContext,
              artifactId: replay?.artifactId ?? (input as { artifactId: string }).artifactId,
              authority: executionContext?.authority,
              ...(executionContext?.surface ? { surface: executionContext.surface } : {}),
              ...(executionContext?.signal ? { signal: executionContext.signal } : {}),
              execute,
            }) } : {}),
        listContributedActionDefinitions:
          externalActionContributedDefinitionLister!,
        inputTypeDeps: createCommittedInputTypeDeps(),
        ...(hostExternalSessionAction ? { hostExternalSessionAction } : {}),
        ...(params.externalSessionPluginAdmissionOwner
          ? {
              externalSessionPluginAdmissionOwner:
                params.externalSessionPluginAdmissionOwner,
            }
          : {}),
        ...(sessionSpawnDirectTargetTransport
          ? { sessionSpawnDirectTargetTransport }
          : {}),
        ...(apiMachineForSessions
          ? {
              sessionActionRpcTransport: async (request) => {
                if (request.executionAuthorization) {
                  return await apiMachineForSessions.callSessionActionRpc(request);
                }
                const current = isSessionActionCallerCurrent
                  ? await isSessionActionCallerCurrent()
                  : await isSessionCallerCurrent({
                      caller: request.origin.caller,
                      signal: request.signal,
                    });
                if (!current)
                  throw Object.assign(new Error('target_unavailable'), {
                    code: 'target_unavailable',
                  });
                return await apiMachineForSessions.callSessionActionRpc(
                  request,
                );
              },
              machineActionDirectTargetTransport: {
                machineId: params.machineId,
                machineServiceAction: request => apiMachineForSessions.executeMachineServiceAction(request),
                openProject: async (input, context) => {
                  const ingress = resolveRequesterIngress(context);
                  if (!ingress?.machineAdmission || !ingress.verifyMachineAdmissionCurrent) {
                    return { kind: 'refused', code: 'machine_admission_required' };
                  }
                  return await apiMachineForSessions.callProjectOpen({ input, rpcContext: ingress,
                    context: { ...context, machineAdmission: ingress.machineAdmission,
                      verifyMachineAdmissionCurrent: ingress.verifyMachineAdmissionCurrent } });
                },
                invoke: async (method, request, options) => {
                  const ingress = resolveRequesterIngress(options?.localActionContext ?? executionContext);
                  return await apiMachineForSessions
                    .invokeLocalMachineAction(method, request, { ...options,
                      ...(ingress ? { rpcContext: ingress } : {}),
                      ...(options?.localActionContext ?? ingress?.localActionContext
                        ? { localActionContext: options?.localActionContext ?? ingress?.localActionContext } : {}),
                    });
                },
              },
            }
          : {}),
        ...(apiMachineForSessions
          ? {
              machineAdmissionTransport: async (request, options) =>
                await apiMachineForSessions.enqueueSessionPendingByMachine(
                  request,
                  options,
                ),
            }
          : {}),
        transcriptFollowLeaseRegistry:
          externalActionTranscriptFollowLeaseRegistry!,
      }));
      const executeAccepted = async (acceptedContext: ActionExecutorContext | undefined) => {
        const release = requesterAccountContext?.retain();
        try {
          const execute = () => confidential
            ? executor.continueConfidentialApprovalRequest(confidential.input, acceptedContext)
            : replay ? executor.replayApprovedApprovalRequest(replay)
              : executor.execute(actionId, input, acceptedContext);
          return requesterAccountContext
            ? await runWithServerHttpBaseUrl(requesterAccountContext.serverHttpBaseUrl,
              execute)
            : await execute();
        } finally { await timeApprovalPhase('approval.daemon.requester_release', () => release?.()); }
      };
      // Native owners, including Project finite execution, attach observation
      // after approval. Recording an Ask here caches its receipt as execution.
      return await executeAccepted(executionContext);
    }), replay?.artifactId, context?.actionRequestId);
    return {
      execute: (actionId, input, context) => invoke(actionId, input, context),
      // Keep the private operand on its existing continuation owner, with the same
      // captured Home, native dependencies and requester lifetime as ordinary admission.
      continueConfidentialApprovalRequest: (input, context) => invoke('approval.request.decide', undefined,
        context, undefined, { input }),
      // The existing replay owner loads and rechecks the immutable native origin;
      // the fresh reviewer context supplies custody, not a replacement native root.
      replayApprovedApprovalRequest: args => invoke('approval.request.decide', undefined,
        { ...(args.signal ? { signal: args.signal } : {}),
          ...(args.callerAuthority ? { authority: args.callerAuthority } : {}) }, args),
    };
  };
  return createExternalActionExecutor;
}
