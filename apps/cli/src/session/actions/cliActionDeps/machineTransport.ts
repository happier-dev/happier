import { resolveMachineRpcExternalActionEffectV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import type { CliActionDepsParams } from './types';
import type { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ManagedMachineActionIdV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isManagedControllerCodecActionV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import type { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { RpcLocalActionContext } from '@/api/rpc/types';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/socketRpc';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import type { callExactMachineRpc, callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
export function executionRunAuthorityCeiling(opts?: Pick<ActionExecutorContext, 'authority'>): Readonly<{
    authorityCeiling?: 'account_automation';
  }> {
    return opts?.authority === 'account_automation' ? { authorityCeiling: 'account_automation' } : {};
  }
export type CliMachineActionCall = (input: Readonly<{
    processEnvironmentRead?: RpcLocalActionContext['processEnvironmentRead'];
    machineId: string;
    authority?: ActionExecutorContext['authority'];
    serverId?: string;
    method: string;
    request: unknown;
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

export function createCliMachineActionTransport(
  params: Pick<CliActionDepsParams, 'credentials' | 'serverId' | 'serverIdentityId' | 'serverHttpBaseUrl' | 'machineActionDirectTargetTransport' | 'externalActionMachineRequestPrivateKey' | 'externalActionMachineInstallationId'>,
): Readonly<{ callMachineAction: CliMachineActionCall; isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent }> {
  const isMachineActionServerScopeCurrent = async (input: Readonly<{
    serverId?: string | null;
    machineId?: ActionExecutorContext['executionRunTargetMachineId'];
    context?: ActionExecutorContext;
    signal?: AbortSignal;
  }>): Promise<boolean> => {
    if (!input.serverId) return true;
    const context = input.context;
    const replayHomeIdentityId = input.machineId && context?.bypassApprovals
      && context.serverId === input.serverId && context.serverIdentityId
      && context.executionRunTargetMachineId === input.machineId
      && params.machineActionDirectTargetTransport?.machineId === input.machineId
      ? context.serverIdentityId : null;
    if (params.serverIdentityId) {
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
      ...ACTION_ID_FAMILIES_V1.machine_processes,
      ...ACTION_ID_FAMILIES_V1.machine_storage,
      ...ACTION_ID_FAMILIES_V1.machine_guard,
      ...ACTION_ID_FAMILIES_V1.machine_reboot,
    ].flatMap(actionId => {
      const method = getActionSpec(actionId).bindings?.rpcMethod;
      return method ? [method] : [];
    }),
    // Native browser stores belong to the OS user. Always spend authenticated
    // Machine ingress so a shared-Machine Use requester cannot bypass Manage locally.
    RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES,
    RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ,
    RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY,
    RPC_METHODS.DAEMON_VITALS_WATCH, RPC_METHODS.DAEMON_PROCESSES_WATCH,
    RPC_METHODS.DAEMON_STORAGE_WATCH, RPC_METHODS.DAEMON_GUARD_WATCH,
    // Issuer-side approval has no receiving Machine stamp. Open's ordinary
    // Account replay must pass authenticated ingress, like resource effects.
    RPC_METHODS.PROJECTS_OPEN,
    // Configured-Agent jobs require receiving Machine admission, which local
    // approval replay does not carry. Direct-only hosts can still install
    // bundled tools; configured definitions remain refused without admission.
    ...(params.credentials ? [
      RPC_METHODS.DAEMON_AGENTS_INSTALL_START,
      RPC_METHODS.DAEMON_AGENTS_INSTALL_READ,
      RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL,
    ] : []),
  ]);
  const callMachineAction = async (input: Readonly<{
    processEnvironmentRead?: RpcLocalActionContext['processEnvironmentRead'];
    machineId: string;
    authority?: ActionExecutorContext['authority'];
    serverId?: string;
    method: string;
    request: unknown;
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
  }>): Promise<unknown> => {
    if (!await isMachineActionServerScopeCurrent(input)) {
      throw Object.assign(new Error('server_scope_mismatch'), { code: 'server_scope_mismatch' });
    }
    if (input.context?.actionCaller?.kind === 'workflowRun' && !input.context.externalActionExecutionAuthorization
      && input.effectActionId && ManagedMachineActionIdV1Schema.safeParse(input.effectActionId).success) {
      const publisherMachineId = params.machineActionDirectTargetTransport?.machineId;
      if (!params.credentials || !publisherMachineId || !params.serverIdentityId
        || !params.externalActionMachineRequestPrivateKey || !params.externalActionMachineInstallationId
        || !input.context.actionRequestId) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
      const execution = await dispatchOriginalAccountAction({ actionId: input.effectActionId,
        input: input.request, requestId: input.context.actionRequestId, target: { kind: 'machine', machineId: input.machineId },
        credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        serverIdentityId: params.serverIdentityId, authority: 'account_automation',
        installedWorkflow: { context: input.context, machineId: publisherMachineId,
          installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey },
        ...(input.signal ? { signal: input.signal } : {}) });
      if (!execution.ok) throw Object.assign(new RpcError(execution.error, execution.errorCode),
        execution.details === undefined ? {} : { details: execution.details });
      return execution.result;
    }
    const direct = params.machineActionDirectTargetTransport;
    const templateUpdateRoot = input.context?.externalActionExecutionAuthorization;
    if (input.method === RPC_METHODS.MACHINE_SETUP_PLAN && input.effectActionId === 'machines.setup.plan'
      && templateUpdateRoot?.binding.actionId === 'template.updates.apply' && input.context?.originalActionEnvelope) {
      if (!params.credentials || !params.serverIdentityId) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
      const execution = await dispatchOriginalAccountAction({ actionId: 'machines.setup.plan', input: input.request,
        requestId: templateUpdateRoot.binding.requestId, target: { kind: 'machine', machineId: input.machineId },
        credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        serverIdentityId: params.serverIdentityId, authority: input.authority ?? input.context.authority,
        templateRequesterSetupPlanContinuation: { authorization: templateUpdateRoot, originalActionEnvelope: input.context.originalActionEnvelope },
        ...(input.signal ? { signal: input.signal } : {}) });
      if (!execution.ok) throw Object.assign(new RpcError(execution.error, execution.errorCode),
        execution.details === undefined ? {} : { details: execution.details });
      return execution.result;
    }
    const externalRequest = input.context?.externalActionCredential !== undefined
      || input.context?.externalActionExecutionAuthorization !== undefined;
    if (externalRequest && (!params.externalActionMachineRequestPrivateKey || !params.externalActionMachineInstallationId
      || !input.effectActionId || !input.context?.externalActionExecutionAuthorization || !input.context.externalActionTarget)) {
      throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
    }
    // Opened requester custody is host-private. Sending it back through a
    // serialized self-RPC drops its private readers; spend it at this installed owner.
    const [{ readRequesterAccountActionContext }, { callExactMachineRpc, callMachineRpc }] = await Promise.all([import("@/daemon/sessionEncryption/requesterAccountActionContext"), import("@/session/transport/rpc/machineRpc")]);
    const requester = readRequesterAccountActionContext(input.context?.externalActionExecutionAuthorization);
    const admittedLocalRequester = requester?.authorization.binding.machineId === input.machineId;
    const managedBinding = input.context?.externalActionExecutionAuthorization?.binding;
    const managedAdmission = input.context?.machineAdmission;
    const boundToThisMachine = Boolean(managedBinding && managedAdmission
      && managedBinding.machineId === input.machineId && managedAdmission.machineId === input.machineId
      && managedBinding.installationId === managedAdmission.installationId
      && managedBinding.accountId === managedAdmission.actorAccountId
      && managedBinding.custodianAccountId === managedAdmission.custodianAccountId);
    // This in-process admission was installed only after opening the exact
    // controller codec and rechecking Home. Reuse it for the two scoped reads;
    // serializing a self-RPC would lose that private receiver authority.
    const admittedLocalManaged = Boolean(managedBinding && managedAdmission
      && isManagedControllerCodecActionV1(managedBinding)
      && managedBinding.managedAdmission?.actionId === input.effectActionId
      && managedBinding.actionId === input.effectActionId
      && (input.effectActionId === 'action.operations.list' && input.method === ACTION_OPERATION_RPC_METHODS_V2.list
        || input.effectActionId === 'action.operations.get' && input.method === ACTION_OPERATION_RPC_METHODS_V2.get)
      && managedBinding.machineId === input.machineId && managedAdmission.machineId === input.machineId
      && managedBinding.installationId === managedAdmission.installationId
      && managedBinding.accountId === managedAdmission.actorAccountId
      && managedBinding.custodianAccountId === managedAdmission.custodianAccountId
      && input.context?.verifyMachineAdmissionCurrent && await input.context.verifyMachineAdmissionCurrent());
    // Spend the installed native Action admission, including its exact-target preview.
    const admittedLocalAction = Boolean(boundToThisMachine && managedBinding
      && managedBinding.installationId === params.externalActionMachineInstallationId
      && managedBinding.actionId === input.effectActionId
      && resolveMachineRpcExternalActionEffectV1(input.method, managedBinding) === input.effectActionId);
    const admittedProcessRead = admittedLocalRequester && input.processEnvironmentRead !== undefined
      && [RPC_METHODS.MACHINES_PROCESSES_LIST, RPC_METHODS.MACHINES_PROCESSES_GET, RPC_METHODS.MACHINES_PROCESSES_CHECK]
        .some(method => method === input.method);
    // Session-scoped SCM evidence needs verified ingress. This local adapter
    // cannot synthesize it; preserve already-admitted private requester custody
    // and let the canonical protocol map classify ordinary SCM callers.
    const requiresScmSessionIngress = input.authorization && !admittedLocalRequester
      && input.method.startsWith('scm.') && resolveSocketRpcSessionAuthorization(input.method) !== null;
    if (!requiresScmSessionIngress && direct?.machineId === input.machineId && (!externalRequest || admittedLocalRequester || admittedLocalManaged || admittedLocalAction)
      && (!authenticatedMachineIngressMethods.has(input.method) || admittedProcessRead || admittedLocalAction)) {
      const localActionContext: RpcLocalActionContext = {
        ...(input.context?.authenticatedLocalRootCustody
          ? { authenticatedLocalRootCustody: input.context.authenticatedLocalRootCustody } : {}),
        ...(admittedProcessRead ? { processEnvironmentRead: input.processEnvironmentRead } : {}),
        ...(admittedLocalRequester && input.effectActionId === 'session.open'
          && input.context?.actionCaller?.kind === 'session' && input.request
          && typeof input.request === 'object' && 'type' in input.request && input.request.type === 'resume-session'
          ? { resumeActionContext: input.context } : {}),
        ...(input.context?.surface ? { surface: input.context.surface } : {}),
        ...((admittedLocalRequester || admittedLocalManaged || admittedLocalAction) && input.context?.externalActionExecutionAuthorization
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
        callerInputAuthorization: host.callerInputAuthorization,
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
    const reviewedOpinionDirectoryRead = input.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT
      && input.effectActionId === 'session.spawn_new'
      && requester?.authorization.binding.actionId === 'discussion.second_opinion.start';
    const reviewedSetupPlanRead = input.method === RPC_METHODS.MACHINE_SETUP_PLAN && input.effectActionId === 'machines.setup.plan'
      && (requester?.authorization.binding.actionId === 'machines.setup.plan' || requester?.authorization.binding.actionId === 'machines.setup.apply');
    const credentials = reviewedOpinionDirectoryRead || reviewedSetupPlanRead ? requester!.credentials : params.credentials;
    if (!credentials) throw new RpcError('An authenticated Machine transport is required.', 'not_authenticated');
    return readMachineActionRpcResult(await invoke({
      credentials,
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
      ...executionRunAuthorityCeiling(input),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.waitForResultOnCancel ? { waitForResultOnCancel: true } : {}),
    }));
  };
  return { callMachineAction, isMachineActionServerScopeCurrent };
}

