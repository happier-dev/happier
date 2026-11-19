import { readSessionAgentReadinessChildActionV1, resolveMachineRpcExternalActionEffectV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { readSessionActionChildCreationRpcEffectV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationActionIdsV1';
import type { CliActionDepsParams } from './types';
import { ACTION_ID_FAMILIES_V1, isWorkspaceSyncRelationshipWriteActionId, isLocalServiceStopActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { HandoffTargetReplacementPreflightV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { isMachineSetupPlanRpcChildV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isMachineSetupCombinedActionIdV1, isOrdinaryMachineSetupNativeActionIdV1, SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { isManagedControllerCodecActionV1, projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import type { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { RpcLocalActionContext } from '@/api/rpc/types';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/socketRpc';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { doesExternalActionConsumeRequesterAccountContentV1, getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import type { callExactMachineRpc, callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { executionRunAuthorityCeiling } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

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
  params: Pick<CliActionDepsParams, 'credentials' | 'serverId' | 'serverIdentityId' | 'serverHttpBaseUrl' | 'machineActionDirectTargetTransport' | 'externalActionMachineRequestPrivateKey' | 'externalActionMachineInstallationId' | 'onRequesterSessionCredentialDisclosure'>,
): Readonly<{ callMachineAction: CliMachineActionCall; isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent }> {
  const isMachineActionServerScopeCurrent = createCliMachineActionServerScopeCurrent(params);
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
      // Workflow materialization also observes the same Machine after durable
      // approval replay. Native detection needs fresh Home admission, not the
      // unadmitted direct hop available to this host-local executor.
      RPC_METHODS.CAPABILITIES_DETECT,
      RPC_METHODS.DAEMON_AGENTS_INSTALL_START,
      RPC_METHODS.DAEMON_AGENTS_INSTALL_READ,
      RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL,
    ] : []),
  ]);
  const callMachineAction: CliMachineActionCall = async (input) => {
    if (!await isMachineActionServerScopeCurrent(input)) {
      throw new RpcError('server_scope_mismatch', 'server_scope_mismatch');
    }
    const originalContext = input.context;
    const originalAccountAction = isLocalServiceStopActionIdV1(input.effectActionId)
      || input.effectActionId === 'execution.run.action'
        && doesExternalActionConsumeRequesterAccountContentV1({ actionId: input.effectActionId, input: input.request });
    if (params.credentials && originalContext && originalAccountAction
      && !originalContext.externalActionExecutionAuthorization && !originalContext.externalActionCredential
      && !originalContext.rpcSessionAuthorization && !originalContext.causalPermissionAuthority
      && (!originalContext.actionCaller || originalContext.actionCaller.kind === 'host')) {
      const target = { kind: 'machine' as const, machineId: input.machineId };
      const accountId = readAccountIdFromToken(params.credentials.token);
      const serverId = originalContext.serverId ?? params.serverId;
      const serverIdentityId = originalContext.serverIdentityId ?? params.serverIdentityId;
      const provenance = readAuthTokenProvenance(decodeJwtPayload(params.credentials.token), { allowLegacyHome: true });
      const authentication = provenance?.provenance.kind;
      const invocation = accountId && serverId && (authentication === 'account' || authentication === 'terminal')
        ? projectExternalActionRequesterInvocationV1({ actionId: input.effectActionId,
          context: { ...originalContext, actionCaller: { kind: 'host' } },
          account: { accountId, serverId, ...(serverIdentityId ? { serverIdentityId } : {}) }, target,
          authentication: { kind: authentication } }) : null;
      if (!invocation || !originalContext.actionRequestId) {
        throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
      }
      const wrapped = TargetedActionRpcRequestV1Schema.safeParse(input.request);
      const execution = await dispatchOriginalAccountAction({ actionId: input.effectActionId,
        input: wrapped.success ? wrapped.data.input : input.request, requestId: originalContext.actionRequestId, target,
        credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        ...(serverIdentityId ? { serverIdentityId } : {}), authority: invocation.authority, invocation,
        ...(params.onRequesterSessionCredentialDisclosure
          ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
        ...(input.signal ? { signal: input.signal } : {}) });
      if (!execution.ok) throw Object.assign(new RpcError(execution.error, execution.errorCode), execution);
      return execution.result;
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
    const direct = params.machineActionDirectTargetTransport;
    const externalRequest = input.context?.externalActionCredential !== undefined
      || input.context?.externalActionExecutionAuthorization !== undefined;
    if (externalRequest && (!params.externalActionMachineRequestPrivateKey || !params.externalActionMachineInstallationId
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
    const managedBinding = input.context?.externalActionExecutionAuthorization?.binding;
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
    const admittedLocalAction = Boolean(boundToThisMachine && managedBinding
      && managedBinding.installationId === params.externalActionMachineInstallationId
      && managedBinding.actionId === input.effectActionId
      && (admittedMoveStatusRead || resolveMachineRpcExternalActionEffectV1(input.method, managedBinding) === input.effectActionId));
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
    const originalRequester = input.context?.verifiedExternalActionRequester;
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
    const requiresScmSessionIngress = input.authorization && !admittedLocalRequester
      && input.method.startsWith('scm.') && resolveSocketRpcSessionAuthorization(input.method) !== null;
    // Native command delegation retains its host-private receiving admission;
    // the installed receiver still owns target/currentness and execution identity.
    const admittedLocalCommand = input.method === RPC_METHODS.BASH && input.effectActionId === 'machines.command.run'
      && input.context?.machineAdmission?.machineId === input.machineId;
    if (!requiresScmSessionIngress && direct?.machineId === input.machineId && (!externalRequest || admittedLocalRequesterAction || admittedProcessRead || admittedLocalManaged || admittedLocalDiscovery || admittedLocalAction)
      && (!authenticatedMachineIngressMethods.has(input.method) || admittedProcessRead || admittedLocalCommand || admittedLocalAction)) {
      const localActionContext: RpcLocalActionContext = {
        ...(input.context?.presentUserApproval ? { presentUserApproval: input.context.presentUserApproval } : {}),
        ...(input.context?.handoffTargetReplacementApproval
          ? { handoffTargetReplacementApproval: input.context.handoffTargetReplacementApproval } : {}),
        ...(input.context?.originalActionEnvelope
          ? { originalActionEnvelope: input.context.originalActionEnvelope } : {}),
        ...(input.context?.authenticatedLocalRootCustody
          ? { authenticatedLocalRootCustody: input.context.authenticatedLocalRootCustody } : {}),
        ...(admittedProcessRead ? { processEnvironmentRead: input.processEnvironmentRead } : {}),
        ...(admittedLocalRequester && input.effectActionId === 'session.open'
          && input.context?.actionCaller?.kind === 'session' && input.request
          && typeof input.request === 'object' && 'type' in input.request && input.request.type === 'resume-session'
          ? { resumeActionContext: input.context } : {}),
        ...(input.context?.surface ? { surface: input.context.surface } : {}),
        ...((admittedLocalRequester || admittedLocalManaged || admittedLocalDiscovery || admittedLocalAction) && input.context?.externalActionExecutionAuthorization
          ? { externalActionExecutionAuthorization: input.context.externalActionExecutionAuthorization } : {}),
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
      };
      const hasLocalActionContext = Object.keys(localActionContext).length > 0;
      // A host child keeps the receiving hop's admission. Local Action authority
      // alone cannot stand in for that fact (interactive terminals require both).
      const host = input.context;
      const rpcContext = host?.machineAdmission ? {
        machineAdmission: host.machineAdmission,
        verifyMachineAdmissionCurrent: host.verifyMachineAdmissionCurrent,
        callerAuthority: input.authority ?? host.authority,
        callerInputAuthorization: host.callerInputAuthorization
          ?? (admittedLocalDiscovery || admittedMoveStatusRead ? host.externalActionExecutionAuthorization : undefined),
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
          // SCM has no native requester identity owner. Keep its exact local
          // custody, but let the receiving authorizer select or refuse that
          // identity instead of treating Action admission as execution identity.
          ...(admittedLocalAction && !input.method.startsWith('scm.')
            ? { admissionResult: { ok: true as const } } : {}),
        } : undefined,
      ));
    }
    const invoke = input.exactMachine ? callExactMachineRpc : callMachineRpc;
    const requestId = input.requestId ?? input.context?.actionRequestId;
    const transportRequester = readRequesterAccountActionTransportContext(input.context?.externalActionExecutionAuthorization);
    const reviewedCreationRead = input.effectActionId === readSessionActionChildCreationRpcEffectV1(input.method,
      transportRequester?.authorization.binding, undefined, readHostAdmittedReviewedChildV1(input.context) ?? undefined);
    const reviewedSetupPlanRead = isMachineSetupPlanRpcChildV1({ rootActionId: transportRequester?.authorization.binding.actionId,
      effectActionId: input.effectActionId, method: input.method });
    const reviewedReadiness = readSessionAgentReadinessChildActionV1(transportRequester?.authorization.binding,
      readHostAdmittedReviewedChildV1(input.context) ?? undefined);
    const readinessEffect = reviewedReadiness && resolveMachineRpcExternalActionEffectV1(input.method, transportRequester?.authorization.binding,
      undefined, readHostAdmittedReviewedChildV1(input.context) ?? undefined) === input.effectActionId;
    const credentials = reviewedCreationRead || reviewedSetupPlanRead || readinessEffect ? transportRequester!.credentials : params.credentials;
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
  return { callMachineAction, isMachineActionServerScopeCurrent };
}

