import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { RpcActionExecutorContext } from '../../_actionDispatchAdapter';
import type { HostAgentIsolationLaunchContext, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { logger } from '@/ui/logger';
import type { FilesystemEffectFailureDetailsV1 } from '@happier-dev/protocol/actions/filesystemActionFamily';

export type FilesystemEffectFailure = Readonly<{
  errorCode: 'filesystem_identity_custody_unavailable';
  error: string;
  details: FilesystemEffectFailureDetailsV1;
}>;

export type FilesystemEffectRequester = Readonly<{ identity: HostRequesterExecutionIdentity; dispose(): Promise<void> }>;

/** Host-private effect prerequisite; never a caller-selected path or OS user. */
export type FilesystemEffectAdmission = Readonly<{
  rpc(context?: RpcHandlerContext): Promise<FilesystemEffectFailure | null>;
  action(context?: RpcActionExecutorContext, alreadySelectedIdentity?: HostRequesterExecutionIdentity): Promise<FilesystemEffectFailure | null>;
  resolveRpcRequester?(context?: RpcHandlerContext): Promise<FilesystemEffectRequester>;
  resolveActionRequester?(context?: RpcActionExecutorContext): Promise<FilesystemEffectRequester>;
  executeRpc?(method: string, input: unknown, context: RpcHandlerContext | undefined,
    ownerEffect: () => Promise<unknown>, projectFailure: (failure: FilesystemEffectFailure) => unknown): Promise<unknown>;
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
    const origin = context?.sessionActionOrigin ?? context?.callerInputAuthorization?.binding.sessionActionOrigin
      ?? input.actionContext?.externalActionExecutionAuthorization?.binding.sessionActionOrigin;
    const retained = !context?.requesterSessionBootstrap && origin
      ? await params.resolveSessionRequester?.(origin.caller.sessionId, context?.signal) : undefined;
    let disposed = false;
    const dispose = async () => { if (disposed) return; disposed = true; await retained?.dispose(); };
    try {
      const bootstrap = context?.requesterSessionBootstrap ?? retained?.bootstrap;
      if (origin && bootstrap && bootstrap.getBoundSessionId() !== origin.caller.sessionId)
        return { identity: { kind: 'unknown', reason: 'session_requester_unavailable' }, dispose };
      const identity = (await import('@/daemon/agentIsolation/agentIsolationLaunchPolicy'))
        .selectHostRequesterExecutionIdentity({ ...input, hostHomeServerIdentityId,
        ...(bootstrap ? { sessionRequester: bootstrap.attribution,
          sessionRequesterHomeServerIdentityId: bootstrap.homeServerIdentityId,
          sessionCustodianAccountId: host?.custodianAccountId } : {}),
        ...(params.resolveHostIdentity ? { hostCustodianAccountId: host?.custodianAccountId ?? null,
          ...(host ? { hostExecutionTarget: { machineId: host.machineId, installationId: host.installationId } } : {}) } : {}) });
      return { identity, dispose };
    } catch (error) { await dispose(); throw error; }
  };
  const admit = async (input: Readonly<{ rpcContext?: RpcHandlerContext; actionContext?: RpcActionExecutorContext }>,
    alreadySelectedIdentity?: HostRequesterExecutionIdentity) => {
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
      if (!policy.isHostRequesterUnrestrictedOwner(identity) && !(params.readAgentIsolation && identity.kind === 'isolated'
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
  return { rpc: rpcContext => admit({ rpcContext }),
    action: (actionContext, alreadySelectedIdentity) => admit({ actionContext }, alreadySelectedIdentity),
    resolveRpcRequester: rpcContext => resolveRequester({ rpcContext }),
    resolveActionRequester: actionContext => resolveRequester({ actionContext }),
    ...(params.executeNativeRpc ? { executeRpc: async (method: string, input: unknown, context: RpcHandlerContext | undefined,
      ownerEffect: () => Promise<unknown>, projectFailure: (failure: FilesystemEffectFailure) => unknown) => {
      if ((await import('@happier-dev/protocol/machines/managed/actionsV1'))
        .ManagedInstallationServerOriginV1Schema.safeParse(context?.authorization).success) {
        const failure = await admit({ rpcContext: context });
        return failure ? projectFailure(failure) : await ownerEffect();
      }
      const requester = await resolveRequester({ rpcContext: context });
      try {
        const identity = requester.identity;
        if (!context || context.signal.aborted || identity.kind === 'unknown')
          return projectFailure(refuse('requester_identity_unavailable'));
        // Ingress has already admitted this arrival. Never invoke an opaque
        // currentness callback here: only its local cancellation is relevant.
        context.signal.throwIfAborted();
        const policy = await import('@/daemon/agentIsolation/agentIsolationLaunchPolicy');
        if (policy.isHostRequesterUnrestrictedOwner(identity) || params.readAgentIsolation && identity.kind === 'isolated'
          && policy.resolveHostRequesterAgentPlacementForHost({ identity, snapshot: params.readAgentIsolation?.() }) === 'daemon')
          return await ownerEffect();
        if (identity.kind !== 'isolated') return projectFailure(refuse('requester_identity_unavailable'));
        try { return await params.executeNativeRpc!({ method, input, context, identity, requester }); }
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
      if (admission.executeRpc) return await admission.executeRpc(method, input, context, async () => await handler(input, context), projectFailure);
      const failure = await admission.rpc(context);
      return failure ? projectFailure(failure) : await handler(input, context);
    });
  } };
}
