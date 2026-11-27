import { createSessionFollowActionDeps } from '@/api/sessionFollowActionDeps';
import type { CliReceivingMachineSetupPlan } from './cliActionDeps/types';
import { createSessionReadStateActionDeps } from '@/api/sessionReadStateActionDeps';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { awaitCliActionResult } from './awaitCliActionResult';
import {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
} from '@/api/session/followSessionTranscript';
import {
  executeCliTranscriptAction,
  type CliTranscriptActionExecutorOptions,
} from './executeCliTranscriptAction';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import {
  hasStoredSessionCredentialProvenance,
  type StoredCredentials,
} from '@/persistence';
import { createDaemonPluginActionExecutor, createPluginActionExecutor, isPluginActionExecutionDispatchId, readPluginActionExecutionReference, type PluginActionExecutionRequestOwner } from './createDaemonPluginActionExecutor';
import { createCommittedContributedActionSchemaReader, createCommittedInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import type { CliActionExactHomeTarget } from './createCliActionDeps';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createCliLocalServiceClientActionExecutor } from './cliActionDeps/localServices';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps, RuntimeActionExecute, ActionId } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { relaysWorkflowDeploymentBackup } from './controllerDeploymentDispatch';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';
import type { AccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliPersonalSavedSecretActionExecute } from '@/settings/secrets/personalSavedSecretActionHost';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import type { ResolveSpawnConnectedServicesTeamResourceCatalog } from '@/session/services/spawnConnectedServicesDefaults';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { isFilesystemActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readExternalActionBindingAuthority, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { readHostAdmittedBackupReceiverSetupApplyV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { executeOriginalAccountRequesterOperation, prepareOriginalAccountPresetAcquire, projectExternalActionRequesterHttpAuthorization, readExternalActionRequesterInvocation } from '@/api/externalActionExecutionAuthorization';
import { answerAdmittedManagedAcquireSignIn } from '@/machines/managed/installationResponse';
import { ManagedMachineActionIdV1Schema, isManagedRetainedControlInvocation } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolveManagedControlControllerTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import { MANAGED_ACQUIRE_ACTION_ID_V1, MANAGED_LIST_ACTION_ID_V1, MANAGED_RETIRE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { actionStartTargetUnavailableV1, isAgentStartActionInvocationV1, measureActionStartPhaseV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { isManagedControllerCodecRootV1, openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readRetainedVerifiedExternalActionRequester, retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { ReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ACTION_ID_FAMILIES_V1, isReviewNewRoundRunActionV1, isReviewRecordWriteActionIdV1, isReviewTriageRunActionV1 } from '@happier-dev/protocol/actions/actionIds';
import { canUseLocalRuntimeReviewAccount } from '@/daemon/lifecycle/requesterWorkAttribution';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutorHarness>[0]
  & CliTranscriptActionExecutorOptions
  & Readonly<{
    runtimeActionExecute?: RuntimeActionExecute;
    /** Daemon-owned finite broker transport retained by Account child execution. */
    executeTeamCredentialBrokerAction?: import('@/plugins/runtime/accountExecutionRuntime').AccountExecutionRuntimeInput['executeTeamCredentialBrokerAction'];
    prepareLocalServiceStartApproval?: ActionExecutorDeps['prepareLocalServiceStartApproval'];
    clientActionExecute?: ActionExecutorDeps['clientActionExecute'];
    machineManagedInstallationRespond?: ActionExecutorDeps['machineManagedInstallationRespond'];
    confidentialSecretFill?: ActionExecutorDeps['confidentialSecretFill'];
    confidentialActionInputs?: ActionExecutorDeps['confidentialActionInputs'];
    /** Bound by the live Session/Run host; private and deferred operations retain Artifact custody. */
    sessionActionConfirmation?: ActionExecutorDeps['sessionActionConfirmation'];
    hostActionApprovalLifetime?: ActionExecutorDeps['hostActionApprovalLifetime'];
    runActionOperation?: ActionExecutorDeps['runActionOperation'];
    /** Current committed contributed Action declarations for catalog discovery. */
    listContributedActionDefinitions?: ActionExecutorDeps['listContributedActionDefinitions'];
    inputTypeDeps?: Pick<ActionExecutorDeps, 'resolveInputType' | 'readInputTypeResource'>;
    externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
    /** The committed plugin-runtime owner for the built-in `action.invoke` Action. */
    invokeContributedAction?: ActionExecutorDeps['invokeContributedAction'];
    /** Exact daemon replay for API target-action approvals. */
    targetActionApprovalReplay?: ActionExecutorDeps['targetActionApprovalReplay'];
    executionRunHostActionApprovalReplay?: ActionExecutorDeps['executionRunHostActionApprovalReplay'];
    approvalRequestOutcomePublication?: ActionExecutorDeps['approvalRequestOutcomePublication'];
    approvalRequestApprovedReplay?: ActionExecutorDeps['approvalRequestApprovedReplay'];
    approvalRequestApproveRefusal?: ActionExecutorDeps['approvalRequestApproveRefusal'];
    /** Current authority/credential/target proof for durable core Action replay. */
    isApprovalExecutionOriginCurrent?: ActionExecutorDeps['isApprovalExecutionOriginCurrent'];
    prepareApprovalExecutionOriginContext?: ActionExecutorDeps['prepareApprovalExecutionOriginContext'];
    prepareApprovalExecutionAuthorization?: ActionExecutorDeps['prepareApprovalExecutionAuthorization'];
    prepareApprovedApiTokenExecution?: ActionExecutorDeps['prepareApprovedApiTokenExecution'];
    /** The exact daemon external-session RPC owner for host-stamped API requests. */
    hostExternalSessionAction?: ActionExecutorDeps['hostExternalSessionAction'];
    /** Thin adapters to the canonical Account-server-owned auth routes. */
    accountServerActionDeps?: AccountServerActionDeps;
    /** Origin-neutral workflow family handler; absent until its server/session owners are bound. */
    workflowAction?: ActionExecutorDeps['workflowAction'];
    /** Reuses the root placement owner for Machine children of Account composites. */
    routeHostChildAction?: ActionExecutorDeps['routeHostChildAction'];
    deploymentBackupAction?: ActionExecutorDeps['deploymentBackupAction'];
    deploymentRestore?: ActionExecutorDeps['deploymentRestore'];
    projectReadinessRead?: ActionExecutorDeps['projectReadinessRead'];
    managedMachineAction?: ActionExecutorDeps['managedMachineAction'];
    /** Installed Account custody for a background acquire sign-in after its invocation ends. */
    managedAcquireSignInCustody?: Readonly<{
      credentials: StoredCredentials;
      signal: AbortSignal;
      isCurrent(): Promise<boolean>;
    }>;
    receivingMachineSetupPlan?: CliReceivingMachineSetupPlan;
    machineReachabilityAction?: ActionExecutorDeps['machineReachabilityAction'];
    /** Receiving daemon's native Stop effect, after requester policy and scope admission. */
    sessionStop?: ActionExecutorDeps['sessionStop'];
    /** Installed exact-target worker Status/retirement producer, overriding only those IDs. */
    projectWorkerAction?: ActionExecutorDeps['projectWorkerAction'];
    /** The canonical prepared filesystem owner installed by the daemon. */
    filesystemActionExecute?: ActionExecutorDeps['filesystemActionExecute'];
    workspaceFilesReplace?: ActionExecutorDeps['workspaceFilesReplace'];
    workspaceFilesReplacePreview?: ActionExecutorDeps['workspaceFilesReplacePreview'];
    languageIntelligenceApply?: ActionExecutorDeps['languageIntelligenceApply'];
    skillMachineActionExecute?: ActionExecutorDeps['skillMachineActionExecute'];
    sessionFollowActionDeps?: Pick<ActionExecutorDeps, 'sessionFollowAction' | 'readSessionFollowRules'>;
    sessionTrackedTargetCompatibilityDeps?: Pick<ActionExecutorDeps, 'sessionTargetTrackedSet'>;
    sessionReadStateActionDeps?: Pick<ActionExecutorDeps, 'sessionReadStateAction'>;
    pluginActionExecutionOwner?: 'daemon_control' | 'current_process';
    requestPluginActionExecution?: PluginActionExecutionRequestOwner;
    /** Credentialed capability receiver; captured parent registries omit this. */
    accountPluginActions?: true;
    executeInvokingUiAction?: import('@/plugins/runtime/invocation/actions/executeContributedAction').ClientContributedActionExecutor;
  }>;

export type CliReviewServices = Readonly<{
  records?: ReviewRecordPortV1;
  comments?: ActionExecutorDeps['reviewCommentAction'];
}>;

type CliActionExecutor = ReturnType<typeof createCliActionExecutorHarness>['executor']
  & Pick<ReturnType<typeof createCliActionExecutorHarness>, 'observeRecordedApprovalExecution'>
  & Pick<ActionExecutorDeps, 'prepareSessionSpawnNewInput'>
  & Readonly<{ resolveReviewServices?(context?: ActionExecutorContext): Promise<CliReviewServices> }>;

export function createCliActionExecutor(params: CliActionExecutorParams): CliActionExecutor {
  return createCliActionHost(params).executor;
}

/** The final credentialed host reuses the core harness and its native ports. */
export function createCliActionHost(params: CliActionExecutorParams):
  Omit<ReturnType<typeof createCliActionExecutorHarness>, 'executor'> & Readonly<{ executor: CliActionExecutor }> {
  const followCredentials = params.credentials;
  const followServerHttpBaseUrl = followCredentials
    ? normalizeServerHttpBaseUrl(params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()) : undefined;
  const { projectWorkerAction: projectWorkerAccountAction, ...accountServerActionPorts } = params.accountServerActionDeps ?? {};
  const nativeManagedMachineAction = params.managedMachineAction;
  const accountManagedMachineAction = accountServerActionPorts.managedMachineAction;
  const hostManagedMachineAction: ActionExecutorDeps['managedMachineAction'] = nativeManagedMachineAction && accountManagedMachineAction
    ? async request => {
      // A receiving daemon supplies transport, not a controller identity for an
      // Account-owned resource. Consume the retained controller selector here.
      // Home owns the enrolled allocation inventory, including the absence of
      // an allocation for a manually enrolled Machine. Preparing retention
      // reads that inventory even when this daemon has no managed controller.
      if (request.actionId === MANAGED_LIST_ACTION_ID_V1 || request.actionId === MANAGED_RETIRE_ACTION_ID_V1) {
        return await accountManagedMachineAction(request);
      }
      if (isManagedRetainedControlInvocation(request.actionId, request.input)) {
        const controller = await resolveManagedControlControllerTarget({ actionId: request.actionId, rawInput: request.input,
          credentials: params.credentials?.token === params.token ? params.credentials : { token: params.token, encryption: null },
          serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
          ...(request.context.externalActionExecutionAuthorization ? { authorization: request.context.externalActionExecutionAuthorization } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        if (!controller) return await accountManagedMachineAction(request);
      }
      return await nativeManagedMachineAction(request);
    }
    : nativeManagedMachineAction;
  // O-MACH 2026-11-25 01:03Z: a Session Agent's admitted acquire on a delegated Team
  // preset is this Account's own local Action. Its controller holds no custody for this
  // requester, so the effect reaches it through Home's acquire routing and relay as this
  // Account's own invocation; Home admits the delegation at that routing.
  const managedMachineAction: ActionExecutorDeps['managedMachineAction'] = hostManagedMachineAction && params.credentials
    ? async request => {
      const context = request.context;
      const sessionMachineId = context.defaultSessionMachineId;
      const root = context.externalActionExecutionAuthorization?.binding;
      // Not a received foreign root: this Session host's own local Action.
      if (request.actionId === MANAGED_ACQUIRE_ACTION_ID_V1 && context.actionCaller?.kind === 'session'
        && sessionMachineId && (!root || root.machineId === sessionMachineId) && context.actionRequestId) {
        const deliver = await prepareOriginalAccountPresetAcquire({ actionId: request.actionId, input: request.input,
          requestId: context.actionRequestId, credentials: params.credentials!,
          serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
          ...((params.serverIdentityId ?? context.serverIdentityId) ? { serverIdentityId: params.serverIdentityId ?? context.serverIdentityId } : {}),
          ...(context.authority ? { authority: context.authority } : {}),
          invocation: readExternalActionRequesterInvocation(context),
          delegatedFromMachineId: sessionMachineId,
          ...(request.signal ? { signal: request.signal } : {}) });
        if (deliver) {
          // The managed effect owner carries a typed failure envelope unchanged.
          const result = await deliver();
          if (result.ok) answerAdmittedAcquireSignIn(request.input, result.result, context);
          return result.ok ? result.result : result;
        }
      }
      const result = await hostManagedMachineAction(request);
      if (request.actionId === MANAGED_ACQUIRE_ACTION_ID_V1) answerAdmittedAcquireSignIn(request.input, result, context);
      return result;
    }
    : hostManagedMachineAction;
  // Owner ruling 2026-11-26: the approval of this Account's own acquire, or its "allow" setting,
  // covers signing the new guest in. This daemon answers that one question with its own sign-in.
  function answerAdmittedAcquireSignIn(input: unknown, result: unknown, context: ActionExecutorContext): void {
    const custody = params.managedAcquireSignInCustody;
    const serverId = params.serverId;
    const serverIdentityId = params.serverIdentityId ?? context.serverIdentityId;
    const root = context.externalActionExecutionAuthorization?.binding;
    // A relayed acquire another Account admitted is that Account's to answer, never this daemon's.
    if (!custody || params.credentials?.token !== custody.credentials.token || !serverId || !serverIdentityId
      || root && root.accountId !== readAccountIdFromToken(custody.credentials.token)) return;
    // The invocation may hold a requester-scoped copy. Only the installed daemon lends sign-in material.
    const { credentials, signal, isCurrent } = custody;
    const serverUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
    void (async () => {
      if (signal.aborted || !await isCurrent() || signal.aborted) return;
      await answerAdmittedManagedAcquireSignIn({ credentials, serverId, serverIdentityId, serverUrl, signal,
        acquireInput: input, acquireResult: result,
        readOperation: operation => executeOriginalAccountRequesterOperation({ operation, credentials, serverIdentityId,
          serverHttpBaseUrl: serverUrl, requestId: randomUUID(), authority: 'account_automation', isCurrent, signal }),
      });
    })().catch(error => {
      if (!signal.aborted) logger.warn('[managed] Following the admitted acquire sign-in failed', error);
    });
  }
  const personalSavedSecretActionExecute = params.personalSavedSecretActionExecute ?? (params.credentials && accountServerActionPorts.homeDomainAction
    ? createCliPersonalSavedSecretActionExecute({ credentials: params.credentials, home: accountServerActionPorts.homeDomainAction,
      operationContext: params.savedSecretOperationContext, serverHttpBaseUrl: params.serverHttpBaseUrl, isCredentialCurrent: params.isCredentialCurrent }) : undefined);
  const invokeContributedAction: ActionExecutorDeps['invokeContributedAction'] = params.invokeContributedAction
    ?? (params.pluginActionExecutionOwner === 'current_process' ? undefined
      : async (request) => pluginExecutor.invokeContributedAction(request));
  const actionSettingsProvider = params.actionsSettingsProvider ?? createActionSettingsProvider({
    scopeKey: resolveAccountSettingsScopeKeyForToken(params.token),
  });
  const runtimeAccountId = readAccountIdFromToken(params.token) ?? undefined;
  const requesterPrivateEffectAuthorityFailure = async (actionId: ActionId, input: unknown, context: ActionExecutorContext | undefined) => {
    const runActionId = readRecord(input)?.actionId;
    if ((ACTION_ID_FAMILIES_V1.review_comments.some(id => id === actionId) || actionId === 'review.apply'
      || isReviewTriageRunActionV1(actionId, runActionId)
      // Review record writes spend this executor's Account only without a requester
      // authorization; with one, the transport signs for the requester's own Account.
      || (isReviewRecordWriteActionIdV1(actionId) || isReviewNewRoundRunActionV1(actionId, runActionId))
        && !context?.externalActionExecutionAuthorization)
      && !await canUseLocalRuntimeReviewAccount(context, runtimeAccountId ?? null, params.serverId)) {
      // The raw comment port spends this executor's Account credentials. Machine
      // placement or requester attribution cannot lend that Account to a guest.
      return { ok: false as const, errorCode: 'review_comment_account_custody_denied',
        error: 'This action cannot use the installed Account’s Review access from this context.' };
    }
    const binding = context?.externalActionExecutionAuthorization?.binding;
    if (binding && binding.accountId !== runtimeAccountId && binding.accountEncryptionMode === 'e2ee'
      && (actionId === 'template.instantiate' || actionId === 'session.spawn_new')) {
      // Placement authority does not provide the requester's private Session
      // encryption material. Prepared requester executors carry that Account.
      return { ok: false as const, errorCode: 'requester_account_material_unavailable', error: 'requester_account_material_unavailable' };
    }
    if (!binding || !('authentication' in binding) || !binding.sessionActionOrigin
      || binding.accountId === runtimeAccountId) return null;
    const effect = getActionSpec(actionId).sideEffectClass;
    if (effect === 'none' || effect === 'read') return null;
    // Home admitted this exact compute acquire. Agent work needs the source
    // requester's private policy, which controller custody cannot read: only the
    // source host's signed admission stamp carries that decision here.
    if (actionId === 'machines.managed.acquire' && binding.actionId === actionId
      && binding.managedAcquireDelegation === true
      && (!isAgentStartActionInvocationV1(actionId, readRecord(input)) || binding.sessionActionOrigin.agentStartAdmission)
      && readRetainedVerifiedExternalActionRequester(context?.externalActionExecutionAuthorization)) return null;
    // A delegated preset Session spawn rides the same signed source admission.
    if (actionId === 'session.spawn_new' && binding.actionId === actionId
      && binding.sessionPresetAcquisition?.admission?.delegated === true && binding.sessionActionOrigin.agentStartAdmission
      && readRetainedVerifiedExternalActionRequester(context?.externalActionExecutionAuthorization)) return null;
    // Receiving Machine admission grants effect placement, not the requester's
    // private Action policy or approval Artifact writes. The existing Account
    // projection reads facts only; it cannot authorize borrowing custodian policy.
    return { ok: false as const, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
  };
  const filesystemRequesterAuthorityFailure = (actionId: string, context: ActionExecutorContext | undefined) => {
    if (!isFilesystemActionId(actionId)) return null;
    const credentialAccountId = context?.externalActionCredential?.accountId.trim();
    const foreignCredential = context?.externalActionCredential
      && (!credentialAccountId || credentialAccountId !== runtimeAccountId);
    // An API requester credential is just as distinct from the daemon's
    // Account policy as an admitted RPC actor. Surface is not authority proof.
    if (!foreignCredential && context?.surface !== 'rpc') return null;
    const requesterAccountId = context?.runtimeAccountId?.trim() || credentialAccountId;
    if (!foreignCredential && requesterAccountId && runtimeAccountId && requesterAccountId === runtimeAccountId) return null;
    // The incumbent private requester projection only reads Project/Artifact
    // facts. It does not supply requester Action policy or approval writes, so
    // a foreign actor stamp cannot borrow this runtime's Account authority.
    return { ok: false as const, errorCode: 'filesystem_requester_account_authority_unavailable',
      error: 'The requester filesystem policy and approval authority are unavailable' };
  };
  const transcriptFollowLeaseRegistry = params.transcriptFollowLeaseRegistry
    ?? createSessionTranscriptFollowLeaseRegistry({
      idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    });
  const resolveTeamCredentialResourceCatalog = params.resolveTeamCredentialResourceCatalog
    ?? (() => {
      if (!runtimeAccountId || !params.accountServerActionDeps?.homeDomainAction) return undefined;
      // Preserve constructor-time Home/Account binding while loading the spawn
      // catalog only when a spawn actually asks for its Team resources.
      const binding = {
        homeDomainAction: params.accountServerActionDeps.homeDomainAction,
        serverId: params.serverId ?? configuration.activeServerId,
        accountId: runtimeAccountId,
      };
      return async (request: Parameters<ResolveSpawnConnectedServicesTeamResourceCatalog>[0]) => {
        const { createSpawnConnectedServicesTeamResourceCatalogResolver } = await import(
          '@/session/services/spawnConnectedServicesDefaults'
        );
        return await createSpawnConnectedServicesTeamResourceCatalogResolver(binding)(request);
      };
    })();
  // The exact Home pair travels to its owners as one value; spreading the two
  // fields separately loses the binding the params type already guarantees.
  const exactHome: CliActionExactHomeTarget =
    params.serverId !== undefined && params.serverHttpBaseUrl !== undefined
      ? { serverId: params.serverId, serverHttpBaseUrl: params.serverHttpBaseUrl }
      : {};
  const runActionOperation = params.runActionOperation;
  const harness = createCliActionExecutorHarness(
    {
      ...params,
      ...(personalSavedSecretActionExecute ? { personalSavedSecretActionExecute } : {}),
      ...(projectWorkerAccountAction ? { projectWorkerAccountAction } : {}),
      actionsSettingsProvider: actionSettingsProvider,
      ...(resolveTeamCredentialResourceCatalog ? { resolveTeamCredentialResourceCatalog } : {}),
    },
    {
      ...(params.sessionActionConfirmation ? { sessionActionConfirmation: params.sessionActionConfirmation } : {}),
      ...(params.teamCredentialUsageExport ? { teamCredentialUsageExport: params.teamCredentialUsageExport } : {}),
      ...(params.machineManagedInstallationRespond ? { machineManagedInstallationRespond: params.machineManagedInstallationRespond } : {}),
      clientActionExecute: createCliLocalServiceClientActionExecutor(params.clientActionExecute),
      ...(params.confidentialSecretFill ? { confidentialSecretFill: params.confidentialSecretFill } : {}),
      ...(params.confidentialActionInputs ? { confidentialActionInputs: params.confidentialActionInputs } : {}),
      ...(params.runtimeActionExecute
        ? { runtimeActionExecute: params.runtimeActionExecute }
        : {}),
      ...(params.prepareLocalServiceStartApproval ? { prepareLocalServiceStartApproval: params.prepareLocalServiceStartApproval } : {}),
      ...(invokeContributedAction
        ? { invokeContributedAction }
        : {}),
      ...(params.targetActionApprovalReplay
        ? { targetActionApprovalReplay: params.targetActionApprovalReplay }
        : {}),
      ...(params.executionRunHostActionApprovalReplay
        ? { executionRunHostActionApprovalReplay: params.executionRunHostActionApprovalReplay }
        : {}),
      ...(params.approvalRequestOutcomePublication
        ? { approvalRequestOutcomePublication: params.approvalRequestOutcomePublication }
        : {}),
      ...(params.approvalRequestApprovedReplay
        ? { approvalRequestApprovedReplay: params.approvalRequestApprovedReplay }
        : {}),
      ...(params.approvalRequestApproveRefusal
        ? { approvalRequestApproveRefusal: params.approvalRequestApproveRefusal }
        : {}),
      ...(params.isApprovalExecutionOriginCurrent
        ? { isApprovalExecutionOriginCurrent: params.isApprovalExecutionOriginCurrent }
        : {}),
      ...(params.prepareApprovalExecutionOriginContext
        ? { prepareApprovalExecutionOriginContext: params.prepareApprovalExecutionOriginContext }
        : {}),
      ...(params.prepareApprovalExecutionAuthorization
        ? { prepareApprovalExecutionAuthorization: params.prepareApprovalExecutionAuthorization }
        : {}),
      ...(params.prepareApprovedApiTokenExecution ? { prepareApprovedApiTokenExecution: params.prepareApprovedApiTokenExecution } : {}),
      ...(params.listContributedActionDefinitions
        ? { listContributedActionDefinitions: params.listContributedActionDefinitions,
            readContributedActionSchemas: createCommittedContributedActionSchemaReader(params.listContributedActionDefinitions) }
        : {}),
      ...(params.inputTypeDeps ?? (params.pluginActionExecutionOwner === 'current_process' ? createCommittedInputTypeDeps() : {})),
      ...(params.hostExternalSessionAction
        ? { hostExternalSessionAction: params.hostExternalSessionAction }
        : {}),
      ...accountServerActionPorts,
      ...(personalSavedSecretActionExecute ? { personalSavedSecretActionExecute } : {}),
      ...(params.projectWorkerAction ? { projectWorkerAction: params.projectWorkerAction } : {}),
      ...(params.workflowAction ? { workflowAction: params.workflowAction } : {}),
      ...(params.deploymentBackupAction ? { deploymentBackupAction: params.deploymentBackupAction } : {}),
      ...(params.deploymentRestore ? { deploymentRestore: params.deploymentRestore } : {}),
      ...(params.projectReadinessRead ? { projectReadinessRead: params.projectReadinessRead } : {}),
      routeHostChildAction: async request => {
        if (request.actionId === 'action.invoke') {
          const { executeAccountPluginAction } = await import('./executeAccountPluginAction');
          const account = await executeAccountPluginAction({ host: params, deps: harness.deps,
            resolveContext: harness.resolveContext,
            actionId: request.actionId, input: request.input, context: request.context });
          if (account.matched) return account.result;
          // Only a positively declared Machine child reaches its invoker;
          // unavailable Account custody or Client placement cannot borrow it.
          if (account.accountSelectionUnavailable && account.executionPlacement !== 'machine') return { ok: false,
            errorCode: 'plugin_action_execution_placement_unavailable', error: 'plugin_action_execution_placement_unavailable' };
        }
        return await params.routeHostChildAction?.(request) ?? null;
      },
      ...(managedMachineAction ? { managedMachineAction } : {}),
      ...(params.machineReachabilityAction ? { machineReachabilityAction: params.machineReachabilityAction } : {}),
      ...(params.sessionStop ? { sessionStop: params.sessionStop } : {}),
      ...(params.hostActionApprovalLifetime ? { hostActionApprovalLifetime: params.hostActionApprovalLifetime } : {}),
      ...(runActionOperation ? { runActionOperation: async (request) => {
        // The signed receiver owns the operation for relayed Workflow backup work.
        if (relaysWorkflowDeploymentBackup(request.actionId, request.context)) {
          return request.execute(request.context);
        }
        return runActionOperation(request);
      } } : {}),
      ...(params.filesystemActionExecute ? { filesystemActionExecute: async (request) => {
        const denied = filesystemRequesterAuthorityFailure(request.actionId, request.context);
        return denied ?? await params.filesystemActionExecute!(request);
      } } : {}),
      ...(params.skillMachineActionExecute ? { skillMachineActionExecute: params.skillMachineActionExecute } : {}),
      ...(params.workspaceFilesReplace ? { workspaceFilesReplace: params.workspaceFilesReplace } : {}),
      ...(params.workspaceFilesReplacePreview ? { workspaceFilesReplacePreview: params.workspaceFilesReplacePreview } : {}),
      ...(params.languageIntelligenceApply ? { languageIntelligenceApply: params.languageIntelligenceApply } : {}),
      ...(params.sessionFollowActionDeps ?? createSessionFollowActionDeps({
        token: params.token,
        ...(params.credentials ? { credentials: params.credentials } : {}),
        ...(params.isCredentialCurrent ? { isCredentialCurrent: params.isCredentialCurrent } : {}),
        ...exactHome,
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
        ...(followCredentials ? {
          prepareSourceKeyAfterSet: async input => {
            const { createSessionFollowSourceKeyPreparationAfterSet } = await import('@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet');
            return createSessionFollowSourceKeyPreparationAfterSet({
              credentials: followCredentials,
              ...(followServerHttpBaseUrl ? { serverHttpBaseUrl: followServerHttpBaseUrl } : {}),
              ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
              ...(params.resolveServerFeaturesSnapshot
                ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
                : {}),
              ...(params.externalActionMachineRequestPrivateKey
                ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
                : {}),
              ...(params.externalActionMachineInstallationId
                ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
                : {}),
            })(input);
          },
        } : {}),
      })),
      ...(params.sessionTrackedTargetCompatibilityDeps ?? {}),
      ...(params.sessionReadStateActionDeps ?? createSessionReadStateActionDeps({
        token: params.token,
        ...exactHome,
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
      })),
      sessionTranscriptAction: async ({ actionId, input, context }) => await executeCliTranscriptAction({
        actionId,
        input,
        context,
        defaultSessionId: params.sessionId,
        options: {
          ...params,
          transcriptFollowLeaseRegistry,
        },
      }),
    },
  );
  const base = harness.executor;
  const hasBoundMachineAction = (reference: NonNullable<ReturnType<typeof readPluginActionExecutionReference>>) => {
    if (!params.invokeContributedAction) return false;
    const id = formatQualifiedPluginActionId(reference);
    return params.listContributedActionDefinitions?.({ id }).find(candidate => candidate.id === id)?.executionPlacement === 'machine';
  };
  const executeInCurrentProcess: NonNullable<Parameters<typeof createDaemonPluginActionExecutor>[0]['executeInCurrentProcess']> =
    async (actionId, input, context) => {
      const readsExactLocalContract = actionId === 'action.spec.get'
        && params.pluginActionExecutionOwner === 'current_process'
        && context?.authority === 'account_automation'
        && context.externalActionTarget?.kind === 'machine'
        && context.externalActionTarget.machineId === context.executionRunTargetMachineId;
      if (readsExactLocalContract || (context?.surface === 'plugin' && context.actionCaller?.kind === 'plugin')) {
        const reference = readPluginActionExecutionReference(actionId, input);
        if (reference && hasBoundMachineAction(reference)) {
          return { matched: true, result: await base.execute(actionId as ActionId, input, context) };
        }
      }
      const { executeAccountPluginAction } = await import('./executeAccountPluginAction');
      return await executeAccountPluginAction({ host: params, deps: harness.deps,
        resolveContext: harness.resolveContext,
        actionId, input, ...(context ? { context } : {}) });
    };
  // Options inherit the consuming Action's placement, even when a receiving
  // daemon's own catalog intentionally excludes Account Actions.
  const usesPluginPlacement = (actionId: string, input: unknown) => params.pluginActionExecutionOwner !== 'current_process'
    || params.accountPluginActions === true
    || (actionId === 'action.options.resolve' && readPluginActionExecutionReference(actionId, input) !== null);
  const pluginExecutor = params.pluginActionExecutionOwner === 'current_process'
    ? createPluginActionExecutor({ base, executeInCurrentProcess: async (actionId, input, context) =>
      usesPluginPlacement(actionId, input) ? executeInCurrentProcess(actionId, input, context)
        // This bound registry owns caller and placement admission. Returning
        // unmatched would classify its nested plugin call as unbound transport.
        : { matched: true as const, result: await base.execute(actionId as ActionId, input, context) } })
    : createDaemonPluginActionExecutor({ base, executeInCurrentProcess,
      ...(params.requestPluginActionExecution ? { requestPluginActionExecution: params.requestPluginActionExecution } : {}) });
  const resolveContext = async (context: RpcActionExecutorContext | undefined, invocation?: Readonly<{ actionId: ActionId; input: unknown }>) => {
    const currentWorkspaceWrites = harness.deps.getCurrentWorkspaceWrites?.();
    const credential = params.credentials && hasStoredSessionCredentialProvenance(params.credentials) ? 'terminal' : 'api_token';
    const surface = context?.surface ?? 'cli';
    // RPC receivers already have the verified caller stamp; an unstamped RPC stays automation.
    let authority = surface === 'rpc'
      ? credential === 'terminal' ? context?.authority ?? 'account_automation' : 'account_automation'
      : context?.authority === 'account_automation' ? 'account_automation' : resolveInvocationAuthority({
        credential, surface,
      });
    let authorization = context?.externalActionExecutionAuthorization;
    const sessionBinding = authorization && 'authentication' in authorization.binding
      && authorization.binding.sessionActionOrigin ? authorization.binding : null;
    const privateKey = params.externalActionMachineRequestPrivateKey;
    const admission = context?.machineAdmission;
    const requesterAccount = authorization?.requesterAccountProjection;
    const requesterHttp = authorization?.requesterHttpProjection;
    const admittedPrivateUiCustody = Boolean(authorization
      && readExternalActionBindingAuthority(authorization.binding) === 'present_user'
      && surface === 'ui' && context?.authority === 'present_user' && context.actionCaller?.kind === 'host'
      && context.causalPermissionAuthority == null
      && requesterAccount && requesterHttp
      && requesterAccount.accountId === runtimeAccountId && requesterAccount.serverId === params.serverId
      && requesterAccount.accountEncryptionMode === authorization.binding.accountEncryptionMode
      && requesterHttp.accountId === runtimeAccountId && requesterHttp.serverId === params.serverId
      && requesterHttp.serverIdentityId === authorization.binding.serverIdentityId
      && requesterHttp.accountEncryptionMode === authorization.binding.accountEncryptionMode
      && normalizeServerHttpBaseUrl(requesterHttp.serverHttpBaseUrl)
        === normalizeServerHttpBaseUrl(params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl())
      && await requesterAccount.isCurrent().catch(() => false)
      && !Boolean(context.signal?.aborted)
      && await requesterHttp.isCurrent().catch(() => false)
      && !Boolean(context.signal?.aborted));
    // Ordinary Account host ingress retains its human cause only at its exact
    // credential-backed receiver, after the incumbent Home verifier checks
    // the installed destination's signed request. A raw origin cannot confer it.
    const privatelyReconciledSession = Boolean(admittedPrivateUiCustody && authorization
      && authorization.binding.target.kind === 'machine'
      && authorization.binding.target.machineId === authorization.binding.machineId
      && context?.externalActionTarget?.kind === 'session'
      && context.defaultSessionId === context.externalActionTarget.sessionId);
    const ordinaryAccountHostBinding = authorization && 'authentication' in authorization.binding
      && !authorization.binding.sessionActionOrigin
      && (surface === 'ui' || surface === 'voice' && context?.actionCaller?.kind === 'host'
        && readExternalActionBindingAuthority(authorization.binding) === 'present_user')
      && context?.authority === 'present_user'
      && privateKey && params.serverId && params.serverIdentityId === authorization.binding.serverIdentityId
      && runtimeAccountId === authorization.binding.accountId
      && (runtimeAccountId === authorization.binding.custodianAccountId || admittedPrivateUiCustody)
      && params.externalActionMachineInstallationId === authorization.binding.installationId
      && context.actionRequestId === authorization.binding.requestId
      && context.defaultSessionMachineId === authorization.binding.machineId
      && (sameStrictJsonValue(context.externalActionTarget, authorization.binding.target) || privatelyReconciledSession)
      ? authorization.binding : null;
    // A managed controller keeps its own Account custody. The verified Home
    // root plus exact installed codec preserves the requester's direct click;
    // neither the custodian credential nor a raw UI label supplies that cause.
    let managedControllerUiBinding: NonNullable<typeof authorization>['binding'] | null = null;
    if (authorization
      && readExternalActionBindingAuthority(authorization.binding) === 'present_user'
      && isManagedControllerCodecRootV1(authorization.binding)
      && authorization.binding.accountId !== authorization.binding.custodianAccountId
      && runtimeAccountId === authorization.binding.custodianAccountId
      && !authorization.binding.sessionActionOrigin && !authorization.binding.workflowActionOrigin
      && surface === 'ui' && context?.authority === 'present_user' && context.actionCaller?.kind === 'host'
      && context.causalPermissionAuthority == null && privateKey && params.serverId
      && params.serverIdentityId === authorization.binding.serverIdentityId
      && params.externalActionMachineInstallationId === authorization.binding.installationId
      && context.actionRequestId === authorization.binding.requestId
      && context.defaultSessionMachineId === authorization.binding.machineId
      && sameStrictJsonValue(context.externalActionTarget, authorization.binding.target)
      && requesterHttp && requesterHttp.accountId === authorization.binding.accountId
      && requesterHttp.serverId === params.serverId && requesterHttp.serverIdentityId === authorization.binding.serverIdentityId
      && requesterHttp.accountEncryptionMode === authorization.binding.accountEncryptionMode
      && normalizeServerHttpBaseUrl(requesterHttp.serverHttpBaseUrl)
        === normalizeServerHttpBaseUrl(params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl())
      && !context.signal?.aborted && await requesterHttp.isCurrent().catch(() => false) && !context.signal?.aborted) {
      try {
        const codec = openManagedControllerActionCodecV1({ authorization, includeInvocation: true,
          machineId: authorization.binding.machineId, installationId: authorization.binding.installationId,
          serverIdentityId: authorization.binding.serverIdentityId,
          installationPrivateKey: typeof privateKey === 'string' ? decodeBase64(privateKey, 'base64url') : privateKey });
        if (codec?.invocation?.caller.kind === 'host' && codec.invocation.surface === 'ui'
          && codec.invocation.authority === 'present_user') managedControllerUiBinding = authorization.binding;
      } catch { /* A malformed installation key cannot confer a human cause. */ }
    }
    // Only the live registered Machine ingress can install receiver custody.
    // A source factory with the same Home proof does not acquire the foreign key.
    const admittedReceiver = Boolean(sessionBinding && admission && context?.verifyMachineAdmissionCurrent && privateKey && params.serverId
      && params.serverIdentityId === sessionBinding.serverIdentityId
      && admission.machineId === sessionBinding.machineId
      && admission.installationId === sessionBinding.installationId
      && admission.actorAccountId === sessionBinding.accountId
      && admission.custodianAccountId === sessionBinding.custodianAccountId
      && params.externalActionMachineInstallationId === sessionBinding.installationId
      && context?.defaultSessionMachineId === sessionBinding.sessionActionSource?.machineId
      && sameStrictJsonValue(context.externalActionTarget, sessionBinding.target));
    if ((admittedReceiver || ordinaryAccountHostBinding || managedControllerUiBinding) && authorization && privateKey && params.externalActionMachineInstallationId
      && params.serverId && params.serverIdentityId && context?.externalActionTarget) {
      const originalAuthorization = authorization;
      const projectionRequest = { authorization: originalAuthorization,
        serverId: params.serverId, serverIdentityId: params.serverIdentityId,
        serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        target: context.externalActionTarget, installationId: params.externalActionMachineInstallationId,
        privateKey, isCurrent: context.verifyMachineAdmissionCurrent, ...(context.signal ? { signal: context.signal } : {}) };
      const projected = await measureActionStartPhaseV1(context, 'requester_projection',
        () => projectExternalActionRequesterHttpAuthorization(projectionRequest));
      if (!projected) {
        context?.recordActionStartDiagnostic?.({ phase: 'requester_projection', refusalReason: 'requester_projection_unavailable' });
        return null;
      }
      authorization = projected;
      const retainedRequester = ordinaryAccountHostBinding || managedControllerUiBinding
        ? readRetainedVerifiedExternalActionRequester(originalAuthorization) : undefined;
      if (retainedRequester) {
        if (projected.token !== originalAuthorization.token
          || !sameStrictJsonValue(projected.binding, originalAuthorization.binding)) return null;
        authorization = retainVerifiedExternalActionRequester({ authorization: projected, isCurrent: retainedRequester.isCurrent });
      }
      if (ordinaryAccountHostBinding || managedControllerUiBinding) authority = 'present_user';
    }
    const admittedBackupReceiverSetup = invocation
      ? readHostAdmittedBackupReceiverSetupApplyV1({ context, actionId: invocation.actionId, input: invocation.input })
      : null;
    if (admittedBackupReceiverSetup
      && surface === 'ui'
      && params.serverId && params.serverIdentityId === admittedBackupReceiverSetup.binding.serverIdentityId
      && runtimeAccountId === admittedBackupReceiverSetup.requesterAccountId
      && params.externalActionMachineInstallationId === admittedBackupReceiverSetup.receiving.installationId
      && admission
      && admission.machineId === admittedBackupReceiverSetup.receiving.machineId
      && admission.installationId === admittedBackupReceiverSetup.receiving.installationId
      && admission.actorAccountId === admittedBackupReceiverSetup.receiving.actorAccountId
      && admission.role === 'manage'
      && context?.verifyMachineAdmissionCurrent
      && requesterAccount
      && requesterAccount.accountId === runtimeAccountId
      && requesterAccount.serverId === params.serverId
      && requesterAccount.accountEncryptionMode === admittedBackupReceiverSetup.binding.accountEncryptionMode
      && !context.signal?.aborted
      && await requesterAccount.isCurrent().catch(() => false)
      && !context.signal?.aborted
      && await context.verifyMachineAdmissionCurrent().catch(() => false)
      && !context.signal?.aborted) {
      authority = 'present_user';
    }
    const credentials = params.credentials;
    if (ordinaryAccountHostBinding && credentials && !params.actionsSettingsProvider) {
      const managedAction = ManagedMachineActionIdV1Schema.safeParse(ordinaryAccountHostBinding.actionId);
      if (managedAction.success && getActionSpec(managedAction.data).sideEffectClass !== 'read') {
        // The ordinary receiver has this acquiring Account's credential, not a
        // reviewed Session policy. Fetch its persisted policy before Ask-first
        // preparation; retain the refresh owner's existing cache fallback.
        await runWithServerHttpBaseUrl(params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), () =>
          refreshAccountSettingsForMinimumVersion({ credentials, mode: 'blocking', forceRefresh: true }));
      }
    }
    // The original Session issuer and the selected receiver are the same
    // installed controller here. A foreign controller must use its own existing
    // receiver signer, never the originating Session host's private key.
    const canSignOriginalSessionApproval = Boolean(sessionBinding && privateKey
      && params.serverIdentityId === sessionBinding.serverIdentityId
      && runtimeAccountId === sessionBinding.accountId
      && context?.defaultSessionMachineId === sessionBinding.machineId
      && params.externalActionMachineInstallationId === sessionBinding.installationId
      && sessionBinding.sessionActionSource?.machineId === sessionBinding.machineId
      && sessionBinding.sessionActionSource.installationId === sessionBinding.installationId);
    // The accepted Run retains its original Home root. Reuse this installed
    // signer's custody for approval input without admitting the principal again.
    const canSignWorkflowApproval = Boolean(context?.actionCaller?.kind === 'workflowRun' && authorization && privateKey
      && params.serverIdentityId === authorization.binding.serverIdentityId
      && runtimeAccountId === authorization.binding.accountId
      && params.externalActionMachineInstallationId === authorization.binding.installationId);
    const approvalAuthorization = authorization;
    const signExternalActionApprovalInput: ActionExecutorContext['signExternalActionApprovalInput'] =
      context?.signExternalActionApprovalInput
      ?? ((ordinaryAccountHostBinding || managedControllerUiBinding || canSignOriginalSessionApproval || canSignWorkflowApproval || admittedReceiver && runtimeAccountId === sessionBinding?.accountId)
        && approvalAuthorization && privateKey ? ({ actionId, input, target, authorization: suppliedAuthorization, requesterConfirmation, sessionTargetsV1 }) => {
        if (suppliedAuthorization.token !== approvalAuthorization.token
          || !sameStrictJsonValue(target, approvalAuthorization.binding.target)) throw new Error('approval_origin_unavailable');
        return signExternalActionApprovalInputV1({ authorizationToken: approvalAuthorization.token,
          actionId, input, target, privateKey, ...(requesterConfirmation ? { requesterConfirmation } : {}),
          ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) });
      } : undefined);
    return ({
    ...(context ?? {}),
    ...(authorization ? { externalActionExecutionAuthorization: authorization } : {}),
    ...((currentWorkspaceWrites || context?.workspaceWrites) ? {
      workspaceWrites: currentWorkspaceWrites === 'deny' || context?.workspaceWrites === 'deny'
        ? 'deny' as const : currentWorkspaceWrites ?? context?.workspaceWrites,
    } : {}),
    surface,
    authority,
    ...(signExternalActionApprovalInput ? { signExternalActionApprovalInput } : {}),
    // Token-only callers retain this host's existing Account binding. The
    // shared harness stamps credentialed hosts; Session-only MCP has no such credentials.
    ...(!params.credentials && surface !== 'rpc' && !context?.machineAdmission
      && context?.runtimeAccountId === undefined && runtimeAccountId ? { runtimeAccountId } : {}),
    actionsSettings: actionSettingsProvider.getActionsSettings(),
    sessionAgentSpawnPolicyV1:
      context?.sessionAgentSpawnPolicyV1
      ?? actionSettingsProvider.getAccountSettings?.()?.sessionAgentSpawnPolicyV1,
    });
  };
  return { ...harness, executor: {
    admitContributedSessionReadSet: base.admitContributedSessionReadSet,
    observeRecordedApprovalExecution: harness.observeRecordedApprovalExecution,
    prepareSessionSpawnNewInput: harness.deps.prepareSessionSpawnNewInput,
    resolveReviewServices: async context => {
      if (!await canUseLocalRuntimeReviewAccount(context, runtimeAccountId ?? null, params.serverId)) return {};
      const resolvedContext = await resolveContext(context);
      if (!resolvedContext) return {};
      const comments = harness.deps.reviewCommentAction;
      const invoke = <T>(operation: () => T): T => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, operation) : operation();
      const boundComments: ActionExecutorDeps['reviewCommentAction'] = comments ? Object.assign(
        (request: Parameters<typeof comments>[0]) => invoke(() => comments(request)),
        { createBatch: comments.createBatch && ((...args: Parameters<NonNullable<typeof comments.createBatch>>) =>
          invoke(() => comments.createBatch!(...args))) },
      ) : undefined;
      return {
        ...(harness.deps.reviewRecords ? { records: harness.deps.reviewRecords(resolvedContext) } : {}),
        ...(boundComments ? { comments: boundComments } : {}),
      } satisfies CliReviewServices;
    },
    prepare: async (actionId, input, context, options) => {
      const denied = filesystemRequesterAuthorityFailure(actionId, context)
        ?? await requesterPrivateEffectAuthorityFailure(actionId, input, context);
      if (denied) return { kind: 'settled' as const, result: denied };
      const resolvedContext = await measureActionStartPhaseV1(context, 'cli_context', () => resolveContext(context, { actionId, input }));
      if (!resolvedContext) return { kind: 'settled' as const,
        result: actionStartTargetUnavailableV1(context, 'cli_context', 'requester_projection_unavailable') };
      // The committed Machine registry owns prepared Machine dispatch. The
      // Account route is selected here for other qualified Workflow calls.
      const workflowAction = params.pluginActionExecutionOwner === 'current_process' && params.accountPluginActions
        && resolvedContext.actionCaller?.kind === 'workflowRun' ? readPluginActionExecutionReference(actionId, input) : null;
      if (isPluginActionExecutionDispatchId(actionId) && usesPluginPlacement(actionId, input)
        && !(workflowAction && hasBoundMachineAction(workflowAction))) {
        // Preparation must not bypass the placement owner or run an effect.
        // The same admitted invocation settles once when its caller runs it.
        let result: Promise<ActionExecuteResult> | undefined;
        return { kind: 'ready' as const, invocation: { run: () =>
          result ??= awaitCliActionResult(() => pluginExecutor.execute(actionId, input, resolvedContext), context?.signal) } };
      }
      const prepared = await base.prepare(actionId, input, resolvedContext, options);
      if (prepared.kind !== 'ready') return prepared;
      return { ...prepared, invocation: { ...prepared.invocation,
        run: () => awaitCliActionResult(() => prepared.invocation.run(), context?.signal),
      } };
    },
    execute: async (actionId, input, context) => {
      const denied = filesystemRequesterAuthorityFailure(actionId, context)
        ?? await requesterPrivateEffectAuthorityFailure(actionId, input, context);
      if (denied) return denied;
      const resolvedContext = await measureActionStartPhaseV1(context, 'cli_context', () => resolveContext(context, { actionId, input }));
      if (!resolvedContext) return actionStartTargetUnavailableV1(context, 'cli_context', 'requester_projection_unavailable');
      return await awaitCliActionResult(() => pluginExecutor.execute(actionId, input, resolvedContext), context?.signal);
    },
    continueConfidentialApprovalRequest: async (input, context) => {
      const resolvedContext = await measureActionStartPhaseV1(context, 'cli_context', () => resolveContext(context));
      return resolvedContext ? await base.continueConfidentialApprovalRequest(input, resolvedContext)
        : actionStartTargetUnavailableV1(context, 'cli_context', 'requester_projection_unavailable');
    },
    replayApprovedApprovalRequest: async (args, machineIngress) => await base.replayApprovedApprovalRequest({ ...args,
      // These facts come from this actual credentialed Home, not editable
      // Artifact metadata or an RPC caller's claimed Account. The existing
      // admitted callerAuthority remains separate and is not upgraded here.
      currentAccount: runtimeAccountId && params.serverId && params.serverIdentityId ? {
        accountId: runtimeAccountId, serverId: params.serverId, serverIdentityId: params.serverIdentityId,
        actionsSettings: actionSettingsProvider.getActionsSettings(),
      } : undefined,
    }, machineIngress),
  } };
}
