import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { RpcActionExecutorContext } from '../../_actionDispatchAdapter';
import type { HostAgentIsolationLaunchContext, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { logger } from '@/ui/logger';
import type { FilesystemEffectFailureDetailsV1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { CapabilitiesDetectRequest } from '@/capabilities/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readWorkspaceSourcePlacement, runWithWorkspaceSourceDemand, selectWorkspaceSource,
  type WorkspaceSource, type WorkspaceSourcePlacement, type WorkspaceTargetSourceResolver } from '@/workspaces/source/workspaceSource';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions';
import type { SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';

/** Capability admission has already expanded and validated the effective request. */
export function isAgentInventoryRead(method: string, input: unknown): boolean {
  return method === RPC_METHODS.CAPABILITIES_DETECT
    && (input as CapabilitiesDetectRequest).requests?.some(request =>
      request.id.startsWith('cli.') || request.id === 'tool.acpAgentInventory') === true;
}

export type FilesystemEffectFailure = Readonly<{
  errorCode: 'filesystem_identity_custody_unavailable';
  error: string;
  details: FilesystemEffectFailureDetailsV1;
}>;

export type FilesystemEffectRequester = Readonly<{
  identity: HostRequesterExecutionIdentity;
  /** Demand-only projection of the host's Workspace execution policy. */
  canExecuteWorkspaceOnDaemon?: boolean;
  dispose(): Promise<void>;
}>;

/** The Session facts an admitted RPC or Action request carries. */
export type FilesystemEffectSessionContext = Readonly<{
  signal?: AbortSignal;
  sessionActionOrigin?: SessionActionRpcOriginV1;
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
  externalActionExecutionAuthorization?: ExternalActionExecutionAuthorizationV1;
  machineAdmission?: RpcHandlerContext['machineAdmission'];
  authorization?: unknown;
}>;

/**
 * The one reader of the Session an admitted request acts for: an RPC origin, the
 * caller's execution authorization, or an Action's execution authorization.
 */
function readSessionActionOrigin(context: FilesystemEffectSessionContext | undefined) {
  return context?.sessionActionOrigin ?? context?.callerInputAuthorization?.binding.sessionActionOrigin
    ?? context?.externalActionExecutionAuthorization?.binding.sessionActionOrigin;
}

/** Placement of an admitted request: its Session (through the one origin reader) and addressed root. */
function readFilesystemEffectPlacement(context: FilesystemEffectSessionContext | undefined, input: unknown): WorkspaceSourcePlacement {
  return readWorkspaceSourcePlacement({ sessionActionOrigin: readSessionActionOrigin(context), authorization: context?.authorization }, input);
}

/** Host-private effect prerequisite; never a caller-selected path or OS user. */
export type FilesystemEffectAdmission = Readonly<{
  /** `source` is the request's selected workspace source (this Machine's disk when omitted). */
  rpc(context?: RpcHandlerContext, source?: WorkspaceSource): Promise<FilesystemEffectFailure | null>;
  action(context?: RpcActionExecutorContext, alreadySelectedIdentity?: HostRequesterExecutionIdentity, source?: WorkspaceSource): Promise<FilesystemEffectFailure | null>;
  resolveRpcRequester?(context?: RpcHandlerContext): Promise<FilesystemEffectRequester>;
  resolveActionRequester?(context?: RpcActionExecutorContext): Promise<FilesystemEffectRequester>;
  executeRpc?(method: string, input: unknown, context: RpcHandlerContext | undefined,
    ownerEffect: () => Promise<unknown>, projectFailure: (failure: FilesystemEffectFailure) => unknown,
    source?: WorkspaceSource): Promise<unknown>;
  /** The workspace source of this admitted request: this Machine's disk or the Session's target. */
  selectWorkspaceSource(context: FilesystemEffectSessionContext | undefined, input: unknown): Promise<WorkspaceSource>;
}>;

/** Admission belongs to ingress; admitted filesystem work observes local cancellation. */
export async function assertFilesystemEffectCurrent(context?: Readonly<{ signal?: AbortSignal }>): Promise<void> {
  context?.signal?.throwIfAborted();
}

/**
 * Owner effects retain their existing process placement. Isolated effects use
 * the installed native-operation owner: a path check followed by daemon IO
 * cannot emulate another OS user. A missing native port refuses before IO.
 */
export function createFilesystemEffectAdmission(params: Readonly<{
  readAgentIsolation?: HostAgentIsolationLaunchContext['read'];
  resolveHomeServerIdentityId?: () => Promise<string | null>;
  resolveHostIdentity?: (signal?: AbortSignal) => Promise<Readonly<{
    custodianAccountId: string; machineId: string; installationId: string;
  }> | null>;
  resolveSessionRequester?: (sessionId: string, signal?: AbortSignal) => Promise<Readonly<{
    bootstrap: AdmittedRequesterSessionBootstrap; dispose(): Promise<void>;
  }> | null>;
  executeNativeRpc?: (request: Readonly<{ method: string; input: unknown; context: RpcHandlerContext;
    requester: FilesystemEffectRequester; identity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }> }>) => Promise<unknown>;
  /** Session placement owner: the target source of a Session running in an execution target. */
  resolveWorkspaceTarget?: WorkspaceTargetSourceResolver;
  /** Existing Home-backed Session workspace proof, spent only when its live placement is absent. */
  readRetainedSessionWorkspace?: (sessionId: string, signal?: AbortSignal) => Promise<Readonly<{ requiresManagedTarget?: true }> | null>;
  /** Restore a committed Project target on the first demand following a controller restart. */
  restoreManagedWorkspaceTarget?: (workspace: NonNullable<WorkspaceSourcePlacement['workspace']>,
    context: FilesystemEffectSessionContext | undefined) => Promise<WorkspaceSource | null>;
}> = {}): FilesystemEffectAdmission {
  const unavailable = {
    errorCode: 'filesystem_identity_custody_unavailable' as const,
    error: 'Requester-bound filesystem IO is unavailable on this Machine',
  };
  const refuse = (reason: FilesystemEffectFailureDetailsV1['reason']): FilesystemEffectFailure => {
    // This boundary must explain a no-effect refusal without recording file
    // names, bytes, Account identity or transport credentials.
    try { logger.warnLocalFile('[Filesystem] Effect admission refused', {
      code: unavailable.errorCode, phase: 'filesystem_effect_admission', reason,
    }); } catch { /* Diagnostics cannot replace the original typed refusal. */ }
    return { ...unavailable, details: { reason } };
  };
  const resolveRequester = async (input: Readonly<{ rpcContext?: RpcHandlerContext; actionContext?: RpcActionExecutorContext }>): Promise<FilesystemEffectRequester> => {
    if (input.actionContext) input = { ...input,
      actionContext: (await import('@/daemon/agentIsolation/agentIsolationLaunchPolicy'))
        .projectVerifiedExternalActionRequesterContext(input.actionContext) };
    const context = input.rpcContext ?? input.actionContext;
    context?.signal?.throwIfAborted();
    const hostHomeServerIdentityId = params.resolveHomeServerIdentityId
      ? await params.resolveHomeServerIdentityId() : undefined;
    const host = await params.resolveHostIdentity?.(context?.signal);
    const origin = readSessionActionOrigin(context);
    const retained = !context?.requesterSessionBootstrap && origin
      ? await params.resolveSessionRequester?.(origin.caller.sessionId, context?.signal) : undefined;
    let disposed = false;
    const dispose = async () => { if (disposed) return; disposed = true; await retained?.dispose(); };
    try {
      const bootstrap = context?.requesterSessionBootstrap ?? retained?.bootstrap;
      if (origin && bootstrap && bootstrap.getBoundSessionId() !== origin.caller.sessionId)
        return { identity: { kind: 'unknown', reason: 'session_requester_unavailable' }, dispose };
      const policy = await import('@/daemon/agentIsolation/agentIsolationLaunchPolicy');
      const identity = policy.selectHostRequesterExecutionIdentity({ ...input, hostHomeServerIdentityId,
        ...(bootstrap ? { sessionRequester: bootstrap.attribution,
          sessionRequesterHomeServerIdentityId: bootstrap.homeServerIdentityId,
          sessionCustodianAccountId: host?.custodianAccountId } : {}),
        ...(params.resolveHostIdentity ? { hostCustodianAccountId: host?.custodianAccountId ?? null,
          ...(host ? { hostExecutionTarget: { machineId: host.machineId, installationId: host.installationId } } : {}) } : {}) });
      return { identity, dispose, get canExecuteWorkspaceOnDaemon() {
        return policy.canExecuteRequesterWorkspaceOnDaemonForHost(identity, params.readAgentIsolation);
      } };
    } catch (error) { await dispose(); throw error; }
  };
  /**
   * Owner ruling 2026-11-12 (container member access): inside a Session's execution
   * target there is no per-member OS identity. The container boundary, the source's
   * workspace-root confinement and the member's Session access admitted at ingress
   * (a Session-scoped call for the Session the target was selected from) suffice.
   */
  const admitsTargetSessionMember = (context: FilesystemEffectSessionContext | undefined, source: WorkspaceSource | undefined) =>
    source !== undefined && source.kind !== 'local' && readFilesystemEffectPlacement(context, undefined).sessionId !== undefined;
  const admit = async (input: Readonly<{ rpcContext?: RpcHandlerContext; actionContext?: RpcActionExecutorContext }>,
    alreadySelectedIdentity?: HostRequesterExecutionIdentity, source?: WorkspaceSource) => {
    if (input.actionContext) input = { ...input,
      actionContext: (await import('@/daemon/agentIsolation/agentIsolationLaunchPolicy'))
        .projectVerifiedExternalActionRequesterContext(input.actionContext) };
    try {
      // The receiving authorizer already admitted the exact finite installation
      // method/body; the stamp alone grants no generic filesystem access.
      if ((await import('@happier-dev/protocol/machines/managed/actionsV1'))
        .ManagedInstallationServerOriginV1Schema.safeParse(input.rpcContext?.authorization).success) {
        const context = input.rpcContext;
        if (!context?.verifyMachineAdmissionCurrent || context.signal.aborted) return refuse('admission_not_current');
        await assertFilesystemEffectCurrent(context);
        return null;
      }
      const context = input.rpcContext ?? input.actionContext;
      let identity = alreadySelectedIdentity;
      if (identity === undefined) {
        const requester = await resolveRequester(input);
        identity = requester.identity;
        await requester.dispose();
      }
      const policy = await import('@/daemon/agentIsolation/agentIsolationLaunchPolicy');
      if (!policy.isHostRequesterUnrestrictedOwner(identity) && !admitsTargetSessionMember(context, source) && !(params.readAgentIsolation && identity.kind === 'isolated'
        && policy.resolveHostRequesterAgentPlacementForHost({ identity, snapshot: params.readAgentIsolation?.() }) === 'daemon'))
        return refuse('requester_identity_unavailable');
      // The selector consumed receiving admission or authenticated local-root
      // custody. Finite effects observe cancellation, not a second admission.
      if (context?.signal?.aborted) return refuse('admission_not_current');
      await assertFilesystemEffectCurrent(context);
      return null;
    } catch (error) {
      return refuse(error && typeof error === 'object' && 'code' in error && error.code === 'filesystem_identity_custody_unavailable'
        ? 'admission_not_current' : 'admission_unavailable');
    }
  };
  return { rpc: (rpcContext, source) => admit({ rpcContext }, undefined, source),
    selectWorkspaceSource: async (context, input) => selectWorkspaceSource(readFilesystemEffectPlacement(context, input),
      params.resolveWorkspaceTarget, params.readRetainedSessionWorkspace
        ? sessionId => params.readRetainedSessionWorkspace!(sessionId, context?.signal) : undefined,
      params.restoreManagedWorkspaceTarget ? workspace => params.restoreManagedWorkspaceTarget!(workspace, context) : undefined),
    action: (actionContext, alreadySelectedIdentity, source) => admit({ actionContext }, alreadySelectedIdentity, source),
    resolveRpcRequester: rpcContext => resolveRequester({ rpcContext }),
    resolveActionRequester: actionContext => resolveRequester({ actionContext }),
    ...(params.executeNativeRpc ? { executeRpc: async (method: string, input: unknown, context: RpcHandlerContext | undefined,
      ownerEffect: () => Promise<unknown>, projectFailure: (failure: FilesystemEffectFailure) => unknown, source?: WorkspaceSource) => {
      if ((await import('@happier-dev/protocol/machines/managed/actionsV1'))
        .ManagedInstallationServerOriginV1Schema.safeParse(context?.authorization).success) {
        const failure = await admit({ rpcContext: context });
        return failure ? projectFailure(failure) : await ownerEffect();
      }
      const requester = await resolveRequester({ rpcContext: context });
      try {
        const policy = await import('@/daemon/agentIsolation/agentIsolationLaunchPolicy');
        // Session folder preflight must run where the Agent will run. Manage
        // file browsing retains the person's administrator placement.
        const identity = method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT || isAgentInventoryRead(method, input)
          ? policy.resolveHostRequesterAgentExecutionIdentity(requester.identity) : requester.identity;
        if (!context || context.signal.aborted) return projectFailure(refuse('requester_identity_unavailable'));
        // A member of a target Session works through the target's source, never the host OS identity.
        if (admitsTargetSessionMember(context, source)) return await ownerEffect();
        if (identity.kind === 'unknown') return projectFailure(refuse('requester_identity_unavailable'));
        // Ingress has already admitted this arrival. Never invoke an opaque
        // currentness callback here: only its local cancellation is relevant.
        context.signal.throwIfAborted();
        if (policy.isHostRequesterUnrestrictedOwner(identity) || params.readAgentIsolation && identity.kind === 'isolated'
          && policy.resolveHostRequesterAgentPlacementForHost({ identity, snapshot: params.readAgentIsolation?.() }) === 'daemon')
          return await ownerEffect();
        // The native requester channel is this Machine's disk; a target without admitted Session access is refused.
        if (identity.kind !== 'isolated' || source && source.kind !== 'local') return projectFailure(refuse('requester_identity_unavailable'));
        try { return await params.executeNativeRpc!({ method, input, context, identity, requester: { ...requester, identity } }); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === unavailable.errorCode)
            return projectFailure(refuse('requester_identity_unavailable'));
          throw error;
        }
      } finally { await requester.dispose(); }
    } } : {}) };
}

/** Keep legacy aliases and transfer phases at the same physical effect boundary. */
export function createFilesystemEffectRpcRegistrar(
  registrar: RpcHandlerRegistrar,
  admission: FilesystemEffectAdmission,
  projectFailure: (failure: FilesystemEffectFailure) => unknown = failure => ({ success: false, ...failure }),
): RpcHandlerRegistrar {
  return { registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>): void {
    registrar.registerHandler<TRequest, unknown>(method, async (input, context) => {
      // The source is chosen once here; every consumer the handler reaches reads it.
      const source = await admission.selectWorkspaceSource(context, input);
      const ownerEffect = () => runWithWorkspaceSourceDemand(source, () => handler(input, context));
      if (admission.executeRpc) return await admission.executeRpc(method, input, context, ownerEffect, projectFailure, source);
      const failure = await admission.rpc(context, source);
      return failure ? projectFailure(failure) : await ownerEffect();
    });
  } };
}
