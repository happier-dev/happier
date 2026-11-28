import { readProjectExecutionOutputMachineAdmissionMethodV1, readSessionAgentReadinessChildActionV1, resolveMachineRpcExternalActionEffectV1, resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { readReviewedMachineRpcChildFamilyV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/reviewedChildFamilyV1';
import { readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { CliActionDepsParams } from './types';
import { ACTION_ID_FAMILIES_V1, ActionIdSchema, isWorkspaceSyncRelationshipWriteActionId, isLocalServiceStopActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { ACTION_OPERATION_CANCEL_ACTION_ID_V1, ACTION_OPERATION_GET_ACTION_ID_V1, ACTION_OPERATION_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { isProjectWorkspaceSyncOpenActionV1, SESSION_CHECKOUT_REMOVAL_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { HandoffTargetReplacementPreflightV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { isMachineSetupCombinedActionIdV1, isOrdinaryMachineSetupNativeActionIdV1, SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { isManagedControllerCodecActionV1, projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/methodsV1';
import type { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { RpcLocalActionContext } from '@/api/rpc/types';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/socketRpc';
import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import { doesExternalActionConsumeRequesterAccountContentV1, getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import type { callExactMachineRpc, callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { executionRunAuthorityCeiling } from '@/session/transport/rpc/machineRpc';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { readContextRetainedVerifiedExternalActionRequester, readRetainedVerifiedExternalActionRequester } from '@/daemon/agentIsolation/verifiedExternalActionRequester';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { canUseAuthenticatedLocalRequesterForScmRpc } from '@/scm/actions/placement';

export { executionRunAuthorityCeiling } from '@/session/transport/rpc/machineRpc';

/** A fresh Workflow native child is observed only after its signed ingress. */
export function requiresWorkflowMachineActionAdmission(actionId: string, context?: Pick<ActionExecutorContext,
  'actionCaller' | 'actionRequestId' | 'externalActionExecutionAuthorization'>): boolean {
  const caller = context?.actionCaller;
  if (caller?.kind !== 'workflowRun') return false;
  const origin = context?.externalActionExecutionAuthorization?.binding.workflowActionOrigin;
  const parent = caller.authorization.reviewedChild?.actionId
    ?? caller.authorization.externalActionExecutionAuthorization?.binding.actionId;
  const setupInstall = actionId === SESSION_AGENT_READINESS_CHILDREN_V1.acquire.action
    && parent !== undefined && isMachineSetupCombinedActionIdV1(parent);
  return (isOrdinaryMachineSetupNativeActionIdV1(actionId) || setupInstall)
    && (!origin || origin.runId !== caller.runId || origin.requestId !== context?.actionRequestId);
}

export type CliMachineActionCall = (input: Readonly<{
    processEnvironmentRead?: RpcLocalActionContext['processEnvironmentRead'];
    scmSessionWorkspace?: RpcLocalActionContext['scmSessionWorkspace'];
    machineId: string;
    authority?: ActionExecutorContext['authority'];
    serverId?: string;
    method: string;
    request: unknown;
    workflowActionInput?: unknown;
    authorization?: Parameters<typeof callMachineRpc>[0]['authorization'];
    signal?: AbortSignal;
    timeoutMs?: number | null;
    waitForResultOnCancel?: boolean;
    requestId?: string;
    reattachOnReconnect?: Parameters<typeof callMachineRpc>[0]['reattachOnReconnect'];
    exactMachine?: true;
    requireCurrentMachine?: true;
    context?: RpcActionExecutorContext;
    effectActionId?: string;
  }>) => Promise<unknown>;
export type CliOriginalAccountMachineActionDispatch = (input: Readonly<{
    actionId: string;
    machineId: string;
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<ActionExecuteResult | null>;
export type CliMachineActionServerScopeCurrent = (input: Readonly<{
    serverId?: string | null;
    machineId?: ActionExecutorContext['executionRunTargetMachineId'];
    context?: ActionExecutorContext;
    signal?: AbortSignal;
  }>) => Promise<boolean>;

export function createCliMachineActionServerScopeCurrent(
  params: Pick<CliActionDepsParams, 'serverId' | 'serverIdentityId' | 'serverHttpBaseUrl' | 'machineActionDirectTargetTransport'>,
): CliMachineActionServerScopeCurrent {
  return async input => {
    if (!input.serverId) return true;
    const context = input.context;
    const replayHomeIdentityId = input.machineId && context?.bypassApprovals
      && context.serverId === input.serverId && context.serverIdentityId
      && context.executionRunTargetMachineId === input.machineId
      && params.machineActionDirectTargetTransport?.machineId === input.machineId
      ? context.serverIdentityId : null;
    if (params.serverIdentityId) {
      // A pinned Home needs no local profile, but two profiles claiming it leave the target ambiguous.
      const { isServerProfileHomeIdentityAmbiguous } = await import("@/server/serverProfiles");
      if (await isServerProfileHomeIdentityAmbiguous(params.serverIdentityId)) return false;
      const profileId = params.serverId ?? configuration.activeServerId;
      return areServerProfileIdentifiersEquivalent(profileId, input.serverId, identifier =>
        identifier === profileId || identifier === params.serverIdentityId ? params.serverIdentityId
          : identifier === context?.serverId ? replayHomeIdentityId : undefined);
    }
    const [{ isServerProfileHomeIdentity }, { createCurrentMachineExecutionOriginContextResolver }] = await Promise.all([import("@/server/serverProfiles"), import("@/api/machine/resolveCurrentMachineExecutionOriginContext")]);
    if (await isServerProfileHomeIdentity(params.serverId ?? configuration.activeServerId, input.serverId)) return true;
    // Exact daemon replay retains the creator's profile label in its signed
    // proposal. Only that verified origin's current Home/Machine can interpret
    // the label; another input, Home or target is not a routing alias.
    if (!replayHomeIdentityId) return false;
    const current = await createCurrentMachineExecutionOriginContextResolver({
      serverUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      resolveCurrentMachineId: () => params.machineActionDirectTargetTransport?.machineId ?? null,
    })(input.signal);
    return current?.machineId === input.machineId && current?.serverIdentityId === replayHomeIdentityId;
  };
}

export function createCliMachineActionTransport(
  params: Pick<CliActionDepsParams, 'credentials' | 'serverId' | 'serverIdentityId' | 'serverHttpBaseUrl' | 'machineActionDirectTargetTransport' | 'externalActionMachineRequestPrivateKey' | 'externalActionMachineInstallationId'>,
): Readonly<{ callMachineAction: CliMachineActionCall; dispatchOriginalAccountMachineAction: CliOriginalAccountMachineActionDispatch;
  isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent }> {
  const isMachineActionServerScopeCurrent = createCliMachineActionServerScopeCurrent(params);
  // An original (not received) Account caller delivers the whole Action to its Machine:
  // Home admits the requester and the receiving daemon executes. Null: not this caller's route.
  const dispatchOriginalAccountMachineAction: CliOriginalAccountMachineActionDispatch = async (input) => {
    const context = input.context;
    if (!params.credentials || context.externalActionExecutionAuthorization || context.externalActionCredential
      || context.rpcSessionAuthorization || context.causalPermissionAuthority) return null;
    // The original-Account invocation contract carries host and Plugin callers only.
    const caller = context.actionCaller ?? { kind: 'host' as const };
    if (caller.kind !== 'host' && caller.kind !== 'plugin') return null;
    const target = { kind: 'machine' as const, machineId: input.machineId };
    const accountId = readAccountIdFromToken(params.credentials.token);
    const serverId = context.serverId ?? params.serverId;
    const serverIdentityId = context.serverIdentityId ?? params.serverIdentityId;
    const provenance = readAuthTokenProvenance(decodeJwtPayload(params.credentials.token), { allowLegacyHome: true });
    const authentication = provenance?.provenance.kind;
    const invocation = accountId && serverId && (authentication === 'account' || authentication === 'terminal')
      ? projectExternalActionRequesterInvocationV1({ actionId: input.actionId,
        context: { ...context, actionCaller: caller },
        account: { accountId, serverId, ...(serverIdentityId ? { serverIdentityId } : {}) }, target,
        authentication: { kind: authentication } }) : null;
    if (!invocation || !context.actionRequestId) {
      return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    }
    return await dispatchOriginalAccountAction({ actionId: input.actionId, input: input.input,
      requestId: context.actionRequestId, target,
      credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      ...(serverIdentityId ? { serverIdentityId } : {}), authority: invocation.authority, invocation,
      ...(input.signal ? { signal: input.signal } : {}) });
  };
  // Resource handlers require current Machine admission even on this daemon.
  // Derive every Action method from the canonical families; watches share that ingress.
  const authenticatedMachineIngressMethods = new Set<string>([
    // Marker disclosure uses the caller stamped by Machine admission, including on this daemon.
    getActionSpec('machines.runs.list').bindings!.rpcMethod!,
    ...[
      ...ACTION_ID_FAMILIES_V1.machine_agent_isolation,
      ...ACTION_ID_FAMILIES_V1.machine_admin_access,
      ...ACTION_ID_FAMILIES_V1.machine_work_summary,
      ...ACTION_ID_FAMILIES_V1.machine_vitals,
      ...ACTION_ID_FAMILIES_V1.machine_resources,
      ...ACTION_ID_FAMILIES_V1.machine_reachability,
      ...ACTION_ID_FAMILIES_V1.machine_processes,
      ...ACTION_ID_FAMILIES_V1.machine_storage,
      ...ACTION_ID_FAMILIES_V1.machine_guard,
      ...ACTION_ID_FAMILIES_V1.machine_reboot,
    ].flatMap(actionId => {
      const method = getActionSpec(actionId).bindings?.rpcMethod;
      return method ? [method] : [];
    }),
    // The command Action's installed transport uses the legacy shell method.
    RPC_METHODS.BASH,
    // Session folder preflight selects native requester custody. An owner
    // Workflow's local Action context carries no receiving Machine admission.
    RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
    RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH,
    RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_OPTIONS,
    RPC_METHODS.DAEMON_SESSION_CONFIG_OPTION_CHOICES,
    RPC_METHODS.DAEMON_SESSION_CONFIG_OPTION_SET,
    // Native account descriptions use the daemon custodian’s Account. Enter
    // Home's custodian-only route even when the selected daemon is local.
    CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
    // Native browser stores belong to the OS user. Always spend authenticated
    // Machine ingress so a shared-Machine Use requester cannot bypass Manage locally.
    RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES,
    RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ,
    RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY,
    RPC_METHODS.DAEMON_BROWSER_PROFILE_PASSKEYS_APPLY,
    RPC_METHODS.DAEMON_VITALS_WATCH, RPC_METHODS.DAEMON_PROCESSES_WATCH,
    RPC_METHODS.DAEMON_STORAGE_WATCH, RPC_METHODS.DAEMON_GUARD_WATCH,
    // Issuer-side approval has no receiving Machine stamp. Open's ordinary
    // Account replay must pass authenticated ingress, like resource effects.
    RPC_METHODS.PROJECTS_OPEN,
    // Configured-Agent jobs require receiving Machine admission, which local
    // approval replay does not carry. Direct-only hosts can still install
    // bundled tools; configured definitions remain refused without admission.
    ...(params.credentials ? [
      // Entry history spends Home's installed Machine admission, including on
      // the caller's own daemon where a direct Action otherwise lacks that stamp.
      RPC_METHODS.SCM_HISTORY_ENTRIES,
      // Workflow materialization also observes the same Machine after durable
      // approval replay. Native detection needs fresh Home admission, not the
      // unadmitted direct hop available to this host-local executor.
      RPC_METHODS.CAPABILITIES_DETECT,
      RPC_METHODS.DAEMON_AGENTS_INSTALL_START,
      RPC_METHODS.DAEMON_AGENTS_INSTALL_READ,
      RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST,
      RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL,
    ] : []),
  ]);
  const callMachineAction: CliMachineActionCall = async (input) => {
    if (!await isMachineActionServerScopeCurrent(input)) {
      throw new RpcError('server_scope_mismatch', 'server_scope_mismatch');
    }
    const originalContext = input.context;
    const originalAccountAction = isLocalServiceStopActionIdV1(input.effectActionId)
      || input.effectActionId === SESSION_CHECKOUT_REMOVAL_ACTION_IDS_V1[0]
      || isProjectWorkspaceSyncOpenActionV1(input.effectActionId)
      || input.effectActionId === 'execution.run.action'
        && doesExternalActionConsumeRequesterAccountContentV1({ actionId: input.effectActionId, input: input.request });
    if (originalContext && originalAccountAction
      && (!originalContext.actionCaller || originalContext.actionCaller.kind === 'host')) {
      const wrapped = TargetedActionRpcRequestV1Schema.safeParse(input.request);
      const execution = await dispatchOriginalAccountMachineAction({ actionId: input.effectActionId!, machineId: input.machineId,
        input: wrapped.success ? wrapped.data.input : input.request, context: originalContext,
        ...(input.signal ? { signal: input.signal } : {}) });
      if (execution) {
        if (!execution.ok) throw Object.assign(new RpcError(execution.error, execution.errorCode), execution);
        return execution.result;
      }
    }
    if (input.context && input.effectActionId && requiresWorkflowMachineActionAdmission(input.effectActionId, input.context)) {
      const publisherMachineId = params.machineActionDirectTargetTransport?.machineId;
      if (!params.credentials || !publisherMachineId || !params.serverIdentityId
        || !params.externalActionMachineRequestPrivateKey || !params.externalActionMachineInstallationId
        || !input.context.actionRequestId) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
      const execution = await dispatchOriginalAccountAction({ actionId: input.effectActionId,
        input: input.workflowActionInput ?? input.request, requestId: input.context.actionRequestId, target: { kind: 'machine', machineId: input.machineId },
        credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        serverIdentityId: params.serverIdentityId, authority: 'account_automation',
        installedWorkflow: { context: input.context, machineId: publisherMachineId,
          installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey },
        ...(input.signal ? { signal: input.signal } : {}) });
      if (!execution.ok) throw Object.assign(new RpcError(execution.error, execution.errorCode), execution);
      return execution.result;
    }
    const externalRequest = input.context?.externalActionCredential !== undefined
      || input.context?.externalActionExecutionAuthorization !== undefined;
    // A reviewed child retains its ingress identity through the private issuer.
    // The receiver decides this method's access; the transport does not classify
    // which native effects may use that identity.
    const retainedRequester = readContextRetainedVerifiedExternalActionRequester(input.context);
    const retainedLocalRequester = Boolean(retainedRequester
      && retainedRequester.authorization.binding.machineId === input.machineId
      // These routes always invoke the receiving identity authorizer. Other
      // methods keep their incumbent transport and admission requirements.
      && resolveMachineRpcRoutePolicy(input.method).requesterExecutionIsolationRequired === true);
    // A remote operation can attach output on the local Machine. Retain
    // requester Account admission for the attachment's read as well.
    const requesterOutputRead = !externalRequest && input.context?.actionCaller?.kind === 'session'
      && input.effectActionId && readProjectExecutionOutputMachineAdmissionMethodV1(input.effectActionId);
    const direct = requesterOutputRead ? undefined : params.machineActionDirectTargetTransport;
    if (externalRequest && !retainedLocalRequester && (!params.externalActionMachineRequestPrivateKey || !params.externalActionMachineInstallationId
      || !input.effectActionId || !input.context?.externalActionExecutionAuthorization || !input.context.externalActionTarget)) {
      throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
    }
    // Opened requester custody is host-private. Sending it back through a
    // serialized self-RPC drops its private readers; spend it at this installed owner.
    const [{ readRequesterAccountActionContext, readRequesterAccountActionTransportContext }, { callExactMachineRpc, callMachineRpc }] = await Promise.all([import("@/daemon/sessionEncryption/requesterAccountActionContext"), import("@/session/transport/rpc/machineRpc")]);
    const requester = readRequesterAccountActionContext(input.context?.externalActionExecutionAuthorization);
    const normalSyncRoot = input.context?.externalActionExecutionAuthorization;
    if (direct?.workspaceSyncPreflightTarget && input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT
      && normalSyncRoot && isWorkspaceSyncRelationshipWriteActionId(normalSyncRoot.binding.actionId)
      && normalSyncRoot.binding.machineId === direct.machineId && input.context) {
      return direct.workspaceSyncPreflightTarget(HandoffTargetReplacementPreflightV1Schema.parse(input.request), {
        signal: input.signal ?? input.context.signal ?? new AbortController().signal,
        machineAdmission: input.context.machineAdmission,
        verifyMachineAdmissionCurrent: input.context.verifyMachineAdmissionCurrent,
        callerAuthority: input.authority ?? input.context.authority,
        callerInputAuthorization: normalSyncRoot, originalActionEnvelope: input.context.originalActionEnvelope,
        callerInputConstraints: input.context.callerInputConstraints, sessionActionOrigin: input.context.sessionActionOrigin,
        localActionContext: { ...input.context,
          executionRunTargetMachineId: input.context.executionRunTargetMachineId ?? undefined,
          executionRunWorkflowRunId: input.context.executionRunWorkflowRunId ?? undefined },
      });
    }
    const admittedLocalRequester = requester?.authorization.binding.machineId === input.machineId;
    const admittedLocalRequesterAction = admittedLocalRequester
      && requester?.authorization.binding.actionId === input.effectActionId;
    const executionAuthorization = input.context?.externalActionExecutionAuthorization;
    const managedBinding = executionAuthorization?.binding;
    const managedAdmission = input.context?.machineAdmission;
    const boundToThisMachine = Boolean(managedBinding && managedAdmission
      && managedBinding.machineId === input.machineId && managedAdmission.machineId === input.machineId
      && managedBinding.installationId === managedAdmission.installationId
      && managedBinding.accountId === managedAdmission.actorAccountId
      && managedBinding.custodianAccountId === managedAdmission.custodianAccountId);
    // The receiving signed Action already owns this native invocation. Delegate
    // its exact method with that private context: a serialized self-RPC loses
    // operation acceptance and cannot reuse an Action-envelope proof as an RPC proof.
    // Role/target authorization for this method was decided once by Home's Action
    // admission (machineAccess method policy); invokeLocal spends that receiving
    // Machine admission and does not re-authorize the role.
    const admittedMoveStatusRead = Boolean(boundToThisMachine && managedBinding
      && managedBinding.actionId === 'projects.service.relocate'
      && input.effectActionId === managedBinding.actionId
      && input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST
      && managedBinding.workspaceSyncAdmission?.source.machineId === input.machineId
      && managedBinding.workspaceSyncAdmission.source.installationId === params.externalActionMachineInstallationId);
    const originalRequester = input.context?.verifiedExternalActionRequester;
    // The requester operation spends its verified Account scope inside the installed
    // operation store. Its carrier has no authority on the general RPC route.
    const admittedRequesterOperation = managedBinding?.requesterOperationRead
      && (input.effectActionId === ACTION_OPERATION_GET_ACTION_ID_V1 && input.method === ACTION_OPERATION_RPC_METHODS_V2.get
        || input.effectActionId === ACTION_OPERATION_LIST_ACTION_ID_V1 && input.method === ACTION_OPERATION_RPC_METHODS_V2.list
        || input.effectActionId === ACTION_OPERATION_CANCEL_ACTION_ID_V1 && input.method === ACTION_OPERATION_RPC_METHODS_V1.cancel)
      && readRetainedVerifiedExternalActionRequester(executionAuthorization) !== undefined;
    const reviewedChild = readHostAdmittedReviewedChildV1(input.context) ?? undefined;
    // Guard Undo's way back is a host child on this same Machine: the Activity
    // owner selected it from its own receipt (or its installation-signed Ask
    // replays it). It spends the receiving Manage admission of the Undo on the
    // child's own native method; a self-RPC through Home would carry an Undo
    // root that does not imply the child's family.
    const effectSpec = input.effectActionId ? ActionIdSchema.safeParse(input.effectActionId) : undefined;
    const guardUndoWayBack = managedBinding?.actionId === 'machines.guard.activity.undo' && effectSpec?.success === true
      && effectSpec.data !== managedBinding.actionId && getActionSpec(effectSpec.data).bindings?.rpcMethod === input.method;
    const admittedLocalAction = Boolean(boundToThisMachine && managedBinding
      && managedBinding.installationId === params.externalActionMachineInstallationId
      && (guardUndoWayBack || (managedBinding.actionId === input.effectActionId
        || readSessionAgentReadinessChildActionV1(managedBinding, reviewedChild) === input.effectActionId)
      && (managedBinding.requesterOperationRead ? admittedRequesterOperation
        : admittedMoveStatusRead || resolveMachineRpcExternalActionEffectV1(input.method, managedBinding, undefined, reviewedChild) === input.effectActionId)));
    // This in-process admission was installed only after opening the exact
    // controller codec at Home. Reuse it for the two scoped reads; serializing
    // a self-RPC would lose that private receiver authority. A foreign requester
    // reaches only the effects named here, so the allowlist stays.
    const admittedLocalManaged = Boolean(boundToThisMachine && managedBinding
      && isManagedControllerCodecActionV1(managedBinding)
      && managedBinding.managedAdmission?.actionId === input.effectActionId
      && managedBinding.actionId === input.effectActionId
      && (input.effectActionId === 'action.operations.list' && input.method === ACTION_OPERATION_RPC_METHODS_V2.list
        || input.effectActionId === 'action.operations.get' && input.method === ACTION_OPERATION_RPC_METHODS_V2.get));
    // Options admission already authorized discovery at this installed Machine.
    // Keep that original proof through the native effect gate, rather than
    // re-entering Account HTTP under the child's ungranted inventory Action.
    const admittedLocalDiscovery = Boolean(boundToThisMachine && input.context?.externalActionCredential && managedBinding
      && managedBinding.actionId === 'action.options.resolve'
      && input.method === RPC_METHODS.CAPABILITIES_INVOKE
      && input.request && typeof input.request === 'object' && 'method' in input.request
      && (input.effectActionId === 'agents.models.list' && input.request.method === 'probeModels'
        || input.effectActionId === 'agents.config_options.list' && input.request.method === 'probeConfigOptions')
      && originalRequester && originalRequester.authorization === input.context.externalActionExecutionAuthorization
      && managedBinding.installationId === params.externalActionMachineInstallationId);
    const admittedProcessRead = admittedLocalRequester && input.processEnvironmentRead !== undefined
      && [RPC_METHODS.MACHINES_PROCESSES_LIST, RPC_METHODS.MACHINES_PROCESSES_GET, RPC_METHODS.MACHINES_PROCESSES_CHECK]
        .some(method => method === input.method);
    // Session-scoped SCM evidence needs verified ingress. This local adapter
    // cannot synthesize it; preserve already-admitted private requester custody
    // and let the canonical protocol map classify ordinary SCM callers.
    const requiresScmSessionIngress = input.authorization && !admittedLocalRequester && !retainedLocalRequester
      && input.method.startsWith('scm.') && resolveSocketRpcSessionAuthorization(input.method) !== null;
    // Native command delegation retains its host-private receiving admission;
    // the installed receiver still owns target/currentness and execution identity.
    const admittedLocalCommand = input.method === RPC_METHODS.BASH && input.effectActionId === 'machines.command.run'
      && input.context?.machineAdmission?.machineId === input.machineId;
    // A Run's Machine assignment is independent of the target Session. Enter
    // the ordinary Home Stop admission with the starter's credentials.
    const requiresWorkflowStopIngress = input.method === RPC_METHODS.STOP_SESSION
      && input.context?.actionCaller?.kind === 'workflowRun';
    if (!requiresScmSessionIngress && !requiresWorkflowStopIngress
      && direct?.machineId === input.machineId && (!externalRequest || retainedLocalRequester || admittedLocalRequesterAction || admittedProcessRead || admittedLocalManaged || admittedLocalDiscovery || admittedLocalAction)
      && (!authenticatedMachineIngressMethods.has(input.method) || admittedProcessRead || admittedLocalCommand || admittedLocalAction)) {
      const localExecutionAuthorization = retainedLocalRequester
        ? retainedRequester?.authorization
        : input.context?.externalActionExecutionAuthorization;
      const localActionContext: RpcLocalActionContext = {
        ...(input.context?.presentUserApproval ? { presentUserApproval: input.context.presentUserApproval } : {}),
        ...(input.context?.handoffTargetReplacementApproval
          ? { handoffTargetReplacementApproval: input.context.handoffTargetReplacementApproval } : {}),
        ...(input.context?.originalActionEnvelope
          ? { originalActionEnvelope: input.context.originalActionEnvelope } : {}),
        ...(input.context?.authenticatedLocalRootCustody
          ? { authenticatedLocalRootCustody: input.context.authenticatedLocalRootCustody } : {}),
        ...(input.context?.admittedHostWorkflowRequester
          ? { admittedHostWorkflowRequester: input.context.admittedHostWorkflowRequester } : {}),
        ...(admittedProcessRead ? { processEnvironmentRead: input.processEnvironmentRead } : {}),
        ...(retainedLocalRequester && input.scmSessionWorkspace
          ? { scmSessionWorkspace: input.scmSessionWorkspace } : {}),
        ...(admittedLocalRequester && input.effectActionId === 'session.open'
          && input.context?.actionCaller?.kind === 'session' && input.request
          && typeof input.request === 'object' && 'type' in input.request && input.request.type === 'resume-session'
          ? { resumeActionContext: input.context } : {}),
        ...(input.context?.surface ? { surface: input.context.surface } : {}),
        ...((retainedLocalRequester || admittedLocalRequester || admittedLocalManaged || admittedLocalDiscovery || admittedLocalAction) && localExecutionAuthorization
          ? { externalActionExecutionAuthorization: localExecutionAuthorization } : {}),
        ...((input.authority ?? input.context?.authority) ? { authority: input.authority ?? input.context?.authority } : {}),
        ...(input.context?.actionCaller ? { actionCaller: input.context.actionCaller } : {}),
        ...(input.context?.callerPermissionMode !== undefined ? { callerPermissionMode: input.context.callerPermissionMode } : {}),
        ...(input.context?.causalPermissionAuthority !== undefined ? { causalPermissionAuthority: input.context.causalPermissionAuthority } : {}),
        ...(input.context?.callerInputConstraints ? { callerInputConstraints: input.context.callerInputConstraints } : {}),
        ...(input.context?.agentStartContext ? { agentStartContext: input.context.agentStartContext } : {}),
        ...(input.context?.agentStartWorkDepth !== undefined ? { agentStartWorkDepth: input.context.agentStartWorkDepth } : {}),
        ...(input.context?.agentStartWorkspaceWrites !== undefined ? { agentStartWorkspaceWrites: input.context.agentStartWorkspaceWrites } : {}),
        ...(input.context?.sessionAgentSpawnPolicyV1 !== undefined ? { sessionAgentSpawnPolicyV1: input.context.sessionAgentSpawnPolicyV1 } : {}),
        ...(input.context?.actionRequestId ? { actionRequestId: input.context.actionRequestId } : {}),
        ...(input.context?.executionRunWorkflowRunId ? { executionRunWorkflowRunId: input.context.executionRunWorkflowRunId } : {}),
        ...(input.context?.executionRunWorkflowScope ? { executionRunWorkflowScope: input.context.executionRunWorkflowScope } : {}),
        ...(input.context?.executionRunTargetMachineId ? { executionRunTargetMachineId: input.context.executionRunTargetMachineId } : {}),
        ...(input.context?.operationProgress ? { operationProgress: input.context.operationProgress } : {}),
        ...(input.context?.operationOwnerUpdate ? { operationOwnerUpdate: input.context.operationOwnerUpdate } : {}),
        ...(input.context?.operationAcceptance ? { operationAcceptance: input.context.operationAcceptance } : {}),
        ...(input.context?.operationCancellation ? { operationCancellation: input.context.operationCancellation } : {}),
        ...(input.context?.operationReview ? { operationReview: input.context.operationReview } : {}),
        ...(input.context?.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: input.context.requesterWorkAttributionV1 } : {}),
        // A package-script open/restart spends its reviewed script child in this process.
        ...(input.context?.hostReviewedChild && (input.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE
          || input.method === RPC_METHODS.DAEMON_TERMINAL_RESTART) ? { hostReviewedChild: input.context.hostReviewedChild } : {}),
      };
      const hasLocalActionContext = Object.keys(localActionContext).length > 0;
      // A host child keeps the receiving hop's admission. Local Action authority
      // alone cannot stand in for that fact (interactive terminals require both).
      const host = input.context;
      const authenticatedLocalRequester = host?.authenticatedLocalRootCustody?.machineId === input.machineId
        && !externalRequest && canUseAuthenticatedLocalRequesterForScmRpc(input.method);
      const rpcContext = host && (host.machineAdmission || retainedLocalRequester || authenticatedLocalRequester) ? {
        machineAdmission: host.machineAdmission,
        verifyMachineAdmissionCurrent: host.verifyMachineAdmissionCurrent,
        callerAuthority: input.authority ?? host.authority,
        callerInputAuthorization: host?.callerInputAuthorization
          ?? (retainedLocalRequester ? retainedRequester?.authorization : undefined)
          ?? (admittedLocalDiscovery || admittedMoveStatusRead || admittedRequesterOperation && input.effectActionId === ACTION_OPERATION_CANCEL_ACTION_ID_V1
            ? host.externalActionExecutionAuthorization : undefined),
        callerInputConstraints: host.callerInputConstraints,
        sessionActionOrigin: host.sessionActionOrigin,
        originalActionEnvelope: host.originalActionEnvelope,
        requesterSessionBootstrap: host.requesterSessionBootstrap,
      } : undefined;
      return readMachineActionRpcResult(await direct.invoke(
        input.method,
        input.request,
        input.signal || hasLocalActionContext || rpcContext ? {
          ...(input.signal ? { signal: input.signal } : {}),
          ...(hasLocalActionContext ? { localActionContext } : {}),
          ...(rpcContext ? { rpcContext } : {}),
          // SCM has no native requester identity owner, and a Sync link places
          // the requester's own work by Machine policy. Keep their exact local
          // custody, but let the receiving authorizer select or refuse that
          // identity instead of treating Action admission as execution identity.
          ...(admittedLocalAction && !input.method.startsWith('scm.')
            && input.method !== RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE
            ? { admissionResult: { ok: true as const } } : {}),
        } : undefined,
      ));
    }
    const invoke = input.exactMachine ? callExactMachineRpc : callMachineRpc;
    const requestId = input.requestId ?? input.context?.actionRequestId;
    const transportRequester = readRequesterAccountActionTransportContext(input.context?.externalActionExecutionAuthorization);
    // Reviewed children the owner names spend the original requester's Account
    // transport; the other families keep this host's own credentials.
    const childFamily = readReviewedMachineRpcChildFamilyV1({ binding: transportRequester?.authorization.binding,
      effectActionId: input.effectActionId, method: input.method,
      reviewedChild: readHostAdmittedReviewedChildV1(input.context) ?? undefined });
    const credentials = childFamily === 'creation' || childFamily === 'setup_plan' || childFamily === 'readiness'
      || childFamily === 'backup_receiver_setup' || childFamily === 'session_project_files_source'
      ? transportRequester?.credentials : params.credentials;
    if (!credentials) throw new RpcError('An authenticated Machine transport is required.', 'not_authenticated');
    return readMachineActionRpcResult(await invoke({
      credentials,
      serverUrl: params.serverHttpBaseUrl,
      machineId: input.machineId,
      method: input.method,
      request: input.request,
      ...(input.requireCurrentMachine ? { requireCurrentMachine: true } : {}),
      ...(requestId ? { requestId } : {}),
      ...(input.reattachOnReconnect ? { reattachOnReconnect: input.reattachOnReconnect } : {}),
      ...(externalRequest && input.context && input.effectActionId && params.externalActionMachineInstallationId
        && params.externalActionMachineRequestPrivateKey ? { externalAction: { context: input.context, effectActionId: input.effectActionId,
          installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey } } : {}),
      ...(input.authorization ? { authorization: input.authorization } : {}),
      ...executionRunAuthorityCeiling({ authority: input.authority ?? input.context?.authority }),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.waitForResultOnCancel ? { waitForResultOnCancel: true } : {}),
    }));
  };
  return { callMachineAction, dispatchOriginalAccountMachineAction, isMachineActionServerScopeCurrent };
}

