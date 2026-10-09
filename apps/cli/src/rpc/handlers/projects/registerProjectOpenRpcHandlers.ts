import type { RpcHandlerRegistrar, RpcHandlerContext } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema, ProjectOpenSyncMaterializationResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { openProject, materializeProjectSyncOnSource, type ProjectOpenRuntime } from '@/workspaces/activation/openProject';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { logger } from '@/ui/logger';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

type RequesterPorts = Pick<Parameters<typeof registerSessionLifecycleRpcHandlers>[0], 'requesterSessionRuntime' | 'requesterBootstrapBoundary'>;

export function registerProjectOpenRpcHandlers(registrar: RpcHandlerRegistrar, input: Readonly<{
  serverId: string;
  machineId: string;
  runtime?: ProjectOpenRuntime;
  observeExecution?: HostActionOperationRuntime['observeExecution'];
}> & RequesterPorts): void {
  async function withRequesterContext<T>(context: RpcHandlerContext | undefined,
    run: (context: RpcHandlerContext | undefined, signing?: ProjectOpenRuntime['requesterMachineRpcSigning']) => Promise<T>): Promise<T> {
    const authorization = context?.callerInputAuthorization;
    if (!authorization || authorization.requesterAccountProjection && authorization.requesterHttpProjection) return run(context);
    const boundary = input.requesterBootstrapBoundary;
    const owner = input.requesterSessionRuntime;
    const origin = authorization.binding.sessionActionOrigin;
    const source = authorization.binding.sessionActionSource;
    const admission = context.machineAdmission;
    // The exact authenticated origin is the only Session lookup key. A target
    // Machine's other Sessions cannot provide custody for a requester invocation.
    if (!boundary || !owner || origin?.caller.kind !== 'session' || !source || !admission
      || boundary.serverId !== input.serverId || owner.serverId !== input.serverId
      || source.machineId !== input.machineId || source.installationId !== admission.installationId
      || authorization.binding.machineId !== input.machineId
      || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) return run(context);
    const runtime = await owner.resolve(origin.caller.sessionId).catch(() => null);
    if (!runtime) return run(context);
    try {
      const bootstrap = runtime.bootstrap;
      const { isAdmittedRequesterSessionBootstrapCurrent } = await import('@/daemon/sessionEncryption/requesterSessionCredentials');
      if (bootstrap.getBoundSessionId() !== origin.caller.sessionId
        || bootstrap.attribution.serverId !== input.serverId
        || !await isAdmittedRequesterSessionBootstrapCurrent({ ...context, requesterSessionBootstrap: bootstrap })) return await run(context);
      const identity = await boundary.getObservedServerIdentityId();
      const installation = await boundary.readInstallation?.().catch(() => null);
      if (!identity || !installation || installation.machineId !== admission.machineId
        || installation.identity.installationId !== admission.installationId) return await run(context);
      const accountAuthorization = await bootstrap.projectExternalActionAuthorization(authorization, identity, context.signal);
      if (!accountAuthorization) return await run(context);
      const { projectExternalActionRequesterHttpAuthorization } = await import('@/api/externalActionExecutionAuthorization');
      const projected = await projectExternalActionRequesterHttpAuthorization({ authorization: accountAuthorization,
        serverId: input.serverId, serverIdentityId: identity, serverHttpBaseUrl: bootstrap.serverHttpBaseUrl,
        target: authorization.binding.target, installationId: installation.identity.installationId,
        privateKey: decodeBase64(installation.identity.privateKey, 'base64url'),
        isCurrent: async () => await bootstrap.isCurrent() && await context.verifyMachineAdmissionCurrent!(), signal: context.signal });
      return await run(projected ? { ...context, callerInputAuthorization: projected, requesterSessionBootstrap: bootstrap } : context,
        projected ? { installationId: installation.identity.installationId,
          privateKey: decodeBase64(installation.identity.privateKey, 'base64url') } : undefined);
    } finally { await owner.release(runtime); }
  }
  registrar.registerHandler(RPC_METHODS.PROJECTS_OPEN, async (raw: unknown, context) => {
    const parsed = OpenProjectInputV1Schema.safeParse(raw);
    if (!parsed.success) { logger.warnLocalFile('[Project Open RPC] Invalid input', { issues: parsed.error.issues }); return { kind: 'refused', code: 'invalid_input' }; }
    if (parsed.data.machineId !== input.machineId || input.runtime
      && (input.runtime.serverId !== input.serverId || input.runtime.machineId !== input.machineId)) {
      logger.warnLocalFile('[Project Open RPC] Target mismatch'); return { kind: 'refused', code: 'target_mismatch' };
    }
    if (!input.runtime) {
      const code = await isServerProfileHomeIdentity(input.serverId, parsed.data.serverId) ? 'project_open_unavailable' : 'target_mismatch';
      logger.warnLocalFile('[Project Open RPC] Runtime unavailable', { code }); return { kind: 'refused', code };
    }
    const result = OpenProjectResultV1Schema.safeParse(await withRequesterContext(context, async (admitted, signing) => {
      const runtime = { ...input.runtime!, ...(signing ? { requesterMachineRpcSigning: signing } : {}) };
      // The receiving host's existing observer owns the original attempt. An
      // already observed local Action must not acquire a second operation.
      if (!input.observeExecution || !admitted || admitted.localActionContext?.operationAcceptance?.actionId === 'projects.open') {
        return openProject(parsed.data, runtime, admitted);
      }
      const observed = await input.observeExecution({ actionId: 'projects.open', input: parsed.data,
        actionRequestId: admitted.localActionContext?.actionRequestId ?? admitted.transportRequestId,
        rpcContext: admitted,
        execute: async operation => ({ ok: true, result: await openProject(parsed.data, runtime, {
          ...admitted, signal: AbortSignal.any([admitted.signal, operation.signal]),
        }, operation.operationAcceptance) }),
      });
      return observed.ok ? observed.result : { kind: 'refused', code: observed.errorCode ?? 'project_open_unavailable' };
    }));
    if (!result.success) logger.warnLocalFile('[Project Open RPC] Invalid settlement', { issues: result.error.issues });
    return result.success ? result.data : { kind: 'outcomeUnknown' };
  });
  registrar.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, async (raw: unknown, context) => {
    const parsed = OpenProjectInputV1Schema.safeParse(raw);
    if (!parsed.success) { logger.warnLocalFile('[Project Open Sync RPC] Invalid input', { issues: parsed.error.issues }); return { kind: 'refused', code: 'invalid_input' }; }
    if (input.runtime && (input.runtime.serverId !== input.serverId || input.runtime.machineId !== input.machineId)) {
      logger.warnLocalFile('[Project Open Sync RPC] Target mismatch'); return { kind: 'refused', code: 'target_mismatch' };
    }
    if (!input.runtime) {
      const code = await isServerProfileHomeIdentity(input.serverId, parsed.data.serverId) ? 'project_open_unavailable' : 'target_mismatch';
      logger.warnLocalFile('[Project Open Sync RPC] Runtime unavailable', { code }); return { kind: 'refused', code };
    }
    const result = ProjectOpenSyncMaterializationResultV1Schema.safeParse(await withRequesterContext(context, (admitted, signing) => materializeProjectSyncOnSource(parsed.data,
      { ...input.runtime!, ...(signing ? { requesterMachineRpcSigning: signing } : {}) }, admitted)));
    if (!result.success) logger.warnLocalFile('[Project Open Sync RPC] Invalid settlement', { issues: result.error.issues });
    return result.success ? result.data : { kind: 'outcomeUnknown' };
  });
}
