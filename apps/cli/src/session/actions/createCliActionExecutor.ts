import { isManagedControllerCodecActionV1, openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createSessionFollowActionDeps } from '@/api/sessionFollowActionDeps';
import { createSessionReadStateActionDeps } from '@/api/sessionReadStateActionDeps';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
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
import { createDaemonPluginActionExecutor, createPluginActionExecutor } from './createDaemonPluginActionExecutor';
import { createCommittedContributedActionSchemaReader, createCommittedInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import type { CliActionExactHomeTarget } from './createCliActionDeps';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';
import type { ActionExecutorContext, ActionExecutorDeps, RuntimeActionExecute, ActionId } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';
import type { AccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliPersonalSavedSecretActionExecute } from '@/settings/secrets/personalSavedSecretActionHost';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import type { ResolveSpawnConnectedServicesTeamResourceCatalog } from '@/session/services/spawnConnectedServicesDefaults';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { isFilesystemActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { resolveEffectiveTerminalPresentUserPolicy } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { ManagedMachineActionIdV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { actionStartTargetUnavailableV1, measureActionStartPhaseV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { bindDiscussionDraftReply } from '@/discussions/bindDiscussionDraftReply';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutorHarness>[0]
  & CliTranscriptActionExecutorOptions
  & Readonly<{
    runtimeActionExecute?: RuntimeActionExecute;
    prepareLocalServiceStartApproval?: ActionExecutorDeps['prepareLocalServiceStartApproval'];
    clientActionExecute?: ActionExecutorDeps['clientActionExecute'];
    confidentialSecretFill?: ActionExecutorDeps['confidentialSecretFill'];
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
    approvalRequestApprovedReplay?: ActionExecutorDeps['approvalRequestApprovedReplay'];
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
    managedMachineAction?: ActionExecutorDeps['managedMachineAction'];
    machineEnvironmentApply?: ActionExecutorDeps['machineEnvironmentApply'];
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
    /** Credentialed capability receiver; captured parent registries omit this. */
    accountPluginActions?: true;
  }>;

export function createCliActionExecutor(
  params: CliActionExecutorParams,
): ReturnType<typeof createCliActionExecutorHarness>['executor']
  & Pick<ReturnType<typeof createCliActionExecutorHarness>, 'observeRecordedApprovalExecution'> {
  const { projectWorkerAction: projectWorkerAccountAction, ...accountServerActionPorts } = params.accountServerActionDeps ?? {};
  const personalSavedSecretActionExecute = params.personalSavedSecretActionExecute ?? (params.credentials && accountServerActionPorts.homeDomainAction
    ? createCliPersonalSavedSecretActionExecute({ credentials: params.credentials, home: accountServerActionPorts.homeDomainAction,
      operationContext: params.savedSecretOperationContext, serverHttpBaseUrl: params.serverHttpBaseUrl, isCredentialCurrent: params.isCredentialCurrent }) : undefined);
  const invokeContributedAction: ActionExecutorDeps['invokeContributedAction'] = params.invokeContributedAction
    ?? (params.pluginActionExecutionOwner === 'current_process' ? undefined
      : async (request) => pluginExecutor!.invokeContributedAction(request));
  const actionSettingsProvider = params.actionsSettingsProvider ?? createActionSettingsProvider({
    scopeKey: resolveAccountSettingsScopeKeyForToken(params.token),
  });
  const runtimeAccountId = readAccountIdFromToken(params.token) ?? undefined;
  const requesterPrivateEffectAuthorityFailure = (actionId: ActionId, context: ActionExecutorContext | undefined) => {
    const binding = context?.externalActionExecutionAuthorization?.binding;
    if (!binding || !('authentication' in binding) || !binding.sessionActionOrigin
      || binding.accountId === runtimeAccountId) return null;
    const effect = getActionSpec(actionId).sideEffectClass;
    if (effect === 'none' || effect === 'read') return null;
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
      clientActionExecute: params.clientActionExecute ?? (async ({ actionId }) => clientActionUnavailable(actionId)),
      ...(params.confidentialSecretFill ? { confidentialSecretFill: params.confidentialSecretFill } : {}),
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
      ...(params.approvalRequestApprovedReplay
        ? { approvalRequestApprovedReplay: params.approvalRequestApprovedReplay }
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
      ...(params.routeHostChildAction ? { routeHostChildAction: params.routeHostChildAction } : {}),
      ...(params.managedMachineAction ? { managedMachineAction: params.managedMachineAction } : {}),
      ...(params.machineEnvironmentApply ? { machineEnvironmentApply: params.machineEnvironmentApply } : {}),
      ...(params.sessionStop ? { sessionStop: params.sessionStop } : {}),
      ...(params.hostActionApprovalLifetime ? { hostActionApprovalLifetime: params.hostActionApprovalLifetime } : {}),
      ...(params.runActionOperation ? { runActionOperation: params.runActionOperation } : {}),
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
        ...(params.credentials ? {
          prepareSourceKeyAfterSet: createSessionFollowSourceKeyPreparationAfterSet({
            credentials: params.credentials,
            ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
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
          }),
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
  const executeInCurrentProcess: NonNullable<Parameters<typeof createDaemonPluginActionExecutor>[0]['executeInCurrentProcess']> =
    async (actionId, input, context) => {
      const { executeAccountPluginAction } = await import('./executeAccountPluginAction');
      return await executeAccountPluginAction({ host: params, deps: harness.deps,
        actionId, input, ...(context ? { context } : {}) });
    };
  const pluginExecutor = params.pluginActionExecutionOwner === 'current_process'
    ? params.accountPluginActions ? createPluginActionExecutor({ base, executeInCurrentProcess }) : null
    : createDaemonPluginActionExecutor({ base, executeInCurrentProcess });
  const daemonAware = pluginExecutor ?? base;
  const resolveContext = async (context: RpcActionExecutorContext | undefined) => {
    const currentWorkspaceWrites = harness.deps.getCurrentWorkspaceWrites?.();
    const credential = params.credentials && hasStoredSessionCredentialProvenance(params.credentials) ? 'terminal' : 'api_token';
    const surface = context?.surface ?? 'cli';
    // RPC receivers already have the verified caller stamp. The host's terminal
    // opt-out cannot narrow an Account/UI caller; an unstamped RPC stays automation.
    let authority = surface === 'rpc'
      ? credential === 'terminal' ? context?.authority ?? 'account_automation' : 'account_automation'
      : context?.authority === 'account_automation' ? 'account_automation' : resolveInvocationAuthority({
        credential, surface,
        terminalPolicy: resolveEffectiveTerminalPresentUserPolicy({
          token: params.token,
          ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
        }),
      });
    let authorization = context?.externalActionExecutionAuthorization;
    const sessionBinding = authorization && 'authentication' in authorization.binding
      && authorization.binding.sessionActionOrigin ? authorization.binding : null;
    const privateKey = params.externalActionMachineRequestPrivateKey;
    const admission = context?.machineAdmission;
    const requesterAccount = authorization?.requesterAccountProjection;
    const requesterHttp = authorization?.requesterHttpProjection;
    const admittedPrivateUiCustody = Boolean(authorization && 'authentication' in authorization.binding
      && authorization.binding.authentication.kind === 'account'
      && !authorization.binding.sessionActionOrigin && !authorization.binding.workflowActionOrigin
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
    // Ordinary Account UI ingress retains its human cause only at its exact
    // credential-backed receiver, after the incumbent Home verifier checks
    // the installed destination's signed request. A raw origin cannot confer it.
    const privatelyReconciledSession = Boolean(admittedPrivateUiCustody && authorization
      && authorization.binding.target.kind === 'machine'
      && authorization.binding.target.machineId === authorization.binding.machineId
      && context?.externalActionTarget?.kind === 'session'
      && context.defaultSessionId === context.externalActionTarget.sessionId);
    const ordinaryUiBinding = authorization && 'authentication' in authorization.binding
      && !authorization.binding.sessionActionOrigin && surface === 'ui' && context?.authority === 'present_user'
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
    let managedControllerUiBinding: typeof ordinaryUiBinding = null;
    if (authorization && 'authentication' in authorization.binding
      && authorization.binding.authentication.kind === 'account'
      && isManagedControllerCodecActionV1(authorization.binding)
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
    if ((admittedReceiver || ordinaryUiBinding || managedControllerUiBinding) && authorization && privateKey && params.externalActionMachineInstallationId
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
      if (ordinaryUiBinding || managedControllerUiBinding) authority = resolveInvocationAuthority({ credential: 'account', surface });
    }
    const credentials = params.credentials;
    if (ordinaryUiBinding && credentials && !params.actionsSettingsProvider) {
      const managedAction = ManagedMachineActionIdV1Schema.safeParse(ordinaryUiBinding.actionId);
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
    const approvalAuthorization = authorization;
    const signExternalActionApprovalInput: ActionExecutorContext['signExternalActionApprovalInput'] =
      context?.signExternalActionApprovalInput
      ?? ((ordinaryUiBinding || managedControllerUiBinding || canSignOriginalSessionApproval || admittedReceiver && runtimeAccountId === sessionBinding?.accountId)
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
    ...(!params.credentials && surface !== 'rpc' && !context?.machineAdmission && runtimeAccountId ? { runtimeAccountId } : {}),
    actionsSettings: actionSettingsProvider.getActionsSettings(),
    sessionAgentSpawnPolicyV1:
      context?.sessionAgentSpawnPolicyV1
      ?? actionSettingsProvider.getAccountSettings?.()?.sessionAgentSpawnPolicyV1,
    });
  };
  return {
    observeRecordedApprovalExecution: harness.observeRecordedApprovalExecution,
    prepare: async (actionId, input, context) => {
      const denied = filesystemRequesterAuthorityFailure(actionId, context)
        ?? requesterPrivateEffectAuthorityFailure(actionId, context);
      if (denied) return { kind: 'settled' as const, result: denied };
      const resolvedContext = await measureActionStartPhaseV1(context, 'cli_context', () => resolveContext(context));
      if (!resolvedContext) return { kind: 'settled' as const,
        result: actionStartTargetUnavailableV1(context, 'cli_context', 'requester_projection_unavailable') };
      // The daemon binds drafts before signing, but an unchanged signed reply
      // must still refuse if its current participant policy now requires a draft.
      // Already-bound drafts carry discussionReplyReturn and skip this recheck.
      const bound = await bindDiscussionDraftReply({ actionId, input, context: resolvedContext,
        serverId: params.serverId ?? configuration.activeServerId, discussionAction: harness.deps.discussionAction,
        credentials: { token: params.token }, serverHttpBaseUrl: params.serverHttpBaseUrl });
      if ('failure' in bound) return { kind: 'settled' as const, result: bound.failure };
      return await base.prepare(bound.actionId, bound.input, bound.context);
    },
    execute: async (actionId, input, context) => {
      const denied = filesystemRequesterAuthorityFailure(actionId, context)
        ?? requesterPrivateEffectAuthorityFailure(actionId, context);
      if (denied) return denied;
      const resolvedContext = await measureActionStartPhaseV1(context, 'cli_context', () => resolveContext(context));
      if (!resolvedContext) return actionStartTargetUnavailableV1(context, 'cli_context', 'requester_projection_unavailable');
      // Retain the same current-policy recheck as prepare; never rewrite signed operands.
      const bound = await bindDiscussionDraftReply({ actionId, input, context: resolvedContext,
        serverId: params.serverId ?? configuration.activeServerId, discussionAction: harness.deps.discussionAction,
        credentials: { token: params.token }, serverHttpBaseUrl: params.serverHttpBaseUrl });
      if ('failure' in bound) return bound.failure;
      return await daemonAware.execute(bound.actionId, bound.input, bound.context);
    },
    continueConfidentialApprovalRequest: async (input, context) => {
      const resolvedContext = await measureActionStartPhaseV1(context, 'cli_context', () => resolveContext(context));
      return resolvedContext ? await base.continueConfidentialApprovalRequest(input, resolvedContext)
        : actionStartTargetUnavailableV1(context, 'cli_context', 'requester_projection_unavailable');
    },
    replayApprovedApprovalRequest: async (args) => await base.replayApprovedApprovalRequest({ ...args,
      // These facts come from this actual credentialed Home, not editable
      // Artifact metadata or an RPC caller's claimed Account. The existing
      // admitted callerAuthority remains separate and is not upgraded here.
      currentAccount: runtimeAccountId && params.serverId && params.serverIdentityId ? {
        accountId: runtimeAccountId, serverId: params.serverId, serverIdentityId: params.serverIdentityId,
      } : undefined,
    }),
  };
}
